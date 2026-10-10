const QRCode = require('qrcode');
const JSZip = require('jszip');
const { qrPngWithCode } = require('../qrimage');
const { HttpError, normalizeCode, isValidCode, formatCode, requireId } = require('../util');
const { requirePermission } = require('../session');

const MAX_FREE_CODES = 210; // 10 Etikettenbögen
const MAX_ZIP = 500;

module.exports = function qrRoutes(app, { db, sessions, inventory }) {
    const { authenticate } = sessions;
    const { log } = inventory;
    const canManageItems = [authenticate, requirePermission('can_manage_items')];

    // Im QR-Code steht die Adresse, unter der Equiply gerade aufgerufen wird
    const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
    // Bild (1000 px breit) mit dem Code als Text darunter
    const pngFor = async (req, code) => qrPngWithCode(`${baseUrl(req)}/q/${code}`, formatCode(code));
    const fileName = (text) => text.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

    // Bilder zu einem Code ändern sich nicht; Bilder zu einem Gerät schon (neuer Code nach Kategoriewechsel)
    const CACHE_CODE = 'private, max-age=300';
    const CACHE_ITEM = 'private, no-cache';

    async function sendPng(req, res, code, filename, cache = CACHE_CODE) {
        const png = await pngFor(req, code);
        res.set({ 'Content-Type': 'image/png', 'Cache-Control': cache });
        if (req.query.download) {
            const ascii = filename.replace(/[^A-Za-z0-9_.-]+/g, '-');
            res.set('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        }
        res.send(png);
    }

    async function sendSvg(req, res, code, cache = CACHE_CODE) {
        const svg = await QRCode.toString(`${baseUrl(req)}/q/${code}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
        res.set({ 'Content-Type': 'image/svg+xml', 'Cache-Control': cache }).send(svg);
    }

    const ownCode = (req, raw) => {
        const row = db.prepare(`SELECT code, verein_id FROM qr_codes WHERE code = ?`).get(normalizeCode(raw));
        if (!row || row.verein_id !== req.user.verein_id) throw new HttpError(404, 'Code nicht gefunden.');
        return row.code;
    };

    // Nachschlagen geht auch mit alten Kennungen (z. B. früheren Nummern wie 1001), neu vergeben werden nur gültige Codes
    const isLookupCode = (code) => isValidCode(code) || /^[0-9A-Z]{2,20}$/.test(code);

    // Gescannter Link -> App öffnet das Gerät (Anmeldung wird dort geprüft)
    app.get('/q/:code', (req, res) => {
        const code = normalizeCode(req.params.code);
        res.redirect(302, isLookupCode(code) ? `/#q/${code}` : '/');
    });

    // --- Freie Codes (Vorrat), immer für eine bestimmte Kategorie ---
    app.get('/api/qr/frei', ...canManageItems, (req, res) => {
        res.json(db.prepare(`
            SELECT q.code, q.created_at, q.kategorie_id, k.name AS kategorie FROM qr_codes q JOIN kategorien k ON k.id = q.kategorie_id
            WHERE q.verein_id = ? AND q.equipment_id IS NULL ORDER BY k.name COLLATE NOCASE, q.code`).all(req.user.verein_id));
    });

    app.post('/api/qr/frei', ...canManageItems, (req, res) => {
        const anzahl = Number(req.body.anzahl);
        if (!Number.isInteger(anzahl) || anzahl < 1 || anzahl > MAX_FREE_CODES) throw new HttpError(400, `Bitte zwischen 1 und ${MAX_FREE_CODES} Codes erzeugen.`);
        const kategorie = inventory.getCategory(req.user.verein_id, req.body.kategorie_id);
        const codes = db.transaction(() => {
            const list = Array.from({ length: anzahl }, () => inventory.newCode(req.user.verein_id, kategorie));
            log(req.user.verein_id, req.user.id, null, 'qr', `${anzahl} freie Codes für „${kategorie.name}“ erzeugt`);
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
            for (const raw of String(req.query.codes).split(',')) {
                try { const code = ownCode(req, raw); files.push({ code, name: `${formatCode(code)}.png` }); } catch (e) { /* fremd/unbekannt */ }
            }
        } else {
            const ids = [...new Set(String(req.query.ids || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0))];
            const get = db.prepare(`SELECT device_id, name FROM equipment WHERE id = ? AND verein_id = ?`);
            for (const id of ids) {
                const item = get.get(id, req.user.verein_id);
                if (item) files.push({ code: item.device_id, name: `${fileName(`${formatCode(item.device_id)} ${item.name}`)}.png` });
            }
        }
        if (!files.length) throw new HttpError(400, 'Keine Geräte ausgewählt.');
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

    // Was steckt hinter einem gescannten Code? (aktueller oder alter Code eines Geräts, freier Code, unbekannt)
    app.get('/api/qr/:code', authenticate, (req, res) => {
        const code = normalizeCode(req.params.code);
        if (!isLookupCode(code)) throw new HttpError(400, 'Kein gültiger Code.');
        const row = db.prepare(`
            SELECT q.verein_id, q.equipment_id, q.kategorie_id, k.name AS kategorie FROM qr_codes q
            LEFT JOIN kategorien k ON k.id = q.kategorie_id WHERE q.code = ?`).get(code);
        if (!row || row.verein_id !== req.user.verein_id) return res.json({ code, status: 'unbekannt' });
        if (row.equipment_id) return res.json({ code, status: 'zugeordnet', equipment_id: row.equipment_id });
        res.json({ code, status: 'frei', kategorie_id: row.kategorie_id, kategorie: row.kategorie });
    });

    app.get('/api/qr/:code/png', authenticate, async (req, res) => {
        const code = ownCode(req, req.params.code);
        await sendPng(req, res, code, `${formatCode(code)}.png`);
    });

    app.get('/api/qr/:code/svg', authenticate, async (req, res) => {
        await sendSvg(req, res, ownCode(req, req.params.code));
    });

    // QR-Code eines Geräts als Bild, Dateiname mit Code und Name
    app.get('/api/equipment/:id/qr.png', authenticate, async (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        await sendPng(req, res, item.device_id, `${fileName(`${formatCode(item.device_id)} ${item.name}`)}.png`, CACHE_ITEM);
    });

    app.get('/api/equipment/:id/qr.svg', authenticate, async (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        await sendSvg(req, res, item.device_id, CACHE_ITEM);
    });

    // Anderes Schild verwenden: freien Code derselben Kategorie übernehmen, der bisherige wird frei
    app.put('/api/equipment/:id/qr', ...canManageItems, (req, res) => {
        const id = requireId(req.params.id);
        const code = db.transaction(() => inventory.replaceCode(req.user.verein_id, req.user.id, inventory.getItem(req.user.verein_id, id), req.body.code))();
        res.json({ code, message: `Code ${formatCode(code)} übernommen.` });
    });
};
