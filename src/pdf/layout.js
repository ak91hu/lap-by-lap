// "Justified rows" fotóelrendezés: a képek soronként pontosan kitöltik a szélességet,
// eredeti képarányukat megtartva (vágás nélkül).

/**
 * @param {Array<{width:number,height:number}>} photos
 * @param {number} W         rendelkezésre álló szélesség
 * @param {number} gap       képek közti rés
 * @param {number} targetH   kívánt sormagasság
 * @param {number} maxPerRow legfeljebb ennyi kép egy sorban
 * @returns {Array<{items:Array, aspects:number[], h:number}>}
 */
export function buildRows(photos, W, gap, targetH, maxPerRow = 3) {
  const rows = [];
  let cur = [];
  let sumA = 0;
  const flush = () => {
    if (!cur.length) return;
    const aspects = cur.map(aspect);
    const h = (W - gap * (cur.length - 1)) / sumA;
    rows.push({ items: cur, aspects, h });
    cur = [];
    sumA = 0;
  };
  for (const p of photos) {
    cur.push(p);
    sumA += aspect(p);
    if (sumA * targetH + gap * (cur.length - 1) >= W || cur.length >= maxPerRow) flush();
  }
  flush();

  // Ha az utolsó sor egyetlen kép lenne, de az előző sor 3 képes, egyet áthozunk,
  // így nem lesz egy aránytalanul nagy kép a végén.
  if (rows.length >= 2) {
    const last = rows[rows.length - 1];
    const prev = rows[rows.length - 2];
    if (last.items.length === 1 && prev.items.length >= 3) {
      const moved = prev.items.pop();
      last.items.unshift(moved);
      for (const r of [prev, last]) {
        r.aspects = r.items.map(aspect);
        r.h = (W - gap * (r.items.length - 1)) / r.aspects.reduce((s, a) => s + a, 0);
      }
    }
  }
  return rows;
}

export function aspect(p) {
  const a = p.width / p.height;
  return Number.isFinite(a) && a > 0 ? Math.min(Math.max(a, 0.3), 4) : 1.5;
}

/** Egy sor elemeinek szélességei és vízszintes kezdőpontja adott magasság mellett (középre igazítva). */
export function placeRow(row, x, W, gap, h) {
  const widths = row.aspects.map((a) => a * h);
  const total = widths.reduce((s, w) => s + w, 0) + gap * (widths.length - 1);
  let cx = x + Math.max(0, (W - total) / 2);
  return widths.map((w) => {
    const r = { x: cx, w };
    cx += w + gap;
    return r;
  });
}
