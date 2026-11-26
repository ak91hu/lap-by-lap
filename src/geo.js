// Nyelvválasztás a látogató IP-címe alapján (Magyarország → magyar, egyébként angol).
// Helyi (loopback / privát) cím esetén a gép nyilvános IP-jének országát kérdezzük le,
// hiszen ilyenkor a felhasználó ugyanazon a gépen vagy hálózaton ül. Az eredmény gyorsítótárazva van.
import net from 'node:net';
import { GEOIP, DEFAULT_LANG } from './config.js';
import { normLang } from './i18n.js';

const cache = new Map(); // ip -> { country, at }
const TTL = 24 * 3600 * 1000;
const HU_COUNTRIES = new Set(['HU']);

function isPrivate(ip) {
  if (!ip) return true;
  const v4 = ip.replace(/^::ffff:/, '');
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip);
}

async function lookupCountry(ip) {
  const key = isPrivate(ip) ? 'self' : ip;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.country;
  let country = null;
  try {
    const url = key === 'self' ? GEOIP.url : new URL(encodeURIComponent(ip), GEOIP.url).toString();
    const res = await fetch(url, { signal: AbortSignal.timeout(2500), headers: { Accept: 'application/json' } });
    if (res.ok) country = String((await res.json()).country || '').toUpperCase() || null;
  } catch { /* hálózati hiba: marad a tartalék */ }
  cache.set(key, { country, at: Date.now() });
  return country;
}

function fromAcceptLanguage(header) {
  const first = String(header || '').split(',')[0].trim().toLowerCase();
  return first.startsWith('hu') ? 'hu' : null;
}

/** Sorrend: kézi választás (süti) → IP-ország → böngésző nyelve → alapértelmezés. */
export async function detectLang(req, chosen) {
  if (chosen) return { lang: normLang(chosen), source: 'manual' };
  if (GEOIP.enabled) {
    const country = await lookupCountry(req.ip);
    if (country) return { lang: HU_COUNTRIES.has(country) ? 'hu' : 'en', source: 'ip', country };
  }
  const al = fromAcceptLanguage(req.headers['accept-language']);
  if (al) return { lang: al, source: 'browser' };
  return { lang: DEFAULT_LANG, source: 'default' };
}
