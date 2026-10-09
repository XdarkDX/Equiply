'use strict';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
    const ids = new Set((new URLSearchParams(location.search).get('ids') || '').split(',').map(Number).filter(Boolean));
    const [meRes, itemsRes] = await Promise.all([fetch('/api/me'), fetch('/api/equipment')]);
    if (meRes.status === 401) { location.href = '/'; return; }
    const me = await meRes.json();
    const items = (await itemsRes.json()).filter(i => ids.has(i.id));
    document.getElementById('info').textContent = `${items.length} Etikett${items.length === 1 ? '' : 'en'} für ${me.verein.name}`;
    document.getElementById('sheet').innerHTML = items.map(i => `
        <div class="label-item">
            <img src="/api/equipment/${i.id}/qr.svg" alt="">
            <div class="min-w-0 leading-tight">
                ${me.verein.logo ? `<img src="${esc(me.verein.logo)}" alt="" class="label-logo">` : `<div class="text-[7pt] text-slate-500 truncate">${esc(me.verein.name)}</div>`}
                <div class="font-mono font-extrabold text-[16pt]">${esc(i.deviceId)}</div>
                <div class="font-bold text-[9pt] line-clamp-2 break-words">${esc(i.name)}</div>
                <div class="text-[7pt] text-slate-500 truncate">${esc(i.category)}${i.seriennummer ? ` · SN ${esc(i.seriennummer)}` : ''}</div>
            </div>
        </div>`).join('');
}

document.getElementById('print').addEventListener('click', () => window.print());
load().catch(e => { document.getElementById('info').textContent = 'Fehler: ' + e.message; });
