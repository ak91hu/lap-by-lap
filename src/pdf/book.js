// Nyomdakész PDF fotókönyv (PDFKit).
//
// Tervezési elvek (fotókönyves jó gyakorlatok):
//  • oldalpárokban gondolkodunk: a fejezetek (évek) jobb oldalon nyílnak, a bal oldalra az év fotója kerül;
//  • ritmus: hős-fotós (kifutó nyitókép) és klasszikus aktivitásoldalak váltakoznak, sűrű rácsok után nyugodt oldalak;
//  • kevés, de erős egész oldalas (kifutó) kép a kiemelt pillanatokhoz;
//  • a fotókon nincs szöveg – a képaláírások és a térkép-sorszámok a kép alatt, közös alapvonalon;
//  • két betűcsalád (Fraunces + Inter), bőkezű fehér tér, kötésoldali többletmargó;
//  • nyomdai minőség: 300 DPI-re méretezett képek, 3 mm kifutó, TrimBox/BleedBox, vágójelek.
//
// Memória: a képek elhelyezés-pontosan méretezve, egyenként kerülnek a PDF-be (beágyazás után
// felszabadulnak), az útvonal-adatsorok aktivitásonként töltődnek be, a PDF folyamatosan íródik ki.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Writable } from 'node:stream';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { activityType, localDate, year } from '../format.js';
import { loadStreams } from '../sync.js';
import { MAP } from '../config.js';
import { aspect } from './layout.js';
import { planPage } from './collage.js';
import { projectToBox, decodePolyline } from './polyline.js';
import { buildTrack, trimTrack, hasElevation, locatePhotos } from './track.js';
import { renderBasemap, basemapEnabled } from './maps.js';
import { weatherKey } from '../weather.js';

const require = createRequire(import.meta.url);
const fontDir = (pkg) => path.dirname(require.resolve(`@expo-google-fonts/${pkg}/package.json`));
const FONT_FILES = {
  sans: ['inter', '400Regular/Inter_400Regular.ttf'],
  sansItalic: ['inter', '400Regular_Italic/Inter_400Regular_Italic.ttf'],
  sansMedium: ['inter', '500Medium/Inter_500Medium.ttf'],
  sansSemi: ['inter', '600SemiBold/Inter_600SemiBold.ttf'],
  sansBold: ['inter', '700Bold/Inter_700Bold.ttf'],
  sansBlack: ['inter', '800ExtraBold/Inter_800ExtraBold.ttf'],
  serif: ['fraunces', '600SemiBold/Fraunces_600SemiBold.ttf'],
  serifLight: ['fraunces', '300Light/Fraunces_300Light.ttf'],
  serifItalic: ['fraunces', '400Regular_Italic/Fraunces_400Regular_Italic.ttf'],
  serifRegular: ['fraunces', '400Regular/Fraunces_400Regular.ttf'],
  sportHead: ['oswald', '600SemiBold/Oswald_600SemiBold.ttf'],
  elegantHead: ['playfair-display', '700Bold/PlayfairDisplay_700Bold.ttf'],
  elegantItalic: ['playfair-display', '400Regular_Italic/PlayfairDisplay_400Regular_Italic.ttf'],
};

/** Két hex szín lineáris keverése (t = 0 → a, 1 → b). */
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

export const MM = 72 / 25.4;

export const PAGE_SIZES = {
  a4: { w: 210, h: 297 },
  a4l: { w: 297, h: 210 },
  sq21: { w: 210, h: 210 },
  sq30: { w: 300, h: 300 },
  a5: { w: 148, h: 210 },
};

export const THEMES = {
  sunrise: { accent: '#D4511F', tint: '#F5EFE7', deep: '#2A1A14' },
  forest: { accent: '#2E6B4E', tint: '#EDF1EA', deep: '#14231B' },
  lake: { accent: '#1D6787', tint: '#EAF1F4', deep: '#0F1E26' },
  berry: { accent: '#9A2F5B', tint: '#F6EDF1', deep: '#2A1220' },
  graphite: { accent: '#2B2B2E', tint: '#F1F0EE', deep: '#1A1A1C' },
};

/** Papírvastagság levelenként (mm) a gerinc becsléséhez – a pontos értéket a nyomda adja meg. */
export const PAPER_CALIPER = { thin: 0.1, standard: 0.13, thick: 0.17 };

// Oldaltónusok. Nyomtatásra hangolt színek: a másodlagos szöveg elég sötét (ill. sötét lapon elég világos)
// ahhoz, hogy kis méretben is olvasható maradjon.
export const TONES = {
  white: { paper: null, base: '#FFFFFF', ink: '#1C1A17', ink2: '#3A3630', muted: '#625D55', hair: '#DDD7CC', soft: '#ECE7DF', leader: '#B9B2A6', cell: '#FFFFFF', dark: false },
  cream: { paper: '#FBF6EC', base: '#FBF6EC', ink: '#1E1B16', ink2: '#3B362E', muted: '#625B50', hair: '#DED5C5', soft: '#EDE5D7', leader: '#BBB09F', cell: '#FFFDF8', dark: false },
  night: { paper: '#151412', base: '#151412', ink: '#F3EFE8', ink2: '#DAD4CA', muted: '#A59E93', hair: '#3A3631', soft: '#2B2824', leader: '#5A554D', cell: '#2C2925', dark: true },
};

// ====================================================================== belépési pontok

/**
 * Kétmenetes tördelés: az első („száraz”) menet képfeldolgozás nélkül kiszámolja az oldalszámokat
 * a tartalomjegyzékhez, a második elkészíti a valódi PDF-et. A tördelés determinisztikus
 * (csak a képek méretadataitól függ), így a két menet oldalszámai megegyeznek.
 */
export async function buildBook(args) {
  let marks = null;
  if (args.options.toc !== false) {
    const noop = { phase() {}, tick() {}, wait() {} };
    ({ marks } = await renderBook({ ...args, ctx: noop, dry: true }));
  }
  return renderBook({ ...args, marks });
}

async function renderBook({ entries, athlete, avatarFile, options, outFile, ctx, fmt, images, dry = false, marks = null }) {
  const book = new Book(options, athlete, fmt, images, null, dry);
  const finished = dry ? book.pipeNull() : book.pipeTo(outFile);
  const ordered = options.order === 'desc' ? [...entries].reverse() : entries;
  const chapters = buildChapters(ordered, options.chapters, fmt);

  ctx.phase('phasePdf', entries.length);
  if (options.coverSpread) book.titlePage(entries);
  else await book.cover(entries, options.coverFile);
  if (options.dedication?.trim()) book.dedication(options.dedication.trim());
  if (options.toc !== false) book.toc(entries, chapters, marks);
  await book.overview(entries, avatarFile);
  if (options.routesPage !== false) book.routesPage(entries);

  // Kiemelések: a felhasználó kedvencei, vagy ha nincsenek, automatikusan a legnépszerűbbek.
  const favs = new Set((options.favorites || []).map(String));
  const highlights = favs.size
    ? new Set(entries.filter((e) => favs.has(String(e.activity.id)) && e.photos.length).map((e) => e.activity.id))
    : pickHighlights(entries);
  for (const ch of chapters) {
    if (ch.kind !== 'none') {
      if (options.yearPages !== false) await book.chapterOpener(ch);
      else book.startChapter(ch.title);
    }
    const rest = [];
    for (const e of ch.list) {
      if (e.photos.length) await book.activity(e, highlights.has(e.activity.id));
      else rest.push(e);
      ctx.tick();
    }
    if (rest.length && options.listNoPhoto !== false) book.logList(rest, ch.title);
  }

  if (options.afterword?.trim()) book.afterword(options.afterword.trim());
  book.finish();
  book.doc.end();
  await finished;
  return dry ? { marks: book.marks } : book.report();
}

/** Borító-terítő (hátsó borító + gerinc + első borító) a kötészethez, 3 mm kifutóval. */
export async function buildCoverSpread({ entries, athlete, options, outFile, fmt, images, pages }) {
  const size = PAGE_SIZES[options.pageSize] || PAGE_SIZES.a4;
  const caliper = PAPER_CALIPER[options.paper] ?? PAPER_CALIPER.standard;
  const spineMm = options.spineMm > 0 ? options.spineMm : Math.max(2, Math.round((pages / 2) * caliper * 10) / 10);
  const spine = spineMm * MM;
  const tw = size.w * MM;
  const book = new Book({ ...options, bleed: true, cropMarks: false, gutter: false }, athlete, fmt, images, {
    w: tw * 2 + spine, h: size.h * MM,
  });
  const finished = book.pipeTo(outFile);
  book.newPage({ footer: false });
  const b = book.bleed;
  await book.drawCover(entries, options.coverFile, tw + spine, 0, tw, book.th, { l: 0, r: b, t: b, b });
  book.backCover(entries, 0, 0, tw, book.th, b);
  book.spine(entries, tw, spine, spineMm);
  book.doc.end();
  await finished;
  return { spineMm, widthMm: Math.round((book.tw / MM) * 10) / 10, heightMm: size.h };
}

// ====================================================================== segédek

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function athleteName(a) {
  return [a?.firstname, a?.lastname].filter(Boolean).join(' ');
}

function dateRange(entries) {
  if (!entries.length) return '';
  const y1 = year(entries[0].activity);
  const y2 = year(entries[entries.length - 1].activity);
  return y1 === y2 ? String(y1) : `${y1}–${y2}`;
}

function totals(acts) {
  const days = new Set();
  const t = { count: acts.length, distance: 0, elevation: 0, time: 0, days: 0 };
  for (const a of acts) {
    t.distance += a.distance || 0;
    t.elevation += a.total_elevation_gain || 0;
    t.time += a.moving_time || 0;
    days.add((a.start_date_local || '').slice(0, 10));
  }
  t.days = days.size;
  return t;
}

/**
 * Fejezetekre bontás: év, hónap, évszak (meteorológiai; a december a következő év telébe tartozik),
 * sportág vagy egyetlen folyamatos fejezet.
 */
function buildChapters(entries, mode, f) {
  const SEASON = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 0];
  const keyOf = (e) => {
    const d = localDate(e.activity);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    switch (mode) {
      case 'month':
        return { key: `${y}-${String(m + 1).padStart(2, '0')}`, title: f.monthYear(d), kind: 'month' };
      case 'season': {
        const sy = m === 11 ? y + 1 : y;
        const si = SEASON[m];
        // A tél két évre nyúlik át: „Tél 2025/26”.
        const label = si === 0 ? `${sy - 1}/${String(sy).slice(2)}` : String(sy);
        return { key: `${sy}-${si}`, title: `${f.t(`season${si}`)} ${label}`, kind: 'season' };
      }
      case 'sport': {
        const t = activityType(e.activity);
        return { key: `sport-${t}`, title: f.sport(t), kind: 'sport' };
      }
      case 'none':
        return { key: 'all', title: '', kind: 'none' };
      default:
        return { key: String(y), title: String(y), kind: 'year', year: y };
    }
  };
  const map = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (!map.has(k.key)) map.set(k.key, { ...k, list: [] });
    map.get(k.key).list.push(e);
  }
  const chapters = [...map.values()];
  // Sportág szerinti bontásnál a leggyakoribb sportág kerül előre.
  if (mode === 'sport') chapters.sort((a, b) => b.list.length - a.list.length);
  return chapters;
}

/** Kiemelt aktivitások (egész oldalas fotóval): a könyv méretével arányosan, max. 8 db. */
function pickHighlights(entries) {
  const withPhotos = entries.filter((e) => e.photos.length >= 3);
  const k = Math.max(0, Math.min(8, Math.round(withPhotos.length / 10)));
  const score = (e) => (e.activity.kudos_count || 0) + e.photos.length * 2 + (e.activity.achievement_count || 0);
  return new Set(withPhotos.sort((a, b) => score(b) - score(a)).slice(0, k).map((e) => e.activity.id));
}


// ====================================================================== a könyv

class Book {
  constructor(opts, athlete, fmt, images, trimOverride, dry = false) {
    this.dry = dry; // „száraz” menet: csak tördelés, képfeldolgozás nélkül (tartalomjegyzékhez)
    this.marks = { sections: {}, years: {}, acts: {} };
    this.minFont = Infinity;
    const size = PAGE_SIZES[opts.pageSize] || PAGE_SIZES.a4;
    this.opts = opts;
    this.athlete = athlete;
    this.f = fmt;
    this.images = images;
    this.theme = THEMES[opts.theme] || THEMES.sunrise;
    // Egyedi akcentszín (a felhasználó saját színe, pl. klubszín) felülírja a téma színét.
    this.accent = /^#[0-9a-f]{6}$/i.test(opts.accent || '') ? opts.accent : this.theme.accent;
    this.c = TONES[opts.tone] || TONES.white;
    this.tintBg = this.c.dark ? '#211F1B' : opts.tone === 'cream' ? mix(this.theme.tint, '#F4EBDA', 0.5) : this.theme.tint;
    this.routeColor = opts.routeColor === 'ink' ? this.c.ink : this.accent;
    this.layout = ['gallery', 'journal'].includes(opts.layout) ? opts.layout : 'magazine';
    this.tw = trimOverride?.w ?? size.w * MM;
    this.th = trimOverride?.h ?? size.h * MM;
    this.bleed = opts.bleed ? 3 * MM : 0;
    this.slug = opts.cropMarks ? 10 * MM : 0;
    this.off = this.bleed + this.slug;
    const minSide = Math.min(size.w, size.h) * MM;
    this.s = 0.74 + 0.26 * (minSide / 595.28); // tipográfiai skála
    this.m = Math.max(14 * MM, minSide * 0.085); // margó
    this.gutter = opts.gutter === false ? 0 : 6 * MM;
    this.gap = 3.5 * MM * this.s;
    this.landscape = this.tw > this.th * 1.15 && !trimOverride;
    this.pageNo = 0;
    this.lowRes = [];
    this.photoCount = 0;
    this.chapter = null;
    this.lastTemplate = null;
    this.headFont = { modern: 'sansBlack', sport: 'sportHead', elegant: 'elegantHead' }[opts.typeface] || 'serif';
    // A sportos (keskeny) betűnél nagyobb méret és nagybetűs címek – ez adja a karakterét.
    this.headScale = opts.typeface === 'sport' ? 1.12 : 1;
    this.headUpper = opts.typeface === 'sport';
    this.italicFont = opts.typeface === 'elegant' ? 'elegantItalic' : 'serifItalic';
    this.favorites = new Set((opts.favorites || []).map(String));

    this.doc = new PDFDocument({
      size: [this.tw + 2 * this.off, this.th + 2 * this.off],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: false,
      bufferPages: false,
      compress: true,
      // Az átlátszóság (színátmenetek, áttetsző elemek) PDF 1.4+ funkció; a nyomdai előellenőrzők
      // hibának jelzik, ha egy 1.3-as fájl használja. 1.7 = ISO 32000-1.
      pdfVersion: '1.7',
      lang: fmt.lang === 'hu' ? 'hu-HU' : 'en-GB',
      displayTitle: true,
      info: {
        Title: opts.title || 'Lap by Lap',
        Author: athleteName(athlete),
        Subject: dateRange([]) || 'Strava',
        Creator: 'Lap by Lap',
        Producer: 'Lap by Lap / PDFKit',
      },
    });
    for (const [name, [pkg, file]] of Object.entries(FONT_FILES)) {
      this.doc.registerFont(name, path.join(fontDir(pkg), file));
    }
    if (!dry) this.outputIntent();
  }

  /** sRGB OutputIntent: a nyomda színkezelése egyértelműen tudja, milyen színtérben vannak a képek és a színek. */
  outputIntent() {
    const doc = this.doc;
    const icc = fs.readFileSync(path.join(path.dirname(require.resolve('pdfkit')), 'data', 'sRGB_IEC61966_2_1.icc'));
    const profile = doc.ref({ Length: icc.length, N: 3 });
    profile.write(icc);
    profile.end();
    const intent = doc.ref({
      Type: 'OutputIntent',
      S: 'GTS_PDFA1',
      Info: new String('sRGB IEC61966-2.1'),
      OutputConditionIdentifier: new String('sRGB IEC61966-2.1'),
      RegistryName: new String('http://www.color.org'),
      DestOutputProfile: profile,
    });
    intent.end();
    doc._root.data.OutputIntents = [intent];
  }

  pipeNull() {
    const sink = new Writable({ write: (chunk, enc, cb) => cb() });
    const p = new Promise((resolve, reject) => {
      sink.on('finish', resolve);
      this.doc.on('error', reject);
    });
    this.doc.pipe(sink);
    return p;
  }

  pipeTo(file) {
    const out = fs.createWriteStream(file);
    const p = new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
      this.doc.on('error', reject);
    });
    this.doc.pipe(out);
    return p;
  }

  // ------------------------------------------------------------ oldalkezelés

  isRight(n = this.pageNo) {
    return n % 2 === 1;
  }

  newPage({ footer = true, bg = null } = {}) {
    const doc = this.doc;
    doc.addPage();
    this.pageNo++;
    const o = this.off;
    doc.page.dictionary.data.TrimBox = [o, o, o + this.tw, o + this.th];
    doc.page.dictionary.data.BleedBox = [o - this.bleed, o - this.bleed, o + this.tw + this.bleed, o + this.th + this.bleed];
    if (this.slug) this.cropMarks();
    doc.translate(o, o);
    if (bg) this.fillBleed(bg);
    else if (this.c.paper) this.fillBleed(this.c.paper); // krém vagy éjszakai papírtónus kifutóig
    const right = this.isRight();
    this.x0 = this.m + (right ? this.gutter : 0);
    this.W = this.tw - 2 * this.m - this.gutter;
    this.y0 = this.m;
    this.yMax = this.th - this.m;
    if (footer) this.footer(right);
    return this.y0;
  }

  fillBleed(color) {
    const b = this.bleed;
    this.doc.rect(-b, -b, this.tw + 2 * b, this.th + 2 * b).fill(color);
  }

  cropMarks() {
    const d = this.doc;
    const o = this.off;
    const len = 6 * MM;
    const gap = this.bleed + 1 * MM;
    d.save().lineWidth(0.25).strokeColor('#000000');
    for (const x of [o, o + this.tw]) {
      for (const y of [o, o + this.th]) {
        const sx = x === o ? -1 : 1;
        const sy = y === o ? -1 : 1;
        d.moveTo(x + sx * gap, y).lineTo(x + sx * (gap + len), y).stroke();
        d.moveTo(x, y + sy * gap).lineTo(x, y + sy * (gap + len)).stroke();
      }
    }
    d.restore();
  }

  /**
   * Élőfej a lap alján, klasszikus könyves rendben: a folió (oldalszám) a külső sarokban,
   * mellette bal oldalon a könyv címe, jobb oldalon az aktuális fejezet (év).
   */
  footer(right) {
    const s = this.s;
    const y = this.th - this.m * 0.6;
    const size = 7.4 * s;
    const folio = String(this.pageNo);
    const run = this.opts.runningHeads === false ? '' : (right ? this.chapter : this.opts.title || 'Lap by Lap') || '';
    const d = this.doc;
    d.font('sansSemi').fontSize(size);
    const fw = d.widthOfString(folio, { features: ['tnum'] });
    const gap = 8 * s;
    if (right) {
      const fx = this.x0 + this.W - fw;
      this.text(folio, fx, y, { font: 'sansSemi', size, color: this.c.ink, lines: 1, features: ['tnum'] });
      if (run) {
        d.save().moveTo(fx - gap / 2, y + 0.5).lineTo(fx - gap / 2, y + size * 0.95).lineWidth(0.5).strokeColor(this.c.hair).stroke().restore();
        this.text(run.toLocaleUpperCase(this.f.locale), this.x0, y + 0.6, { size: size * 0.92, color: this.c.muted, width: this.W - fw - gap, align: 'right', lines: 1, spacing: 0.8 * s });
      }
    } else {
      this.text(folio, this.x0, y, { font: 'sansSemi', size, color: this.c.ink, lines: 1, features: ['tnum'] });
      if (run) {
        d.save().moveTo(this.x0 + fw + gap / 2, y + 0.5).lineTo(this.x0 + fw + gap / 2, y + size * 0.95).lineWidth(0.5).strokeColor(this.c.hair).stroke().restore();
        this.text(run.toLocaleUpperCase(this.f.locale), this.x0 + fw + gap, y + 0.6, { size: size * 0.92, color: this.c.muted, width: this.W - fw - gap, lines: 1, spacing: 0.8 * s });
      }
    }
  }

  startChapter(title) {
    this.chapter = title;
    this.yearOutline = this.doc.outline.addItem(title);
  }

  // ------------------------------------------------------------ rajzelemek

  text(str, x, y, { font = 'sans', size = 10, color = this.c.ink, width, align = 'left', lines, lineGap = 0, spacing = 0, height, features } = {}) {
    const d = this.doc;
    if (font === this.headFont) {
      size *= this.headScale;
      if (this.headUpper) str = String(str).toLocaleUpperCase(this.f.locale);
    }
    if (size < this.minFont && str) this.minFont = size;
    d.font(font).fontSize(size).fillColor(color);
    const opts = { width, align, lineGap, characterSpacing: spacing };
    if (features) opts.features = features;
    const lh = d.currentLineHeight(true) + lineGap;
    if (lines) opts.height = lh * lines;
    if (height) opts.height = height;
    if (opts.height) opts.ellipsis = true;
    if (!width) opts.lineBreak = false;
    const measured = width ? d.heightOfString(str, opts) : lh;
    d.text(str, x, y, opts);
    return Math.min(measured, opts.height ?? Infinity);
  }

  kicker(str, x, y, width, color = this.accent) {
    return this.text(str.toLocaleUpperCase(this.f.locale), x, y, {
      font: 'sansSemi', size: 7.4 * this.s, color, width, spacing: 1.1 * this.s, lines: 1,
    });
  }

  hair(x, y, w, color = this.c.hair, lw = 0.5) {
    this.doc.save().moveTo(x, y).lineTo(x + w, y).lineWidth(lw).strokeColor(color).stroke().restore();
  }

  async coverImage(file, x, y, w, h) {
    if (this.dry) return;
    const buf = await this.images.cover(file, w, h);
    this.doc.image(buf, x, y, { width: w, height: h });
  }

  /**
   * Statisztikasáv: egyenlő cellák, a cellák között finom függőleges elválasztóval
   * (sport-magazinos adatsor). A sorok kiegyensúlyozottak: 8 adat 4+4, nem 6+2.
   */
  statGrid(stats, x, y, width, { minCell = 80, valueSize = 14, cols: forceCols, labelColor = this.c.muted, valueColor = this.c.ink, rules = true } = {}) {
    if (!stats.length) return 0;
    const s = this.s;
    const maxCols = Math.max(1, Math.min(stats.length, Math.floor(width / (minCell * s))));
    const cols = forceCols || Math.ceil(stats.length / Math.ceil(stats.length / maxCols));
    const cw = width / cols;
    const pad = rules ? 9 * s : 0;
    const rowH = (7 + 6 + valueSize + 2) * s;
    const gapY = 12 * s;
    stats.forEach(([label, value], i) => {
      const col = i % cols;
      const cx = x + col * cw + (col ? pad : 0);
      const cy = y + Math.floor(i / cols) * (rowH + gapY);
      const w = cw - (col ? pad : 0) - 6;
      if (rules && col) {
        this.doc.save().moveTo(x + col * cw, cy + 1).lineTo(x + col * cw, cy + rowH - 2 * s).lineWidth(0.5).strokeColor(this.c.hair).stroke().restore();
      }
      this.text(label.toLocaleUpperCase(this.f.locale), cx, cy, { font: 'sansSemi', size: 6.8 * s, color: labelColor, width: w, spacing: 0.6 * s, lines: 1 });
      this.text(value, cx, cy + 12.5 * s, { font: 'sansMedium', size: valueSize * s, color: valueColor, width: w, lines: 1, features: ['tnum'] });
    });
    const rows = Math.ceil(stats.length / cols);
    return rows * rowH + (rows - 1) * gapY;
  }

  statGridHeight(n, width, { minCell = 80, valueSize = 14 } = {}) {
    const s = this.s;
    const maxCols = Math.max(1, Math.min(n, Math.floor(width / (minCell * s))));
    const rows = Math.ceil(n / Math.ceil(n / Math.ceil(n / maxCols)));
    return rows * (7 + 6 + valueSize + 2) * s + (rows - 1) * 12 * s;
  }

  pin(cx, cy, num, r = 5.6 * this.s) {
    const d = this.doc;
    d.circle(cx, cy, r).lineWidth(0.9 * this.s).fillAndStroke(this.accent, '#FFFFFF');
    const size = Math.max(5.5, r * (num > 9 ? 0.95 : 1.12));
    this.text(String(num), cx - r - 2, cy - size * 0.52, { font: 'sansBold', size, color: '#FFFFFF', width: 2 * r + 4, align: 'center', lines: 1, features: ['tnum'] });
  }

  // ------------------------------------------------------------ tartalomjegyzék

  /**
   * Tartalomjegyzék: szakaszok, évek és a fotós aktivitások, pontozott vezetővonallal és jobbra
   * igazított oldalszámmal. A száraz menetben helyőrző számokkal ugyanannyi helyet foglal.
   */
  toc(entries, chapters, marks) {
    const s = this.s;
    const f = this.f;
    const rows = [];
    rows.push({ kind: 'section', label: f.t('overview'), key: 'overview' });
    if (this.opts.routesPage !== false && entries.filter((e) => e.activity.polyline).length >= 4) rows.push({ kind: 'section', label: f.t('allRoutes'), key: 'routes' });
    for (const ch of chapters) {
      if (ch.kind !== 'none') rows.push({ kind: 'year', label: ch.title, key: ch.key });
      for (const e of ch.list) {
        if (!e.photos.length) continue;
        rows.push({ kind: 'item', label: e.activity.name || f.t('untitled'), date: f.dayMonth(localDate(e.activity)), key: e.activity.id });
      }
    }
    const page = (r) => {
      if (!marks) return '000';
      const p = r.kind === 'section' ? marks.sections[r.key] : r.kind === 'year' ? marks.years[r.key] : marks.acts[r.key];
      return p ? String(p) : '';
    };

    const rowH = { section: 20 * s, year: 30 * s, item: 15.5 * s };
    const totalH = rows.reduce((t, r) => t + rowH[r.kind], 0);
    let i = 0;
    let first = true;
    while (i < rows.length) {
      let y = this.newPage();
      if (first) {
        this.doc.outline.addItem(f.t('contents'));
        this.kicker(this.opts.title || 'Lap by Lap', this.x0, y, this.W);
        y += 14 * s;
        this.text(f.t('contents'), this.x0, y, { font: this.headFont, size: 26 * s, width: this.W, lines: 1 });
        y += 48 * s;
        first = false;
      }
      // Egy oszlop, ha minden elfér (olvasható szélességben); egyébként két oszlop széles oldalon.
      const oneCol = totalH <= this.yMax - y - 8 * s || this.W <= 420 * s;
      const cols = oneCol ? 1 : 2;
      const colGap = 26 * s;
      const colW = oneCol ? Math.min(this.W, 380 * s) : (this.W - colGap) / 2;
      for (let c = 0; c < cols && i < rows.length; c++) {
        let cy = y;
        const cx = this.x0 + c * (colW + colGap);
        while (i < rows.length) {
          const r = rows[i];
          const h = rowH[r.kind];
          if (cy + h > this.yMax - 4 * s) break;
          // ne maradjon egy évcím árván az oszlop alján
          if (r.kind === 'year' && cy + h + rowH.item * 2 > this.yMax) break;
          this.tocRow(r, page(r), cx, cy, colW);
          cy += h;
          i++;
        }
      }
    }
  }

  tocRow(r, pg, x, y, w) {
    const s = this.s;
    const d = this.doc;
    const numW = 26 * s;
    if (r.kind === 'year') {
      const yy = y + 8 * s;
      this.text(r.label, x, yy, { font: this.headFont, size: 15 * s, color: this.c.ink, width: w - numW, lines: 1 });
      this.text(pg, x + w - numW, yy + 4 * s, { font: 'sansSemi', size: 8.6 * s, color: this.accent, width: numW, align: 'right', lines: 1, features: ['tnum'] });
      this.hair(x, yy + 21 * s, w);
      return;
    }
    const size = r.kind === 'section' ? 9.4 * s : 8.6 * s;
    const font = r.kind === 'section' ? 'sansSemi' : 'sans';
    let tx = x;
    if (r.date) {
      this.text(r.date, x, y + 0.6 * s, { font: 'sansMedium', size: 7.4 * s, color: this.c.muted, width: 40 * s, lines: 1, features: ['tnum'] });
      tx += 42 * s;
    }
    d.font(font).fontSize(size);
    const maxLabel = w - (tx - x) - numW - 10 * s;
    let label = r.label;
    if (d.widthOfString(label) > maxLabel) {
      while (label.length > 1 && d.widthOfString(`${label}…`) > maxLabel) label = label.slice(0, -1);
      label = `${label.trimEnd()}…`;
    }
    const lw = d.widthOfString(label);
    this.text(label, tx, y, { font, size, color: this.c.ink, lines: 1 });
    // pontozott vezetővonal a címtől az oldalszámig
    const lx0 = tx + lw + 5 * s;
    const lx1 = x + w - numW - 2 * s;
    if (lx1 - lx0 > 8 * s) {
      d.save().moveTo(lx0, y + size * 0.82).lineTo(lx1, y + size * 0.82).lineWidth(0.6).dash(0.6, { space: 2.6 * s }).strokeColor(this.c.leader).stroke().undash().restore();
    }
    this.text(pg, x + w - numW, y, { font: 'sansSemi', size, color: this.c.ink, width: numW, align: 'right', lines: 1, features: ['tnum'] });
  }

  // ------------------------------------------------------------ borító

  async cover(entries, coverFile) {
    this.newPage({ footer: false });
    const b = this.bleed;
    await this.drawCover(entries, coverFile, 0, 0, this.tw, this.th, { l: b, r: b, t: b, b });
    this.doc.outline.addItem(this.opts.title || 'Lap by Lap');
  }

  /** Borító egy (x, y, w, h) keretbe; ext = kifutó kiterjesztés oldalanként. */
  async drawCover(entries, coverFile, x, y, w, h, ext) {
    const s = this.s;
    const d = this.doc;
    const style = this.opts.coverStyle === 'routes' || (!coverFile && !entries.some((e) => e.photos.length)) ? 'routes' : 'photo';
    const bx = x - ext.l;
    const by = y - ext.t;
    const bw = w + ext.l + ext.r;
    const bh = h + ext.t + ext.b;
    const m = Math.max(14 * MM, Math.min(w, h) * 0.085);
    const tx = x + m;
    const tW = w - 2 * m;
    const rawTitle = this.opts.title || 'Lap by Lap';
    const title = this.headUpper ? rawTitle.toLocaleUpperCase(this.f.locale) : rawTitle;
    const titleSize = Math.min(64, 44 * s * Math.sqrt(w / 595)) * this.headScale;
    const meta = [athleteName(this.athlete), this.opts.volumeLabel, dateRange(entries)].filter(Boolean).join('   ·   ');

    if (style === 'photo') {
      const photo = coverFile ? { file: coverFile } : pickCoverPhoto(entries, w / h);
      d.rect(bx, by, bw, bh).fill(this.theme.deep);
      if (photo) await this.coverImage(photo.file, bx, by, bw, bh);
      d.font(this.headFont).fontSize(titleSize);
      const lg = -titleSize * 0.1;
      const titleH = d.heightOfString(title, { width: tW, lineGap: lg });
      const sub = this.opts.subtitle || '';
      const blockH = 18 * s + titleH + 6 * s + (sub ? 24 * s : 0) + 22 * s;
      const pos = ['top', 'center'].includes(this.opts.titlePos) ? this.opts.titlePos : 'bottom';
      // A szöveg mögé a pozíciónak megfelelő, finom színátmenet kerül, hogy a cím minden fotón olvasható legyen.
      const g = pos === 'top' ? d.linearGradient(0, y, 0, y + h * 0.55) : pos === 'center' ? null : d.linearGradient(0, y + h * 0.45, 0, y + h);
      if (pos === 'top') g.stop(0, '#000000', 0.65).stop(1, '#000000', 0);
      if (pos === 'bottom') g.stop(0, '#000000', 0).stop(1, '#000000', 0.7);
      if (g) d.rect(bx, by, bw, bh).fill(g);
      else d.save().fillOpacity(0.32).rect(bx, by, bw, bh).fill('#000000').restore();
      let ty = pos === 'top' ? y + m + 18 * s : pos === 'center' ? y + (h - blockH) / 2 + 18 * s : y + h - m - titleH - (sub ? 24 * s : 0) - 30 * s;
      d.rect(tx, ty - 18 * s, 28 * s, 2.5 * s).fill(this.accent === this.c.ink ? '#FFFFFF' : this.accent);
      d.fillColor('#FFFFFF').text(title, tx, ty, { width: tW, lineGap: lg });
      ty += titleH + 6 * s;
      if (sub) ty += this.text(sub, tx, ty, { font: this.italicFont, size: 14 * s, color: '#FFFFFF', width: tW, lines: 1 }) + 8 * s;
      this.text(meta.toLocaleUpperCase(this.f.locale), tx, ty + 6 * s, { font: 'sansSemi', size: 7 * s, color: '#FFFFFF', width: tW, lines: 1, spacing: 1.1 * s });
    } else {
      // Útvonal-mozaik borító: papírszín, nagy cím, alatta a leghosszabb útvonalak rácsa.
      d.rect(bx, by, bw, bh).fill(this.tintBg);
      let ty = y + m * 1.1;
      this.kicker(meta, tx, ty, tW);
      ty += 18 * s;
      d.font(this.headFont).fontSize(titleSize);
      const lg = -titleSize * 0.1;
      const titleH = Math.min(d.heightOfString(title, { width: tW, lineGap: lg }), titleSize * 3.2);
      d.fillColor(this.c.ink).text(title, tx, ty, { width: tW, lineGap: lg, height: titleSize * 3.2, ellipsis: true });
      ty += titleH + 6 * s;
      if (this.opts.subtitle) ty += this.text(this.opts.subtitle, tx, ty, { font: this.italicFont, size: 14 * s, color: this.c.muted, width: tW, lines: 1 });
      const top = Math.max(ty + 26 * s, y + h * 0.4);
      const polys = entries.filter((e) => e.activity.polyline)
        .sort((a, b2) => (b2.activity.distance || 0) - (a.activity.distance || 0))
        .slice(0, 96)
        .sort((a, b2) => a.activity.start_date_local.localeCompare(b2.activity.start_date_local))
        .map((e) => e.activity.polyline);
      this.routeMosaic(polys, tx, top, tW, y + h - m - top, { color: this.accent, maxWidth: 1.1 });
    }
  }

  titlePage(entries) {
    // Belső címoldal (ha a borító külön terítőként készül).
    const s = this.s;
    this.newPage({ footer: false });
    const w = Math.min(this.W, 380 * s);
    const x = (this.tw - w) / 2;
    const title = this.headUpper ? (this.opts.title || 'Lap by Lap').toLocaleUpperCase(this.f.locale) : this.opts.title || 'Lap by Lap';
    const d = this.doc;
    const size = 30 * s * this.headScale;
    d.font(this.headFont).fontSize(size);
    const h = d.heightOfString(title, { width: w, align: 'center' });
    const y = this.th * 0.36;
    d.rect(this.tw / 2 - 12 * s, y - 24 * s, 24 * s, 2.5 * s).fill(this.accent);
    d.fillColor(this.c.ink).text(title, x, y, { width: w, align: 'center' });
    let ty = y + h + 8 * s;
    if (this.opts.subtitle) ty += this.text(this.opts.subtitle, x, ty, { font: this.italicFont, size: 13 * s, color: this.c.muted, width: w, align: 'center', lines: 2 }) + 10 * s;
    const meta = [athleteName(this.athlete), this.opts.volumeLabel, dateRange(entries)].filter(Boolean).join('   ·   ');
    this.text(meta.toLocaleUpperCase(this.f.locale), x, ty + 10 * s, { font: 'sansSemi', size: 7 * s, color: this.c.muted, width: w, align: 'center', lines: 1, spacing: 1.1 * s });
    this.doc.outline.addItem(title);
  }

  backCover(entries, x, y, w, h, b) {
    const s = this.s;
    const d = this.doc;
    d.rect(x - b, y - b, w + b, h + 2 * b).fill(this.tintBg);
    const m = Math.max(14 * MM, Math.min(w, h) * 0.085);
    const acts = entries.map((e) => e.activity);
    const t = totals(acts);
    const photos = entries.reduce((n, e) => n + e.photos.length, 0);
    const polys = entries.filter((e) => e.activity.polyline).map((e) => e.activity.polyline).slice(-400);
    const areaH = h * 0.5;
    this.routeMosaic(polys, x + m, y + m, w - 2 * m, areaH, { color: this.c.ink, maxWidth: 0.7 });
    const line = this.f.t('backCoverLine', { acts: this.f.n0(t.count), dist: this.f.bigDistance(t.distance), elev: this.f.elevation(t.elevation), photos: this.f.n0(photos) });
    this.text(line, x + m, y + m + areaH + 24 * s, { font: 'sansMedium', size: 8.5 * s, color: this.c.ink, width: w - 2 * m, align: 'center', lines: 2 });
    this.text(`Lap by Lap  ·  ${this.f.t('dataSource')}`, x + m, y + h - m, { size: 6.5 * s, color: this.c.muted, width: w - 2 * m, align: 'center', lines: 1 });
  }

  spine(entries, x, w, spineMm) {
    const s = this.s;
    const d = this.doc;
    const b = this.bleed;
    const dark = this.opts.coverStyle !== 'routes';
    d.rect(x, -b, w, this.th + 2 * b).fill(dark ? this.theme.deep : this.tintBg);
    if (spineMm < 6) return; // túl vékony gerincre nem kerül felirat
    const label = [this.opts.title || 'Lap by Lap', this.opts.volumeLabel, dateRange(entries)].filter(Boolean).join('   ·   ');
    const size = Math.min(w * 0.42, 11 * s);
    const cx = x + w / 2;
    const cy = this.th / 2;
    const len = this.th - 30 * MM;
    // Magyar könyveken a gerincfelirat alulról felfelé, angolon felülről lefelé olvasható.
    d.save();
    d.rotate(this.f.lang === 'hu' ? -90 : 90, { origin: [cx, cy] });
    this.text(label, cx - len / 2, cy - size * 0.62, { font: 'sansSemi', size, color: dark ? '#FFFFFF' : this.c.ink, width: len, align: 'center', lines: 1, spacing: 0.8 * s });
    d.restore();
  }

  dedication(text) {
    this.newPage({ footer: false });
    const s = this.s;
    const w = Math.min(this.W, 320 * s);
    const x = (this.tw - w) / 2;
    const d = this.doc;
    d.font(this.italicFont).fontSize(15 * s);
    const h = d.heightOfString(text, { width: w, align: 'center', lineGap: 5 });
    const y = this.th * 0.4 - h / 2;
    d.fillColor(this.c.ink).text(text, x, y, { width: w, align: 'center', lineGap: 5 });
    d.rect(this.tw / 2 - 10 * s, y + h + 20 * s, 20 * s, 2).fill(this.accent);
  }

  // ------------------------------------------------------------ áttekintés

  async overview(entries, avatarFile) {
    const s = this.s;
    const f = this.f;
    const acts = entries.map((e) => e.activity);
    let y = this.newPage();
    this.marks.sections.overview = this.pageNo;
    this.doc.outline.addItem(f.t('overview'));
    const x = this.x0;
    const W = this.W;

    const r = 26 * s;
    let tx = x;
    if (avatarFile) {
      const d = this.doc;
      if (!this.dry) {
        const buf = await this.images.square(avatarFile, 2 * r);
        d.save().circle(x + r, y + r, r).clip();
        d.image(buf, x, y, { width: 2 * r, height: 2 * r });
        d.restore();
      }
      tx = x + 2 * r + 16 * s;
    }
    this.kicker(f.t('overview'), tx, y + 4 * s, W);
    this.text(athleteName(this.athlete) || 'Strava', tx, y + 16 * s, { font: this.headFont, size: 26 * s, width: x + W - tx, lines: 1 });
    const place = [this.athlete?.city, this.athlete?.country].filter(Boolean).join(', ');
    this.text([place, dateRange(entries)].filter(Boolean).join('   ·   '), tx, y + 50 * s, { size: 9 * s, color: this.c.muted, width: x + W - tx, lines: 1 });
    y += Math.max(2 * r, 64 * s) + 26 * s;

    const t = totals(acts);
    const photos = entries.reduce((n, e) => n + e.photos.length, 0);
    this.hair(x, y, W);
    y += 16 * s;
    y += this.statGrid([
      [f.t('activities'), f.n0(t.count)],
      [f.t('distance'), f.bigDistance(t.distance)],
      [f.t('elevation'), f.elevation(t.elevation)],
      [f.t('movingTime'), f.hours(t.time)],
      [f.t('activeDays'), f.n0(t.days)],
      [f.t('photos'), f.n0(photos)],
    ], x, y, W, { valueSize: 21, cols: W > 420 * s ? 3 : 2 }) + 24 * s;

    const recs = records(entries, f);
    if (recs.length) {
      this.hair(x, y, W);
      y += 14 * s;
      this.kicker(f.t('records'), x, y, W);
      y += 20 * s;
      const cols = W > 420 * s ? 2 : 1;
      const colGap = 22 * s;
      const colW = (W - colGap * (cols - 1)) / cols;
      const rowH = 42 * s;
      const fit = Math.max(0, Math.floor((this.yMax - y - 130 * s) / rowH) * cols);
      const shown = recs.slice(0, Math.max(cols * 2, fit));
      shown.forEach((rec, i) => {
        const cx = x + (i % cols) * (colW + colGap);
        const cy = y + Math.floor(i / cols) * rowH;
        const vw = colW * 0.36;
        this.text(rec.label, cx, cy, { font: 'sansSemi', size: 7 * s, color: this.c.muted, width: colW, lines: 1 });
        this.text(rec.value, cx, cy + 11 * s, { font: 'sansSemi', size: 13.5 * s, color: this.accent, width: vw, lines: 1, features: ['tnum'] });
        this.text(rec.detail, cx + vw, cy + 11 * s, { font: 'sansMedium', size: 8.8 * s, color: this.c.ink, width: colW - vw, lines: 1 });
        if (rec.when) this.text(rec.when, cx + vw, cy + 23.5 * s, { size: 7.4 * s, color: this.c.muted, width: colW - vw, lines: 1 });
        if (Math.floor(i / cols) < Math.ceil(shown.length / cols) - 1) this.hair(cx, cy + rowH - 7 * s, colW, this.c.soft);
      });
      y += Math.ceil(shown.length / cols) * rowH + 10 * s;
    }

    const byType = [...groupBy(acts, activityType)].map(([type, list]) => ({ type, ...totals(list) })).sort((a, b) => b.count - a.count);
    const rowH = 18 * s;
    const maxRows = Math.floor((this.yMax - y - 44 * s) / rowH);
    if (maxRows >= 2) {
      this.hair(x, y, W);
      y += 14 * s;
      this.kicker(f.t('sports'), x, y, W);
      y += 20 * s;
      const cols = [0.3, 0.22, 0.1, 0.13, 0.13, 0.12].map((p) => p * W);
      this.tableRow([f.t('sport'), '', f.t('count'), f.t('statDistance'), f.t('time'), f.t('elevationShort')], x, y, cols, true);
      y += rowH;
      const shown = byType.slice(0, maxRows - 1);
      const maxTime = Math.max(...byType.map((b) => b.time), 1);
      for (const r2 of shown) {
        this.tableRow([f.sport(r2.type), '', f.n0(r2.count), r2.distance ? f.bigDistance(r2.distance) : '–', f.hours(r2.time), r2.elevation ? f.elevation(r2.elevation) : '–'], x, y, cols);
        // arányos sáv a mozgásidőből – egy pillantással látszik, mivel telt az idő
        const bw = Math.max(1.5, (cols[1] - 12 * s) * (r2.time / maxTime));
        this.doc.roundedRect(x + cols[0], y + 2.6 * s, bw, 5 * s, 2.5 * s).fill(this.accent);
        y += rowH;
      }
      if (byType.length > shown.length) {
        this.text(f.t('moreSports', { n: byType.length - shown.length }), x, y + 3 * s, { size: 7.4 * s, color: this.c.muted, width: W, lines: 1 });
      }
    }
  }

  tableRow(cells, x, y, widths, header = false) {
    const s = this.s;
    let cx = x;
    cells.forEach((c, i) => {
      if (c) {
        this.text(header ? c.toLocaleUpperCase(this.f.locale) : c, cx, y, {
          font: header ? 'sansSemi' : i === 0 ? 'sansMedium' : 'sans',
          size: (header ? 6.8 : 9) * s,
          color: header ? this.c.muted : this.c.ink,
          width: widths[i] - 4,
          align: i === 0 ? 'left' : 'right',
          lines: 1,
          spacing: header ? 0.6 * s : 0,
          features: ['tnum'],
        });
      }
      cx += widths[i];
    });
    if (!header) this.hair(x, y + 13.5 * s, widths.reduce((a, b) => a + b, 0), this.c.soft);
  }

  // ------------------------------------------------------------ minden útvonal

  routesPage(entries) {
    const polys = entries.filter((e) => e.activity.polyline).map((e) => e.activity.polyline);
    if (polys.length < 4) return;
    const s = this.s;
    let y = this.newPage();
    this.marks.sections.routes = this.pageNo;
    this.kicker(dateRange(entries), this.x0, y, this.W);
    y += 14 * s;
    this.text(this.f.t('allRoutes'), this.x0, y, { font: this.headFont, size: 24 * s, width: this.W, lines: 1 });
    y += 32 * s;
    this.text(this.f.t('allRoutesSub', { n: this.f.n0(Math.min(polys.length, 1500)) }), this.x0, y, { size: 9 * s, color: this.c.muted, width: this.W, lines: 1 });
    y += 22 * s;
    this.routeMosaic(polys.slice(-1500), this.x0, y, this.W, this.yMax - y - 6 * s, { color: this.c.ink, maxWidth: 0.9 });
    this.doc.outline.addItem(this.f.t('allRoutes'));
  }

  /** Kis multiplikátum-rács az útvonalakból (poszter-hatás). */
  routeMosaic(polys, x, y, W, H, { color = this.c.ink, maxWidth = 0.9 } = {}) {
    const n = polys.length;
    if (!n || W <= 0 || H <= 0) return;
    let cols = Math.max(1, Math.round(Math.sqrt((n * W) / H)));
    let rows = Math.ceil(n / cols);
    while (rows * (W / cols) > H && cols < n) {
      cols++;
      rows = Math.ceil(n / cols);
    }
    const cell = Math.min(W / cols, H / rows);
    const ox = x + (W - cols * cell) / 2;
    const d = this.doc;
    const maxPts = cell < 30 ? 40 : cell < 70 ? 90 : 200;
    d.save().lineWidth(Math.max(0.3, Math.min(maxWidth, cell / 55))).lineJoin('round').lineCap('round').strokeColor(color);
    polys.forEach((poly, i) => {
      let ll = decodePolyline(poly);
      if (ll.length < 2) return;
      if (ll.length > maxPts) {
        const step = ll.length / maxPts;
        ll = Array.from({ length: maxPts }, (_, k) => ll[Math.floor(k * step)]).concat([ll[ll.length - 1]]);
      }
      const cx = ox + (i % cols) * cell;
      const cy = y + Math.floor(i / cols) * cell;
      const { pts } = projectToBox(ll, cx, cy, cell, cell, cell * 0.14);
      d.moveTo(...pts[0]);
      for (let k = 1; k < pts.length; k++) d.lineTo(...pts[k]);
    });
    d.stroke();
    d.restore();
  }

  // ------------------------------------------------------------ évnyitó

  /**
   * Fejezetnyitó (év, hónap, évszak vagy sportág). Mindig jobb oldalon nyílik; ha a következő oldal
   * bal oldali, oda a fejezet legjobb fotója kerül kifutóval – így egy valódi nyitó oldalpár jön létre.
   */
  async chapterOpener(ch) {
    if (ch.kind === 'year') return this.yearOpener(ch.year, ch.list, ch.key);
    const s = this.s;
    const f = this.f;
    const list = ch.list;
    const acts = list.map((e) => e.activity);
    this.chapter = ch.title;
    if (!this.isRight(this.pageNo + 1)) {
      const best = pickCoverPhoto(list, this.tw / this.th);
      this.newPage({ footer: false });
      if (best) {
        const b = this.bleed;
        await this.coverImage(best.file, -b, -b, this.tw + 2 * b, this.th + 2 * b);
        this.photoCount++;
      }
    }
    let y = this.newPage({ bg: this.tintBg });
    this.marks.years[ch.key] = this.pageNo;
    this.startChapter(ch.title);
    const x = this.x0;
    const W = this.W;
    this.kicker(f.t(ch.kind === 'sport' ? 'sport' : 'chapter'), x, y, W);
    y += 12 * s;
    y += this.text(ch.title, x, y, { font: this.headFont, size: Math.min(58 * s, this.th * 0.085), width: W, lines: 2, lineGap: -4 }) + 22 * s;
    const t = totals(acts);
    const photos = list.reduce((n, e) => n + e.photos.length, 0);
    y += this.statGrid([
      [f.t('activities'), f.n0(t.count)],
      [f.t('distance'), f.bigDistance(t.distance)],
      [f.t('elevationShort'), f.elevation(t.elevation)],
      [f.t('movingTime'), f.hours(t.time)],
      [f.t('activeDays'), f.n0(t.days)],
      [f.t('photos'), f.n0(photos)],
    ], x, y, W, { valueSize: 17, cols: 3 }) + 28 * s;
    // A fejezet útvonalai poszterszerűen, alatta a legjobb pillanatok.
    const best = list.filter((e) => e.photos.some((p) => !p.isVideo))
      .sort((a, b) => (b.activity.kudos_count || 0) - (a.activity.kudos_count || 0))
      .slice(0, W > 420 * s ? 4 : 3);
    const stripH = best.length >= 2 ? Math.min((W / best.length) * 1.05, (this.yMax - y) * 0.42) : 0;
    const polys = acts.filter((a) => a.polyline).map((a) => a.polyline).slice(-300);
    const mosaicH = this.yMax - y - (stripH ? stripH + 40 * s : 0);
    if (polys.length >= 2 && mosaicH > 80 * s) {
      this.routeMosaic(polys, x, y, W, mosaicH - 10 * s, { color: this.routeColor, maxWidth: 1 });
      y += mosaicH;
    }
    if (stripH > 60 * s) {
      this.kicker(f.t('momentsChapter'), x, y, W, this.c.muted);
      y += 16 * s;
      const cw = (W - this.gap * (best.length - 1)) / best.length;
      for (let i = 0; i < best.length; i++) {
        const p = best[i].photos.find((q) => !q.isVideo);
        await this.coverImage(p.file, x + i * (cw + this.gap), y, cw, stripH);
      }
    }
  }

  async yearOpener(yr, list, key = String(yr)) {
    const s = this.s;
    const f = this.f;
    const acts = list.map((e) => e.activity);
    this.chapter = String(yr);
    // Az évnyitó jobb oldalon kezdődik; ha a következő oldal bal oldali, oda kerül az év fotója.
    if (!this.isRight(this.pageNo + 1)) {
      const best = pickCoverPhoto(list, this.tw / this.th);
      if (best) {
        this.newPage({ footer: false });
        const b = this.bleed;
        await this.coverImage(best.file, -b, -b, this.tw + 2 * b, this.th + 2 * b);
        this.photoCount++;
      } else {
        this.newPage({ footer: false });
      }
    }
    let y = this.newPage({ bg: this.tintBg });
    this.marks.years[key] = this.pageNo;
    this.startChapter(String(yr));
    const x = this.x0;
    const W = this.W;

    this.kicker(f.t('yearInReview'), x, y, W);
    y += 8 * s;
    const yearSize = Math.min(118 * s, this.th * 0.17);
    this.text(String(yr), x - yearSize * 0.04, y, { font: this.headFont, size: yearSize, color: this.c.ink, width: W, lines: 1, features: ['lnum'] });
    y += yearSize * 1.18;

    const t = totals(acts);
    const photos = list.reduce((n, e) => n + e.photos.length, 0);
    y += this.statGrid([
      [f.t('activities'), f.n0(t.count)],
      [f.t('distance'), f.bigDistance(t.distance)],
      [f.t('elevationShort'), f.elevation(t.elevation)],
      [f.t('movingTime'), f.hours(t.time)],
      [f.t('activeDays'), f.n0(t.days)],
      [f.t('photos'), f.n0(photos)],
    ], x, y, W, { valueSize: 17, cols: 3 }) + 26 * s;

    const useDist = t.distance > 0;
    const monthly = new Array(12).fill(0);
    for (const a of acts) monthly[localDate(a).getUTCMonth()] += useDist ? f.distanceValue(a.distance || 0) : (a.moving_time || 0) / 3600;
    this.kicker(useDist ? (f.imperial ? f.t('perMonthMi') : f.t('perMonthKm')) : f.t('perMonthH'), x, y, W, this.c.muted);
    y += 16 * s;
    const chartH = Math.max(50 * s, Math.min(105 * s, this.yMax - y - 230 * s));
    this.monthBars(monthly, x, y, W, chartH);
    y += chartH + 26 * s;

    if (this.yMax - y > 70 * s) {
      this.kicker(f.t('calendar'), x, y, W, this.c.muted);
      y += 16 * s;
      y += this.heatmap(yr, acts, x, y, W, Math.min(this.yMax - y, 105 * s)) + 24 * s;
    }

    const best = list.filter((e) => e.photos.some((p) => !p.isVideo))
      .sort((a, b) => (b.activity.kudos_count || 0) - (a.activity.kudos_count || 0))
      .slice(0, W > 420 * s ? 4 : 3);
    const stripH = Math.min(this.yMax - y - 16 * s, (W / Math.max(best.length, 1)) * 1.05);
    if (best.length >= 2 && stripH > 60 * s) {
      this.kicker(f.t('moments'), x, y, W, this.c.muted);
      y += 16 * s;
      const cw = (W - this.gap * (best.length - 1)) / best.length;
      for (let i = 0; i < best.length; i++) {
        const p = best[i].photos.find((q) => !q.isVideo);
        await this.coverImage(p.file, x + i * (cw + this.gap), y, cw, stripH);
      }
    }
  }

  monthBars(values, x, y, W, H) {
    const s = this.s;
    const d = this.doc;
    const max = Math.max(...values, 1);
    const gap = 6 * s;
    const bw = (W - gap * 11) / 12;
    const labelH = 12 * s;
    const top = y + 10 * s;
    const barArea = H - labelH - 10 * s;
    values.forEach((v, i) => {
      const bx = x + i * (bw + gap);
      const bh = v > 0 ? Math.max(1.5, (v / max) * barArea) : 0;
      const by = top + barArea - bh;
      if (bh > 0) d.roundedRect(bx, by, bw, bh, Math.min(2 * s, bw / 4)).fill(this.accent);
      this.hair(bx, top + barArea, bw, this.c.hair);
      if (v > 0) this.text(this.f.n0(Math.round(v)), bx - 6, by - 10 * s, { font: 'sansSemi', size: 6.6 * s, color: this.c.ink, width: bw + 12, align: 'center', lines: 1, features: ['tnum'] });
      this.text(this.f.months[i], bx - 6, y + H - labelH + 2 * s, { size: 7 * s, color: this.c.muted, width: bw + 12, align: 'center', lines: 1 });
    });
  }

  heatmap(yr, acts, x, y, W, maxH) {
    const s = this.s;
    const d = this.doc;
    const perDay = new Map();
    for (const a of acts) {
      const k = (a.start_date_local || '').slice(0, 10);
      perDay.set(k, (perDay.get(k) || 0) + (a.moving_time || a.elapsed_time || 0));
    }
    const jan1 = Date.UTC(yr, 0, 1);
    const offset = (new Date(jan1).getUTCDay() + 6) % 7;
    const daysInYear = (Date.UTC(yr + 1, 0, 1) - jan1) / 86400000;
    const weeks = Math.ceil((daysInYear + offset) / 7);
    const labelW = 14 * s;
    const cell = Math.min((W - labelW) / weeks, (maxH - 14 * s) / 7);
    const pad = cell * 0.18;
    const vals = [...perDay.values()].sort((a, b) => a - b);
    const q = (p) => vals[Math.floor((vals.length - 1) * p)] || 1;
    const th = [q(0.25), q(0.5), q(0.8)];
    const gx = x + labelW;
    const gy = y + 12 * s;
    this.f.weekdays.forEach((dn, i) => {
      if (i % 2 === 0) this.text(dn, x, gy + i * cell + (cell - 6.4 * s) / 2, { size: 6.4 * s, color: this.c.muted, width: labelW - 2, lines: 1 });
    });
    for (let m = 0; m < 12; m++) {
      const wk = Math.floor(((Date.UTC(yr, m, 1) - jan1) / 86400000 + offset) / 7);
      this.text(this.f.months[m], gx + wk * cell, y, { size: 6.4 * s, color: this.c.muted, width: cell * 5, lines: 1 });
    }
    // Üres napok egyetlen útvonalban, a kitöltöttek szintenként – kevesebb PDF-művelet.
    const levels = [[], [], [], [], []];
    for (let i = 0; i < daysInYear; i++) {
      const k = new Date(jan1 + i * 86400000).toISOString().slice(0, 10);
      const pos = i + offset;
      const v = perDay.get(k) || 0;
      const lvl = v === 0 ? 0 : v <= th[0] ? 1 : v <= th[1] ? 2 : v <= th[2] ? 3 : 4;
      levels[lvl].push([gx + Math.floor(pos / 7) * cell + pad / 2, gy + (pos % 7) * cell + pad / 2]);
    }
    const sz = cell - pad;
    const draw = (cellsArr, color, opacity) => {
      if (!cellsArr.length) return;
      d.save().fillOpacity(opacity);
      for (const [cx, cy] of cellsArr) d.roundedRect(cx, cy, sz, sz, cell * 0.2);
      d.fill(color).restore();
    };
    draw(levels[0], this.c.cell, 1);
    draw(levels[1], this.accent, 0.3);
    draw(levels[2], this.accent, 0.52);
    draw(levels[3], this.accent, 0.76);
    draw(levels[4], this.accent, 1);
    return 12 * s + 7 * cell;
  }

  // ------------------------------------------------------------ aktivitás

  async activity(entry, highlight) {
    const a = entry.activity;
    const opts = this.opts;
    // A galéria-elrendezés fotóközpontú: nincs térkép és profil, a képek kapják a helyet.
    const maps = opts.showMaps !== false && this.layout !== 'gallery';
    const streams = maps ? await loadStreams(entry.streamsFile) : null;
    let track = maps ? buildTrack(a, streams) : null;
    track = trimTrack(track, Number(opts.privacyMeters) || 0);
    const fav = this.favorites.has(String(a.id));

    // Útvonal szerinti sorrend + sorszámok a térképhez
    let photos = entry.photos.map((p) => ({ ...p }));
    const idx = locatePhotos(track, photos, a);
    photos.forEach((p, i) => (p.trackIdx = idx[i]));
    photos = [...photos.filter((p) => p.trackIdx != null).sort((p, q) => p.trackIdx - q.trackIdx), ...photos.filter((p) => p.trackIdx == null)];
    let n = 0;
    for (const p of photos) if (p.trackIdx != null) p.pin = ++n;

    // Sablonválasztás a ritmushoz
    const landscapes = photos.filter((p) => !p.isVideo && aspect(p) >= 1.25 && p.width >= 1000);
    const useHero = landscapes.length > 0 && (fav || this.layout === 'gallery' || this.lastTemplate !== 'hero' || photos.length >= 6);
    const hero = useHero ? landscapes.reduce((b, p) => (p.width * p.height > b.width * b.height ? p : b)) : null;
    let full = null;
    if (highlight) {
      const pageA = this.tw / this.th;
      const cands = photos.filter((p) => p !== hero && !p.isVideo && p.width >= 1200 && Math.abs(Math.log(aspect(p) / pageA)) < 0.35);
      full = cands.sort((p, q) => q.width * q.height - p.width * p.height)[0] || null;
    }
    const grid = photos.filter((p) => p !== hero && p !== full);

    const outline = `${this.f.shortDate(localDate(a))} – ${a.name || this.f.t('untitled')}`;
    this.marks.acts[a.id] = this.pageNo + 1;
    let y;
    if (hero) y = await this.heroHeader(a, hero, track, photos, grid.length === 0);
    else y = await this.classicHeader(a, track, photos);
    (this.yearOutline || this.doc.outline).addItem(outline);
    // Fekvő hős-oldalon a fél oldalas oszlop túl keskeny egy fotórácshoz: a képek a következő oldalra kerülnek.
    if (hero && this.landscape && grid.length) y = this.yMax;
    if (grid.length) await this.photoRows(grid, a, y);
    if (full) await this.fullBleed(full, a);
    this.lastTemplate = hero ? 'hero' : 'classic';
  }

  /** Az aktivitás adatai a felhasználó által kiválasztott mutatókkal: [címke, érték, kulcs, rövid forma]. */
  activityStats(a) {
    const f = this.f;
    const want = Array.isArray(this.opts.stats) && this.opts.stats.length ? new Set(this.opts.stats) : null;
    const out = [];
    const add = (key, label, value, short = value) => {
      if (!want || want.has(key)) out.push([label, value, key, short]);
    };
    const dist = a.distance > 0 ? f.distance(a.distance) : null;
    if (dist) add('distance', f.t('statDistance'), dist);
    if (a.moving_time) add('time', dist ? f.t('movingTime') : f.t('duration'), f.duration(a.moving_time));
    if (a.total_elevation_gain > 0) add('elevation', f.t('elevationShort'), f.elevation(a.total_elevation_gain), `↑${f.elevation(a.total_elevation_gain)}`);
    const sp = f.speedOrPace(a);
    if (sp) add('pace', sp.label, sp.value);
    if (a.weather) {
      const temp = f.imperial ? `${Math.round((a.weather.t * 9) / 5 + 32)} °F` : `${Math.round(a.weather.t)} °C`;
      // Rácsban az égbolt a címke és a hőmérséklet az érték (így elfér a cellában); egysoros formában mindkettő.
      const sky = f.t(`wx_${weatherKey(a.weather.code)}`);
      add('weather', sky, temp.replace(/^-0 /, '0 '), `${temp}, ${sky}`);
    }
    if (a.average_heartrate) add('hr', f.t('statHr'), `${Math.round(a.average_heartrate)} bpm`);
    if (a.device_watts && a.average_watts) add('power', f.t('statPower'), `${Math.round(a.average_watts)} W`);
    if (a.calories) add('calories', f.t('statCalories'), `${f.n0(Math.round(a.calories))} kcal`);
    if (a.elev_high != null && a.total_elevation_gain > 50) add('high', f.t('statHigh'), f.elevation(a.elev_high), `▲${f.elevation(a.elev_high)}`);
    if (a.kudos_count) add('kudos', f.t('statKudos'), f.n0(a.kudos_count), `${f.n0(a.kudos_count)} kudos`);
    return out.slice(0, 9);
  }

  /** Adatblokk az elrendezés szerint: magazinban tagolt sáv, galériában és naplóban egyetlen elegáns sor. */
  statsBlock(a, x, y, W, minCell = 78) {
    const stats = this.activityStats(a);
    if (!stats.length) return 0;
    if (this.layout === 'magazine') return this.statGrid(stats, x, y, W, { minCell });
    const line = stats.map((st) => st[3]).join('   ·   ');
    return this.text(line, x, y, { font: 'sansMedium', size: 9.6 * this.s, color: this.c.ink2, width: W, lines: 2, lineGap: 3, features: ['tnum'] }) + 4 * this.s;
  }

  statsBlockHeight(a, W, minCell = 78) {
    const n = this.activityStats(a).length;
    if (!n) return 0;
    if (this.layout === 'magazine') return this.statGridHeight(n, W, { minCell });
    return 9.6 * this.s * 1.25 + 4 * this.s;
  }

  /** QR-kód mérete a cím mellett (a Strava-aktivitásra mutat; a nyomtatott könyvből egy beolvasással elérhető). */
  qrSize(a) {
    return this.opts.qr !== false && /^\d{1,20}$/.test(String(a.id)) ? 36 * this.s : 0;
  }

  /** QR-kód vektorosan, fehér alapon (éjszakai papírtónuson is olvasható), soronként összevont modulokkal. */
  drawQr(text, x, y, size) {
    const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = q.modules.size;
    const pad = 2;
    const cell = size / (n + pad * 2);
    const d = this.doc;
    d.save();
    d.roundedRect(x, y, size, size, cell * 1.5).fill('#FFFFFF');
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!q.modules.data[r * n + c]) continue;
        let e = c;
        while (e + 1 < n && q.modules.data[r * n + e + 1]) e++;
        d.rect(x + (c + pad) * cell, y + (r + pad) * cell, (e - c + 1) * cell + 0.02, cell + 0.02);
        c = e;
      }
    }
    d.fill('#1F1D1A').restore();
  }

  titleBlock(a, x, y, W, maxLines = 2) {
    const s = this.s;
    const q = this.qrSize(a);
    const tw = q ? W - q - 10 * s : W;
    let h = this.kicker(`${this.f.sport(activityType(a))}   ·   ${this.f.longDate(a)}`, x, y, tw) + 7 * s;
    h += this.text(a.name || this.f.t('untitled'), x, y + h, { font: this.headFont, size: 24 * s, width: tw, lines: maxLines, lineGap: -2 }) + 14 * s;
    if (q) {
      this.drawQr(`https://www.strava.com/activities/${a.id}`, x + W - q, y, q);
      h = Math.max(h, q + 10 * s);
    }
    return h;
  }

  titleBlockHeight(a, W, maxLines = 2) {
    const s = this.s;
    const d = this.doc;
    const q = this.qrSize(a);
    const tw = q ? W - q - 10 * s : W;
    d.font(this.headFont).fontSize(24 * s * this.headScale);
    const lh = d.currentLineHeight(true) - 2;
    const name = a.name || this.f.t('untitled');
    const h = Math.min(d.heightOfString(this.headUpper ? name.toLocaleUpperCase(this.f.locale) : name, { width: tw, lineGap: -2 }), lh * maxLines);
    d.font('sansSemi').fontSize(7.4 * s);
    const total = d.currentLineHeight(true) + 7 * s + h + 14 * s;
    return q ? Math.max(total, q + 10 * s) : total;
  }

  equipmentLine(a, x, y, W) {
    const eq = [a.gear_name, a.device_name].filter(Boolean).join('   ·   ');
    if (!eq) return 0;
    return this.text(eq, x, y, { size: 7.4 * this.s, color: this.c.muted, width: W, lines: 1 }) + 5 * this.s;
  }

  async classicHeader(a, track, photos) {
    const s = this.s;
    let y = this.newPage();
    const x = this.x0;
    const W = this.W;
    const mapW = track ? Math.min(W * 0.36, 180 * s) : 0;
    const leftW = track ? W - mapW - 18 * s : W;
    let ly = y + this.titleBlock(a, x, y, leftW, 3);
    ly += this.statsBlock(a, x, ly, leftW, 74) + 8 * s;
    ly += this.equipmentLine(a, x, ly, leftW);
    if (track) await this.routeMap(track, photos, x + W - mapW, y, mapW, mapW);
    y = Math.max(ly, y + mapW) + 14 * s;
    if (track && hasElevation(track)) {
      const eh = 44 * s;
      this.elevation(track, photos, x, y, W, eh);
      y += eh + 16 * s;
    }
    y += this.description(a, x, y, W, 6);
    return y + 4 * s;
  }

  /** A hős-kép alatti információs blokk becsült magassága (a kép méretének kiszámításához). */
  heroInfoHeight(a, W, track) {
    const s = this.s;
    let h = this.titleBlockHeight(a, W, 2);
    h += this.statsBlockHeight(a, W) + 10 * s;
    if (a.gear_name || a.device_name) h += 14 * s;
    h += 6 * s;
    const desc = this.opts.showDescriptions === false ? '' : (a.description || '').trim();
    if (track && W >= 300 * s) {
      const mapW = Math.min(W * 0.4, 170 * s);
      h += mapW * 0.82 + 14 * s;
      const side = mapW * 0.82 - (hasElevation(track) ? 56 * s : 0);
      if (desc && this.descriptionHeight(a, W - mapW - 16 * s) > side) h += Math.min(this.descriptionHeight(a, W), 10 * 16 * s) + 30 * s;
    } else if (desc) {
      h += Math.min(this.descriptionHeight(a, W), this.descLines(5) * 16 * s) + 14 * s;
    }
    return h;
  }

  async heroHeader(a, hero, track, photos, alone = false) {
    const s = this.s;
    const b = this.bleed;
    this.newPage();
    let x;
    let y;
    let W;
    if (this.landscape) {
      // Fekvő oldalon: a kifutó kép a lap külső felére kerül (nem a gerincbe), a történet a belső felére.
      const right = this.isRight();
      const imgW = this.tw * 0.5;
      const ix = right ? this.tw - imgW : -b;
      await this.coverImage(hero.file, ix, -b, imgW + b, this.th + 2 * b);
      if (hero.pin) this.pin((right ? this.tw - 14 * s : 14 * s), this.th - 14 * s, hero.pin);
      x = right ? this.m + this.gutter : imgW + this.m * 0.9;
      W = this.tw * 0.5 - this.m * 1.9 - (right ? this.gutter : 0);
      y = this.y0;
      this.x0 = x;
      this.W = W;
    } else {
      // Ha a hős-kép egyedül áll az oldalon, akkora, hogy az információs blokkal együtt kitöltse a lapot.
      let heroH = this.th * (this.tw / this.th > 0.9 ? 0.48 : 0.45);
      if (alone) {
        const info = this.heroInfoHeight(a, this.W, track);
        heroH = Math.max(this.th * 0.4, Math.min(this.th * 0.66, this.yMax - info - this.m * 0.62 - 4 * s));
        // ne legyen a képarányánál sokkal laposabb (túlzott vágás)
        heroH = Math.max(heroH, Math.min(this.th * 0.66, (this.tw / aspect(hero)) * 0.55));
      }
      await this.coverImage(hero.file, -b, -b, this.tw + 2 * b, heroH + b);
      if (hero.pin) this.pin(this.x0 + 6 * s, heroH - 12 * s, hero.pin);
      x = this.x0;
      W = this.W;
      y = heroH + this.m * 0.62;
    }
    this.photoCount++;
    this.checkDpi(hero, this.landscape ? this.tw * 0.5 : this.tw, this.th * 0.45, a);
    y += this.titleBlock(a, x, y, W, 2);
    y += this.statsBlock(a, x, y, W) + 10 * s;
    y += this.equipmentLine(a, x, y, W);
    y += 6 * s;
    // Térkép + profil + leírás blokk
    if (track) {
      const stacked = W < 300 * s;
      const mapW = stacked ? W : Math.min(W * 0.4, 170 * s);
      const mapH = stacked ? Math.min(W * 0.62, this.yMax - y - 120 * s) : mapW * 0.82;
      if (mapH > 60 * s) {
        await this.routeMap(track, photos, x, y, mapW, mapH);
        if (stacked) {
          y += mapH + 14 * s;
          if (hasElevation(track)) {
            this.elevation(track, photos, x, y, W, 38 * s);
            y += 38 * s + 16 * s;
          }
          y += this.description(a, x, y, W, 6);
        } else {
          const rx = x + mapW + 16 * s;
          const rw = W - mapW - 16 * s;
          let ry = y;
          if (hasElevation(track)) {
            this.elevation(track, photos, rx, ry, rw, 40 * s);
            ry += 40 * s + 16 * s;
          }
          // A leírás a térkép mellé kerül, ha elfér; ha hosszabb, a térkép alá, teljes szélességben (nem vágjuk le).
          const room = y + mapH - ry;
          if (this.descriptionHeight(a, rw) <= room) {
            ry += this.description(a, rx, ry, rw, 99);
            y = Math.max(y + mapH, ry) + 14 * s;
          } else {
            y = Math.max(y + mapH + (track.trimmed ? 12 * s : 0), ry) + 16 * s;
            y += this.description(a, x, y, W, 10);
          }
        }
        return y;
      }
    }
    y += this.description(a, x, y, W, 5);
    return y + 4 * s;
  }

  /** Leírás-stílus az elrendezés szerint: a napló nagyobb, serif „olvasó” betűt használ. */
  descStyle() {
    const s = this.s;
    return this.layout === 'journal'
      ? { font: this.opts.typeface === 'elegant' ? 'elegantItalic' : 'serifRegular', size: 11.2 * s, lineGap: 5.6 * s }
      : { font: 'sans', size: 9.8 * s, lineGap: 4.5 * s };
  }

  descLines(n) {
    return this.layout === 'journal' ? n * 2 : this.layout === 'gallery' ? Math.min(n, 3) : n;
  }

  descriptionHeight(a, W) {
    const desc = this.opts.showDescriptions === false ? '' : (a.description || '').trim();
    if (!desc) return 0;
    const st = this.descStyle();
    this.doc.font(st.font).fontSize(st.size);
    return this.doc.heightOfString(desc, { width: W - 12 * this.s, lineGap: st.lineGap });
  }

  /** Leírás: álló betű, másfeles sorköz, bal oldali akcentvonallal – hosszabb szövegnél is jól olvasható. */
  description(a, x, y, W, lines) {
    const s = this.s;
    const desc = this.opts.showDescriptions === false ? '' : (a.description || '').trim();
    if (!desc) return 0;
    const indent = 12 * s;
    const st = this.descStyle();
    const h = this.text(desc, x + indent, y, { font: st.font, size: st.size, color: this.c.ink2, width: W - indent, lineGap: st.lineGap, lines: lines >= 99 ? undefined : this.descLines(lines) });
    this.doc.save().moveTo(x + 1, y + 2 * s).lineTo(x + 1, y + h - 3 * s).lineWidth(2 * s).strokeColor(this.accent).stroke().restore();
    return h + 14 * s;
  }

  /** Utószó: személyes zárószöveg a könyv végén. */
  afterword(text) {
    const s = this.s;
    let y = this.newPage();
    const w = Math.min(this.W, 360 * s);
    const x = this.x0 + (this.W - w) / 2;
    y += this.th * 0.12;
    this.kicker(this.f.t('afterword'), x, y, w);
    y += 22 * s;
    this.text(text, x, y, { font: this.opts.typeface === 'elegant' ? 'elegantItalic' : 'serifRegular', size: 12 * s, color: this.c.ink, width: w, lineGap: 6 * s, height: this.yMax - y - 40 * s });
    this.doc.outline.addItem(this.f.t('afterword'));
  }

  async routeMap(track, photos, x, y, w, h) {
    const s = this.s;
    const d = this.doc;
    const ll = track.pts.map((p) => p.ll);
    const r = 5 * s;
    let pts;
    let metersPerPt;
    const base = basemapEnabled() && !this.dry ? await renderBasemap(ll, w, h, { dpi: Math.min(this.images.dpi, 220) }) : null;
    d.save();
    d.roundedRect(x, y, w, h, r).clip();
    if (base) {
      d.image(base.buffer, x, y, { width: w, height: h });
      pts = ll.map(([la, ln]) => {
        const [px, py] = base.project(la, ln);
        return [x + px, y + py];
      });
      metersPerPt = base.metersPerPt;
    } else {
      d.rect(x, y, w, h).fill(this.tintBg);
      // finom pontrács a vektoros térkép hátteréhez
      const step = 9 * s;
      d.fillColor(this.c.dark ? '#FFFFFF' : '#000000').fillOpacity(this.c.dark ? 0.08 : 0.07);
      for (let gx = x + step / 2; gx < x + w; gx += step) for (let gy = y + step / 2; gy < y + h; gy += step) d.circle(gx, gy, 0.45 * s);
      d.fill();
      d.fillOpacity(1);
      ({ pts, metersPerPt } = projectToBox(ll, x, y, w, h, 16 * s));
    }
    if (pts.length >= 2) {
      const path = () => {
        d.moveTo(...pts[0]);
        for (let i = 1; i < pts.length; i++) d.lineTo(...pts[i]);
      };
      path();
      d.lineWidth(4.8 * s).lineJoin('round').lineCap('round').strokeColor(base ? '#FFFFFF' : this.c.base).stroke();
      path();
      d.lineWidth(2.1 * s).strokeColor(this.routeColor).stroke();
      const [sx, sy] = pts[0];
      const [ex, ey] = pts[pts.length - 1];
      d.circle(ex, ey, 3.4 * s).lineWidth(1.3 * s).fillAndStroke(this.c.ink, this.c.base);
      d.circle(sx, sy, 3.4 * s).lineWidth(1.3 * s).fillAndStroke(this.c.base, this.c.ink);
      if (this.opts.mapPins !== false) for (const p of photos) if (p.pin) this.pin(...pts[p.trackIdx], p.pin, 5.2 * s);
    }
    this.scaleBar(x + 9 * s, y + h - 10 * s, w * 0.3, metersPerPt);
    d.restore();
    const notes = [];
    if (track.trimmed) notes.push(this.f.t('privacyZone'));
    if (base) notes.push(MAP.attribution);
    if (notes.length) {
      this.text(notes.join('  ·  '), x, y + h + 4 * s, { size: 6 * s, color: this.c.muted, width: w, lines: 2 });
    }
  }

  scaleBar(x, y, maxW, metersPerPt) {
    if (!metersPerPt || !Number.isFinite(metersPerPt)) return;
    const s = this.s;
    const unit = this.f.imperial ? 1609.344 : 1000;
    const maxUnits = (maxW * metersPerPt) / unit;
    const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].filter((v) => v <= maxUnits).pop();
    if (!nice) return;
    const w = (nice * unit) / metersPerPt;
    const d = this.doc;
    d.save().lineWidth(0.8 * s).strokeColor(this.c.ink);
    d.moveTo(x, y - 2 * s).lineTo(x, y).lineTo(x + w, y).lineTo(x + w, y - 2 * s).stroke();
    d.restore();
    const label = `${this.f.n1(nice).replace(/[,.]0$/, '')} ${this.f.imperial ? 'mi' : 'km'}`;
    this.text(label, x + w + 4 * s, y - 5 * s, { font: 'sansSemi', size: 6.2 * s, color: this.c.ink, lines: 1 });
  }

  elevation(track, photos, x, y, w, h) {
    const s = this.s;
    const d = this.doc;
    const f = this.f;
    const pts = track.pts.filter((p) => p.alt != null);
    const d0 = pts[0].d;
    const d1 = pts[pts.length - 1].d;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.alt < lo) lo = p.alt;
      if (p.alt > hi) hi = p.alt;
    }
    const labelW = 36 * s;
    const gx = x + labelW;
    const gw = w - labelW;
    const px = (dist) => gx + ((dist - d0) / Math.max(d1 - d0, 1)) * gw;
    const py = (alt) => y + h - ((alt - lo) / Math.max(hi - lo, 1)) * (h - 8 * s);
    const grad = d.linearGradient(0, y, 0, y + h);
    grad.stop(0, this.accent, 0.32).stop(1, this.accent, 0.04);
    d.save();
    d.moveTo(gx, y + h);
    for (const p of pts) d.lineTo(px(p.d), py(p.alt));
    d.lineTo(gx + gw, y + h).closePath().fill(grad);
    d.restore();
    d.save();
    pts.forEach((p, i) => (i ? d.lineTo(px(p.d), py(p.alt)) : d.moveTo(px(p.d), py(p.alt))));
    d.lineWidth(1.1 * s).lineJoin('round').strokeColor(this.accent).stroke();
    d.restore();
    this.hair(gx, y + h, gw, this.c.hair);
    this.text(f.elevation(hi), x, y + 2 * s, { size: 6.6 * s, color: this.c.muted, width: labelW - 5, lines: 1, features: ['tnum'] });
    this.text(f.elevation(lo), x, y + h - 8 * s, { size: 6.6 * s, color: this.c.muted, width: labelW - 5, lines: 1, features: ['tnum'] });
    this.text(f.distance(d1 - d0) || '', gx, y + h + 3 * s, { size: 6.6 * s, color: this.c.muted, width: gw, align: 'right', lines: 1, features: ['tnum'] });
    for (const p of photos) {
      if (!p.pin) continue;
      const tp = track.pts[p.trackIdx];
      if (tp.alt == null) continue;
      const cx = px(tp.d);
      const cy = py(tp.alt);
      d.save().moveTo(cx, cy).lineTo(cx, y + h).lineWidth(0.5).strokeColor(this.accent).stroke().restore();
      this.pin(cx, cy, p.pin, 5 * s);
    }
  }

  // ------------------------------------------------------------ fotórács

  /**
   * Fotóoldalak a kompozíciós motorral (collage.js): oldalanként a legjobb vágásos elrendezés,
   * egy domináns képpel, közös rácson és résen, egységes képaláírás-sávval.
   */
  async photoRows(photos, a, yStart) {
    const s = this.s;
    const capH = 15 * s;
    const fullH = this.yMax - this.y0;
    const opts = {
      gap: this.gap,
      capH,
      hasCap: (p) => Boolean((p.caption && this.opts.showCaptions !== false) || p.pin || p.isVideo),
      pageArea: this.W * fullH,
      minFrac: 0.07, // egy kép se legyen kisebb a tartalmi terület ~7%-ánál (A4-en kb. 5 × 6 cm)
      dpi: (p, w, h) => Math.min(p.width / (w / 72), p.height / (h / 72)),
    };
    let rest = photos;
    let y = yStart;
    let fresh = false;
    while (rest.length) {
      const W = this.W; // lapozás után a teljes szélesség (a hős-oldal oszlopa keskenyebb lehet)
      const R = this.yMax - y;
      // A fejléc alatti maradék helyet csak akkor használjuk, ha elég nagy egy igényes képblokkhoz.
      const plan = R >= fullH * 0.3 || fresh ? planPage(rest, W, R, opts, this.landscape ? 5 : 6) : null;
      if (!plan) {
        y = this.continuationPage(a);
        fresh = true;
        continue;
      }
      // A blokk vízszintesen középre, függőlegesen a maradék tér súlypontjába kerül
      // (szándékos, kiegyensúlyozott fehér tér – nem egy üres sáv az oldal alján).
      const leftover = Math.max(0, R - plan.h);
      const ox = this.x0 + (W - plan.w) / 2;
      const oy = y + (leftover > R * 0.08 ? leftover * (fresh ? 0.5 : 0.3) : 0);
      await this.drawCells(plan.cells, ox, oy, a);
      y = oy + plan.h + this.gap;
      rest = rest.slice(plan.k);
      if (rest.length) {
        y = this.continuationPage(a);
        fresh = true;
      }
    }
    this.cursorY = y;
    this.cursorPage = this.pageNo;
  }

  continuationPage(a) {
    const y = this.newPage();
    this.kicker(`${a.name || this.f.t('untitled')}  ·  ${this.f.t('continued')}`, this.x0, y, this.W, this.c.muted);
    return y + 22 * this.s;
  }

  /** A cellák kirajzolása: a képek párhuzamosan készülnek elő; ahol a cella aránya eltér, intelligens kivágás. */
  async drawCells(cells, ox, oy, a) {
    const srcs = this.dry ? [] : await Promise.all(cells.map((c) => (c.crop > 0.03
      ? this.images.cover(c.p.file, c.w, c.imgH)
      : this.images.fit(c.p.file, c.p.width, c.w, c.imgH))));
    cells.forEach((c, i) => {
      if (!this.dry) this.doc.image(srcs[i], ox + c.x, oy + c.y, { width: c.w, height: c.imgH });
      this.photoCount++;
      this.checkDpi(c.p, c.w, c.imgH, a);
      if (c.cap) this.caption(c.p, ox + c.x, oy + c.y + c.imgH + 4 * this.s, c.w);
    });
  }

  checkDpi(p, wPt, hPt, a) {
    const dpi = Math.min(p.width / (wPt / 72), p.height / (hPt / 72));
    if (dpi < 150) this.lowRes.push({ activity: a.name, date: this.f.shortDate(localDate(a)), dpi: Math.round(dpi), page: this.pageNo });
  }

  caption(p, x, y, w) {
    const s = this.s;
    let cx = x;
    if (p.pin) {
      this.pin(x + 4.6 * s, y + 4.4 * s, p.pin, 4.6 * s);
      cx += 13 * s;
    }
    const parts = [];
    if (p.isVideo) parts.push(this.f.t('video'));
    if (p.caption && this.opts.showCaptions !== false) parts.push(p.caption);
    if (parts.length) this.text(parts.join(' · '), cx, y + 0.5 * s, { font: 'sansItalic', size: 7.8 * s, color: this.c.ink2, width: x + w - cx, lines: 1 });
  }

  async fullBleed(p, a) {
    this.newPage({ footer: false });
    const b = this.bleed;
    await this.coverImage(p.file, -b, -b, this.tw + 2 * b, this.th + 2 * b);
    this.photoCount++;
    this.checkDpi(p, this.tw, this.th, a);
    if (p.pin) this.pin(this.m * 0.6, this.th - this.m * 0.6, p.pin);
  }

  // ------------------------------------------------------------ napló

  logList(list, yr) {
    const s = this.s;
    const rowH = 29 * s;
    let y;
    if (this.cursorPage === this.pageNo && this.yMax - this.cursorY > rowH * 5) {
      y = this.cursorY + 18 * s;
      this.hair(this.x0, y - 9 * s, this.W);
    } else {
      y = this.newPage();
    }
    let x = this.x0; // lapozás után olvassuk ki (a hős-oldal oszlopa eltérhet)
    const header = (cont) => {
      this.kicker(`${yr ? `${yr}   ·   ` : ''}${this.f.t('furtherActivities')}${cont ? ` (${this.f.t('continued')})` : ''}`, x, y, this.W, this.c.muted);
      y += 20 * s;
    };
    header(false);
    const cols = this.W > 400 * s ? 2 : 1;
    const colGap = 22 * s;
    const colW = (this.W - colGap * (cols - 1)) / cols;
    let i = 0;
    while (i < list.length) {
      const avail = Math.floor((this.yMax - y) / rowH);
      if (avail < 1) {
        y = this.newPage();
        x = this.x0;
        header(true);
        continue;
      }
      const n = Math.min(list.length - i, avail * cols);
      const rowsUsed = Math.ceil(n / cols);
      for (let k = 0; k < n; k++) {
        this.logRow(list[i + k].activity, x + Math.floor(k / rowsUsed) * (colW + colGap), y + (k % rowsUsed) * rowH, colW);
      }
      i += n;
      y += rowsUsed * rowH;
    }
    this.cursorY = y;
    this.cursorPage = this.pageNo;
  }

  logRow(a, x, y, w) {
    const s = this.s;
    const f = this.f;
    const dw = 44 * s;
    this.text(f.dayMonth(localDate(a)), x, y + 1 * s, { font: 'sansSemi', size: 8.2 * s, color: this.accent, width: dw, lines: 1, features: ['tnum'] });
    this.text(a.name || f.t('untitled'), x + dw, y, { font: 'sansMedium', size: 9 * s, width: w - dw, lines: 1 });
    const sp = f.speedOrPace(a);
    const st = [
      f.sport(activityType(a)),
      a.distance ? f.distance(a.distance) : null,
      f.duration(a.moving_time),
      a.total_elevation_gain > 0 ? `↑${f.elevation(a.total_elevation_gain)}` : null,
      sp?.value,
    ].filter(Boolean).join(' · ');
    this.text(st, x + dw, y + 12.5 * s, { size: 7.4 * s, color: this.c.muted, width: w - dw, lines: 1, features: ['tnum'] });
    this.hair(x, y + 24.5 * s, w, this.c.soft);
  }

  // ------------------------------------------------------------ zárás

  finish() {
    // Kért jegyzetoldalak (pl. célokhoz, emlékekhez), majd kötéshez 4-gyel osztható kitöltés.
    for (let i = 0; i < (Number(this.opts.notesPages) || 0); i++) this.notesPage();
    if (this.opts.padToFour !== false) {
      while ((this.pageNo + 1) % 4 !== 0) this.notesPage();
    }
    this.colophon();
  }

  notesPage() {
    // Jegyzetoldalra kézzel írnak: éjszakai tónusú könyvben is világos papír marad.
    const s = this.s;
    const saved = this.c;
    if (this.c.dark) this.c = TONES.white;
    let y = this.newPage();
    this.kicker(this.f.t('notes'), this.x0, y, this.W, this.c.muted);
    y += 32 * s;
    for (; y < this.yMax - 4; y += 22 * s) this.hair(this.x0, y, this.W, this.c.hair);
    this.c = saved;
  }

  colophon() {
    const s = this.s;
    this.newPage({ footer: false });
    const w = Math.min(this.W, 300 * s);
    const x = (this.tw - w) / 2;
    const y = this.th - this.m - 64 * s;
    this.doc.rect(this.tw / 2 - 9 * s, y - 16 * s, 18 * s, 2).fill(this.accent);
    this.text(this.opts.title || 'Lap by Lap', x, y, { font: this.headFont, size: 12 * s, width: w, align: 'center', lines: 1 });
    const lines = [this.f.t('colophon', { date: this.f.today() }), this.f.t('dataSource')];
    if (basemapEnabled() && this.opts.showMaps !== false) lines.push(this.f.t('mapData', { attr: MAP.attribution }));
    this.text(lines.join('\n'), x, y + 19 * s, { size: 7 * s, color: this.c.muted, width: w, align: 'center', lineGap: 2 });
  }

  report() {
    return {
      pages: this.pageNo,
      photos: this.photoCount,
      lowRes: this.lowRes.slice(0, 200),
      lowResCount: this.lowRes.length,
      trimSize: `${Math.round(this.tw / MM)} × ${Math.round(this.th / MM)} mm`,
      bleed: Boolean(this.bleed),
      cropMarks: Boolean(this.slug),
      // Nyomdai előellenőrzés (a fájl tényleges tulajdonságai)
      preflight: {
        pdfVersion: '1.7',
        outputIntent: 'sRGB IEC61966-2.1',
        fontsEmbedded: true,
        trimBox: true,
        bleedMm: this.bleed ? 3 : 0,
        imageDpi: this.images.dpi,
        minFontPt: Math.round(this.minFont * 10) / 10,
        lowResImages: this.lowRes.length,
        pagesDivisibleBy4: this.pageNo % 4 === 0,
        safeMarginMm: Math.round((this.m / MM) * 10) / 10,
      },
    };
  }
}

// ====================================================================== számítások

function records(entries, f) {
  const acts = entries.map((e) => e.activity);
  const out = [];
  const best = (fn) => acts.reduce((b, a) => (fn(a) > (b ? fn(b) : 0) ? a : b), null);
  const rec = (label, value, a) => out.push({ label, value, detail: a.name || f.t('untitled'), when: f.longDate(a) });
  const longest = best((a) => a.distance || 0);
  if (longest?.distance) rec(f.t('recLongest'), f.distance(longest.distance), longest);
  const climb = best((a) => a.total_elevation_gain || 0);
  if (climb?.total_elevation_gain) rec(f.t('recClimb'), f.elevation(climb.total_elevation_gain), climb);
  const longT = best((a) => a.moving_time || 0);
  if (longT?.moving_time) rec(f.t('recLongTime'), f.duration(longT.moving_time), longT);
  const high = best((a) => a.elev_high || 0);
  if (high?.elev_high > 300) rec(f.t('recHigh'), f.elevation(high.elev_high), high);
  const kudos = best((a) => a.kudos_count || 0);
  if (kudos?.kudos_count) rec(f.t('recKudos'), f.n0(kudos.kudos_count), kudos);
  const photoE = entries.reduce((b, e) => (e.photos.length > (b?.photos.length || 0) ? e : b), null);
  if (photoE) rec(f.t('recPhotos'), f.t('nPhotos', { n: photoE.photos.length }), photoE.activity);
  const minutes = (a) => {
    const t = (a.start_date_local || '').slice(11, 16).split(':').map(Number);
    return t.length === 2 ? t[0] * 60 + t[1] : 9999;
  };
  const early = acts.reduce((b, a) => (minutes(a) >= 180 && (!b || minutes(a) < minutes(b)) ? a : b), null);
  if (early) rec(f.t('recEarly'), (early.start_date_local || '').slice(11, 16), early);
  const streak = longestStreak(acts);
  if (streak.days >= 2) {
    out.push({ label: f.t('recStreak'), value: f.t('nDays', { n: streak.days }), detail: f.t('recStreakDetail'), when: `${f.shortDate(streak.from)} – ${f.shortDate(streak.to)}` });
  }
  return out;
}

function longestStreak(acts) {
  const days = [...new Set(acts.map((a) => (a.start_date_local || '').slice(0, 10)))].filter(Boolean).sort();
  let best = { days: 0 };
  let start = 0;
  for (let i = 1; i <= days.length; i++) {
    const contiguous = i < days.length && Date.parse(days[i]) - Date.parse(days[i - 1]) === 86400000;
    if (!contiguous) {
      const len = i - start;
      if (len > best.days) best = { days: len, from: days[start], to: days[i - 1] };
      start = i;
    }
  }
  return best;
}

/** Borító / évnyitó fotó: népszerű aktivitás, jó felbontás, az oldal arányához illő kép. */
function pickCoverPhoto(entries, pageAspect) {
  let best = null;
  let bestScore = -Infinity;
  for (const e of entries) {
    for (const p of e.photos) {
      if (p.isVideo) continue;
      const fitPenalty = Math.abs(Math.log(aspect(p) / pageAspect)) * 6;
      const score = Math.log1p(e.activity.kudos_count || 0) * 2 + Math.min(p.width, p.height) / 600 - fitPenalty;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}
