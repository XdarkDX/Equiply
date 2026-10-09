const express = require('express');
const ExcelJS = require('exceljs');
const { HttpError, CONDITIONS, CONDITION_LABELS, isIsoDate, today } = require('../util');
const { requirePermission } = require('../session');
const { buildPreview, makeCategoryResolver, MAX_ROWS } = require('../importer');

const COLUMNS = [
    { header: 'Inventarnummer', key: 'deviceId', width: 16 },
    { header: 'Bezeichnung', key: 'name', width: 32 },
    { header: 'Kategorie', key: 'category', width: 16 },
    { header: 'Hersteller', key: 'hersteller', width: 18 },
    { header: 'Seriennummer', key: 'seriennummer', width: 18 },
    { header: 'Größe', key: 'groesse', width: 10 },
    { header: 'Lagerort', key: 'lagerort', width: 16 },
    { header: 'TÜV / Prüfung', key: 'tuev', width: 14, date: true },
    { header: 'Zustand', key: 'condition', width: 15 },
    { header: 'Notizen', key: 'notes', width: 40 },
];
const EXPORT_EXTRA = [
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Ausgeliehen an', key: 'borrower', width: 20 },
    { header: 'Rückgabe bis', key: 'returnDate', width: 13, date: true },
];

const toDate = (iso) => (iso ? new Date(iso + 'T00:00:00Z') : null);

function styleSheet(sheet, columns) {
    sheet.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width, style: c.date ? { numFmt: 'dd.mm.yyyy' } : {} }));
    const head = sheet.getRow(1);
    head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0369A1' } };
    head.alignment = { vertical: 'middle' };
    head.height = 20;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

async function sendWorkbook(res, wb, filename) {
    res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
    });
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}

module.exports = function transferRoutes(app, { db, sessions, inventory }) {
    const { authenticate } = sessions;
    const canManageItems = [authenticate, requirePermission('can_manage_items')];

    function existingMaps(vereinId) {
        const rows = db.prepare(`SELECT id, device_id, seriennummer FROM equipment WHERE verein_id = ?`).all(vereinId);
        const byDeviceId = new Map(rows.map(r => [r.device_id.toLowerCase(), r.id]));
        const serialCount = new Map();
        for (const r of rows) if (r.seriennummer) serialCount.set(r.seriennummer.toLowerCase(), (serialCount.get(r.seriennummer.toLowerCase()) || []).concat(r.id));
        // Seriennummer nur verwenden, wenn sie eindeutig ist
        const bySerial = new Map([...serialCount].filter(([, ids]) => ids.length === 1).map(([k, ids]) => [k, ids[0]]));
        return { byDeviceId, bySerial };
    }

    // --- Export ---
    app.get('/api/export/inventar.xlsx', authenticate, async (req, res) => {
        const items = db.prepare(`
            SELECT e.device_id AS deviceId, e.name, k.name AS category, e.hersteller, e.seriennummer, e.groesse, e.lagerort, e.tuev,
                   e.condition, e.notes, CASE WHEN a.id IS NULL THEN 'Verfügbar' ELSE 'Ausgeliehen' END AS status, a.borrower, a.rueckgabe_geplant AS returnDate
            FROM equipment e JOIN kategorien k ON k.id = e.kategorie_id
            LEFT JOIN ausleihen a ON a.equipment_id = e.id AND a.zurueckgegeben_am IS NULL
            WHERE e.verein_id = ? ORDER BY k.prefix, e.device_id`).all(req.user.verein_id);

        const wb = new ExcelJS.Workbook();
        wb.creator = 'Equiply';
        const sheet = wb.addWorksheet('Inventar');
        const columns = [...COLUMNS, ...EXPORT_EXTRA];
        styleSheet(sheet, columns);
        for (const i of items) {
            sheet.addRow({ ...i, condition: CONDITION_LABELS[i.condition], tuev: toDate(i.tuev), returnDate: toDate(i.returnDate) });
        }
        sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
        await sendWorkbook(res, wb, `equiply-inventar-${today()}.xlsx`);
    });

    // --- Vorlage zum Ausfüllen ---
    app.get('/api/import/vorlage.xlsx', authenticate, async (req, res) => {
        const kategorien = inventory.categories(req.user.verein_id).map(k => k.name);
        const wb = new ExcelJS.Workbook();
        wb.creator = 'Equiply';
        const sheet = wb.addWorksheet('Inventar');
        styleSheet(sheet, COLUMNS);
        const listFormula = (values) => `"${values.join(',').replace(/"/g, '')}"`;
        for (let r = 2; r <= 500; r++) {
            if (kategorien.length && listFormula(kategorien).length < 250) {
                sheet.getCell(r, 3).dataValidation = { type: 'list', allowBlank: true, showErrorMessage: false, formulae: [listFormula(kategorien)] };
            }
            sheet.getCell(r, 10).dataValidation = { type: 'list', allowBlank: true, formulae: [listFormula(Object.values(CONDITION_LABELS))] };
        }

        const hints = wb.addWorksheet('Hinweise');
        hints.getColumn(1).width = 110;
        [
            'So füllst du die Vorlage aus:',
            '',
            '• Pro Zeile ein Gerät. Nur „Bezeichnung“ ist Pflicht, alle anderen Spalten sind optional.',
            '• Inventarnummer leer lassen → Equiply vergibt automatisch die nächste freie Nummer.',
            '• Inventarnummer, die es schon gibt → das vorhandene Gerät wird aktualisiert (nur ausgefüllte Felder).',
            `• Kategorie: ${kategorien.join(', ')}. Unbekannte Kategorien werden neu angelegt, leere landen in „Sonstiges“.`,
            '• Datumsangaben als Datum oder z. B. 31.12.2027. Beim TÜV reicht auch Monat/Jahr (z. B. 05/2027).',
            '• Zustand: Einwandfrei, Leichte Mängel oder Defekt.',
            '• Du kannst auch eine eigene Tabelle hochladen – Equiply erkennt die Spalten an den Überschriften.',
            '• Vor dem Übernehmen zeigt Equiply eine Vorschau mit allen erkannten Daten und Fehlern.',
        ].forEach((t, i) => { hints.getCell(i + 1, 1).value = t; if (i === 0) hints.getCell(1, 1).font = { bold: true, size: 13 }; });
        await sendWorkbook(res, wb, 'equiply-vorlage.xlsx');
    });

    // --- Import, Schritt 1: Datei prüfen und Vorschau liefern (es wird noch nichts gespeichert) ---
    app.post('/api/import/vorschau', ...canManageItems, express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
        const { byDeviceId, bySerial } = existingMaps(req.user.verein_id);
        const preview = await buildPreview(req.body, {
            categories: inventory.categories(req.user.verein_id),
            existingByDeviceId: byDeviceId,
            existingBySerial: bySerial,
        });
        res.json(preview);
    });

    // --- Import, Schritt 2: geprüfte Zeilen übernehmen ---
    app.post('/api/import', ...canManageItems, express.json({ limit: '10mb' }), (req, res) => {
        const zeilen = req.body.zeilen;
        const aktualisieren = req.body.aktualisieren !== false;
        if (!Array.isArray(zeilen) || !zeilen.length) throw new HttpError(400, 'Keine Zeilen zum Importieren.');
        if (zeilen.length > MAX_ROWS) throw new HttpError(400, `Maximal ${MAX_ROWS} Zeilen pro Import.`);

        const vereinId = req.user.verein_id;
        const result = { neu: 0, aktualisiert: 0, uebersprungen: 0, fehler: [], neueKategorien: [] };

        db.transaction(() => {
            let categories = inventory.categories(vereinId);
            let resolve = makeCategoryResolver(categories);
            const { byDeviceId, bySerial } = existingMaps(vereinId);

            for (const z of zeilen) {
                const nr = z && z.zeile;
                const d = (z && z.daten) || {};
                try {
                    db.transaction(() => {
                        // Kategorie zuordnen, unbekannte anlegen
                        let kategorie = null;
                        if (d.kategorie) {
                            kategorie = resolve(d.kategorie);
                            if (kategorie.neu) {
                                kategorie = inventory.createCategory(vereinId, kategorie.name);
                                result.neueKategorien.push(kategorie.name);
                                inventory.log(vereinId, req.user.id, null, 'kategorie', `Kategorie „${kategorie.name}“ (Kürzel ${kategorie.prefix}) beim Import erstellt`);
                                categories = inventory.categories(vereinId);
                                resolve = makeCategoryResolver(categories);
                            }
                        }
                        for (const f of ['tuev']) if (d[f] && !isIsoDate(d[f])) throw new HttpError(400, `${f === 'tuev' ? 'TÜV' : 'Kaufdatum'} ist ungültig`);
                        if (d.condition && !CONDITIONS.includes(d.condition)) throw new HttpError(400, 'Zustand ist ungültig');

                        const deviceId = d.deviceId ? String(d.deviceId).trim() : null;
                        const zielId = deviceId ? byDeviceId.get(deviceId.toLowerCase())
                            : (d.seriennummer ? bySerial.get(String(d.seriennummer).toLowerCase()) : undefined);

                        if (zielId) {
                            if (!aktualisieren) { result.uebersprungen++; return; }
                            const old = inventory.getItem(vereinId, zielId);
                            // Nur ausgefüllte Felder überschreiben, alles andere bleibt wie es ist
                            const merged = {};
                            for (const f of inventory.FIELDS) merged[f.key] = d[f.key] !== undefined && d[f.key] !== null && d[f.key] !== '' ? d[f.key] : old[f.key];
                            const fields = inventory.readFields(merged);
                            const kat = kategorie || { id: old.kategorie_id, name: old.kategorie };
                            if (inventory.update(vereinId, req.user.id, old, kat, fields)) result.aktualisiert++;
                            else result.uebersprungen++;
                        } else {
                            const fields = inventory.readFields(d);
                            const { id } = inventory.create(vereinId, req.user.id, kategorie || resolve(null) || inventory.createCategory(vereinId, 'Sonstiges'), fields, deviceId);
                            const created = db.prepare(`SELECT device_id FROM equipment WHERE id = ?`).get(id);
                            byDeviceId.set(created.device_id.toLowerCase(), id);
                            result.neu++;
                        }
                    })();
                } catch (e) {
                    if (!(e instanceof HttpError) && !String(e.code || '').startsWith('SQLITE_CONSTRAINT')) throw e;
                    result.fehler.push({ zeile: nr, text: e instanceof HttpError ? e.message : 'Ungültige Daten' });
                }
            }
            inventory.log(vereinId, req.user.id, null, 'import',
                `Import: ${result.neu} neu, ${result.aktualisiert} aktualisiert${result.uebersprungen ? `, ${result.uebersprungen} unverändert` : ''}${result.fehler.length ? `, ${result.fehler.length} fehlerhaft` : ''}`);
        })();

        res.json(result);
    });
};
