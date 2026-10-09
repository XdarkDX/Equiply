// Erzeugt das QR-Bild zum Herunterladen: QR-Code oben, darunter gut lesbar der Code (z. B. K7F3X9).
const path = require('path');
const QRCode = require('qrcode');
const { Resvg } = require('@resvg/resvg-js');

// Schrift wird mitgeliefert, damit das Bild auf jedem Server gleich aussieht
const FONT_FILE = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const WIDTH = 1000;

function qrPngWithCode(url, code) {
    const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const margin = 4; // Ruhezone in Modulen
    const total = size + 2 * margin;

    let modules = '';
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (qr.modules.get(r, c)) modules += `M${c + margin} ${r + margin}h1v1h-1z`;
        }
    }

    // Maße in Modul-Einheiten; Text darunter mit etwas Abstand
    const fontSize = total * 0.13;
    const height = total + fontSize * 1.35;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}">
        <rect width="100%" height="100%" fill="#fff"/>
        <path d="${modules}" fill="#000" shape-rendering="crispEdges"/>
        <text x="${total / 2}" y="${total + fontSize * 0.55}" font-family="DejaVu Sans" font-weight="bold" font-size="${fontSize}"
              letter-spacing="${fontSize * 0.12}" text-anchor="middle" fill="#000">${code.replace(/[^0-9A-Z]/g, '')}</text>
    </svg>`;

    const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: WIDTH },
        font: { fontFiles: [FONT_FILE], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
    });
    return resvg.render().asPng();
}

module.exports = { qrPngWithCode };
