'use strict';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function brand(me) {
    return `<div class="text-[7pt] text-slate-500 truncate">${esc(me.verein.name)}</div>`;
}

async function load() {
    const params = new URLSearchParams(location.search);
    const meRes = await fetch('/api/me');
    if (meRes.status === 401) { location.href = '/'; return; }
    const me = await meRes.json();
    const sheet = document.getElementById('sheet');
    const info = document.getElementById('info');

    // Freie Codes (Vorrat, z. B. zum Vorab-Lasern)
    if (params.get('codes')) {
        const codes = params.get('codes').split(',').filter(c => /^[0-9A-Z]{4,12}$/.test(c));
        info.textContent = `${codes.length} freie QR-Code${codes.length === 1 ? '' : 's'} für ${me.verein.name}`;
        sheet.innerHTML = codes.map(code => `
            <div class="label-item">
                <img src="/api/qr/${code}/svg" alt="">
                <div class="min-w-0 leading-tight">
                    ${brand(me)}
                    <div class="font-mono font-extrabold text-[15pt] tracking-wider">${code}</div>
                    <div class="text-[7pt] text-slate-500">Equiply QR-Code</div>
                </div>
            </div>`).join('');
        return;
    }

    const ids = new Set((params.get('ids') || '').split(',').map(Number).filter(Boolean));
    const items = (await (await fetch('/api/equipment')).json()).filter(i => ids.has(i.id));
    info.textContent = `${items.length} Etikett${items.length === 1 ? '' : 'en'} für ${me.verein.name}`;
    sheet.innerHTML = items.map(i => `
        <div class="label-item">
            <img src="/api/qr/${esc(i.qr_code)}/svg" alt="">
            <div class="min-w-0 leading-tight">
                ${brand(me)}
                <div class="font-mono font-extrabold text-[16pt]">${esc(i.deviceId)}</div>
                <div class="font-bold text-[9pt] line-clamp-2 break-words">${esc(i.name)}</div>
                <div class="text-[7pt] text-slate-500 truncate">${esc(i.category)}</div>
            </div>
        </div>`).join('');
}

document.getElementById('print').addEventListener('click', () => window.print());
load().catch(e => { document.getElementById('info').textContent = 'Fehler: ' + e.message; });
