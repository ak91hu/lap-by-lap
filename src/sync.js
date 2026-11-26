// Adatletöltés a Stravától helyi gyorsítótárba (data/athletes/<id>/…).
//
// Memória- és API-takarékosság (1000+ aktivitáshoz):
//  • az aktivitáslistából és a részletekből csak a könyvhöz szükséges mezőket tároljuk;
//  • az útvonal-adatsorok (streams) ritkítva, külön fájlban maradnak, és csak rajzoláskor töltjük be őket;
//  • a sorrend prioritásos: fotólisták → képek → leírások → magassági profilok, így ha elfogy
//    az API-keret, a legfontosabb adatok már megvannak;
//  • minden elem azonnal lemezre kerül, a letöltés bármikor (akár napokkal később) folytatható.
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { SkipApiError } from './strava.js';
import { athleteDir, readJson, writeJson, exists } from './store.js';
import { activityType, year } from './format.js';

sharp.cache({ memory: 64, files: 0, items: 64 });

const SUMMARY_FIELDS = [
  'id', 'name', 'sport_type', 'type', 'start_date', 'start_date_local', 'timezone', 'distance', 'moving_time',
  'elapsed_time', 'total_elevation_gain', 'average_speed', 'max_speed', 'average_heartrate', 'max_heartrate',
  'average_watts', 'device_watts', 'kilojoules', 'kudos_count', 'achievement_count', 'elev_high', 'elev_low',
  'total_photo_count', 'private', 'visibility', 'trainer', 'commute',
];

function trimSummary(a) {
  const o = {};
  for (const k of SUMMARY_FIELDS) if (a[k] !== undefined && a[k] !== null) o[k] = a[k];
  const poly = a.map?.summary_polyline;
  if (poly) o.polyline = poly;
  return o;
}

function trimDetail(d) {
  return {
    description: d.description || '',
    calories: d.calories || 0,
    device_name: d.device_name || '',
    gear_name: d.gear?.name || '',
  };
}

// ---------------------------------------------------------------- aktivitáslista

export async function syncActivities(client, athleteId, ctx) {
  const dir = athleteDir(athleteId);
  const athlete = await client.athlete();
  await writeJson(path.join(dir, 'athlete.json'), {
    id: athlete.id, firstname: athlete.firstname, lastname: athlete.lastname, city: athlete.city,
    state: athlete.state, country: athlete.country, profile: athlete.profile, profile_medium: athlete.profile_medium,
    measurement_preference: athlete.measurement_preference,
  });

  ctx.phase('phaseList');
  const all = [];
  for await (const page of client.activities()) {
    for (const a of page) all.push(trimSummary(a));
    ctx.tick(page.length);
  }
  all.sort((x, y) => x.start_date_local.localeCompare(y.start_date_local));
  await writeJson(path.join(dir, 'activities.json'), all);
  invalidate(athleteId);
  return summarize(all);
}

// Kis memóriabeli gyorsítótár a gyakran kért aktivitáslistához (mtime alapján érvényes).
const listCache = new Map();
function invalidate(id) {
  listCache.delete(id);
}

export async function loadActivities(athleteId) {
  const file = path.join(athleteDir(athleteId), 'activities.json');
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return null;
  }
  const hit = listCache.get(athleteId);
  if (hit && hit.mtime === st.mtimeMs) return hit.list;
  const list = await readJson(file, null);
  if (list) {
    // régebbi formátum (teljes Strava-objektum) átalakítása
    const norm = list.map((a) => (a.map ? trimSummary(a) : a));
    listCache.set(athleteId, { mtime: st.mtimeMs, list: norm });
    return norm;
  }
  return null;
}

export async function loadAthlete(athleteId) {
  return readJson(path.join(athleteDir(athleteId), 'athlete.json'), null);
}

export function summarize(list) {
  const years = {};
  const types = {};
  let photos = 0;
  let photoActivities = 0;
  for (const a of list) {
    const y = year(a);
    years[y] = (years[y] || 0) + 1;
    const t = activityType(a);
    types[t] ??= { count: 0, photos: 0 };
    types[t].count++;
    const pc = a.total_photo_count || 0;
    types[t].photos += pc;
    photos += pc;
    if (pc > 0) photoActivities++;
  }
  return {
    count: list.length, photos, photoActivities, years, types,
    first: list[0]?.start_date_local || null, last: list[list.length - 1]?.start_date_local || null,
  };
}

// ---------------------------------------------------------------- segédek

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function pickUrl(urls) {
  if (!urls) return null;
  const keys = Object.keys(urls).sort((a, b) => Number(b) - Number(a));
  for (const k of keys) {
    const u = urls[k];
    if (u && /^https?:\/\//.test(u) && !/placeholder/i.test(u)) return u;
  }
  return null;
}

const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

async function downloadImage(url, file) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_IMAGE_BYTES) throw new Error('too large');
  const buf = Buffer.from(await res.arrayBuffer());
  return storeImage(buf, file);
}

/** Megfelelő (sRGB, álló helyzetű) JPEG-et újrakódolás nélkül ment; minden mást egyszer átalakít. */
export async function storeImage(input, file) {
  const meta = await sharp(input, { failOn: 'none', limitInputPixels: 120e6 }).metadata();
  if (meta.format === 'jpeg' && (!meta.orientation || meta.orientation === 1) && (!meta.space || meta.space === 'srgb')) {
    if (Buffer.isBuffer(input)) await fs.writeFile(file, input);
    else if (input !== file) await fs.copyFile(input, file);
    return { w: meta.width, h: meta.height };
  }
  const info = await sharp(input, { failOn: 'none', limitInputPixels: 120e6 })
    .rotate()
    .resize({ width: 4000, height: 4000, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .jpeg({ quality: 90 })
    .toFile(file);
  return { w: info.width, h: info.height };
}

/** Legfeljebb ~600 pontra ritkítja az adatsorokat (nyomtatáshoz bőven elég). */
export function downsampleStreams(raw) {
  const latlng = raw?.latlng?.data;
  if (!Array.isArray(latlng) || latlng.length < 2) return { empty: true };
  const n = latlng.length;
  const step = Math.max(1, Math.ceil(n / 600));
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const pick = (arr, digits) => {
    if (!Array.isArray(arr) || arr.length !== n || !arr.some((v) => v != null)) return null;
    return idx.map((i) => (arr[i] == null ? null : digits == null ? arr[i] : Number(Number(arr[i]).toFixed(digits))));
  };
  return {
    latlng: idx.map((i) => [Number(latlng[i][0].toFixed(5)), Number(latlng[i][1].toFixed(5))]),
    altitude: pick(raw.altitude?.data, 1),
    distance: pick(raw.distance?.data, 0),
    time: pick(raw.time?.data),
  };
}

export async function loadStreams(file) {
  if (!file) return null;
  const s = await readJson(file);
  return s && !s.empty ? s : null;
}

// ---------------------------------------------------------------- könyv-előkészítés

/**
 * Letölti (vagy a gyorsítótárból veszi) a könyvhöz szükséges adatokat.
 * Visszatér: könnyű bejegyzések – a nagy adatsorok csak fájlútvonalként szerepelnek.
 * @returns {Promise<{entries: Array<{activity, photos, streamsFile}>, failedPhotos: number, skipped: boolean}>}
 */
export async function prepareEntries(client, athleteId, activities, ctx, opts = {}) {
  const { descriptions = true, streams = true, maxPhotos = 0 } = opts;
  const dir = athleteDir(athleteId);
  let skipped = false;
  // API-hívás: ha a felhasználó a „most készítsd el” gombot választja, a hiányzó adat kimarad.
  const api = async (fn) => {
    if (skipped) return undefined;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SkipApiError) {
        skipped = true;
        return undefined;
      }
      if (err.status === 404) return null; // törölt / nem elérhető elem
      throw err;
    }
  };

  const withPhotos = activities.filter((a) => (a.total_photo_count || 0) > 0);

  // 1) Fotólisták – ez a könyv lényege, ezért elsőként.
  ctx.phase('phasePhotoLists', withPhotos.length);
  const photoLists = new Map();
  await pool(withPhotos, 3, async (a) => {
    const file = path.join(dir, 'photos', `${a.id}.json`);
    let list = await readJson(file);
    // Az archívumból importált lista végleges; az API-s listát akkor frissítjük, ha változott a fotószám.
    if (!list || (list.source !== 'archive' && list.count !== a.total_photo_count)) {
      const raw = await api(() => client.photos(a.id));
      if (raw !== undefined) {
        list = {
          count: a.total_photo_count,
          items: (Array.isArray(raw) ? raw : []).map((p, i) => ({
            id: String(p.unique_id || p.id || `${a.id}-${i}`).replace(/[^\w.-]/g, '_'),
            url: pickUrl(p.urls),
            caption: (p.caption || '').trim().slice(0, 300),
            isVideo: p.media_type === 2 || Boolean(p.video_url),
            createdAt: p.created_at || null,
            location: Array.isArray(p.location) && p.location.length === 2 ? p.location : null,
          })).filter((p) => p.url),
        };
        await writeJson(file, list);
      }
    }
    if (list) photoLists.set(a.id, list);
    ctx.tick();
  });

  // 2) Képfájlok a CDN-ről (nem számít bele az API-keretbe). Aktivitásonként egy index-fájl.
  const totalImages = [...photoLists.values()].reduce((n, l) => n + l.items.length, 0);
  ctx.phase('phaseImages', totalImages);
  let failed = 0;
  const imageIndex = new Map();
  await pool([...photoLists.entries()], 6, async ([actId, list]) => {
    const imgDir = path.join(dir, 'images', String(actId));
    const indexFile = path.join(imgDir, 'index.json');
    const index = (await readJson(indexFile)) || {};
    let changed = false;
    for (const p of list.items) {
      const file = path.join(imgDir, `${p.id}.jpg`);
      if (!index[p.id] || !(await exists(file))) {
        try {
          await fs.mkdir(imgDir, { recursive: true });
          index[p.id] = await downloadImage(p.url, file);
          changed = true;
        } catch (err) {
          failed++;
          delete index[p.id];
          console.warn(`Photo download failed (${actId}/${p.id}): ${err.message}`);
        }
      }
      ctx.tick();
    }
    if (changed) await writeJson(indexFile, index);
    imageIndex.set(actId, index);
  });

  // 3) Részletek (leírás, kalória, eszköz) – csak a fotós aktivitásokhoz, ha kérték.
  const details = new Map();
  if (descriptions) {
    ctx.phase('phaseDetails', withPhotos.length);
    await pool(withPhotos, 3, async (a) => {
      const file = path.join(dir, 'details', `${a.id}.json`);
      let d = await readJson(file);
      if (d && d.id) { // régi formátum: teljes objektum → csak a szükséges mezők
        d = trimDetail(d);
        await writeJson(file, d);
      }
      if (!d) {
        const raw = await api(() => client.activity(a.id));
        if (raw) {
          d = trimDetail(raw);
          await writeJson(file, d);
        }
      }
      if (d) details.set(a.id, d);
      ctx.tick();
    });
  }

  // 4) Magassági profil + pontos útvonal. A helyben meglévő (archívumból importált vagy korábban
  //    letöltött) adatsort mindig használjuk; API-hívás csak akkor, ha kérték és van GPS-útvonal.
  const streamFiles = new Map();
  ctx.phase('phaseStreams', withPhotos.length);
  await pool(withPhotos, 3, async (a) => {
    const file = path.join(dir, 'streams', `${a.id}.json`);
    if (!(await exists(file)) && streams && a.polyline) {
      const raw = await api(() => client.streams(a.id));
      if (raw !== undefined) await writeJson(file, raw ? downsampleStreams(raw) : { empty: true });
    }
    if (await exists(file)) streamFiles.set(a.id, file);
    ctx.tick();
  });

  // 5) Könnyű bejegyzések időrendben.
  const entries = activities.map((a) => {
    const list = photoLists.get(a.id);
    const index = imageIndex.get(a.id) || {};
    let photos = [];
    if (list) {
      for (const p of list.items) {
        const m = index[p.id];
        if (!m) continue;
        photos.push({
          file: path.join(dir, 'images', String(a.id), `${p.id}.jpg`),
          width: m.w, height: m.h, caption: p.caption, isVideo: p.isVideo,
          createdAt: p.createdAt, createdAtLocal: p.createdAtLocal || null, location: p.location,
        });
      }
    }
    if (maxPhotos > 0 && photos.length > maxPhotos) photos = pickBest(photos, maxPhotos);
    const d = details.get(a.id);
    return { activity: d ? { ...a, ...d } : a, photos, streamsFile: streamFiles.get(a.id) || null };
  });
  entries.sort((x, y) => x.activity.start_date_local.localeCompare(y.activity.start_date_local));
  return { entries, failedPhotos: failed, skipped };
}

/** Ha korlátozott a fotószám: a nagyobb felbontású, aláírt, nem videós képek előnyben, eredeti sorrendben. */
function pickBest(photos, n) {
  const scored = photos.map((p, i) => ({
    p, i, score: (p.isVideo ? -5 : 0) + (p.caption ? 1 : 0) + Math.min(p.width, p.height) / 1000,
  }));
  return scored.sort((a, b) => b.score - a.score).slice(0, n).sort((a, b) => a.i - b.i).map((x) => x.p);
}

export async function downloadAvatar(athlete, athleteId) {
  const url = athlete?.profile;
  if (!url || !/^https:\/\//.test(url) || /avatar\/athlete\/large/.test(url)) return null;
  const file = path.join(athleteDir(athleteId), 'avatar.jpg');
  if (await exists(file)) return file;
  try {
    await downloadImage(url, file);
    return file;
  } catch {
    return null;
  }
}
