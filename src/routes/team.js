const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcrypt');
const { HttpError, requireText, requireEmail, requirePassword, requireId, detectImage } = require('../util');
const { requirePermission, requireAdmin } = require('../session');

module.exports = function teamRoutes(app, { db, config, sessions, log, sendLogo }) {
    const { authenticate } = sessions;
    const canManageUsers = [authenticate, requirePermission('can_manage_users')];

    // --- Verein ---
    app.put('/api/verein', authenticate, requireAdmin, (req, res) => {
        const old = db.prepare(`SELECT name, farbe, qr_url FROM vereine WHERE id = ?`).get(req.user.verein_id);
        const name = requireText(req.body.name, 'Vereinsname', 100);
        // Nicht mitgeschickte Felder bleiben unverändert
        let farbe = req.body.farbe === undefined ? old.farbe : (req.body.farbe ? String(req.body.farbe).toLowerCase() : null);
        if (farbe && !/^#[0-9a-f]{6}$/.test(farbe)) throw new HttpError(400, 'Farbe ist ungültig.');
        let qrUrl = req.body.qr_url === undefined ? old.qr_url : (req.body.qr_url ? String(req.body.qr_url).trim() : null);
        if (qrUrl) {
            if (!/^https?:\/\//i.test(qrUrl)) qrUrl = 'http://' + qrUrl;
            let u;
            try { u = new URL(qrUrl); } catch (e) { throw new HttpError(400, 'Die Adresse für QR-Codes ist ungültig.'); }
            if (!['http:', 'https:'].includes(u.protocol) || u.search || u.hash) throw new HttpError(400, 'Die Adresse für QR-Codes ist ungültig.');
            qrUrl = (u.origin + u.pathname).replace(/\/+$/, '');
        }
        db.prepare(`UPDATE vereine SET name = ?, farbe = ?, qr_url = ? WHERE id = ?`).run(name, farbe, qrUrl, req.user.verein_id);
        if (old.qr_url !== qrUrl) log(req.user.verein_id, req.user.id, null, 'verein', `Adresse für QR-Codes: ${qrUrl || 'automatisch'}`);
        if (old.name !== name) log(req.user.verein_id, req.user.id, null, 'verein', `Verein umbenannt in „${name}“`);
        if (old.farbe !== farbe) log(req.user.verein_id, req.user.id, null, 'verein', `Vereinsfarbe ${farbe ? `auf ${farbe} gesetzt` : 'zurückgesetzt'}`);
        res.json({ message: 'Gespeichert.' });
    });

    // --- Vereinslogo ---
    const currentLogo = (vereinId) => db.prepare(`SELECT logo FROM vereine WHERE id = ?`).get(vereinId).logo;
    const removeFile = (datei) => { if (datei) fs.rm(path.join(config.uploadDir, datei), { force: true }, () => {}); };

    app.get('/api/verein/logo', authenticate, (req, res) => {
        const logo = currentLogo(req.user.verein_id);
        if (!logo) throw new HttpError(404, 'Kein Logo.');
        sendLogo(res, logo);
    });

    app.post('/api/verein/logo', authenticate, requireAdmin, express.raw({ type: () => true, limit: 5 * 1024 * 1024 }), (req, res) => {
        if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Keine Bilddatei empfangen.');
        const type = detectImage(req.body);
        if (!type) throw new HttpError(400, 'Das Logo muss ein JPG-, PNG-, WebP- oder GIF-Bild sein.');
        const datei = `logo-${crypto.randomBytes(12).toString('hex')}.${type.ext}`;
        fs.writeFileSync(path.join(config.uploadDir, datei), req.body);
        const old = currentLogo(req.user.verein_id);
        db.prepare(`UPDATE vereine SET logo = ? WHERE id = ?`).run(datei, req.user.verein_id);
        removeFile(old);
        log(req.user.verein_id, req.user.id, null, 'verein', 'Vereinslogo hochgeladen');
        res.status(201).json({ message: 'Logo gespeichert.' });
    });

    app.delete('/api/verein/logo', authenticate, requireAdmin, (req, res) => {
        const old = currentLogo(req.user.verein_id);
        db.prepare(`UPDATE vereine SET logo = NULL WHERE id = ?`).run(req.user.verein_id);
        removeFile(old);
        log(req.user.verein_id, req.user.id, null, 'verein', 'Vereinslogo entfernt');
        res.json({ message: 'Logo entfernt.' });
    });

    // --- Rollen ---
    const rolePerms = (r) => ({ can_manage_users: !!r.can_manage_users, can_manage_items: !!r.can_manage_items, can_borrow_return: !!r.can_borrow_return });

    app.get('/api/rollen', ...canManageUsers, (req, res) => {
        const rows = db.prepare(`
            SELECT r.*, (SELECT COUNT(*) FROM nutzer n WHERE n.vereins_rolle_id = r.id) AS nutzer_anzahl
            FROM vereins_rollen r WHERE r.verein_id = ? ORDER BY r.name`).all(req.user.verein_id);
        res.json(rows.map(r => ({ id: r.id, name: r.name, permissions: rolePerms(r), nutzer_anzahl: r.nutzer_anzahl })));
    });

    function readRole(body) {
        const p = body.permissions || {};
        return { name: requireText(body.name, 'Rollen-Name', 50), u: p.can_manage_users ? 1 : 0, i: p.can_manage_items ? 1 : 0, b: p.can_borrow_return ? 1 : 0 };
    }

    app.post('/api/rollen', ...canManageUsers, (req, res) => {
        const r = readRole(req.body);
        const id = db.prepare(`INSERT INTO vereins_rollen (verein_id, name, can_manage_users, can_manage_items, can_borrow_return) VALUES (?, ?, ?, ?, ?)`)
            .run(req.user.verein_id, r.name, r.u, r.i, r.b).lastInsertRowid;
        log(req.user.verein_id, req.user.id, null, 'team', `Rolle „${r.name}“ erstellt`);
        res.status(201).json({ id: Number(id), message: 'Rolle erstellt.' });
    });

    app.put('/api/rollen/:id', ...canManageUsers, (req, res) => {
        const r = readRole(req.body);
        const info = db.prepare(`UPDATE vereins_rollen SET name = ?, can_manage_users = ?, can_manage_items = ?, can_borrow_return = ? WHERE id = ? AND verein_id = ?`)
            .run(r.name, r.u, r.i, r.b, requireId(req.params.id), req.user.verein_id);
        if (!info.changes) throw new HttpError(404, 'Rolle nicht gefunden.');
        log(req.user.verein_id, req.user.id, null, 'team', `Rolle „${r.name}“ geändert`);
        res.json({ message: 'Rolle gespeichert.' });
    });

    app.delete('/api/rollen/:id', ...canManageUsers, (req, res) => {
        const role = db.prepare(`SELECT id, name FROM vereins_rollen WHERE id = ? AND verein_id = ?`).get(requireId(req.params.id), req.user.verein_id);
        if (!role) throw new HttpError(404, 'Rolle nicht gefunden.');
        // ON DELETE SET NULL nimmt betroffenen Nutzern die Rolle automatisch weg.
        db.prepare(`DELETE FROM vereins_rollen WHERE id = ?`).run(role.id);
        log(req.user.verein_id, req.user.id, null, 'team', `Rolle „${role.name}“ gelöscht`);
        res.json({ message: 'Rolle gelöscht.' });
    });

    // --- Mitglieder ---
    const userInVerein = db.prepare(`SELECT id, username, role, vereins_rolle_id FROM nutzer WHERE id = ? AND verein_id = ?`);
    const countAdmins = db.prepare(`SELECT COUNT(*) AS c FROM nutzer WHERE verein_id = ? AND role = 'admin'`);

    // rolle: '' / null = keine Rolle (nur ansehen), 'admin' = Admin, sonst ID einer Vereinsrolle
    function resolveRole(value, vereinId) {
        if (value === 'admin') return { role: 'admin', rolleId: null };
        if (value === '' || value === null || value === undefined) return { role: 'user', rolleId: null };
        const rolleId = requireId(value, 'Rolle');
        if (!db.prepare(`SELECT 1 FROM vereins_rollen WHERE id = ? AND verein_id = ?`).get(rolleId, vereinId)) throw new HttpError(400, 'Rolle existiert nicht.');
        return { role: 'user', rolleId };
    }

    app.get('/api/users', ...canManageUsers, (req, res) => {
        res.json(db.prepare(`
            SELECT n.id, n.username, n.email, n.role, n.vereins_rolle_id, r.name AS rollen_name, n.created_at
            FROM nutzer n LEFT JOIN vereins_rollen r ON r.id = n.vereins_rolle_id
            WHERE n.verein_id = ? ORDER BY n.username COLLATE NOCASE`).all(req.user.verein_id));
    });

    app.post('/api/users', ...canManageUsers, async (req, res) => {
        const username = requireText(req.body.username, 'Benutzername', 50);
        const email = requireEmail(req.body.email);
        const password = requirePassword(req.body.password);
        const { role, rolleId } = resolveRole(req.body.rolle, req.user.verein_id);
        if (role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins können Admins anlegen.');

        const id = db.prepare(`INSERT INTO nutzer (verein_id, username, email, password_hash, role, vereins_rolle_id) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(req.user.verein_id, username, email, await bcrypt.hash(password, 12), role, rolleId).lastInsertRowid;
        log(req.user.verein_id, req.user.id, null, 'team', `Mitglied „${username}“ angelegt`);
        res.status(201).json({ id: Number(id), message: 'Mitglied angelegt.' });
    });

    app.put('/api/users/:id', ...canManageUsers, async (req, res) => {
        const id = requireId(req.params.id);
        const target = userInVerein.get(id, req.user.verein_id);
        if (!target) throw new HttpError(404, 'Mitglied nicht gefunden.');
        if (target.role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins können Admins bearbeiten.');

        const username = requireText(req.body.username, 'Benutzername', 50);
        const email = requireEmail(req.body.email);
        const hash = req.body.password ? await bcrypt.hash(requirePassword(req.body.password), 12) : null;

        // Die eigene Rolle kann man nicht ändern (sonst könnte sich der letzte Admin aussperren).
        const { role, rolleId } = id === req.user.id
            ? { role: target.role, rolleId: target.vereins_rolle_id }
            : resolveRole(req.body.rolle, req.user.verein_id);
        if (role === 'admin' && target.role !== 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins können Admins ernennen.');

        db.transaction(() => {
            if (target.role === 'admin' && role !== 'admin' && countAdmins.get(req.user.verein_id).c <= 1) {
                throw new HttpError(400, 'Der Verein braucht mindestens einen Admin.');
            }
            // Neues Passwort -> bestehende Sitzungen des Mitglieds werden beendet
            db.prepare(`UPDATE nutzer SET username = ?, email = ?, role = ?, vereins_rolle_id = ?,
                        password_hash = COALESCE(?, password_hash), token_version = token_version + (? IS NOT NULL) WHERE id = ?`)
                .run(username, email, role, rolleId, hash, hash, id);
        })();
        log(req.user.verein_id, req.user.id, null, 'team', `Mitglied „${username}“ bearbeitet${hash ? ' (Passwort zurückgesetzt)' : ''}`);
        res.json({ message: 'Gespeichert.' });
    });

    app.delete('/api/users/:id', ...canManageUsers, (req, res) => {
        const id = requireId(req.params.id);
        if (id === req.user.id) throw new HttpError(400, 'Du kannst dich nicht selbst löschen.');
        const target = userInVerein.get(id, req.user.verein_id);
        if (!target) throw new HttpError(404, 'Mitglied nicht gefunden.');
        if (target.role === 'admin' && req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins können Admins löschen.');
        db.prepare(`DELETE FROM nutzer WHERE id = ?`).run(id);
        log(req.user.verein_id, req.user.id, null, 'team', `Mitglied „${target.username}“ gelöscht`);
        res.json({ message: 'Mitglied gelöscht.' });
    });

    // --- Aktivitätsprotokoll ---
    app.get('/api/aktivitaeten', ...canManageUsers, (req, res) => {
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
        res.json(db.prepare(`
            SELECT a.id, a.aktion, a.details, a.created_at, a.equipment_id, n.username, e.name AS equipment_name, e.device_id
            FROM aktivitaeten a
            LEFT JOIN nutzer n ON n.id = a.nutzer_id
            LEFT JOIN equipment e ON e.id = a.equipment_id
            WHERE a.verein_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?`).all(req.user.verein_id, limit));
    });
};
