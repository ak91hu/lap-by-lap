// Az elkészült PDF-ek tárolása: helyi megőrzési szabályok (folyamaton belül), és S3-kompatibilis tároló
// (ál-S3 szerverrel, a valódi alkalmazáson keresztül): feltöltés, helyi példány törlése, streamelt letöltés
// Range-kéréssel, törlés, megőrzés, adattörlés.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { tmpDir, seedAthlete, startApp, startMockStrava, sessionCookie, client, inspectPdf } from './helpers.mjs';

// ---------------------------------------------------------------- helyi megőrzés (folyamaton belül)

const LOCAL = tmpDir();
process.env.LAPBYLAP_NO_DOTENV = '1';
process.env.DATA_DIR = LOCAL;
process.env.BOOKS_KEEP = '2';
process.env.PREVIEW_TTL_HOURS = '24';
const storage = await import('../src/storage.js');
const { booksDir } = await import('../src/store.js');

function fakeBook(athleteId, name) {
  fs.mkdirSync(booksDir(athleteId), { recursive: true });
  fs.writeFileSync(path.join(booksDir(athleteId), name), '%PDF-1.7 fake');
}

test('helyi mód: nyilvántartás, lista, megőrzés (BOOKS_KEEP, előnézet-lejárat)', async () => {
  assert.equal(storage.remoteEnabled(), false);
  const id = 31;
  let t = 1000;
  const realNow = Date.now;
  Date.now = () => t;
  try {
    for (const build of ['b1', 'b2', 'b3']) {
      t += 1000;
      fakeBook(id, `${build}.pdf`);
      fakeBook(id, `${build}-cover.pdf`);
      await storage.storeBook(id, { name: `${build}.pdf`, build, kind: 'book', preview: false, pages: 8 });
      await storage.storeBook(id, { name: `${build}-cover.pdf`, build, kind: 'cover', preview: false });
    }
    fakeBook(id, 'preview-x.pdf');
    await storage.storeBook(id, { name: 'preview-x.pdf', build: 'preview-x', kind: 'book', preview: true, pages: 4 });
  } finally {
    Date.now = realNow;
  }
  assert.equal((await storage.listBooks(id)).length, 7);
  const removed = await storage.applyRetention(id, 1000 + 3000 + 3600 * 1000);
  assert.deepEqual(removed.sort(), ['b1-cover.pdf', 'b1.pdf'], 'a legrégebbi összeállítás (kötet + borító) törlődik');
  const later = await storage.applyRetention(id, 1000 + 3000 + 25 * 3600 * 1000);
  assert.deepEqual(later, ['preview-x.pdf'], 'az előnézet 24 óra után lejár');
  assert.deepEqual((await storage.listBooks(id)).map((b) => b.name).sort(), ['b2-cover.pdf', 'b2.pdf', 'b3-cover.pdf', 'b3.pdf']);
  assert.equal(fs.existsSync(path.join(booksDir(id), 'b1.pdf.json')), false, 'a metaadat is törlődik');
});

test('helyi mód: metaadat nélküli régi PDF is listázódik; érvénytelen nevek elutasítva', async () => {
  const id = 32;
  fakeBook(id, 'regi-konyv-202501010000.pdf');
  const list = await storage.listBooks(id);
  assert.equal(list.length, 1);
  assert.equal(list[0].remote, false);
  assert.equal(storage.validName('../x.pdf'), null);
  assert.equal(storage.validName('a b.pdf'), null);
  assert.equal(storage.validName('ok-1.pdf'), 'ok-1.pdf');
  assert.equal(await storage.deleteBook(id, '../../etc.pdf'), false);
});

// ---------------------------------------------------------------- S3-mód a valódi szerveren, ál-S3-mal

let s3;
let s3Url;
const objects = new Map();
const s3Calls = [];
let app;
let DATA;
let strava;

before(async () => {
  s3 = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    s3Calls.push({ method: req.method, path: decodeURIComponent(u.pathname), auth: req.headers.authorization || '', sha: req.headers['x-amz-content-sha256'] || '', range: req.headers.range || '' });
    if (!/^AWS4-HMAC-SHA256 Credential=TESTKEY\//.test(req.headers.authorization || '')) {
      res.writeHead(403);
      return res.end('unsigned');
    }
    const key = decodeURIComponent(u.pathname);
    if (req.method === 'PUT') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      objects.set(key, Buffer.concat(chunks));
      res.writeHead(200, { ETag: '"x"' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET') {
      const buf = objects.get(key);
      if (!buf) {
        res.writeHead(404);
        return res.end('NoSuchKey');
      }
      const m = (req.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : buf.length - 1;
        res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${buf.length}` });
        return res.end(buf.subarray(start, end + 1));
      }
      res.writeHead(200, { 'Content-Length': buf.length });
      return res.end(buf);
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise((r) => s3.listen(0, '127.0.0.1', r));
  s3Url = `http://127.0.0.1:${s3.address().port}`;
  DATA = tmpDir();
  await seedAthlete(DATA, { id: 41, count: 6, photoEvery: 2, photosPer: 2, img: [700, 466] });
  strava = await startMockStrava();
  app = await startApp({
    dataDir: DATA,
    strava,
    env: { S3_ENDPOINT: s3Url, S3_BUCKET: 'lap-books', S3_ACCESS_KEY_ID: 'TESTKEY', S3_SECRET_ACCESS_KEY: 'secret', S3_REGION: 'eu-central-003', BOOKS_KEEP: '2' },
  });
});

after(async () => {
  await app?.stop();
  await strava?.close();
  await new Promise((r) => s3?.close(r));
});

async function makeBook(c, body) {
  const start = await c.post('/api/book', { body: { quality: 'screen', ...body } });
  const job = await c.waitJob(start.json.jobId);
  assert.equal(job.status, 'done', job.error);
  return job;
}

test('S3-mód: a kész könyv feltöltődik (aláírva), a helyi példány törlődik, a letöltés streamelve megy', async () => {
  const c = client(app.base, sessionCookie(41));
  const job = await makeBook(c, { title: 'Felhős könyv' });
  assert.ok(job.phase === 'phaseUpload' || job.phases.includes('phaseUpload'), 'feltöltési lépés');
  const name = job.result.files[0].name;
  const key = `/lap-books/books/41/${name}`;
  assert.ok(objects.has(key), `feltöltve: ${[...objects.keys()].join(', ')}`);
  const put = s3Calls.find((x) => x.method === 'PUT' && x.path === key);
  assert.equal(put.sha, 'UNSIGNED-PAYLOAD');
  assert.match(put.auth, /Credential=TESTKEY\/\d{8}\/eu-central-003\/s3\/aws4_request/);
  assert.equal(fs.existsSync(path.join(DATA, 'books', '41', name)), false, 'a helyi PDF törölve');

  const list = (await c.get('/api/books')).json;
  assert.equal(list[0].name, name);
  assert.equal(list[0].remote, true);
  assert.equal(list[0].size, objects.get(key).length);

  const dl = await c.get(`/api/books/${name}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename=/);
  assert.ok(dl.buf.equals(objects.get(key)), 'ugyanazok a bájtok');
  assert.ok((await inspectPdf(dl.buf)).pages > 0);

  const part = await c.get(`/api/books/${name}?inline`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.buf.length, 100);
  assert.match(part.headers.get('content-range'), /^bytes 0-99\//);
  assert.match(part.headers.get('content-disposition'), /^inline/);
});

test('S3-mód: az előnézet nem kerül fel a tárolóba (helyben marad, 24 óra után lejár)', async () => {
  const c = client(app.base, sessionCookie(41));
  const before = objects.size;
  const job = await makeBook(c, { preview: true });
  assert.equal(objects.size, before);
  assert.ok(fs.existsSync(path.join(DATA, 'books', '41', job.result.files[0].name)));
  assert.equal((await c.get(`/api/books/${job.result.files[0].name}`)).status, 200);
});

test('S3-mód: megőrzés (BOOKS_KEEP=2) a tárolóból is töröl; kézi törlés; adattörlés mindent eltávolít', async () => {
  const c = client(app.base, sessionCookie(41));
  await makeBook(c, { title: 'Második' });
  await makeBook(c, { title: 'Harmadik', coverSpread: true });
  const full = (await c.get('/api/books')).json.filter((b) => !b.preview);
  assert.equal(new Set(full.map((b) => b.build)).size, 2, 'két összeállítás maradt');
  assert.ok(![...objects.keys()].some((k) => /felhos-konyv/.test(k)), 'a legrégebbi a tárolóból is törlődött');
  assert.equal(objects.size, full.length);

  const victim = full.find((b) => b.kind === 'cover');
  assert.equal((await c.del(`/api/books/${victim.name}`)).status, 200);
  assert.equal(objects.has(`/lap-books/books/41/${victim.name}`), false);
  assert.equal((await c.get(`/api/books/${victim.name}`)).status, 404);

  assert.equal((await c.post('/api/forget')).status, 200);
  assert.equal(objects.size, 0, 'a tárolóban sem marad semmi');
  assert.equal(fs.existsSync(path.join(DATA, 'books', '41')), false);
});
