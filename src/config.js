const crypto = require('crypto');
const path = require('path');

// .env laden, falls vorhanden (Node >= 20.12 / 21.7)
try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (e) { /* keine .env vorhanden */ }

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
    jwtSecret = crypto.randomBytes(48).toString('hex');
    console.warn('[WARNUNG] JWT_SECRET ist nicht gesetzt – es wird ein zufälliger Schlüssel verwendet. ' +
        'Alle Logins werden bei jedem Neustart ungültig. Bitte JWT_SECRET in der .env setzen.');
}

module.exports = {
    port: parseInt(process.env.PORT, 10) || 3000,
    // 127.0.0.1 = nur lokal erreichbar (z. B. hinter Caddy/nginx), 0.0.0.0 = von außen erreichbar
    host: process.env.HOST || '0.0.0.0',
    dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'equiply.db'),
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    // System-Owner (Superadmin). Ohne diese Variablen ist der Superadmin-Login deaktiviert.
    superadminUser: process.env.SUPERADMIN_USER || null,
    superadminPassword: process.env.SUPERADMIN_PASSWORD || null,
    corsOrigin: process.env.CORS_ORIGIN || null,
};
