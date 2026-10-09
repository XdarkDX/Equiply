// Gemeinsame Inventar-Logik für Formular-API und Excel-Import
const MAX_PER_CATEGORY = 999;
const { HttpError, CONDITIONS, CONDITION_LABELS, requireText, optionalText, optionalDate, requireOneOf, requireId, formatDate } = require('./util');

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

function prefixConflict(a, b) {
    return a.startsWith(b) || b.startsWith(a);
}

function createInventory(db) {
    const q = {
        kategorien: db.prepare(`SELECT id, name, prefix FROM kategorien WHERE verein_id = ? ORDER BY prefix`),
        kategorie: db.prepare(`SELECT id, name, prefix FROM kategorien WHERE id = ? AND verein_id = ?`),
        deviceIdTaken: db.prepare(`SELECT id FROM equipment WHERE verein_id = ? AND device_id = ?`),
        usedNrs: db.prepare(`SELECT device_id FROM equipment WHERE verein_id = ? AND length(device_id) = ? AND device_id GLOB ? || '[0-9][0-9][0-9]'`),
        insert: db.prepare(`INSERT INTO equipment (verein_id, kategorie_id, device_id, name, hersteller, seriennummer, groesse, lagerort, tuev, condition, notes)
                            VALUES (@verein_id, @kategorie_id, @device_id, @name, @hersteller, @seriennummer, @groesse, @lagerort, @tuev, @condition, @notes)`),
        update: db.prepare(`UPDATE equipment SET kategorie_id = @kategorie_id, device_id = @device_id, name = @name, hersteller = @hersteller, seriennummer = @seriennummer, groesse = @groesse,
                            lagerort = @lagerort, tuev = @tuev, condition = @condition, notes = @notes WHERE id = @id`),
        byId: db.prepare(`SELECT e.*, k.name AS kategorie FROM equipment e JOIN kategorien k ON k.id = e.kategorie_id WHERE e.id = ? AND e.verein_id = ?`),
        log: db.prepare(`INSERT INTO aktivitaeten (verein_id, nutzer_id, equipment_id, aktion, details) VALUES (?, ?, ?, ?, ?)`),
    };

    function log(vereinId, userId, equipmentId, aktion, details) {
        q.log.run(vereinId, userId || null, equipmentId || null, aktion, details || null);
    }

    function getCategory(vereinId, id) {
        const k = q.kategorie.get(requireId(id, 'Kategorie'), vereinId);
        if (!k) throw new HttpError(400, 'Kategorie existiert nicht.');
        return k;
    }

    function validatePrefix(vereinId, prefix, exceptId = null) {
        if (typeof prefix !== 'string' || !/^[0-9A-Z]{1,4}$/.test(prefix)) throw new HttpError(400, 'Kürzel: 1–4 Zeichen, nur Ziffern und Großbuchstaben.');
        const clash = q.kategorien.all(vereinId).find(k => k.id !== exceptId && prefixConflict(k.prefix, prefix));
        if (clash) throw new HttpError(409, `Kürzel „${prefix}“ überschneidet sich mit „${clash.prefix}“ (${clash.name}). Inventarnummern wären nicht mehr eindeutig.`);
        return prefix;
    }

    // Schlägt ein freies Kürzel vor: zuerst Ziffern 1–9, dann Buchstaben aus dem Namen
    function suggestPrefix(vereinId, name) {
        const existing = q.kategorien.all(vereinId).map(k => k.prefix);
        const free = (p) => !existing.some(e => prefixConflict(e, p));
        for (let i = 1; i <= 9; i++) if (free(String(i))) return String(i);
        const letters = String(name).toUpperCase().replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/[^A-Z]/g, '') || 'K';
        for (const len of [2, 3, 4]) if (letters.length >= len && free(letters.slice(0, len))) return letters.slice(0, len);
        for (let i = 1; i < 1000; i++) if (free(letters[0] + i)) return (letters[0] + i).slice(0, 4);
        throw new HttpError(409, 'Kein freies Kürzel gefunden.');
    }

    function createCategory(vereinId, name, prefix) {
        name = requireText(name, 'Kategoriename', 50);
        prefix = prefix ? validatePrefix(vereinId, String(prefix).toUpperCase().trim()) : suggestPrefix(vereinId, name);
        const id = Number(db.prepare(`INSERT INTO kategorien (verein_id, name, prefix) VALUES (?, ?, ?)`).run(vereinId, name, prefix).lastInsertRowid);
        return { id, name, prefix };
    }

    // Kleinste freie Inventarnummer der Kategorie: Kürzel + 3 Stellen (1001 … 1999, LA001 … LA999).
    // Nummern gelöschter Geräte werden so wiederverwendet – alte QR-Etiketten passen dann zum neuen Gerät.
    function nextDeviceId(vereinId, kategorie) {
        const used = new Set(q.usedNrs.all(vereinId, kategorie.prefix.length + 3, kategorie.prefix)
            .map(r => Number(r.device_id.slice(kategorie.prefix.length))));
        for (let nr = 1; nr <= MAX_PER_CATEGORY; nr++) {
            const id = kategorie.prefix + String(nr).padStart(3, '0');
            if (!used.has(nr) && !q.deviceIdTaken.get(vereinId, id)) return id;
        }
        throw new HttpError(409, `Die Kategorie „${kategorie.name}“ ist voll (maximal ${MAX_PER_CATEGORY} Geräte).`);
    }

    // Prüft Formulardaten und liefert ein sauberes Objekt für die Datenbank
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

    function create(vereinId, userId, kategorie, fields, deviceId = null) {
        if (deviceId) {
            deviceId = requireText(String(deviceId), 'Inventarnummer', 30);
            if (q.deviceIdTaken.get(vereinId, deviceId)) throw new HttpError(409, `Inventarnummer ${deviceId} ist schon vergeben.`);
        } else {
            deviceId = nextDeviceId(vereinId, kategorie);
        }
        const id = Number(q.insert.run({ ...fields, verein_id: vereinId, kategorie_id: kategorie.id, device_id: deviceId }).lastInsertRowid);
        log(vereinId, userId, id, 'erstellt', `${fields.name} (${deviceId}) angelegt`);
        return { id, deviceId };
    }

    function display(key, value) {
        if (value === null || value === undefined || value === '') return '–';
        if (key === 'tuev') return formatDate(value);
        if (key === 'condition') return CONDITION_LABELS[value] || value;
        if (key === 'notes') return value.length > 40 ? value.slice(0, 40) + '…' : value;
        return value;
    }

    // Aktualisiert ein Gerät und schreibt die Änderungen verständlich ins Protokoll
    // Bei einem Kategoriewechsel bekommt das Gerät eine neue Nummer aus dem Bereich der neuen Kategorie.
    function update(vereinId, userId, old, kategorie, fields) {
        const moved = old.kategorie_id !== kategorie.id;
        const deviceId = moved ? nextDeviceId(vereinId, kategorie) : old.device_id;
        q.update.run({ ...fields, id: old.id, kategorie_id: kategorie.id, device_id: deviceId });
        const changes = [];
        if (moved) changes.push(`Kategorie: ${old.kategorie} → ${kategorie.name}`, `Inventarnummer: ${old.device_id} → ${deviceId}`);
        for (const f of FIELDS) {
            if ((old[f.key] ?? null) !== (fields[f.key] ?? null)) changes.push(`${f.label}: ${display(f.key, old[f.key])} → ${display(f.key, fields[f.key])}`);
        }
        if (!changes.length) return false;

        const onlyTuev = changes.length === 1 && old.tuev !== fields.tuev;
        const repaired = changes.length === 1 && old.condition === 'Reparaturbedürftig' && fields.condition !== 'Reparaturbedürftig';
        if (onlyTuev) log(vereinId, userId, old.id, 'tuev', `TÜV/Prüfung erneuert: gültig bis ${display('tuev', fields.tuev)}`);
        else if (repaired) log(vereinId, userId, old.id, 'repariert', 'Als repariert markiert');
        else log(vereinId, userId, old.id, 'bearbeitet', changes.join('; '));
        return true;
    }

    function getItem(vereinId, id) {
        const item = q.byId.get(requireId(id), vereinId);
        if (!item) throw new HttpError(404, 'Gerät nicht gefunden.');
        return item;
    }

    return { FIELDS, log, getCategory, createCategory, validatePrefix, suggestPrefix, nextDeviceId, readFields, create, update, getItem, categories: (v) => q.kategorien.all(v) };
}

module.exports = { createInventory, FIELDS };
