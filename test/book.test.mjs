// A PDF-könyv tördelése a beállítások széles körével, kitalált adatokon. Minden változatnál ellenőrizzük,
// hogy a PDF megnyitható, az oldalszám egyezik a jelentéssel, és a nyomdai beállítások (kifutó, 4-gyel osztható
// oldalszám, borító-terítő) ténylegesen megjelennek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpDir, seedAthlete, ctxStub, inspectPdf } from './helpers.mjs';

const DATA = tmpDir();
process.env.LAPBYLAP_NO_DOTENV = '1';
process.env.DATA_DIR = DATA;

const { buildBook, buildCoverSpread, PAGE_SIZES, MM } = await import('../src/pdf/book.js');
const { ImagePrep } = await import('../src/pdf/images.js');
const { Fmt } = await import('../src/format.js');
const { prepareEntries, loadActivities, loadAthlete } = await import('../src/sync.js');
const { sanitizeOptions, slugify } = await import('../src/options.js');

const seeded = await seedAthlete(DATA, { id: 701, count: 14, photoEvery: 2, photosPer: 4, years: [2025, 2026], img: [1200, 800] });
const athlete = await loadAthlete(701);
const all = await loadActivities(701);
// A fotólisták "archív" forrásúak, így nincs API-hívás; a kliens csak biztosíték.
const noApi = { photos: () => assert.fail('API'), activity: () => assert.fail('API'), streams: () => assert.fail('API') };
const { entries: baseEntries } = await prepareEntries(noApi, 701, all, ctxStub(), { descriptions: false, streams: false });
const images = new ImagePrep({ dpi: 150, quality: 70 });
const out = tmpDir('lbl-pdf-');

async function build(over = {}, name = 'book') {
  const options = { ...sanitizeOptions({ quality: 'screen', ...over }, 'hu'), coverFile: null, volumeLabel: '' };
  const fmt = new Fmt(options.lang, options.units === 'imperial' ? 'imperial' : 'metric');
  const file = path.join(out, `${name}-${slugify(JSON.stringify(over))}.pdf`);
  const entries = over.entries || baseEntries;
  const rep = await buildBook({ entries, athlete, avatarFile: null, options, outFile: file, ctx: ctxStub(), fmt, images });
  const pdf = await inspectPdf(file);
  assert.equal(pdf.head.slice(0, 5), '%PDF-');
  assert.equal(pdf.pages, rep.pages, 'a jelentés oldalszáma egyezik a PDF-fel');
  return { rep, pdf, file, options };
}

test('sanitizeOptions: ismeretlen értékek helyett biztonságos alapértékek', () => {
  const o = sanitizeOptions({ pageSize: 'x', theme: 'y', layout: 'z', privacyMeters: 7, maxPhotos: 5, title: 'a'.repeat(200), stats: ['distance', 'evil'], excludePhotos: ['1/a', '../x'] }, 'hu');
  assert.equal(o.pageSize, 'a4');
  assert.equal(o.theme, 'sunrise');
  assert.equal(o.layout, 'magazine');
  assert.equal(o.privacyMeters, 200);
  assert.equal(o.maxPhotos, 0);
  assert.equal(o.title.length, 80);
  assert.deepEqual(o.stats, ['distance']);
  assert.deepEqual([...o.excludePhotos], ['1/a']);
  assert.equal(o.lang, 'hu');
  assert.equal(slugify('Árvíztűrő Tükörfúrógép!'), 'arvizturo-tukorfurogep');
});

test('alapkönyv: borító, tartalomjegyzék, évnyitók, aktivitások, 4-gyel osztható oldalszám', async () => {
  const { rep, pdf } = await build({ title: 'Teszt könyv' });
  assert.equal(rep.pages % 4, 0);
  assert.ok(rep.photos >= seeded.photoActs.length * 3, `fotók: ${rep.photos}`);
  const all = pdf.text.join('\n');
  assert.match(all, /Teszt tura 1/);
  assert.match(all, /2025/);
  assert.match(all, /2026/);
  assert.ok(rep.preflight && rep.preflight.pagesDivisibleBy4);
});

for (const layout of ['magazine', 'gallery', 'journal']) {
  for (const tone of ['white', 'cream', 'night']) {
    test(`elrendezés: ${layout} · ${tone}`, async () => {
      await build({ layout, tone, typeface: tone === 'night' ? 'elegant' : 'sport' });
    });
  }
}

for (const pageSize of Object.keys(PAGE_SIZES)) {
  test(`oldalméret: ${pageSize} – a MediaBox a vágott mérettel egyezik`, async () => {
    const { pdf } = await build({ pageSize, chapters: 'none', yearPages: false });
    const [x0, y0, x1, y1] = pdf.mediaBox;
    assert.ok(Math.abs((x1 - x0) / MM - PAGE_SIZES[pageSize].w) < 1, `szélesség ${(x1 - x0) / MM}`);
    assert.ok(Math.abs((y1 - y0) / MM - PAGE_SIZES[pageSize].h) < 1, `magasság ${(y1 - y0) / MM}`);
  });
}

test('nyomdai mód: 3 mm kifutó TrimBox/BleedBox-szal és vágójelekkel', async () => {
  const { pdf } = await build({ bleed: true, cropMarks: true });
  assert.ok(pdf.trimBox && pdf.bleedBox, 'van TrimBox és BleedBox');
  const trimW = (pdf.trimBox[2] - pdf.trimBox[0]) / MM;
  const mediaW = (pdf.mediaBox[2] - pdf.mediaBox[0]) / MM;
  assert.ok(Math.abs(trimW - 210) < 0.5, `vágott szélesség ${trimW}`);
  assert.ok(mediaW > trimW + 5.9, 'a lap a kifutóval és a vágójelekkel nagyobb');
});

test('fejezetek és sorrend: hónap, évszak, sportág, fordított sorrend', async () => {
  for (const chapters of ['month', 'season', 'sport']) await build({ chapters, order: 'desc' }, chapters);
});

test('tartalom kikapcsolva: térkép, profil, leírás, felirat, tartalomjegyzék, évoldalak, napló nélkül', async () => {
  const { rep } = await build({ showMaps: false, elevation: false, showDescriptions: false, showCaptions: false, toc: false, yearPages: false, routesPage: false, listNoPhoto: false, runningHeads: false, padToFour: false });
  assert.ok(rep.pages > 0);
});

test('extrák: ajánlás, utószó, jegyzetoldalak, kedvencek, max fotó, adatvédelmi zóna, saját színek', async () => {
  const fav = String(seeded.photoActs[0].id);
  const { rep, pdf } = await build({
    dedication: 'Mindenkinek, aki velem futott.', afterword: 'Köszönöm!', notesPages: 4, favorites: [fav], maxPhotos: 3,
    privacyMeters: 1000, accent: '#123456', routeColor: 'ink', titlePos: 'top', coverStyle: 'routes', subtitle: 'Alcím',
  });
  const text = pdf.text.join('\n');
  assert.match(text, /Mindenkinek, aki velem futott\./);
  assert.match(text, /Köszönöm!/);
  assert.ok(rep.pages > 0);
});

test('max fotó / aktivitás: az előkészítés a legjobb képeket tartja meg, eredeti sorrendben', async () => {
  const { entries } = await prepareEntries(noApi, 701, all, ctxStub(), { descriptions: false, streams: false, maxPhotos: 3 });
  for (const e of entries.filter((x) => x.photos.length)) {
    assert.equal(e.photos.length, 3);
    const idx = e.photos.map((p) => Number(p.file.match(/_(\d+)\.jpg$/)[1]));
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'eredeti sorrend');
  }
});

test('angol nyelv, angolszász mértékegységek', async () => {
  const { pdf } = await build({ lang: 'en', units: 'imperial' });
  const text = pdf.text.join('\n');
  assert.match(text, /\bmi\b/);
  assert.match(text, /Contents|CONTENTS/);
});

test('időjárás és QR-kód: az időjárás megjelenik, a QR kikapcsolható', async () => {
  const entries = baseEntries.map((e, i) => (i === 0 && e.photos.length ? { ...e, activity: { ...e.activity, weather: { t: 4.6, code: 45, wind: 12 } } } : e));
  const first = entries.find((e) => e.photos.length);
  first.activity = { ...first.activity, weather: { t: 4.6, code: 45, wind: 12 } };
  const withQr = await build({ entries, qr: true, stats: ['distance', 'weather'] }, 'qr');
  const text = withQr.pdf.text.join('\n');
  assert.match(text, /5 °C/);
  assert.match(text, /köd/i);
  const noQr = await build({ entries, qr: false, stats: ['distance', 'weather'] }, 'noqr');
  assert.ok(withQr.pdf.pages >= noQr.pdf.pages);
});

test('fotó kihagyása a könyvből: a kihagyott kép nem kerül be', async () => {
  const act = seeded.photoActs[0].id;
  const ex = new Set([`${act}/p${act}_0`, `${act}/p${act}_1`]);
  const { entries } = await prepareEntries(noApi, 701, all, ctxStub(), { descriptions: false, streams: false, excludePhotos: ex });
  const e = entries.find((x) => x.activity.id === act);
  assert.equal(e.photos.length, 2);
  assert.ok(e.photos.every((p) => !/_0\.jpg$|_1\.jpg$/.test(p.file)));
});

test('évenkénti kötetek és borító-terítő gerinccel', async () => {
  const options = { ...sanitizeOptions({ quality: 'screen', coverSpread: true, paper: 'thick' }, 'hu'), coverFile: null, volumeLabel: '' };
  const fmt = new Fmt('hu', 'metric');
  const y2025 = baseEntries.filter((e) => e.activity.start_date_local.startsWith('2025'));
  const file = path.join(out, 'vol.pdf');
  const rep = await buildBook({ entries: y2025, athlete, avatarFile: null, options: { ...options, volumeLabel: '1. kötet · 2025' }, outFile: file, ctx: ctxStub(), fmt, images });
  const coverFile = path.join(out, 'vol-cover.pdf');
  const cs = await buildCoverSpread({ entries: y2025, athlete, options, outFile: coverFile, fmt, images, pages: rep.pages });
  assert.ok(cs.spineMm > 0, 'van gerinc');
  const cover = await inspectPdf(coverFile);
  assert.equal(cover.pages, 1);
  const w = (cover.mediaBox[2] - cover.mediaBox[0]) / MM;
  assert.ok(w > 2 * 210 + cs.spineMm - 1, `terítő szélessége ${w}`);
});

test('üres fotójú aktivitások: csak napló-lista, nem dől el', async () => {
  const entries = baseEntries.map((e) => ({ ...e, photos: [] }));
  const { rep } = await build({ entries }, 'nophotos');
  assert.ok(rep.pages >= 4);
  assert.equal(rep.photos, 0);
});
