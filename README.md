# Equiply

Equipment-Verwaltung für Vereine – entwickelt für Tauchvereine, nutzbar für jedes Vereinsinventar.
Läuft auf dem eigenen Server, alle Daten bleiben beim Verein.

## Funktionen

- **Inventar** mit Inventarnummer, Kategorie, Hersteller, Seriennummer, Größe, Lagerort, TÜV/Prüfdatum, Zustand und Notizen
- **Fotos** pro Gerät (auch direkt mit der Handykamera, werden automatisch verkleinert)
- **Kommentare** pro Gerät, z. B. für Mängel oder Wartungshinweise
- **Ausleihe & Rückgabe** mit geplantem Rückgabedatum, Zustand bei Rückgabe und vollständigem Verlauf
- **Übersicht auf einen Blick:** verfügbar, ausgeliehen, überfällig, TÜV fällig, defekt – mit Suche, Filtern, Kachel- und Listenansicht
- **TÜV-Überwachung:** Warnung 3 Monate vorher, abgelaufene Geräte werden automatisch für die Ausleihe gesperrt
- **Excel-/CSV-Import:** vorhandene Listen hochladen, Spalten werden automatisch erkannt, Vorschau vor dem Übernehmen, erneuter Import aktualisiert statt zu duplizieren
- **Excel-Export** des kompletten Inventars, **Excel-Vorlage** zum Ausfüllen
- **Feste QR-Codes** (z. B. `K7F3X9`): Ein Gerät bekommt einen Code erst, wenn man ihn zuweist (aus dem Vorrat, per Schild-Scan oder neu). Der Code ändert sich danach nie – auch nicht bei neuer Kategorie oder Nummer; ideal zum Lasern. Codes gelöschter Geräte werden wieder frei. Download als Bild (PNG, 1000 × 1000 px), Etiketten für A4-Bögen (3 × 7)
- **Alles rund um QR-Codes an einem Ort** (Knopf „QR-Codes“): Geräte auswählen → Codes zuweisen, Etiketten drucken oder als Bilder (ZIP) herunterladen; freie Codes auf Vorrat
- **Eingebauter QR-Scanner** (Kamera oder Foto), erkennt auch helle Codes auf dunklem Metall
- **Eigene Kategorien** mit eigenem Nummernkreis (z. B. 1001–1999, bis zu 999 Geräte pro Kategorie; Nummern gelöschter Geräte werden wiederverwendet)
- **Vereinslogo und -farbe:** Logo hochladen, die Oberfläche übernimmt automatisch die Farbe
- **Mitglieder & Rollen** mit feinen Rechten (Ausleihe, Inventar, Team)
- **Aktivitätsprotokoll:** wer hat wann was geändert
- Läuft auf PC, Tablet und Handy; lässt sich auf dem Handy als App auf den Startbildschirm legen

## Installation auf einem Server (Debian/Ubuntu)

Voraussetzung: ein Linux-Server (Debian 11+ oder Ubuntu 22.04+) mit root-Zugang, idealerweise eine (Sub-)Domain, die per DNS-A-Eintrag auf den Server zeigt.

```bash
# Equiply-Paket auf den Server kopieren und entpacken, z. B.:
tar xzf equiply-2.0.0.tar.gz
cd equiply

sudo bash deploy/install.sh equiply.meinverein.de   # mit Domain → automatisch HTTPS
# oder ohne Domain:  sudo bash deploy/install.sh    → http://SERVER-IP:3000
```

Das Skript installiert Node.js, richtet Equiply als Systemdienst ein (startet automatisch, auch nach einem Neustart),
erzeugt einen geheimen Schlüssel, richtet tägliche Backups ein und – wenn eine Domain angegeben ist – den Webserver Caddy
mit kostenlosem Let's-Encrypt-Zertifikat.

**Danach sofort die Adresse im Browser öffnen und den Verein einrichten.** Wer die Ersteinrichtung abschließt, wird Admin.
Anschließend ist die Registrierung geschlossen; weitere Mitglieder legt der Admin unter *Einstellungen → Mitglieder* an.

| Was | Wo |
|-----|----|
| Programm | `/opt/equiply` |
| Datenbank | `/var/lib/equiply/equiply.db` |
| Fotos | `/var/lib/equiply/uploads/` |
| Backups | `/var/lib/equiply/backups/` (Datenbank: 14 Tage, Fotos: Spiegel) |
| Konfiguration | `/etc/equiply/equiply.env` |

### Update

Neues Paket entpacken und das Installationsskript erneut ausführen – Daten und Konfiguration bleiben erhalten,
die Datenbank wird automatisch auf den neuen Stand gebracht:

```bash
tar xzf equiply-<version>.tar.gz && cd equiply && sudo bash deploy/install.sh equiply.meinverein.de
```

### Backup & Wiederherstellung

Die Backups liegen auf demselben Server. Für echte Ausfallsicherheit den Ordner `/var/lib/equiply/backups/`
regelmäßig woandershin kopieren (z. B. per `rsync` oder Backup-Dienst des Hosters).

Wiederherstellen:

```bash
systemctl stop equiply
cp /var/lib/equiply/backups/equiply-JJJJ-MM-TT.db /var/lib/equiply/equiply.db
rm -f /var/lib/equiply/equiply.db-wal /var/lib/equiply/equiply.db-shm
rsync -a /var/lib/equiply/backups/uploads/ /var/lib/equiply/uploads/
chown -R equiply:equiply /var/lib/equiply
systemctl start equiply
```

### Nützliche Befehle

```bash
systemctl status equiply       # läuft der Dienst?
journalctl -u equiply -f       # Live-Log
systemctl restart equiply      # nach Änderungen an der Konfiguration
equiply-passwort               # alle Benutzer anzeigen
equiply-passwort anna NeuesPasswort123   # Passwort zurücksetzen (z. B. wenn der Admin es vergessen hat)
```

### Konfiguration (`/etc/equiply/equiply.env`)

| Variable | Bedeutung | Standard |
|----------|-----------|----------|
| `PORT` | Port des Dienstes | `3000` |
| `HOST` | `127.0.0.1` hinter Caddy/nginx, `0.0.0.0` für direkten Zugriff | `0.0.0.0` |
| `DB_PATH` | Datenbankdatei | `./data/equiply.db` |
| `UPLOAD_DIR` | Ordner für Fotos | neben der Datenbank: `uploads/` |
| `JWT_SECRET` | Geheimer Schlüssel für Logins (wird erzeugt) | – |
| `SESSION_DAYS` | Tage, die man ohne Nutzung angemeldet bleibt | `14` |
| `ALLOW_REGISTRATION` | `true` = weitere Vereine dürfen sich auf diesem Server registrieren (getrennte Daten) | `false` |

## Impressum & Datenschutz

Unter `/impressum.html` und `/datenschutz.html` gibt es fertige Seiten, verlinkt auf der Login-Seite und unten in der App.
Den Impressum-Text trägt der Admin unter *Einstellungen → Verein → Impressum* ein. Die Datenschutzerklärung beschreibt,
was Equiply verarbeitet, und verweist für die Kontaktdaten auf das Impressum.

## Datenschutz & Sicherheit

- Alles läuft auf dem eigenen Server. Es werden **keine externen Dienste, CDNs oder Schriftarten** nachgeladen und keine Daten an Dritte übertragen.
- Es wird nur ein technisch notwendiges Sitzungs-Cookie gesetzt (HttpOnly, SameSite=Strict) – kein Tracking.
- Passwörter werden mit bcrypt gespeichert. Nach 10 Fehlversuchen wird der Login für 15 Minuten gebremst.
- Ändert ein Mitglied sein Passwort (oder setzt ein Admin es zurück), werden alle anderen Sitzungen abgemeldet.
- Strikte Content-Security-Policy, Prüfung aller Eingaben, Fotos werden anhand ihres Inhalts geprüft (nur JPG, PNG, WebP, GIF).

Gespeicherte personenbezogene Daten: Benutzername und E-Mail der Mitglieder, Namen von Ausleihern, Kommentare und das
Aktivitätsprotokoll. Der Verein ist dafür verantwortlich, seine Mitglieder darüber zu informieren (Datenschutzerklärung).

## Entwicklung

```bash
npm install
cp .env.example .env          # JWT_SECRET eintragen
npm run dev                   # Server mit automatischem Neuladen auf http://localhost:3000
npm run watch:css             # CSS bei Änderungen neu bauen (Tailwind)
npm test                      # API-, Import- und Migrationstests
npm run package               # Paket equiply-<version>.tar.gz für die Weitergabe erstellen
```

```
server.js              Einstiegspunkt
src/config.js          Konfiguration aus Umgebungsvariablen / .env
src/db.js              Datenbankverbindung (SQLite) + Migrationen
src/migrations.js      Datenbankschema (versioniert, wird beim Start automatisch aktualisiert)
src/session.js         Login-Sitzungen, Rechte, Login-Bremse
src/inventory.js       Inventar-Logik (Nummernvergabe, Änderungsprotokoll)
src/importer.js        Excel-/CSV-Erkennung
src/routes/            API: auth, team, equipment, transfer (Import/Export)
public/                Oberfläche (HTML, JS, gebautes CSS)
styles/app.css         Tailwind-Quelle für public/app.css
deploy/install.sh      Installations- und Update-Skript
test/                  Tests
```

Nach Änderungen an Klassen in `public/` oder an `styles/app.css`: `npm run build:css` ausführen und `public/app.css` mit einchecken.
