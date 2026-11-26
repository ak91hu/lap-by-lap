// Biztonsági segédek: munkamenet-süti aláírása lejárattal, CSRF-védelem az Origin / Sec-Fetch-Site fejlécek
// alapján, egyszerű IP-alapú kéréskorlát, és a Strava-tokenek titkosítása tároláskor.
import crypto from 'node:crypto';

// ---------------------------------------------------------------- munkamenet

export const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/**
 * A süti neve. HTTPS-en `__Host-` előtaggal: ilyet a böngésző csak Secure, Path=/ és Domain nélküli formában fogad el,
 * így egy testvér-aldomain (pl. egy másik *.code.run alkalmazás) nem tudja felülírni („cookie tossing”).
 */
export const sessionCookieName = (secure) => (secure ? '__Host-lbl_s' : 'lbl_s');

export function signSession(data, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ ...data, iat: now })).toString('base64url');
  return `${payload}.${hmac(payload, secret)}`;
}

/** @returns {object|null} az érvényes, le nem járt munkamenet adatai */
export function verifySession(raw, secret, now = Date.now()) {
  const [payload, sig, extra] = String(raw || '').split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const want = hmac(payload, secret);
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || !Number.isFinite(data.iat)) return null;
  if (data.iat > now + 60000 || now - data.iat > SESSION_MAX_AGE_MS) return null; // lejárt vagy jövőbeli
  return data;
}

const hmac = (v, secret) => crypto.createHmac('sha256', secret).update(v).digest('base64url');

// ---------------------------------------------------------------- CSRF

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Állapotot módosító kérés csak a saját oldalról jöhet. A SameSite=Lax süti önmagában nem elég, mert a *.code.run
 * nincs a Public Suffix Listán: a böngésző egy másik ottani alkalmazást „ugyanannak a site-nak” tekint.
 * A böngészők minden ilyen kérésnél küldik az Origin és/vagy Sec-Fetch-Site fejlécet; ha egyik sincs (pl. curl),
 * az nem böngészős támadás, átengedjük.
 */
export function csrfGuard(baseUrl) {
  const own = new URL(baseUrl).origin;
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const site = req.get('sec-fetch-site');
    const origin = req.get('origin');
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'Cross-site request blocked' });
    if (origin && origin !== own) return res.status(403).json({ error: 'Cross-origin request blocked' });
    next();
  };
}

// ---------------------------------------------------------------- kéréskorlát

/**
 * Fix ablakos, IP-nkénti korlát (memóriában). Visszafogott értékek: a normál használatot nem zavarja, de egy
 * elszabadult kliens vagy szándékos elárasztás nem tudja lefoglalni az egész szervert.
 */
export function rateLimit({ windowMs = 60000, max = 600, name = 'rl' } = {}) {
  const hits = new Map(); // ip -> { n, reset }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || '?';
    let h = hits.get(key);
    if (!h || h.reset <= now) {
      h = { n: 0, reset: now + windowMs };
      hits.set(key, h);
    }
    h.n++;
    if (h.n > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests', limit: name });
    }
    next();
  };
}

// ---------------------------------------------------------------- tokenek titkosítása tároláskor

/** AES-256-GCM kulcs a TOKEN_KEY-ből, ennek hiányában a munkamenet-titokból (HKDF), külön céllal. */
export function tokenKey(secret, explicit = process.env.TOKEN_KEY) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(explicit || secret), Buffer.from('lap-by-lap'), Buffer.from('strava-tokens-v1'), 32));
}

export function encryptJson(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, enc: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64') };
}

/** Titkosított vagy (régi) titkosítatlan tartalom; hibás kulcsnál / sérült adatnál null. */
export function decryptJson(stored, key) {
  if (!stored || typeof stored !== 'object') return null;
  if (stored.v !== 1 || typeof stored.enc !== 'string') return stored.accessToken ? stored : null; // régi formátum
  try {
    const buf = Buffer.from(stored.enc, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch {
    return null;
  }
}
