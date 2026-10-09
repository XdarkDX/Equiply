// Erzeugt das QR-Bild zum Herunterladen: QR-Code oben, darunter gut lesbar der Code (z. B. K7F3X9).
const QRCode = require('qrcode');
const { PNG } = require('pngjs');

// Einfache 5×7-Pixelschrift für die Zeichen, die in Codes vorkommen
const FONT = {
    0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
    4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    N: ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
    P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
    Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

const WIDTH = 1000;

function qrPngWithCode(url, code) {
    const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
    const size = qr.modules.size;
    const margin = 4;                                  // Ruhezone in Modulen
    const scale = Math.floor(WIDTH / (size + 2 * margin));
    const qrPx = scale * (size + 2 * margin);
    const offset = Math.floor((WIDTH - qrPx) / 2);

    // Schrift so groß wie möglich, ohne über den Rand zu gehen
    const chars = [...code].filter(c => FONT[c]);
    const fontScale = Math.max(4, Math.min(22, Math.floor((WIDTH * 0.8) / (chars.length * 6))));
    const textH = 7 * fontScale;
    const height = WIDTH + textH + Math.round(fontScale * 7);

    const png = new PNG({ width: WIDTH, height, colorType: 2 });
    png.data.fill(255); // weißer Hintergrund (RGBA, Alpha bleibt 255)
    const black = (x, y, w, h) => {
        for (let yy = y; yy < y + h; yy++) {
            for (let xx = x; xx < x + w; xx++) {
                const i = (yy * WIDTH + xx) * 4;
                png.data[i] = png.data[i + 1] = png.data[i + 2] = 0;
            }
        }
    };

    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (qr.modules.get(r, c)) black(offset + (c + margin) * scale, offset + (r + margin) * scale, scale, scale);
        }
    }

    // Code unter den QR-Code schreiben
    const textW = chars.length * 6 * fontScale - fontScale;
    let x = Math.floor((WIDTH - textW) / 2);
    const y = WIDTH - Math.round(margin * scale * 0.4);
    for (const ch of chars) {
        FONT[ch].forEach((row, ry) => [...row].forEach((bit, rx) => {
            if (bit === '1') black(x + rx * fontScale, y + ry * fontScale, fontScale, fontScale);
        }));
        x += 6 * fontScale;
    }
    return PNG.sync.write(png);
}

module.exports = { qrPngWithCode };
