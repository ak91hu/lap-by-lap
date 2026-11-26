// Időjárás az aktivitás kezdetekor az Open-Meteo ingyenes, kulcs nélküli API-jából.
// Adatvédelem: a rajtpontot ~10 km-re kerekítve küldjük el, csak a dátummal és az órával együtt,
// és az eredményt aktivitásonként gyorsítótárazzuk (data/athletes/<id>/weather/<aktivitás>.json).
import path from 'node:path';
import { athleteDir, readJson, writeJson } from './store.js';
import { loadStreams } from './sync.js';
import { decodePolyline } from './pdf/polyline.js';
import { activityType } from './format.js';

const ENABLED = process.env.WEATHER !== 'off';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST = 'https://api.open-meteo.com/v1/forecast'; // az archívum néhány napot késik; a friss napokat innen kérjük

export const weatherEnabled = () => ENABLED;

/** Rajtpont: a pontos útvonal első pontja, ennek hiányában az összefoglaló polyline első pontja. */
async function startPoint(activity, streamsFile) {
  const s = streamsFile ? await loadStreams(streamsFile).catch(() => null) : null;
  const ll = s?.latlng?.[0];
  if (Array.isArray(ll) && ll.length === 2) return ll;
  const pts = decodePolyline(activity.polyline || '');
  return pts.length ? pts[0] : null;
}

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'LapByLap/2.0 (photobook; low volume)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * @returns {Promise<{t:number, code:number, wind:number}|null>} hőmérséklet (°C), WMO-időjáráskód, szél (km/h)
 */
export async function activityWeather(athleteId, activity, streamsFile) {
  if (!ENABLED) return null;
  const type = activityType(activity);
  if (activity.trainer || /^Virtual/.test(type)) return null;
  const file = path.join(athleteDir(athleteId), 'weather', `${activity.id}.json`);
  const cached = await readJson(file);
  if (cached) return cached.none ? null : cached;

  const local = String(activity.start_date_local || '');
  const day = local.slice(0, 10);
  const hour = Number(local.slice(11, 13));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const pt = await startPoint(activity, streamsFile);
  if (!pt) {
    await writeJson(file, { none: true });
    return null;
  }
  const lat = Math.round(pt[0] * 10) / 10;
  const lon = Math.round(pt[1] * 10) / 10;
  const ageDays = (Date.now() - Date.parse(`${day}T12:00:00Z`)) / 86400000;
  const base = ageDays < 60 ? FORECAST : ARCHIVE;
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), start_date: day, end_date: day,
    hourly: 'temperature_2m,weather_code,wind_speed_10m', timezone: 'auto',
  });
  try {
    const data = await fetchJson(`${base}?${q}`);
    const h = data.hourly;
    const i = Math.max(0, Math.min((h?.time?.length || 1) - 1, Number.isFinite(hour) ? hour : 12));
    const t = h?.temperature_2m?.[i];
    const code = h?.weather_code?.[i];
    if (typeof t !== 'number' || typeof code !== 'number') {
      await writeJson(file, { none: true });
      return null;
    }
    const w = { t: Math.round(t * 10) / 10, code, wind: Math.round(h.wind_speed_10m?.[i] ?? 0) };
    await writeJson(file, w);
    return w;
  } catch {
    return null; // hálózati hiba: nem gyorsítótárazzuk, legközelebb újrapróbáljuk
  }
}

/** WMO-időjáráskód → szövegkulcs (i18n: wx.<kulcs>). */
export function weatherKey(code) {
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

/** A fotós aktivitások bejegyzéseit kiegészíti az időjárással (activity.weather), korlátozott párhuzamossággal. */
export async function addWeather(athleteId, entries, ctx) {
  if (!ENABLED) return;
  const todo = entries.filter((e) => e.photos.length);
  ctx?.phase('phaseWeather', todo.length);
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const e = todo[next++];
      const w = await activityWeather(athleteId, e.activity, e.streamsFile).catch(() => null);
      if (w) e.activity = { ...e.activity, weather: w };
      ctx?.tick();
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}
