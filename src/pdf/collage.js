// Kompozíciós motor a fotóoldalakhoz – úgy dolgozik, mint egy fotókönyv-tervező:
//
//  • Minden oldalt egy „vágásos” (guillotine) szerkezet bont cellákra: a teret rekurzívan, vízszintesen
//    vagy függőlegesen kettéosztja. Ebből kijön minden klasszikus sablon (1 nagy + 2 kicsi, 2×2 rács,
//    nagy álló kép mellett két fekvő, stb.), és a cellák mindig egy közös rácsra és résre illeszkednek.
//  • Az osztásarányokat a fotók képaránya adja (fekvő kép széles, álló kép magas cellát kap), így a
//    képeket csak minimálisan kell vágni; a maradék eltérést intelligens kivágás kezeli (max. ~25%).
//  • Pontozás: kitöltés, vágás mértéke, hierarchia (egy domináns kép), ne legyenek túl kicsi vagy
//    túl keskeny cellák, és a gyenge felbontású képek ne kapjanak nagy cellát.
//  • Lapozás: oldalanként annyi kép, amennyi a minimális képméret mellett szépen elfér; az utolsó
//    oldalra nem marad árva egyetlen kép.
//
// A képek sorrendje (az útvonal menti sorrend) oldalon belül is megmarad – a térkép sorszámai így
// balról jobbra, fentről lefelé követik egymást.

const MAX_STRETCH = Math.log(1.32); // a teljes elrendezés legfeljebb ennyivel nyújtható a terület kitöltéséhez
const MAX_CROP = Math.log(1.45); // egyetlen kép legfeljebb ennyire vágható

const aspectOf = (p) => {
  const a = p.width / p.height;
  return Number.isFinite(a) && a > 0 ? Math.min(Math.max(a, 0.33), 3.2) : 1.5;
};

// ---------------------------------------------------------------- szerkezetek

const treeCache = new Map();

/** Az összes bináris vágásos szerkezet `n` levélre (a levelek sorrendje rögzített). */
function trees(n) {
  if (treeCache.has(n)) return treeCache.get(n);
  let out;
  if (n === 1) out = [{ leaf: true, n: 1 }];
  else {
    out = [];
    for (let k = 1; k < n; k++) {
      for (const l of trees(k)) {
        for (const r of trees(n - k)) {
          out.push({ dir: 'h', l, r, n }); // egymás mellett
          out.push({ dir: 'v', l, r, n }); // egymás alatt
        }
      }
    }
  }
  treeCache.set(n, out);
  return out;
}

/** Természetes képarány: egymás mellett az arányok összeadódnak, egymás alatt a reciprokok. */
function natural(node, aspects, i = 0) {
  if (node.leaf) return { a: aspects[i], next: i + 1 };
  const L = natural(node.l, aspects, i);
  const R = natural(node.r, aspects, L.next);
  const a = node.dir === 'h' ? L.a + R.a : 1 / (1 / L.a + 1 / R.a);
  return { a, next: R.next, la: L.a, ra: R.a };
}

function place(node, aspects, x, y, w, h, gap, out, i = 0) {
  if (node.leaf) {
    out.push({ x, y, w, h, i });
    return i + 1;
  }
  const la = natural(node.l, aspects, i).a;
  const nL = node.l.n;
  const ra = natural(node.r, aspects, i + nL).a;
  if (node.dir === 'h') {
    const ww = w - gap;
    const wl = ww * (la / (la + ra));
    const next = place(node.l, aspects, x, y, wl, h, gap, out, i);
    return place(node.r, aspects, x + wl + gap, y, ww - wl, h, gap, out, next);
  }
  const hh = h - gap;
  const hl = hh * ((1 / la) / (1 / la + 1 / ra));
  const next = place(node.l, aspects, x, y, w, hl, gap, out, i);
  return place(node.r, aspects, x, y + hl + gap, w, hh - hl, gap, out, next);
}

function depth(node) {
  return node.leaf ? 0 : 1 + Math.max(depth(node.l), depth(node.r));
}

// ---------------------------------------------------------------- egy oldal legjobb kompozíciója

/**
 * @param {Array} photos       a képek (width, height, caption/pin jelzéssel)
 * @param {number} W, H        a rendelkezésre álló terület
 * @param {object} o           { gap, capH(p), pageArea, minFrac, dpi(p, w, h) }
 * @returns {null | {cells: Array<{x,y,w,h,imgH,p,crop}>, w, h, score}}
 */
export function compose(photos, W, H, o) {
  const n = photos.length;
  // Egységes képaláírás-sáv az oldalon: így egy sorban a képek alja egy vonalba esik.
  const cap = photos.some(o.hasCap) ? o.capH : 0;
  const aspects = photos.map((p) => {
    const a = aspectOf(p);
    // a sáv a cellán belül van, a cella arányába beszámítjuk (a cellaszélesség becslésével)
    return cap ? 1 / (1 / a + cap / Math.max(W / Math.ceil(Math.sqrt(n)), 1)) : a;
  });
  let best = null;
  for (const t of trees(n)) {
    if (n >= 4 && depth(t) > 3) continue;
    const A = natural(t, aspects).a;
    const regionA = W / H;
    // a teljes elrendezést legfeljebb MAX_STRETCH-csel nyújtjuk a terület arányára
    const stretch = Math.log(regionA / A);
    const s = Math.max(-MAX_STRETCH, Math.min(MAX_STRETCH, stretch));
    const tA = A * Math.exp(s);
    const [bw, bh] = tA > regionA ? [W, W / tA] : [H * tA, H];
    const cells = [];
    place(t, aspects, 0, 0, bw, bh, o.gap, cells);
    let crop = 0;
    let maxCrop = 0;
    let bad = false;
    let small = 0;
    let lowres = 0;
    let skinny = 0;
    let minA = Infinity;
    let maxA = 0;
    for (const c of cells) {
      const p = photos[c.i];
      c.cap = cap;
      c.imgH = c.h - cap;
      if (c.imgH <= 20 || c.w <= 20) { bad = true; break; }
      const ca = c.w / c.imgH;
      c.crop = Math.abs(Math.log(ca / aspectOf(p)));
      if (c.crop > MAX_CROP) { bad = true; break; }
      crop += c.crop;
      maxCrop = Math.max(maxCrop, c.crop);
      const area = c.w * c.imgH;
      minA = Math.min(minA, area);
      maxA = Math.max(maxA, area);
      if (area < o.pageArea * o.minFrac) small++;
      if (ca < 0.42 || ca > 3.4) skinny++;
      const dpi = o.dpi(p, c.w, c.imgH);
      if (dpi < 110) lowres += (110 - dpi) / 110;
    }
    if (bad) continue;
    const fill = (bw * bh) / (W * H);
    const hierarchy = n >= 3 ? Math.min(0.12, Math.max(0, Math.log(maxA / minA) - 0.35) * 0.08) : 0;
    const score = fill * 1.0 - (crop / n) * 0.9 - maxCrop * 0.35 + hierarchy
      - small * 0.25 - skinny * 0.2 - lowres * 0.6 - depth(t) * 0.004;
    if (!best || score > best.score) best = { cells, w: bw, h: bh, score, small };
  }
  if (best) for (const c of best.cells) c.p = photos[c.i];
  return best;
}

/**
 * Hány kép kerüljön a következő oldalra? A legtöbb, ami még szépen elfér (ne legyen túl kicsi kép),
 * és ne maradjon árva egyetlen kép a végére.
 */
export function planPage(photos, W, H, o, maxPerPage = 6) {
  const upTo = Math.min(photos.length, maxPerPage);
  let chosen = null;
  for (let k = upTo; k >= 1; k--) {
    const c = compose(photos.slice(0, k), W, H, o);
    if (!c) continue;
    if (c.small > 0 && k > 1) continue; // túl kicsi képek – inkább kevesebbet tegyünk erre az oldalra
    if (c.score < (k === 1 ? -0.5 : 0.25)) continue;
    chosen = { k, ...c };
    break;
  }
  if (!chosen) return null;
  // Árva kép elkerülése: ha csak egy kép maradna a következő oldalra, inkább kettő menjen oda.
  const rest = photos.length - chosen.k;
  if (rest === 1 && chosen.k >= 3) {
    const alt = compose(photos.slice(0, chosen.k - 1), W, H, o);
    if (alt && alt.small === 0) chosen = { k: chosen.k - 1, ...alt };
  }
  return chosen;
}
