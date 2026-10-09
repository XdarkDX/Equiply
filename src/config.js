const crypto = require('crypto');
const path = require('path');

// .env laden, falls vorhanden (Node >= 20.12)
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (e) { /* keine .env vorhanden */ }

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    jwtSecret = crypto.randomBytes(48).toString('hex');
    console.warn('[WARNUNG] JWT_SECRET ist nicht gesetzt – es wird ein zufälliger Schlüssel verwendet. ' +
        'Alle Logins werden bei jedem Neustart ungültig. Bitte JWT_SECRET in der .env setzen.');
}

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'equiply.db');

module.exports = {
    port: parseInt(process.env.PORT, 10) || 3000,
    // 127.0.0.1 = nur lokal erreichbar (z. B. hinter Caddy/nginx), 0.0.0.0 = von außen erreichbar
    host: process.env.HOST || '0.0.0.0',
    dbPath,
    uploadDir: process.env.UPLOAD_DIR || path.join(dbPath === ':memory:' ? path.join(__dirname, '..', 'data') : path.dirname(dbPath), 'uploads'),
    jwtSecret,
    sessionDays: parseInt(process.env.SESSION_DAYS, 10) || 14,
    // Nach der Ersteinrichtung können sich keine weiteren Vereine selbst registrieren – außer das ist ausdrücklich erlaubt.
    allowRegistration: process.env.ALLOW_REGISTRATION === 'true',
};
