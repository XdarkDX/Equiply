const QRCode = require('qrcode');
const { HttpError, normalizeCode, isValidCode, requireId } = require('../util');
const { requirePermission } = require('../session');

const MAX_FREE_CODES = 210; // 10 Etikettenbögen

module.exports = function qrRoutes(app, { db, sessions, inventory }) {
    const { authenticate } = sessions;
    const { log } = inventory;
    const canManageItems = [authenticate, requirePermission('can_manage_items')];

    // Adresse, die in den QR-Code geschrieben wird: fest eingestellt oder die aktuelle Server-Adresse
    function baseUrl(req) {
        const v = db.prepare(`SELECT qr_url FROM vereine WHERE id = ?`).get(req.user.verein_id);
        return (v && v.qr_url) || `${req.protocol}://${req.get('host')}`;
    }

    async function sendSvg(req, res, code) {
        const svg = await QRCode.toString(`${baseUrl(req)}/q/${code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, max-age=300' });
        if (req.query.download) res.set('Content-Disposition', `attachment; filename="equiply-qr-${code}.svg"`);
        res.send(svg);
    }

    // Gescannter Link -> App öffnet das Gerät (Anmeldung wird dort geprüft)
    app.get('/q/:code', (req, res) => {
        const code = normalizeCode(req.params.code);
        res.redirect(302, isValidCode(code) ? `/#q/${code}` : '/');
    });

    // Freie (noch keinem Gerät zugeordnete) Codes – z. B. um Schilder vorab lasern zu lassen
    app.get('/api/qr/frei', ...canManageItems, (req, res) => {
        res.json(db.prepare(`SELECT code, created_at FROM qr_codes WHERE verein_id = ? AND equipment_id IS NULL ORDER BY created_at DESC, code`).all(req.user.verein_id));
    });

    app.post('/api/qr/frei', ...canManageItems, (req, res) => {
        const anzahl = Number(req.body.anzahl);
        if (!Number.isInteger(anzahl) || anzahl < 1 || anzahl > MAX_FREE_CODES) throw new HttpError(400, `Bitte zwischen 1 und ${MAX_FREE_CODES} Codes erzeugen.`);
        const codes = db.transaction(() => {
            const list = Array.from({ length: anzahl }, () => inventory.newCode(req.user.verein_id));
            log(req.user.verein_id, req.user.id, null, 'qr', `${anzahl} freie QR-Codes erzeugt`);
            return list;
        })();
        res.status(201).json({ codes });
    });

    app.delete('/api/qr/frei/:code', ...canManageItems, (req, res) => {
        const info = db.prepare(`DELETE FROM qr_codes WHERE code = ? AND verein_id = ? AND equipment_id IS NULL`).run(normalizeCode(req.params.code), req.user.verein_id);
        if (!info.changes) throw new HttpError(404, 'Freier Code nicht gefunden.');
        res.json({ message: 'Code gelöscht.' });
    });

    // Was steckt hinter einem gescannten Code?
    app.get('/api/qr/:code', authenticate, (req, res) => {
        const code = normalizeCode(req.params.code);
        if (!isValidCode(code)) throw new HttpError(400, 'Kein gültiger QR-Code.');
        const row = db.prepare(`SELECT verein_id, equipment_id FROM qr_codes WHERE code = ?`).get(code);
        if (!row || row.verein_id !== req.user.verein_id) return res.json({ code, status: 'unbekannt' });
        res.json(row.equipment_id ? { code, status: 'zugeordnet', equipment_id: row.equipment_id } : { code, status: 'frei' });
    });

    app.get('/api/qr/:code/svg', authenticate, async (req, res) => {
        const code = normalizeCode(req.params.code);
        const row = db.prepare(`SELECT verein_id FROM qr_codes WHERE code = ?`).get(code);
        if (!row || row.verein_id !== req.user.verein_id) throw new HttpError(404, 'QR-Code nicht gefunden.');
        await sendSvg(req, res, code);
    });

    // QR-Code eines Geräts (für Etiketten)
    app.get('/api/equipment/:id/qr.svg', authenticate, async (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        const code = inventory.codeOf(item.id) || inventory.newCode(req.user.verein_id, item.id);
        await sendSvg(req, res, code);
    });

    // Anderen Code zuweisen, z. B. ein schon gelasertes Schild an ein neues Gerät
    app.put('/api/equipment/:id/qr', ...canManageItems, (req, res) => {
        const id = requireId(req.params.id);
        const result = db.transaction(() => {
            const item = inventory.getItem(req.user.verein_id, id);
            const r = inventory.assignCode(req.user.verein_id, item.id, req.body.code);
            if (r.code !== r.old) {
                log(req.user.verein_id, req.user.id, item.id, 'qr', `QR-Code ${r.old ? `${r.old} → ` : ''}${r.code}${r.old ? ` (${r.old} ist jetzt frei)` : ''}`);
            }
            return r;
        })();
        res.json({ code: result.code, message: 'QR-Code zugewiesen.' });
    });
};
