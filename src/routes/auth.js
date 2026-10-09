const bcrypt = require('bcrypt');
const { version } = require('../../package.json');
const { HttpError, DEFAULT_CATEGORIES, requireText, requireEmail, requirePassword } = require('../util');

// Vergleichs-Hash für unbekannte Benutzernamen, damit die Antwortzeit nichts verrät
const DUMMY_HASH = bcrypt.hashSync('dummy-passwort', 12);

module.exports = function authRoutes(app, { db, config, sessions, limiter, log }) {
    const { authenticate, startSession, endSession } = sessions;
    const vereinCount = db.prepare(`SELECT COUNT(*) AS c FROM vereine`);

    app.get('/api/setup', (req, res) => {
        res.json({ einrichtung: vereinCount.get().c === 0, registrierung: config.allowRegistration, version });
    });

    // Ersteinrichtung (bzw. Registrierung weiterer Vereine, falls ALLOW_REGISTRATION=true)
    app.post('/api/setup', async (req, res) => {
        limiter.check(req);
        const vereinName = requireText(req.body.vereinName, 'Vereinsname', 100);
        const username = requireText(req.body.username, 'Benutzername', 50);
        const email = requireEmail(req.body.email);
        const hash = await bcrypt.hash(requirePassword(req.body.password), 12);

        const user = db.transaction(() => {
            if (vereinCount.get().c > 0 && !config.allowRegistration) throw new HttpError(403, 'Die Einrichtung ist bereits abgeschlossen. Bitte einloggen.');
            if (db.prepare(`SELECT 1 FROM vereine WHERE name = ?`).get(vereinName)) throw new HttpError(409, 'Vereinsname existiert bereits.');
            const vereinId = Number(db.prepare(`INSERT INTO vereine (name) VALUES (?)`).run(vereinName).lastInsertRowid);
            const insertKat = db.prepare(`INSERT INTO kategorien (verein_id, name, prefix) VALUES (?, ?, ?)`);
            for (const [name, prefix] of DEFAULT_CATEGORIES) insertKat.run(vereinId, name, prefix);
            const id = Number(db.prepare(`INSERT INTO nutzer (verein_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`)
                .run(vereinId, username, email, hash).lastInsertRowid);
            log(vereinId, id, null, 'verein', `Verein „${vereinName}“ eingerichtet`);
            return { id, token_version: 0 };
        })();

        startSession(req, res, user);
        res.status(201).json({ message: 'Verein eingerichtet.' });
    });

    app.post('/api/login', async (req, res) => {
        limiter.check(req);
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string' || !username.trim()) throw new HttpError(400, 'Bitte Benutzername und Passwort eingeben.');

        const user = db.prepare(`SELECT id, password_hash, token_version FROM nutzer WHERE username = ? OR email = ?`).get(username.trim(), username.trim());
        const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
        if (!user || !ok) {
            limiter.fail(req);
            throw new HttpError(401, 'Benutzername oder Passwort falsch.');
        }
        limiter.success(req);
        startSession(req, res, user);
        res.json({ message: 'Eingeloggt.' });
    });

    app.post('/api/logout', (req, res) => {
        endSession(req, res);
        res.json({ message: 'Ausgeloggt.' });
    });

    app.get('/api/me', authenticate, (req, res) => {
        const u = req.user;
        startSession(req, res, u); // Sitzung verlängern, solange die App benutzt wird
        res.json({ id: u.id, username: u.username, email: u.email, role: u.role, permissions: u.permissions, verein: { id: u.verein_id, name: u.verein_name } });
    });

    app.put('/api/me/password', authenticate, async (req, res) => {
        const newPassword = requirePassword(req.body.newPassword);
        const row = db.prepare(`SELECT password_hash FROM nutzer WHERE id = ?`).get(req.user.id);
        if (typeof req.body.oldPassword !== 'string' || !(await bcrypt.compare(req.body.oldPassword, row.password_hash))) {
            throw new HttpError(400, 'Altes Passwort ist falsch.');
        }
        // token_version erhöhen -> alle anderen Sitzungen (z. B. auf fremden Geräten) werden abgemeldet
        db.prepare(`UPDATE nutzer SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`).run(await bcrypt.hash(newPassword, 12), req.user.id);
        startSession(req, res, { id: req.user.id, token_version: req.user.token_version + 1 });
        res.json({ message: 'Passwort geändert. Andere Geräte wurden abgemeldet.' });
    });
};
