// Konfiguráció: .env betöltése, tartós munkamenet-titok.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

try {
  process.loadEnvFile('.env');
} catch { /* nincs .env – környezeti változókból dolgozunk */ }

export const PORT = Number(process.env.PORT || 3000);
// Renderen a RENDER_EXTERNAL_URL magától adott (https://<név>.onrender.com), így a BASE_URL-t nem kell kézzel megadni.
export const BASE_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const STRAVA = {
  clientId: process.env.STRAVA_CLIENT_ID || '',
  clientSecret: process.env.STRAVA_CLIENT_SECRET || '',
};
export const MAP = {
  tileUrl: process.env.MAP_TILE_URL || '',
  attribution: process.env.MAP_ATTRIBUTION || '© OpenStreetMap contributors',
};
export const GEOIP = {
  enabled: process.env.GEOIP !== 'off',
  url: process.env.GEOIP_URL || 'https://api.country.is/',
};
export const DEFAULT_LANG = process.env.DEFAULT_LANG === 'hu' ? 'hu' : 'en';
// Express 'trust proxy': "true"/"false", ugrásszám (pl. "1"), vagy cím-/hálózatlista (pl. "loopback").
// Renderen a kliens IP-je csak a nyelvfelismeréshez kell, ezért ott a teljes X-Forwarded-For láncot elfogadjuk.
const parseTrust = (v) => (v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v);
export const TRUST_PROXY = parseTrust(process.env.TRUST_PROXY || (process.env.RENDER ? 'true' : 'loopback'));

export const isConfigured = () => Boolean(STRAVA.clientId && STRAVA.clientSecret);

fs.mkdirSync(DATA_DIR, { recursive: true });

/** Munkamenet-aláíró kulcs: .env-ből, vagy egyszer generálva és a data mappában megőrizve. */
export const SESSION_SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
})();
