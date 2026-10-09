const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');

async function startServer(overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equiply-test-'));
    const config = { jwtSecret: 'test-secret', sessionDays: 1, allowRegistration: false, uploadDir: path.join(dir, 'uploads'), ...overrides };
    const db = openDatabase(':memory:');
    const server = createApp(db, config).listen(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { db, config, base, dir, close: () => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// Kleiner HTTP-Client mit Cookie-Speicher (wie ein Browser)
function client(base) {
    let cookie = '';
    async function call(method, url, body, opts = {}) {
        const headers = { ...(opts.headers || {}) };
        if (cookie) headers.Cookie = cookie;
        let payload;
        if (Buffer.isBuffer(body)) { payload = body; headers['Content-Type'] = headers['Content-Type'] || 'application/octet-stream'; }
        else if (body !== undefined && body !== null) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
        const res = await fetch(base + url, { method, headers, body: payload });
        const set = res.headers.get('set-cookie');
        if (set) {
            const m = set.match(/equiply_session=([^;]*)/);
            if (m) cookie = m[1] ? `equiply_session=${m[1]}` : '';
        }
        const type = res.headers.get('content-type') || '';
        const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
        return { status: res.status, body: data, headers: res.headers };
    }
    return {
        get: (u, o) => call('GET', u, null, o),
        post: (u, b, o) => call('POST', u, b, o),
        put: (u, b, o) => call('PUT', u, b, o),
        del: (u, o) => call('DELETE', u, null, o),
        get cookie() { return cookie; },
    };
}

module.exports = { startServer, client };
