// Gemeinsame Inventar-Logik für Formular-API und Excel-Import
const {
    HttpError, CONDITIONS, CONDITION_LABELS, requireText, optionalText, optionalDate, requireOneOf, requireId, formatDate,
    randomPart, normalizeCode, isValidCode, isCategoryCode, formatCode, derivePrefix,
} = require('./util');

// Felder, die man bearbeiten kann, mit Anzeigenamen (für Protokoll, Export und Import)
const FIELDS = [
    { key: 'name', label: 'Bezeichnung', max: 100 },
    { key: 'hersteller', label: 'Hersteller', max: 100 },
    { key: 'seriennummer', label: 'Seriennummer', max: 100 },
    { key: 'groesse', label: 'Größe', max: 50 },
    { key: 'lagerort', label: 'Lagerort', max: 100 },
    { key: 'tuev', label: 'TÜV / Prüfung', date: true },
    { key: 'condition', label: 'Zustand' },
    { key: 'notes', label: 'Notizen', max: 2000 },
];

/*
 * Gerätecodes (Tabelle qr_codes):
 *  - aktueller Code eines Geräts:  equipment_id = Gerät und code = equipment.device_id
 *  - alter Code eines Geräts:      equipment_id = Gerät, aber ein anderer Code (z. B. vor einem Kategoriewechsel) –
 *                                  alte Schilder öffnen beim Scannen weiterhin das Gerät
 *  - freier Code (Vorrat):         equipment_id = NULL, gehört zu einer Kategorie
 */
function createInventory(db) {
    const q = {
        kategorien: db.prepare(`SELECT id, name, prefix FROM kategorien WHERE verein_id = ? ORDER BY name COLLATE NOCASE`),
        kategorie: db.prepare(`SELECT id, name, prefix FROM kategorien WHERE id = ? AND verein_id = ?`),
        insert: db.prepare(`INSERT INTO equipment (verein_id, kategorie_id, device_id, name, hersteller, seriennummer, groesse, lagerort, tuev, condition, notes)
                            VALUES (@verein_id, @kategorie_id, @device_id, @name, @hersteller, @seriennummer, @groesse, @lagerort, @tuev, @condition, @notes)`),
        update: db.prepare(`UPDATE equipment SET kategorie_id = @kategorie_id, device_id = @device_id, name = @name, hersteller = @hersteller, seriennummer = @seriennummer, groesse = @groesse,
                            lagerort = @lagerort, tuev = @tuev, condition = @condition, notes = @notes WHERE id = @id`),
        setDeviceCode: db.prepare(`UPDATE equipment SET device_id = ? WHERE id = ?`),
        byId: db.prepare(`SELECT e.*, k.name AS kategorie, k.prefix FROM equipment e JOIN kategorien k ON k.id = e.kategorie_id WHERE e.id = ? AND e.verein_id = ?`),
        codeRow: db.prepare(`SELECT code, verein_id, equipment_id, kategorie_id FROM qr_codes WHERE code = ?`),
        insertCode: db.prepare(`INSERT OR IGNORE INTO qr_codes (code, verein_id, equipment_id, kategorie_id) VALUES (?, ?, ?, ?)`),
        claimCode: db.prepare(`UPDATE qr_codes SET equipment_id = ?, kategorie_id = ? WHERE code = ?`),
        releaseCode: db.prepare(`UPDATE qr_codes SET equipment_id = NULL WHERE code = ?`),
        makeOld: db.prepare(`UPDATE qr_codes SET kategorie_id = NULL WHERE code = ?`),
        deleteOldCodes: db.prepare(`DELETE FROM qr_codes WHERE equipment_id = ? AND code <> ?`),
        log: db.prepare(`INSERT INTO aktivitaeten (verein_id, nutzer_id, equipment_id, aktion, details) VALUES (?, ?, ?, ?, ?)`),
    };

    function log(vereinId, userId, equipmentId, aktion, details) {
        q.log.run(vereinId, userId || null, equipmentId || null, aktion, details || null);
    }

    // ---------- Kategorien ----------
    function getCategory(vereinId, id) {
        const k = q.kategorie.get(requireId(id, 'Kategorie'), vereinId);
        if (!k) throw new HttpError(400, 'Kategorie existiert nicht.');
        return k;
    }

    // Beim Anlegen genügt der Name – das Kürzel (z. B. FL) wird automatisch und eindeutig vergeben
    function createCategory(vereinId, name) {
        name = requireText(name, 'Kategoriename', 50);
        const prefix = derivePrefix(name, new Set(q.kategorien.all(vereinId).map(k => k.prefix)));
        const id = Number(db.prepare(`INSERT INTO kategorien (verein_id, name, prefix) VALUES (?, ?, ?)`).run(vereinId, name, prefix).lastInsertRowid);
        return { id, name, prefix };
    }

    // ---------- Codes ----------
    // Neuer, noch nie vergebener Code der Kategorie (optional mit Wunsch-Zufallsteil)
    function newCode(vereinId, kategorie, equipmentId = null, wish = null) {
        for (let i = 0; ; i++) {
            const code = kategorie.prefix + (i === 0 && wish ? wish : randomPart());
            if (q.insertCode.run(code, vereinId, equipmentId, kategorie.id).changes) return code;
        }
    }

    // Prüft einen eingegebenen/gescannten Code, der einem Gerät der Kategorie gegeben werden soll
    function checkCode(vereinId, raw, kategorie, equipmentId = null) {
        const code = normalizeCode(raw);
        if (!isValidCode(code)) throw new HttpError(400, `„${raw}“ ist kein gültiger Code.`);
        const row = q.codeRow.get(code);
        if (row && row.verein_id !== vereinId) throw new HttpError(409, `Der Code ${formatCode(code)} gehört zu einem anderen Verein.`);
        if (row && row.equipment_id && row.equipment_id !== equipmentId) throw new HttpError(409, `Der Code ${formatCode(code)} ist schon einem anderen Gerät zugeordnet.`);
        const fits = row && row.kategorie_id ? row.kategorie_id === kategorie.id : (isCategoryCode(code) && code.slice(0, -4) === kategorie.prefix);
        if (!fits) throw new HttpError(409, `Der Code ${formatCode(code)} passt nicht zur Kategorie „${kategorie.name}“ (Codes beginnen dort mit ${kategorie.prefix}).`);
        return { code, row };
    }

    function claim(vereinId, equipmentId, kategorie, checked) {
        if (checked.row) q.claimCode.run(equipmentId, kategorie.id, checked.code);
        else q.insertCode.run(checked.code, vereinId, equipmentId, kategorie.id);
    }

    // ---------- Geräte ----------
    function readFields(body) {
        const out = {};
        for (const f of FIELDS) {
            if (f.key === 'name') out.name = requireText(body.name, 'Bezeichnung', f.max);
            else if (f.key === 'condition') out.condition = body.condition ? requireOneOf(body.condition, CONDITIONS, 'Zustand') : 'Gut';
            else if (f.date) out[f.key] = optionalDate(body[f.key], f.label);
            else out[f.key] = optionalText(body[f.key], f.label, f.max);
        }
        return out;
    }

    // Legt ein Gerät an. Ohne Angabe bekommt es automatisch einen neuen Code seiner Kategorie,
    // sonst den angegebenen (z. B. von einem schon gelaserten Schild aus dem Vorrat).
    function create(vereinId, userId, kategorie, fields, wantedCode = null) {
        const checked = wantedCode ? checkCode(vereinId, wantedCode, kategorie) : null;
        let code = checked ? checked.code : null;
        if (!code) do { code = kategorie.prefix + randomPart(); } while (q.codeRow.get(code));
        const id = Number(q.insert.run({ ...fields, verein_id: vereinId, kategorie_id: kategorie.id, device_id: code }).lastInsertRowid);
        claim(vereinId, id, kategorie, checked || { code, row: null });
        log(vereinId, userId, id, 'erstellt', `${fields.name} (${formatCode(code)}) angelegt`);
        return { id, code };
    }

    function display(key, value) {
        if (value === null || value === undefined || value === '') return '–';
        if (key === 'tuev') return formatDate(value);
        if (key === 'condition') return CONDITION_LABELS[value] || value;
        if (key === 'notes') return value.length > 40 ? value.slice(0, 40) + '…' : value;
        return value;
    }

    // Aktualisiert ein Gerät und schreibt die Änderungen verständlich ins Protokoll.
    // Bei einem Kategoriewechsel bekommt es das neue Kürzel (FL-7K3X -> AT-7K3X); der alte Code bleibt beim Scannen gültig.
    function update(vereinId, userId, old, kategorie, fields) {
        const moved = old.kategorie_id !== kategorie.id;
        let code = old.device_id;
        if (moved) {
            q.makeOld.run(old.device_id);
            const wish = isCategoryCode(old.device_id) ? old.device_id.slice(-4) : null;
            code = newCode(vereinId, kategorie, old.id, wish);
        }
        q.update.run({ ...fields, id: old.id, kategorie_id: kategorie.id, device_id: code });
        const changes = [];
        if (moved) changes.push(`Kategorie: ${old.kategorie} → ${kategorie.name}`, `Code: ${formatCode(old.device_id)} → ${formatCode(code)} (altes Schild bleibt gültig)`);
        for (const f of FIELDS) {
            if ((old[f.key] ?? null) !== (fields[f.key] ?? null)) changes.push(`${f.label}: ${display(f.key, old[f.key])} → ${display(f.key, fields[f.key])}`);
        }
        if (!changes.length) return { changed: false, code };

        const onlyTuev = changes.length === 1 && old.tuev !== fields.tuev;
        const repaired = changes.length === 1 && old.condition === 'Reparaturbedürftig' && fields.condition !== 'Reparaturbedürftig';
        if (onlyTuev) log(vereinId, userId, old.id, 'tuev', `TÜV/Prüfung erneuert: gültig bis ${display('tuev', fields.tuev)}`);
        else if (repaired) log(vereinId, userId, old.id, 'repariert', 'Als repariert markiert');
        else log(vereinId, userId, old.id, 'bearbeitet', changes.join('; '));
        return { changed: true, code };
    }

    // Anderes Schild verwenden: Gerät bekommt einen freien Code seiner Kategorie, der bisherige wird frei
    function replaceCode(vereinId, userId, item, raw) {
        const kategorie = { id: item.kategorie_id, name: item.kategorie, prefix: item.prefix };
        const checked = checkCode(vereinId, raw, kategorie, item.id);
        if (checked.code === item.device_id) return item.device_id;
        q.releaseCode.run(item.device_id);
        claim(vereinId, item.id, kategorie, checked);
        q.setDeviceCode.run(checked.code, item.id);
        log(vereinId, userId, item.id, 'qr', `Code ${formatCode(item.device_id)} → ${formatCode(checked.code)} (${formatCode(item.device_id)} ist jetzt frei)`);
        return checked.code;
    }

    // Vor dem Löschen: alte Codes entfernen, der aktuelle Code wird wieder frei (Schild kann weiterverwendet werden)
    function prepareDelete(item) {
        q.deleteOldCodes.run(item.id, item.device_id);
    }

    function getItem(vereinId, id) {
        const item = q.byId.get(requireId(id), vereinId);
        if (!item) throw new HttpError(404, 'Gerät nicht gefunden.');
        return item;
    }

    return {
        FIELDS, log, getCategory, createCategory, newCode, checkCode, readFields, create, update, replaceCode, prepareDelete, getItem,
        categories: (v) => q.kategorien.all(v),
    };
}

module.exports = { createInventory, FIELDS };
