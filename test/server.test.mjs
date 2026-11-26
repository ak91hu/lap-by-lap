// Integrációs tesztek: a valódi szerver gyermekfolyamatként, ál-Strava szerverrel és kitalált adatokkal.
// A teljes felhasználói út: bejelentkezés → szinkron → fotók → ZIP → beállítások → borító → könyv → törlés,
// valamint a jogosultsági és bemenet-ellenőrzési szabályok.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { tmpDir, seedAthlete, startMockStrava, startApp, sessionCookie, client, inspectPdf, makeJpeg } from './helpers.mjs';

let DATA;
let strava;
let app;
let seeded;

before(async () => {
  DATA = tmpDir();
  strava = await startMockStrava({ athleteId: 777, activities: 6, photosPer: 2 });
  seeded = await seedAthlete(DATA, { id: 888, count: 10, photoEvery: 2, photosPer: 3, img: [800, 533] });
  app = await startApp({ dataDir: DATA, strava, env: { ARCHIVE_MAX_GB: String(3 / 1024) } }); // 3 MB-os feltöltési korlát
});

after(async () => {
  await app?.stop();
  await strava?.close();
});

const anon = () => client(app.base);
const as = (id) => client(app.base, sessionCookie(id));

function zipNames(buf) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const names = [];
      zip.on('entry', (e) => {
        names.push(e.fileName);
        zip.readEntry();
      });
      zip.on('end', () => resolve(names));
      zip.readEntry();
    });
  });
}

// ---------------------------------------------------------------- nyilvános végpontok

test('kezdőoldal, statikus fájlok, biztonsági fejlécek, gyorsítótár-szabályok', async () => {
  const r = await anon().get('/');
  assert.equal(r.status, 200);
  assert.match(r.buf.toString(), /<title>Lap by Lap<\/title>/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('cache-control'), 'no-cache', 'a HTML-t mindig újraellenőrzi');
  assert.equal((await anon().get('/app.js')).headers.get('cache-control'), 'no-cache');
  assert.equal((await anon().get('/i18n.js')).headers.get('cache-control'), 'no-cache');
  assert.match((await anon().get('/sample/hu/p01.webp')).headers.get('cache-control'), /max-age=3600/);
  const wk = await anon().get('/.well-known/onesvibe.txt');
  assert.equal(wk.status, 200);
  assert.match(wk.buf.toString(), /^ov-/);
  const font = await anon().get('/fonts/inter/package.json');
  assert.equal(font.status, 200);
});

test('állapot bejelentkezés nélkül és egészségjelzés', async () => {
  const st = await anon().get('/api/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.loggedIn, false);
  assert.equal(st.json.configured, true);
  assert.equal(st.json.redirectDomain, '127.0.0.1');
  const h = await anon().get('/healthz');
  assert.equal(h.json.ok, true);
  assert.ok(h.json.rssMb > 0);
  assert.ok(h.json.heavyJobs.limit >= 1);
});

test('nyelvválasztás: süti, X-Lang és Accept-Language', async () => {
  const set = await anon().post('/api/lang', { body: { lang: 'hu' } });
  assert.equal(set.json.lang, 'hu');
  assert.match(set.headers.get('set-cookie'), /kk_lang=hu/);
  const browser = await anon().get('/api/status', { headers: { 'accept-language': 'hu-HU,hu;q=0.9' } });
  assert.equal(browser.json.lang, 'hu');
  assert.equal(browser.json.langSource, 'browser');
  const manual = await anon().get('/api/status', { headers: { cookie: 'kk_lang=en', 'accept-language': 'hu' } });
  assert.equal(manual.json.lang, 'en');
});

// ---------------------------------------------------------------- jogosultság

test('védett végpontok bejelentkezés nélkül 401-et adnak', async () => {
  const urls = [
    ['get', '/api/activities'], ['get', '/api/photos'], ['get', '/api/settings'], ['get', '/api/books'],
    ['post', '/api/sync'], ['post', '/api/book'], ['post', '/api/photos/fetch'], ['post', '/api/forget'],
    ['get', `/api/photos/${seeded.photoActs[0].id}/p${seeded.photoActs[0].id}_0`], ['put', '/api/settings'],
  ];
  for (const [m, u] of urls) assert.equal((await anon()[m](u, m === 'put' ? { body: {} } : undefined)).status, 401, `${m} ${u}`);
});

test('hamisított vagy idegen titokkal aláírt süti nem ad hozzáférést', async () => {
  const forged = client(app.base, sessionCookie(888, 'wrong-secret'));
  assert.equal((await forged.get('/api/activities')).status, 401);
  const garbage = client(app.base, 'kk_s=abc.def');
  assert.equal((await garbage.get('/api/activities')).status, 401);
  const unknown = client(app.base, sessionCookie(123456));
  assert.equal((await unknown.get('/api/activities')).status, 401, 'token nélküli sportoló');
});

test('útvonal-bejárás és hibás azonosítók elutasítva', async () => {
  const c = as(888);
  assert.equal((await c.get('/api/books/..%2F..%2Fathletes%2F888%2Ftokens.json')).status, 400);
  assert.equal((await c.get('/api/books/x.txt')).status, 400);
  assert.equal((await c.get('/api/photos/abc/def')).status, 400);
  assert.equal((await c.get('/api/photos/123/..%2F..%2Ftokens')).status, 400);
  assert.equal((await c.get('/api/cover/..%2Ftokens.json')).status, 400);
  assert.equal((await c.post('/api/cover/photo', { body: { ref: '../../tokens' } })).status, 400);
  assert.equal((await c.post('/api/photos/zip', { form: { ids: '../x\n1/../../y' } })).status, 400);
  assert.equal((await c.put('/api/settings', { body: [1, 2] })).status, 400);
  assert.equal((await c.get('/api/jobs/nincs-ilyen')).status, 404);
});

// ---------------------------------------------------------------- bejelentkezés és szinkron (ál-Strava)

test('OAuth: login → callback állapot-ellenőrzéssel → bejelentkezett munkamenet', async () => {
  const login = await anon().get('/auth/login');
  assert.equal(login.status, 302);
  const loc = new URL(login.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, `${strava.oauthUrl}/authorize`);
  const stateParam = loc.searchParams.get('state');
  assert.equal(loc.searchParams.get('redirect_uri'), `${app.base}/auth/callback`);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const bad = await client(app.base, cookie).get(`/auth/callback?code=x&state=rossz&scope=read,activity:read_all`);
  assert.match(bad.headers.get('location'), /error=state/);
  const noScope = await client(app.base, cookie).get(`/auth/callback?code=x&state=${stateParam}&scope=read`);
  assert.match(noScope.headers.get('location'), /error=scope/);
  const denied = await client(app.base, cookie).get('/auth/callback?error=access_denied');
  assert.match(denied.headers.get('location'), /error=denied/);

  const ok = await client(app.base, cookie).get(`/auth/callback?code=good&state=${stateParam}&scope=read,activity:read_all`);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/');
  const sess = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(ok.headers.get('set-cookie'), /SameSite=Lax/i);
  const st = await client(app.base, sess).get('/api/status');
  assert.equal(st.json.loggedIn, true);
  assert.equal(st.json.athlete.firstname, 'Mock');
  const tokens = JSON.parse(fs.readFileSync(path.join(DATA, 'athletes', '777', 'tokens.json'), 'utf8'));
  assert.match(tokens.accessToken, /^acc-/);
});

test('szinkron: aktivitáslista az ál-Stravából, összegzés és tömör lista', async () => {
  const c = as(777);
  const start = await c.post('/api/sync');
  assert.equal(start.status, 200);
  const job = await c.waitJob(start.json.jobId);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.summary.count, 6);
  const acts = await c.get('/api/activities');
  assert.equal(acts.json.length, 6);
  const [id, name, date, type, typeName, dist, photos] = acts.json[0];
  assert.ok(id && name && date && type && typeName && dist > 0 && photos >= 0);
});

test('párhuzamos feladat ugyanannál a felhasználónál 409', async () => {
  const c = as(777);
  const a = await c.post('/api/photos/fetch');
  const b = await c.post('/api/sync');
  assert.equal(a.status, 200);
  assert.equal(b.status, 409);
  const job = await c.waitJob(a.json.jobId);
  assert.equal(job.status, 'done', job.error);
  // a hiányzó fotók letöltése az ál-CDN-ről
  assert.equal(job.result.downloaded, 6);
  assert.equal(job.result.expected, 6);
  assert.equal(job.result.failedPhotos, 0);
});

test('könyv az API-ból letöltött leírásokkal és útvonalakkal (ál-Strava)', async () => {
  const c = as(777);
  const start = await c.post('/api/book', { body: { title: 'API könyv', quality: 'screen', showDescriptions: true, showMaps: true, elevation: true } });
  const job = await c.waitJob(start.json.jobId);
  assert.equal(job.status, 'done', job.error);
  const pdf = await inspectPdf((await c.get(`/api/books/${encodeURIComponent(job.result.files[0].name)}`)).buf);
  const text = pdf.text.join('\n');
  assert.match(text, /Leírás \d+/, 'az API-ból jött leírás');
  assert.match(text, /Mock Shoes/, 'felszerelés a részletekből');
  assert.ok(strava.calls.some((x) => /\/streams$/.test(x)), 'útvonal-adatsor lekérve');
});

// ---------------------------------------------------------------- fotók

test('fotólista, bélyegkép, egyedi letöltés, ZIP (mind / kijelölt)', async () => {
  const c = as(888);
  const list = await c.get('/api/photos');
  assert.equal(list.json.downloaded, seeded.photoActs.length * 3);
  const [act, , , photos] = list.json.groups[0];
  const ref = `${act}/${photos[0][0]}`;
  const thumb = await c.get(`/api/photos/${ref}?thumb`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  assert.ok(thumb.buf.length < (await c.get(`/api/photos/${ref}`)).buf.length, 'a bélyegkép kisebb');
  const dl = await c.get(`/api/photos/${ref}?download`);
  assert.match(dl.headers.get('content-disposition'), /attachment; filename=".*01\.jpg"/);
  assert.equal((await c.get(`/api/photos/${act}/nincs`)).status, 404);

  const all = await c.post('/api/photos/zip', { form: { all: '1' } });
  assert.equal(all.status, 200);
  assert.match(all.headers.get('content-disposition'), /lap-by-lap-photos-\d{8}\.zip/);
  assert.equal((await zipNames(all.buf)).length, seeded.photoActs.length * 3);
  const sel = await c.post('/api/photos/zip', { form: { ids: `${ref}\n${act}/${photos[2][0]}` } });
  assert.equal((await zipNames(sel.buf)).length, 2);
  // más sportoló fotói nem kérhetők le (a saját mappáján kívül nincs mit kiszolgálni)
  const other = await as(777).get(`/api/photos/${ref}`);
  assert.equal(other.status, 404);
});

test('beállítások mentése és visszaolvasása, felhasználónként elkülönítve', async () => {
  const c = as(888);
  assert.deepEqual((await c.get('/api/settings')).json, {});
  const body = { v: 1, form: { title: 'Mentett cím', layout: 'gallery' }, photoExcl: ['1/a'], advanced: true };
  assert.equal((await c.put('/api/settings', { body })).status, 200);
  const back = (await c.get('/api/settings')).json;
  assert.equal(back.form.title, 'Mentett cím');
  assert.deepEqual(back.photoExcl, ['1/a']);
  assert.ok(back.savedAt);
  assert.deepEqual((await as(777).get('/api/settings')).json, {}, 'másik felhasználó nem látja');
  assert.equal((await c.put('/api/settings', { raw: 'x'.repeat(1.2 * 1024 * 1024), headers: { 'Content-Type': 'application/json' } })).status, 413);
});

test('borító saját fotóból és feltöltésből', async () => {
  const c = as(888);
  const act = seeded.photoActs[0].id;
  const r = await c.post('/api/cover/photo', { body: { ref: `${act}/p${act}_1` } });
  assert.equal(r.status, 200);
  assert.match(r.json.coverId, /^cover-[a-f0-9]{16}\.jpg$/);
  const img = await c.get(`/api/cover/${r.json.coverId}`);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await c.post('/api/cover/photo', { body: { ref: `${act}/nincs` } })).status, 404);
  const up = await c.post('/api/cover', { raw: await makeJpeg(500, 400), headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(up.status, 200);
  const bad = await c.post('/api/cover', { raw: Buffer.from('nem kép'), headers: { 'Content-Type': 'image/jpeg' } });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- könyv

test('előnézet és teljes könyv: kihagyott fotó, borító, letöltés, megtekintés, törlés', async () => {
  const c = as(888);
  const act = seeded.photoActs[0].id;
  const cover = (await c.post('/api/cover/photo', { body: { ref: `${act}/p${act}_0` } })).json.coverId;
  const prev = await c.waitJob((await c.post('/api/book', { body: { preview: true, quality: 'screen', coverId: cover } })).json.jobId);
  assert.equal(prev.status, 'done', prev.error);
  assert.equal(prev.result.preview, true);
  assert.match(prev.result.files[0].name, /^preview-/);

  const full = await c.waitJob((await c.post('/api/book', {
    body: { title: 'Teljes könyv', quality: 'screen', excludePhotos: [`${act}/p${act}_0`], favorites: [String(act)], split: 'year', coverSpread: true },
  })).json.jobId);
  assert.equal(full.status, 'done', full.error);
  const books = full.result.files.filter((f) => f.kind === 'book');
  const covers = full.result.files.filter((f) => f.kind === 'cover');
  assert.equal(books.length, 2, 'évenként egy kötet');
  assert.equal(covers.length, 2, 'kötetenként egy borító-terítő');
  // a jelentés fotószáma a borító- és évnyitó-képeket is tartalmazza, ezért egy kihagyás nélküli könyvvel vetjük össze
  const ref = await c.waitJob((await c.post('/api/book', { body: { title: 'Teljes könyv', quality: 'screen', favorites: [String(act)], split: 'year' } })).json.jobId);
  assert.ok(full.result.photos < ref.result.photos, `kihagyással ${full.result.photos}, anélkül ${ref.result.photos}`);
  for (const f of books) assert.equal(f.pages % 4, 0);

  const name = books[0].name;
  const inline = await c.get(`/api/books/${encodeURIComponent(name)}?inline`);
  assert.match(inline.headers.get('content-disposition'), /^inline/);
  assert.equal(inline.headers.get('content-security-policy'), null, 'a PDF-nézőt nem korlátozzuk');
  const listed = (await c.get('/api/books')).json.map((b) => b.name);
  assert.ok(listed.includes(name));
  assert.equal((await c.del(`/api/books/${encodeURIComponent(name)}`)).status, 200);
  assert.ok(!(await c.get('/api/books')).json.some((b) => b.name === name));
  assert.equal((await as(777).get(`/api/books/${encodeURIComponent(books[1].name)}`)).status, 404, 'más könyve nem tölthető le');
});

test('üres kijelölés és aktivitás nélküli felhasználó érthető hibát kap', async () => {
  const c = as(888);
  const empty = await c.post('/api/book', { body: { from: '1990-01-01', to: '1990-12-31' }, headers: { 'X-Lang': 'en' } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /No activity/);
  fs.mkdirSync(path.join(DATA, 'athletes', '999'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'athletes', '999', 'tokens.json'), JSON.stringify({ accessToken: 'a', refreshToken: 'b', expiresAt: 9e9 }));
  const none = await as(999).post('/api/book', { body: {}, headers: { 'X-Lang': 'hu' } });
  assert.equal(none.status, 400);
  assert.match(none.json.error, /aktivitás/);
});

test('visszavont Strava-hozzáférés: a könyv a meglévő adatokból elkészül, figyelmeztetéssel', async () => {
  await seedAthlete(DATA, { id: 889, count: 4, photoEvery: 1, photosPer: 1, img: [600, 400] }); // még nincs letöltött leírása
  strava.state.revoked = true;
  try {
    const c = as(889);
    const job = await c.waitJob((await c.post('/api/book', { body: { preview: true, quality: 'screen', showDescriptions: true } })).json.jobId);
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.result.skipped, true, 'a felület jelzi, hogy adat maradt ki');
  } finally {
    strava.state.revoked = false;
  }
});

// ---------------------------------------------------------------- archívum

async function archiveZip(withBigFile = false) {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('Activity ID,Activity Name,Activity Description,Filename,Media\n88800,Archív,Archív leírás,,media/x.jpg\n'), 'activities.csv');
  zip.addBuffer(await makeJpeg(400, 300, 2), 'media/x.jpg');
  if (withBigFile) zip.addBuffer(Buffer.alloc(4 * 1024 * 1024, 1), 'big.bin', { compress: false });
  zip.end();
  const chunks = [];
  for await (const c of zip.outputStream) chunks.push(c);
  return Buffer.concat(chunks);
}

test('archívum feltöltése és importja; méretkorlát; hibás ZIP', async () => {
  const c = as(888);
  const up = await c.post('/api/archive', { raw: await archiveZip(), headers: { 'Content-Type': 'application/zip' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const job = await c.waitJob(up.json.jobId);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.photos, 1);
  assert.equal((await c.get('/api/status')).json.archive.photos, 1);
  assert.deepEqual(fs.readdirSync(path.join(DATA, 'athletes', '888')).filter((n) => n.startsWith('upload-')), [], 'az ideiglenes ZIP törlődött');

  const big = await c.post('/api/archive', { raw: await archiveZip(true), headers: { 'Content-Type': 'application/zip' } });
  assert.equal(big.status, 413);

  const broken = await c.post('/api/archive', { raw: Buffer.from('nem zip'), headers: { 'Content-Type': 'application/zip', 'X-Lang': 'en' } });
  const bj = await c.waitJob(broken.json.jobId);
  assert.equal(bj.status, 'error');
  assert.match(bj.error, /archive|ZIP/i);
});

// ---------------------------------------------------------------- kijelentkezés, törlés

test('kijelentkezés törli a sütit; adattörlés visszavonja a Strava-hozzáférést', async () => {
  const out = await anon().post('/auth/logout');
  assert.match(out.headers.get('set-cookie'), /kk_s=;/);
  const before = strava.state.deauthorized;
  const c = as(777);
  const r = await c.post('/api/forget');
  assert.equal(r.status, 200);
  assert.equal(strava.state.deauthorized, before + 1);
  assert.equal(fs.existsSync(path.join(DATA, 'athletes', '777')), false);
  assert.equal((await c.get('/api/activities')).status, 401);
});
