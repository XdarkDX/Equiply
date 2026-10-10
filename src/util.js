const crypto = require('crypto');

const CONDITIONS = ['Gut', 'Gebrauchsspuren', 'Reparaturbedürftig'];
const CONDITION_LABELS = { Gut: 'Einwandfrei', Gebrauchsspuren: 'Leichte Mängel', Reparaturbedürftig: 'Defekt' };
const DEFAULT_CATEGORIES = ['Flaschen', 'Atemregler', 'Jackets', 'Blei', 'Sonstiges'];
const MIN_PASSWORD_LENGTH = 8;

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function requireText(value, field, max = 200) {
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} darf nicht leer sein.`);
    if (value.trim().length > max) throw new HttpError(400, `${field} ist zu lang (max. ${max} Zeichen).`);
    return value.trim();
}
function optionalText(value, field, max = 200) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') value = String(value);
    if (typeof value !== 'string') throw new HttpError(400, `${field} ist ungültig.`);
    if (value.trim().length > max) throw new HttpError(400, `${field} ist zu lang (max. ${max} Zeichen).`);
    return value.trim() || null;
}
function requireEmail(value) {
    const email = requireText(value, 'E-Mail', 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-Mail-Adresse ist ungültig.');
    return email;
}
function requirePassword(value) {
    if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
    if (Buffer.byteLength(value) > 72) throw new HttpError(400, 'Passwort ist zu lang (max. 72 Zeichen).');
    return value;
}
function isIsoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === value;
}
function optionalDate(value, field) {
    if (value === undefined || value === null || value === '') return null;
    if (!isIsoDate(value)) throw new HttpError(400, `${field} ist kein gültiges Datum.`);
    return value;
}
function requireOneOf(value, allowed, field) {
    if (!allowed.includes(value)) throw new HttpError(400, `${field} ist ungültig.`);
    return value;
}
function requireId(value, field = 'ID') {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, `Ungültige ${field}.`);
    return id;
}
function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function formatDate(iso) {
    if (!iso) return '–';
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
}
// Vergleichbare Form eines Textes: klein, ohne Umlaute/Sonderzeichen ("Nächster TÜV" -> "naechstertuev")
function normalizeKey(text) {
    return String(text ?? '').toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]/g, '');
}

// Bildtyp anhand der ersten Bytes erkennen (dem Content-Type-Header des Browsers wird nicht vertraut)
function detectImage(buf) {
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
    if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
    if (buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
    return null;
}

// ---------- Gerätecodes ----------
// Aufbau: Kategorie-Kürzel (2 Buchstaben, z. B. FL) + 4 zufällige Zeichen, angezeigt als „FL-7K3X“.
// Der Zufallsteil nutzt Crockford-Base32: keine leicht verwechselbaren Zeichen (kein I, L, O, U).
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_LENGTH = 4;
function randomPart(length = RANDOM_LENGTH) {
    let s = '';
    for (let i = 0; i < length; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    return s;
}
const generateCode = (length = 6) => randomPart(length); // für ältere Migrationen
// Eingaben vereinheitlichen: Großbuchstaben, Bindestriche/Leerzeichen weg; im Zufallsteil O -> 0, I/L -> 1
function normalizeCode(value) {
    const s = String(value ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
    if (s.length < 6) return s;
    const tail = s.slice(-RANDOM_LENGTH).replace(/O/g, '0').replace(/[IL]/g, '1');
    return s.slice(0, -RANDOM_LENGTH) + tail;
}
const NEW_CODE = /^[A-Z]{2,3}[0-9A-HJKMNP-TV-Z]{4}$/;
const OLD_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/; // ältere Codes ohne Kategorie (funktionieren beim Scannen weiter)
function isValidCode(code) {
    return NEW_CODE.test(code) || OLD_CODE.test(code);
}
function isCategoryCode(code) {
    return NEW_CODE.test(code);
}
// FL7K3X -> FL-7K3X
function formatCode(code) {
    return code && NEW_CODE.test(code) ? `${code.slice(0, -RANDOM_LENGTH)}-${code.slice(-RANDOM_LENGTH)}` : code;
}

// Kürzel aus dem Kategorienamen: zuerst die ersten zwei Buchstaben (Flaschen -> FL),
// sonst eine andere eindeutige Kombination; bei mehr als 676 Kategorien drei Buchstaben.
function derivePrefix(name, used) {
    const umlaut = (t) => t.toUpperCase().replace(/Ä/g, 'AE').replace(/Ö/g, 'OE').replace(/Ü/g, 'UE').replace(/ß/g, 'SS');
    const words = umlaut(String(name)).split(/[^A-Z]+/).filter(Boolean);
    const letters = words.join('') || 'X';
    const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    function* candidates() {
        if (letters.length > 1) yield letters.slice(0, 2);
        if (words.length > 1) yield words[0][0] + words[1][0];
        for (let i = 2; i < letters.length; i++) yield letters[0] + letters[i];
        for (const b of AZ) yield letters[0] + b;
        for (const a of AZ) for (const b of AZ) yield a + b;
        if (letters.length > 2) yield letters.slice(0, 3);
        for (const c of AZ) yield letters.slice(0, 2).padEnd(2, 'X') + c;
        for (const a of AZ) for (const b of AZ) for (const c of AZ) yield a + b + c;
    }
    for (const p of candidates()) if (!used.has(p)) return p;
    throw new HttpError(409, 'Es konnte kein freies Kürzel gefunden werden.');
}

module.exports = {
    CONDITIONS, CONDITION_LABELS, DEFAULT_CATEGORIES, MIN_PASSWORD_LENGTH, HttpError,
    requireText, optionalText, requireEmail, requirePassword, optionalDate, isIsoDate, requireOneOf, requireId,
    today, formatDate, normalizeKey, detectImage, randomPart, generateCode, normalizeCode, isValidCode, isCategoryCode, formatCode, derivePrefix,
};
