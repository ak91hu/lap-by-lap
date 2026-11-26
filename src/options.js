// A könyvkészítési kérés beállításainak ellenőrzése és alapértékei (minden mező kliensoldali, ezért szigorúan szűrjük).
import { PAGE_SIZES, THEMES, PAPER_CALIPER } from './pdf/book.js';
import { normLang } from './i18n.js';
import { parseRef } from './photos.js';
import { weatherEnabled } from './weather.js';

export function sanitizeOptions(body, reqLang = 'en') {
  const o = body || {};
  const str = (v, max) => String(v ?? '').trim().slice(0, max);
  const bool = (v, def) => (v === undefined ? def : Boolean(v));
  return {
    lang: normLang(o.lang || reqLang),
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
    stats: Array.isArray(o.stats) ? o.stats.filter((k) => ['distance', 'time', 'elevation', 'pace', 'weather', 'hr', 'power', 'calories', 'high', 'kudos'].includes(k)) : null,
    excludePhotos: new Set((Array.isArray(o.excludePhotos) ? o.excludePhotos.slice(0, 50000) : []).map(parseRef).filter(Boolean).map((r) => r.join('/'))),
    weather: bool(o.weather, true) && weatherEnabled(),
    qr: bool(o.qr, true),
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

export function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'book';
}
