'use strict';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// FL7K3X -> FL-7K3X
const fmtCode = (code) => /^[A-Z]{2,3}[0-9A-Z]{4}$/.test(code) ? `${code.slice(0, -4)}-${code.slice(-4)}` : code;

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

    // Freie Codes (Vorrat, z. B. zum Vorab-Lasern) – die Kategorie ergibt sich aus dem Kürzel
    if (params.get('codes')) {
        const codes = params.get('codes').split(',').filter(c => /^[0-9A-Z]{4,12}$/.test(c));
        const kategorien = await (await fetch('/api/kategorien')).json();
        const kategorie = (code) => (kategorien.find(k => k.prefix === code.slice(0, -4)) || {}).name || '';
        info.textContent = `${codes.length} freie QR-Code${codes.length === 1 ? '' : 's'} für ${me.verein.name}`;
        sheet.innerHTML = codes.map(code => `
            <div class="label-item">
                <img src="/api/qr/${code}/svg" alt="">
                <div class="min-w-0 leading-tight">
                    ${brand(me)}
                    <div class="font-mono font-extrabold text-[13pt] whitespace-nowrap">${esc(fmtCode(code))}</div>
                    <div class="text-[7pt] text-slate-500 truncate">${esc(kategorie(code))}</div>
                </div>
            </div>`).join('');
        return;
    }

    const ids = new Set((params.get('ids') || '').split(',').map(Number).filter(Boolean));
    const chosen = (await (await fetch('/api/equipment')).json()).filter(i => ids.has(i.id));
    const items = chosen.filter(i => i.code); // nur Geräte, denen ein QR-Code zugewiesen ist
    const ohne = chosen.length - items.length;
    info.textContent = `${items.length} Etikett${items.length === 1 ? '' : 'en'} für ${me.verein.name}`
        + (ohne ? ` – ${ohne} Gerät${ohne === 1 ? '' : 'e'} ohne QR-Code übersprungen` : '');
    sheet.innerHTML = items.map(i => `
        <div class="label-item">
            <img src="/api/equipment/${i.id}/qr.svg" alt="">
            <div class="min-w-0 leading-tight">
                ${brand(me)}
                <div class="font-mono font-extrabold text-[13pt] whitespace-nowrap">${esc(fmtCode(i.code))}</div>
                <div class="font-bold text-[9pt] line-clamp-2 break-words">${esc(i.name)}</div>
                <div class="text-[7pt] text-slate-500 truncate">${esc(i.category)}</div>
            </div>
        </div>`).join('');
}

document.getElementById('print').addEventListener('click', () => window.print());
load().catch(e => { document.getElementById('info').textContent = 'Fehler: ' + e.message; });
