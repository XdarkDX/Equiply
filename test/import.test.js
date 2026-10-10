const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { startServer, client } = require('./helpers');
const { parseDate, parseCsv, matchHeader } = require('../src/importer');

test('Datumsformate werden erkannt', () => {
    assert.deepEqual(parseDate('31.12.2027', 'tuev'), { iso: '2027-12-31' });
    assert.deepEqual(parseDate('1.2.27', 'tuev'), { iso: '2027-02-01' });
    assert.deepEqual(parseDate('2027-05-03', 'tuev'), { iso: '2027-05-03' });
    assert.equal(parseDate('05/2027', 'tuev').iso, '2027-05-31', 'TÜV Monat/Jahr = Monatsende');
    assert.equal(parseDate('02/2028', 'tuev').iso, '2028-02-29', 'Schaltjahr');
    assert.equal(parseDate(new Date(Date.UTC(2026, 0, 15)), 'tuev').iso, '2026-01-15');
    assert.equal(parseDate(46037, 'tuev').iso, '2026-01-15', 'Excel-Seriennummer');
    assert.ok(parseDate('31.02.2027', 'tuev').fehler);
    assert.ok(parseDate('irgendwann', 'tuev').fehler);
    assert.deepEqual(parseDate(null, 'tuev'), { iso: null });
});

test('Spaltenüberschriften werden zugeordnet', () => {
    assert.equal(matchHeader('Nächster TÜV'), 'tuev');
    assert.equal(matchHeader('TÜV-Datum'), 'tuev');
    assert.equal(matchHeader('Inv.-Nr.'), 'code');
    assert.equal(matchHeader('Code'), 'code');
    assert.equal(matchHeader('QR-Code'), 'code');
    assert.equal(matchHeader('Seriennummer'), 'seriennummer');
    assert.equal(matchHeader('Gerät'), 'name');
    assert.equal(matchHeader('Standort'), 'lagerort');
    assert.equal(matchHeader('Foo'), null);
});

test('CSV mit Semikolon, Anführungszeichen und Zeilenumbruch', () => {
    const rows = parseCsv('Bezeichnung;Notizen\r\n"Flasche ""rot""";"Zeile 1\nZeile 2"\r\n;\r\nLampe;\r\n');
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[1].values, ['Flasche "rot"', 'Zeile 1\nZeile 2']);
    assert.deepEqual(rows[2].values, ['Lampe', null]);
});

let srv, admin;
before(async () => {
    srv = await startServer();
    admin = client(srv.base);
    await admin.post('/api/setup', { vereinName: 'Import-Club', username: 'chef', email: 'chef@example.de', password: 'geheim123' });
});
after(() => srv.close());

async function xlsx(rows) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Tabelle1');
    rows.forEach(r => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
}

test('Excel-Import: Vorschau erkennt Spalten, Kategorien, Fehler – erst Übernehmen speichert', async () => {
    const file = await xlsx([
        ['Meine Geräteliste'],
        ['Gerät', 'Typ', 'Hersteller', 'SN', 'Nächster TÜV', 'Zustand', 'Bemerkung', 'Irgendwas'],
        ['Flasche 12L', 'Flasche', 'Faber', 'A-1', '05/2027', 'gut', 'neu gekauft', 'x'],
        ['Regler Apeks', 'Atemregler', 'Apeks', 'R-7', new Date(Date.UTC(2026, 5, 30)), 'leichte Mängel', null, null],
        ['Tauchlampe', 'Lampen', null, null, null, 'kaputt', null, null],
        [null, 'Blei', null, null, null, null, null, null],
        [],
        ['Weste', 'BCD', null, null, 'nächstes Jahr', null, null, null],
    ]);
    const r = await admin.post('/api/import/vorschau', file);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const p = r.body;
    assert.equal(p.spalten.name, 'Gerät');
    assert.equal(p.spalten.tuev, 'Nächster TÜV');
    assert.deepEqual(p.ignoriert, ['Irgendwas']);
    assert.deepEqual(p.neueKategorien, ['Lampen']);
    assert.equal(p.zeilen.length, 5);

    const [flasche, regler, lampe, ohneName, weste] = p.zeilen;
    assert.equal(flasche.daten.kategorie, 'Flaschen');
    assert.equal(flasche.daten.tuev, '2027-05-31');
    assert.equal(flasche.daten.condition, 'Gut');
    assert.equal(regler.daten.tuev, '2026-06-30');
    assert.equal(regler.daten.condition, 'Gebrauchsspuren');
    assert.equal(lampe.daten.condition, 'Reparaturbedürftig');
    assert.equal(ohneName.aktion, 'fehler');
    assert.equal(weste.daten.kategorie, 'Jackets');
    assert.equal(weste.aktion, 'fehler');
    assert.equal((await admin.get('/api/equipment')).body.length, 0, 'Vorschau speichert nichts');

    const ok = p.zeilen.filter(z => z.aktion !== 'fehler');
    const imp = await admin.post('/api/import', { zeilen: ok });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.neu, 3);
    assert.deepEqual(imp.body.neueKategorien, ['Lampen']);

    const items = (await admin.get('/api/equipment')).body;
    assert.ok(items.every(i => i.code === null), 'importierte Geräte haben noch keinen QR-Code');
    assert.deepEqual(items.map(i => i.kennung.replace(/NEU\d+$/, 'NEU')).sort(), ['AT-NEU', 'FL-NEU', 'LA-NEU'], 'Platzhalter mit Kategorie-Kürzel');
    assert.equal(items.find(i => i.name === 'Flasche 12L').seriennummer, 'A-1');
});

test('Re-Import: vorhandene Codes und Platzhalter werden aktualisiert, leere Felder bleiben', async () => {
    const items0 = (await admin.get('/api/equipment')).body;
    const fl = items0.find(i => i.name === 'Flasche 12L');
    fl.code = (await admin.put(`/api/equipment/${fl.id}/qr`, { neu: true })).body.code;
    const regler = items0.find(i => i.category === 'Atemregler');
    const file = await xlsx([
        ['Code', 'Bezeichnung', 'Lagerort', 'Hersteller'],
        [`${fl.code.slice(0, 2)}-${fl.code.slice(2)}`.toLowerCase(), 'Flasche 12L Stahl', 'Keller', null],
        [regler.kennung.toLowerCase(), null, 'Schrank 2', null],
        ['1001', 'Neue Flasche', null, null],
    ]);
    const p = (await admin.post('/api/import/vorschau', file)).body;
    assert.equal(p.spalten.code, 'Code');
    assert.deepEqual(p.zeilen.map(z => z.aktion), ['aktualisieren', 'aktualisieren', 'neu']);
    assert.match(p.zeilen[2].hinweise.join(), /Platzhalter/, 'alte Zahlen-Nummer ist kein gültiger Code');
    const imp = (await admin.post('/api/import', { zeilen: p.zeilen })).body;
    assert.equal(imp.aktualisiert, 2);
    assert.equal(imp.neu, 1);
    assert.equal((await admin.get(`/api/equipment/${regler.id}`)).body.lagerort, 'Schrank 2', 'über den Platzhalter gefunden');

    const items = (await admin.get('/api/equipment')).body;
    const f = items.find(i => i.id === fl.id);
    assert.equal(f.name, 'Flasche 12L Stahl');
    assert.equal(f.lagerort, 'Keller');
    assert.equal(f.hersteller, 'Faber', 'leere Zelle überschreibt nicht');
    assert.equal(f.category, 'Flaschen', 'Kategorie bleibt');
    assert.equal(f.code, fl.code, 'Code bleibt');
    const neu = items.find(i => i.name === 'Neue Flasche');
    assert.equal(neu.category, 'Sonstiges');
    assert.equal(neu.code, null);
    assert.match(neu.kennung, /^SO-NEU\d+$/);

    const skip = (await admin.post('/api/import', { zeilen: p.zeilen.slice(0, 1), aktualisieren: false })).body;
    assert.equal(skip.uebersprungen, 1);
});

test('CSV-Import aus deutschem Excel (Windows-1252, Semikolon)', async () => {
    const csv = Buffer.from('Bezeichnung;Größe;TÜV\r\nJacket groß;XL;31.12.2028\r\n', 'latin1');
    const p = (await admin.post('/api/import/vorschau', csv)).body;
    assert.equal(p.zeilen[0].daten.name, 'Jacket groß');
    assert.equal(p.zeilen[0].daten.groesse, 'XL');
    assert.equal(p.zeilen[0].daten.tuev, '2028-12-31');
});

test('Ungültige Dateien geben verständliche Fehler', async () => {
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    assert.match((await admin.post('/api/import/vorschau', xls)).body.error, /\.xlsx/);
    assert.match((await admin.post('/api/import/vorschau', Buffer.from('a;b\n1;2'))).body.error, /Bezeichnung/);
    const imp = await admin.post('/api/import', { zeilen: [{ zeile: 2, daten: { name: 'X', tuev: '2027-99-99' } }, { zeile: 3, daten: { name: '' } }] });
    assert.equal(imp.body.neu, 0);
    assert.equal(imp.body.fehler.length, 2);
});

test('Export und Vorlage sind gültige Excel-Dateien und wieder importierbar', async () => {
    const exp = await admin.get('/api/export/inventar.xlsx');
    assert.equal(exp.status, 200);
    assert.match(exp.headers.get('content-disposition'), /equiply-inventar-.*\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(exp.body);
    const ws = wb.getWorksheet('Inventar');
    assert.equal(ws.getRow(1).getCell(1).value, 'Code');
    const codes = [];
    ws.eachRow((row, i) => { if (i > 1) codes.push(row.getCell(1).value); });
    assert.ok(codes.every(c => /^[A-Z]{2}-([0-9A-Z]{4}|NEU\d+)$/.test(c)), `Code mit Bindestrich oder Platzhalter: ${codes}`);
    assert.ok(codes.some(c => /NEU/.test(c)) && codes.some(c => !/NEU/.test(c)));
    assert.equal(ws.actualRowCount, 1 + (await admin.get('/api/equipment')).body.length);

    // Export direkt wieder importieren -> alles wird als "aktualisieren" erkannt
    const p = (await admin.post('/api/import/vorschau', exp.body)).body;
    assert.ok(p.zeilen.every(z => z.aktion === 'aktualisieren'), JSON.stringify(p.zeilen.filter(z => z.aktion !== 'aktualisieren')));
    const again = (await admin.post('/api/import', { zeilen: p.zeilen })).body;
    assert.equal(again.aktualisiert, 0, 'nichts geändert');

    const vorlage = await admin.get('/api/import/vorlage.xlsx');
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(vorlage.body);
    assert.deepEqual(wb2.worksheets.map(w => w.name), ['Inventar', 'Hinweise']);
});

test('Re-Import mit geänderter Kategorie: neuer Code, alter Code bleibt gültig; Vorrats-Code wird übernommen', async () => {
    const items = (await admin.get('/api/equipment')).body;
    const f = items.find(i => i.name === 'Flasche 12L Stahl');
    const kats = (await admin.get('/api/kategorien')).body;
    const blei = kats.find(k => k.name === 'Blei');
    const vorrat = (await admin.post('/api/qr/frei', { anzahl: 1, kategorie_id: blei.id })).body.codes[0];
    const file = await xlsx([
        ['Code', 'Bezeichnung', 'Kategorie'],
        [f.code, 'Flasche umsortiert', 'Sonstiges'],
        [vorrat, 'Gerät mit vorgelasertem Schild', 'Blei'],
        [vorrat, 'Doppelt', 'Blei'],
    ]);
    const p = (await admin.post('/api/import/vorschau', file)).body;
    assert.deepEqual(p.zeilen.map(z => z.aktion), ['aktualisieren', 'neu', 'fehler']);
    const r = (await admin.post('/api/import', { zeilen: p.zeilen.filter(z => z.aktion !== 'fehler') })).body;
    assert.equal(r.aktualisiert, 1);
    assert.equal(r.neu, 1);
    const after = (await admin.get('/api/equipment')).body;
    const moved = after.find(i => i.id === f.id);
    assert.equal(moved.category, 'Sonstiges');
    assert.equal(moved.code, 'SO' + f.code.slice(2), 'neues Kürzel, gleicher Zufallsteil');
    assert.equal(after.find(i => i.name === 'Gerät mit vorgelasertem Schild').code, vorrat);
    // Nochmal mit altem Code importieren -> wird über den alten Code gefunden
    const p2 = (await admin.post('/api/import/vorschau', await xlsx([['Code', 'Bezeichnung'], [f.code, 'Flasche umsortiert']]))).body;
    assert.equal(p2.zeilen[0].aktion, 'aktualisieren');
});
