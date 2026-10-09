const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

const config = { jwtSecret: 'test-secret', jwtExpiresIn: '1h', superadminUser: 'root', superadminPassword: 'root-passwort-123' };

let server, base, db;

before(async () => {
    db = openDatabase(':memory:');
    server = createApp(db, config).listen(0);
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => { server.close(); db.close(); });

async function call(method, url, body, token) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
}

let adminToken, helperToken, rolleId, flascheId;

test('Registrierung legt Verein + Admin an, doppelte Namen werden abgelehnt', async () => {
    const r = await call('POST', '/register', { vereinName: 'Tauchclub Nord', username: 'chef', email: 'chef@example.de', password: 'geheim123' });
    assert.equal(r.status, 201);
    adminToken = r.body.token;

    assert.equal((await call('POST', '/register', { vereinName: 'tauchclub nord', username: 'x', email: 'x@example.de', password: 'geheim123' })).status, 409);
    assert.equal((await call('POST', '/register', { vereinName: 'Anderer', username: 'CHEF', email: 'y@example.de', password: 'geheim123' })).status, 409);
    assert.equal((await call('POST', '/register', { vereinName: 'Kurz', username: 'k', email: 'k@example.de', password: '123' })).status, 400);
    // fehlgeschlagene Registrierung darf keinen halben Verein hinterlassen
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM vereine`).get().c, 1);
});

test('Login und /me', async () => {
    assert.equal((await call('POST', '/login', { username: 'chef', password: 'falsch' })).status, 401);
    const r = await call('POST', '/login', { username: 'chef', password: 'geheim123' });
    assert.equal(r.status, 200);
    const me = await call('GET', '/me', null, r.body.token);
    assert.equal(me.body.role, 'admin');
    assert.equal(me.body.permissions.can_manage_users, true);
});

test('Rollen und Nutzer mit eingeschränkten Rechten', async () => {
    const r = await call('POST', '/rollen', { name: 'Ausgabe', permissions: { can_borrow_return: true } }, adminToken);
    assert.equal(r.status, 201);
    rolleId = r.body.id;
    assert.equal((await call('POST', '/rollen', { name: 'Ausgabe', permissions: {} }, adminToken)).status, 409);

    assert.equal((await call('POST', '/users', { username: 'helfer', email: 'helfer@example.de', password: 'helfer123', vereins_rolle_id: String(rolleId) }, adminToken)).status, 201);
    helperToken = (await call('POST', '/login', { username: 'helfer', password: 'helfer123' })).body.token;

    const me = await call('GET', '/me', null, helperToken);
    assert.deepEqual(me.body.permissions, { can_manage_users: false, can_manage_items: false, can_borrow_return: true });
    assert.equal((await call('GET', '/users', null, helperToken)).status, 403);
    assert.equal((await call('POST', '/equipment', { name: 'X', category: 'Blei' }, helperToken)).status, 403);
});

test('Equipment: fortlaufende Inventarnummern je Kategorie', async () => {
    const a = await call('POST', '/equipment', { name: '12L Stahl', category: 'Flaschen', tuev: '2030-01-01' }, adminToken);
    const b = await call('POST', '/equipment', { name: '10L Alu', category: 'Flaschen' }, adminToken);
    const c = await call('POST', '/equipment', { name: 'Apeks', category: 'Atemregler' }, adminToken);
    assert.deepEqual([a.body.deviceId, b.body.deviceId, c.body.deviceId], ['101', '102', '201']);
    flascheId = a.body.id;

    assert.equal((await call('POST', '/equipment', { name: 'X', category: 'Unsinn' }, adminToken)).status, 400);
    assert.equal((await call('POST', '/equipment', { name: 'X', category: 'Blei', tuev: '01.01.2030' }, adminToken)).status, 400);
});

test('Ausleihe, doppelte Ausleihe, Rückgabe und Verlauf', async () => {
    assert.equal((await call('PUT', `/equipment/${flascheId}/action`, { borrower: 'Anna', returnDate: '2030-02-01' }, helperToken)).status, 200);
    assert.equal((await call('PUT', `/equipment/${flascheId}/action`, { borrower: 'Ben' }, helperToken)).status, 409);

    let item = (await call('GET', '/equipment', null, helperToken)).body.find(i => i.id === flascheId);
    assert.equal(item.status, 'Ausgeliehen');
    assert.equal(item.borrower, 'Anna');
    assert.equal(item.returnDate, '2030-02-01');

    assert.equal((await call('PUT', `/equipment/${flascheId}/action`, { condition: 'Reparaturbedürftig' }, helperToken)).status, 200);
    item = (await call('GET', '/equipment', null, helperToken)).body.find(i => i.id === flascheId);
    assert.equal(item.status, 'Verfügbar');
    assert.equal(item.condition, 'Reparaturbedürftig');
    assert.equal((await call('PUT', `/equipment/${flascheId}/action`, { borrower: 'Ben' }, helperToken)).status, 409, 'defekt -> keine Ausleihe');

    const hist = await call('GET', `/equipment/${flascheId}/history`, null, helperToken);
    assert.equal(hist.body.length, 1);
    assert.equal(hist.body[0].ausgegeben_von, 'helfer');
    assert.ok(hist.body[0].zurueckgegeben_am);
});

test('Admin-Ernennung, letzter Admin bleibt geschützt', async () => {
    const users = (await call('GET', '/users', null, adminToken)).body;
    const helfer = users.find(u => u.username === 'helfer');
    const chef = users.find(u => u.username === 'chef');

    assert.equal((await call('PUT', `/users/${helfer.id}`, { username: 'helfer', email: 'helfer@example.de', vereins_rolle_id: 'admin' }, adminToken)).status, 200);
    assert.equal((await call('GET', '/me', null, helperToken)).body.role, 'admin');

    assert.equal((await call('DELETE', `/users/${chef.id}`, null, adminToken)).status, 400, 'Selbstlöschung');
    assert.equal((await call('PUT', `/users/${chef.id}`, { username: 'chef', email: 'chef@example.de', vereins_rolle_id: '' }, helperToken)).status, 200);
    assert.equal((await call('PUT', `/users/${helfer.id}`, { username: 'helfer', email: 'helfer@example.de', vereins_rolle_id: '' }, adminToken)).status, 403, 'chef ist kein Admin mehr');
});

test('Vereine sind voneinander getrennt', async () => {
    const other = (await call('POST', '/register', { vereinName: 'Süd', username: 'sued', email: 'sued@example.de', password: 'geheim123' })).body.token;
    assert.equal((await call('GET', '/equipment', null, other)).body.length, 0);
    assert.equal((await call('DELETE', `/equipment/${flascheId}`, null, other)).status, 404);
    assert.equal((await call('GET', `/equipment/${flascheId}/history`, null, other)).status, 404);
});

test('Superadmin löscht Verein inkl. aller Daten (Kaskade)', async () => {
    const t = (await call('POST', '/login', { username: 'root', password: 'root-passwort-123' })).body.token;
    const overview = (await call('GET', '/system-overview', null, t)).body;
    const nord = overview.vereine.find(v => v.name === 'Tauchclub Nord');
    assert.equal(nord.equipment_anzahl, 3);

    assert.equal((await call('DELETE', `/vereine/${nord.id}`, null, t)).status, 200);
    for (const table of ['nutzer', 'equipment', 'vereins_rollen', 'ausleihen']) {
        const where = table === 'ausleihen' ? '' : `WHERE verein_id = ${nord.id}`;
        assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table} ${where}`).get().c, 0, table);
    }
    assert.equal((await call('GET', '/me', null, adminToken)).status, 401, 'Token gelöschter Nutzer ist ungültig');
});

test('Migration übernimmt eine alte equiply.db', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'equiply-')), 'alt.db');
    const old = new Database(file);
    old.exec(`
        CREATE TABLE vereine (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
        CREATE TABLE vereins_rollen (id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, name TEXT, permissions TEXT, FOREIGN KEY(verein_id) REFERENCES vereine(id));
        CREATE TABLE nutzer (id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, username TEXT UNIQUE, email TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'user', vereins_rolle_id INTEGER);
        CREATE TABLE equipment (id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, name TEXT, deviceId TEXT, category TEXT, tuev TEXT, status TEXT DEFAULT 'Verfügbar', condition TEXT DEFAULT 'Gut', notes TEXT, borrower TEXT, returnDate TEXT);
        INSERT INTO vereine (id, name) VALUES (7, 'Altclub');
        INSERT INTO vereins_rollen VALUES (3, 7, 'Wart', '{"can_manage_items":true}');
    `);
    old.prepare(`INSERT INTO nutzer VALUES (5, 7, 'alt', 'alt@example.de', ?, 'user', 3)`).run(bcrypt.hashSync('altpasswort', 4));
    old.exec(`
        INSERT INTO equipment VALUES (1, 7, 'Flasche', '101', 'Flaschen', '2025-05-01', 'Ausgeliehen', 'Gut', NULL, 'Carl', '2026-01-01');
        INSERT INTO equipment VALUES (2, 7, 'Kram', '501', 'Sonstiges', '', 'Verfügbar', 'Gut', NULL, '', '');
    `);
    old.close();

    const migrated = openDatabase(file);
    assert.equal(migrated.pragma('user_version', { simple: true }), 2);
    assert.equal(migrated.prepare(`SELECT can_manage_items FROM vereins_rollen WHERE id = 3`).get().can_manage_items, 1);
    assert.ok(bcrypt.compareSync('altpasswort', migrated.prepare(`SELECT password_hash FROM nutzer WHERE id = 5`).get().password_hash));
    const loan = migrated.prepare(`SELECT * FROM ausleihen WHERE equipment_id = 1 AND zurueckgegeben_am IS NULL`).get();
    assert.equal(loan.borrower, 'Carl');
    assert.equal(loan.rueckgabe_geplant, '2026-01-01');
    assert.equal(migrated.prepare(`SELECT tuev FROM equipment WHERE id = 2`).get().tuev, null);
    migrated.close();

    // zweites Öffnen: keine erneute Migration, Daten bleiben
    const again = openDatabase(file);
    assert.equal(again.prepare(`SELECT COUNT(*) c FROM equipment`).get().c, 2);
    again.close();
});
