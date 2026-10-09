const config = require('./src/config');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');

const db = openDatabase(config.dbPath);
const app = createApp(db, config);

const server = app.listen(config.port, config.host, () => {
    console.log(`Server läuft auf http://${config.host}:${config.port}`);
    console.log(`Datenbank: ${config.dbPath}`);
    if (!config.superadminUser || !config.superadminPassword) console.log('Superadmin-Login ist deaktiviert (SUPERADMIN_USER / SUPERADMIN_PASSWORD nicht gesetzt).');
});

function shutdown() {
    server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
