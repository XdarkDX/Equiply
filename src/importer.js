// Liest Excel- (.xlsx) und CSV-Dateien und erkennt die Spalten automatisch.
const ExcelJS = require('exceljs');
const { HttpError, normalizeKey, normalizeCode, isValidCode } = require('./util');

const MAX_ROWS = 5000;

// Spaltenüberschriften (normalisiert) -> Feld
const HEADER_SYNONYMS = {
    code: ['code', 'geraetecode', 'qrcode', 'qr', 'qrid', 'qrkennung', 'qrcodeid', 'inventarnummer', 'inventarnr', 'invnr', 'inventar',
        'nummer', 'nr', 'id', 'systemid', 'geraetenummer', 'geraetenr', 'geraeteid', 'kennung'],
    name: ['bezeichnung', 'name', 'geraet', 'geraetename', 'artikel', 'artikelname', 'gegenstand', 'equipment', 'titel', 'item', 'produkt', 'modell'],
    kategorie: ['kategorie', 'kategorien', 'typ', 'art', 'gruppe', 'category', 'geraetetyp', 'geraeteart'],
    hersteller: ['hersteller', 'marke', 'brand', 'manufacturer', 'fabrikat'],
    seriennummer: ['seriennummer', 'seriennr', 'sn', 'snr', 'serial', 'serialnumber'],
    groesse: ['groesse', 'size', 'volumen', 'liter', 'inhalt', 'gewicht'],
    lagerort: ['lagerort', 'standort', 'ort', 'lager', 'platz', 'location', 'aufbewahrung', 'regal', 'schrank'],
    tuev: ['tuev', 'tuv', 'tuevbis', 'tuevdatum', 'naechstertuev', 'tuevfaellig', 'pruefung', 'tuevpruefung', 'pruefdatum', 'naechstepruefung',
        'pruefungbis', 'wartung', 'naechstewartung', 'wartungbis', 'faellig', 'faelligkeit'],
    condition: ['zustand', 'condition'],
    notes: ['notizen', 'notiz', 'bemerkung', 'bemerkungen', 'kommentar', 'kommentare', 'anmerkung', 'anmerkungen', 'info', 'hinweis', 'notes', 'beschreibung'],
};
// Teilwörter, falls keine exakte Übereinstimmung gefunden wurde
const HEADER_CONTAINS = [['code', 'code'], ['tuev', 'tuev'], ['pruef', 'tuev'], ['wartung', 'tuev'], ['serien', 'seriennummer'], ['inventar', 'code'],
    ['bezeichnung', 'name'], ['kategorie', 'kategorie'], ['hersteller', 'hersteller'], ['lagerort', 'lagerort'], ['standort', 'lagerort'],
    ['zustand', 'condition'], ['bemerk', 'notes'], ['notiz', 'notes'], ['groesse', 'groesse']];

const CATEGORY_SYNONYMS = {
    flaschen: ['flasche', 'flaschen', 'pressluftflasche', 'tauchflasche', 'tank', 'cylinder', 'stahlflasche', 'aluflasche'],
    atemregler: ['atemregler', 'regler', 'automat', 'lungenautomat', 'regulator', '1stufe', '2stufe', 'oktopus', 'octopus'],
    jackets: ['jacket', 'jackets', 'tarierjacket', 'tarierweste', 'bcd', 'wing', 'jacket'],
    blei: ['blei', 'gewicht', 'gewichte', 'bleigurt', 'bleitaschen', 'weights'],
};

const CONDITION_MAP = [
    ['Reparaturbedürftig', ['defekt', 'kaputt', 'reparatur', 'reparaturbeduerftig', 'ausserbetrieb', 'gesperrt', 'nichtok', 'mangelhaft']],
    ['Gebrauchsspuren', ['gebrauchsspuren', 'leichtemaengel', 'maengel', 'gebraucht', 'befriedigend', 'mittel', 'ausreichend']],
    ['Gut', ['gut', 'einwandfrei', 'ok', 'neu', 'sehrgut', 'neuwertig', 'top', 'intakt']],
];

// ---------- Datei lesen ----------

function cellValue(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
        if ('result' in v) return cellValue(v.result);
        if ('text' in v) return cellValue(v.text);
        if ('error' in v) return null;
        return null;
    }
    if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
    return v;
}

async function readXlsx(buffer) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); } catch (e) { throw new HttpError(400, 'Die Excel-Datei konnte nicht gelesen werden. Ist sie beschädigt oder passwortgeschützt?'); }
    const sheet = wb.worksheets.find(ws => ws.actualRowCount > 0);
    if (!sheet) throw new HttpError(400, 'Die Excel-Datei enthält keine Daten.');
    const rows = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        const values = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = cellValue(cell.value); });
        rows.push({ nr: rowNumber, values });
    });
    return rows;
}

function decodeText(buffer) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, ''); } catch (e) {
        return new TextDecoder('windows-1252').decode(buffer); // ältere Excel-CSV-Exporte
    }
}

function parseCsv(text) {
    const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
    const delimiter = [';', ',', '\t'].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], field = '', quoted = false, nr = 1;
    const pushRow = () => {
        row.push(field); field = '';
        if (row.some(v => v.trim() !== '')) rows.push({ nr, values: row.map(v => (v.trim() === '' ? null : v.trim())) });
        row = []; nr++;
    };
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
        } else if (c === '"' && field === '') quoted = true;
        else if (c === delimiter) { row.push(field); field = ''; }
        else if (c === '\n') pushRow();
        else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) pushRow();
    return rows;
}

async function readFile(buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, 'Keine Datei empfangen.');
    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
        throw new HttpError(400, 'Das alte Excel-Format (.xls) wird nicht unterstützt. Bitte in Excel „Speichern unter“ → „Excel-Arbeitsmappe (.xlsx)“ wählen.');
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) return readXlsx(buffer);
    return parseCsv(decodeText(buffer));
}

// ---------- Spalten erkennen ----------

function matchHeader(text) {
    const key = normalizeKey(text);
    if (!key) return null;
    for (const [field, names] of Object.entries(HEADER_SYNONYMS)) if (names.includes(key)) return field;
    for (const [part, field] of HEADER_CONTAINS) if (key.includes(part)) return field;
    return null;
}

function detectColumns(rows) {
    let best = null;
    for (const row of rows.slice(0, 10)) {
        const mapping = {};
        const ignored = [];
        row.values.forEach((v, col) => {
            if (v === null || v === undefined) return;
            const field = matchHeader(v);
            if (field && mapping[field] === undefined) mapping[field] = { col, header: String(v) };
            else ignored.push(String(v));
        });
        const score = Object.keys(mapping).length;
        if (mapping.name && (!best || score > best.score)) best = { row, mapping, ignored, score };
    }
    if (!best) {
        const first = rows[0] ? rows[0].values.filter(Boolean).join(', ') : '';
        throw new HttpError(400, `Keine Spalte „Bezeichnung“ gefunden. Die erste Zeile muss Überschriften enthalten (z. B. Bezeichnung, Kategorie, TÜV).${first ? ` Gefunden: ${first.slice(0, 200)}` : ''}`);
    }
    return best;
}

// ---------- Werte umwandeln ----------

const pad = (n) => String(n).padStart(2, '0');
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function validYmd(y, m, d) {
    if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > lastDayOfMonth(y, m)) return null;
    return `${y}-${pad(m)}-${pad(d)}`;
}

// Liefert { iso } oder { iso, hinweis } oder { fehler }
function parseDate(v, field) {
    if (v === null || v === undefined) return { iso: null };
    if (v instanceof Date) return { iso: validYmd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) };
    if (typeof v === 'number') {
        if (v >= 1900 && v <= 2200 && Number.isInteger(v)) v = String(v);
        else if (v > 1 && v < 100000) {
            const d = new Date(Math.round((v - 25569) * 86400000));
            return { iso: validYmd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) };
        }
    }
    const s = String(v).trim();
    let m;
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return check(validYmd(+m[1], +m[2], +m[3]));
    if ((m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})$/))) return check(validYmd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]));
    if ((m = s.match(/^(\d{1,2})\s*[./-]\s*(\d{4}|\d{2})$/))) {
        const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
        const mo = +m[1];
        const iso = mo >= 1 && mo <= 12 ? validYmd(y, mo, field === 'tuev' ? lastDayOfMonth(y, mo) : 1) : null;
        return iso ? { iso, hinweis: `${s} als ${iso.split('-').reverse().join('.')} übernommen` } : { fehler: `Datum „${s}“ nicht erkannt` };
    }
    if ((m = s.match(/^(\d{4})$/))) {
        const iso = field === 'tuev' ? `${m[1]}-12-31` : `${m[1]}-01-01`;
        return { iso, hinweis: `${s} als ${iso.split('-').reverse().join('.')} übernommen` };
    }
    return { fehler: `Datum „${s}“ nicht erkannt` };

    function check(iso) { return iso ? { iso } : { fehler: `Datum „${s}“ ist ungültig` }; }
}

function parseCondition(v) {
    if (v === null || v === undefined) return { value: null };
    const key = normalizeKey(v);
    for (const [value, words] of CONDITION_MAP) if (words.some(w => key === w || key.startsWith(w))) return { value };
    return { value: 'Gut', hinweis: `Zustand „${v}“ unbekannt – als „Einwandfrei“ übernommen` };
}

function toText(v, max) {
    if (v === null || v === undefined) return null;
    let s = v instanceof Date ? `${pad(v.getUTCDate())}.${pad(v.getUTCMonth() + 1)}.${v.getUTCFullYear()}` : String(v).trim();
    return s ? s.slice(0, max) : null;
}

// Ordnet einen Kategorienamen aus der Datei einer bestehenden Kategorie zu
function makeCategoryResolver(categories) {
    const byKey = new Map(categories.map(k => [normalizeKey(k.name), k]));
    return (raw) => {
        if (raw === null || raw === undefined || String(raw).trim() === '') {
            return byKey.get('sonstiges') || categories[0];
        }
        const key = normalizeKey(raw);
        if (byKey.has(key)) return byKey.get(key);
        for (const k of categories) {
            const kk = normalizeKey(k.name);
            if (key.length >= 4 && kk.length >= 4 && (kk.startsWith(key) || key.startsWith(kk))) return k;
        }
        for (const [katKey, words] of Object.entries(CATEGORY_SYNONYMS)) {
            if (byKey.has(katKey) && words.some(w => key === w || key.includes(w))) return byKey.get(katKey);
        }
        return { neu: true, name: String(raw).trim().slice(0, 50) };
    };
}

// ---------- Vorschau ----------

/**
 * Liest die Datei und bereitet jede Zeile auf.
 * existingByCode: Code (auch alte Codes) -> Geräte-ID, existingBySerial: Seriennummer -> Geräte-ID
 */
async function buildPreview(buffer, { categories, existingByCode, existingBySerial }) {
    const rows = await readFile(buffer);
    if (!rows.length) throw new HttpError(400, 'Die Datei ist leer.');
    const { row: headerRow, mapping, ignored } = detectColumns(rows);
    const dataRows = rows.filter(r => r.nr > headerRow.nr);
    if (dataRows.length > MAX_ROWS) throw new HttpError(400, `Zu viele Zeilen (${dataRows.length}). Maximal ${MAX_ROWS} pro Import.`);

    const resolveCategory = makeCategoryResolver(categories);
    const seenCodes = new Map();
    const newCategories = new Set();
    const get = (r, field) => (mapping[field] ? r.values[mapping[field].col] ?? null : undefined);

    const zeilen = [];
    for (const r of dataRows) {
        const fehler = [], hinweise = [];
        const daten = {};

        for (const field of ['hersteller', 'seriennummer', 'groesse', 'lagerort']) {
            const v = get(r, field);
            if (v !== undefined) daten[field] = toText(v, 100);
        }
        if (mapping.notes) daten.notes = toText(get(r, 'notes'), 2000);
        let codeRaw = null;
        if (mapping.code) {
            codeRaw = toText(get(r, 'code'), 30);
            daten.code = codeRaw ? normalizeCode(codeRaw) : null;
        }
        daten.name = toText(get(r, 'name'), 100);

        for (const field of ['tuev']) {
            if (!mapping[field]) continue;
            const d = parseDate(get(r, field), field);
            if (d.fehler) fehler.push(`${field === 'tuev' ? 'TÜV' : 'Kaufdatum'}: ${d.fehler}`);
            if (d.hinweis) hinweise.push(d.hinweis);
            daten[field] = d.iso ?? null;
        }
        if (mapping.condition) {
            const c = parseCondition(get(r, 'condition'));
            if (c.hinweis) hinweise.push(c.hinweis);
            daten.condition = c.value;
        }

        const katRaw = get(r, 'kategorie');
        if (katRaw !== undefined && katRaw !== null) {
            const k = resolveCategory(katRaw);
            daten.kategorie = k.name;
            if (k.neu) { newCategories.add(k.name); hinweise.push(`Neue Kategorie „${k.name}“ wird angelegt`); }
        } else if (katRaw === undefined || katRaw === null) {
            daten.kategorie = null; // bei neuen Geräten -> Sonstiges, bei Updates bleibt die Kategorie
        }

        // Komplett leere Zeilen überspringen
        if (Object.values(daten).every(v => v === null || v === undefined)) continue;
        if (!daten.name) fehler.push('Bezeichnung fehlt');

        let aktion = 'neu', zielId = null;
        if (daten.code) {
            if (seenCodes.has(daten.code)) fehler.push(`Code ${codeRaw} kommt doppelt vor (auch Zeile ${seenCodes.get(daten.code)})`);
            seenCodes.set(daten.code, r.nr);
        }
        // Zuordnung zu vorhandenen Geräten: zuerst über den Code (auch alte Codes/Nummern), dann Seriennummer
        if (daten.code && existingByCode.has(daten.code)) {
            zielId = existingByCode.get(daten.code);
        } else if (daten.code && !isValidCode(daten.code)) {
            hinweise.push(`Code „${codeRaw}“ ist unbekannt – es wird ein neuer Code vergeben`);
            daten.code = null;
        } else if (daten.code) {
            hinweise.push(`Code ${codeRaw} wird übernommen`);
        }
        if (!zielId && daten.seriennummer && existingBySerial.has(daten.seriennummer.toLowerCase())) {
            zielId = existingBySerial.get(daten.seriennummer.toLowerCase());
            hinweise.push('Über die Seriennummer einem vorhandenen Gerät zugeordnet');
        }
        if (zielId) aktion = 'aktualisieren';
        if (fehler.length) aktion = 'fehler';

        zeilen.push({ zeile: r.nr, aktion, zielId, daten, fehler, hinweise });
    }

    const spalten = Object.fromEntries(Object.entries(mapping).map(([f, m]) => [f, m.header]));
    return { spalten, ignoriert: ignored, neueKategorien: [...newCategories], zeilen };
}

module.exports = { buildPreview, parseDate, parseCsv, matchHeader, makeCategoryResolver, MAX_ROWS };
