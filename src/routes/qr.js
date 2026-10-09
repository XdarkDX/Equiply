const QRCode = require('qrcode');
const JSZip = require('jszip');
const { HttpError, normalizeCode, isValidCode, requireId } = require('../util');
const { requirePermission } = require('../session');

const MAX_FREE_CODES = 210; // 10 Etikettenbögen
const MAX_ZIP = 500;

module.exports = function qrRoutes(app, { db, sessions, inventory }) {
    const { authenticate } = sessions;
    const { log } = inventory;
    const canManageItems = [authenticate, requirePermission('can_manage_items')];

    // Im QR-Code steht die Adresse, unter der Equiply gerade aufgerufen wird
    const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;

    // PNG in hoher Auflösung (1000 px) – reicht auch zum Lasern und für große Schilder
    const pngFor = (req, code) => QRCode.toBuffer(`${baseUrl(req)}/q/${code}`, { type: 'png', width: 1000, margin: 2, errorCorrectionLevel: 'M' });
    const fileName = (text) => text.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

    async function sendPng(req, res, code, filename) {
        const png = await pngFor(req, code);
        res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=300' });
        if (req.query.download) {
            const ascii = filename.replace(/[^A-Za-z0-9_.-]+/g, '-');
            res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        }
        res.send(png);
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

    // Mehrere QR-Codes als Bilder in einer ZIP-Datei (?ids=1,2,3 für Geräte oder ?codes=A,B für freie Codes)
    app.get('/api/qr/bilder.zip', authenticate, async (req, res) => {
        const files = [];
        if (req.query.codes) {
            const own = db.prepare(`SELECT code FROM qr_codes WHERE code = ? AND verein_id = ?`);
            for (const raw of String(req.query.codes).split(',')) {
                const code = normalizeCode(raw);
                if (own.get(code, req.user.verein_id)) files.push({ code, name: `QR-Code ${code}.png` });
            }
        } else {
            const ids = [...new Set(String(req.query.ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0))];
            for (const id of ids) {
                const item = db.prepare(`SELECT id, device_id, name FROM equipment WHERE id = ? AND verein_id = ?`).get(id, req.user.verein_id);
                if (!item) continue;
                const code = inventory.codeOf(item.id);
                if (!code) continue; // Geräte ohne QR-Code werden übersprungen
                files.push({ code, name: `${fileName(`${item.device_id} ${item.name}`)}.png` });
            }
        }
        if (!files.length) throw new HttpError(400, 'Die ausgewählten Geräte haben noch keinen QR-Code.');
        if (files.length > MAX_ZIP) throw new HttpError(400, `Maximal ${MAX_ZIP} QR-Codes auf einmal.`);
        const zip = new JSZip();
        const used = new Set();
        for (const f of files) {
            let name = f.name;
            for (let n = 2; used.has(name); n++) name = f.name.replace(/\.png$/, ` (${n}).png`);
            used.add(name);
            zip.file(name, await pngFor(req, f.code));
        }
        const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
        res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="QR-Codes.zip"' }).send(buf);
    });

    // Was steckt hinter einem gescannten Code?
    app.get('/api/qr/:code', authenticate, (req, res) => {
        const code = normalizeCode(req.params.code);
        if (!isValidCode(code)) throw new HttpError(400, 'Kein gültiger QR-Code.');
        const row = db.prepare(`SELECT verein_id, equipment_id FROM qr_codes WHERE code = ?`).get(code);
        if (!row || row.verein_id !== req.user.verein_id) return res.json({ code, status: 'unbekannt' });
        res.json(row.equipment_id ? { code, status: 'zugeordnet', equipment_id: row.equipment_id } : { code, status: 'frei' });
    });

    app.get('/api/qr/:code/png', authenticate, async (req, res) => {
        const code = normalizeCode(req.params.code);
        const row = db.prepare(`SELECT verein_id FROM qr_codes WHERE code = ?`).get(code);
        if (!row || row.verein_id !== req.user.verein_id) throw new HttpError(404, 'QR-Code nicht gefunden.');
        await sendPng(req, res, code, `QR-Code ${code}.png`);
    });

    app.get('/api/qr/:code/svg', authenticate, async (req, res) => {
        const code = normalizeCode(req.params.code);
        const row = db.prepare(`SELECT verein_id FROM qr_codes WHERE code = ?`).get(code);
        if (!row || row.verein_id !== req.user.verein_id) throw new HttpError(404, 'QR-Code nicht gefunden.');
        await sendSvg(req, res, code);
    });

    // QR-Code eines Geräts als Bild zum Herunterladen, Dateiname mit Nummer und Name
    app.get('/api/equipment/:id/qr.png', authenticate, async (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        const code = inventory.codeOf(item.id);
        if (!code) throw new HttpError(404, 'Dieses Gerät hat noch keinen QR-Code.');
        await sendPng(req, res, code, `QR-Code ${fileName(`${item.device_id} ${item.name}`)}.png`);
    });

    // QR-Code eines Geräts (für Etiketten)
    app.get('/api/equipment/:id/qr.svg', authenticate, async (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        const code = inventory.codeOf(item.id);
        if (!code) throw new HttpError(404, 'Dieses Gerät hat noch keinen QR-Code.');
        await sendSvg(req, res, code);
    });

    // QR-Code zuweisen: vorhandenen (freien/gescannten) Code ({ code }) oder einen neuen ({ neu: true })
    app.put('/api/equipment/:id/qr', ...canManageItems, (req, res) => {
        const id = requireId(req.params.id);
        const result = db.transaction(() => {
            const item = inventory.getItem(req.user.verein_id, id);
            const code = req.body.neu ? inventory.newCode(req.user.verein_id) : req.body.code;
            const r = inventory.assignCode(req.user.verein_id, item.id, code);
            if (r.code !== r.old) {
                log(req.user.verein_id, req.user.id, item.id, 'qr', `QR-Code ${r.old ? `${r.old} → ` : ''}${r.code}${r.old ? ` (${r.old} ist jetzt frei)` : ''}`);
            }
            return r;
        })();
        res.json({ code: result.code, message: 'QR-Code zugewiesen.' });
    });

    // QR-Code vom Gerät lösen – der Code wird wieder frei
    app.delete('/api/equipment/:id/qr', ...canManageItems, (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        const code = inventory.releaseCode(item.id);
        if (!code) throw new HttpError(404, 'Dieses Gerät hat keinen QR-Code.');
        log(req.user.verein_id, req.user.id, item.id, 'qr', `QR-Code ${code} gelöst (ist jetzt frei)`);
        res.json({ message: 'QR-Code gelöst.' });
    });

    // Mehreren Geräten ohne QR-Code auf einmal einen neuen Code geben
    app.post('/api/qr/zuweisen', ...canManageItems, (req, res) => {
        const ids = Array.isArray(req.body.ids) ? [...new Set(req.body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0))] : [];
        const count = db.transaction(() => {
            let n = 0;
            for (const id of ids) {
                const item = db.prepare(`SELECT id FROM equipment WHERE id = ? AND verein_id = ?`).get(id, req.user.verein_id);
                if (!item || inventory.codeOf(item.id)) continue;
                const code = inventory.newCode(req.user.verein_id, item.id);
                log(req.user.verein_id, req.user.id, item.id, 'qr', `QR-Code ${code} zugewiesen`);
                n++;
            }
            return n;
        })();
        res.json({ zugewiesen: count, message: `${count} QR-Code${count === 1 ? '' : 's'} zugewiesen.` });
    });
};
