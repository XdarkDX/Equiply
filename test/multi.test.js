const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client } = require('./helpers');

let srv;
before(async () => { srv = await startServer({ allowRegistration: true }); });
after(() => srv.close());

test('Mit ALLOW_REGISTRATION=true sind mehrere Vereine strikt getrennt', async () => {
    const nord = client(srv.base), sued = client(srv.base);
    assert.equal((await nord.post('/api/setup', { vereinName: 'Nord', username: 'nord', email: 'nord@example.de', password: 'geheim123' })).status, 201);
    assert.equal((await sued.post('/api/setup', { vereinName: 'nord', username: 'x', email: 'x@example.de', password: 'geheim123' })).status, 409);
    assert.equal((await sued.post('/api/setup', { vereinName: 'Süd', username: 'sued', email: 'sued@example.de', password: 'geheim123' })).status, 201);
    assert.equal(srv.db.prepare(`SELECT COUNT(*) c FROM vereine`).get().c, 2);

    const katNord = (await nord.get('/api/kategorien')).body[0].id;
    const item = (await nord.post('/api/equipment', { name: 'Flasche', kategorie_id: katNord })).body;
    const bild = (await nord.post(`/api/equipment/${item.id}/bilder`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).body;

    assert.equal((await sued.get('/api/equipment')).body.length, 0);
    assert.equal((await sued.get(`/api/equipment/${item.id}`)).status, 404);
    assert.equal((await sued.del(`/api/equipment/${item.id}`)).status, 404);
    assert.equal((await sued.get(`/api/bilder/${bild.id}`)).status, 404);
    assert.equal((await sued.post('/api/equipment', { name: 'X', kategorie_id: katNord })).status, 400, 'fremde Kategorie');
    assert.equal((await sued.post(`/api/equipment/${item.id}/kommentare`, { text: 'hi' })).status, 404);
});
