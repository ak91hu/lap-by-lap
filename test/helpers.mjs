// Közös tesztsegédek: ideiglenes adatmappa, mesterséges (kitalált) sportoló-adatok, ál-Strava szerver,
// az alkalmazás elindítása gyermekfolyamatként, aláírt munkamenet-süti és PDF-ellenőrzés.
// A tesztek SOHA nem nyúlnak a valódi data/ mappához és nem hívják a valódi Strava API-t.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SESSION_SECRET = 'test-session-secret';

export function tmpDir(prefix = 'lbl-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

// ---------------------------------------------------------------- mesterséges adatok

/** Zajos (valódi fotóhoz hasonlóan tömöríthető) JPEG a megadott méretben. */
export async function makeJpeg(width = 1600, height = 1067, seed = 1) {
  const hue = (seed * 47) % 255;
  return sharp({
    create: { width, height, channels: 3, background: { r: hue, g: 120, b: 255 - hue }, noise: { type: 'gaussian', mean: 120, sigma: 40 } },
  }).jpeg({ quality: 80 }).toBuffer();
}

/** Egyszerű, valószerű útvonal (kör) adott pont körül. */
export function makeTrack(lat, lng, n = 120, radius = 0.01) {
  const latlng = [];
  const altitude = [];
  const distance = [];
  const time = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    const a = (i / (n - 1)) * Math.PI * 2;
    const p = [Number((lat + Math.sin(a) * radius).toFixed(5)), Number((lng + Math.cos(a) * radius * 1.5).toFixed(5))];
    if (i) d += 25;
    latlng.push(p);
    altitude.push(200 + Math.round(Math.sin(a * 2) * 60));
    distance.push(d);
    time.push(i * 10);
  }
  return { latlng, altitude, distance, time };
}

/**
 * Kitalált sportoló a megadott adatmappában: aktivitáslista, fotólisták, képek, útvonalak, tokenek.
 * @returns {{id:number, activities:object[], photoActs:object[]}}
 */
export async function seedAthlete(dataDir, { id = 4242, count = 10, photoEvery = 2, photosPer = 3, years = [2025, 2026], img = [900, 600] } = {}) {
  const dir = path.join(dataDir, 'athletes', String(id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'tokens.json'), JSON.stringify({ accessToken: 'tok', refreshToken: 'ref', expiresAt: Math.floor(Date.now() / 1000) + 86400 }));
  fs.writeFileSync(path.join(dir, 'athlete.json'), JSON.stringify({ id, firstname: 'Teszt', lastname: 'Elek', city: 'Budapest', country: 'Hungary', measurement_preference: 'meters' }));
  const types = ['Run', 'Ride', 'Hike', 'Walk'];
  const activities = [];
  for (let i = 0; i < count; i++) {
    const y = years[i % years.length];
    const m = String((i % 12) + 1).padStart(2, '0');
    const day = String((i % 27) + 1).padStart(2, '0');
    const hasPhotos = i % photoEvery === 0;
    activities.push({
      id: id * 1000 + i,
      name: `Teszt tura ${i + 1}`,
      sport_type: types[i % types.length],
      type: types[i % types.length],
      start_date: `${y}-${m}-${day}T07:00:00Z`,
      start_date_local: `${y}-${m}-${day}T08:00:00Z`,
      distance: 5000 + i * 1300,
      moving_time: 1800 + i * 300,
      elapsed_time: 2000 + i * 300,
      total_elevation_gain: 80 + i * 15,
      average_speed: 2.7,
      max_speed: 5,
      average_heartrate: 140,
      kudos_count: i,
      achievement_count: i % 3,
      elev_high: 320,
      elev_low: 140,
      total_photo_count: hasPhotos ? photosPer : 0,
      private: i === 3,
      commute: i === 5,
      trainer: i === 7,
    });
  }
  activities.sort((a, b) => a.start_date_local.localeCompare(b.start_date_local));
  fs.writeFileSync(path.join(dir, 'activities.json'), JSON.stringify(activities));

  const photoActs = activities.filter((a) => a.total_photo_count > 0);
  for (const a of photoActs) {
    const imgDir = path.join(dir, 'images', String(a.id));
    fs.mkdirSync(imgDir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'photos'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'streams'), { recursive: true });
    const index = {};
    const items = [];
    for (let k = 0; k < a.total_photo_count; k++) {
      const pid = `p${a.id}_${k}`;
      const [w, h] = k % 2 ? [img[1], img[0]] : img; // álló és fekvő vegyesen
      fs.writeFileSync(path.join(imgDir, `${pid}.jpg`), await makeJpeg(w, h, a.id + k));
      index[pid] = { w, h };
      items.push({ id: pid, url: null, caption: k === 0 ? `Felirat ${a.name}` : '', isVideo: false, createdAt: null, createdAtLocal: null, location: null });
    }
    fs.writeFileSync(path.join(imgDir, 'index.json'), JSON.stringify(index));
    fs.writeFileSync(path.join(dir, 'photos', `${a.id}.json`), JSON.stringify({ count: a.total_photo_count, source: 'archive', items }));
    fs.writeFileSync(path.join(dir, 'streams', `${a.id}.json`), JSON.stringify(makeTrack(47.5 + photoActs.indexOf(a) * 0.01, 19.0)));
  }
  return { id, activities, photoActs };
}

/** Google encoded polyline (a Strava összefoglaló útvonalának formátuma). */
export function encodePolyline(points) {
  let out = '';
  let pLat = 0;
  let pLng = 0;
  const enc = (v) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (x >= 0x20) {
      s += String.fromCharCode((0x20 | (x & 0x1f)) + 63);
      x >>= 5;
    }
    return s + String.fromCharCode(x + 63);
  };
  for (const [lat, lng] of points) {
    const a = Math.round(lat * 1e5);
    const b = Math.round(lng * 1e5);
    out += enc(a - pLat) + enc(b - pLng);
    pLat = a;
    pLng = b;
  }
  return out;
}

// ---------------------------------------------------------------- ál-Strava szerver

/**
 * Ál-Strava (OAuth + API v3 + kép-CDN). Az `athletes` térkép: tokenazonosító → sportoló-leírás.
 * @returns {Promise<{url:string, oauthUrl:string, apiUrl:string, calls:string[], close():Promise<void>, state:object}>}
 */
export async function startMockStrava({ athleteId = 777, activities = 6, photosPer = 2 } = {}) {
  const calls = [];
  const state = { deauthorized: 0, tokenRequests: 0, fail429Once: new Set(), images: new Map() };
  const acts = Array.from({ length: activities }, (_, i) => ({
    id: athleteId * 100 + i,
    name: `Mock activity ${i + 1}`,
    sport_type: i % 2 ? 'Ride' : 'Run',
    type: i % 2 ? 'Ride' : 'Run',
    start_date: `2026-0${(i % 9) + 1}-10T06:00:00Z`,
    start_date_local: `2026-0${(i % 9) + 1}-10T07:00:00Z`,
    distance: 8000 + i * 1000,
    moving_time: 2400,
    elapsed_time: 2600,
    total_elevation_gain: 120,
    average_speed: 3.2,
    kudos_count: i,
    total_photo_count: i % 2 === 0 ? photosPer : 0,
    map: { summary_polyline: encodePolyline(makeTrack(46.07 + i * 0.01, 18.23, 30).latlng) },
  }));
  const jpeg = await makeJpeg(1200, 800, 3);

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(`${req.method} ${u.pathname}`);
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'x-ratelimit-limit': '100,1000', 'x-ratelimit-usage': `${calls.length % 50},${calls.length}`, ...headers });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (state.revoked && (u.pathname.startsWith('/api/v3/') || u.pathname === '/oauth/token')) {
      return send(401, { message: 'Authorization Error', errors: [{ resource: 'Application', code: 'invalid' }] });
    }
    if (state.fail429Once.has(u.pathname)) {
      state.fail429Once.delete(u.pathname);
      return send(429, { message: 'Rate Limit Exceeded' }, { 'x-ratelimit-usage': '100,500' });
    }
    if (u.pathname === '/oauth/token' && req.method === 'POST') {
      state.tokenRequests++;
      return send(200, {
        access_token: `acc-${state.tokenRequests}`, refresh_token: `ref-${state.tokenRequests}`, expires_at: Math.floor(Date.now() / 1000) + 21600,
        athlete: { id: athleteId, firstname: 'Mock', lastname: 'Athlete', city: 'Pécs', country: 'Hungary', profile: '', measurement_preference: 'meters' },
      });
    }
    if (u.pathname === '/oauth/deauthorize') {
      state.deauthorized++;
      return send(200, {});
    }
    if (u.pathname === '/api/v3/athlete') return send(200, { id: athleteId, firstname: 'Mock', lastname: 'Athlete', measurement_preference: 'meters' });
    if (u.pathname === '/api/v3/athlete/activities') return send(200, Number(u.searchParams.get('page')) === 1 ? acts : []);
    let m = u.pathname.match(/^\/api\/v3\/activities\/(\d+)\/photos$/);
    if (m) {
      const a = acts.find((x) => String(x.id) === m[1]);
      return send(200, Array.from({ length: a?.total_photo_count || 0 }, (_, k) => ({
        unique_id: `u-${m[1]}-${k}`, urls: { 2048: `http://127.0.0.1:${server.address().port}/cdn/${m[1]}-${k}.jpg` }, caption: k ? '' : 'Mock caption', created_at: null,
      })));
    }
    m = u.pathname.match(/^\/api\/v3\/activities\/(\d+)\/streams$/);
    if (m) {
      const t = makeTrack(46.07, 18.23, 80);
      return send(200, { latlng: { data: t.latlng }, altitude: { data: t.altitude }, distance: { data: t.distance }, time: { data: t.time } });
    }
    m = u.pathname.match(/^\/api\/v3\/activities\/(\d+)$/);
    if (m) return send(200, { id: Number(m[1]), description: `Leírás ${m[1]}`, calories: 500, device_name: 'Mock Watch', gear: { name: 'Mock Shoes' } });
    if (u.pathname.startsWith('/cdn/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(jpeg);
    }
    send(404, { message: 'Not Found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base, apiUrl: `${base}/api/v3`, oauthUrl: `${base}/oauth`, calls, state, acts,
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------- az alkalmazás indítása

/** Elindítja a szervert gyermekfolyamatként a megadott adatmappával; a visszaadott objektum HTTP-segédeket is ad. */
export async function startApp({ dataDir, strava, env = {} } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LAPBYLAP_NO_DOTENV: '1',
      PORT: String(port),
      BASE_URL: base,
      DATA_DIR: dataDir,
      STRAVA_CLIENT_ID: '12345',
      STRAVA_CLIENT_SECRET: 'test-secret',
      SESSION_SECRET,
      GEOIP: 'off',
      WEATHER: 'off',
      // ál-Strava nélkül is egy elérhetetlen helyi címre mutatunk: a tesztek soha nem hívják a valódi Stravát
      STRAVA_API_URL: strava ? strava.apiUrl : 'http://127.0.0.1:9/api/v3',
      STRAVA_OAUTH_URL: strava ? strava.oauthUrl : 'http://127.0.0.1:9/oauth',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) break;
    } catch { /* még indul */ }
    if (Date.now() > deadline || child.exitCode != null) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    base,
    child,
    log: () => log,
    stop: () => new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      child.once('exit', resolve);
      child.kill();
    }),
  };
}

/** Aláírt munkamenet-süti egy sportolóhoz (ugyanazzal a titokkal, amivel a tesztszerver fut). */
export function sessionCookie(athleteId, secret = SESSION_SECRET) {
  const payload = Buffer.from(JSON.stringify({ aid: athleteId })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `kk_s=${payload}.${sig}`;
}

/** Kis HTTP-kliens: JSON-válasz automatikus feldolgozással. */
export function client(base, cookie) {
  const call = async (method, url, { body, headers = {}, raw, form } = {}) => {
    const h = { ...(cookie ? { cookie } : {}), ...headers };
    let payload;
    if (form) {
      h['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (raw) payload = raw;
    else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    let json = null;
    if ((res.headers.get('content-type') || '').includes('json')) {
      try {
        json = JSON.parse(buf.toString('utf8'));
      } catch { /* */ }
    }
    return { status: res.status, headers: res.headers, json, buf };
  };
  return {
    get: (u, o) => call('GET', u, o),
    post: (u, o) => call('POST', u, o),
    put: (u, o) => call('PUT', u, o),
    del: (u, o) => call('DELETE', u, o),
    /** Elindított feladat lekérdezése a befejezésig. */
    async waitJob(jobId, timeoutMs = 120000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const r = await call('GET', `/api/jobs/${jobId}`);
        if (r.json?.status && r.json.status !== 'running') return r.json;
        if (Date.now() > until) throw new Error(`job ${jobId} timed out: ${JSON.stringify(r.json)}`);
        await new Promise((res) => setTimeout(res, 200));
      }
    },
  };
}

// ---------------------------------------------------------------- PDF-ellenőrzés (mupdf, fejlesztői függőség)

let mupdfMod;
export async function mupdf() {
  if (!mupdfMod) {
    const req = createRequire(path.join(ROOT, 'package.json'));
    mupdfMod = await import(pathToFileURL(req.resolve('mupdf')).href);
  }
  return mupdfMod;
}

/** Megnyitja a PDF-et, és visszaadja az oldalszámot, az oldalak szövegét és az első oldal dobozait. */
export async function inspectPdf(fileOrBuf) {
  const m = await mupdf();
  const buf = Buffer.isBuffer(fileOrBuf) ? fileOrBuf : fs.readFileSync(fileOrBuf);
  const doc = m.Document.openDocument(buf, 'application/pdf');
  const pages = doc.countPages();
  const text = [];
  for (let i = 0; i < pages; i++) text.push(doc.loadPage(i).toStructuredText().asText());
  const pdfDoc = doc.asPDF();
  const first = pdfDoc ? pdfDoc.findPage(0) : null;
  const box = (k) => {
    const v = first?.get(k);
    return v && v.isArray() ? [0, 1, 2, 3].map((i) => v.get(i).asNumber()) : null;
  };
  return { pages, text, mediaBox: box('MediaBox'), trimBox: box('TrimBox'), bleedBox: box('BleedBox'), head: buf.subarray(0, 8).toString('latin1') };
}

export const ctxStub = () => {
  const phases = [];
  return { phases, job: {}, phase: (k) => phases.push(k), tick() {}, wait() {}, clearWait() {} };
};
