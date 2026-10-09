// Datenbank-Migrationen. Jede Migration läuft genau einmal und in einer Transaktion.
// Neue Änderungen am Schema immer als NEUE Migration hinten anhängen – bestehende nie verändern.

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
const ISO_DATE = `GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`;

function tableExists(db, name) {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function columnExists(db, table, column) {
    return db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column) !== undefined;
}

module.exports = [
    {
        version: 1,
        name: 'Ausgangsschema (kompatibel zu alten equiply.db-Dateien)',
        up(db) {
            db.exec(`
                CREATE TABLE IF NOT EXISTS vereine (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE);
                CREATE TABLE IF NOT EXISTS vereins_rollen (id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, name TEXT, permissions TEXT);
                CREATE TABLE IF NOT EXISTS nutzer (id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, username TEXT UNIQUE, email TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'user');
                CREATE TABLE IF NOT EXISTS equipment (id INTEGER PRIMARY KEY AUTOINCREMENT, verein_id INTEGER, name TEXT, deviceId TEXT, category TEXT, tuev TEXT, status TEXT DEFAULT 'Verfügbar', condition TEXT DEFAULT 'Gut', notes TEXT, borrower TEXT, returnDate TEXT);
            `);
            if (!columnExists(db, 'nutzer', 'vereins_rolle_id')) db.exec(`ALTER TABLE nutzer ADD COLUMN vereins_rolle_id INTEGER`);
        },
    },
    {
        version: 2,
        name: 'Sauberes Schema: Constraints, Kaskaden, Indizes, Rechte als Spalten, Ausleih-Historie',
        up(db) {
            for (const t of ['vereine', 'vereins_rollen', 'nutzer', 'equipment']) {
                if (tableExists(db, t)) db.exec(`ALTER TABLE ${t} RENAME TO _alt_${t}`);
            }

            db.exec(`
                CREATE TABLE vereine (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    name        TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) > 0),
                    created_at  TEXT NOT NULL DEFAULT ${NOW}
                );

                CREATE TABLE vereins_rollen (
                    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
                    verein_id          INTEGER NOT NULL REFERENCES vereine(id) ON DELETE CASCADE,
                    name               TEXT NOT NULL CHECK (length(trim(name)) > 0),
                    can_manage_users   INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_users IN (0, 1)),
                    can_manage_items   INTEGER NOT NULL DEFAULT 0 CHECK (can_manage_items IN (0, 1)),
                    can_borrow_return  INTEGER NOT NULL DEFAULT 0 CHECK (can_borrow_return IN (0, 1)),
                    created_at         TEXT NOT NULL DEFAULT ${NOW},
                    UNIQUE (verein_id, name)
                );

                CREATE TABLE nutzer (
                    id                INTEGER PRIMARY KEY AUTOINCREMENT,
                    verein_id         INTEGER NOT NULL REFERENCES vereine(id) ON DELETE CASCADE,
                    username          TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(username)) > 0),
                    email             TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (email LIKE '%_@_%'),
                    password_hash     TEXT NOT NULL,
                    role              TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
                    vereins_rolle_id  INTEGER REFERENCES vereins_rollen(id) ON DELETE SET NULL,
                    created_at        TEXT NOT NULL DEFAULT ${NOW}
                );
                CREATE INDEX idx_nutzer_verein ON nutzer(verein_id);
                CREATE INDEX idx_nutzer_rolle ON nutzer(vereins_rolle_id);

                CREATE TABLE equipment (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    verein_id   INTEGER NOT NULL REFERENCES vereine(id) ON DELETE CASCADE,
                    device_id   TEXT NOT NULL,
                    name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
                    category    TEXT NOT NULL CHECK (category IN ('Flaschen', 'Atemregler', 'Jackets', 'Blei', 'Sonstiges')),
                    tuev        TEXT CHECK (tuev IS NULL OR tuev ${ISO_DATE}),
                    condition   TEXT NOT NULL DEFAULT 'Gut' CHECK (condition IN ('Gut', 'Gebrauchsspuren', 'Reparaturbedürftig')),
                    notes       TEXT,
                    created_at  TEXT NOT NULL DEFAULT ${NOW},
                    updated_at  TEXT NOT NULL DEFAULT ${NOW},
                    UNIQUE (verein_id, device_id)
                );
                CREATE INDEX idx_equipment_verein_kategorie ON equipment(verein_id, category);

                -- Jede Ausleihe ist ein eigener Datensatz -> vollständige Historie.
                -- Offene Ausleihe = zurueckgegeben_am IS NULL (höchstens eine pro Gerät).
                CREATE TABLE ausleihen (
                    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                    equipment_id          INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
                    borrower              TEXT NOT NULL CHECK (length(trim(borrower)) > 0),
                    ausgeliehen_am        TEXT NOT NULL DEFAULT ${NOW},
                    rueckgabe_geplant     TEXT CHECK (rueckgabe_geplant IS NULL OR rueckgabe_geplant ${ISO_DATE}),
                    ausgegeben_von        INTEGER REFERENCES nutzer(id) ON DELETE SET NULL,
                    zurueckgegeben_am     TEXT,
                    zurueckgenommen_von   INTEGER REFERENCES nutzer(id) ON DELETE SET NULL,
                    zustand_bei_rueckgabe TEXT CHECK (zustand_bei_rueckgabe IS NULL OR zustand_bei_rueckgabe IN ('Gut', 'Gebrauchsspuren', 'Reparaturbedürftig'))
                );
                CREATE INDEX idx_ausleihen_equipment ON ausleihen(equipment_id, ausgeliehen_am);
                CREATE UNIQUE INDEX idx_ausleihen_offen ON ausleihen(equipment_id) WHERE zurueckgegeben_am IS NULL;

                CREATE TRIGGER trg_equipment_updated_at AFTER UPDATE ON equipment
                FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
                BEGIN
                    UPDATE equipment SET updated_at = ${NOW} WHERE id = NEW.id;
                END;
            `);

            // --- Altdaten übernehmen (falls vorhanden) ---
            if (tableExists(db, '_alt_vereine')) {
                db.exec(`INSERT INTO vereine (id, name) SELECT id, name FROM _alt_vereine WHERE name IS NOT NULL AND trim(name) <> ''`);
            }

            if (tableExists(db, '_alt_vereins_rollen')) {
                const rollen = db.prepare(`SELECT * FROM _alt_vereins_rollen WHERE verein_id IN (SELECT id FROM vereine)`).all();
                const insert = db.prepare(`INSERT INTO vereins_rollen (id, verein_id, name, can_manage_users, can_manage_items, can_borrow_return) VALUES (?, ?, ?, ?, ?, ?)`);
                for (const r of rollen) {
                    let p = {};
                    try { p = JSON.parse(r.permissions) || {}; } catch (e) { /* ungültiges JSON -> keine Rechte */ }
                    insert.run(r.id, r.verein_id, r.name || `Rolle ${r.id}`, p.can_manage_users ? 1 : 0, p.can_manage_items ? 1 : 0, p.can_borrow_return ? 1 : 0);
                }
            }

            if (tableExists(db, '_alt_nutzer')) {
                db.exec(`
                    INSERT INTO nutzer (id, verein_id, username, email, password_hash, role, vereins_rolle_id)
                    SELECT id, verein_id, username, email, password,
                           CASE WHEN role = 'admin' THEN 'admin' ELSE 'user' END,
                           CASE WHEN vereins_rolle_id IN (SELECT id FROM vereins_rollen) THEN vereins_rolle_id END
                    FROM _alt_nutzer
                    WHERE verein_id IN (SELECT id FROM vereine) AND username IS NOT NULL AND email IS NOT NULL AND password IS NOT NULL
                `);
            }

            if (tableExists(db, '_alt_equipment')) {
                db.exec(`
                    INSERT INTO equipment (id, verein_id, device_id, name, category, tuev, condition, notes)
                    SELECT id, verein_id, COALESCE(NULLIF(deviceId, ''), 'ALT-' || id), COALESCE(NULLIF(trim(name), ''), 'Unbenannt'),
                           CASE WHEN category IN ('Flaschen', 'Atemregler', 'Jackets', 'Blei') THEN category ELSE 'Sonstiges' END,
                           CASE WHEN tuev ${ISO_DATE} THEN tuev END,
                           CASE WHEN condition IN ('Gut', 'Gebrauchsspuren', 'Reparaturbedürftig') THEN condition ELSE 'Gut' END,
                           notes
                    FROM _alt_equipment
                    WHERE verein_id IN (SELECT id FROM vereine);

                    INSERT INTO ausleihen (equipment_id, borrower, rueckgabe_geplant)
                    SELECT id, COALESCE(NULLIF(trim(borrower), ''), 'Unbekannt'), CASE WHEN returnDate ${ISO_DATE} THEN returnDate END
                    FROM _alt_equipment
                    WHERE status = 'Ausgeliehen' AND id IN (SELECT id FROM equipment);
                `);
            }

            for (const t of ['equipment', 'nutzer', 'vereins_rollen', 'vereine']) {
                if (tableExists(db, `_alt_${t}`)) db.exec(`DROP TABLE _alt_${t}`);
            }
        },
    },
];
