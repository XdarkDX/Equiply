#!/usr/bin/env node
// Setzt das Passwort eines Mitglieds direkt in der Datenbank zurück (z. B. wenn der einzige Admin es vergessen hat).
// Aufruf auf dem Server:  equiply-passwort <benutzername oder e-mail> <neues passwort>
//          ohne Angaben:  equiply-passwort   (listet alle Benutzer)
const bcrypt = require('bcrypt');
const config = require('../src/config');
const { openDatabase } = require('../src/db');

const [login, password] = process.argv.slice(2);
const db = openDatabase(config.dbPath);

if (!login) {
    const users = db.prepare(`SELECT n.username, n.email, n.role, v.name AS verein FROM nutzer n JOIN vereine v ON v.id = n.verein_id ORDER BY v.name, n.username`).all();
    if (!users.length) console.log('Noch keine Benutzer – bitte zuerst im Browser den Verein einrichten.');
    for (const u of users) console.log(`${u.username.padEnd(20)} ${u.email.padEnd(32)} ${u.role === 'admin' ? 'Admin' : 'Mitglied'}  (${u.verein})`);
    console.log('\nPasswort zurücksetzen:  equiply-passwort <benutzername> <neues passwort>');
    process.exit(0);
}
if (!password || password.length < 8) {
    console.error('Das neue Passwort muss mindestens 8 Zeichen lang sein.');
    process.exit(1);
}
const user = db.prepare(`SELECT id, username FROM nutzer WHERE username = ? OR email = ?`).get(login, login);
if (!user) {
    console.error(`Benutzer „${login}“ nicht gefunden. Ohne Angaben aufrufen, um alle Benutzer zu sehen.`);
    process.exit(1);
}
db.prepare(`UPDATE nutzer SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`).run(bcrypt.hashSync(password, 12), user.id);
console.log(`Passwort für „${user.username}“ wurde geändert. Jetzt im Browser damit anmelden.`);
db.close();
