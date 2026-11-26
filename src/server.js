// Lap by Lap – webszerver: Strava OAuth, háttérfeladatok, PDF-készítés és -letöltés.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import sharp from 'sharp';
import { PORT, BASE_URL, DATA_DIR, STRAVA, SESSION_SECRET, TRUST_PROXY, isConfigured } from './config.js';
import { authorizeUrl, exchangeCode, deauthorize, StravaClient } from './strava.js';
import { createJob, getJob, publicJob, activeJob, queueStats } from './jobs.js';
import { syncActivities, loadActivities, loadAthlete, summarize, prepareEntries, downloadAvatar } from './sync.js';
import { athleteDir, booksDir, loadTokens, saveTokens, deleteTokens, deleteAllData, readJson, writeJson } from './store.js';
import { storeBook, listBooks, getBook, sendBook, deleteBook, deleteAllBooks, applyRetention, startRetentionTimer, remoteEnabled } from './storage.js';
import { buildBook, buildCoverSpread, PAGE_SIZES, THEMES, PAPER_CALIPER } from './pdf/book.js';
import { ImagePrep } from './pdf/images.js';
import { basemapEnabled } from './pdf/maps.js';
import { Fmt, activityType, year } from './format.js';
import { detectLang } from './geo.js';
import { importArchive, archiveInfo } from './archive.js';
import { listPhotos, parseRef, photoFile, thumbFile, downloadName, streamZip } from './photos.js';
import { addWeather } from './weather.js';
import { sessionCookieName, signSession, verifySession, SESSION_MAX_AGE_MS, csrfGuard, rateLimit } from './security.js';
import { sanitizeOptions, slugify } from './options.js';
import { t, sportName, normLang } from './i18n.js';

const ARCHIVE_MAX_BYTES = Number(process.env.ARCHIVE_MAX_GB || 10) * 1024 ** 3;
const DISK_RESERVE_BYTES = 512 * 1024 ** 2;
let reservedDisk = 0;

/** Lefoglal helyet egy feltöltésnek, ha a lemezen (a többi futó feltöltéssel együtt) elfér. */
async function reserveDisk(bytes) {
  try {
    const st = await fsp.statfs(DATA_DIR);
    const free = st.bavail * st.bsize;
    if (bytes && free - reservedDisk - bytes < DISK_RESERVE_BYTES) return false;
  } catch { /* statfs nem elérhető: nem korlátozunk */ }
  reservedDisk += bytes;
  return true;
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

// ------------------------------------------------------------------ biztonsági fejlécek

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  });
  if (secure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  // A PDF-válaszokra nem teszünk CSP-t, mert az a böngésző beépített PDF-nézőjét is korlátozhatja.
  if (!req.path.startsWith('/api/books/')) {
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'none'; form-action 'self' https://www.strava.com");
  }
  next();
});

// Állapotot módosító kérés csak a saját oldalról (CSRF), és IP-nkénti kéréskorlát.
app.use(csrfGuard(BASE_URL));
app.use('/auth/login', rateLimit({ windowMs: 60000, max: 60, name: 'login' }));
app.use(['/api/archive', '/api/cover'], rateLimit({ windowMs: 60000, max: 20, name: 'upload' }));
app.use(['/api', '/auth'], rateLimit({ windowMs: 60000, max: Number(process.env.RATE_LIMIT_PER_MIN) || 3000, name: 'api' }));

// ------------------------------------------------------------------ aláírt süti alapú munkamenet (szerveroldali tár nélkül)

const secure = BASE_URL.startsWith('https://');
const COOKIE = sessionCookieName(secure);

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (k in out) continue; // azonos nevű sütiknél az első (a legpontosabb útvonalú) számít
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* hibás kódolás (pl. kívülről „bedobott” süti): kihagyjuk, nem dől el a kérés */ }
  }
  return out;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req);
  req.cookies = cookies;
  req.sess = verifySession(cookies[COOKIE], SESSION_SECRET) || {};
  res.saveSession = (data) => {
    req.sess = data;
    res.cookie(COOKIE, signSession(data, SESSION_SECRET), { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_MAX_AGE_MS, path: '/' });
  };
  res.clearSession = () => {
    req.sess = {};
    res.clearCookie(COOKIE, { path: '/', secure, httpOnly: true, sameSite: 'lax' });
  };
  next();
});

// A felület a felismert nyelvet (kézi süti → IP-ország → böngésző) az X-Lang fejlécben küldi vissza.
app.use((req, res, next) => {
  req.lang = normLang(req.get('x-lang') || req.cookies.kk_lang || 'en');
  next();
});

// Állapotjelzés a platform egészségellenőrzéséhez és a terhelésméréshez (személyes adat nélkül).
app.get('/healthz', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, uptimeS: Math.round(process.uptime()), rssMb: Math.round(process.memoryUsage().rss / 1048576), heavyJobs: queueStats() });
});

// ------------------------------------------------------------------ statikus fájlok

// A ponttal kezdődő mappát külön kell kiszolgálni: az express.static alapból kihagyja a rejtett útvonalakat.
app.use('/.well-known', express.static(path.resolve('public/.well-known'), { maxAge: '1h' }));
// A felület fájljai (HTML/JS/CSS) minden betöltéskor újraellenőrzöttek (ETag → 304), így deploy után a böngésző
// sosem keveri a régi és az új verziót. A ritkán változó médiát (mintakönyv-oldalak, ikon) egy óráig tárolhatja.
app.use(express.static(path.resolve('public'), {
  maxAge: '1h',
  index: 'index.html',
  setHeaders(res, file) {
    if (/\.(html|js|mjs|css|json)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
  },
}));
const requireCjs = createRequire(import.meta.url);
for (const pkg of ['inter', 'fraunces', 'oswald', 'playfair-display']) {
  const dir = path.dirname(requireCjs.resolve(`@expo-google-fonts/${pkg}/package.json`));
  app.use(`/fonts/${pkg}`, express.static(dir, { maxAge: '30d', immutable: true }));
}

// ------------------------------------------------------------------ hitelesítés

async function requireAuth(req, res, next) {
  const id = Number(req.sess.aid);
  const tokens = id ? await loadTokens(id) : null;
  if (!tokens) return res.status(401).json({ error: t(req.lang, 'errLogin') });
  req.athleteId = id;
  req.owner = `athlete:${id}`;
  next();
}

function makeClient(athleteId, tokens, job) {
  return new StravaClient(tokens, STRAVA, {
    onWait: (until, kind) => {
      job.waitUntil = until;
      job.waitKind = kind;
    },
    onTokens: (tk) => saveTokens(athleteId, tk),
    shouldSkip: () => job.skipApi,
  });
}

app.get('/auth/login', (req, res) => {
  if (!isConfigured()) return res.redirect('/?error=config');
  const state = crypto.randomBytes(16).toString('hex');
  res.saveSession({ ...req.sess, st: state });
  res.redirect(authorizeUrl({ clientId: STRAVA.clientId, redirectUri: `${BASE_URL}/auth/callback`, state }));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, scope = '' } = req.query;
  if (error) return res.redirect('/?error=denied');
  if (!code || !state || state !== req.sess.st) return res.redirect('/?error=state');
  if (!String(scope).includes('activity:read')) return res.redirect('/?error=scope');
  try {
    const tk = await exchangeCode({ ...STRAVA, code: String(code) });
    await saveTokens(tk.athlete.id, { accessToken: tk.accessToken, refreshToken: tk.refreshToken, expiresAt: tk.expiresAt });
    if (!(await loadAthlete(tk.athlete.id))) {
      const a = tk.athlete;
      await writeJson(path.join(athleteDir(a.id), 'athlete.json'), {
        id: a.id, firstname: a.firstname, lastname: a.lastname, city: a.city, country: a.country,
        profile: a.profile, profile_medium: a.profile_medium, measurement_preference: a.measurement_preference,
      });
    }
    res.saveSession({ aid: tk.athlete.id });
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.redirect('/?error=token');
  }
});

app.post('/auth/logout', async (req, res) => {
  res.clearSession();
  res.json({ ok: true });
});

/** Minden helyi adat törlése + a Strava-hozzáférés visszavonása. */
app.post('/api/forget', requireAuth, async (req, res) => {
  if (activeJob(req.owner)) return res.status(409).json({ error: t(req.lang, 'errBusy') });
  const tokens = await loadTokens(req.athleteId);
  if (tokens?.accessToken) await deauthorize(tokens.accessToken);
  await deleteTokens(req.athleteId);
  await deleteAllBooks(req.athleteId); // a távoli (S3) példányokkal együtt
  await deleteAllData(req.athleteId);
  res.clearSession();
  res.json({ ok: true });
});

// ------------------------------------------------------------------ nyelv és állapot

app.post('/api/lang', express.json({ limit: '1kb' }), (req, res) => {
  const lang = normLang(req.body?.lang);
  res.cookie('kk_lang', lang, { sameSite: 'lax', secure, maxAge: 365 * 24 * 3600 * 1000, path: '/' });
  res.json({ lang });
});

app.get('/api/status', async (req, res) => {
  const { lang, source, country } = await detectLang(req, req.cookies.kk_lang);
  const id = Number(req.sess.aid);
  const loggedIn = Boolean(id && (await loadTokens(id)));
  let summary = null;
  let athlete = null;
  let books = [];
  let job = null;
  let archive = null;
  if (loggedIn) {
    const acts = await loadActivities(id);
    if (acts) summary = summarize(acts);
    athlete = await loadAthlete(id);
    books = await listBooks(id);
    archive = await archiveInfo(id);
    const aj = activeJob(`athlete:${id}`);
    if (aj) job = { id: aj.id, kind: aj.kind };
  }
  res.json({
    lang, langSource: source, country: country || null,
    configured: isConfigured(),
    redirectDomain: new URL(BASE_URL).hostname,
    loggedIn,
    athlete: athlete && {
      id: athlete.id, firstname: athlete.firstname, lastname: athlete.lastname,
      profile: athlete.profile_medium, units: athlete.measurement_preference === 'feet' ? 'imperial' : 'metric',
    },
    summary,
    books,
    job,
    archive,
    basemap: basemapEnabled(),
    pageSizes: Object.keys(PAGE_SIZES),
    themes: Object.fromEntries(Object.entries(THEMES).map(([k, v]) => [k, { accent: v.accent, tint: v.tint, deep: v.deep }])),
    papers: PAPER_CALIPER,
  });
});

app.get('/api/activities', requireAuth, async (req, res) => {
  const acts = (await loadActivities(req.athleteId)) || [];
  const lang = normLang(req.query.lang || req.lang);
  // Tömör formátum: 1000+ aktivitásnál is kicsi a válasz.
  // [id, név, dátum, típus, típusnév, táv (m), fotók, jelzők: 1=privát 2=ingázás 4=beltéri]
  res.json(acts.map((a) => [
    a.id, a.name, a.start_date_local, activityType(a), sportName(lang, activityType(a)), Math.round(a.distance || 0), a.total_photo_count || 0,
    ((a.private || a.visibility === 'only_me') ? 1 : 0) | (a.commute ? 2 : 0) | ((a.trainer || /^Virtual/.test(activityType(a))) ? 4 : 0),
  ]));
});

// ------------------------------------------------------------------ feladatok

function startJob(req, res, kind, run) {
  if (activeJob(req.owner)) return res.status(409).json({ error: t(req.lang, 'errBusy') });
  const job = createJob(req.owner, kind, run);
  res.json({ jobId: job.id });
}

app.post('/api/sync', requireAuth, async (req, res) => {
  const athleteId = req.athleteId;
  const tokens = await loadTokens(athleteId);
  startJob(req, res, 'sync', async (ctx) => {
    const client = makeClient(athleteId, tokens, ctx.job);
    return { summary: await syncActivities(client, athleteId, ctx) };
  });
});

app.post('/api/jobs/:id/skip', requireAuth, (req, res) => {
  const job = getJob(req.params.id, req.owner);
  if (!job) return res.status(404).json({ error: t(req.lang, 'errNoJob') });
  job.skipApi = true;
  res.json({ ok: true });
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id, req.owner);
  if (!job) return res.status(404).json({ error: t(req.lang, 'errNoJob') });
  res.json(publicJob(job));
});

// Strava-archívum feltöltése: a kérés törzse streamelve, közvetlenül lemezre kerül (több GB is lehet),
// majd háttérfeladatként importáljuk. Utána a ZIP törlődik.
app.post('/api/archive', requireAuth, async (req, res) => {
  if (activeJob(req.owner)) return res.status(409).json({ error: t(req.lang, 'errBusy') });
  const athleteId = req.athleteId;
  const dir = athleteDir(athleteId);
  await fsp.mkdir(dir, { recursive: true });
  const zipFile = path.join(dir, `upload-${Date.now()}.zip`);
  // Méretkorlát, hogy egy hibás vagy rosszindulatú feltöltés ne töltse meg a lemezt.
  const declared = Number(req.get('content-length') || 0);
  if (declared > ARCHIVE_MAX_BYTES) return res.status(413).json({ error: t(req.lang, 'errTooLarge') });
  // Szabad hely: a többi folyamatban lévő feltöltés által lefoglalt hellyel együtt, 512 MB tartalékkal.
  if (!(await reserveDisk(declared))) return res.status(507).json({ error: t(req.lang, 'errNoSpace') });
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      cb(received > ARCHIVE_MAX_BYTES ? Object.assign(new Error('too large'), { code: 'TOO_LARGE' }) : null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, createWriteStream(zipFile));
  } catch (err) {
    await fsp.rm(zipFile, { force: true });
    if (err.code === 'TOO_LARGE') return res.status(413).json({ error: t(req.lang, 'errTooLarge') });
    return res.status(400).json({ error: 'Upload failed' });
  } finally {
    reservedDisk -= declared;
  }
  const lang = req.lang;
  if (activeJob(req.owner)) { // feltöltés közben indult egy másik feladat
    await fsp.rm(zipFile, { force: true });
    return res.status(409).json({ error: t(lang, 'errBusy') });
  }
  startJob(req, res, 'archive', async (ctx) => {
    try {
      return await importArchive(zipFile, athleteId, ctx);
    } catch (err) {
      if (err.code === 'NO_CSV' || err.code === 'EMPTY' || /end of central directory|invalid/i.test(err.message)) throw new Error(t(lang, 'errArchive'));
      throw err;
    } finally {
      await fsp.rm(zipFile, { force: true });
    }
  });
});

// Borítókép-feltöltés nyers bináris adatként (nem base64 JSON – kevesebb memória).
app.post('/api/cover', requireAuth, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/tiff'], limit: '30mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No image' });
  const id = `cover-${crypto.randomBytes(8).toString('hex')}.jpg`;
  const dir = path.join(athleteDir(req.athleteId), 'uploads');
  await fsp.mkdir(dir, { recursive: true });
  try {
    await sharp(req.body, { failOn: 'none', limitInputPixels: 120e6 }).rotate()
      .resize({ width: 4000, height: 4000, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 92, mozjpeg: true })
      .toFile(path.join(dir, id));
  } catch {
    return res.status(400).json({ error: 'Invalid image' });
  }
  res.json({ coverId: id });
});

// Borító a már letöltött saját fotók közül (feltöltés nélkül): ugyanúgy előkészítve, mint a feltöltött borító.
app.post('/api/cover/photo', requireAuth, express.json({ limit: '2kb' }), async (req, res) => {
  const ref = parseRef(req.body?.ref);
  if (!ref) return res.status(400).json({ error: 'Invalid photo' });
  const id = `cover-${crypto.randomBytes(8).toString('hex')}.jpg`;
  const dir = path.join(athleteDir(req.athleteId), 'uploads');
  await fsp.mkdir(dir, { recursive: true });
  try {
    await sharp(photoFile(req.athleteId, ...ref), { failOn: 'none', limitInputPixels: 120e6 }).rotate()
      .resize({ width: 4000, height: 4000, fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb').jpeg({ quality: 92, mozjpeg: true })
      .toFile(path.join(dir, id));
  } catch {
    return res.status(404).json({ error: 'Invalid photo' });
  }
  res.json({ coverId: id });
});

app.get('/api/cover/:id', requireAuth, (req, res) => {
  if (!/^cover-[a-f0-9]{16}\.jpg$/.test(req.params.id)) return res.status(400).end();
  res.sendFile(path.join(athleteDir(req.athleteId), 'uploads', req.params.id), { headers: { 'Cache-Control': 'private, max-age=86400' } },
    (err) => err && !res.headersSent && res.status(404).end());
});

// ------------------------------------------------------------------ mentett beállítások
// A felület minden változtatás után elmenti a könyv beállításait, így újratöltés vagy másik eszköz után is megmaradnak.

const settingsFile = (id) => path.join(athleteDir(id), 'settings.json');

app.get('/api/settings', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json((await readJson(settingsFile(req.athleteId))) || {});
});

app.put('/api/settings', requireAuth, express.json({ limit: '1mb' }), async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Invalid settings' });
  await writeJson(settingsFile(req.athleteId), { ...body, savedAt: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/api/book', requireAuth, express.json({ limit: '2mb' }), async (req, res) => {
  const opts = sanitizeOptions(req.body, req.lang);
  const athleteId = req.athleteId;
  const all = await loadActivities(athleteId);
  if (!all) return res.status(400).json({ error: t(opts.lang, 'errNoActivities') });

  let selected = all.filter((a) => {
    const day = (a.start_date_local || '').slice(0, 10);
    if (opts.from && day < opts.from) return false;
    if (opts.to && day > opts.to) return false;
    if (opts.types && !opts.types.has(activityType(a))) return false;
    if (opts.exclude.has(String(a.id))) return false;
    if (opts.onlyPhotos && !(a.total_photo_count > 0)) return false;
    if (opts.excludePrivate && (a.private || a.visibility === 'only_me')) return false;
    if (opts.excludeCommute && a.commute) return false;
    if (opts.excludeIndoor && (a.trainer || /^Virtual/.test(activityType(a)))) return false;
    if (opts.minKm && (a.distance || 0) < opts.minKm * 1000 && a.distance > 0) return false;
    return true;
  });
  if (!selected.length) return res.status(400).json({ error: t(opts.lang, 'errEmptySelection') });
  if (opts.preview) {
    // Gyors előnézet: a kiválasztás legfrissebb 3 fotós aktivitása (valós adatokkal), plusz néhány fotó nélküli.
    const photoActs = selected.filter((a) => a.total_photo_count > 0).slice(-3);
    const lastYear = photoActs.length ? year(photoActs[photoActs.length - 1]) : year(selected[selected.length - 1]);
    const others = selected.filter((a) => !(a.total_photo_count > 0) && year(a) === lastYear).slice(-8);
    selected = [...photoActs, ...others].sort((x, y) => x.start_date_local.localeCompare(y.start_date_local));
  }
  const tokens = await loadTokens(athleteId);

  startJob(req, res, opts.preview ? 'preview' : 'book', async (ctx) => {
    const client = makeClient(athleteId, tokens, ctx.job);
    const athlete = (await loadAthlete(athleteId)) || { id: athleteId };
    const units = opts.units === 'auto' ? (athlete.measurement_preference === 'feet' ? 'imperial' : 'metric') : opts.units;
    const fmt = new Fmt(opts.lang, units);
    const { entries, failedPhotos, skipped } = await prepareEntries(client, athleteId, selected, ctx, {
      descriptions: opts.showDescriptions,
      streams: opts.showMaps && opts.elevation,
      maxPhotos: opts.maxPhotos,
      excludePhotos: opts.excludePhotos,
    });
    if (opts.weather) await addWeather(athleteId, entries, ctx);
    const avatarFile = await downloadAvatar(athlete, athleteId);
    const coverFile = opts.coverId ? path.join(athleteDir(athleteId), 'uploads', opts.coverId) : null;
    const images = new ImagePrep(opts.quality === 'screen' ? { dpi: 150, quality: 78 } : { dpi: 300, quality: 86 });
    const outDir = booksDir(athleteId);
    await fsp.mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const base = `${opts.preview ? 'preview-' : ''}${slugify(opts.title)}-${stamp}`;

    const volumes = opts.split === 'year' && !opts.preview
      ? [...Map.groupBy(entries, (e) => year(e.activity))].map(([yr, list], i) => ({ list, label: `${fmt.t('volume', { n: i + 1 })} · ${yr}`, suffix: `-${yr}` }))
      : [{ list: entries, label: '', suffix: '' }];

    const files = [];
    let pages = 0;
    let photos = 0;
    const lowRes = [];
    let preflight = null;
    for (const v of volumes) {
      const name = `${base}${v.suffix}.pdf`;
      const options = { ...opts, coverFile, volumeLabel: v.label, padToFour: opts.preview ? false : opts.padToFour };
      const rep = await buildBook({ entries: v.list, athlete, avatarFile, options, outFile: path.join(outDir, name), ctx, fmt, images });
      files.push({ name, kind: 'book', pages: rep.pages, label: v.label });
      pages += rep.pages;
      photos += rep.photos;
      lowRes.push(...rep.lowRes);
      // kötetenkénti előellenőrzés összesítése (a legrosszabb érték számít)
      preflight = preflight
        ? {
          ...preflight,
          minFontPt: Math.min(preflight.minFontPt, rep.preflight.minFontPt),
          lowResImages: preflight.lowResImages + rep.preflight.lowResImages,
          pagesDivisibleBy4: preflight.pagesDivisibleBy4 && rep.preflight.pagesDivisibleBy4,
        }
        : rep.preflight;
      if (opts.coverSpread && !opts.preview) {
        ctx.phase('phaseCover');
        const coverName = `${base}${v.suffix}-cover.pdf`;
        const cs = await buildCoverSpread({ entries: v.list, athlete, options, outFile: path.join(outDir, coverName), fmt, images, pages: rep.pages });
        files.push({ name: coverName, kind: 'cover', label: v.label, spineMm: cs.spineMm, widthMm: cs.widthMm, heightMm: cs.heightMm });
      }
    }
    // Nyilvántartás + (ha be van állítva) feltöltés az S3-tárolóba, majd a megőrzési szabályok.
    if (remoteEnabled() && !opts.preview) ctx.phase('phaseUpload', files.length);
    for (const f of files) {
      const meta = await storeBook(athleteId, { name: f.name, build: base, kind: f.kind, preview: opts.preview, pages: f.pages || null, label: f.label || '' });
      f.size = meta.size;
      ctx.tick();
    }
    await applyRetention(athleteId);
    return {
      files, pages, photos, lowRes: lowRes.slice(0, 100), lowResCount: lowRes.length, failedPhotos, skipped,
      activities: entries.length, trimSize: `${PAGE_SIZES[opts.pageSize].w} × ${PAGE_SIZES[opts.pageSize].h} mm`,
      bleed: opts.bleed, cropMarks: opts.cropMarks, preview: opts.preview, preflight,
      coverSpread: opts.coverSpread && !opts.preview,
    };
  });
});

// ------------------------------------------------------------------ fotók letöltése
// A könyvhöz amúgy is letöltött (helyi) fotókat adjuk ki: egyenként, kijelölve vagy mindet ZIP-ben.

app.get('/api/photos', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await listPhotos(req.athleteId));
});

app.get('/api/photos/:act/:pid', requireAuth, async (req, res) => {
  const ref = parseRef(`${req.params.act}/${req.params.pid}`);
  if (!ref) return res.status(400).end();
  const [act, pid] = ref;
  const fail = (err) => err && !res.headersSent && res.status(404).end();
  if (req.query.thumb !== undefined) {
    const file = await thumbFile(req.athleteId, act, pid).catch(() => null);
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=86400');
    return res.sendFile(file, fail);
  }
  const file = photoFile(req.athleteId, act, pid);
  if (req.query.download === undefined) return res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600' } }, fail);
  const acts = (await loadActivities(req.athleteId)) || [];
  const list = (await listPhotos(req.athleteId)).groups.find((g) => g[0] === act);
  const i = Math.max(0, list ? list[3].findIndex(([p]) => p === pid) : 0);
  res.download(file, downloadName(acts.find((a) => String(a.id) === act), i), fail);
});

// Űrlapos POST (nem fetch), hogy a böngésző maga töltse le a több GB-os ZIP-et is, memóriába olvasás nélkül.
app.post('/api/photos/zip', requireAuth, express.urlencoded({ extended: false, limit: '8mb' }), async (req, res) => {
  const all = req.body?.all === '1';
  const refs = all ? null : new Set(String(req.body?.ids || '').split(/[\s,]+/).map(parseRef).filter(Boolean).map((r) => r.join('/')));
  if (refs && !refs.size) return res.status(400).json({ error: t(req.lang, 'errNoPhotos') });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ok = await streamZip(req.athleteId, refs, res, `lap-by-lap-photos-${stamp}.zip`);
  if (!ok) res.status(404).json({ error: t(req.lang, 'errNoPhotos') });
});

// A még le nem töltött fotók letöltése könyvkészítés nélkül (ugyanaz a gyorsítótár, amit a könyv is használ).
app.post('/api/photos/fetch', requireAuth, async (req, res) => {
  const athleteId = req.athleteId;
  const acts = ((await loadActivities(athleteId)) || []).filter((a) => (a.total_photo_count || 0) > 0);
  if (!acts.length) return res.status(400).json({ error: t(req.lang, 'errNoPhotos') });
  const tokens = await loadTokens(athleteId);
  startJob(req, res, 'photos', async (ctx) => {
    const client = makeClient(athleteId, tokens, ctx.job);
    const { failedPhotos, skipped } = await prepareEntries(client, athleteId, acts, ctx, { descriptions: false, streams: false });
    const { downloaded, expected } = await listPhotos(athleteId);
    return { downloaded, expected, failedPhotos, skipped };
  });
});

// ------------------------------------------------------------------ könyvek

app.get('/api/books', requireAuth, async (req, res) => res.json(await listBooks(req.athleteId)));

app.get('/api/books/:name', requireAuth, async (req, res) => {
  if (!/^[\w.-]+\.pdf$/.test(req.params.name)) return res.status(400).end();
  const meta = await getBook(req.athleteId, req.params.name);
  if (!meta) return res.status(404).end();
  await sendBook(req.athleteId, meta, req, res, req.query.inline !== undefined ? 'inline' : 'attachment');
});

app.delete('/api/books/:name', requireAuth, async (req, res) => {
  if (!(await deleteBook(req.athleteId, req.params.name))) return res.status(400).end();
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' });
});

startRetentionTimer();

app.listen(PORT, () => {
  console.log(`\n  Lap by Lap: ${BASE_URL}\n`);
  if (!isConfigured()) console.log('  ! STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET missing (.env) – see README.\n');
});
