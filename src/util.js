const CONDITIONS = ['Gut', 'Gebrauchsspuren', 'Reparaturbedürftig'];
const CONDITION_LABELS = { Gut: 'Einwandfrei', Gebrauchsspuren: 'Leichte Mängel', Reparaturbedürftig: 'Defekt' };
const DEFAULT_CATEGORIES = [['Flaschen', '1'], ['Atemregler', '2'], ['Jackets', '3'], ['Blei', '4'], ['Sonstiges', '5']];
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

module.exports = {
    CONDITIONS, CONDITION_LABELS, DEFAULT_CATEGORIES, MIN_PASSWORD_LENGTH, HttpError,
    requireText, optionalText, requireEmail, requirePassword, optionalDate, isIsoDate, requireOneOf, requireId,
    today, formatDate, normalizeKey,
};
