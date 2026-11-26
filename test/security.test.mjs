// Biztonsági tesztek: munkamenet (aláírás, lejárat), tokenek titkosítása, CSRF (idegen és testvér-aldomain),
// kéréskorlát, hibás sütik, __Host- előtag, biztonsági fejlécek, archívum-bombák, IP-ellenőrzés a nyelvfelismerésnél.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import yazl from 'yazl';
import { tmpDir, seedAthlete, startApp, startMockStrava, sessionCookie, client, ctxStub, SESSION_SECRET } from './helpers.mjs';

const DATA = tmpDir();
process.env.LAPBYLAP_NO_DOTENV = '1';
process.env.DATA_DIR = DATA;
process.env.SESSION_SECRET = SESSION_SECRET;
const sec = await import('../src/security.js');
const store = await import('../src/store.js');
const { importArchive } = await import('../src/archive.js');

// ---------------------------------------------------------------- egységtesztek

test('munkamenet: aláírás, lejárat, jövőbeli időpont, manipuláció', () => {
  const now = Date.now();
  const raw = sec.signSession({ aid: 5 }, 's1', now);
  assert.equal(sec.verifySession(raw, 's1', now).aid, 5);
  assert.equal(sec.verifySession(raw, 's2', now), null, 'más titok');
  assert.equal(sec.verifySession(raw, 's1', now + sec.SESSION_MAX_AGE_MS + 1000), null, 'lejárt');
  assert.equal(sec.verifySession(sec.signSession({ aid: 5 }, 's1', now + 3600e3), 's1', now), null, 'jövőbeli');
  const [p, s] = raw.split('.');
  const forged = Buffer.from(JSON.stringify({ aid: 6, iat: now })).toString('base64url');
  assert.equal(sec.verifySession(`${forged}.${s}`, 's1', now), null, 'átírt tartalom');
  assert.equal(sec.verifySession(`${p}.${s}.x`, 's1', now), null);
  assert.equal(sec.verifySession('', 's1', now), null);
  const noIat = Buffer.from(JSON.stringify({ aid: 5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 's1').update(noIat).digest('base64url');
  assert.equal(sec.verifySession(`${noIat}.${sig}`, 's1', now), null, 'lejárat nélküli (régi) süti');
  assert.equal(sec.sessionCookieName(true), '__Host-lbl_s');
  assert.equal(sec.sessionCookieName(false), 'lbl_s');
});

test('tokenek titkosítása: oda-vissza, rossz kulcs, sérült adat, régi formátum', () => {
  const k1 = sec.tokenKey('secret-a');
  const k2 = sec.tokenKey('secret-b');
  const t = { accessToken: 'a', refreshToken: 'r', expiresAt: 1 };
  const enc = sec.encryptJson(t, k1);
  assert.equal(enc.v, 1);
  assert.ok(!JSON.stringify(enc).includes('"r"'), 'a token nem olvasható a fájlban');
  assert.deepEqual(sec.decryptJson(enc, k1), t);
  assert.equal(sec.decryptJson(enc, k2), null);
  assert.equal(sec.decryptJson({ v: 1, enc: `${enc.enc.slice(0, -4)}AAAA` }, k1), null);
  assert.deepEqual(sec.decryptJson(t, k1), t, 'régi, titkosítatlan fájl még olvasható');
  assert.notDeepEqual(sec.tokenKey('x', 'explicit'), sec.tokenKey('x'), 'TOKEN_KEY felülírja');
});

test('tokenek a lemezen titkosítva; a régi titkosítatlan fájl első olvasáskor titkosítva újraíródik', async () => {
  await store.saveTokens(11, { accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: 9e9 });
  const file = path.join(store.athleteDir(11), 'tokens.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('secret-access') && !raw.includes('secret-refresh'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const legacy = path.join(store.athleteDir(12), 'tokens.json');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, JSON.stringify({ accessToken: 'old-plain', refreshToken: 'x', expiresAt: 9e9 }));
  assert.equal((await store.loadTokens(12)).accessToken, 'old-plain');
  assert.ok(!fs.readFileSync(legacy, 'utf8').includes('old-plain'), 'migrálva');

  assert.equal(await store.loadTokens(14), null, 'hiányzó fájl');
});

test('archívum: tömörítési bomba (.gpx.gz) és lezáratlan GPX-pontok nem fagyasztják le a szervert', async () => {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('Activity ID,Activity Name,Filename,Media\n1,Bomba,activities/1.gpx.gz,media/a.jpg\n2,Lassú,activities/2.gpx,media/b.jpg\n'), 'activities.csv');
  const tiny = await (await import('sharp')).default({ create: { width: 20, height: 20, channels: 3, background: '#888' } }).jpeg().toBuffer();
  zip.addBuffer(tiny, 'media/a.jpg');
  zip.addBuffer(tiny, 'media/b.jpg');
  zip.addBuffer(zlib.gzipSync(Buffer.alloc(200 * 1024 * 1024, 0x20)), 'activities/1.gpx.gz'); // 200 MB kibontva
  zip.addBuffer(Buffer.from(`<gpx>${'<trkpt lat="1" lon="2"><ele>1</ele>'.repeat(60000)}</gpx>`), 'activities/2.gpx'); // sosem zárul
  zip.end();
  const file = path.join(DATA, 'bomb.zip');
  await new Promise((r) => zip.outputStream.pipe(fs.createWriteStream(file)).on('close', r));
  const t0 = Date.now();
  const sum = await importArchive(file, 21, ctxStub());
  const ms = Date.now() - t0;
  assert.equal(sum.photos, 2);
  assert.equal(sum.tracks, 0, 'egyik sem lett útvonal');
  assert.ok(ms < 8000, `lineáris idő: ${ms} ms`);
});

// ---------------------------------------------------------------- a valódi szerveren

let app;
let httpsLike;
const HTTPS_DATA = tmpDir();
let strava;
let geo;
const geoHits = [];

before(async () => {
  await seedAthlete(DATA, { id: 51, count: 3, photoEvery: 9 });
  strava = await startMockStrava({ athleteId: 52 });
  geo = http.createServer((req, res) => {
    geoHits.push(req.url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ country: req.url.includes('8.8.8.8') ? 'US' : '<script>' }));
  });
  await new Promise((r) => geo.listen(0, '127.0.0.1', r));
  app = await startApp({ dataDir: DATA, strava, env: { GEOIP: 'on', GEOIP_URL: `http://127.0.0.1:${geo.address().port}/`, TRUST_PROXY: 'true' } });
  // HTTPS-es BASE_URL-lel (a szerver maga HTTP-n fut, mint egy proxy mögött): __Host- süti, HSTS
  httpsLike = await startApp({ dataDir: HTTPS_DATA, strava, env: { BASE_URL: 'https://lap.example.com' } });
});

after(async () => {
  await app?.stop();
  await httpsLike?.stop();
  await strava?.close();
  await new Promise((r) => geo.close(r));
});

test('CSRF: idegen eredetű és testvér-aldomainről (same-site) jövő módosító kérés tiltva, saját oldalról engedve', async () => {
  const c = client(app.base, sessionCookie(51));
  const body = { v: 1 };
  assert.equal((await c.put('/api/settings', { body, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.put('/api/settings', { body, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await c.put('/api/settings', { body, headers: { 'Sec-Fetch-Site': 'same-site', Origin: 'https://other-app.code.run' } })).status, 403);
  assert.equal((await c.post('/api/photos/zip', { form: { all: '1' }, headers: { Origin: 'https://other-app.code.run' } })).status, 403, 'a ZIP-űrlap is');
  assert.equal((await c.post('/api/forget', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  assert.equal((await c.put('/api/settings', { body, headers: { Origin: app.base, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await c.get('/api/settings', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'olvasás nem érintett');
});

test('hibás kódolású vagy idegen („bedobott”) süti nem dönti el a kérést', async () => {
  const r = await client(app.base, 'kk_lang=%E0%A4%A; lbl_s=%%%; x=1').get('/api/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.loggedIn, false);
});

test('lejárt munkamenet és régi formátumú (lejárat nélküli) süti nem érvényes', async () => {
  const old = sessionCookie(51, SESSION_SECRET, { iat: Date.now() - 31 * 86400e3 });
  assert.equal((await client(app.base, old).get('/api/activities')).status, 401);
  assert.equal((await client(app.base, sessionCookie(51)).get('/api/activities')).status, 200);
});

test('kéréskorlát: a bejelentkezés indítása IP-nként percenként legfeljebb 60-szor', async () => {
  const codes = [];
  for (let i = 0; i < 64; i++) codes.push((await client(app.base).get('/auth/login')).status);
  assert.equal(codes.filter((c) => c === 302).length, 60);
  assert.equal(codes.at(-1), 429);
});

test('OAuth után a tokenek titkosítva kerülnek a lemezre', async () => {
  const login = await client(httpsLike.base).get('/auth/login');
  const setCookie = login.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-lbl_s=/, '__Host- előtag HTTPS-en');
  assert.match(setCookie, /Secure/i);
  assert.doesNotMatch(setCookie, /Domain=/i);
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const cb = await client(httpsLike.base, setCookie.split(';')[0]).get(`/auth/callback?code=ok&state=${state}&scope=read,activity:read_all`);
  assert.equal(cb.status, 302);
  const raw = fs.readFileSync(path.join(HTTPS_DATA, 'athletes', '52', 'tokens.json'), 'utf8');
  assert.match(raw, /"enc":/);
  assert.doesNotMatch(raw, /acc-\d|ref-\d/, 'az ál-Strava tokenjei nem olvashatók a fájlban');
});

test('biztonsági fejlécek: CSP frame-ancestors, COOP, CORP, Permissions-Policy; HSTS HTTPS-en', async () => {
  const r = await client(app.base).get('/');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(r.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(r.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(r.headers.get('strict-transport-security'), null, 'HTTP-n nincs HSTS');
  assert.match((await client(httpsLike.base).get('/')).headers.get('strict-transport-security'), /max-age=31536000/);
});

test('nyelvfelismerés: hamisított, nem IP-cím értékre nincs külső lekérdezés; érvénytelen országkód eldobva', async () => {
  geoHits.length = 0;
  await client(app.base).get('/api/status', { headers: { 'X-Forwarded-For': '../../admin?x=' } });
  assert.equal(geoHits.length, 0);
  const us = (await client(app.base).get('/api/status', { headers: { 'X-Forwarded-For': '8.8.8.8' } })).json;
  assert.equal(us.country, 'US');
  const bad = (await client(app.base).get('/api/status', { headers: { 'X-Forwarded-For': '9.9.9.9' } })).json;
  assert.equal(bad.country, null, 'a <script> „országkód” nem kerül a válaszba');
  await Promise.all(Array.from({ length: 5 }, () => client(app.base).get('/api/status', { headers: { 'X-Forwarded-For': '4.4.4.4' } })));
  assert.equal(geoHits.filter((u) => u.includes('4.4.4.4')).length, 1, 'párhuzamos kérések egy lekérdezéssel');
});
