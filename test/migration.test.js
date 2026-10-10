const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { openDatabase } = require('../src/db');

test('Migration übernimmt eine equiply.db aus der allerersten Version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equiply-mig-'));
    const file = path.join(dir, 'alt.db');
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
        INSERT INTO equipment VALUES (2, 7, 'Kram', '501', 'Quatsch', '', 'Verfügbar', 'kaputt?', NULL, '', '');
    `);
    old.close();

    const db = openDatabase(file);
    assert.equal(db.pragma('user_version', { simple: true }), 7);
    // Kürzel aus den Kategorienamen
    assert.deepEqual(db.prepare(`SELECT name, prefix FROM kategorien WHERE verein_id = 7 ORDER BY name`).all().map(k => `${k.name}:${k.prefix}`),
        ['Atemregler:AT', 'Blei:BL', 'Flaschen:FL', 'Jackets:JA', 'Sonstiges:SO']);
    assert.equal(db.prepare(`SELECT can_manage_items FROM vereins_rollen WHERE id = 3`).get().can_manage_items, 1);
    const user = db.prepare(`SELECT password_hash, token_version FROM nutzer WHERE id = 5`).get();
    assert.ok(bcrypt.compareSync('altpasswort', user.password_hash));
    assert.equal(user.token_version, 0);

    assert.equal(db.prepare(`SELECT COUNT(*) c FROM kategorien WHERE verein_id = 7`).get().c, 5);
    const items = db.prepare(`SELECT e.id, e.device_id, e.tuev, e.condition, k.name AS kat FROM equipment e JOIN kategorien k ON k.id = e.kategorie_id ORDER BY e.id`).all();
    assert.match(items[0].device_id, /^FL[0-9A-Z]{4}$/, 'neuer Code mit Kategorie-Kürzel');
    assert.match(items[1].device_id, /^SO[0-9A-Z]{4}$/);
    assert.deepEqual(items.map(i => [i.tuev, i.condition, i.kat]), [['2025-05-01', 'Gut', 'Flaschen'], [null, 'Gut', 'Sonstiges']]);
    // Frühere Nummern und frühere QR-Codes führen weiterhin zum Gerät
    const alteCodes = db.prepare(`SELECT code FROM qr_codes WHERE equipment_id = 1 ORDER BY code`).all().map(r => r.code);
    assert.ok(alteCodes.includes("1001") && alteCodes.includes(items[0].device_id) && alteCodes.length === 3, JSON.stringify(alteCodes));
    const loan = db.prepare(`SELECT * FROM ausleihen WHERE equipment_id = 1 AND zurueckgegeben_am IS NULL`).get();
    assert.equal(loan.borrower, 'Carl');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();

    // Erneutes Öffnen: keine weitere Migration, Daten bleiben
    const again = openDatabase(file);
    assert.equal(again.prepare(`SELECT COUNT(*) c FROM equipment`).get().c, 2);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
