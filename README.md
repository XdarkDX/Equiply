# Equiply

Equipment-Verwaltung für Tauchvereine: Inventar, TÜV-Termine, Ausleihe/Rückgabe, Rollen & Rechte.

## Starten

```bash
npm install
cp .env.example .env     # JWT_SECRET und ggf. SUPERADMIN_* eintragen
npm start                # http://localhost:3000
```

`npm run dev` startet mit automatischem Neuladen, `npm test` führt die API-Tests aus.

## Auf einem Server installieren (Debian/Ubuntu)

```bash
apt install -y git
git clone -b ccr-632c83c1-hj1wq2 https://github.com/XdarkDX/Equiply.git
cd Equiply
sudo bash deploy/install.sh equiply.meinverein.de   # mit Domain → automatisch HTTPS
# oder ohne Domain:  sudo bash deploy/install.sh    → http://SERVER-IP:3000
```

Das Skript installiert Node.js, richtet Equiply als Systemdienst ein (startet automatisch nach Neustart),
erzeugt sichere Schlüssel, legt tägliche Backups an und richtet bei Angabe einer Domain Caddy mit
Let's-Encrypt-Zertifikat ein. Das Superadmin-Passwort wird am Ende einmal angezeigt.

| Was | Wo |
|-----|----|
| Programm | `/opt/equiply` |
| Datenbank | `/var/lib/equiply/equiply.db` |
| Backups (14 Tage) | `/var/lib/equiply/backups/` |
| Konfiguration | `/etc/equiply/equiply.env` |

**Update:** `cd Equiply && git pull && sudo bash deploy/install.sh <domain>`
**Log:** `journalctl -u equiply -f`

## Aufbau

```
server.js            Einstiegspunkt
src/config.js        Konfiguration aus Umgebungsvariablen / .env
src/db.js            Datenbankverbindung + Migrationen ausführen
src/migrations.js    Datenbankschema (versioniert)
src/app.js           Express-API
Equiply.html         Frontend
test/                API- und Migrationstests
```

## Datenbank

SQLite über `better-sqlite3` (Datei standardmäßig unter `data/equiply.db`, WAL-Modus, Fremdschlüssel aktiv).

| Tabelle          | Inhalt |
|------------------|--------|
| `vereine`        | Vereine (Name eindeutig, ohne Groß-/Kleinschreibung) |
| `vereins_rollen` | Rollen je Verein mit den Rechten als eigene Spalten |
| `nutzer`         | Benutzer (`admin` oder `user` + optionale Vereinsrolle) |
| `equipment`      | Inventar mit Inventarnummer (eindeutig je Verein), Kategorie, TÜV, Zustand |
| `ausleihen`      | Jede Ausleihe als eigener Datensatz → vollständiger Verlauf. Pro Gerät höchstens eine offene Ausleihe. |

- Wird ein Verein gelöscht, entfernt die Datenbank automatisch alle zugehörigen Daten (`ON DELETE CASCADE`).
- Schemaänderungen werden als neue Migration in `src/migrations.js` angehängt; der Stand steht in `PRAGMA user_version`.
- Eine alte `equiply.db` aus der Vorversion wird beim ersten Start automatisch übernommen
  (`DB_PATH=./equiply.db npm start`). Vorher am besten eine Kopie der Datei anlegen.

**Backup:** im laufenden Betrieb z. B. `sqlite3 data/equiply.db ".backup backup.db"`.
