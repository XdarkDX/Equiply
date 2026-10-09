const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const migrations = require('./migrations');

function openDatabase(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');   // bessere Parallelität, crash-sicher
    db.pragma('foreign_keys = ON');    // Fremdschlüssel wirklich durchsetzen
    db.pragma('busy_timeout = 5000');

    migrate(db);
    return db;
}

// Führt alle noch nicht angewendeten Migrationen aus. Der Stand wird in PRAGMA user_version gespeichert.
function migrate(db) {
    const current = db.pragma('user_version', { simple: true });
    const pending = migrations.filter(m => m.version > current);
    if (pending.length === 0) return;

    // Während Tabellen umgebaut werden, müssen FK-Prüfungen aus sein (geht nur außerhalb einer Transaktion).
    db.pragma('foreign_keys = OFF');
    try {
        for (const m of pending) {
            db.transaction(() => {
                m.up(db);
                const violations = db.pragma('foreign_key_check');
                if (violations.length) throw new Error(`Migration ${m.version}: Fremdschlüssel verletzt (${violations.length}x)`);
                db.pragma(`user_version = ${m.version}`);
            })();
            console.log(`[DB] Migration ${m.version} angewendet: ${m.name}`);
        }
    } finally {
        db.pragma('foreign_keys = ON');
    }
}

module.exports = { openDatabase };
