// Modultesztek ideiglenes adatmappával: fotólista és ZIP, bélyegképek, időjárás (ál-fetch-csel),
// a nehéz feladatok sora, és a Strava-archívum importja egy kitalált archívumból.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { tmpDir, seedAthlete, makeJpeg, ctxStub } from './helpers.mjs';

const DATA = tmpDir();
process.env.LAPBYLAP_NO_DOTENV = '1';
process.env.DATA_DIR = DATA;
process.env.MAX_HEAVY_JOBS = '1';

const photos = await import('../src/photos.js');
const weather = await import('../src/weather.js');
const jobs = await import('../src/jobs.js');
const { importArchive } = await import('../src/archive.js');
const { athleteDir } = await import('../src/store.js');

const seeded = await seedAthlete(DATA, { id: 501, count: 8, photoEvery: 2, photosPer: 3, img: [400, 300] });

/** Gyűjtő „válasz” a streamZip-hez: fejlécek + a teljes ZIP-tartalom. */
function fakeRes() {
  const chunks = [];
  const res = new Writable({
    write(c, _e, cb) {
      chunks.push(c);
      cb();
    },
  });
  res.headers = {};
  res.set = (h) => Object.assign(res.headers, h);
  res.done = new Promise((r) => res.on('finish', r));
  res.body = () => Buffer.concat(chunks);
  return res;
}

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

test('listPhotos: csoportok a legfrissebb aktivitással kezdve, a fotólista sorrendjében', async () => {
  const r = await photos.listPhotos(seeded.id);
  assert.equal(r.downloaded, seeded.photoActs.length * 3);
  assert.equal(r.expected, seeded.photoActs.length * 3);
  assert.equal(r.groups.length, seeded.photoActs.length);
  const dates = r.groups.map((g) => g[2]);
  assert.deepEqual(dates, [...dates].sort().reverse());
  for (const g of r.groups) assert.deepEqual(g[3].map((p) => p[0]), [0, 1, 2].map((k) => `p${g[0]}_${k}`));
});

test('streamZip: mind / kijelölt fotók, mappák aktivitásonként, tömörítés nélkül', async () => {
  const all = fakeRes();
  assert.equal(await photos.streamZip(seeded.id, null, all, 'x.zip'), true);
  await all.done;
  assert.equal(all.headers['Content-Type'], 'application/zip');
  const names = await zipNames(all.body());
  assert.equal(names.length, seeded.photoActs.length * 3);
  assert.ok(names.every((n) => /^\d{4}-\d{2}-\d{2} Teszt tura \d+\/0[123]\.jpg$/.test(n)), names.join(', '));

  const act = seeded.photoActs[0].id;
  const sel = fakeRes();
  await photos.streamZip(seeded.id, new Set([`${act}/p${act}_2`]), sel, 'y.zip');
  await sel.done;
  const selNames = await zipNames(sel.body());
  assert.equal(selNames.length, 1);
  assert.match(selNames[0], /\/03\.jpg$/, 'a sorszám a teljes listában elfoglalt hely');

  assert.equal(await photos.streamZip(seeded.id, new Set(['1/none']), fakeRes(), 'z.zip'), false);
});

test('streamZip: a lemezről hiányzó fájl kimarad, nem töri el a ZIP-et', async () => {
  const act = seeded.photoActs[1].id;
  const file = photos.photoFile(seeded.id, String(act), `p${act}_1`);
  const keep = fs.readFileSync(file);
  fs.rmSync(file);
  try {
    const res = fakeRes();
    await photos.streamZip(seeded.id, null, res, 'x.zip');
    await res.done;
    const names = await zipNames(res.body());
    assert.equal(names.length, seeded.photoActs.length * 3 - 1);
  } finally {
    fs.writeFileSync(file, keep);
  }
});

test('thumbFile: elkészül, gyorsítótárazott, párhuzamos kérésekre sem ütközik', async () => {
  const act = String(seeded.photoActs[2].id);
  const pid = `p${act}_0`;
  const results = await Promise.all(Array.from({ length: 8 }, () => photos.thumbFile(seeded.id, act, pid)));
  assert.ok(results.every((f) => f && f === results[0]));
  assert.ok(fs.statSync(results[0]).size > 0);
  const leftovers = fs.readdirSync(path.dirname(results[0])).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
  assert.equal(await photos.thumbFile(seeded.id, act, 'nincs-ilyen'), null);
});

test('activityWeather: kerekített koordináta, gyorsítótár, beltéri kihagyás, hálózati hiba nem kerül tárolásra', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  let fail = false;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (fail) throw new Error('offline');
    const hours = Array.from({ length: 24 }, (_, i) => i);
    return new Response(JSON.stringify({ hourly: { time: hours, temperature_2m: hours.map((h) => h + 0.04), weather_code: hours.map(() => 45), wind_speed_10m: hours.map(() => 12.4) } }));
  };
  try {
    const a = seeded.photoActs[0];
    const streams = path.join(athleteDir(seeded.id), 'streams', `${a.id}.json`);
    const w = await weather.activityWeather(seeded.id, a, streams);
    assert.deepEqual(w, { t: 8, code: 45, wind: 12 }); // 08 óra helyi idő
    const q = new URL(urls[0]).searchParams;
    assert.ok(/^\d+(\.\d)?$/.test(q.get('latitude')) && /^\d+(\.\d)?$/.test(q.get('longitude')), 'legfeljebb 1 tizedes');
    assert.equal(q.get('start_date'), a.start_date_local.slice(0, 10));
    await weather.activityWeather(seeded.id, a, streams);
    assert.equal(urls.length, 1, 'második hívás a gyorsítótárból');

    assert.equal(await weather.activityWeather(seeded.id, { ...a, id: 1, trainer: true }, streams), null);
    assert.equal(urls.length, 1, 'beltérinél nincs hívás');

    fail = true;
    const b = { ...a, id: 999001 };
    assert.equal(await weather.activityWeather(seeded.id, b, streams), null);
    assert.equal(fs.existsSync(path.join(athleteDir(seeded.id), 'weather', '999001.json')), false, 'a hiba nem kerül a gyorsítótárba');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('nehéz feladatok sora: MAX_HEAVY_JOBS=1 mellett a második vár, majd elindul', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const order = [];
  const a = jobs.createJob('athlete:1', 'book', async () => {
    order.push('a-start');
    await gate;
    order.push('a-end');
    return 'A';
  });
  const b = jobs.createJob('athlete:2', 'preview', async () => {
    order.push('b-start');
    return 'B';
  });
  const light = jobs.createJob('athlete:3', 'sync', async () => 'L');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(b.phase, 'phaseQueued');
  assert.equal(b.queuePos, 1);
  assert.equal(light.status, 'done', 'a könnyű feladat nem áll sorba');
  assert.deepEqual(jobs.queueStats(), { limit: 1, running: 1, queued: 1 });
  release();
  for (let i = 0; i < 50 && b.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start']);
  assert.equal(a.result, 'A');
  assert.equal(b.result, 'B');
  assert.equal(b.queuePos, null);
  assert.deepEqual(jobs.queueStats(), { limit: 1, running: 0, queued: 0 });
});

test('nehéz feladatok sora: hibás feladat is felszabadítja a helyet', async () => {
  const a = jobs.createJob('athlete:4', 'archive', async () => {
    throw new Error('boom');
  });
  const b = jobs.createJob('athlete:5', 'book', async () => 'ok');
  for (let i = 0; i < 50 && b.status === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(a.status, 'error');
  assert.equal(b.status, 'done');
  assert.equal(jobs.getJob(a.id, 'athlete:other'), null, 'más felhasználó nem látja');
  assert.equal('owner' in jobs.publicJob(a), false);
});

/** Kitalált, a Strava-exporttal azonos szerkezetű archívum. */
async function makeArchive(file) {
  const zip = new yazl.ZipFile();
  const csv = [
    'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Filename,Activity Gear,Media',
    '7001,"May 1, 2025",Archív futás,Run,"Leírás, vesszővel",1800,5,activities/7001.gpx,Cipő A,media/a1.jpg|media/a2.jpg|media/v1.mp4',
    '7002,"May 2, 2025",Archív séta,Walk,,1200,2,activities/7002.tcx,,',
    'nemszam,"x",Hibás sor,Run,,,,,,',
  ].join('\n');
  zip.addBuffer(Buffer.from(`﻿${csv}`), 'export_1/activities.csv');
  zip.addBuffer(Buffer.from('filename,caption\nmedia/a1.jpg,Archív felirat\n'), 'export_1/media.csv');
  zip.addBuffer(await makeJpeg(640, 480, 9), 'export_1/media/a1.jpg');
  zip.addBuffer(await makeJpeg(480, 640, 10), 'export_1/media/a2.jpg');
  zip.addBuffer(Buffer.from('not a video'), 'export_1/media/v1.mp4');
  const pts = Array.from({ length: 20 }, (_, i) => `<trkpt lat="${47.5 + i / 1000}" lon="${19 + i / 1000}"><ele>${100 + i}</ele><time>2025-05-01T06:${String(i).padStart(2, '0')}:00Z</time></trkpt>`).join('');
  zip.addBuffer(Buffer.from(`<gpx><trk><trkseg>${pts}</trkseg></trk></gpx>`), 'export_1/activities/7001.gpx');
  zip.end();
  await new Promise((resolve, reject) => zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject));
}

test('importArchive: CSV, leírások, fotók (videó kihagyva), képaláírás, GPX-útvonal', async () => {
  const file = path.join(DATA, 'archive-test.zip');
  await makeArchive(file);
  const ctx = ctxStub();
  const sum = await importArchive(file, 601, ctx);
  assert.equal(sum.activities, 2);
  assert.equal(sum.photos, 2);
  assert.equal(sum.skippedVideos, 1);
  assert.equal(sum.tracks, 1);
  assert.deepEqual(ctx.phases, ['phaseArchiveRead', 'phaseArchivePhotos', 'phaseArchiveTracks']);
  const dir = athleteDir(601);
  const list = JSON.parse(fs.readFileSync(path.join(dir, 'photos', '7001.json'), 'utf8'));
  assert.equal(list.source, 'archive');
  assert.equal(list.items.length, 2);
  assert.equal(list.items.find((p) => p.id === 'a_a1').caption, 'Archív felirat');
  const det = JSON.parse(fs.readFileSync(path.join(dir, 'details', '7001.json'), 'utf8'));
  assert.equal(det.description, 'Leírás, vesszővel');
  assert.equal(det.gear_name, 'Cipő A');
  const streams = JSON.parse(fs.readFileSync(path.join(dir, 'streams', '7001.json'), 'utf8'));
  assert.equal(streams.latlng.length, 20);
  assert.ok(streams.time.every((t) => typeof t === 'number'));
  // újrafuttatás: idempotens, nem duplikál
  const again = await importArchive(file, 601, ctxStub());
  assert.equal(again.photos, 2);
});

test('importArchive: activities.csv nélküli ZIP érthető hibát ad', async () => {
  const file = path.join(DATA, 'bad.zip');
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('x'), 'random.txt');
  zip.end();
  await new Promise((r) => zip.outputStream.pipe(fs.createWriteStream(file)).on('close', r));
  await assert.rejects(importArchive(file, 602, ctxStub()), (e) => e.code === 'NO_CSV');
});
