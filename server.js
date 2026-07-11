const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = 3000;
const SECRET_KEY = "dein_super_geheimes_passwort_fuer_tokens"; 

const SYSTEM_OWNER_USER = "admin";
const SYSTEM_OWNER_PASS = "EquiplyMaster2026!";

app.use(express.json());
app.use(cors());

const db = new sqlite3.Database('./equiply.db', (err) => {
    if (err) console.error("Fehler beim Öffnen", err);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS vereine (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS vereins_rollen (
        id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, name TEXT, permissions TEXT, FOREIGN KEY(verein_id) REFERENCES vereine(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS nutzer (
        id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, username TEXT UNIQUE, email TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'user', vereins_rolle_id INTEGER, FOREIGN KEY(verein_id) REFERENCES vereine(id), FOREIGN KEY(vereins_rolle_id) REFERENCES vereins_rollen(id)
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS equipment (
        id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, name TEXT, deviceId TEXT, category TEXT, tuev TEXT, status TEXT DEFAULT 'Verfügbar', condition TEXT DEFAULT 'Gut', notes TEXT, borrower TEXT, returnDate TEXT, FOREIGN KEY(verein_id) REFERENCES vereine(id)
    )`);

    db.run(`ALTER TABLE nutzer ADD COLUMN vereins_rolle_id INTEGER`, (err) => {});
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'Equiply.html')));

// --- AUTHENTIFIZIERUNG & SESSION ---
app.post('/api/register', async (req, res) => {
    const { vereinName, username, email, password } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO vereine (name) VALUES (?)`, [vereinName], function(err) {
            if (err) return res.status(400).json({ error: "Vereinsname existiert bereits." });
            const vereinId = this.lastID;
            db.run(`INSERT INTO nutzer (verein_id, username, email, password, role) VALUES (?, ?, ?, ?, 'admin')`, 
            [vereinId, username, email, hashedPassword], function(err) {
                if (err) return res.status(400).json({ error: "Benutzername oder E-Mail existiert schon." });
                const token = jwt.sign({ id: this.lastID, verein_id: vereinId, role: 'admin' }, SECRET_KEY, { expiresIn: '24h' });
                res.json({ token, role: 'admin', message: "Erfolgreich registriert." });
            });
        });
    } catch (err) { res.status(500).json({ error: "Serverfehler" }); }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === SYSTEM_OWNER_USER && password === SYSTEM_OWNER_PASS) {
        const token = jwt.sign({ id: 0, verein_id: 0, role: 'superadmin' }, SECRET_KEY, { expiresIn: '24h' });
        return res.json({ token, role: 'superadmin', message: "System Access Granted." });
    }

    db.get(`SELECT * FROM nutzer WHERE username = ?`, [username], async (err, user) => {
        if (err || !user) return res.status(401).json({ error: "Zugangsdaten ungültig." });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: "Zugangsdaten ungültig." });
        const token = jwt.sign({ id: user.id, verein_id: user.verein_id, role: user.role }, SECRET_KEY, { expiresIn: '24h' });
        res.json({ token, role: user.role, message: "Eingeloggt." });
    });
});

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Nicht autorisiert." });
    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: "Sitzung abgelaufen." });
        req.user = user; next();
    });
}

app.get('/api/me', authenticateToken, (req, res) => {
    if(req.user.role === 'superadmin') {
        return res.json({ role: 'superadmin', permissions: { can_manage_users: true, can_manage_items: true, can_borrow_return: true }});
    }
    db.get(`SELECT n.role, r.permissions FROM nutzer n LEFT JOIN vereins_rollen r ON n.vereins_rolle_id = r.id WHERE n.id = ?`, [req.user.id], (err, row) => {
        if(!row) return res.status(404).json({ error: "Nutzer nicht gefunden" });
        let perms = { can_manage_users: false, can_manage_items: false, can_borrow_return: false };
        if(row.role === 'admin') {
            perms = { can_manage_users: true, can_manage_items: true, can_borrow_return: true };
        } else if (row.permissions) {
            try { perms = JSON.parse(row.permissions); } catch(e){}
        }
        res.json({ role: row.role, permissions: perms });
    });
});

function checkPermission(requiredPerm) {
    return (req, res, next) => {
        if(req.user.role === 'superadmin' || req.user.role === 'admin') return next();
        db.get(`SELECT r.permissions FROM nutzer n LEFT JOIN vereins_rollen r ON n.vereins_rolle_id = r.id WHERE n.id = ?`, [req.user.id], (err, row) => {
            if(err || !row) return res.status(403).json({error: "Nicht autorisiert."});
            if(row.permissions) {
                try {
                    const p = JSON.parse(row.permissions);
                    if(p[requiredPerm]) return next();
                } catch(e){}
            }
            res.status(403).json({error: "Server blockiert: Dir fehlen die Rechte für diese Aktion!"});
        });
    };
}

function requireSuperAdmin(req, res, next) {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: "Streng geheim!" });
    next();
}

app.put('/api/users/me/password', authenticateToken, (req, res) => {
    const { oldPassword, newPassword } = req.body;
    db.get(`SELECT * FROM nutzer WHERE id = ?`, [req.user.id], async (err, user) => {
        if (err || !user) return res.status(404).json({ error: "Nutzer nicht gefunden." });
        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) return res.status(401).json({ error: "Altes Passwort inkorrekt." });
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        db.run(`UPDATE nutzer SET password = ? WHERE id = ?`, [hashedPassword, req.user.id], function(err) {
            res.json({ message: "Passwort geändert." });
        });
    });
});

// --- SUPERADMIN BEREICH ---
app.get('/api/system-overview', authenticateToken, requireSuperAdmin, (req, res) => {
    db.all(`SELECT id, name FROM vereine`, [], (err, vereine) => {
        db.all(`SELECT id, verein_id, username, email, role FROM nutzer`, [], (err, nutzer) => {
            db.all(`SELECT * FROM equipment`, [], (err, equipment) => { res.json({ vereine, nutzer, equipment }); });
        });
    });
});
app.delete('/api/vereine/:id', authenticateToken, requireSuperAdmin, (req, res) => {
    const vId = req.params.id;
    db.run(`DELETE FROM equipment WHERE verein_id = ?`, [vId], () => {
        db.run(`DELETE FROM nutzer WHERE verein_id = ?`, [vId], () => {
            db.run(`DELETE FROM vereins_rollen WHERE verein_id = ?`, [vId], () => {
                db.run(`DELETE FROM vereine WHERE id = ?`, [vId], function(err) {
                    res.json({ message: "Verein und alle Daten restlos gelöscht." });
                });
            });
        });
    });
});

// --- ROLLEN VERWALTUNG ---
app.get('/api/rollen', authenticateToken, checkPermission('can_manage_users'), (req, res) => {
    db.all(`SELECT * FROM vereins_rollen WHERE verein_id = ?`, [req.user.verein_id], (err, rows) => res.json(rows || []));
});
app.post('/api/rollen', authenticateToken, checkPermission('can_manage_users'), (req, res) => {
    const { name, permissions } = req.body;
    db.run(`INSERT INTO vereins_rollen (verein_id, name, permissions) VALUES (?, ?, ?)`, 
        [req.user.verein_id, name, JSON.stringify(permissions)], function(err) { res.json({ message: "Rolle erstellt." }); });
});
app.delete('/api/rollen/:id', authenticateToken, checkPermission('can_manage_users'), (req, res) => {
    db.run(`UPDATE nutzer SET vereins_rolle_id = NULL WHERE vereins_rolle_id = ? AND verein_id = ?`, [req.params.id, req.user.verein_id], () => {
        db.run(`DELETE FROM vereins_rollen WHERE id = ? AND verein_id = ?`, [req.params.id, req.user.verein_id], function(err) { res.json({ message: "Rolle gelöscht." }); });
    });
});

// --- NORMALE NUTZERVERWALTUNG ---
app.get('/api/users', authenticateToken, checkPermission('can_manage_users'), (req, res) => {
    db.all(`SELECT n.id, n.username, n.email, n.role, n.vereins_rolle_id, r.name as rollen_name, r.permissions FROM nutzer n LEFT JOIN vereins_rollen r ON n.vereins_rolle_id = r.id WHERE n.verein_id = ?`, 
    [req.user.verein_id], (err, rows) => { res.json(rows || []); });
});

app.post('/api/users', authenticateToken, checkPermission('can_manage_users'), async (req, res) => {
    const { username, email, password, vereins_rolle_id } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const roleId = vereins_rolle_id ? vereins_rolle_id : null;
        db.run(`INSERT INTO nutzer (verein_id, username, email, password, role, vereins_rolle_id) VALUES (?, ?, ?, ?, 'user', ?)`, 
            [req.user.verein_id, username, email, hashedPassword, roleId], function(err) {
                if (err) return res.status(400).json({ error: "Name/E-Mail existiert schon." });
                res.json({ message: "Erstellt." });
            });
    } catch(e) { res.status(500).json({ error: "Fehler." }); }
});

app.put('/api/users/:id', authenticateToken, checkPermission('can_manage_users'), async (req, res) => {
    const { username, email, password, vereins_rolle_id } = req.body;
    try {
        const roleId = vereins_rolle_id ? vereins_rolle_id : null;
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            db.run(`UPDATE nutzer SET username=?, email=?, password=?, vereins_rolle_id=? WHERE id=? AND verein_id=?`,
                [username, email, hashedPassword, roleId, req.params.id, req.user.verein_id], function(err) { res.json({ message: "Aktualisiert." }); });
        } else {
            db.run(`UPDATE nutzer SET username=?, email=?, vereins_rolle_id=? WHERE id=? AND verein_id=?`,
                [username, email, roleId, req.params.id, req.user.verein_id], function(err) { res.json({ message: "Aktualisiert." }); });
        }
    } catch(e) { res.status(500).json({ error: "Fehler." }); }
});

app.delete('/api/users/:id', authenticateToken, checkPermission('can_manage_users'), (req, res) => {
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error: "Selbstlöschung blockiert." });
    db.run(`DELETE FROM nutzer WHERE id=? AND verein_id=?`, [req.params.id, req.user.verein_id], function(err) { res.json({ message: "Gelöscht." }); });
});

// --- EQUIPMENT ---
app.get('/api/equipment', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM equipment WHERE verein_id = ?`, [req.user.verein_id], (err, rows) => res.json(rows || []));
});

app.post('/api/equipment', authenticateToken, checkPermission('can_manage_items'), (req, res) => {
    const { name, category, tuev } = req.body;
    const prefixes = { 'Flaschen': '1', 'Atemregler': '2', 'Jackets': '3', 'Blei': '4', 'Sonstiges': '5' };
    const prefix = prefixes[category] || '9';

    db.get(`SELECT deviceId FROM equipment WHERE verein_id = ? AND category = ? ORDER BY CAST(deviceId AS INTEGER) DESC LIMIT 1`, 
        [req.user.verein_id, category], 
        (err, row) => {
            let nextId = prefix + '01'; 
            if (row && row.deviceId && row.deviceId.startsWith(prefix)) {
                nextId = (parseInt(row.deviceId) + 1).toString();
            }
            db.run(`INSERT INTO equipment (verein_id, name, deviceId, category, tuev) VALUES (?, ?, ?, ?, ?)`,
                [req.user.verein_id, name, nextId, category, tuev], function (err) { res.json({ id: this.lastID, deviceId: nextId }); 
            });
        }
    );
});

app.put('/api/equipment/:id', authenticateToken, checkPermission('can_manage_items'), (req, res) => {
    const { name, category, tuev, condition } = req.body;
    db.run(`UPDATE equipment SET name=?, category=?, tuev=?, condition=? WHERE id=? AND verein_id=?`,
        [name, category, tuev, condition, req.params.id, req.user.verein_id], function(err) { res.json({ message: "Aktualisiert" }); });
});

app.delete('/api/equipment/:id', authenticateToken, checkPermission('can_manage_items'), (req, res) => {
    db.run(`DELETE FROM equipment WHERE id = ? AND verein_id = ?`, [req.params.id, req.user.verein_id], function(err) { res.json({ message: "Gelöscht" }); });
});

app.put('/api/equipment/:id/action', authenticateToken, checkPermission('can_borrow_return'), (req, res) => {
    const { status, borrower, returnDate, condition } = req.body;
    if (condition) { 
        db.run(`UPDATE equipment SET status=?, borrower='', returnDate='', condition=? WHERE id=? AND verein_id=?`,
            ['Verfügbar', condition, req.params.id, req.user.verein_id], function(err) { res.json({ message: "Rückgabe erfasst" }); });
    } else { 
        db.run(`UPDATE equipment SET status=?, borrower=?, returnDate=? WHERE id=? AND verein_id=?`,
            ['Ausgeliehen', borrower, returnDate, req.params.id, req.user.verein_id], function(err) { res.json({ message: "Ausleihe erfasst" }); });
    }
});

app.listen(PORT, () => console.log(`Server läuft auf http://localhost:${PORT}`));