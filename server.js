const config = require('./src/config');
const { openDatabase } = require('./src/db');
const { createApp } = require('./src/app');
const { version } = require('./package.json');

const db = openDatabase(config.dbPath);
const app = createApp(db, config);

const server = app.listen(config.port, config.host, () => {
    console.log(`Equiply ${version} läuft auf http://${config.host}:${config.port}`);
    console.log(`Datenbank: ${config.dbPath}`);
    console.log(`Bilder:    ${config.uploadDir}`);
});

function shutdown() {
    server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
