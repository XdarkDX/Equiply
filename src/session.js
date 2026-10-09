const jwt = require('jsonwebtoken');
const { HttpError } = require('./util');

const COOKIE = 'equiply_session';
const ALL_PERMISSIONS = { can_manage_users: true, can_manage_items: true, can_borrow_return: true };

function parseCookies(header) {
    const out = {};
    for (const part of (header || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function createSessions(db, config) {
    const userById = db.prepare(`
        SELECT n.id, n.verein_id, n.username, n.email, n.role, n.vereins_rolle_id, n.token_version,
               r.can_manage_users, r.can_manage_items, r.can_borrow_return, v.name AS verein_name, v.farbe AS verein_farbe, v.logo AS verein_logo
        FROM nutzer n
        JOIN vereine v ON v.id = n.verein_id
        LEFT JOIN vereins_rollen r ON r.id = n.vereins_rolle_id
        WHERE n.id = ?`);

    function startSession(req, res, user) {
        const maxAge = config.sessionDays * 24 * 60 * 60;
        const token = jwt.sign({ uid: user.id, tv: user.token_version }, config.jwtSecret, { expiresIn: maxAge });
        res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: maxAge * 1000, path: '/' });
    }

    function endSession(req, res) {
        res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', secure: req.secure, path: '/' });
    }

    // Lädt den Nutzer bei jeder Anfrage frisch: gelöschte Nutzer, geänderte Rechte und
    // Passwortänderungen (token_version) wirken sofort.
    function authenticate(req, res, next) {
        const token = parseCookies(req.headers.cookie)[COOKIE];
        if (!token) throw new HttpError(401, 'Bitte einloggen.');
        let payload;
        try { payload = jwt.verify(token, config.jwtSecret); } catch (e) { throw new HttpError(401, 'Sitzung abgelaufen. Bitte neu einloggen.'); }
        const user = userById.get(payload.uid);
        if (!user || user.token_version !== payload.tv) throw new HttpError(401, 'Sitzung abgelaufen. Bitte neu einloggen.');
        user.permissions = user.role === 'admin' ? ALL_PERMISSIONS : {
            can_manage_users: !!user.can_manage_users, can_manage_items: !!user.can_manage_items, can_borrow_return: !!user.can_borrow_return,
        };
        req.user = user;
        next();
    }

    return { startSession, endSession, authenticate, userById };
}

const requirePermission = (perm) => (req, res, next) => {
    if (!req.user.permissions[perm]) throw new HttpError(403, 'Dir fehlen die Rechte für diese Aktion.');
    next();
};
const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') throw new HttpError(403, 'Nur Admins dürfen das.');
    next();
};

// Bremst Passwort-Raten: max. `limit` Fehlversuche pro IP in `windowMs`.
function createLoginLimiter({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
    const attempts = new Map();
    const cleanup = setInterval(() => {
        const now = Date.now();
        for (const [ip, a] of attempts) if (a.reset < now) attempts.delete(ip);
    }, windowMs);
    cleanup.unref();

    return {
        check(req) {
            const a = attempts.get(req.ip);
            if (a && a.reset > Date.now() && a.count >= limit) {
                const min = Math.ceil((a.reset - Date.now()) / 60000);
                throw new HttpError(429, `Zu viele Fehlversuche. Bitte in ${min} Minute${min === 1 ? '' : 'n'} erneut versuchen.`);
            }
        },
        fail(req) {
            const now = Date.now();
            const a = attempts.get(req.ip);
            if (!a || a.reset < now) attempts.set(req.ip, { count: 1, reset: now + windowMs });
            else a.count++;
        },
        success(req) { attempts.delete(req.ip); },
    };
}

module.exports = { createSessions, createLoginLimiter, requirePermission, requireAdmin };
