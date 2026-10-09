const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const CATEGORIES = ['Flaschen', 'Atemregler', 'Jackets', 'Blei', 'Sonstiges'];
const CATEGORY_PREFIX = { Flaschen: '1', Atemregler: '2', Jackets: '3', Blei: '4', Sonstiges: '5' };
const CONDITIONS = ['Gut', 'Gebrauchsspuren', 'Reparaturbedürftig'];
const ALL_PERMISSIONS = { can_manage_users: true, can_manage_items: true, can_borrow_return: true };
const NO_PERMISSIONS = { can_manage_users: false, can_manage_items: false, can_borrow_return: false };
const MIN_PASSWORD_LENGTH = 8;

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

// --- Eingabe-Validierung ---
function requireText(value, field, max = 200) {
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} darf nicht leer sein.`);
    if (value.trim().length > max) throw new HttpError(400, `${field} ist zu lang (max. ${max} Zeichen).`);
    return value.trim();
}
function requireEmail(value) {
    const email = requireText(value, 'E-Mail', 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'E-Mail-Adresse ist ungültig.');
    return email;
}
function requirePassword(value) {
    if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) throw new HttpError(400, `Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.`);
    if (value.length > 72) throw new HttpError(400, 'Passwort ist zu lang (max. 72 Zeichen).');
    return value;
}
function optionalDate(value, field) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) throw new HttpError(400, `${field} ist kein gültiges Datum.`);
    return value;
}
function requireOneOf(value, allowed, field) {
    if (!allowed.includes(value)) throw new HttpError(400, `${field} ist ungültig.`);
    return value;
}
function requireId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Ungültige ID.');
    return id;
}
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}
function rolePermissions(row) {
    return { can_manage_users: !!row.can_manage_users, can_manage_items: !!row.can_manage_items, can_borrow_return: !!row.can_borrow_return };
}

function createApp(db, config) {
    const app = express();
    app.use(express.json({ limit: '100kb' }));
    app.use(cors(config.corsOrigin ? { origin: config.corsOrigin } : undefined));

    // --- Prepared Statements ---
    const q = {
        userById: db.prepare(`
            SELECT n.id, n.verein_id, n.username, n.email, n.role, n.vereins_rolle_id,
                   r.can_manage_users, r.can_manage_items, r.can_borrow_return
            FROM nutzer n LEFT JOIN vereins_rollen r ON r.id = n.vereins_rolle_id
            WHERE n.id = ?`),
        userForLogin: db.prepare(`SELECT id, verein_id, role, password_hash FROM nutzer WHERE username = ?`),
        userPassword: db.prepare(`SELECT password_hash FROM nutzer WHERE id = ?`),
        countAdmins: db.prepare(`SELECT COUNT(*) AS c FROM nutzer WHERE verein_id = ? AND role = 'admin'`),
        roleInVerein: db.prepare(`SELECT id FROM vereins_rollen WHERE id = ? AND verein_id = ?`),
        equipmentList: db.prepare(`
            SELECT e.id, e.verein_id, e.name, e.device_id AS deviceId, e.category, e.tuev,
                   CASE WHEN a.id IS NULL THEN 'Verfügbar' ELSE 'Ausgeliehen' END AS status,
                   e.condition, e.notes, a.borrower, a.rueckgabe_geplant AS returnDate,
                   e.created_at, e.updated_at
            FROM equipment e
            LEFT JOIN ausleihen a ON a.equipment_id = e.id AND a.zurueckgegeben_am IS NULL
            WHERE e.verein_id = ?
            ORDER BY e.category, e.device_id`),
        equipmentById: db.prepare(`
            SELECT e.*, a.id AS ausleihe_id FROM equipment e
            LEFT JOIN ausleihen a ON a.equipment_id = e.id AND a.zurueckgegeben_am IS NULL
            WHERE e.id = ? AND e.verein_id = ?`),
    };

    // --- Middleware ---
    function authenticate(req, res, next) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (!token) throw new HttpError(401, 'Nicht autorisiert.');
        let payload;
        try { payload = jwt.verify(token, config.jwtSecret); } catch (e) { throw new HttpError(401, 'Sitzung abgelaufen. Bitte neu einloggen.'); }

        if (payload.role === 'superadmin') {
            req.user = { id: 0, verein_id: null, role: 'superadmin', permissions: ALL_PERMISSIONS };
            return next();
        }
        // Nutzer bei jeder Anfrage frisch laden: gelöschte Nutzer und geänderte Rechte greifen sofort.
        const user = q.userById.get(payload.id);
        if (!user) throw new HttpError(401, 'Nutzer existiert nicht mehr.');
        user.permissions = user.role === 'admin' ? ALL_PERMISSIONS : rolePermissions(user);
        req.user = user;
        next();
    }

    const requirePermission = (perm) => (req, res, next) => {
        if (!req.user.permissions[perm]) throw new HttpError(403, 'Dir fehlen die Rechte für diese Aktion.');
        next();
    };
    const requireVerein = (req, res, next) => {
        if (!req.user.verein_id) throw new HttpError(403, 'Nur für Vereinsmitglieder.');
        next();
    };
    const requireSuperAdmin = (req, res, next) => {
        if (req.user.role !== 'superadmin') throw new HttpError(403, 'Kein Zugriff.');
        next();
    };

    function signToken(payload) {
        return jwt.sign(payload, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    }

    // --- Frontend ---
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, '..', 'Equiply.html')));

    // --- Auth ---
    app.post('/api/register', async (req, res) => {
        const vereinName = requireText(req.body.vereinName, 'Vereinsname', 100);
        const username = requireText(req.body.username, 'Benutzername', 50);
        const email = requireEmail(req.body.email);
        const hash = await bcrypt.hash(requirePassword(req.body.password), 12);

        const { vereinId, userId } = db.transaction(() => {
            if (db.prepare(`SELECT 1 FROM vereine WHERE name = ?`).get(vereinName)) throw new HttpError(409, 'Vereinsname existiert bereits.');
            const vereinId = db.prepare(`INSERT INTO vereine (name) VALUES (?)`).run(vereinName).lastInsertRowid;
            const userId = db.prepare(`INSERT INTO nutzer (verein_id, username, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`)
                .run(vereinId, username, email, hash).lastInsertRowid;
            return { vereinId, userId };
        })();

        const token = signToken({ id: Number(userId), verein_id: Number(vereinId), role: 'admin' });
        res.status(201).json({ token, role: 'admin', message: 'Erfolgreich registriert.' });
    });

    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body || {};
        if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(400, 'Felder unvollständig.');

        if (config.superadminUser && config.superadminPassword &&
            safeEqual(username, config.superadminUser) && safeEqual(password, config.superadminPassword)) {
            const token = signToken({ id: 0, verein_id: 0, role: 'superadmin' });
            return res.json({ token, role: 'superadmin', message: 'System Access Granted.' });
        }

        const user = q.userForLogin.get(username.trim());
        const ok = user && await bcrypt.compare(password, user.password_hash);
        if (!ok) throw new HttpError(401, 'Zugangsdaten ungültig.');

        const token = signToken({ id: user.id, verein_id: user.verein_id, role: user.role });
        res.json({ token, role: user.role, message: 'Eingeloggt.' });
    });

    app.get('/api/me', authenticate, (req, res) => {
        const { id, username, email, role, verein_id, permissions } = req.user;
        res.json({ id, username, email, role, verein_id, permissions });
    });

    app.put('/api/users/me/password', authenticate, requireVerein, async (req, res) => {
        const { oldPassword } = req.body || {};
        const newPassword = requirePassword(req.body.newPassword);
        const row = q.userPassword.get(req.user.id);
        if (!row || typeof oldPassword !== 'string' || !(await bcrypt.compare(oldPassword, row.password_hash))) {
            throw new HttpError(400, 'Altes Passwort inkorrekt.');
        }
        db.prepare(`UPDATE nutzer SET password_hash = ? WHERE id = ?`).run(await bcrypt.hash(newPassword, 12), req.user.id);
        res.json({ message: 'Passwort geändert.' });
    });

    // --- Superadmin ---
    app.get('/api/system-overview', authenticate, requireSuperAdmin, (req, res) => {
        const vereine = db.prepare(`
            SELECT v.id, v.name, v.created_at,
                   (SELECT COUNT(*) FROM nutzer n WHERE n.verein_id = v.id) AS nutzer_anzahl,
                   (SELECT COUNT(*) FROM equipment e WHERE e.verein_id = v.id) AS equipment_anzahl
            FROM vereine v ORDER BY v.name`).all();
        const nutzer = db.prepare(`SELECT id, verein_id, username, email, role FROM nutzer ORDER BY verein_id, username`).all();
        res.json({ vereine, nutzer });
    });

    app.delete('/api/vereine/:id', authenticate, requireSuperAdmin, (req, res) => {
        // ON DELETE CASCADE entfernt Rollen, Nutzer, Equipment und Ausleihen automatisch.
        const info = db.prepare(`DELETE FROM vereine WHERE id = ?`).run(requireId(req.params.id));
        if (!info.changes) throw new HttpError(404, 'Verein nicht gefunden.');
        res.json({ message: 'Verein und alle Daten restlos gelöscht.' });
    });

    // --- Rollen ---
    app.get('/api/rollen', authenticate, requireVerein, requirePermission('can_manage_users'), (req, res) => {
        const rows = db.prepare(`SELECT * FROM vereins_rollen WHERE verein_id = ? ORDER BY name`).all(req.user.verein_id);
        res.json(rows.map(r => ({ id: r.id, verein_id: r.verein_id, name: r.name, permissions: JSON.stringify(rolePermissions(r)) })));
    });

    app.post('/api/rollen', authenticate, requireVerein, requirePermission('can_manage_users'), (req, res) => {
        const name = requireText(req.body.name, 'Rollen-Name', 50);
        const p = req.body.permissions || {};
        const id = db.prepare(`INSERT INTO vereins_rollen (verein_id, name, can_manage_users, can_manage_items, can_borrow_return) VALUES (?, ?, ?, ?, ?)`)
            .run(req.user.verein_id, name, p.can_manage_users ? 1 : 0, p.can_manage_items ? 1 : 0, p.can_borrow_return ? 1 : 0).lastInsertRowid;
        res.status(201).json({ id: Number(id), message: 'Rolle erstellt.' });
    });

    app.delete('/api/rollen/:id', authenticate, requireVerein, requirePermission('can_manage_users'), (req, res) => {
        // ON DELETE SET NULL nimmt betroffenen Nutzern die Rolle automatisch weg.
        const info = db.prepare(`DELETE FROM vereins_rollen WHERE id = ? AND verein_id = ?`).run(requireId(req.params.id), req.user.verein_id);
        if (!info.changes) throw new HttpError(404, 'Rolle nicht gefunden.');
        res.json({ message: 'Rolle gelöscht.' });
    });

    // --- Nutzer ---
    // vereins_rolle_id: '' / null = keine Rolle, 'admin' = Vereins-Admin, sonst ID einer Vereinsrolle
    function resolveRole(value, vereinId) {
        if (value === 'admin') return { role: 'admin', rolleId: null };
        if (value === '' || value === null || value === undefined) return { role: 'user', rolleId: null };
        const rolleId = requireId(value);
        if (!q.roleInVerein.get(rolleId, vereinId)) throw new HttpError(400, 'Rolle existiert nicht.');
        return { role: 'user', rolleId };
    }

    app.get('/api/users', authenticate, requireVerein, requirePermission('can_manage_users'), (req, res) => {
        const rows = db.prepare(`
            SELECT n.id, n.username, n.email, n.role, n.vereins_rolle_id, r.name AS rollen_name,
                   r.can_manage_users, r.can_manage_items, r.can_borrow_return
            FROM nutzer n LEFT JOIN vereins_rollen r ON r.id = n.vereins_rolle_id
            WHERE n.verein_id = ? ORDER BY n.username`).all(req.user.verein_id);
        res.json(rows.map(({ can_manage_users, can_manage_items, can_borrow_return, ...u }) => ({
            ...u, permissions: u.vereins_rolle_id ? JSON.stringify({ can_manage_users: !!can_manage_users, can_manage_items: !!can_manage_items, can_borrow_return: !!can_borrow_return }) : null,
        })));
    });

    app.post('/api/users', authenticate, requireVerein, requirePermission('can_manage_users'), async (req, res) => {
        const username = requireText(req.body.username, 'Benutzername', 50);
        const email = requireEmail(req.body.email);
        const password = requirePassword(req.body.password);
        const { role, rolleId } = resolveRole(req.body.vereins_rolle_id, req.user.verein_id);
        if (role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins können Admins anlegen.');

        const id = db.prepare(`INSERT INTO nutzer (verein_id, username, email, password_hash, role, vereins_rolle_id) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(req.user.verein_id, username, email, await bcrypt.hash(password, 12), role, rolleId).lastInsertRowid;
        res.status(201).json({ id: Number(id), message: 'Erstellt.' });
    });

    app.put('/api/users/:id', authenticate, requireVerein, requirePermission('can_manage_users'), async (req, res) => {
        const id = requireId(req.params.id);
        const target = q.userById.get(id);
        if (!target || target.verein_id !== req.user.verein_id) throw new HttpError(404, 'Nutzer nicht gefunden.');
        if (target.role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins können Admins bearbeiten.');

        const username = requireText(req.body.username, 'Benutzername', 50);
        const email = requireEmail(req.body.email);
        const hash = req.body.password ? await bcrypt.hash(requirePassword(req.body.password), 12) : null;

        // Eigene Rolle kann man nicht ändern (verhindert, dass sich der letzte Admin aussperrt).
        let { role, rolleId } = id === req.user.id
            ? { role: target.role, rolleId: target.vereins_rolle_id }
            : resolveRole(req.body.vereins_rolle_id, req.user.verein_id);
        if (role === 'admin' && target.role !== 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins können Admins ernennen.');

        db.transaction(() => {
            if (target.role === 'admin' && role !== 'admin' && q.countAdmins.get(req.user.verein_id).c <= 1) {
                throw new HttpError(400, 'Der Verein braucht mindestens einen Admin.');
            }
            db.prepare(`UPDATE nutzer SET username = ?, email = ?, role = ?, vereins_rolle_id = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?`)
                .run(username, email, role, rolleId, hash, id);
        })();
        res.json({ message: 'Aktualisiert.' });
    });

    app.delete('/api/users/:id', authenticate, requireVerein, requirePermission('can_manage_users'), (req, res) => {
        const id = requireId(req.params.id);
        if (id === req.user.id) throw new HttpError(400, 'Du kannst dich nicht selbst löschen.');
        const target = q.userById.get(id);
        if (!target || target.verein_id !== req.user.verein_id) throw new HttpError(404, 'Nutzer nicht gefunden.');
        if (target.role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins können Admins löschen.');
        db.prepare(`DELETE FROM nutzer WHERE id = ?`).run(id);
        res.json({ message: 'Gelöscht.' });
    });

    // --- Equipment ---
    function loadEquipment(req) {
        const item = q.equipmentById.get(requireId(req.params.id), req.user.verein_id);
        if (!item) throw new HttpError(404, 'Equipment nicht gefunden.');
        return item;
    }

    app.get('/api/equipment', authenticate, requireVerein, (req, res) => {
        res.json(q.equipmentList.all(req.user.verein_id));
    });

    app.post('/api/equipment', authenticate, requireVerein, requirePermission('can_manage_items'), (req, res) => {
        const name = requireText(req.body.name, 'Bezeichnung', 100);
        const category = requireOneOf(req.body.category, CATEGORIES, 'Kategorie');
        const tuev = optionalDate(req.body.tuev, 'TÜV-Datum');
        const condition = req.body.condition ? requireOneOf(req.body.condition, CONDITIONS, 'Zustand') : 'Gut';
        const prefix = CATEGORY_PREFIX[category];

        // Nummer vergeben und einfügen in einer Transaktion -> keine doppelten Inventarnummern.
        const result = db.transaction(() => {
            const { maxNr } = db.prepare(`
                SELECT MAX(CAST(substr(device_id, 2) AS INTEGER)) AS maxNr FROM equipment
                WHERE verein_id = ? AND category = ? AND device_id GLOB ? || '[0-9]*'`).get(req.user.verein_id, category, prefix);
            const deviceId = prefix + String((maxNr || 0) + 1).padStart(2, '0');
            const id = db.prepare(`INSERT INTO equipment (verein_id, device_id, name, category, tuev, condition, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(req.user.verein_id, deviceId, name, category, tuev, condition, req.body.notes || null).lastInsertRowid;
            return { id: Number(id), deviceId };
        })();
        res.status(201).json(result);
    });

    app.put('/api/equipment/:id', authenticate, requireVerein, requirePermission('can_manage_items'), (req, res) => {
        const item = loadEquipment(req);
        const name = requireText(req.body.name, 'Bezeichnung', 100);
        const category = requireOneOf(req.body.category, CATEGORIES, 'Kategorie');
        const tuev = optionalDate(req.body.tuev, 'TÜV-Datum');
        const condition = requireOneOf(req.body.condition, CONDITIONS, 'Zustand');
        const notes = req.body.notes !== undefined ? req.body.notes : item.notes;
        db.prepare(`UPDATE equipment SET name = ?, category = ?, tuev = ?, condition = ?, notes = ? WHERE id = ?`)
            .run(name, category, tuev, condition, notes, item.id);
        res.json({ message: 'Aktualisiert' });
    });

    app.delete('/api/equipment/:id', authenticate, requireVerein, requirePermission('can_manage_items'), (req, res) => {
        const item = loadEquipment(req);
        db.prepare(`DELETE FROM equipment WHERE id = ?`).run(item.id);
        res.json({ message: 'Gelöscht' });
    });

    // Ausleihen ({ borrower, returnDate }) oder Rückgabe ({ condition })
    app.put('/api/equipment/:id/action', authenticate, requireVerein, requirePermission('can_borrow_return'), (req, res) => {
        db.transaction(() => {
            const item = loadEquipment(req);
            if (req.body.condition) {
                const condition = requireOneOf(req.body.condition, CONDITIONS, 'Zustand');
                if (!item.ausleihe_id) throw new HttpError(409, 'Dieses Equipment ist nicht ausgeliehen.');
                db.prepare(`UPDATE ausleihen SET zurueckgegeben_am = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), zurueckgenommen_von = ?, zustand_bei_rueckgabe = ? WHERE id = ?`)
                    .run(req.user.id, condition, item.ausleihe_id);
                db.prepare(`UPDATE equipment SET condition = ? WHERE id = ?`).run(condition, item.id);
                res.json({ message: 'Rückgabe erfasst' });
            } else {
                const borrower = requireText(req.body.borrower, 'Name des Ausleihers', 100);
                const returnDate = optionalDate(req.body.returnDate, 'Rückgabedatum');
                if (item.ausleihe_id) throw new HttpError(409, 'Dieses Equipment ist bereits ausgeliehen.');
                if (item.condition === 'Reparaturbedürftig') throw new HttpError(409, 'Defektes Equipment kann nicht ausgeliehen werden.');
                if (item.tuev && item.tuev < new Date().toISOString().slice(0, 10)) throw new HttpError(409, 'TÜV ist abgelaufen – Ausleihe gesperrt.');
                db.prepare(`INSERT INTO ausleihen (equipment_id, borrower, rueckgabe_geplant, ausgegeben_von) VALUES (?, ?, ?, ?)`)
                    .run(item.id, borrower, returnDate, req.user.id);
                res.json({ message: 'Ausleihe erfasst' });
            }
        })();
    });

    app.get('/api/equipment/:id/history', authenticate, requireVerein, (req, res) => {
        const item = loadEquipment(req);
        res.json(db.prepare(`
            SELECT a.id, a.borrower, a.ausgeliehen_am, a.rueckgabe_geplant, a.zurueckgegeben_am, a.zustand_bei_rueckgabe,
                   aus.username AS ausgegeben_von, zur.username AS zurueckgenommen_von
            FROM ausleihen a
            LEFT JOIN nutzer aus ON aus.id = a.ausgegeben_von
            LEFT JOIN nutzer zur ON zur.id = a.zurueckgenommen_von
            WHERE a.equipment_id = ? ORDER BY a.ausgeliehen_am DESC, a.id DESC`).all(item.id));
    });

    // --- Fehlerbehandlung ---
    app.use('/api', (req, res) => res.status(404).json({ error: 'Endpunkt nicht gefunden.' }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
        if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültiges JSON.' });
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            if (/nutzer\.username/.test(err.message)) return res.status(409).json({ error: 'Benutzername existiert schon.' });
            if (/nutzer\.email/.test(err.message)) return res.status(409).json({ error: 'E-Mail existiert schon.' });
            if (/vereins_rollen/.test(err.message)) return res.status(409).json({ error: 'Eine Rolle mit diesem Namen existiert schon.' });
            return res.status(409).json({ error: 'Eintrag existiert bereits.' });
        }
        if (typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'Ungültige Daten.' });
        console.error(err);
        res.status(500).json({ error: 'Interner Serverfehler.' });
    });

    return app;
}

module.exports = { createApp };
