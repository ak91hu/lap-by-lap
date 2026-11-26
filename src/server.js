// Lap by Lap – webszerver: Strava OAuth, háttérfeladatok, PDF-készítés és -letöltés.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import sharp from 'sharp';
import { PORT, BASE_URL, STRAVA, SESSION_SECRET, TRUST_PROXY, isConfigured } from './config.js';
import { authorizeUrl, exchangeCode, deauthorize, StravaClient } from './strava.js';
import { createJob, getJob, publicJob, activeJob } from './jobs.js';
import { syncActivities, loadActivities, loadAthlete, summarize, prepareEntries, downloadAvatar } from './sync.js';
import { athleteDir, booksDir, loadTokens, saveTokens, deleteTokens, deleteAllData, listBooks, safeBookPath, writeJson } from './store.js';
import { buildBook, buildCoverSpread, PAGE_SIZES, THEMES, PAPER_CALIPER } from './pdf/book.js';
import { ImagePrep } from './pdf/images.js';
import { basemapEnabled } from './pdf/maps.js';
import { Fmt, activityType, year } from './format.js';
import { detectLang } from './geo.js';
import { importArchive, archiveInfo } from './archive.js';
import { listPhotos, parseRef, photoFile, thumbFile, downloadName, streamZip } from './photos.js';
import { t, sportName, normLang } from './i18n.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);

// ------------------------------------------------------------------ biztonsági fejlécek

app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN' });
  // A PDF-válaszokra nem teszünk CSP-t, mert az a böngésző beépített PDF-nézőjét is korlátozhatja.
  if (!req.path.startsWith('/api/books/')) {
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data: blob:; style-src 'self'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self' https://www.strava.com");
  }
  next();
});

// ------------------------------------------------------------------ aláírt süti alapú munkamenet (szerveroldali tár nélkül)

const COOKIE = 'kk_s';
const secure = BASE_URL.startsWith('https://');

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');

app.use((req, res, next) => {
  const cookies = parseCookies(req);
  req.cookies = cookies;
  req.sess = {};
  const raw = cookies[COOKIE];
  if (raw) {
    const [payload, sig] = raw.split('.');
    const good = sig && payload && sig.length === sign(payload).length
      && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(payload)));
    if (good) {
      try {
        req.sess = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch { /* sérült süti */ }
    }
  }
  res.saveSession = (data) => {
    req.sess = data;
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    res.cookie(COOKIE, `${payload}.${sign(payload)}`, { httpOnly: true, sameSite: 'lax', secure, maxAge: 30 * 24 * 3600 * 1000, path: '/' });
  };
  res.clearSession = () => {
    req.sess = {};
    res.clearCookie(COOKIE, { path: '/' });
  };
  next();
});

// A felület a felismert nyelvet (kézi süti → IP-ország → böngésző) az X-Lang fejlécben küldi vissza.
app.use((req, res, next) => {
  req.lang = normLang(req.get('x-lang') || req.cookies.kk_lang || 'en');
  next();
});

// ------------------------------------------------------------------ statikus fájlok

app.use(express.static(path.resolve('public'), { maxAge: '1h', index: 'index.html' }));
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
  try {
    await pipeline(req, createWriteStream(zipFile));
  } catch {
    await fsp.rm(zipFile, { force: true });
    return res.status(400).json({ error: 'Upload failed' });
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

function sanitizeOptions(body, req) {
  const o = body || {};
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const bool = (v, def) => (v === undefined ? def : Boolean(v));
  return {
    lang: normLang(o.lang || req.lang),
    units: ['metric', 'imperial'].includes(o.units) ? o.units : 'auto',
    title: str(o.title, 80) || 'Lap by Lap',
    subtitle: str(o.subtitle, 120),
    dedication: str(o.dedication, 600),
    pageSize: PAGE_SIZES[o.pageSize] ? o.pageSize : 'a4',
    theme: THEMES[o.theme] ? o.theme : 'sunrise',
    typeface: ['modern', 'sport', 'elegant'].includes(o.typeface) ? o.typeface : 'classic',
    coverStyle: o.coverStyle === 'routes' ? 'routes' : 'photo',
    titlePos: ['top', 'center'].includes(o.titlePos) ? o.titlePos : 'bottom',
    layout: ['gallery', 'journal'].includes(o.layout) ? o.layout : 'magazine',
    tone: ['cream', 'night'].includes(o.tone) ? o.tone : 'white',
    accent: /^#[0-9a-f]{6}$/i.test(o.accent || '') ? o.accent : null,
    routeColor: o.routeColor === 'ink' ? 'ink' : 'accent',
    chapters: ['month', 'season', 'sport', 'none'].includes(o.chapters) ? o.chapters : 'year',
    order: o.order === 'desc' ? 'desc' : 'asc',
    stats: Array.isArray(o.stats) ? o.stats.filter((k) => ['distance', 'time', 'elevation', 'pace', 'hr', 'power', 'calories', 'high', 'kudos'].includes(k)) : null,
    favorites: Array.isArray(o.favorites) ? o.favorites.map(String).slice(0, 200) : [],
    mapPins: bool(o.mapPins, true),
    runningHeads: bool(o.runningHeads, true),
    afterword: str(o.afterword, 2000),
    notesPages: [0, 2, 4, 8].includes(Number(o.notesPages)) ? Number(o.notesPages) : 0,
    excludePrivate: bool(o.excludePrivate, false),
    excludeCommute: bool(o.excludeCommute, false),
    excludeIndoor: bool(o.excludeIndoor, false),
    minKm: Math.max(0, Math.min(500, Number(o.minKm) || 0)),
    coverId: /^cover-[a-f0-9]{16}\.jpg$/.test(o.coverId || '') ? o.coverId : null,
    from: /^\d{4}-\d{2}-\d{2}$/.test(o.from || '') ? o.from : null,
    to: /^\d{4}-\d{2}-\d{2}$/.test(o.to || '') ? o.to : null,
    types: Array.isArray(o.types) ? new Set(o.types.map(String)) : null,
    exclude: new Set(Array.isArray(o.exclude) ? o.exclude.map(String) : []),
    onlyPhotos: bool(o.onlyPhotos, false),
    maxPhotos: [0, 3, 6, 12, 24].includes(Number(o.maxPhotos)) ? Number(o.maxPhotos) : 0,
    listNoPhoto: bool(o.listNoPhoto, true),
    yearPages: bool(o.yearPages, true),
    routesPage: bool(o.routesPage, true),
    toc: bool(o.toc, true),
    showMaps: bool(o.showMaps, true),
    elevation: bool(o.elevation, true),
    showDescriptions: bool(o.showDescriptions, true),
    showCaptions: bool(o.showCaptions, true),
    privacyMeters: [0, 200, 500, 1000].includes(Number(o.privacyMeters)) ? Number(o.privacyMeters) : 200,
    quality: o.quality === 'screen' ? 'screen' : 'print',
    bleed: bool(o.bleed, false),
    cropMarks: bool(o.cropMarks, false),
    gutter: bool(o.gutter, true),
    padToFour: bool(o.padToFour, true),
    split: o.split === 'year' ? 'year' : 'none',
    coverSpread: bool(o.coverSpread, false),
    paper: PAPER_CALIPER[o.paper] ? o.paper : 'standard',
    spineMm: Math.max(0, Math.min(80, Number(o.spineMm) || 0)),
    preview: bool(o.preview, false),
  };
}

function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'book';
}

app.post('/api/book', requireAuth, express.json({ limit: '2mb' }), async (req, res) => {
  const opts = sanitizeOptions(req.body, req);
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
    });
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
    for (const f of files) f.size = (await fsp.stat(path.join(outDir, f.name))).size;
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

app.get('/api/books/:name', requireAuth, (req, res) => {
  const file = safeBookPath(req.athleteId, req.params.name);
  if (!file) return res.status(400).end();
  if (req.query.inline !== undefined) {
    res.set('Content-Disposition', `inline; filename="${path.basename(file)}"`);
    return res.sendFile(file, (err) => err && !res.headersSent && res.status(404).end());
  }
  res.download(file, path.basename(file), (err) => err && !res.headersSent && res.status(404).end());
});

app.delete('/api/books/:name', requireAuth, async (req, res) => {
  const file = safeBookPath(req.athleteId, req.params.name);
  if (!file) return res.status(400).end();
  await fsp.rm(file, { force: true });
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' });
});

app.listen(PORT, () => {
  console.log(`\n  Lap by Lap: ${BASE_URL}\n`);
  if (!isConfigured()) console.log('  ! STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET missing (.env) – see README.\n');
});
