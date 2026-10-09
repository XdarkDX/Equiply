const path = require('path');
const express = require('express');
const { HttpError } = require('./util');
const { createSessions, createLoginLimiter } = require('./session');
const { createInventory } = require('./inventory');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function securityHeaders(req, res, next) {
    res.set({
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'same-origin',
        'Permissions-Policy': 'geolocation=(), microphone=()',
    });
    next();
}

// Schutz gegen Cross-Site-Anfragen: verändernde Anfragen müssen von der eigenen Seite kommen
function sameOrigin(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.get('origin');
    if (origin) {
        let host;
        try { host = new URL(origin).host; } catch (e) { host = null; }
        // req.host berücksichtigt hinter einem Proxy auch X-Forwarded-Host
        if (host !== req.get('host') && host !== req.host) throw new HttpError(403, 'Anfrage von fremder Seite blockiert.');
    }
    next();
}

function createApp(db, config) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 'loopback'); // echte Client-IP und HTTPS-Erkennung hinter Caddy/nginx

    const sessions = createSessions(db, config);
    const limiter = createLoginLimiter();
    const inventory = createInventory(db);
    // Logos werden nach dem Typ gespeichert, der beim Hochladen erkannt wurde
    const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
    const sendLogo = (res, datei) => {
        res.set({ 'Content-Type': LOGO_TYPES[path.extname(datei).slice(1)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=604800, immutable' });
        res.sendFile(path.join(config.uploadDir, datei), (err) => { if (err && !res.headersSent) res.status(404).json({ error: 'Logo fehlt.' }); });
    };
    const ctx = { db, config, sessions, limiter, inventory, log: inventory.log, sendLogo };

    app.use(securityHeaders);
    app.use('/api', sameOrigin);
    const smallJson = express.json({ limit: '200kb' });
    app.use('/api', (req, res, next) => (req.path === '/import' ? next() : smallJson(req, res, next)));
    app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

    require('./routes/auth')(app, ctx);
    require('./routes/team')(app, ctx);
    require('./routes/equipment')(app, ctx);
    require('./routes/transfer')(app, ctx);
    require('./routes/qr')(app, ctx);

    app.use('/api', (req, res) => res.status(404).json({ error: 'Endpunkt nicht gefunden.' }));
    app.use(express.static(PUBLIC_DIR, { index: 'index.html', setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
        if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage.' });
        if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Die Datei ist zu groß.' });
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            if (/nutzer\.username/.test(err.message)) return res.status(409).json({ error: 'Benutzername ist schon vergeben.' });
            if (/nutzer\.email/.test(err.message)) return res.status(409).json({ error: 'E-Mail-Adresse ist schon vergeben.' });
            if (/vereins_rollen/.test(err.message)) return res.status(409).json({ error: 'Eine Rolle mit diesem Namen gibt es schon.' });
            if (/kategorien\.name/.test(err.message)) return res.status(409).json({ error: 'Eine Kategorie mit diesem Namen gibt es schon.' });
            if (/vereine\.name/.test(err.message)) return res.status(409).json({ error: 'Dieser Vereinsname ist schon vergeben.' });
            if (/equipment\.device_id/.test(err.message)) return res.status(409).json({ error: 'Diese Inventarnummer ist schon vergeben.' });
            return res.status(409).json({ error: 'Eintrag existiert bereits.' });
        }
        if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'Ungültige Daten.' });
        console.error(err);
        res.status(500).json({ error: 'Interner Serverfehler. Bitte später erneut versuchen.' });
    });

    return app;
}

module.exports = { createApp };
