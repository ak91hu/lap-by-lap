// Fejlesztői eszköz: a kezdőoldali lapozható MINTAKÖNYV előállítása (kedvcsináló).
//
// FONTOS: ez nem a felhasználói könyvek része. Az alkalmazás kizárólag a felhasználó valós Strava-adataival
// dolgozik; ez a szkript csak a bemutató oldalképeit készíti el egy kitalált sportoló („Kata Példa”)
// illusztrált (procedurálisan rajzolt) tájképeivel, egyértelműen mintaként jelölve.
//
// Használat:  npm run sample        → public/sample/{hu,en}/pNN.webp + manifest.json
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import * as mupdf from 'mupdf';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..');
const TMP = path.join(os.tmpdir(), 'lapbylap-sample');
process.env.DATA_DIR = path.join(TMP, 'data');
const { buildBook } = await import('../src/pdf/book.js');
const { ImagePrep } = await import('../src/pdf/images.js');
const { Fmt } = await import('../src/format.js');

// ------------------------------------------------------------------ determinisztikus véletlen

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------ illusztrált tájképek (SVG → JPEG)

const SCENES = {
  dawn: { sky: ['#2B2D5C', '#C9718A', '#F6B183', '#FCE0A8'], sun: '#FFF3D6', sunY: 0.52, ridges: ['#B9798E', '#8E5874', '#5E3B5E', '#2F2240'] },
  lake: { sky: ['#7FB2D4', '#BFD9E6', '#F3E6CF'], sun: '#FFF8E8', sunY: 0.3, ridges: ['#8FB0BE', '#5F8A99', '#365F6E'], lake: ['#6E9FB8', '#24536A'] },
  forest: { sky: ['#B9DCD6', '#E7F0DF', '#F6F1DC'], sun: '#FFFBEA', sunY: 0.26, ridges: ['#9CBFA3', '#6E9C79', '#3F6E4F', '#1E3F2C'], trees: true },
  snow: { sky: ['#5E8BC7', '#A9C6E8', '#EAF2FA'], sun: '#FFFFFF', sunY: 0.22, ridges: ['#C9D8EA', '#9AB3D0', '#6B86AA', '#3C5478'], snow: true },
  coast: { sky: ['#3A2D5A', '#B8577A', '#F59E6B', '#FCDCA0'], sun: '#FFE9B8', sunY: 0.56, ridges: ['#6B4A6E'], sea: ['#C77A7E', '#3B2F55'] },
  night: { sky: ['#070B1F', '#16224A', '#2E4475'], moon: '#F4F1E6', sunY: 0.24, ridges: ['#24345E', '#18244A', '#0D1533'], stars: true },
  autumn: { sky: ['#F5C9A6', '#F9E2C6', '#FBEFD9'], sun: '#FFF4DE', sunY: 0.3, ridges: ['#D9A27A', '#C4683F', '#8E3B24', '#4E2418'], trees: 'round' },
  fog: { sky: ['#D9DEE3', '#ECEFF1'], sun: '#FFFFFF', sunY: 0.28, ridges: ['#C3CBD3', '#A7B2BD', '#8996A3', '#66737F', '#46525C'], mist: true },
};

function ridge(r, w, h, base, amp, rough) {
  const ph = Array.from({ length: 6 }, () => r() * Math.PI * 2);
  const fr = [1.3, 2.7, 5.1, 9.7, 17, 31].map((f) => f * (0.8 + r() * 0.5));
  const am = [1, 0.5, 0.26, 0.12, 0.06, 0.03];
  const pts = [];
  for (let i = 0; i <= 120; i++) {
    const x = (i / 120) * w;
    let y = 0;
    for (let k = 0; k < 6; k++) y += am[k] * Math.sin((fr[k] * i) / 120 * Math.PI + ph[k]) * (k > 2 ? rough : 1);
    pts.push([x, h * base - y * amp * h]);
  }
  return pts;
}

function sceneSvg(name, w, h, seed) {
  const sc = SCENES[name];
  const r = rng(seed);
  const stops = (cols) => cols.map((c, i) => `<stop offset="${i / (cols.length - 1)}" stop-color="${c}"/>`).join('');
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">${stops(sc.sky)}</linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${sc.sun || sc.moon}" stop-opacity=".85"/><stop offset="1" stop-color="${sc.sun || sc.moon}" stop-opacity="0"/></radialGradient>
    <linearGradient id="mist" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".55"/></linearGradient>
    ${sc.lake ? `<linearGradient id="lake" x1="0" y1="0" x2="0" y2="1">${stops(sc.lake)}</linearGradient>` : ''}
    ${sc.sea ? `<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">${stops(sc.sea)}</linearGradient>` : ''}
  </defs><rect width="${w}" height="${h}" fill="url(#sky)"/>`;
  if (sc.stars) {
    for (let i = 0; i < 260; i++) svg += `<circle cx="${(r() * w).toFixed(1)}" cy="${(r() * h * 0.6).toFixed(1)}" r="${(r() * 1.6 + 0.3).toFixed(2)}" fill="#fff" opacity="${(0.35 + r() * 0.6).toFixed(2)}"/>`;
  }
  const sx = w * (0.25 + r() * 0.5);
  const sy = h * sc.sunY;
  const sr = Math.min(w, h) * (sc.moon ? 0.045 : 0.07);
  svg += `<circle cx="${sx}" cy="${sy}" r="${sr * 4.5}" fill="url(#glow)"/><circle cx="${sx}" cy="${sy}" r="${sr}" fill="${sc.sun || sc.moon}"/>`;
  const horizon = sc.lake ? 0.62 : sc.sea ? 0.6 : 1;
  const n = sc.ridges.length;
  sc.ridges.forEach((col, i) => {
    const t = n === 1 ? 1 : i / (n - 1);
    const base = sc.sea ? 0.6 : sc.lake ? 0.5 + t * 0.1 : 0.48 + t * 0.32;
    const amp = sc.sea ? 0.04 : (0.16 - t * 0.06) * (sc.snow ? 1.5 : 1);
    const pts = ridge(r, w, h, base, amp, sc.snow ? 1.6 : 1);
    const d = `M0 ${h} L${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')} L${w} ${h} Z`;
    svg += `<path d="${d}" fill="${col}"/>`;
    if (sc.snow && i < 2) {
      const caps = pts.map(([x, y]) => `${x.toFixed(1)} ${(y + h * 0.035).toFixed(1)}`).reverse();
      svg += `<path d="M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')} L${caps.join(' L')} Z" fill="#FFFFFF" opacity=".75"/>`;
    }
    if (sc.trees && i >= n - 2) {
      for (let k = 0; k < 70; k++) {
        const p = pts[Math.floor(r() * pts.length)];
        const th = h * (0.03 + r() * 0.04) * (1 + i - (n - 2));
        if (sc.trees === 'round') svg += `<circle cx="${p[0].toFixed(1)}" cy="${(p[1] - th * 0.4).toFixed(1)}" r="${(th * 0.45).toFixed(1)}" fill="${col}"/>`;
        else svg += `<path d="M${p[0].toFixed(1)} ${(p[1] - th).toFixed(1)} L${(p[0] - th * 0.28).toFixed(1)} ${(p[1] + 2).toFixed(1)} L${(p[0] + th * 0.28).toFixed(1)} ${(p[1] + 2).toFixed(1)} Z" fill="${col}"/>`;
      }
    }
    if (sc.mist && i < n - 1) svg += `<rect x="0" y="${(h * (base - 0.1)).toFixed(1)}" width="${w}" height="${(h * 0.22).toFixed(1)}" fill="url(#mist)"/>`;
  });
  if (sc.lake) {
    svg += `<rect x="0" y="${h * horizon}" width="${w}" height="${h * (1 - horizon)}" fill="url(#lake)"/>`;
    svg += `<ellipse cx="${sx}" cy="${h * horizon + (h * horizon - sy) * 0.6}" rx="${sr * 1.2}" ry="${sr * 0.35}" fill="${sc.sun}" opacity=".35"/>`;
    for (let k = 0; k < 40; k++) svg += `<rect x="${(r() * w).toFixed(1)}" y="${(h * horizon + r() * h * (1 - horizon)).toFixed(1)}" width="${(30 + r() * 140).toFixed(1)}" height="1.6" fill="#fff" opacity="${(0.1 + r() * 0.25).toFixed(2)}"/>`;
  }
  if (sc.sea) {
    svg += `<rect x="0" y="${h * horizon}" width="${w}" height="${h * (1 - horizon)}" fill="url(#sea)"/>`;
    for (let k = 0; k < 26; k++) {
      const yy = h * horizon + (k / 26) * h * (1 - horizon);
      const ww = sr * (0.6 + k * 0.12);
      svg += `<rect x="${(sx - ww / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${ww.toFixed(1)}" height="${(2 + k * 0.25).toFixed(1)}" fill="${sc.sun}" opacity="${(0.55 - k * 0.018).toFixed(2)}"/>`;
    }
  }
  svg += `<rect width="${w}" height="${h}" fill="#000" opacity="${sc.stars ? 0 : 0.03}"/></svg>`;
  return svg;
}

async function photo(dir, name, scene, w, h, seed) {
  const file = path.join(dir, `${name}.jpg`);
  await sharp(Buffer.from(sceneSvg(scene, w, h, seed))).jpeg({ quality: 88 }).toFile(file);
  return { file, width: w, height: h };
}

// ------------------------------------------------------------------ útvonalak (valószerű, simított bolyongás)

function track(seed, lat0, lng0, km, loop) {
  const r = rng(seed * 7 + 3);
  const n = 420;
  const pts = [];
  let lat = lat0;
  let lng = lng0;
  let dir = r() * Math.PI * 2;
  const step = (km / n) / 111;
  for (let i = 0; i < n; i++) {
    dir += (r() - 0.5) * 0.35 + (loop ? (Math.PI * 2) / n : 0);
    lat += Math.sin(dir) * step;
    lng += (Math.cos(dir) * step) / Math.cos((lat * Math.PI) / 180);
    pts.push([lat, lng]);
  }
  if (loop) { // finoman visszahúzzuk a rajthoz
    const [dl, dg] = [pts[n - 1][0] - lat0, pts[n - 1][1] - lng0];
    pts.forEach((p, i) => { p[0] -= (dl * i) / (n - 1); p[1] -= (dg * i) / (n - 1); });
  }
  return pts;
}

function encode(points) {
  let out = '';
  let pa = 0;
  let pb = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [la, ln] of points) {
    const a = Math.round(la * 1e5);
    const b = Math.round(ln * 1e5);
    out += enc(a - pa) + enc(b - pb);
    pa = a;
    pb = b;
  }
  return out;
}

// ------------------------------------------------------------------ a minta sportoló éve (kitalált)

const STORIES = [
  // [hónap, nap, típus, km, szint, lat, lng, kör?, hu név, en név, hu leírás, en leírás, jelenetek]
  [1, 18, 'Hike', 14.2, 620, 47.84, 18.98, true, 'Téli Börzsöny', 'Winter in the Börzsöny', 'Mínusz hat fok, csikorgó hó és teljes csend a Csóványoson. A termoszos tea sosem esett még ilyen jól.', 'Minus six degrees, crunching snow and complete silence on Csóványos. Hot tea from a flask never tasted better.', ['snow', 'snow', 'fog']],
  [3, 9, 'TrailRun', 21.4, 880, 47.68, 18.92, false, 'Pilisi terepfutás', 'Pilis trail run', 'Első igazi tavaszi nap a Pilisben: sár, napsütés és a Dobogókő-kilátó.', 'First real spring day in the Pilis hills: mud, sunshine and the Dobogókő viewpoint.', ['fog', 'forest']],
  [4, 27, 'GravelRide', 84.6, 1120, 46.95, 17.62, true, 'Balaton-felvidéki gravel', 'Balaton Uplands gravel', 'Fehér murvás utak a szőlősorok között, a Káli-medence felett végig a tavat láttuk.', 'White gravel roads between the vineyards; above the Káli basin the lake was always in view.', ['lake', 'forest', 'dawn', 'lake']],
  [5, 31, 'Run', 12.1, 140, 47.5, 19.04, false, 'Duna-parti esti futás', 'Evening run along the Danube', '', '', ['coast']],
  [6, 21, 'Hike', 26.8, 1350, 47.87, 20.01, false, 'Napfelkelte a Kékesen', 'Sunrise on Kékes', 'Hajnali háromkor indultunk a fejlámpákkal, hogy a nyári napfordulón a csúcson köszöntsük a napot.', 'We set off at 3 a.m. with headlamps to greet the solstice sunrise on the summit.', ['dawn', 'dawn', 'fog', 'forest', 'dawn']],
  [7, 13, 'Kayaking', 16.4, 0, 47.2, 18.6, true, 'Velencei-tó kajak', 'Kayaking Lake Velence', 'Nádas csatornák, gémek és egy hirtelen nyári zápor a végén.', 'Reed channels, herons and a sudden summer shower at the end.', ['lake', 'lake']],
  [8, 9, 'Run', 18.0, 210, 46.91, 17.89, true, 'Tihanyi levendulás futás', 'Lavender run in Tihany', 'A levendulamezők illata végigkísérte a kört; a Belső-tónál megálltam fotózni.', 'The scent of lavender fields followed the whole loop; I stopped at the Inner Lake for photos.', ['coast', 'lake', 'dawn']],
  [9, 20, 'Ride', 112.3, 1480, 48.47, 21.42, false, 'Zemplén: Hollóháza–Füzér', 'Zemplén: Hollóháza to Füzér', 'Hosszú nap a nyeregben, de a füzéri vár látványa mindenért kárpótolt.', 'A long day in the saddle, but the view of Füzér castle made up for everything.', ['autumn', 'forest', 'autumn', 'dawn']],
  [10, 18, 'Hike', 19.6, 760, 48.08, 20.5, true, 'Őszi Bükki-fennsík', 'Autumn on the Bükk plateau', 'Rozsdavörös bükkösök, köd a völgyekben és egy szarvasbőgéssel teli este.', 'Rust-red beech forests, fog in the valleys and an evening full of rutting stags.', ['autumn', 'fog', 'autumn', 'autumn', 'fog', 'autumn']],
  [11, 29, 'TrailRun', 15.3, 540, 47.92, 19.95, false, 'Ködös Mátra-gerinc', 'Misty Mátra ridge', '', '', ['fog', 'night']],
  [12, 31, 'Run', 10.0, 90, 47.51, 19.05, true, 'Szilveszteri futás', 'New Year’s Eve run', 'Az év utolsó kilométerei, csillagszóróval a célban. Jövőre ugyanitt!', 'The last kilometres of the year, with sparklers at the finish. Same place next year!', ['night']],
];

async function buildEntries(lang, imgDir, streamsDir) {
  const entries = [];
  let seed = 11;
  for (const [mi, st] of STORIES.entries()) {
    const [mon, day, type, km, elev, lat, lng, loop, nameHu, nameEn, dHu, dEn, scenes] = st;
    const date = new Date(Date.UTC(2025, mon - 1, day, 7 + (mi % 4), 12)).toISOString().replace('.000', '');
    const pts = track(mi + 1, lat, lng, km, loop);
    const ride = type.includes('Ride');
    const moving = Math.round(km * (ride ? 155 : type === 'Kayaking' ? 520 : type === 'Hike' ? 760 : 345));
    const sFile = path.join(streamsDir, `${mi}.json`);
    const alt = pts.map((_, i) => 180 + elev * 0.35 * (Math.sin(i / 70 + mi) ** 2) + 25 * Math.sin(i / 11 + mi));
    await fs.writeFile(sFile, JSON.stringify({
      latlng: pts.filter((_, i) => i % 1 === 0).map(([a, b]) => [Number(a.toFixed(5)), Number(b.toFixed(5))]),
      altitude: alt.map((v) => Number(v.toFixed(1))),
      distance: pts.map((_, i) => Math.round((km * 1000 * i) / (pts.length - 1))),
      time: pts.map((_, i) => Math.round((moving * i) / (pts.length - 1))),
    }));
    const photos = [];
    for (const [j, scene] of scenes.entries()) {
      const portrait = (j + mi) % 4 === 2;
      const p = await photo(imgDir, `s${mi}-${j}`, scene, portrait ? 1500 : 2000, portrait ? 2000 : 1333, seed++);
      const at = Math.floor(((j + 1) / (scenes.length + 1)) * pts.length);
      const caps = lang === 'hu'
        ? ['Megérte korán kelni', 'Pihenő a kilátónál', '', 'Az utolsó emelkedő előtt', '']
        : ['Worth the early start', 'A break at the viewpoint', '', 'Before the last climb', ''];
      photos.push({ ...p, caption: caps[(j + mi) % caps.length], isVideo: false, location: pts[at], createdAt: null });
    }
    entries.push({
      activity: {
        id: 9000 + mi, name: lang === 'hu' ? nameHu : nameEn, sport_type: type, type,
        start_date: date, start_date_local: date, distance: km * 1000, moving_time: moving, elapsed_time: Math.round(moving * 1.12),
        total_elevation_gain: elev, average_speed: (km * 1000) / moving, average_heartrate: 128 + (mi * 3) % 24,
        kudos_count: 8 + ((mi * 13) % 41), achievement_count: mi % 4, elev_high: 200 + elev * 0.6, elev_low: 120,
        calories: Math.round(km * (ride ? 28 : 62)), description: lang === 'hu' ? dHu : dEn,
        device_name: 'Garmin Fenix 8', gear_name: ride ? 'Canyon Grizl' : type === 'Kayaking' ? '' : 'Hoka Speedgoat',
        polyline: encode(pts.filter((_, i) => i % 3 === 0)), total_photo_count: scenes.length,
      },
      photos,
      streamsFile: sFile,
    });
  }
  // fotó nélküli edzések a naplóhoz (az év ritmusához)
  const r = rng(99);
  for (let k = 0; k < 64; k++) {
    const d = new Date(Date.UTC(2025, 0, 3 + Math.floor((k / 64) * 360), 17, 30)).toISOString().replace('.000', '');
    const run = k % 4 !== 3;
    const km = run ? 6 + Math.round(r() * 9) : 0;
    const pts = track(200 + k, 47.5 + r() * 0.05, 19.03 + r() * 0.05, Math.max(km, 3), true);
    entries.push({
      activity: {
        id: 9100 + k, name: run ? (lang === 'hu' ? 'Könnyű futás' : 'Easy run') : (lang === 'hu' ? 'Erősítés' : 'Strength training'),
        sport_type: run ? 'Run' : 'WeightTraining', start_date: d, start_date_local: d, distance: km * 1000,
        moving_time: run ? km * 330 : 2700, total_elevation_gain: run ? Math.round(r() * 80) : 0, average_speed: run ? 3.03 : 0,
        polyline: run ? encode(pts.filter((_, i) => i % 6 === 0)) : undefined, kudos_count: Math.round(r() * 9),
      },
      photos: [],
      streamsFile: null,
    });
  }
  return entries.sort((a, b) => a.activity.start_date_local.localeCompare(b.activity.start_date_local));
}

// ------------------------------------------------------------------ fő folyamat

const ctx = { phase() {}, tick() {}, wait() {} };
for (const lang of ['hu', 'en']) {
  const work = path.join(TMP, lang);
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(path.join(work, 'img'), { recursive: true });
  await fs.mkdir(path.join(work, 'streams'), { recursive: true });
  const entries = await buildEntries(lang, path.join(work, 'img'), path.join(work, 'streams'));
  const pdf = path.join(work, 'sample.pdf');
  const rep = await buildBook({
    entries,
    athlete: { firstname: 'Kata', lastname: lang === 'hu' ? 'Példa' : 'Sample', city: 'Budapest', country: lang === 'hu' ? 'Magyarország' : 'Hungary' },
    avatarFile: null,
    options: {
      title: lang === 'hu' ? 'Egy év a szabadban' : 'A year outdoors',
      subtitle: lang === 'hu' ? 'Kalandjaim 2025' : 'My adventures 2025',
      dedication: lang === 'hu' ? 'Mindenkinek, aki velem tartott az úton.' : 'For everyone who came along.',
      afterword: lang === 'hu'
        ? 'Tizenegy kaland, hetvenöt edzés és rengeteg emlék. Köszönöm a társaságot minden hajnali induláson és ködös gerincen. Jövőre még több kilométer!'
        : 'Eleven adventures, seventy-five workouts and countless memories. Thank you for the company on every early start and misty ridge. More miles next year!',
      pageSize: 'a4', theme: 'sunrise', typeface: 'classic', layout: 'magazine', tone: 'white', privacyMeters: 0,
      bleed: false, cropMarks: false, padToFour: true, toc: true,
    },
    outFile: pdf,
    ctx,
    fmt: new Fmt(lang, 'metric'),
    images: new ImagePrep({ dpi: 150, quality: 82 }),
  });

  // Oldalak renderelése WebP-be a lapozóhoz
  const out = path.join(ROOT, 'public', 'sample', lang);
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const doc = mupdf.Document.openDocument(await fs.readFile(pdf), 'application/pdf');
  const n = doc.countPages();
  const scale = 900 / 595.28;
  for (let i = 0; i < n; i++) {
    const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    await sharp(Buffer.from(pix.asPNG())).webp({ quality: 80 }).toFile(path.join(out, `p${String(i + 1).padStart(2, '0')}.webp`));
  }
  const first = await sharp(path.join(out, 'p01.webp')).metadata();
  await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ pages: n, width: first.width, height: first.height, sample: true }));
  console.log(`${lang}: ${n} pages, ${rep.photos} photos → ${path.relative(ROOT, out)}`);
}
