// Strava-archívum (Beállítások → Fiókod → „Archívum kérése”) importálása.
//
// Miért? A Strava API alapkerete 100 hívás / 15 perc és 1000 / nap; aktivitásonként 1–3 hívással
// 1000 fotós aktivitás napokig tartana. Az archívum ugyanezeket a VALÓS adatokat egyben tartalmazza –
// leírásokat, GPS-fájlokat és az eredeti, teljes felbontású fotókat –, így a könyv percek alatt elkészül,
// aktivitásonként nulla API-hívással (és jobb nyomdai minőséggel, mint az API 2048 px-es képei).
//
// A ZIP-et nem csomagoljuk ki egészben: a központi könyvtárból csak a szükséges elemeket olvassuk,
// streamelve, korlátozott párhuzamossággal (alacsony memóriaigény több GB-os archívumnál is).
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import yauzl from 'yauzl';
import sharp from 'sharp';
import exifReader from 'exif-reader';
import { Decoder, Stream } from '@garmin/fitsdk';
import { athleteDir, readJson, writeJson, exists } from './store.js';
import { storeImage, downsampleStreams } from './sync.js';

const gunzipAsync = promisify(zlib.gunzip);
const gunzip = (buf) => gunzipAsync(buf, { maxOutputLength: MAX_TRACK }); // tömörítési bomba ellen
const IMAGE_EXT = /\.(jpe?g|png|webp|tiff?|avif|heic|heif)$/i;
const VIDEO_EXT = /\.(mp4|mov|m4v|avi|3gp)$/i;
const MAX_ENTRY = 400 * 1024 * 1024;
const MAX_TRACK = 64 * 1024 * 1024; // egy GPS-fájl (kibontva is) legfeljebb ekkora lehet
const MAX_ENTRIES = 300000; // ennél több fájlt tartalmazó ZIP gyanús (memória)
const POINT_SPAN = 4000; // egy <trkpt>/<Trackpoint> legfeljebb ennyi karakter: lineáris idejű feldolgozás

// ---------------------------------------------------------------- ZIP segédek

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: false, validateEntrySizes: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const map = new Map();
    zip.on('entry', (e) => {
      if (!/\/$/.test(e.fileName)) map.set(e.fileName.replace(/\\/g, '/'), e);
      if (map.size > MAX_ENTRIES) {
        zip.close();
        reject(Object.assign(new Error('archive:too-many-entries'), { code: 'EMPTY' }));
        return;
      }
      zip.readEntry();
    });
    zip.once('end', () => resolve(map));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function readEntry(zip, entry, max = MAX_ENTRY) {
  if (entry.uncompressedSize > max) return Promise.reject(new Error('entry too large'));
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('error', reject);
    });
  });
}

async function pool(items, size, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }));
}

// ---------------------------------------------------------------- CSV (RFC 4180, idézőjeles többsoros mezőkkel)

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0]);
}

/** Oszlopok azonosítása fejléc alapján, tartalom szerinti tartalékkal (lokalizált fejlécek esetére). */
function columns(rows) {
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const byName = (re) => head.findIndex((h) => re.test(h));
  const byContent = (re) => {
    for (let c = 0; c < head.length; c++) {
      let hits = 0;
      for (let r = 1; r < Math.min(rows.length, 60); r++) if (re.test(rows[r][c] || '')) hits++;
      if (hits >= 1) return c;
    }
    return -1;
  };
  const pick = (re, fallback) => {
    const i = byName(re);
    return i >= 0 ? i : fallback;
  };
  return {
    id: pick(/activity id/, 0),
    name: pick(/activity name/, 2),
    desc: pick(/activity description/, 4),
    gear: pick(/activity gear/, -1),
    file: byName(/^filename$/) >= 0 ? byName(/^filename$/) : byContent(/^activities\/.+\.(fit|gpx|tcx)(\.gz)?$/i),
    media: byName(/^media$/) >= 0 ? byName(/^media$/) : byContent(/(^|\|)media\/[^|]+\.\w+/i),
  };
}

// ---------------------------------------------------------------- GPS-fájlok

const SEMI = 180 / 2 ** 31;

function parseFit(buf) {
  const stream = Stream.fromBuffer(buf);
  const decoder = new Decoder(stream);
  if (!decoder.isFIT()) return null;
  const { messages } = decoder.read({ applyScaleAndOffset: true, expandComponents: true, convertDateTimesToDates: true });
  const recs = (messages.recordMesgs || []).filter((r) => r.positionLat != null && r.positionLong != null);
  if (recs.length < 2) return null;
  const t0 = new Date(recs[0].timestamp).getTime();
  return {
    latlng: { data: recs.map((r) => [r.positionLat * SEMI, r.positionLong * SEMI]) },
    altitude: { data: recs.map((r) => r.enhancedAltitude ?? r.altitude ?? null) },
    distance: { data: recs.map((r) => r.distance ?? null) },
    time: { data: recs.map((r) => Math.round((new Date(r.timestamp).getTime() - t0) / 1000)) },
  };
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`));
  return m ? Number(m[1]) : NaN;
}

function parseGpx(xml) {
  const pts = [];
  const re = new RegExp(`<trkpt\\b([^>]{0,500})>([\\s\\S]{0,${POINT_SPAN}}?)</trkpt>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = m[2].match(/<ele>([^<]+)<\/ele>/);
    const time = m[2].match(/<time>([^<]+)<\/time>/);
    pts.push([lat, lon, ele ? Number(ele[1]) : null, time ? Date.parse(time[1]) : null]);
  }
  return toStreams(pts, null);
}

function parseTcx(xml) {
  const pts = [];
  const dist = [];
  const re = new RegExp(`<Trackpoint>([\\s\\S]{0,${POINT_SPAN}}?)</Trackpoint>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const g = (tag) => {
      const r = m[1].match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
      return r ? r[1] : null;
    };
    const lat = Number(g('LatitudeDegrees'));
    const lon = Number(g('LongitudeDegrees'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || g('LatitudeDegrees') == null) continue;
    const alt = g('AltitudeMeters');
    const time = g('Time');
    const d = g('DistanceMeters');
    pts.push([lat, lon, alt != null ? Number(alt) : null, time ? Date.parse(time) : null]);
    dist.push(d != null ? Number(d) : null);
  }
  return toStreams(pts, dist);
}

function toStreams(pts, dist) {
  if (pts.length < 2) return null;
  const t0 = pts.find((p) => p[3] != null)?.[3];
  return {
    latlng: { data: pts.map((p) => [p[0], p[1]]) },
    altitude: { data: pts.map((p) => p[2]) },
    distance: { data: dist && dist.every((d) => d != null) ? dist : null },
    time: { data: t0 != null ? pts.map((p) => (p[3] != null ? Math.round((p[3] - t0) / 1000) : null)) : null },
  };
}

async function parseTrack(name, buf) {
  let data = buf;
  let n = name.toLowerCase();
  if (n.endsWith('.gz')) {
    data = await gunzip(buf);
    n = n.slice(0, -3);
  }
  if (n.endsWith('.fit')) return parseFit(data);
  if (n.endsWith('.gpx')) return parseGpx(data.toString('utf8'));
  if (n.endsWith('.tcx')) return parseTcx(data.toString('utf8').trim());
  return null;
}

// ---------------------------------------------------------------- EXIF

function dms(v, ref) {
  if (!Array.isArray(v) || v.length < 3) return null;
  const deg = v[0] + v[1] / 60 + v[2] / 3600;
  return /[SW]/i.test(ref || '') ? -deg : deg;
}

async function exifInfo(buf) {
  try {
    const meta = await sharp(buf, { failOn: 'none' }).metadata();
    if (!meta.exif) return {};
    const ex = exifReader(meta.exif);
    const gps = ex.GPSInfo || {};
    const lat = dms(gps.GPSLatitude, gps.GPSLatitudeRef);
    const lng = dms(gps.GPSLongitude, gps.GPSLongitudeRef);
    const taken = ex.Photo?.DateTimeOriginal || ex.Image?.DateTime || null;
    return {
      location: Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? [lat, lng] : null,
      // az EXIF-idő helyi idő zóna nélkül → a Strava start_date_local mezőjével vetjük össze
      createdAtLocal: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken.toISOString() : null,
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- import

const safeName = (s) => String(s).replace(/[^\w.-]/g, '_').slice(0, 120);

/**
 * @returns {Promise<{activities:number, photos:number, tracks:number, skippedVideos:number, unsupported:number}>}
 */
export async function importArchive(zipFile, athleteId, ctx) {
  const dir = athleteDir(athleteId);
  const zip = await openZip(zipFile);
  try {
    ctx.phase('phaseArchiveRead');
    const entries = await listEntries(zip);
    const csvName = [...entries.keys()].find((n) => /(^|\/)activities\.csv$/i.test(n));
    if (!csvName) throw Object.assign(new Error('archive:no-csv'), { code: 'NO_CSV' });
    const root = csvName.slice(0, csvName.length - 'activities.csv'.length);
    const rows = parseCsv((await readEntry(zip, entries.get(csvName))).toString('utf8').replace(/^﻿/, ''));
    if (rows.length < 2) throw Object.assign(new Error('archive:empty'), { code: 'EMPTY' });
    const col = columns(rows);

    // Opcionális media.csv a képaláírásokhoz (ha a Strava exportja tartalmazza).
    const captions = new Map();
    const mediaCsv = entries.get(`${root}media.csv`);
    if (mediaCsv) {
      const mrows = parseCsv((await readEntry(zip, mediaCsv)).toString('utf8').replace(/^﻿/, ''));
      const h = (mrows[0] || []).map((x) => x.toLowerCase());
      const fi = h.findIndex((x) => /filename/.test(x));
      const ci = h.findIndex((x) => /caption/.test(x));
      if (fi >= 0 && ci >= 0) for (const r of mrows.slice(1)) if (r[ci]) captions.set(r[fi].trim(), r[ci].trim());
    }

    const acts = [];
    for (const r of rows.slice(1)) {
      const id = Number(String(r[col.id] || '').trim());
      if (!Number.isFinite(id) || id <= 0) continue;
      const media = col.media >= 0 ? String(r[col.media] || '').split('|').map((x) => x.trim()).filter(Boolean) : [];
      acts.push({
        id,
        description: col.desc >= 0 ? (r[col.desc] || '').trim() : '',
        gear: col.gear >= 0 ? (r[col.gear] || '').trim() : '',
        file: col.file >= 0 ? (r[col.file] || '').trim() : '',
        media,
      });
    }

    // Leírások: minden aktivitáshoz (olcsó, csak fájlírás) – a meglévő részletadatokat kiegészítjük.
    for (const a of acts) {
      const f = path.join(dir, 'details', `${a.id}.json`);
      const old = (await readJson(f)) || {};
      await writeJson(f, { ...old, description: a.description || old.description || '', gear_name: a.gear || old.gear_name || '', source: 'archive' });
    }

    // Fotók
    const withMedia = acts.filter((a) => a.media.length);
    const totalMedia = withMedia.reduce((n, a) => n + a.media.length, 0);
    ctx.phase('phaseArchivePhotos', totalMedia);
    let photos = 0;
    let skippedVideos = 0;
    let unsupported = 0;
    await pool(withMedia, 4, async (a) => {
      const imgDir = path.join(dir, 'images', String(a.id));
      await fs.mkdir(imgDir, { recursive: true });
      const index = (await readJson(path.join(imgDir, 'index.json'))) || {};
      const items = [];
      for (const rel of a.media) {
        ctx.tick();
        if (VIDEO_EXT.test(rel)) {
          skippedVideos++;
          continue;
        }
        const entry = entries.get(`${root}${rel}`) || entries.get(rel);
        if (!entry || !IMAGE_EXT.test(rel)) {
          unsupported++;
          continue;
        }
        const pid = `a_${safeName(path.basename(rel).replace(/\.\w+$/, ''))}`;
        const file = path.join(imgDir, `${pid}.jpg`);
        try {
          let ex = {};
          if (!index[pid] || !(await exists(file))) {
            const buf = await readEntry(zip, entry);
            ex = await exifInfo(buf);
            index[pid] = { ...(await storeImage(buf, file)), ...ex };
          }
          const meta = index[pid];
          items.push({
            id: pid, url: null, caption: captions.get(rel) || '', isVideo: false,
            createdAt: null, createdAtLocal: meta.createdAtLocal || null, location: meta.location || null,
          });
          photos++;
        } catch {
          unsupported++; // pl. HEIC kodek nélkül, sérült fájl
        }
      }
      await writeJson(path.join(imgDir, 'index.json'), index);
      // Időrend a készítés ideje szerint (ha ismert), ez adja a történet sorrendjét.
      items.sort((p, q) => String(p.createdAtLocal || '').localeCompare(String(q.createdAtLocal || '')));
      await writeJson(path.join(dir, 'photos', `${a.id}.json`), { count: a.media.length, source: 'archive', items });
    });

    // GPS-fájlok a fotós aktivitásokhoz (magassági profil + pontos útvonal, API nélkül)
    const tracksTodo = withMedia.filter((a) => a.file);
    ctx.phase('phaseArchiveTracks', tracksTodo.length);
    let tracks = 0;
    await pool(tracksTodo, 4, async (a) => {
      const out = path.join(dir, 'streams', `${a.id}.json`);
      const entry = entries.get(`${root}${a.file}`) || entries.get(a.file);
      if (entry) {
        try {
          const raw = await parseTrack(a.file, await readEntry(zip, entry, MAX_TRACK));
          if (raw) {
            await writeJson(out, downsampleStreams(raw));
            tracks++;
          }
        } catch (err) {
          console.warn(`Track parse failed (${a.id}): ${err.message}`);
        }
      }
      ctx.tick();
    });

    const summary = { importedAt: new Date().toISOString(), activities: acts.length, photos, tracks, skippedVideos, unsupported };
    await writeJson(path.join(dir, 'archive.json'), summary);
    return summary;
  } finally {
    zip.close();
  }
}

export async function archiveInfo(athleteId) {
  return readJson(path.join(athleteDir(athleteId), 'archive.json'), null);
}
