// Terheléses teszt: N kitalált felhasználó egyszerre használja az alkalmazást, miközben könyvek készülnek.
// Méri a könnyű kérések válaszidejét (p50/p95/p99), a hibákat, a könyvek elkészülési idejét és a sorban állást,
// valamint a szerver memóriáját (/healthz). Kitalált adatokkal, ideiglenes mappában, ál-Strava szerverrel fut.
//
//   npm run loadtest                       # 30 felhasználó, 60 s, a Northflank-géphez hasonló korlátokkal
//   USERS=20 DURATION=30 node tools/loadtest.mjs
import { tmpDir, seedAthlete, startMockStrava, startApp, sessionCookie, client } from '../test/helpers.mjs';

const USERS = Number(process.env.USERS || 30);
const DURATION_S = Number(process.env.DURATION || 60);
const BOOKS = Number(process.env.BOOKS || Math.ceil(USERS / 2)); // ennyi felhasználó kér könyvet / előnézetet
const HEAVY = process.env.MAX_HEAVY_JOBS || '1'; // Northflank nf-compute-20: 512 MB → 1 nehéz feladat
const HEAP_MB = process.env.HEAP_MB || '384';

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

console.log(`Seeding ${USERS} fictional athletes…`);
const DATA = tmpDir('lbl-load-');
const athletes = [];
for (let i = 0; i < USERS; i++) athletes.push(await seedAthlete(DATA, { id: 10000 + i, count: 40, photoEvery: 4, photosPer: 4, img: [1000, 667] }));

const strava = await startMockStrava();
const app = await startApp({ dataDir: DATA, strava, env: { MAX_HEAVY_JOBS: HEAVY, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` } });
console.log(`Server: ${app.base} (MAX_HEAVY_JOBS=${HEAVY}, heap ≤ ${HEAP_MB} MB). Running ${USERS} users for ${DURATION_S}s, ${BOOKS} book requests…`);

const lat = {};
const errors = {};
const note = (name, ms, ok, status) => {
  (lat[name] ??= []).push(ms);
  if (!ok) errors[`${name} ${status}`] = (errors[`${name} ${status}`] || 0) + 1;
};
const timed = async (name, fn, okStatuses = [200]) => {
  const t = performance.now();
  try {
    const r = await fn();
    note(name, performance.now() - t, okStatuses.includes(r.status), r.status);
    return r;
  } catch (e) {
    note(name, performance.now() - t, false, e.code || 'ERR');
    return null;
  }
};

let rssMax = 0;
let queueMax = 0;
const sampler = setInterval(async () => {
  try {
    const h = await (await fetch(`${app.base}/healthz`)).json();
    rssMax = Math.max(rssMax, h.rssMb);
    queueMax = Math.max(queueMax, h.heavyJobs.queued);
  } catch { /* */ }
}, 500);

const until = Date.now() + DURATION_S * 1000;
const books = [];

async function user(i) {
  const a = athletes[i];
  const c = client(app.base, sessionCookie(a.id));
  await timed('status', () => c.get('/api/status'));
  await timed('activities', () => c.get('/api/activities'));
  const ph = await timed('photos', () => c.get('/api/photos'));
  const refs = ph?.json?.groups.flatMap(([act, , , list]) => list.map(([pid]) => `${act}/${pid}`)) || [];

  if (i < BOOKS) {
    const preview = i % 3 !== 0; // kétharmad előnézet, egyharmad teljes könyv
    const t0 = performance.now();
    const r = await timed('book-start', () => c.post('/api/book', { body: { preview, quality: preview ? 'screen' : 'print', title: `Könyv ${i}` } }));
    if (r?.json?.jobId) {
      books.push((async () => {
        let maxPos = 0;
        for (;;) {
          const j = (await c.get(`/api/jobs/${r.json.jobId}`)).json;
          maxPos = Math.max(maxPos, j?.queuePos || 0);
          if (j?.status !== 'running') return { i, preview, status: j?.status, error: j?.error, s: (performance.now() - t0) / 1000, pages: j?.result?.pages, maxPos };
          await new Promise((res) => setTimeout(res, 800));
        }
      })());
    }
  }

  let k = 0;
  while (Date.now() < until) {
    // a felület tipikus kérései: állapot, fotórács bélyegképekkel, beállítás-mentés, néha ZIP
    await timed('status', () => c.get('/api/status'));
    for (const ref of refs.slice((k * 4) % Math.max(1, refs.length), ((k * 4) % Math.max(1, refs.length)) + 4)) await timed('thumb', () => c.get(`/api/photos/${ref}?thumb`));
    await timed('settings-put', () => c.put('/api/settings', { body: { v: 1, form: { title: `T${k}` } } }));
    if (k % 5 === 0 && refs.length) await timed('zip-3', () => c.post('/api/photos/zip', { form: { ids: refs.slice(0, 3).join('\n') } }));
    k++;
    await new Promise((res) => setTimeout(res, 300 + Math.random() * 700)); // „gondolkodási idő”
  }
}

const t0 = performance.now();
await Promise.all(athletes.map((_, i) => user(i)));
console.log('Browsing finished; waiting for the remaining books…');
const results = await Promise.all(books);
clearInterval(sampler);
const total = (performance.now() - t0) / 1000;

console.log(`\n=== Results (${USERS} users, ${total.toFixed(0)} s) ===`);
console.log('request         n      p50     p95     p99     max (ms)');
for (const [name, arr] of Object.entries(lat)) {
  console.log(`${name.padEnd(14)} ${String(arr.length).padStart(5)} ${pct(arr, 50).toFixed(0).padStart(7)} ${pct(arr, 95).toFixed(0).padStart(7)} ${pct(arr, 99).toFixed(0).padStart(7)} ${Math.max(...arr).toFixed(0).padStart(7)}`);
}
console.log('\nerrors:', Object.keys(errors).length ? errors : 'none');
const okBooks = results.filter((r) => r.status === 'done');
console.log(`books: ${okBooks.length}/${results.length} done, failed: ${results.filter((r) => r.status !== 'done').map((r) => `${r.i}:${r.error}`).join('; ') || 'none'}`);
for (const kind of [true, false]) {
  const rs = okBooks.filter((r) => r.preview === kind);
  if (rs.length) console.log(`  ${kind ? 'previews' : 'full books'}: ${rs.length}, finished after ${Math.min(...rs.map((r) => r.s)).toFixed(0)}–${Math.max(...rs.map((r) => r.s)).toFixed(0)} s (incl. queue), pages ${Math.min(...rs.map((r) => r.pages))}–${Math.max(...rs.map((r) => r.pages))}`);
}
console.log(`max queue length: ${queueMax}, max queue position seen by a user: ${Math.max(0, ...results.map((r) => r.maxPos))}`);
console.log(`server RSS peak: ${rssMax} MB`);
await app.stop();
await strava.close();
process.exit(Object.keys(errors).length || okBooks.length !== results.length ? 1 : 0);
