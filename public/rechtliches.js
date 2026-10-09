'use strict';
// Füllt Impressum und Vereinsnamen auf den öffentlichen Seiten (Impressum, Datenschutz)
fetch('/api/rechtliches').then(r => r.json()).then(data => {
    const text = document.getElementById('impressum-text');
    if (text) text.textContent = data.impressum || '';
    for (const el of document.querySelectorAll('[data-verein]')) {
        if (data.verein) el.textContent = data.verein;
    }
}).catch(() => {});
