const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { HttpError, CONDITIONS, CONDITION_LABELS, requireText, optionalDate, requireOneOf, requireId, today, formatDate, detectImage, formatCode, kennung } = require('../util');
const { requirePermission } = require('../session');

const MAX_IMAGES_PER_ITEM = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

module.exports = function equipmentRoutes(app, { db, config, sessions, inventory }) {
    const { authenticate } = sessions;
    const { log } = inventory;
    const canManageItems = [authenticate, requirePermission('can_manage_items')];
    fs.mkdirSync(config.uploadDir, { recursive: true });

    // --- Kategorien ---
    app.get('/api/kategorien', authenticate, (req, res) => {
        res.json(db.prepare(`
            SELECT k.id, k.name, k.prefix, (SELECT COUNT(*) FROM equipment e WHERE e.kategorie_id = k.id) AS anzahl
            FROM kategorien k WHERE k.verein_id = ? ORDER BY k.name COLLATE NOCASE`).all(req.user.verein_id));
    });

    app.post('/api/kategorien', ...canManageItems, (req, res) => {
        const k = inventory.createCategory(req.user.verein_id, req.body.name);
        log(req.user.verein_id, req.user.id, null, 'kategorie', `Kategorie „${k.name}“ (Kürzel ${k.prefix}) erstellt`);
        res.status(201).json(k);
    });

    app.put('/api/kategorien/:id', ...canManageItems, (req, res) => {
        const k = inventory.getCategory(req.user.verein_id, req.params.id);
        // Nur der Name ist änderbar – das Kürzel bleibt, damit vorhandene Codes und Schilder stimmen
        const name = requireText(req.body.name, 'Kategoriename', 50);
        db.prepare(`UPDATE kategorien SET name = ? WHERE id = ?`).run(name, k.id);
        if (name !== k.name) log(req.user.verein_id, req.user.id, null, 'kategorie', `Kategorie „${k.name}“ umbenannt in „${name}“`);
        res.json({ message: 'Gespeichert.' });
    });

    app.delete('/api/kategorien/:id', ...canManageItems, (req, res) => {
        const k = inventory.getCategory(req.user.verein_id, req.params.id);
        const n = db.prepare(`SELECT COUNT(*) AS c FROM equipment WHERE kategorie_id = ?`).get(k.id).c;
        if (n > 0) throw new HttpError(409, `In „${k.name}“ sind noch ${n} Geräte. Bitte erst verschieben oder löschen.`);
        if (inventory.categories(req.user.verein_id).length <= 1) throw new HttpError(409, 'Mindestens eine Kategorie muss bestehen bleiben.');
        db.prepare(`DELETE FROM kategorien WHERE id = ?`).run(k.id);
        log(req.user.verein_id, req.user.id, null, 'kategorie', `Kategorie „${k.name}“ gelöscht`);
        res.json({ message: 'Kategorie gelöscht.' });
    });

    // --- Inventar ---
    const SELECT_ITEMS = `
        SELECT e.id, e.device_id AS code, e.name, e.kategorie_id, k.name AS category, e.hersteller, e.seriennummer, e.groesse,
               e.lagerort, e.tuev, e.condition, e.notes, e.created_at, e.updated_at,
               CASE WHEN a.id IS NULL THEN 'Verfügbar' ELSE 'Ausgeliehen' END AS status,
               a.borrower, a.rueckgabe_geplant AS returnDate, a.ausgeliehen_am,
               (SELECT b.id FROM bilder b WHERE b.equipment_id = e.id ORDER BY b.id LIMIT 1) AS bild_id,
               (SELECT COUNT(*) FROM bilder b WHERE b.equipment_id = e.id) AS bilder_anzahl,
               (SELECT COUNT(*) FROM kommentare c WHERE c.equipment_id = e.id) AS kommentare_anzahl, k.prefix
        FROM equipment e
        JOIN kategorien k ON k.id = e.kategorie_id
        LEFT JOIN ausleihen a ON a.equipment_id = e.id AND a.zurueckgegeben_am IS NULL
        WHERE e.verein_id = ?`;
    const listQuery = db.prepare(`${SELECT_ITEMS} ORDER BY k.prefix, e.device_id IS NULL, e.device_id, e.id`);
    const itemQuery = db.prepare(`${SELECT_ITEMS} AND e.id = ?`);
    const openLoan = db.prepare(`SELECT id, borrower FROM ausleihen WHERE equipment_id = ? AND zurueckgegeben_am IS NULL`);

    // Kennung zum Anzeigen: Code (FL-7K3X) oder Platzhalter (FL-NEU17), solange noch kein QR-Code zugewiesen ist
    const withKennung = (i) => ({ ...i, kennung: kennung(i.code, i.prefix, i.id) });

    app.get('/api/equipment', authenticate, (req, res) => {
        res.json(listQuery.all(req.user.verein_id).map(withKennung));
    });

    app.get('/api/equipment/:id', authenticate, (req, res) => {
        const row = itemQuery.get(req.user.verein_id, requireId(req.params.id));
        if (!row) throw new HttpError(404, 'Gerät nicht gefunden.');
        const item = withKennung(row);
        res.json({
            ...item,
            bilder: db.prepare(`SELECT b.id, b.created_at, b.erstellt_von, n.username FROM bilder b LEFT JOIN nutzer n ON n.id = b.erstellt_von WHERE b.equipment_id = ? ORDER BY b.id`).all(item.id),
            kommentare: db.prepare(`SELECT c.id, c.text, c.created_at, c.nutzer_id, n.username FROM kommentare c LEFT JOIN nutzer n ON n.id = c.nutzer_id WHERE c.equipment_id = ? ORDER BY c.created_at DESC, c.id DESC`).all(item.id),
            ausleihen: db.prepare(`
                SELECT a.id, a.borrower, a.ausgeliehen_am, a.rueckgabe_geplant, a.zurueckgegeben_am, a.zustand_bei_rueckgabe,
                       aus.username AS ausgegeben_von, zur.username AS zurueckgenommen_von
                FROM ausleihen a LEFT JOIN nutzer aus ON aus.id = a.ausgegeben_von LEFT JOIN nutzer zur ON zur.id = a.zurueckgenommen_von
                WHERE a.equipment_id = ? ORDER BY a.ausgeliehen_am DESC, a.id DESC`).all(item.id),
            aktivitaeten: db.prepare(`
                SELECT a.id, a.aktion, a.details, a.created_at, n.username FROM aktivitaeten a LEFT JOIN nutzer n ON n.id = a.nutzer_id
                WHERE a.equipment_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 200`).all(item.id),
        });
    });

    app.post('/api/equipment', ...canManageItems, (req, res) => {
        const kategorie = inventory.getCategory(req.user.verein_id, req.body.kategorie_id);
        const fields = inventory.readFields(req.body);
        const result = db.transaction(() => inventory.create(req.user.verein_id, req.user.id, kategorie, fields, req.body.code || null))();
        res.status(201).json(result);
    });

    app.put('/api/equipment/:id', ...canManageItems, (req, res) => {
        const result = db.transaction(() => {
            const old = inventory.getItem(req.user.verein_id, req.params.id);
            const kategorie = inventory.getCategory(req.user.verein_id, req.body.kategorie_id);
            return { ...inventory.update(req.user.verein_id, req.user.id, old, kategorie, inventory.readFields(req.body)), alt: old.device_id };
        })();
        res.json({ message: 'Gespeichert.', code: result.code, codeGeaendert: result.code !== result.alt });
    });

    app.delete('/api/equipment/:id', ...canManageItems, (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        const files = db.prepare(`SELECT datei FROM bilder WHERE equipment_id = ?`).all(item.id);
        db.transaction(() => {
            inventory.prepareDelete(item);
            db.prepare(`DELETE FROM equipment WHERE id = ?`).run(item.id); // der Code wird dadurch frei
            log(req.user.verein_id, req.user.id, null, 'geloescht', item.device_id
                ? `${item.name} (${formatCode(item.device_id)}) gelöscht – der Code ist jetzt frei`
                : `${item.name} (${kennung(null, item.prefix, item.id)}) gelöscht`);
        })();
        for (const f of files) fs.rm(path.join(config.uploadDir, f.datei), { force: true }, () => {});
        res.json({ message: 'Gelöscht.' });
    });

    // Ausleihen ({ borrower, returnDate }) oder Rückgabe ({ condition, kommentar })
    app.put('/api/equipment/:id/action', authenticate, requirePermission('can_borrow_return'), (req, res) => {
        const message = db.transaction(() => {
            const item = inventory.getItem(req.user.verein_id, req.params.id);
            const loan = openLoan.get(item.id);
            if (req.body.condition) {
                const condition = requireOneOf(req.body.condition, CONDITIONS, 'Zustand');
                if (!loan) throw new HttpError(409, 'Dieses Gerät ist nicht ausgeliehen.');
                const kommentar = typeof req.body.kommentar === 'string' ? req.body.kommentar.trim().slice(0, 2000) : '';
                db.prepare(`UPDATE ausleihen SET zurueckgegeben_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), zurueckgenommen_von = ?, zustand_bei_rueckgabe = ? WHERE id = ?`)
                    .run(req.user.id, condition, loan.id);
                db.prepare(`UPDATE equipment SET condition = ? WHERE id = ?`).run(condition, item.id);
                if (kommentar) db.prepare(`INSERT INTO kommentare (equipment_id, nutzer_id, text) VALUES (?, ?, ?)`).run(item.id, req.user.id, kommentar);
                log(req.user.verein_id, req.user.id, item.id, 'zurueckgegeben', `Rückgabe von ${loan.borrower} – Zustand: ${CONDITION_LABELS[condition]}`);
                return 'Rückgabe erfasst.';
            }
            const borrower = requireText(req.body.borrower, 'Name des Ausleihers', 100);
            const returnDate = optionalDate(req.body.returnDate, 'Rückgabedatum');
            if (returnDate && returnDate < today()) throw new HttpError(400, 'Das Rückgabedatum liegt in der Vergangenheit.');
            if (loan) throw new HttpError(409, `Dieses Gerät ist bereits an ${loan.borrower} ausgeliehen.`);
            if (item.condition === 'Reparaturbedürftig') throw new HttpError(409, 'Defekte Geräte können nicht ausgeliehen werden.');
            if (item.tuev && item.tuev < today()) throw new HttpError(409, 'TÜV/Prüfung ist abgelaufen – Ausleihe gesperrt.');
            db.prepare(`INSERT INTO ausleihen (equipment_id, borrower, rueckgabe_geplant, ausgegeben_von) VALUES (?, ?, ?, ?)`).run(item.id, borrower, returnDate, req.user.id);
            log(req.user.verein_id, req.user.id, item.id, 'ausgeliehen', `An ${borrower} ausgeliehen${returnDate ? ` bis ${formatDate(returnDate)}` : ''}`);
            return 'Ausleihe erfasst.';
        })();
        res.json({ message });
    });

    // Namensvorschläge für "Ausleihen an"
    app.get('/api/ausleiher', authenticate, (req, res) => {
        const rows = db.prepare(`
            SELECT name FROM (
                SELECT a.borrower AS name, MAX(a.ausgeliehen_am) AS zuletzt FROM ausleihen a JOIN equipment e ON e.id = a.equipment_id
                WHERE e.verein_id = ? GROUP BY a.borrower
                UNION ALL SELECT username, '' FROM nutzer WHERE verein_id = ?
            ) GROUP BY name COLLATE NOCASE ORDER BY MAX(zuletzt) DESC, name LIMIT 500`).all(req.user.verein_id, req.user.verein_id);
        res.json(rows.map(r => r.name));
    });

    // --- Bilder ---
    const canAddImages = (req, res, next) => {
        if (!req.user.permissions.can_manage_items && !req.user.permissions.can_borrow_return) throw new HttpError(403, 'Dir fehlen die Rechte für diese Aktion.');
        next();
    };

    app.post('/api/equipment/:id/bilder', authenticate, canAddImages, express.raw({ type: () => true, limit: MAX_IMAGE_BYTES }), (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Keine Bilddatei empfangen.');
        const type = detectImage(req.body);
        if (!type) throw new HttpError(400, 'Nur JPG-, PNG-, WebP- oder GIF-Bilder sind erlaubt.');
        const count = db.prepare(`SELECT COUNT(*) AS c FROM bilder WHERE equipment_id = ?`).get(item.id).c;
        if (count >= MAX_IMAGES_PER_ITEM) throw new HttpError(409, `Maximal ${MAX_IMAGES_PER_ITEM} Bilder pro Gerät.`);

        const datei = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
        fs.writeFileSync(path.join(config.uploadDir, datei), req.body);
        try {
            const id = db.transaction(() => {
                const id = Number(db.prepare(`INSERT INTO bilder (equipment_id, datei, mime, groesse, erstellt_von) VALUES (?, ?, ?, ?, ?)`)
                    .run(item.id, datei, type.mime, req.body.length, req.user.id).lastInsertRowid);
                log(req.user.verein_id, req.user.id, item.id, 'bild', 'Bild hinzugefügt');
                return id;
            })();
            res.status(201).json({ id });
        } catch (e) {
            fs.rm(path.join(config.uploadDir, datei), { force: true }, () => {});
            throw e;
        }
    });

    const imageQuery = db.prepare(`SELECT b.*, e.verein_id FROM bilder b JOIN equipment e ON e.id = b.equipment_id WHERE b.id = ?`);
    function getImage(req) {
        const img = imageQuery.get(requireId(req.params.id));
        if (!img || img.verein_id !== req.user.verein_id) throw new HttpError(404, 'Bild nicht gefunden.');
        return img;
    }

    app.get('/api/bilder/:id', authenticate, (req, res) => {
        const img = getImage(req);
        res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=604800, immutable', 'Content-Disposition': 'inline' });
        res.sendFile(path.join(config.uploadDir, img.datei), (err) => {
            if (err && !res.headersSent) res.status(404).json({ error: 'Bilddatei fehlt.' });
        });
    });

    app.delete('/api/bilder/:id', authenticate, (req, res) => {
        const img = getImage(req);
        if (!req.user.permissions.can_manage_items && img.erstellt_von !== req.user.id) throw new HttpError(403, 'Du kannst nur eigene Bilder löschen.');
        db.transaction(() => {
            db.prepare(`DELETE FROM bilder WHERE id = ?`).run(img.id);
            log(req.user.verein_id, req.user.id, img.equipment_id, 'bild', 'Bild gelöscht');
        })();
        fs.rm(path.join(config.uploadDir, img.datei), { force: true }, () => {});
        res.json({ message: 'Bild gelöscht.' });
    });

    // --- Kommentare ---
    app.post('/api/equipment/:id/kommentare', authenticate, (req, res) => {
        const item = inventory.getItem(req.user.verein_id, req.params.id);
        const text = requireText(req.body.text, 'Kommentar', 2000);
        const id = Number(db.prepare(`INSERT INTO kommentare (equipment_id, nutzer_id, text) VALUES (?, ?, ?)`).run(item.id, req.user.id, text).lastInsertRowid);
        res.status(201).json({ id });
    });

    app.delete('/api/kommentare/:id', authenticate, (req, res) => {
        const c = db.prepare(`SELECT c.id, c.nutzer_id, e.verein_id FROM kommentare c JOIN equipment e ON e.id = c.equipment_id WHERE c.id = ?`).get(requireId(req.params.id));
        if (!c || c.verein_id !== req.user.verein_id) throw new HttpError(404, 'Kommentar nicht gefunden.');
        if (c.nutzer_id !== req.user.id && !req.user.permissions.can_manage_items) throw new HttpError(403, 'Du kannst nur eigene Kommentare löschen.');
        db.prepare(`DELETE FROM kommentare WHERE id = ?`).run(c.id);
        res.json({ message: 'Kommentar gelöscht.' });
    });
};
