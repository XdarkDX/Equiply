// Datenbank-Migrationen. Jede Migration läuft genau einmal und in einer Transaktion.
// Neue Änderungen am Schema immer als NEUE Migration hinten anhängen – bestehende nie verändern.

const { generateCode } = require('./util');

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
    {
        version: 3,
        name: 'Eigene Kategorien, Zusatzfelder, Bilder, Kommentare, Aktivitätsprotokoll, Sitzungsversion',
        up(db) {
            db.exec(`
                ALTER TABLE nutzer ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

                CREATE TABLE kategorien (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    verein_id   INTEGER NOT NULL REFERENCES vereine(id) ON DELETE CASCADE,
                    name        TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
                    prefix      TEXT NOT NULL CHECK (length(prefix) BETWEEN 1 AND 4 AND prefix NOT GLOB '*[^0-9A-Z]*'),
                    created_at  TEXT NOT NULL DEFAULT ${NOW},
                    UNIQUE (verein_id, name),
                    UNIQUE (verein_id, prefix)
                );

                INSERT INTO kategorien (verein_id, name, prefix)
                SELECT v.id, k.name, k.prefix FROM vereine v CROSS JOIN (
                    SELECT 'Flaschen' AS name, '1' AS prefix UNION ALL SELECT 'Atemregler', '2' UNION ALL
                    SELECT 'Jackets', '3' UNION ALL SELECT 'Blei', '4' UNION ALL SELECT 'Sonstiges', '5'
                ) k;

                CREATE TABLE equipment_neu (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    verein_id     INTEGER NOT NULL REFERENCES vereine(id) ON DELETE CASCADE,
                    kategorie_id  INTEGER NOT NULL REFERENCES kategorien(id),
                    device_id     TEXT NOT NULL CHECK (length(trim(device_id)) > 0),
                    name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
                    hersteller    TEXT,
                    seriennummer  TEXT,
                    groesse       TEXT,
                    lagerort      TEXT,
                    kaufdatum     TEXT CHECK (kaufdatum IS NULL OR kaufdatum ${ISO_DATE}),
                    tuev          TEXT CHECK (tuev IS NULL OR tuev ${ISO_DATE}),
                    condition     TEXT NOT NULL DEFAULT 'Gut' CHECK (condition IN ('Gut', 'Gebrauchsspuren', 'Reparaturbedürftig')),
                    notes         TEXT,
                    created_at    TEXT NOT NULL DEFAULT ${NOW},
                    updated_at    TEXT NOT NULL DEFAULT ${NOW},
                    UNIQUE (verein_id, device_id)
                );

                INSERT INTO equipment_neu (id, verein_id, kategorie_id, device_id, name, tuev, condition, notes, created_at, updated_at)
                SELECT e.id, e.verein_id, k.id, e.device_id, e.name, e.tuev, e.condition, e.notes, e.created_at, e.updated_at
                FROM equipment e JOIN kategorien k ON k.verein_id = e.verein_id AND k.name = e.category;

                DROP TABLE equipment;
                ALTER TABLE equipment_neu RENAME TO equipment;
                CREATE INDEX idx_equipment_verein ON equipment(verein_id);
                CREATE INDEX idx_equipment_kategorie ON equipment(kategorie_id);

                CREATE TRIGGER trg_equipment_updated_at AFTER UPDATE ON equipment
                FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at
                BEGIN
                    UPDATE equipment SET updated_at = ${NOW} WHERE id = NEW.id;
                END;

                CREATE TABLE bilder (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    equipment_id  INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
                    datei         TEXT NOT NULL UNIQUE,
                    mime          TEXT NOT NULL,
                    groesse       INTEGER NOT NULL,
                    erstellt_von  INTEGER REFERENCES nutzer(id) ON DELETE SET NULL,
                    created_at    TEXT NOT NULL DEFAULT ${NOW}
                );
                CREATE INDEX idx_bilder_equipment ON bilder(equipment_id);

                CREATE TABLE kommentare (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    equipment_id  INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
                    nutzer_id     INTEGER REFERENCES nutzer(id) ON DELETE SET NULL,
                    text          TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 2000),
                    created_at    TEXT NOT NULL DEFAULT ${NOW}
                );
                CREATE INDEX idx_kommentare_equipment ON kommentare(equipment_id, created_at);

                -- Wer hat wann was gemacht. Bleibt erhalten, auch wenn Gerät oder Nutzer gelöscht werden.
                CREATE TABLE aktivitaeten (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    verein_id     INTEGER NOT NULL REFERENCES vereine(id) ON DELETE CASCADE,
                    equipment_id  INTEGER REFERENCES equipment(id) ON DELETE SET NULL,
                    nutzer_id     INTEGER REFERENCES nutzer(id) ON DELETE SET NULL,
                    aktion        TEXT NOT NULL,
                    details       TEXT,
                    created_at    TEXT NOT NULL DEFAULT ${NOW}
                );
                CREATE INDEX idx_aktivitaeten_verein ON aktivitaeten(verein_id, created_at);
                CREATE INDEX idx_aktivitaeten_equipment ON aktivitaeten(equipment_id);
            `);
        },
    },
    {
        version: 4,
        name: 'Vereinslogo und -farbe, Inventarnummern dreistellig (101 -> 1001)',
        up(db) {
            db.exec(`
                ALTER TABLE vereine ADD COLUMN logo TEXT;
                ALTER TABLE vereine ADD COLUMN farbe TEXT CHECK (farbe IS NULL OR farbe GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]');
            `);
            // Kürzel + 2 Stellen -> Kürzel + 3 Stellen, damit 999 Geräte pro Kategorie möglich sind
            const rows = db.prepare(`SELECT e.id, e.verein_id, e.device_id, k.prefix FROM equipment e JOIN kategorien k ON k.id = e.kategorie_id`).all();
            const taken = db.prepare(`SELECT 1 FROM equipment WHERE verein_id = ? AND device_id = ?`);
            const update = db.prepare(`UPDATE equipment SET device_id = ? WHERE id = ?`);
            for (const r of rows) {
                const rest = r.device_id.slice(r.prefix.length);
                if (!r.device_id.startsWith(r.prefix) || !/^[0-9]{2}$/.test(rest)) continue;
                const neu = r.prefix + '0' + rest;
                if (!taken.get(r.verein_id, neu)) update.run(neu, r.id);
            }
        },
    },
    {
        version: 5,
        name: 'Feste QR-Codes pro Gerät (unabhängig von Nummer und Kategorie), Adresse für QR-Codes',
        up(db) {
            db.exec(`
                ALTER TABLE vereine ADD COLUMN qr_url TEXT;

                -- Ein QR-Code ändert sich nie. Wird das Gerät gelöscht, wird der Code frei und kann neu zugewiesen werden.
                CREATE TABLE qr_codes (
                    code          TEXT PRIMARY KEY CHECK (length(code) BETWEEN 4 AND 12),
                    verein_id     INTEGER NOT NULL REFERENCES vereine(id) ON DELETE CASCADE,
                    equipment_id  INTEGER UNIQUE REFERENCES equipment(id) ON DELETE SET NULL,
                    created_at    TEXT NOT NULL DEFAULT ${NOW}
                );
                CREATE INDEX idx_qr_codes_verein ON qr_codes(verein_id);
            `);
            const insert = db.prepare(`INSERT OR IGNORE INTO qr_codes (code, verein_id, equipment_id) VALUES (?, ?, ?)`);
            for (const e of db.prepare(`SELECT id, verein_id FROM equipment`).all()) {
                while (insert.run(generateCode(), e.verein_id, e.id).changes === 0) { /* Code schon vergeben -> neuer Versuch */ }
            }
        },
    },
];
