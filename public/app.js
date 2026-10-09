'use strict';

// =====================================================================
// Hilfsfunktionen
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
    me: null,
    items: [],
    kategorien: [],
    filter: { kategorie: null, status: '', search: '' },
    view: storageGet('equiply_view') || 'grid',
    detail: null,
    detailTab: 'kommentare',
    detailImage: 0,
    settingsTab: null,
    importPreview: null,
};

function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* privat */ } }

function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function today(offsetDays = 0) {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDate(iso) {
    if (!iso) return '–';
    const [y, m, d] = iso.slice(0, 10).split('-');
    return `${d}.${m}.${y}`;
}
function fmtDateTime(ts) {
    if (!ts) return '–';
    return new Date(ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function daysUntil(iso) {
    return Math.round((new Date(iso + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
}
function tuevStatus(iso) {
    if (!iso) return 'none';
    if (iso < today()) return 'expired';
    return daysUntil(iso) <= 90 ? 'warning' : 'ok';
}
const isBorrowed = (i) => i.status === 'Ausgeliehen';
const isOverdue = (i) => isBorrowed(i) && i.returnDate && i.returnDate < today();
const isBroken = (i) => i.condition === 'Reparaturbedürftig';
const can = (perm) => !!(state.me && state.me.permissions[perm]);
const CONDITION_LABEL = { Gut: 'Einwandfrei', Gebrauchsspuren: 'Leichte Mängel', Reparaturbedürftig: 'Defekt' };

// ---------- Vereinsfarbe ----------
const DEFAULT_COLOR = '#0284c7';
const hexToRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbToHex = (c) => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
function luminance(rgb) {
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
// Setzt die Akzentfarbe der ganzen Oberfläche. Zu helle Farben werden abgedunkelt, damit weiße Schrift lesbar bleibt.
function applyTheme(hex) {
    let base = hexToRgb(/^#[0-9a-f]{6}$/i.test(hex || '') ? hex : DEFAULT_COLOR);
    while (luminance(base) > 0.22) base = base.map(v => Math.round(v * 0.92));
    const tief = base.map(v => Math.round(v * 0.8));
    const leicht = base.map(v => Math.round(v * 0.12 + 255 * 0.88));
    const root = document.documentElement.style;
    root.setProperty('--ozean-normal', base.join(' '));
    root.setProperty('--ozean-tief', tief.join(' '));
    root.setProperty('--ozean-leicht', leicht.join(' '));
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = rgbToHex(tief);
}
// Häufigste kräftige Farbe eines Logos (ignoriert Weiß, Grau, Schwarz und Transparenz)
async function dominantColor(blob) {
    try {
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = c.height = 48;
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0, 48, 48);
        const d = ctx.getImageData(0, 0, 48, 48).data;
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
            const [r, g, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (a < 128 || max < 40 || (max - min) / max < 0.3) continue;
            const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
            const w = (max - min) / max;
            const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
            e.n += w; e.r += r * w; e.g += g * w; e.b += b * w;
            buckets.set(key, e);
        }
        const best = [...buckets.values()].sort((x, y) => y.n - x.n)[0];
        return best ? rgbToHex([best.r, best.g, best.b].map(v => Math.round(v / best.n))) : null;
    } catch (e) { return null; }
}
// Logo auf max. 512 px verkleinern, Transparenz bleibt erhalten (PNG)
async function prepareLogo(file) {
    try {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.round(bmp.width * scale);
        c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        const blob = await new Promise(r => c.toBlob(r, 'image/png'));
        if (blob) return blob;
    } catch (e) { /* nicht lesbar */ }
    throw new Error('Das Logo muss ein Bild sein (PNG, JPG oder WebP).');
}
function applyBranding(verein) {
    applyTheme(verein && verein.farbe);
    const logo = verein && verein.logo;
    $('#brand-logo').hidden = !logo;
    $('#brand-icon').hidden = !!logo;
    if (logo) $('#brand-logo').src = logo;
    $('#brand-title').textContent = logo ? verein.name : 'Equiply';
    $('#verein-name').textContent = logo ? 'Equiply' : (verein ? verein.name : '');
}

const ICON = {
    edit: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>',
    trash: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>',
    camera: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
    comment: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg>',
    image: '<svg class="w-10 h-10" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    user: '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>',
    calendar: '<svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
    qr: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/></svg>',
    check: '<svg class="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>',
    cross: '<svg class="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>',
    save: '<svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>',
};

// ---------- Server-Anfragen ----------
class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body, raw, quiet401 = false } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (raw) { opts.body = raw; opts.headers['Content-Type'] = raw.type || 'application/octet-stream'; }
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    let res;
    try { res = await fetch('/api' + path, opts); } catch (e) { throw new ApiError(0, 'Keine Verbindung zum Server. Bitte Internetverbindung prüfen.'); }
    let data = null;
    if ((res.headers.get('content-type') || '').includes('json')) data = await res.json();
    if (res.status === 401 && !quiet401 && state.me) {
        state.me = null;
        showAuth('login', (data && data.error) || 'Bitte erneut anmelden.');
    }
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Fehler ${res.status}`);
    return data;
}

// ---------- Meldungen & Dialoge ----------
function toast(message, type = 'success') {
    const colors = { success: 'bg-slate-900 text-white', error: 'bg-red-600 text-white', info: 'bg-ozean-tief text-white' };
    const el = document.createElement('div');
    el.className = `pointer-events-auto px-4 py-3 rounded-xl shadow-xl text-sm font-medium w-full text-center transition-opacity duration-300 ${colors[type] || colors.success}`;
    el.textContent = message;
    $('#toasts').appendChild(el);
    setTimeout(() => { el.classList.add('opacity-0'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 5000 : 2800);
}
const showError = (e) => toast(e.message || String(e), 'error');

function confirmDialog(text, yes = 'Ja, löschen') {
    return new Promise(resolve => {
        $('#confirm-text').textContent = text;
        $('#confirm-yes').textContent = yes;
        openModal('confirm-modal');
        const done = (v) => { closeModal('confirm-modal'); $('#confirm-yes').onclick = $('#confirm-no').onclick = null; resolve(v); };
        $('#confirm-yes').onclick = () => done(true);
        $('#confirm-no').onclick = () => done(false);
    });
}

const modalStack = [];
function openModal(id) {
    const el = document.getElementById(id);
    el.hidden = false;
    if (!modalStack.includes(id)) modalStack.push(id);
    document.body.classList.add('overflow-hidden');
    const first = el.querySelector('input:not([type=hidden]):not([disabled]), textarea, select');
    if (first && window.matchMedia('(min-width: 768px)').matches) setTimeout(() => first.focus(), 30);
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = true;
    const i = modalStack.indexOf(id);
    if (i >= 0) modalStack.splice(i, 1);
    if (!modalStack.length) document.body.classList.remove('overflow-hidden');
    if (id === 'scan-modal') stopScanner();
    if (id === 'settings-modal' && state.me) applyTheme(state.me.verein.farbe); // ungespeicherte Farbvorschau verwerfen
    if (id === 'detail-modal') {
        state.detail = null;
        if (/^#(q|nr|geraet)\//.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
    }
}

function formValues(form) {
    const out = {};
    for (const el of form.elements) {
        if (!el.name || el.type === 'file') continue;
        out[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    return out;
}
function fillForm(form, values) {
    for (const el of form.elements) {
        if (!el.name || el.type === 'file') continue;
        if (el.type === 'checkbox') el.checked = !!values[el.name];
        else el.value = values[el.name] ?? '';
    }
}

// Bilder vor dem Hochladen verkleinern (spart Speicher und Datenvolumen, dreht Handyfotos richtig)
async function prepareImage(file) {
    if (file.type === 'image/gif' && file.size < 8 * 1024 * 1024) return file;
    try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bmp.width * scale);
        canvas.height = Math.round(bmp.height * scale);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (blob) return blob;
    } catch (e) { /* Format vom Browser nicht lesbar */ }
    if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size < 10 * 1024 * 1024) return file;
    throw new Error(`„${file.name}“ ist kein unterstütztes Bild (JPG, PNG, WebP).`);
}

async function uploadImages(itemId, files) {
    let ok = 0;
    for (const file of files) {
        try {
            await api(`/equipment/${itemId}/bilder`, { method: 'POST', raw: await prepareImage(file) });
            ok++;
        } catch (e) { showError(e); }
    }
    return ok;
}

// =====================================================================
// Start, Login, Ersteinrichtung
// =====================================================================
async function boot() {
    try {
        const [setup, branding] = await Promise.all([api('/setup'), api('/branding').catch(() => ({}))]);
        state.setup = setup;
        if (branding.name) {
            applyTheme(branding.farbe);
            $('#auth-title').textContent = branding.name;
            $('#auth-subtitle').textContent = 'Equipment-Verwaltung mit Equiply';
            if (branding.logo) { $('#auth-logo').src = branding.logo; $('#auth-logo').hidden = false; $('#auth-icon').hidden = true; }
        }
        $('#app-version').textContent = setup.version ? `v${setup.version}` : '';
        if (setup.einrichtung) return showAuth('setup');
        try {
            state.me = await api('/me', { quiet401: true });
            await startApp();
        } catch (e) {
            if (e.status === 401) showAuth('login'); else throw e;
        }
    } catch (e) {
        showAuth('login', e.message);
    } finally {
        $('#loading').hidden = true;
    }
}

function showAuth(mode, message) {
    for (const id of [...modalStack]) closeModal(id);
    $('#app-view').hidden = true;
    $('#auth-view').hidden = false;
    $('#form-login').hidden = mode !== 'login';
    $('#form-setup').hidden = mode !== 'setup';
    const firstRun = state.setup && state.setup.einrichtung;
    $('#register-link').hidden = !(state.setup && state.setup.registrierung) || firstRun;
    $('#login-link').hidden = firstRun;
    $('#setup-title').textContent = firstRun ? 'Willkommen! Richte deinen Verein ein' : 'Neuen Verein registrieren';
    const err = $('#auth-error');
    err.hidden = !message;
    err.textContent = message || '';
}

async function startApp() {
    const me = state.me;
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    applyBranding(me.verein);
    $('#user-initial').textContent = (me.username[0] || '?').toUpperCase();
    $('#user-name').textContent = me.username;
    $('#user-role').textContent = me.role === 'admin' ? 'Admin' : 'Mitglied';
    for (const el of $$('[data-perm]')) el.hidden = !can(el.dataset.perm);
    $('#settings-btn').hidden = !(can('can_manage_users') || can('can_manage_items') || me.role === 'admin');
    await loadData();
    openFromHash();
}

async function loadData() {
    const [items, kategorien] = await Promise.all([api('/equipment'), api('/kategorien')]);
    state.items = items;
    state.kategorien = kategorien;
    if (state.filter.kategorie && !kategorien.some(k => k.id === state.filter.kategorie)) state.filter.kategorie = null;
    render();
}

// QR-Etiketten verlinken auf /q/<Code> -> #q/<Code>. Ältere Links (#nr/…, #geraet/…) funktionieren weiter.
function openFromHash() {
    if (!state.me) return;
    const q = location.hash.match(/^#q\/([0-9A-Za-z-]+)/);
    if (q) { handleCode(q[1]); return; }
    const nr = location.hash.match(/^#nr\/(.+)$/);
    if (nr) {
        const wanted = decodeURIComponent(nr[1]).toLowerCase();
        const item = state.items.find(i => i.deviceId.toLowerCase() === wanted);
        if (item) openDetail(item.id);
        else { toast(`Kein Gerät mit der Nummer ${decodeURIComponent(nr[1])} gefunden.`, 'error'); history.replaceState(null, '', location.pathname); }
        return;
    }
    const old = location.hash.match(/^#geraet\/(\d+)/);
    if (old) openDetail(Number(old[1]));
}

// =====================================================================
// Übersicht
// =====================================================================
function matchesStatus(i, status) {
    switch (status) {
        case 'verfuegbar': return !isBorrowed(i) && !isBroken(i) && tuevStatus(i.tuev) !== 'expired';
        case 'ausgeliehen': return isBorrowed(i);
        case 'ueberfaellig': return isOverdue(i);
        case 'tuev': return ['expired', 'warning'].includes(tuevStatus(i.tuev));
        case 'defekt': return isBroken(i);
        default: return true;
    }
}

function filteredItems() {
    const { kategorie, status, search } = state.filter;
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return state.items.filter(i => {
        if (kategorie && i.kategorie_id !== kategorie) return false;
        if (!matchesStatus(i, status)) return false;
        if (!words.length) return true;
        const hay = [i.name, i.deviceId, i.qr_code, i.category, i.hersteller, i.seriennummer, i.groesse, i.lagerort, i.borrower, i.notes].join(' ').toLowerCase();
        return words.every(w => hay.includes(w));
    });
}

function render() {
    renderStats();
    renderChips();
    renderInventory();
}

function renderStats() {
    const it = state.items;
    const tiles = [
        { key: '', label: 'Gesamt', n: it.length, tone: 'text-slate-800' },
        { key: 'verfuegbar', label: 'Verfügbar', n: it.filter(i => matchesStatus(i, 'verfuegbar')).length, tone: 'text-emerald-600' },
        { key: 'ausgeliehen', label: 'Ausgeliehen', n: it.filter(isBorrowed).length, tone: 'text-amber-600' },
        { key: 'ueberfaellig', label: 'Überfällig', n: it.filter(isOverdue).length, tone: 'text-red-600', alert: true },
        { key: 'tuev', label: 'TÜV fällig', n: it.filter(i => matchesStatus(i, 'tuev')).length, tone: 'text-orange-600', alert: true },
        { key: 'defekt', label: 'Defekt', n: it.filter(isBroken).length, tone: 'text-red-600', alert: true },
    ];
    $('#stats').innerHTML = tiles.map(t => {
        const active = state.filter.status === t.key;
        const ring = active ? 'border-ozean-normal ring-2 ring-ozean-normal/20' : (t.alert && t.n ? 'border-red-200 bg-red-50/40' : 'border-slate-200');
        return `<button data-action="stat" data-status="${t.key}" class="bg-white border ${ring} rounded-2xl p-3 md:p-4 text-left hover:shadow-md transition">
            <div class="text-2xl md:text-3xl font-extrabold ${t.n || !t.alert ? t.tone : 'text-slate-300'}">${t.n}</div>
            <div class="text-[11px] md:text-xs font-bold text-slate-500 uppercase tracking-wide">${t.label}</div>
        </button>`;
    }).join('');
}

function renderChips() {
    const chip = (id, label, n) => {
        const on = state.filter.kategorie === id;
        return `<button data-action="category" data-id="${id ?? ''}" class="chip ${on ? 'chip-on' : 'chip-off'}">${esc(label)}${n !== undefined ? ` <span class="${on ? 'text-white/70' : 'text-slate-400'} font-medium">${n}</span>` : ''}</button>`;
    };
    $('#category-chips').innerHTML = chip(null, 'Alle') + state.kategorien.map(k => chip(k.id, k.name, state.items.filter(i => i.kategorie_id === k.id).length)).join('');
}

function statusBadge(i) {
    if (isOverdue(i)) return '<span class="badge bg-red-100 text-red-700">Überfällig</span>';
    if (isBorrowed(i)) return '<span class="badge bg-amber-100 text-amber-700">Ausgeliehen</span>';
    if (isBroken(i)) return '<span class="badge bg-red-100 text-red-700">Defekt</span>';
    if (tuevStatus(i.tuev) === 'expired') return '<span class="badge bg-red-100 text-red-700">Gesperrt</span>';
    return '<span class="badge bg-green-100 text-green-700">Verfügbar</span>';
}
function tuevBadge(iso) {
    const s = tuevStatus(iso);
    if (s === 'expired') return '<span class="badge bg-red-500 text-white ml-2">Abgelaufen</span>';
    if (s === 'warning') return `<span class="badge bg-amber-200 text-amber-800 ml-2">in ${daysUntil(iso)} T.</span>`;
    return '';
}

// Hauptaktion eines Geräts (Ausleihen, Rückgabe, Reparatur, TÜV)
function primaryAction(i, size = 'w-full py-3') {
    if (isBorrowed(i)) {
        return can('can_borrow_return') ? `<button data-action="return" data-id="${i.id}" class="btn-dark ${size}">Rückgabe erfassen</button>` : '';
    }
    if (isBroken(i)) {
        return can('can_manage_items') ? `<button data-action="repaired" data-id="${i.id}" class="btn-success-light ${size}">Als repariert markieren</button>`
            : `<button disabled class="btn-light ${size}">Reparatur nötig</button>`;
    }
    if (tuevStatus(i.tuev) === 'expired') {
        return can('can_manage_items') ? `<button data-action="renew-tuev" data-id="${i.id}" class="btn-danger-light ${size}">TÜV erneuern</button>`
            : `<button disabled class="btn-light ${size}">TÜV abgelaufen</button>`;
    }
    return can('can_borrow_return') ? `<button data-action="borrow" data-id="${i.id}" class="btn-primary ${size}">Ausleihen</button>` : '';
}

function renderInventory() {
    const items = filteredItems();
    const total = state.items.length;
    $('#result-count').textContent = items.length === total ? `${total} Geräte` : `${items.length} von ${total} Geräten`;
    for (const b of $$('.view-btn')) b.classList.toggle('text-ozean-normal', b.dataset.view === state.view);
    const box = $('#inventory');

    if (!total) {
        box.className = '';
        box.innerHTML = `<div class="card p-10 text-center">
            <div class="text-slate-300 flex justify-center mb-3">${ICON.image}</div>
            <h3 class="font-extrabold text-lg">Noch keine Geräte erfasst</h3>
            <p class="text-slate-500 text-sm mt-1 mb-5">Lege dein erstes Gerät an oder übernimm eine vorhandene Excel-Liste.</p>
            ${can('can_manage_items') ? `<div class="flex flex-col sm:flex-row gap-3 justify-center">
                <button data-action="new-item" class="btn-primary">Gerät hinzufügen</button>
                <button data-action="open-import" class="btn-outline">Excel-Liste importieren</button></div>` : ''}
        </div>`;
        return;
    }
    if (!items.length) {
        box.className = '';
        box.innerHTML = `<div class="py-16 text-center text-slate-400 font-medium">Keine Geräte gefunden. <button data-action="reset-filter" class="text-ozean-normal font-bold hover:underline">Filter zurücksetzen</button></div>`;
        return;
    }
    if (state.view === 'list') {
        box.className = 'card overflow-x-auto';
        box.innerHTML = `<table class="w-full text-sm">
            <thead><tr class="text-left text-xs font-bold text-slate-400 uppercase tracking-wide border-b border-slate-100">
                <th class="p-3">Nr.</th><th class="p-3">Bezeichnung</th><th class="p-3 hidden md:table-cell">Kategorie</th><th class="p-3">Status</th>
                <th class="p-3 hidden lg:table-cell">Zustand</th><th class="p-3 hidden sm:table-cell">TÜV</th><th class="p-3 hidden lg:table-cell">Lagerort</th>
                <th class="p-3 hidden md:table-cell">Ausgeliehen an</th><th class="p-3"></th></tr></thead>
            <tbody class="divide-y divide-slate-100">${items.map(listRow).join('')}</tbody></table>`;
    } else {
        box.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 md:gap-5';
        box.innerHTML = items.map(card).join('');
    }
}

function card(i) {
    const broken = isBroken(i);
    return `<article data-action="open-detail" data-id="${i.id}" class="card ${broken ? 'border-red-200' : ''} overflow-hidden flex flex-col cursor-pointer hover:shadow-xl hover:-translate-y-0.5 transition duration-200">
        ${i.bild_id ? `<img src="/api/bilder/${i.bild_id}" alt="" loading="lazy" class="w-full aspect-[16/9] sm:aspect-[4/3] object-cover bg-slate-100">` : ''}
        <div class="p-4 md:p-5 flex flex-col flex-1">
            <div class="flex items-center gap-2 mb-2 flex-wrap">${statusBadge(i)}<span class="text-xs font-mono font-bold text-slate-400 tracking-widest">${esc(i.deviceId)}</span></div>
            <div class="text-[11px] font-bold text-ozean-normal uppercase tracking-wider">${esc(i.category)}</div>
            <h3 class="font-extrabold text-lg text-slate-800 leading-tight mb-3 break-words">${esc(i.name)}</h3>
            <div class="bg-slate-50 border border-slate-100 rounded-xl p-3 text-xs md:text-sm space-y-1.5 mb-3">
                <div class="flex justify-between gap-2"><span class="text-slate-500">Zustand</span><span class="font-bold ${broken ? 'text-red-600' : ''}">${CONDITION_LABEL[i.condition]}</span></div>
                <div class="flex justify-between gap-2"><span class="text-slate-500">TÜV</span><span class="font-bold flex items-center">${fmtDate(i.tuev)}${tuevBadge(i.tuev)}</span></div>
                ${i.lagerort ? `<div class="flex justify-between gap-2"><span class="text-slate-500">Lagerort</span><span class="font-bold truncate">${esc(i.lagerort)}</span></div>` : ''}
            </div>
            ${isBorrowed(i) ? `<div class="${isOverdue(i) ? 'bg-red-50 border-red-100 text-red-800' : 'bg-amber-50 border-amber-100 text-amber-800'} border rounded-xl p-3 text-xs md:text-sm mb-3 space-y-1">
                <div class="flex items-center gap-2">${ICON.user}<span class="truncate">Von: <b>${esc(i.borrower)}</b></span></div>
                <div class="flex items-center gap-2">${ICON.calendar}<span>Bis: <b>${fmtDate(i.returnDate)}</b></span></div></div>` : ''}
            <div class="mt-auto">${primaryAction(i)}</div>
            ${i.kommentare_anzahl || i.bilder_anzahl ? `<div class="flex gap-3 mt-3 text-xs text-slate-400">
                ${i.kommentare_anzahl ? `<span class="flex items-center gap-1">${ICON.comment}${i.kommentare_anzahl}</span>` : ''}
                ${i.bilder_anzahl ? `<span class="flex items-center gap-1">${ICON.camera}${i.bilder_anzahl}</span>` : ''}</div>` : ''}
        </div>
    </article>`;
}

function listRow(i) {
    return `<tr data-action="open-detail" data-id="${i.id}" class="hover:bg-slate-50 cursor-pointer">
        <td class="p-3 font-mono text-xs font-bold text-slate-500 whitespace-nowrap">${esc(i.deviceId)}</td>
        <td class="p-3"><div class="flex items-center gap-3">
            ${i.bild_id ? `<img src="/api/bilder/${i.bild_id}" alt="" loading="lazy" class="w-9 h-9 rounded-lg object-cover shrink-0 bg-slate-100">` : ''}
            <div class="min-w-0"><div class="font-bold text-slate-800">${esc(i.name)}</div>${i.hersteller ? `<div class="text-xs text-slate-400">${esc(i.hersteller)}</div>` : ''}</div></div></td>
        <td class="p-3 hidden md:table-cell text-slate-600">${esc(i.category)}</td>
        <td class="p-3">${statusBadge(i)}</td>
        <td class="p-3 hidden lg:table-cell ${isBroken(i) ? 'text-red-600 font-bold' : 'text-slate-600'}">${CONDITION_LABEL[i.condition]}</td>
        <td class="p-3 hidden sm:table-cell whitespace-nowrap">${fmtDate(i.tuev)}${tuevBadge(i.tuev)}</td>
        <td class="p-3 hidden lg:table-cell text-slate-600">${esc(i.lagerort || '')}</td>
        <td class="p-3 hidden md:table-cell text-slate-600">${isBorrowed(i) ? `${esc(i.borrower)}<div class="text-xs ${isOverdue(i) ? 'text-red-600 font-bold' : 'text-slate-400'}">bis ${fmtDate(i.returnDate)}</div>` : ''}</td>
        <td class="p-3 text-right">${primaryAction(i, 'py-1.5 px-3 text-xs')}</td>
    </tr>`;
}

// =====================================================================
// Detailansicht
// =====================================================================
async function openDetail(id, { keepTab = false } = {}) {
    try {
        const item = await api(`/equipment/${id}`);
        if (!keepTab || !state.detail || state.detail.id !== id) { state.detailTab = 'kommentare'; state.detailImage = 0; }
        state.detail = item;
        state.detailImage = Math.min(state.detailImage, Math.max(0, item.bilder.length - 1));
        renderDetail();
        if ($('#detail-modal').hidden) openModal('detail-modal');
        const hash = item.qr_code ? `#q/${item.qr_code}` : `#nr/${encodeURIComponent(item.deviceId)}`;
        if (location.hash !== hash) history.replaceState(null, '', hash);
    } catch (e) {
        showError(e);
        if (/^#(q|nr|geraet)\//.test(location.hash)) history.replaceState(null, '', location.pathname);
    }
}

async function refreshDetail() {
    if (state.detail && !$('#detail-modal').hidden) await openDetail(state.detail.id, { keepTab: true });
}

function renderDetail() {
    const i = state.detail;
    const canImages = can('can_manage_items') || can('can_borrow_return');
    const img = i.bilder[state.detailImage];
    const field = (label, value, cls = '') => value ? `<div><dt class="text-xs font-bold text-slate-400 uppercase tracking-wide">${label}</dt><dd class="font-semibold text-slate-800 ${cls}">${value}</dd></div>` : '';

    const gallery = `<div>
        ${img ? `<button data-action="lightbox" data-src="/api/bilder/${img.id}" class="block w-full"><img src="/api/bilder/${img.id}" alt="" class="w-full aspect-[4/3] object-cover rounded-xl bg-slate-100"></button>`
            : `<div class="w-full aspect-[4/3] rounded-xl bg-slate-50 border-2 border-dashed border-slate-200 flex flex-col items-center justify-center text-slate-300">${ICON.image}<span class="text-xs mt-1">Noch kein Foto</span></div>`}
        ${i.bilder.length > 1 || (img && canImages) ? `<div class="flex gap-2 mt-2 overflow-x-auto pb-1">
            ${i.bilder.map((b, n) => `<button data-action="detail-image" data-index="${n}" class="shrink-0 rounded-lg overflow-hidden border-2 ${n === state.detailImage ? 'border-ozean-normal' : 'border-transparent'}"><img src="/api/bilder/${b.id}" alt="" loading="lazy" class="w-14 h-14 object-cover"></button>`).join('')}
        </div>` : ''}
        <div class="flex gap-2 mt-2">
            ${canImages ? `<label class="btn-outline flex-1 cursor-pointer">${ICON.camera}Foto hinzufügen<input type="file" accept="image/*" multiple data-change="detail-upload" class="sr-only"></label>` : ''}
            ${img && (can('can_manage_items') || img.erstellt_von === state.me.id) ? `<button data-action="delete-image" data-id="${img.id}" class="btn-outline text-red-600" title="Dieses Foto löschen">${ICON.trash}</button>` : ''}
        </div>
    </div>`;

    const borrowedBox = isBorrowed(i) ? `<div class="${isOverdue(i) ? 'bg-red-50 border-red-200 text-red-800' : 'bg-amber-50 border-amber-200 text-amber-800'} border rounded-xl p-4 mb-5 text-sm">
        <div class="font-bold mb-1">${isOverdue(i) ? 'Rückgabe überfällig!' : 'Aktuell ausgeliehen'}</div>
        <div class="flex items-center gap-2">${ICON.user} ${esc(i.borrower)} · seit ${fmtDate(i.ausgeliehen_am)}</div>
        <div class="flex items-center gap-2">${ICON.calendar} Rückgabe geplant: ${fmtDate(i.returnDate)}</div></div>` : '';

    const actions = [
        primaryAction(i, 'py-2.5'),
        can('can_manage_items') ? `<button data-action="edit-item" data-id="${i.id}" class="btn-outline">${ICON.edit}Bearbeiten</button>` : '',
        can('can_manage_items') && tuevStatus(i.tuev) !== 'expired' && i.tuev ? `<button data-action="renew-tuev" data-id="${i.id}" class="btn-outline">TÜV erneuern</button>` : '',
        `<button data-action="show-qr" data-id="${i.id}" class="btn-outline">${ICON.qr}QR-Code</button>`,
        can('can_manage_items') ? `<button data-action="delete-item" data-id="${i.id}" class="btn-outline text-red-600" title="Gerät löschen">${ICON.trash}</button>` : '',
    ].filter(Boolean).join('');

    const tabs = [['kommentare', `Kommentare (${i.kommentare.length})`], ['ausleihen', `Ausleihen (${i.ausleihen.length})`], ['protokoll', 'Verlauf']];

    $('#detail-content').innerHTML = `
        <div class="sticky top-0 bg-white/95 backdrop-blur border-b border-slate-100 px-5 md:px-7 py-4 flex justify-between items-start gap-3 z-10">
            <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap mb-1">${statusBadge(i)}<span class="text-xs font-mono font-bold text-slate-400 tracking-widest">${esc(i.deviceId)}</span><span class="text-xs font-bold text-ozean-normal uppercase tracking-wider">${esc(i.category)}</span></div>
                <h2 class="font-extrabold text-xl md:text-2xl text-slate-800 break-words">${esc(i.name)}</h2>
            </div>
            <button data-action="close" class="icon-btn shrink-0" title="Schließen">✕</button>
        </div>
        <div class="p-5 md:p-7 grid md:grid-cols-5 gap-6">
            <div class="md:col-span-2">${gallery}</div>
            <div class="md:col-span-3">
                ${borrowedBox}
                <dl class="grid grid-cols-2 gap-x-4 gap-y-3 mb-5">
                    ${field('Zustand', esc(CONDITION_LABEL[i.condition]), isBroken(i) ? 'text-red-600' : '')}
                    ${field('TÜV / Prüfung', i.tuev ? fmtDate(i.tuev) + tuevBadge(i.tuev) : '–')}
                    ${field('Hersteller', esc(i.hersteller))}
                    ${field('Seriennummer', esc(i.seriennummer), 'font-mono')}
                    ${field('Größe', esc(i.groesse))}
                    ${field('Lagerort', esc(i.lagerort))}
                    ${field('Erfasst am', fmtDate(i.created_at))}
                </dl>
                ${i.notes ? `<div class="bg-slate-50 rounded-xl p-4 text-sm text-slate-700 whitespace-pre-line mb-5">${esc(i.notes)}</div>` : ''}
                <div class="flex flex-wrap gap-2">${actions}</div>
            </div>
        </div>
        <div class="px-5 md:px-7 pb-7">
            <div class="flex border-b-2 border-slate-100 mb-4 overflow-x-auto">
                ${tabs.map(([k, l]) => `<button data-action="detail-tab" data-tab="${k}" class="tab ${state.detailTab === k ? 'tab-on' : 'tab-off'}">${l}</button>`).join('')}
            </div>
            ${renderDetailTab(i)}
        </div>`;
}

function renderDetailTab(i) {
    if (state.detailTab === 'kommentare') {
        return `<form data-form="comment" class="flex gap-2 mb-4">
                <textarea name="text" rows="2" maxlength="2000" required class="input flex-1" placeholder="Kommentar schreiben, z. B. Mängel, Hinweise, Wartung …"></textarea>
                <button class="btn-primary self-end">Senden</button>
            </form>
            ${i.kommentare.length ? `<div class="space-y-3">${i.kommentare.map(c => `<div class="bg-slate-50 rounded-xl p-3">
                <div class="flex justify-between items-center gap-2 mb-1">
                    <span class="text-xs"><b class="text-slate-700">${esc(c.username || 'Gelöschter Nutzer')}</b> <span class="text-slate-400">· ${fmtDateTime(c.created_at)}</span></span>
                    ${c.nutzer_id === state.me.id || can('can_manage_items') ? `<button data-action="delete-comment" data-id="${c.id}" class="text-slate-300 hover:text-red-500" title="Kommentar löschen">${ICON.trash}</button>` : ''}
                </div>
                <div class="text-sm text-slate-700 whitespace-pre-line break-words">${esc(c.text)}</div></div>`).join('')}</div>`
            : '<p class="text-sm text-slate-400">Noch keine Kommentare.</p>'}`;
    }
    if (state.detailTab === 'ausleihen') {
        return i.ausleihen.length ? `<div class="divide-y divide-slate-100 border border-slate-100 rounded-xl">${i.ausleihen.map(a => `<div class="p-3 text-sm">
            <div class="flex justify-between gap-2"><b class="truncate">${esc(a.borrower)}</b>
                ${a.zurueckgegeben_am ? `<span class="text-xs text-slate-500">${esc(CONDITION_LABEL[a.zustand_bei_rueckgabe] || '')}</span>` : '<span class="badge bg-amber-100 text-amber-700">Offen</span>'}</div>
            <div class="text-xs text-slate-500 mt-1">Ausgeliehen ${fmtDateTime(a.ausgeliehen_am)}${a.ausgegeben_von ? ` von ${esc(a.ausgegeben_von)}` : ''}</div>
            <div class="text-xs text-slate-500">${a.zurueckgegeben_am ? `Zurück ${fmtDateTime(a.zurueckgegeben_am)}${a.zurueckgenommen_von ? ` von ${esc(a.zurueckgenommen_von)}` : ''}` : `Geplant bis ${fmtDate(a.rueckgabe_geplant)}`}</div>
        </div>`).join('')}</div>` : '<p class="text-sm text-slate-400">Noch nie ausgeliehen.</p>';
    }
    return activityList(i.aktivitaeten, false);
}

const ACTIVITY = {
    erstellt: ['Angelegt', 'bg-emerald-500'], bearbeitet: ['Bearbeitet', 'bg-ozean-normal'], geloescht: ['Gelöscht', 'bg-red-500'],
    ausgeliehen: ['Ausgeliehen', 'bg-amber-500'], zurueckgegeben: ['Zurückgegeben', 'bg-slate-700'], tuev: ['TÜV erneuert', 'bg-emerald-500'],
    repariert: ['Repariert', 'bg-emerald-500'], bild: ['Foto', 'bg-purple-500'], import: ['Import', 'bg-ozean-normal'],
    kategorie: ['Kategorie', 'bg-slate-400'], team: ['Team', 'bg-purple-500'], verein: ['Verein', 'bg-slate-400'],
};
function activityList(rows, withItem) {
    if (!rows.length) return '<p class="text-sm text-slate-400">Noch keine Einträge.</p>';
    return `<ol class="space-y-3">${rows.map(a => {
        const [label, dot] = ACTIVITY[a.aktion] || [a.aktion, 'bg-slate-400'];
        const item = withItem && a.equipment_id ? ` · <button data-action="open-detail" data-id="${a.equipment_id}" class="text-ozean-normal font-bold hover:underline">${esc(a.equipment_name)} (${esc(a.device_id)})</button>` : '';
        return `<li class="flex gap-3 text-sm"><span class="w-2.5 h-2.5 rounded-full ${dot} mt-1.5 shrink-0"></span><div class="min-w-0">
            <div><b>${label}</b>${item}</div>
            ${a.details ? `<div class="text-slate-600 break-words">${esc(a.details)}</div>` : ''}
            <div class="text-xs text-slate-400">${fmtDateTime(a.created_at)} · ${esc(a.username || 'Gelöschter Nutzer')}</div></div></li>`;
    }).join('')}</ol>`;
}

// =====================================================================
// Gerät anlegen / bearbeiten
// =====================================================================
function openItemForm(item, qrCode = null) {
    const form = $('#item-modal form');
    form.reset();
    $('#item-qr-note').hidden = !qrCode;
    $('#item-qr-note').textContent = qrCode ? `QR-Code ${qrCode} wird diesem Gerät zugeordnet.` : '';
    $('#item-kategorie').innerHTML = state.kategorien.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
    const orte = [...new Set(state.items.map(i => i.lagerort).filter(Boolean))].sort();
    $('#lagerorte').innerHTML = orte.map(o => `<option value="${esc(o)}">`).join('');
    if (item) {
        fillForm(form, item);
        form.elements.kategorie_id.value = item.kategorie_id;
    } else {
        fillForm(form, { condition: 'Gut', kategorie_id: state.filter.kategorie || (state.kategorien[0] && state.kategorien[0].id) });
    }
    form.elements.qr_code.value = qrCode || ''; // nach fillForm setzen, sonst wird es wieder geleert
    $('#item-title').textContent = item ? 'Gerät bearbeiten' : 'Neues Gerät';
    $('#item-photo-field').hidden = !!item;
    $('#item-deviceid-field').hidden = !item; // Nummer wird automatisch vergeben, beim Anlegen nicht anzeigen
    openModal('item-modal');
}

function itemPayload(i, overrides = {}) {
    const keys = ['name', 'kategorie_id', 'hersteller', 'seriennummer', 'groesse', 'lagerort', 'tuev', 'condition', 'notes'];
    const out = {};
    for (const k of keys) out[k] = i[k] ?? null;
    return { ...out, ...overrides };
}

// =====================================================================
// Import
// =====================================================================
const FIELD_LABEL = { deviceId: 'Inventarnummer', name: 'Bezeichnung', kategorie: 'Kategorie', hersteller: 'Hersteller', seriennummer: 'Seriennummer', groesse: 'Größe', lagerort: 'Lagerort', tuev: 'TÜV', condition: 'Zustand', notes: 'Notizen' };

function openImport() {
    state.importPreview = null;
    $('#import-step1').hidden = false;
    $('#import-step2').hidden = true;
    $('#import-file').value = '';
    openModal('import-modal');
}

async function previewImport(file) {
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) return toast('Die Datei ist zu groß (max. 15 MB).', 'error');
    const step2 = $('#import-step2');
    $('#import-step1').hidden = true;
    step2.hidden = false;
    step2.innerHTML = '<div class="py-16 flex justify-center"><div class="animate-spin rounded-full h-10 w-10 border-b-2 border-ozean-normal"></div></div>';
    try {
        state.importPreview = await api('/import/vorschau', { method: 'POST', raw: file });
        state.importPreview.dateiname = file.name;
        renderImportPreview();
    } catch (e) {
        step2.innerHTML = `<div class="bg-red-50 border border-red-100 text-red-700 rounded-xl p-5 mb-4"><b>Die Datei konnte nicht gelesen werden.</b><br>${esc(e.message)}</div>
            <button data-action="import-restart" class="btn-light">Andere Datei wählen</button>`;
    }
}

function renderImportPreview() {
    const p = state.importPreview;
    const n = (a) => p.zeilen.filter(z => z.aktion === a).length;
    const counts = { neu: n('neu'), aktualisieren: n('aktualisieren'), fehler: n('fehler') };
    const badge = { neu: '<span class="badge bg-green-100 text-green-700">Neu</span>', aktualisieren: '<span class="badge bg-ozean-leicht text-ozean-tief">Update</span>', fehler: '<span class="badge bg-red-100 text-red-700">Fehler</span>' };
    const rows = p.zeilen.slice(0, 500);

    $('#import-step2').innerHTML = `
        <div class="text-sm text-slate-500 mb-3">Datei: <b class="text-slate-700">${esc(p.dateiname)}</b></div>
        <div class="grid grid-cols-3 gap-3 mb-4">
            <div class="bg-green-50 rounded-xl p-3"><div class="text-2xl font-extrabold text-green-700">${counts.neu}</div><div class="text-xs font-bold text-green-700 uppercase">Neue Geräte</div></div>
            <div class="bg-ozean-leicht rounded-xl p-3"><div class="text-2xl font-extrabold text-ozean-tief">${counts.aktualisieren}</div><div class="text-xs font-bold text-ozean-tief uppercase">Vorhanden</div></div>
            <div class="${counts.fehler ? 'bg-red-50' : 'bg-slate-50'} rounded-xl p-3"><div class="text-2xl font-extrabold ${counts.fehler ? 'text-red-600' : 'text-slate-300'}">${counts.fehler}</div><div class="text-xs font-bold ${counts.fehler ? 'text-red-600' : 'text-slate-400'} uppercase">Fehlerhaft</div></div>
        </div>
        <div class="text-sm mb-2"><b>Erkannte Spalten:</b> ${Object.entries(p.spalten).map(([f, h]) => `<span class="inline-block bg-slate-100 rounded px-2 py-0.5 m-0.5 text-xs">${esc(h)} → <b>${FIELD_LABEL[f]}</b></span>`).join('')}</div>
        ${p.ignoriert.length ? `<div class="text-sm mb-2 text-slate-500"><b>Nicht verwendet:</b> ${p.ignoriert.map(esc).join(', ')}</div>` : ''}
        ${p.neueKategorien.length ? `<div class="text-sm mb-2 text-slate-500"><b>Neue Kategorien:</b> ${p.neueKategorien.map(esc).join(', ')}</div>` : ''}
        <div class="border border-slate-200 rounded-xl overflow-auto max-h-[45vh] mt-3">
            <table class="w-full text-xs md:text-sm">
                <thead class="sticky top-0 bg-slate-50"><tr class="text-left text-xs font-bold text-slate-500 uppercase">
                    <th class="p-2">Zeile</th><th class="p-2"></th><th class="p-2">Nr.</th><th class="p-2">Bezeichnung</th><th class="p-2">Kategorie</th><th class="p-2">TÜV</th><th class="p-2">Zustand</th><th class="p-2">Hinweise</th></tr></thead>
                <tbody class="divide-y divide-slate-100">${rows.map(z => `<tr class="${z.aktion === 'fehler' ? 'bg-red-50/50' : ''}">
                    <td class="p-2 text-slate-400">${z.zeile}</td><td class="p-2">${badge[z.aktion]}</td>
                    <td class="p-2 font-mono">${esc(z.daten.deviceId || '')}</td><td class="p-2 font-bold">${esc(z.daten.name || '')}</td>
                    <td class="p-2">${esc(z.daten.kategorie || '')}</td><td class="p-2 whitespace-nowrap">${z.daten.tuev ? fmtDate(z.daten.tuev) : ''}</td>
                    <td class="p-2">${esc(CONDITION_LABEL[z.daten.condition] || '')}</td>
                    <td class="p-2">${z.fehler.map(f => `<div class="text-red-600">${esc(f)}</div>`).join('')}${z.hinweise.map(h => `<div class="text-slate-500">${esc(h)}</div>`).join('')}</td>
                </tr>`).join('')}</tbody>
            </table>
            ${p.zeilen.length > rows.length ? `<div class="p-2 text-center text-xs text-slate-400">… und ${p.zeilen.length - rows.length} weitere Zeilen</div>` : ''}
        </div>
        ${counts.aktualisieren ? `<label class="flex items-center gap-2 mt-4 text-sm cursor-pointer"><input type="checkbox" id="import-update" checked class="w-4 h-4">
            <span>Vorhandene Geräte aktualisieren (nur ausgefüllte Felder werden überschrieben)</span></label>` : ''}
        ${counts.fehler ? '<p class="text-sm text-slate-500 mt-2">Fehlerhafte Zeilen werden übersprungen. Du kannst sie in der Datei korrigieren und später erneut importieren.</p>' : ''}
        <div class="flex flex-col-reverse sm:flex-row gap-3 mt-5">
            <button data-action="import-restart" class="btn-light flex-1 py-3">Andere Datei</button>
            <button data-action="import-commit" class="btn-primary flex-1 py-3" ${counts.neu + counts.aktualisieren ? '' : 'disabled'}>${counts.neu + counts.aktualisieren} Einträge übernehmen</button>
        </div>`;
}

async function commitImport(btn) {
    const p = state.importPreview;
    const zeilen = p.zeilen.filter(z => z.aktion !== 'fehler').map(z => ({ zeile: z.zeile, daten: z.daten }));
    const updateBox = $('#import-update');
    btn.disabled = true;
    btn.textContent = 'Wird übernommen …';
    try {
        const r = await api('/import', { method: 'POST', body: { zeilen, aktualisieren: updateBox ? updateBox.checked : true } });
        $('#import-step2').innerHTML = `<div class="text-center py-6">
            <div class="mx-auto flex items-center justify-center h-14 w-14 rounded-full bg-green-100 mb-4">${ICON.check.replace('w-4 h-4', 'w-7 h-7')}</div>
            <h3 class="font-extrabold text-xl mb-2">Import abgeschlossen</h3>
            <p class="text-slate-600"><b>${r.neu}</b> neu angelegt · <b>${r.aktualisiert}</b> aktualisiert${r.uebersprungen ? ` · ${r.uebersprungen} unverändert` : ''}</p>
            ${r.neueKategorien.length ? `<p class="text-sm text-slate-500 mt-1">Neue Kategorien: ${r.neueKategorien.map(esc).join(', ')}</p>` : ''}
            ${r.fehler.length ? `<div class="text-left bg-red-50 rounded-xl p-4 mt-4 text-sm text-red-700 max-h-40 overflow-auto">${r.fehler.map(f => `<div>Zeile ${f.zeile}: ${esc(f.text)}</div>`).join('')}</div>` : ''}
            <button data-action="close" class="btn-primary mt-6 px-8 py-3">Fertig</button></div>`;
        await loadData();
    } catch (e) {
        showError(e);
        btn.disabled = false;
        btn.textContent = 'Erneut versuchen';
    }
}

// =====================================================================
// Einstellungen
// =====================================================================
function settingsTabs() {
    const tabs = [];
    if (can('can_manage_users')) tabs.push(['members', 'Mitglieder'], ['roles', 'Rollen']);
    if (can('can_manage_items')) tabs.push(['categories', 'Kategorien'], ['qr', 'QR-Codes']);
    if (state.me.role === 'admin') tabs.push(['verein', 'Verein']);
    if (can('can_manage_users')) tabs.push(['log', 'Protokoll']);
    return tabs;
}

async function openSettings(tab) {
    const tabs = settingsTabs();
    state.settingsTab = tab || (tabs.some(t => t[0] === state.settingsTab) ? state.settingsTab : tabs[0][0]);
    openModal('settings-modal');
    await renderSettings();
}

async function renderSettings() {
    const tab = state.settingsTab;
    $('#settings-tabs').innerHTML = settingsTabs().map(([k, l]) => `<button data-action="settings-tab" data-tab="${k}" class="tab ${tab === k ? 'tab-on' : 'tab-off'}">${l}</button>`).join('');
    const body = $('#settings-body');
    try {
        if (tab === 'members') {
            const [users, rollen] = await Promise.all([api('/users'), api('/rollen')]);
            state.users = users;
            state.rollen = rollen;
            body.innerHTML = `<div class="flex justify-between items-center mb-4"><p class="text-sm text-slate-500">${users.length} Mitglieder</p>
                <button data-action="new-user" class="btn-primary">+ Mitglied</button></div>
                <div class="divide-y divide-slate-100 border border-slate-100 rounded-xl">${users.map(u => `<div class="flex items-center justify-between gap-3 p-3">
                    <div class="min-w-0"><div class="font-bold truncate">${esc(u.username)}${u.id === state.me.id ? ' <span class="text-xs text-slate-400 font-medium">(du)</span>' : ''}</div><div class="text-xs text-slate-500 truncate">${esc(u.email)}</div></div>
                    <div class="flex items-center gap-2 shrink-0">
                        ${u.role === 'admin' ? '<span class="badge bg-purple-100 text-purple-700">Admin</span>' : u.rollen_name ? `<span class="badge bg-ozean-leicht text-ozean-tief">${esc(u.rollen_name)}</span>` : '<span class="text-xs text-slate-400">Nur ansehen</span>'}
                        <button data-action="edit-user" data-id="${u.id}" class="icon-btn" title="Bearbeiten">${ICON.edit}</button>
                        ${u.id !== state.me.id ? `<button data-action="delete-user" data-id="${u.id}" class="icon-btn hover:text-red-600" title="Löschen">${ICON.trash}</button>` : ''}
                    </div></div>`).join('')}</div>`;
        } else if (tab === 'roles') {
            state.rollen = await api('/rollen');
            const p = (v) => (v ? ICON.check : ICON.cross);
            body.innerHTML = `<div class="flex justify-between items-center mb-4"><p class="text-sm text-slate-500">Rollen legen fest, was Mitglieder dürfen. Admins dürfen immer alles.</p>
                <button data-action="new-role" class="btn-primary shrink-0">+ Rolle</button></div>
                ${state.rollen.length ? `<div class="divide-y divide-slate-100 border border-slate-100 rounded-xl">${state.rollen.map(r => `<div class="flex items-center justify-between gap-3 p-3 flex-wrap">
                    <div><div class="font-bold">${esc(r.name)}</div><div class="text-xs text-slate-400">${r.nutzer_anzahl} Mitglieder</div></div>
                    <div class="flex gap-4 text-xs text-slate-600">
                        <span class="flex items-center gap-1">${p(r.permissions.can_borrow_return)}Ausleihe</span>
                        <span class="flex items-center gap-1">${p(r.permissions.can_manage_items)}Inventar</span>
                        <span class="flex items-center gap-1">${p(r.permissions.can_manage_users)}Team</span></div>
                    <div class="flex gap-1"><button data-action="edit-role" data-id="${r.id}" class="icon-btn" title="Bearbeiten">${ICON.edit}</button>
                        <button data-action="delete-role" data-id="${r.id}" class="icon-btn hover:text-red-600" title="Löschen">${ICON.trash}</button></div>
                </div>`).join('')}</div>` : '<p class="text-sm text-slate-400">Noch keine Rollen. Ohne Rolle können Mitglieder nur ansehen und kommentieren.</p>'}`;
        } else if (tab === 'categories') {
            state.kategorien = await api('/kategorien');
            const row = (k) => `<form data-form="category" data-id="${k ? k.id : ''}" class="flex items-center gap-2 p-3">
                <input name="prefix" class="input w-20 font-mono uppercase" maxlength="4" value="${k ? esc(k.prefix) : ''}" placeholder="auto" title="Kürzel: Anfang der Inventarnummer">
                <input name="name" class="input flex-1" maxlength="50" required value="${k ? esc(k.name) : ''}" placeholder="Neue Kategorie">
                ${k ? `<span class="text-xs text-slate-400 w-16 text-right shrink-0">${k.anzahl} Geräte</span>` : ''}
                <button class="${k ? 'icon-btn' : 'btn-primary'}" title="Speichern">${k ? ICON.save : '+ Anlegen'}</button>
                ${k ? `<button type="button" data-action="delete-category" data-id="${k.id}" class="icon-btn hover:text-red-600" title="Löschen">${ICON.trash}</button>` : ''}
            </form>`;
            body.innerHTML = `<p class="text-sm text-slate-500 mb-4">Das Kürzel ist der Anfang der Inventarnummer (z. B. Kürzel 1 → 1001 bis 1999, bis zu 999 Geräte pro Kategorie). Nummern gelöschter Geräte werden wiederverwendet; wechselt ein Gerät die Kategorie, bekommt es eine neue Nummer. Wird es geändert, behalten bestehende Geräte ihre Nummer.</p>
                <div class="divide-y divide-slate-100 border border-slate-100 rounded-xl">${state.kategorien.map(row).join('')}</div>
                <div class="border border-dashed border-slate-300 rounded-xl mt-4">${row(null)}</div>`;
        } else if (tab === 'verein') {
            const v = state.me.verein;
            body.innerHTML = `<form data-form="verein" class="max-w-xl space-y-6">
                <div><label class="label">Vereinsname</label><input name="name" class="input" required maxlength="100" value="${esc(v.name)}"></div>
                <div>
                    <label class="label">Logo</label>
                    <div class="flex items-center gap-4">
                        <div class="w-24 h-24 rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden shrink-0">
                            ${v.logo ? `<img src="${esc(v.logo)}" alt="" class="max-w-full max-h-full object-contain p-1">` : `<span class="text-slate-300">${ICON.image}</span>`}
                        </div>
                        <div class="flex flex-col gap-2 items-start">
                            <label class="btn-outline cursor-pointer">${ICON.camera}${v.logo ? 'Logo ändern' : 'Logo hochladen'}<input type="file" accept="image/*" data-change="logo-upload" class="sr-only"></label>
                            ${v.logo ? '<button type="button" data-action="delete-logo" class="text-sm font-bold text-red-600 hover:underline">Logo entfernen</button>' : ''}
                        </div>
                    </div>
                    <p class="text-xs text-slate-500 mt-2">Am besten ein PNG mit transparentem Hintergrund. Die Vereinsfarbe wird automatisch aus dem Logo übernommen.</p>
                </div>
                <div>
                    <label class="label">Vereinsfarbe</label>
                    <div class="flex items-center gap-3 flex-wrap">
                        <input type="color" name="farbe" value="${esc(v.farbe || DEFAULT_COLOR)}" data-input="farbe" class="h-11 w-16 rounded-lg border border-slate-200 cursor-pointer bg-white p-1">
                        <span class="btn-primary pointer-events-none">Vorschau</span>
                        <span class="badge bg-ozean-leicht text-ozean-tief">Akzent</span>
                        <button type="button" data-action="reset-color" class="text-sm font-bold text-slate-500 hover:text-slate-800">Standardfarbe</button>
                    </div>
                    <p class="text-xs text-slate-500 mt-2">Wird für Knöpfe, Markierungen und die Login-Seite verwendet. Sehr helle Farben werden automatisch etwas abgedunkelt.</p>
                </div>
                <div>
                    <label class="label">Adresse für QR-Codes</label>
                    <input name="qr_url" class="input font-mono" value="${esc(v.qr_url || '')}" placeholder="${esc(location.origin)}" autocapitalize="none" autocorrect="off" spellcheck="false">
                    <p class="text-xs text-slate-500 mt-2">Diese Adresse steckt in jedem QR-Code. Am besten einmal festlegen, bevor Schilder gemacht werden. Leer lassen = ${esc(location.origin)}</p>
                </div>
                <button class="btn-primary">Speichern</button></form>
                <div class="mt-8 text-sm text-slate-500 space-y-2 max-w-xl">
                    <p><b class="text-slate-700">Datensicherung:</b> Über „Export“ kannst du jederzeit das komplette Inventar als Excel-Datei herunterladen. Zusätzlich sichert der Server täglich automatisch die Datenbank.</p>
                </div>`;
        } else if (tab === 'qr') {
            const frei = await api('/qr/frei');
            body.innerHTML = `<div class="space-y-6 max-w-2xl">
                <p class="text-sm text-slate-600">Jedes Gerät hat automatisch seinen eigenen QR-Code. Er ändert sich nie – du findest ihn im Gerät unter <b>„QR-Code“</b>.</p>
                <div class="border-t border-slate-100 pt-6">
                    <h3 class="font-bold mb-1">QR-Codes auf Vorrat</h3>
                    <p class="text-sm text-slate-500 mb-3">Schilder schon vorher machen (z. B. lasern)? Codes hier erzeugen. Später das Schild mit <b>„Scannen“</b> einem Gerät zuordnen.</p>
                    <form data-form="qr-generate" class="flex items-end gap-3 flex-wrap">
                        <div><label class="label">Anzahl</label><input name="anzahl" type="number" min="1" max="210" value="21" class="input w-28"></div>
                        <button class="btn-primary">Erzeugen & drucken</button>
                    </form>
                </div>
                <div>
                    <div class="flex justify-between items-center mb-2"><h3 class="font-bold">Noch nicht zugeordnet (${frei.length})</h3>
                        ${frei.length ? `<button data-action="print-free-codes" class="btn-outline">${ICON.qr}Alle drucken</button>` : ''}</div>
                    ${frei.length ? `<div class="flex flex-wrap gap-2">${frei.map(f => `<span class="inline-flex items-center gap-1 bg-slate-100 rounded-lg pl-3 pr-1 py-1 font-mono text-sm">${esc(f.code)}
                        <a href="/api/qr/${esc(f.code)}/png?download=1" class="icon-btn p-1" title="Als Bild herunterladen">↓</a>
                        <button data-action="delete-free-code" data-code="${esc(f.code)}" class="icon-btn p-1 hover:text-red-600" title="Löschen">✕</button></span>`).join('')}</div>`
                        : '<p class="text-sm text-slate-400">Keine.</p>'}
                </div>
            </div>`;
        } else if (tab === 'log') {
            const rows = await api('/aktivitaeten?limit=300');
            body.innerHTML = `<p class="text-sm text-slate-500 mb-4">Die letzten ${rows.length} Aktionen im Verein.</p>${activityList(rows, true)}`;
        }
    } catch (e) {
        body.innerHTML = `<p class="text-red-600">${esc(e.message)}</p>`;
    }
}

function openUserForm(user) {
    const form = $('#user-modal form');
    form.reset();
    const isSelf = user && user.id === state.me.id;
    const options = ['<option value="">Keine Rolle (nur ansehen)</option>']
        .concat(state.rollen.map(r => `<option value="${r.id}">${esc(r.name)}</option>`));
    if (state.me.role === 'admin' || (user && user.role === 'admin')) options.unshift('<option value="admin">Admin (alle Rechte)</option>');
    form.elements.rolle.innerHTML = options.join('');
    fillForm(form, user ? { ...user, rolle: user.role === 'admin' ? 'admin' : (user.vereins_rolle_id || ''), password: '' } : { rolle: '' });
    form.elements.rolle.disabled = isSelf;
    $('#user-self-hint').hidden = !isSelf;
    form.elements.password.required = !user;
    form.elements.password.placeholder = user ? 'Leer lassen = unverändert' : 'Mindestens 8 Zeichen';
    $('#user-pass-label').textContent = user ? 'Neues Passwort' : 'Passwort';
    $('#user-modal-title').textContent = user ? 'Mitglied bearbeiten' : 'Mitglied hinzufügen';
    openModal('user-modal');
}

function openRoleForm(role) {
    const form = $('#role-modal form');
    form.reset();
    fillForm(form, role ? { id: role.id, name: role.name, ...role.permissions } : { can_borrow_return: true });
    $('#role-modal-title').textContent = role ? 'Rolle bearbeiten' : 'Neue Rolle';
    openModal('role-modal');
}

// =====================================================================
// QR-Codes: Scanner und Zuordnung
// =====================================================================
const scanner = { stream: null, timer: null, onCode: null };

function loadJsQR() {
    if (window.jsQR) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/jsQR.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('Scanner konnte nicht geladen werden.'));
        document.head.appendChild(s);
    });
}

// Erkennt, was im gescannten QR-Code steht: fester Code, ältere Links oder ein eingetippter Code
function parseScan(text) {
    const t = String(text || '').trim();
    let m = t.match(/[/#]q\/([0-9A-Za-z-]{4,20})/);
    if (m) return { code: m[1] };
    m = t.match(/#nr\/([^?#\s]+)/);
    if (m) return { nr: decodeURIComponent(m[1]) };
    m = t.match(/#geraet\/(\d+)/);
    if (m) return { id: Number(m[1]) };
    if (/^[0-9A-Za-z -]{4,20}$/.test(t)) return { code: t.replace(/[\s-]/g, '') };
    return null;
}

function decodeImage(source, width, height) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1200 / Math.max(width, height));
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // attemptBoth: erkennt auch helle Codes auf dunklem Grund (z. B. auf Metall gelasert)
    const r = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    return r ? r.data : null;
}

// onCode(text) wird mit dem Inhalt des QR-Codes aufgerufen
async function openScanner(onCode) {
    scanner.onCode = onCode;
    $('#scan-status').textContent = '';
    $('#scan-modal form').reset();
    openModal('scan-modal');
    const live = window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    $('#scan-live').hidden = !live;
    $('#scan-photo-hint').textContent = live ? 'Klappt es mit der Kamera nicht, kannst du auch ein Foto aufnehmen:' : 'Fotografiere den QR-Code – Equiply erkennt ihn automatisch.';
    try { await loadJsQR(); } catch (e) { $('#scan-status').textContent = e.message; return; }
    if (!live) return;
    try {
        scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if ($('#scan-modal').hidden) return stopScanner();
        const video = $('#scan-video');
        video.srcObject = scanner.stream;
        await video.play();
        const tick = () => {
            if (!scanner.stream) return;
            if (video.readyState >= 2 && video.videoWidth) {
                const text = decodeImage(video, video.videoWidth, video.videoHeight);
                if (text) return scanned(text);
            }
            scanner.timer = setTimeout(tick, 150);
        };
        tick();
    } catch (e) {
        $('#scan-live').hidden = true;
        $('#scan-photo-hint').textContent = 'Kein Zugriff auf die Kamera – fotografiere den QR-Code stattdessen:';
    }
}

function stopScanner() {
    clearTimeout(scanner.timer);
    if (scanner.stream) scanner.stream.getTracks().forEach(t => t.stop());
    scanner.stream = null;
    const video = $('#scan-video');
    if (video) video.srcObject = null;
}

function scanned(text) {
    stopScanner();
    const cb = scanner.onCode;
    closeModal('scan-modal');
    if (navigator.vibrate) navigator.vibrate(60);
    if (cb) Promise.resolve(cb(text)).catch(showError);
}

async function scanPhoto(file) {
    $('#scan-status').textContent = 'Wird erkannt …';
    await loadJsQR();
    const bmp = await createImageBitmap(file);
    const text = decodeImage(bmp, bmp.width, bmp.height);
    if (text) return scanned(text);
    $('#scan-status').textContent = 'Kein QR-Code erkannt. Bitte näher herangehen und scharf fotografieren.';
}

// Standard: gescannten Code öffnen
async function openScanned(text) {
    const r = parseScan(text);
    if (!r) return toast('Das ist kein Equiply-QR-Code.', 'error');
    if (r.code) return handleCode(r.code);
    if (r.id) return openDetail(r.id);
    const item = state.items.find(i => i.deviceId.toLowerCase() === r.nr.toLowerCase());
    if (item) openDetail(item.id); else toast(`Kein Gerät mit der Nummer ${r.nr} gefunden.`, 'error');
}

// Fester QR-Code: zugeordnetes Gerät öffnen oder freien Code zuordnen
async function handleCode(raw) {
    if (location.hash.startsWith('#q/')) history.replaceState(null, '', location.pathname);
    const r = await api(`/qr/${encodeURIComponent(raw)}`);
    if (r.status === 'zugeordnet') return openDetail(r.equipment_id);
    if (!can('can_manage_items')) return toast(`QR-Code ${r.code} ist noch keinem Gerät zugeordnet.`, 'error');
    state.pendingCode = r.code;
    $('#code-modal-code').textContent = r.code;
    $('#code-modal input').value = '';
    renderCodeAssignList('');
    openModal('code-modal');
}

function renderCodeAssignList(search) {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const items = state.items.filter(i => words.every(w => `${i.name} ${i.deviceId} ${i.category}`.toLowerCase().includes(w))).slice(0, 50);
    $('#code-assign-list').innerHTML = items.length ? items.map(i => `<button data-action="code-assign" data-id="${i.id}" class="w-full text-left p-3 hover:bg-slate-50 flex justify-between gap-3">
        <span class="min-w-0"><span class="font-mono text-xs text-slate-400 mr-2">${esc(i.deviceId)}</span><b class="truncate">${esc(i.name)}</b></span>
        <span class="text-xs text-slate-400 font-mono shrink-0">${esc(i.qr_code || '')}</span></button>`).join('')
        : '<p class="p-3 text-sm text-slate-400">Keine Geräte gefunden.</p>';
}

// =====================================================================
// Aktionen (Klicks)
// =====================================================================
const findItem = (id) => state.items.find(i => i.id === Number(id)) || (state.detail && state.detail.id === Number(id) ? state.detail : null);

async function afterChange(message) {
    if (message) toast(message);
    await loadData();
    await refreshDetail();
}

const actions = {
    'show-setup': () => showAuth('setup'),
    'show-login': () => showAuth('login'),
    async logout() {
        await api('/logout', { method: 'POST' }).catch(() => {});
        state.me = null;
        location.hash = '';
        showAuth('login');
    },
    'open-scanner': () => openScanner(openScanned),
    'show-qr': (el) => {
        const i = findItem(el.dataset.id);
        $('#qr-modal-content').innerHTML = `
            <h2 class="font-extrabold text-xl">QR-Code</h2>
            <p class="text-sm text-slate-500 mt-1">${esc(i.name)} · Nr. ${esc(i.deviceId)}</p>
            <img src="/api/equipment/${i.id}/qr.png" alt="QR-Code" class="w-60 h-60 mx-auto my-4 rounded-lg border border-slate-100">
            <p class="text-sm text-slate-600 mb-5">Dieser QR-Code gehört fest zu diesem Gerät und ändert sich nie.</p>
            <div class="space-y-2">
                <a href="/api/equipment/${i.id}/qr.png?download=1" class="btn-primary w-full py-3">Als Bild herunterladen</a>
                <button data-action="print-label" data-id="${i.id}" class="btn-outline w-full py-3">Etikett drucken</button>
                <button data-action="close" class="btn-light w-full py-3">Schließen</button>
            </div>
            ${can('can_manage_items') ? `<button data-action="change-qr" data-id="${i.id}" class="text-xs text-slate-400 hover:text-slate-700 underline mt-4">Anderes Schild verwenden</button>` : ''}`;
        openModal('qr-modal');
    },
    'code-new-item': () => { const code = state.pendingCode; closeModal('code-modal'); openItemForm(null, code); },
    async 'code-assign'(el) {
        const i = findItem(el.dataset.id);
        if (i.qr_code && !await confirmDialog(`„${i.name}“ bekommt den Code ${state.pendingCode}.\nDer bisherige Code ${i.qr_code} wird frei.`, 'Zuordnen')) return;
        await api(`/equipment/${i.id}/qr`, { method: 'PUT', body: { code: state.pendingCode } });
        closeModal('code-modal');
        await afterChange(`QR-Code ${state.pendingCode} zugeordnet.`);
        openDetail(i.id);
    },
    'change-qr': (el) => {
        closeModal('qr-modal');
        const form = $('#qr-change-modal form');
        form.reset();
        form.elements.id.value = el.dataset.id;
        openModal('qr-change-modal');
    },
    'scan-for-change': () => openScanner((text) => {
        const r = parseScan(text);
        if (!r || !r.code) return toast('Kein gültiger QR-Code erkannt.', 'error');
        $('#qr-change-modal form').elements.code.value = r.code.toUpperCase();
    }),
    async 'print-free-codes'() {
        const frei = await api('/qr/frei');
        window.open(`/etiketten.html?codes=${frei.map(f => f.code).join(',')}`, '_blank');
    },
    async 'delete-free-code'(el) {
        if (!await confirmDialog(`Freien Code ${el.dataset.code} löschen?\nNur löschen, wenn es dafür kein Schild gibt.`)) return;
        await api(`/qr/frei/${el.dataset.code}`, { method: 'DELETE' });
        renderSettings();
    },
    'reset-color': () => {
        const input = $('#settings-body input[name=farbe]');
        input.value = DEFAULT_COLOR;
        applyTheme(DEFAULT_COLOR);
    },
    async 'delete-logo'() {
        if (!await confirmDialog('Vereinslogo entfernen?', 'Ja, entfernen')) return;
        await api('/verein/logo', { method: 'DELETE' });
        state.me = await api('/me');
        applyBranding(state.me.verein);
        toast('Logo entfernt.');
        renderSettings();
    },
    'toggle-password': (el) => {
        const input = el.parentElement.querySelector('input');
        input.type = input.type === 'password' ? 'text' : 'password';
        el.textContent = input.type === 'password' ? 'Anzeigen' : 'Verbergen';
    },
    'toggle-menu': () => { $('#user-menu').hidden = !$('#user-menu').hidden; },
    close: (el) => closeModal(el.closest('.overlay').id),
    'close-lightbox': () => { $('#lightbox').hidden = true; },
    lightbox: (el) => { $('#lightbox-img').src = el.dataset.src; $('#lightbox').hidden = false; },
    'open-password': () => { $('#password-modal form').reset(); openModal('password-modal'); },

    stat: (el) => { state.filter.status = state.filter.status === el.dataset.status ? '' : el.dataset.status; $('#status-filter').value = state.filter.status; render(); },
    category: (el) => { state.filter.kategorie = el.dataset.id ? Number(el.dataset.id) : null; render(); },
    view: (el) => { state.view = el.dataset.view; storageSet('equiply_view', state.view); renderInventory(); },
    'reset-filter': () => { state.filter = { kategorie: null, status: '', search: '' }; $('#search').value = ''; $('#status-filter').value = ''; render(); },

    'open-detail': (el) => { closeModal('settings-modal'); openDetail(Number(el.dataset.id)); },
    'detail-tab': (el) => { state.detailTab = el.dataset.tab; renderDetail(); },
    'detail-image': (el) => { state.detailImage = Number(el.dataset.index); renderDetail(); },

    'new-item': () => openItemForm(null),
    'edit-item': (el) => openItemForm(findItem(el.dataset.id)),
    async 'delete-item'(el) {
        const i = findItem(el.dataset.id);
        if (!await confirmDialog(`„${i.name}“ (${i.deviceId}) wirklich löschen?\nFotos, Kommentare und Ausleih-Verlauf werden ebenfalls gelöscht.`)) return;
        await api(`/equipment/${i.id}`, { method: 'DELETE' });
        closeModal('detail-modal');
        await afterChange('Gerät gelöscht.');
    },
    borrow: (el) => openAction(findItem(el.dataset.id), 'borrow'),
    return: (el) => openAction(findItem(el.dataset.id), 'return'),
    'quick-date': (el) => { $('#action-modal form').elements.returnDate.value = today(Number(el.dataset.days)); },
    async repaired(el) {
        const i = findItem(el.dataset.id);
        await api(`/equipment/${i.id}`, { method: 'PUT', body: itemPayload(i, { condition: 'Gut' }) });
        await afterChange('Als repariert markiert.');
    },
    'renew-tuev': (el) => {
        const form = $('#tuev-modal form');
        form.reset();
        form.elements.id.value = el.dataset.id;
        openModal('tuev-modal');
    },
    'print-label': (el) => window.open(`/etiketten.html?ids=${el.dataset.id}`, '_blank'),
    'print-labels': () => {
        const ids = filteredItems().map(i => i.id);
        if (!ids.length) return toast('Keine Geräte ausgewählt.', 'error');
        window.open(`/etiketten.html?ids=${ids.join(',')}`, '_blank');
    },
    async 'delete-image'(el) {
        if (!await confirmDialog('Dieses Foto löschen?')) return;
        await api(`/bilder/${el.dataset.id}`, { method: 'DELETE' });
        state.detailImage = Math.max(0, state.detailImage - 1);
        await afterChange('Foto gelöscht.');
    },
    async 'delete-comment'(el) {
        if (!await confirmDialog('Kommentar löschen?')) return;
        await api(`/kommentare/${el.dataset.id}`, { method: 'DELETE' });
        await afterChange();
    },

    'open-import': () => { $('#user-menu').hidden = true; openImport(); },
    'import-restart': () => openImport(),
    'import-commit': (el) => commitImport(el),

    'open-settings': () => openSettings(),
    'settings-tab': (el) => { state.settingsTab = el.dataset.tab; renderSettings(); },
    'new-user': () => openUserForm(null),
    'edit-user': (el) => openUserForm(state.users.find(u => u.id === Number(el.dataset.id))),
    async 'delete-user'(el) {
        const u = state.users.find(x => x.id === Number(el.dataset.id));
        if (!await confirmDialog(`Mitglied „${u.username}“ wirklich löschen?`)) return;
        await api(`/users/${u.id}`, { method: 'DELETE' });
        toast('Mitglied gelöscht.');
        renderSettings();
    },
    'new-role': () => openRoleForm(null),
    'edit-role': (el) => openRoleForm(state.rollen.find(r => r.id === Number(el.dataset.id))),
    async 'delete-role'(el) {
        const r = state.rollen.find(x => x.id === Number(el.dataset.id));
        if (!await confirmDialog(`Rolle „${r.name}“ löschen?${r.nutzer_anzahl ? `\n${r.nutzer_anzahl} Mitglieder verlieren damit ihre Rechte.` : ''}`)) return;
        await api(`/rollen/${r.id}`, { method: 'DELETE' });
        toast('Rolle gelöscht.');
        renderSettings();
    },
    async 'delete-category'(el) {
        const k = state.kategorien.find(x => x.id === Number(el.dataset.id));
        if (!await confirmDialog(`Kategorie „${k.name}“ löschen?`)) return;
        await api(`/kategorien/${k.id}`, { method: 'DELETE' });
        toast('Kategorie gelöscht.');
        await renderSettings();
        await loadData();
    },
};

function openAction(i, type) {
    const form = $('#action-modal form');
    form.reset();
    form.elements.id.value = i.id;
    form.elements.type.value = type;
    $('#action-borrow').hidden = type !== 'borrow';
    $('#action-return').hidden = type !== 'return';
    $('#action-title').textContent = type === 'borrow' ? 'Ausleihe erfassen' : 'Rückgabe erfassen';
    $('#action-subtitle').textContent = `${i.name} (${i.deviceId})${type === 'return' ? ` – ausgeliehen von ${i.borrower}` : ''}`;
    form.elements.borrower.required = type === 'borrow';
    if (type === 'return') form.elements.condition.value = i.condition === 'Reparaturbedürftig' ? 'Reparaturbedürftig' : 'Gut';
    openModal('action-modal');
    if (type === 'borrow') {
        api('/ausleiher').then(names => { $('#ausleiher').innerHTML = names.map(n => `<option value="${esc(n)}">`).join(''); }).catch(() => {});
    }
}

// =====================================================================
// Formulare
// =====================================================================
const forms = {
    async login(form) {
        const v = formValues(form);
        await api('/login', { method: 'POST', body: v, quiet401: true });
        state.me = await api('/me');
        form.reset();
        await startApp();
    },
    async setup(form) {
        const v = formValues(form);
        if (v.password !== v.password2) throw new Error('Die Passwörter stimmen nicht überein.');
        await api('/setup', { method: 'POST', body: v });
        state.setup.einrichtung = false;
        state.me = await api('/me');
        form.reset();
        await startApp();
        toast('Willkommen bei Equiply! Lege jetzt dein erstes Gerät an oder importiere eine Excel-Liste.', 'info');
    },
    async item(form) {
        const v = formValues(form);
        const files = [...form.elements.fotos.files];
        delete v.deviceId;
        if (!v.qr_code) delete v.qr_code;
        if (v.id) {
            delete v.qr_code;
            await api(`/equipment/${v.id}`, { method: 'PUT', body: v });
            closeModal('item-modal');
            await afterChange('Gespeichert.');
        } else {
            const r = await api('/equipment', { method: 'POST', body: v });
            closeModal('item-modal');
            if (files.length) await uploadImages(r.id, files);
            await afterChange(`Gerät ${r.deviceId} angelegt.`);
        }
    },
    async action(form) {
        const v = formValues(form);
        const body = v.type === 'borrow' ? { borrower: v.borrower, returnDate: v.returnDate || null } : { condition: v.condition, kommentar: v.kommentar };
        const r = await api(`/equipment/${v.id}/action`, { method: 'PUT', body });
        closeModal('action-modal');
        await afterChange(r.message);
    },
    async tuev(form) {
        const v = formValues(form);
        const i = findItem(v.id);
        await api(`/equipment/${i.id}`, { method: 'PUT', body: itemPayload(i, { tuev: v.tuev }) });
        closeModal('tuev-modal');
        await afterChange('TÜV-Datum gespeichert.');
    },
    async comment(form) {
        const text = form.elements.text.value.trim();
        if (!text) return;
        await api(`/equipment/${state.detail.id}/kommentare`, { method: 'POST', body: { text } });
        form.reset();
        await afterChange();
    },
    async password(form) {
        const v = formValues(form);
        if (v.newPassword !== v.newPassword2) throw new Error('Die neuen Passwörter stimmen nicht überein.');
        const r = await api('/me/password', { method: 'PUT', body: v });
        closeModal('password-modal');
        toast(r.message);
    },
    async user(form) {
        const v = formValues(form);
        if (v.id) await api(`/users/${v.id}`, { method: 'PUT', body: v });
        else await api('/users', { method: 'POST', body: v });
        closeModal('user-modal');
        toast('Gespeichert.');
        renderSettings();
    },
    async role(form) {
        const v = formValues(form);
        const body = { name: v.name, permissions: { can_manage_users: v.can_manage_users, can_manage_items: v.can_manage_items, can_borrow_return: v.can_borrow_return } };
        if (v.id) await api(`/rollen/${v.id}`, { method: 'PUT', body });
        else await api('/rollen', { method: 'POST', body });
        closeModal('role-modal');
        toast('Rolle gespeichert.');
        state.me = await api('/me');
        renderSettings();
    },
    async category(form) {
        const v = formValues(form);
        const id = form.dataset.id;
        if (id) await api(`/kategorien/${id}`, { method: 'PUT', body: { name: v.name, prefix: v.prefix.toUpperCase() } });
        else await api('/kategorien', { method: 'POST', body: { name: v.name, prefix: v.prefix ? v.prefix.toUpperCase() : null } });
        toast('Kategorie gespeichert.');
        await renderSettings();
        await loadData();
    },
    async 'scan-manual'(form) {
        const text = form.elements.code.value;
        const cb = scanner.onCode;
        stopScanner();
        closeModal('scan-modal');
        if (cb) await cb(text);
    },
    async 'qr-change'(form) {
        const v = formValues(form);
        const r = await api(`/equipment/${v.id}/qr`, { method: 'PUT', body: { code: v.code } });
        closeModal('qr-change-modal');
        await afterChange(`QR-Code ${r.code} zugeordnet.`);
    },
    async 'qr-generate'(form) {
        const r = await api('/qr/frei', { method: 'POST', body: { anzahl: Number(form.elements.anzahl.value) } });
        window.open(`/etiketten.html?codes=${r.codes.join(',')}`, '_blank');
        renderSettings();
    },
    async verein(form) {
        const v = formValues(form);
        await api('/verein', { method: 'PUT', body: { name: v.name, farbe: v.farbe === DEFAULT_COLOR ? null : v.farbe, qr_url: v.qr_url } });
        state.me = await api('/me');
        applyBranding(state.me.verein);
        toast('Gespeichert.');
    },
};

// =====================================================================
// Ereignisse
// =====================================================================
document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!e.target.closest('#user-menu') && !e.target.closest('[data-action="toggle-menu"]')) $('#user-menu').hidden = true;
    if (!el) return;
    const fn = actions[el.dataset.action];
    if (!fn) return;
    if (el.tagName === 'BUTTON' || el.tagName === 'A') e.preventDefault();
    if (el.disabled) return;
    try { await fn(el, e); } catch (err) { showError(err); }
});

// Klick neben einen Dialog schließt ihn (nur wenn auch dort gedrückt wurde)
let pressedOn = null;
document.addEventListener('mousedown', (e) => { pressedOn = e.target; });
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('overlay') && pressedOn === e.target && e.target.id !== 'confirm-modal') closeModal(e.target.id);
});

document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) { $('#lightbox').hidden = true; return; }
    const top = modalStack[modalStack.length - 1];
    if (top === 'confirm-modal') $('#confirm-no').click();
    else if (top) closeModal(top);
});

document.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const handler = forms[form.dataset.form];
    const btn = form.querySelector('button:not([type=button])');
    if (btn) btn.disabled = true;
    const errBox = form.dataset.form === 'login' || form.dataset.form === 'setup' ? $('#auth-error') : null;
    if (errBox) errBox.hidden = true;
    try { await handler(form); } catch (err) {
        if (errBox) { errBox.textContent = err.message; errBox.hidden = false; } else showError(err);
    } finally { if (btn) btn.disabled = false; }
});

let searchTimer;
document.addEventListener('input', (e) => {
    if (e.target.dataset.input === 'farbe') applyTheme(e.target.value);
    if (e.target.dataset.input === 'code-assign-search') renderCodeAssignList(e.target.value);
    if (e.target.dataset.input === 'search') {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { state.filter.search = e.target.value; renderInventory(); }, 120);
    }
});

document.addEventListener('change', async (e) => {
    const t = e.target;
    try {
        if (t.dataset.change === 'status-filter') { state.filter.status = t.value; render(); }
        if (t.dataset.change === 'import-file') await previewImport(t.files[0]);
        if (t.dataset.change === 'scan-photo' && t.files[0]) { await scanPhoto(t.files[0]); t.value = ''; }
        if (t.dataset.change === 'logo-upload' && t.files[0]) {
            const logo = await prepareLogo(t.files[0]);
            await api('/verein/logo', { method: 'POST', raw: logo });
            const farbe = await dominantColor(logo);
            if (farbe) await api('/verein', { method: 'PUT', body: { name: state.me.verein.name, farbe } });
            state.me = await api('/me');
            applyBranding(state.me.verein);
            toast(farbe ? 'Logo gespeichert – die Farbe wurde aus dem Logo übernommen.' : 'Logo gespeichert.');
            renderSettings();
        }
        if (t.dataset.change === 'detail-upload' && t.files.length) {
            const files = [...t.files];
            const before = state.detail.bilder.length;
            toast(files.length > 1 ? `${files.length} Fotos werden hochgeladen …` : 'Foto wird hochgeladen …', 'info');
            const ok = await uploadImages(state.detail.id, files);
            if (ok) { state.detailImage = before; await afterChange(ok > 1 ? `${ok} Fotos hinzugefügt.` : 'Foto hinzugefügt.'); }
        }
    } catch (err) { showError(err); }
});

// Datei per Drag & Drop in den Import ziehen
const drop = $('#import-drop');
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('border-ozean-normal', 'bg-ozean-leicht/40'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('border-ozean-normal', 'bg-ozean-leicht/40'); }));
drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) previewImport(e.dataTransfer.files[0]); });

window.addEventListener('hashchange', openFromHash);

boot();
