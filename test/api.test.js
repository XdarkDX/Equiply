const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client } = require('./helpers');

let srv, admin, helfer;
const ids = {};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);

before(async () => { srv = await startServer(); admin = client(srv.base); helfer = client(srv.base); });
after(() => srv.close());

test('Ersteinrichtung: nur einmal möglich, danach ist die Registrierung zu', async () => {
    assert.deepEqual((await admin.get('/api/setup')).body, { einrichtung: true, registrierung: false, version: require('../package.json').version });
    assert.equal((await admin.get('/api/me')).status, 401);

    const r = await admin.post('/api/setup', { vereinName: 'Tauchclub Nord', username: 'chef', email: 'chef@example.de', password: 'geheim123' });
    assert.equal(r.status, 201);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);

    const me = (await admin.get('/api/me')).body;
    assert.equal(me.role, 'admin');
    assert.equal(me.verein.name, 'Tauchclub Nord');

    assert.equal((await admin.get('/api/setup')).body.einrichtung, false);
    const fremd = client(srv.base);
    assert.equal((await fremd.post('/api/setup', { vereinName: 'Hacker', username: 'h', email: 'h@example.de', password: 'geheim123' })).status, 403);
    // Standard-Kategorien wurden angelegt
    assert.deepEqual((await admin.get('/api/kategorien')).body.map(k => k.name), ['Flaschen', 'Atemregler', 'Jackets', 'Blei', 'Sonstiges']);
});

test('Kein Superadmin mehr', async () => {
    const c = client(srv.base);
    assert.equal((await c.post('/api/login', { username: 'admin', password: 'EquiplyMaster2026!' })).status, 401);
    assert.equal((await admin.get('/api/system-overview')).status, 404);
});

test('Login per Benutzername oder E-Mail, Logout', async () => {
    const c = client(srv.base);
    assert.equal((await c.post('/api/login', { username: 'chef', password: 'falsch123' })).status, 401);
    assert.equal((await c.post('/api/login', { username: 'CHEF@example.de', password: 'geheim123' })).status, 200);
    assert.equal((await c.get('/api/me')).status, 200);
    await c.post('/api/logout');
    assert.equal((await c.get('/api/me')).status, 401);
});

test('Sicherheits-Header, Fremd-Origin wird blockiert, Frontend wird ausgeliefert', async () => {
    const r = await admin.get('/api/me');
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal((await admin.post('/api/kategorien', { name: 'X' }, { headers: { Origin: 'https://boese.example' } })).status, 403);
    const page = await fetch(srv.base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Equiply/);
});

test('Rollen und Mitglieder mit eingeschränkten Rechten', async () => {
    const r = await admin.post('/api/rollen', { name: 'Ausgabe', permissions: { can_borrow_return: true } });
    assert.equal(r.status, 201);
    ids.rolle = r.body.id;
    assert.equal((await admin.post('/api/rollen', { name: 'Ausgabe', permissions: {} })).status, 409);

    const u = await admin.post('/api/users', { username: 'helfer', email: 'helfer@example.de', password: 'helfer123', rolle: String(ids.rolle) });
    assert.equal(u.status, 201);
    ids.helfer = u.body.id;
    assert.equal((await admin.post('/api/users', { username: 'helfer', email: 'x@example.de', password: 'helfer123' })).status, 409);

    assert.equal((await helfer.post('/api/login', { username: 'helfer', password: 'helfer123' })).status, 200);
    assert.deepEqual((await helfer.get('/api/me')).body.permissions, { can_manage_users: false, can_manage_items: false, can_borrow_return: true });
    assert.equal((await helfer.get('/api/users')).status, 403);
    assert.equal((await helfer.post('/api/equipment', { name: 'X', kategorie_id: 1 })).status, 403);
});

test('Kategorien: eigene anlegen, Kürzel-Konflikte, Löschen nur wenn leer', async () => {
    const r = await admin.post('/api/kategorien', { name: 'Lampen' });
    assert.equal(r.status, 201);
    assert.equal(r.body.prefix, '6');
    ids.lampen = r.body.id;
    assert.equal((await admin.post('/api/kategorien', { name: 'Anzüge', prefix: '12' })).status, 409, '12 kollidiert mit 1');
    assert.equal((await admin.post('/api/kategorien', { name: 'lampen' })).status, 409, 'Name doppelt');
    const anz = await admin.post('/api/kategorien', { name: 'Anzüge', prefix: 'AZ' });
    assert.equal(anz.status, 201);
    assert.equal((await admin.del(`/api/kategorien/${anz.body.id}`)).status, 200);
});

test('Geräte anlegen mit allen Feldern und fortlaufenden Nummern', async () => {
    const kats = (await admin.get('/api/kategorien')).body;
    ids.flaschen = kats.find(k => k.name === 'Flaschen').id;
    const a = await admin.post('/api/equipment', { name: '12L Stahl', kategorie_id: ids.flaschen, tuev: '2030-01-31', hersteller: 'Faber', seriennummer: 'SN-1', groesse: '12 L', lagerort: 'Raum A', notes: 'Rot lackiert' });
    const b = await admin.post('/api/equipment', { name: '10L Alu', kategorie_id: ids.flaschen });
    const c = await admin.post('/api/equipment', { name: 'Taschenlampe', kategorie_id: ids.lampen });
    assert.deepEqual([a.body.deviceId, b.body.deviceId, c.body.deviceId], ['1001', '1002', '6001']);
    ids.flasche = a.body.id;
    ids.lampe = c.body.id;

    const item = (await admin.get(`/api/equipment/${ids.flasche}`)).body;
    assert.equal(item.hersteller, 'Faber');
    assert.equal(item.category, 'Flaschen');
    assert.equal(item.aktivitaeten[0].aktion, 'erstellt');

    assert.equal((await admin.post('/api/equipment', { name: 'X', kategorie_id: 9999 })).status, 400);
    assert.equal((await admin.post('/api/equipment', { name: 'X', kategorie_id: ids.flaschen, tuev: '31.02.2030' })).status, 400);
    assert.equal((await admin.post('/api/equipment', { name: 'X', kategorie_id: ids.flaschen, tuev: '2030-02-31' })).status, 400);
    assert.equal((await admin.del(`/api/kategorien/${ids.lampen}`)).status, 409, 'Kategorie nicht leer');
});

test('Bearbeiten schreibt verständliche Änderungen ins Protokoll', async () => {
    const item = (await admin.get(`/api/equipment/${ids.flasche}`)).body;
    await admin.put(`/api/equipment/${ids.flasche}`, { ...item, kategorie_id: item.kategorie_id, tuev: '2032-01-31' });
    let log = (await admin.get(`/api/equipment/${ids.flasche}`)).body.aktivitaeten;
    assert.equal(log[0].aktion, 'tuev');
    assert.match(log[0].details, /31\.01\.2032/);

    await admin.put(`/api/equipment/${ids.flasche}`, { ...item, tuev: '2032-01-31', lagerort: 'Raum B', name: '12L Stahl rot' });
    log = (await admin.get(`/api/equipment/${ids.flasche}`)).body.aktivitaeten;
    assert.equal(log[0].aktion, 'bearbeitet');
    assert.match(log[0].details, /Lagerort: Raum A → Raum B/);
});

test('Ausleihe und Rückgabe mit Kommentar und Verlauf', async () => {
    assert.equal((await helfer.put(`/api/equipment/${ids.flasche}/action`, { borrower: 'Anna', returnDate: '2000-01-01' })).status, 400, 'Datum in der Vergangenheit');
    assert.equal((await helfer.put(`/api/equipment/${ids.flasche}/action`, { borrower: 'Anna', returnDate: '2099-02-01' })).status, 200);
    assert.equal((await helfer.put(`/api/equipment/${ids.flasche}/action`, { borrower: 'Ben' })).status, 409);

    let list = (await helfer.get('/api/equipment')).body;
    let item = list.find(i => i.id === ids.flasche);
    assert.equal(item.status, 'Ausgeliehen');
    assert.equal(item.borrower, 'Anna');

    assert.equal((await helfer.put(`/api/equipment/${ids.flasche}/action`, { condition: 'Reparaturbedürftig', kommentar: 'Ventil undicht' })).status, 200);
    item = (await helfer.get(`/api/equipment/${ids.flasche}`)).body;
    assert.equal(item.status, 'Verfügbar');
    assert.equal(item.condition, 'Reparaturbedürftig');
    assert.equal(item.kommentare[0].text, 'Ventil undicht');
    assert.equal(item.ausleihen[0].ausgegeben_von, 'helfer');
    assert.ok(item.aktivitaeten.some(a => a.aktion === 'zurueckgegeben'));
    assert.equal((await helfer.put(`/api/equipment/${ids.flasche}/action`, { borrower: 'Ben' })).status, 409, 'defekt');

    assert.ok((await helfer.get('/api/ausleiher')).body.includes('Anna'));
});

test('Bilder: Upload prüft Dateityp, Abruf nur im eigenen Verein, Löschen', async () => {
    const bad = await helfer.post(`/api/equipment/${ids.flasche}/bilder`, Buffer.from('<svg onload=alert(1)>'), { headers: { 'Content-Type': 'image/svg+xml' } });
    assert.equal(bad.status, 400);
    const ok = await helfer.post(`/api/equipment/${ids.flasche}/bilder`, JPEG, { headers: { 'Content-Type': 'image/jpeg' } });
    assert.equal(ok.status, 201);
    ids.bild = ok.body.id;

    const img = await admin.get(`/api/bilder/${ids.bild}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(img.body, JPEG);
    assert.equal((await client(srv.base).get(`/api/bilder/${ids.bild}`)).status, 401);

    const list = (await admin.get('/api/equipment')).body;
    assert.equal(list.find(i => i.id === ids.flasche).bild_id, ids.bild);
    assert.equal((await admin.del(`/api/bilder/${ids.bild}`)).status, 200);
    assert.equal((await admin.get(`/api/bilder/${ids.bild}`)).status, 404);
});

test('Kommentare: jeder darf schreiben, nur eigene löschen', async () => {
    const c = await admin.post(`/api/equipment/${ids.lampe}/kommentare`, { text: 'Akku schwach' });
    assert.equal(c.status, 201);
    assert.equal((await helfer.del(`/api/kommentare/${c.body.id}`)).status, 403);
    const own = await helfer.post(`/api/equipment/${ids.lampe}/kommentare`, { text: 'Stimmt' });
    assert.equal((await helfer.del(`/api/kommentare/${own.body.id}`)).status, 200);
    assert.equal((await admin.del(`/api/kommentare/${c.body.id}`)).status, 200);
    assert.equal((await admin.post(`/api/equipment/${ids.lampe}/kommentare`, { text: '   ' })).status, 400);
});

test('QR-Code fürs Etikett', async () => {
    const r = await admin.get(`/api/equipment/${ids.lampe}/qr.svg`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(r.body.toString(), /<svg/);
    const QR = require('qrcode');
    const expected = await QR.toString(`${srv.base.replace('http://', 'http://')}/#nr/6001`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    assert.equal(r.body.toString(), expected, 'QR enthält die Inventarnummer, nicht die interne ID');
});

test('Inventarnummern: kleinste freie Nummer wird wiederverwendet, Kategoriewechsel vergibt neue Nummer', async () => {
    const neu = async (name, kat = ids.flaschen) => (await admin.post('/api/equipment', { name, kategorie_id: kat })).body;
    const x = await neu('Flasche X');
    assert.equal(x.deviceId, '1003');
    const y = await neu('Flasche Y');
    assert.equal(y.deviceId, '1004');
    await admin.del(`/api/equipment/${x.id}`);
    assert.equal((await neu('Flasche Z')).deviceId, '1003', 'Lücke wird wiederverwendet');

    const item = (await admin.get(`/api/equipment/${y.id}`)).body;
    assert.equal((await admin.put(`/api/equipment/${y.id}`, { ...item, kategorie_id: ids.lampen })).status, 200);
    const moved = (await admin.get(`/api/equipment/${y.id}`)).body;
    assert.equal(moved.deviceId, '6002');
    assert.match(moved.aktivitaeten[0].details, /Inventarnummer: 1004 → 6002/);
    assert.equal((await neu('Flasche W')).deviceId, '1004', 'alte Nummer ist wieder frei');
});

test('Admin-Regeln: Ernennen, letzter Admin, neues Passwort meldet ab', async () => {
    assert.equal((await admin.put(`/api/users/${ids.helfer}`, { username: 'helfer', email: 'helfer@example.de', rolle: 'admin' })).status, 200);
    assert.equal((await helfer.get('/api/me')).body.role, 'admin');

    const me = (await admin.get('/api/me')).body;
    assert.equal((await admin.del(`/api/users/${me.id}`)).status, 400, 'Selbstlöschung');

    // Admin setzt dem Helfer ein neues Passwort -> dessen Sitzung endet
    assert.equal((await admin.put(`/api/users/${ids.helfer}`, { username: 'helfer', email: 'helfer@example.de', rolle: 'admin', password: 'neuespasswort' })).status, 200);
    assert.equal((await helfer.get('/api/me')).status, 401);
    assert.equal((await helfer.post('/api/login', { username: 'helfer', password: 'neuespasswort' })).status, 200);

    // Eigenes Passwort ändern: andere Sitzungen enden, die eigene bleibt
    const zweitesGeraet = client(srv.base);
    await zweitesGeraet.post('/api/login', { username: 'chef', password: 'geheim123' });
    assert.equal((await admin.put('/api/me/password', { oldPassword: 'falsch', newPassword: 'geheim456' })).status, 400);
    assert.equal((await admin.put('/api/me/password', { oldPassword: 'geheim123', newPassword: 'geheim456' })).status, 200);
    assert.equal((await admin.get('/api/me')).status, 200);
    assert.equal((await zweitesGeraet.get('/api/me')).status, 401);
});

test('Aktivitätsprotokoll und Vereinsname', async () => {
    assert.equal((await admin.put('/api/verein', { name: 'TC Nord e.V.' })).status, 200);
    assert.equal((await admin.get('/api/me')).body.verein.name, 'TC Nord e.V.');
    const log = (await admin.get('/api/aktivitaeten')).body;
    assert.ok(log.length > 5);
    assert.ok(log.some(a => a.aktion === 'ausgeliehen' && a.equipment_name));
});

test('Löschen eines Geräts entfernt Bilder, Protokoll bleibt', async () => {
    const up = await admin.post(`/api/equipment/${ids.lampe}/bilder`, JPEG);
    assert.equal(up.status, 201);
    assert.equal((await admin.del(`/api/equipment/${ids.lampe}`)).status, 200);
    assert.equal(srv.db.prepare(`SELECT COUNT(*) c FROM bilder`).get().c, 0);
    assert.ok((await admin.get('/api/aktivitaeten')).body.some(a => a.aktion === 'geloescht' && /Taschenlampe/.test(a.details)));
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(require('fs').readdirSync(srv.config.uploadDir), []);
});

test('Login-Bremse nach 10 Fehlversuchen', async () => {
    const c = client(srv.base);
    for (let i = 0; i < 10; i++) await c.post('/api/login', { username: 'chef', password: 'falsch' + i });
    const r = await c.post('/api/login', { username: 'chef', password: 'geheim456' });
    assert.equal(r.status, 429);
});

test('Die letzte Kategorie kann nicht gelöscht werden', async () => {
    for (const i of (await admin.get('/api/equipment')).body) await admin.del(`/api/equipment/${i.id}`);
    const kats = (await admin.get('/api/kategorien')).body;
    for (const k of kats.slice(1)) assert.equal((await admin.del(`/api/kategorien/${k.id}`)).status, 200);
    const r = await admin.del(`/api/kategorien/${kats[0].id}`);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Mindestens eine Kategorie/);
});

test('Vereinslogo und -farbe', async () => {
    assert.equal((await admin.put('/api/verein', { name: 'TC Nord e.V.', farbe: 'rot' })).status, 400);
    assert.equal((await admin.put('/api/verein', { name: 'TC Nord e.V.', farbe: '#E11D48' })).status, 200);
    assert.equal((await admin.post('/api/verein/logo', Buffer.from('<svg/>'))).status, 400);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    assert.equal((await admin.post('/api/verein/logo', png)).status, 201);
    const me = (await admin.get('/api/me')).body;
    assert.equal(me.verein.farbe, '#e11d48');
    assert.match(me.verein.logo, /^\/api\/verein\/logo\?v=logo-/);
    const logo = await admin.get(me.verein.logo);
    assert.equal(logo.headers.get('content-type'), 'image/png');
    assert.deepEqual(logo.body, png);

    // Login-Seite (nicht angemeldet) bekommt Name, Farbe und Logo
    const anon = client(srv.base);
    const b = (await anon.get('/api/branding')).body;
    assert.equal(b.name, 'TC Nord e.V.');
    assert.equal(b.farbe, '#e11d48');
    assert.deepEqual((await anon.get(b.logo)).body, png);

    assert.equal((await admin.del('/api/verein/logo')).status, 200);
    assert.equal((await admin.get('/api/me')).body.verein.logo, null);
    assert.equal((await anon.get('/api/branding/logo')).status, 404);
});
