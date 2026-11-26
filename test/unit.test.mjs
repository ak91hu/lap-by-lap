// Egységtesztek a tiszta (mellékhatás nélküli) segédfüggvényekre és a Strava-kliens keretkezelésére.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpDir } from './helpers.mjs';

process.env.LAPBYLAP_NO_DOTENV = '1';
process.env.DATA_DIR = tmpDir();

const { parseCsv } = await import('../src/archive.js');
const { Fmt, activityType, localDate, year } = await import('../src/format.js');
const { decodePolyline } = await import('../src/pdf/polyline.js');
const { downsampleStreams, summarize } = await import('../src/sync.js');
const { weatherKey } = await import('../src/weather.js');
const { parseRef, downloadName } = await import('../src/photos.js');
const { parseTrust } = await import('../src/config.js');
const { heavyLimit } = await import('../src/jobs.js');
const strava = await import('../src/strava.js');
const { t, normLang } = await import('../src/i18n.js');

test('parseCsv: idézőjeles, többsoros mezők, CRLF, üres sorok', () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","több\nsoros"\n\n2,"idéző ""jel""",\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'több\nsoros'], ['2', 'idéző "jel"', '']]);
});

test('Fmt: metrikus és angolszász mértékegységek, magyar és angol formázás', () => {
  const hu = new Fmt('hu', 'metric');
  assert.equal(hu.distance(12345), '12,35 km');
  assert.equal(hu.elevation(550), '550 m');
  assert.match(hu.duration(3725), /^1:02:05$/);
  const en = new Fmt('en', 'imperial');
  assert.match(en.distance(1609.344), /^1(\.00)? mi$/);
  assert.match(en.elevation(100), /^328 ft$/);
  const run = en.speedOrPace({ sport_type: 'Run', distance: 5000, average_speed: 1609.344 / 480 });
  assert.match(run.value, /8:00 \/mi/);
});

test('activityType / localDate / year', () => {
  assert.equal(activityType({ sport_type: 'TrailRun', type: 'Run' }), 'TrailRun');
  assert.equal(activityType({ type: 'Ride' }), 'Ride');
  const a = { start_date_local: '2024-05-12T08:30:00Z' };
  assert.equal(year(a), 2024);
  assert.equal(localDate(a).getUTCHours(), 8);
});

test('decodePolyline: Google példa', () => {
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  assert.equal(pts.length, 3);
  assert.deepEqual(pts[0].map((v) => Number(v.toFixed(3))), [38.5, -120.2]);
  assert.deepEqual(decodePolyline(''), []);
});

test('downsampleStreams: ~600 pontra ritkít, az utolsó pont megmarad', () => {
  const n = 5000;
  const raw = {
    latlng: { data: Array.from({ length: n }, (_, i) => [47 + i / 1e4, 19 + i / 1e4]) },
    altitude: { data: Array.from({ length: n }, (_, i) => 100 + i / 10) },
    distance: { data: Array.from({ length: n }, (_, i) => i * 2) },
    time: { data: Array.from({ length: n }, (_, i) => i) },
  };
  const s = downsampleStreams(raw);
  assert.ok(s.latlng.length <= 602 && s.latlng.length >= 500);
  assert.equal(s.time[s.time.length - 1], n - 1);
  assert.deepEqual(downsampleStreams({ latlng: { data: [[1, 2]] } }), { empty: true });
});

test('summarize: évek, sportágak, fotók', () => {
  const s = summarize([
    { start_date_local: '2025-01-01T00:00:00Z', sport_type: 'Run', total_photo_count: 2 },
    { start_date_local: '2026-01-01T00:00:00Z', sport_type: 'Ride', total_photo_count: 0 },
  ]);
  assert.equal(s.count, 2);
  assert.equal(s.photos, 2);
  assert.equal(s.photoActivities, 1);
  assert.deepEqual(Object.keys(s.years), ['2025', '2026']);
});

test('weatherKey: WMO-kódok csoportosítása', () => {
  assert.equal(weatherKey(0), 'clear');
  assert.equal(weatherKey(2), 'partly');
  assert.equal(weatherKey(45), 'fog');
  assert.equal(weatherKey(53), 'drizzle');
  assert.equal(weatherKey(63), 'rain');
  assert.equal(weatherKey(81), 'rain');
  assert.equal(weatherKey(75), 'snow');
  assert.equal(weatherKey(96), 'storm');
});

test('parseRef: csak érvényes aktivitás/fotó azonosítók (útvonal-bejárás ellen)', () => {
  assert.deepEqual(parseRef('123/abc_1.x-2'), ['123', 'abc_1.x-2']);
  for (const bad of ['../x', '123/../x', '123/a/b', 'abc/def', '123/', '/x', '123/a b', `123/${'a'.repeat(121)}`, '']) {
    assert.equal(parseRef(bad), null, bad);
  }
});

test('downloadName: dátum + tisztított név + sorszám', () => {
  assert.equal(downloadName({ start_date_local: '2024-05-12T08:00:00Z', name: 'Reggeli: futás / "Kör"?' }, 2), '2024-05-12 Reggeli futás Kör 03.jpg');
  assert.equal(downloadName(undefined, 0), 'photo 01.jpg');
});

test('parseTrust: Express trust proxy értékek', () => {
  assert.equal(parseTrust('true'), true);
  assert.equal(parseTrust('false'), false);
  assert.equal(parseTrust('2'), 2);
  assert.equal(parseTrust('loopback'), 'loopback');
});

test('heavyLimit: memória alapján számolt párhuzamosság, kézi felülírással', () => {
  const MB = 1024 ** 2;
  assert.equal(heavyLimit({}, 512 * MB, 1), 1); // Northflank ingyenes gép
  assert.equal(heavyLimit({}, 256 * MB, 1), 1); // legalább egy mindig fut
  assert.equal(heavyLimit({}, 4096 * MB, 4), 4); // a CPU-szám a felső korlát
  assert.equal(heavyLimit({}, 4096 * MB, 16), 8);
  assert.equal(heavyLimit({ MAX_HEAVY_JOBS: '3' }, 512 * MB, 1), 3);
});

test('i18n: hiányzó kulcsnál angol tartalék, nyelv normalizálás', () => {
  assert.equal(normLang('HU'), 'hu');
  assert.equal(normLang('de'), 'en');
  assert.equal(t('hu', 'errNoPhotos'), 'Nincs letölthető fotó.');
});

test('Strava: authorizeUrl tartalmazza a szükséges paramétereket', () => {
  const u = new URL(strava.authorizeUrl({ clientId: '1', redirectUri: 'https://x/auth/callback', state: 'abc' }));
  assert.equal(u.searchParams.get('scope'), strava.SCOPES);
  assert.equal(u.searchParams.get('state'), 'abc');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://x/auth/callback');
});

test('Strava: nextWindow negyedórára, nextUtcMidnight éjfél utánra mutat', () => {
  const w = new Date(strava.nextWindow());
  assert.equal(w.getUTCMinutes() % 15, 0);
  assert.ok(w.getTime() > Date.now());
  const m = new Date(strava.nextUtcMidnight());
  assert.equal(m.getUTCHours(), 0);
  assert.ok(m.getTime() > Date.now());
});

test('Strava: a keretfejlécek közös szünetet indítanak minden kliensnek', () => {
  strava.resetSharedPause();
  const waits = [];
  const a = new strava.StravaClient({ accessToken: 'a', expiresAt: 9e9 }, {}, { onWait: (u, k) => waits.push(['a', k]) });
  const b = new strava.StravaClient({ accessToken: 'b', expiresAt: 9e9 }, {}, { onWait: (u, k) => waits.push(['b', k]) });
  const headers = (limit, usage) => ({ headers: new Headers({ 'x-ratelimit-limit': limit, 'x-ratelimit-usage': usage }) });
  a.readLimits(headers('100,1000', '10,100'));
  assert.equal(strava.sharedPause().pauseUntil, 0, 'kevés használatnál nincs szünet');
  a.readLimits(headers('100,1000', '98,300'));
  assert.equal(strava.sharedPause().kind, 'window');
  a.readLimits(headers('100,1000', '50,998'));
  assert.equal(strava.sharedPause().kind, 'daily');
  // b még nem kapott fejlécet, de a kapuban átveszi a közös szünetet (és rögtön kihagyásra kérjük, hogy ne várjon)
  let skip = false;
  b.hooks.shouldSkip = () => skip;
  const gate = b.gate();
  skip = true;
  return gate.then(() => assert.fail('nem várt'), (err) => {
    assert.equal(err.code, 'SKIP_API');
    assert.ok(waits.some(([who, k]) => who === 'b' && k === 'daily'), 'b is jelezte a várakozást');
    strava.resetSharedPause();
  });
});

test('Strava: 401 után tokenfrissítés és újrapróbálás', async () => {
  strava.resetSharedPause();
  const realFetch = globalThis.fetch;
  const seen = [];
  let first = true;
  globalThis.fetch = async (url, opt = {}) => {
    seen.push(String(url));
    if (String(url).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'new', refresh_token: 'r2', expires_at: Date.now() / 1000 + 3600 }), { status: 200 });
    if (first) {
      first = false;
      return new Response('{}', { status: 401 });
    }
    assert.equal(opt.headers.Authorization, 'Bearer new');
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  };
  try {
    const saved = [];
    const c = new strava.StravaClient({ accessToken: 'old', refreshToken: 'r1', expiresAt: Date.now() / 1000 + 3600 }, { clientId: 'x', clientSecret: 'y' }, { onTokens: (tk) => saved.push(tk.accessToken) });
    assert.deepEqual(await c.athlete(), { id: 1 });
    assert.deepEqual(saved, ['new']);
    assert.ok(seen.some((u) => u.endsWith('/oauth/token')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Strava: 404 hibát dob státusszal (a hívó dönti el, mi legyen)', async () => {
  strava.resetSharedPause();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'Record Not Found' }), { status: 404 });
  try {
    const c = new strava.StravaClient({ accessToken: 'a', expiresAt: 9e9 }, {}, {});
    await assert.rejects(c.activity(5), (e) => e.status === 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});
