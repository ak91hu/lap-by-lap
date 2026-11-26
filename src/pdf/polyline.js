// Google "encoded polyline" dekódolás + egyszerű Mercator-vetítés egy dobozba.

export function decodePolyline(str) {
  if (!str) return [];
  const pts = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index < str.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}

function mercY(lat) {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}

const EARTH_R = 6371000;

/**
 * A pontokat a (x, y, w, h) dobozba illeszti arányosan, középre.
 * @returns {{pts: Array<[number, number]>, metersPerPt: number}}
 */
export function projectToBox(latlngs, x, y, w, h, pad = 0) {
  if (latlngs.length < 2) return { pts: [], metersPerPt: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const xs = new Float64Array(latlngs.length);
  const ys = new Float64Array(latlngs.length);
  let latSum = 0;
  latlngs.forEach(([lat, lng], i) => {
    xs[i] = (lng * Math.PI) / 180;
    ys[i] = mercY(lat);
    latSum += lat;
    if (xs[i] < minX) minX = xs[i];
    if (xs[i] > maxX) maxX = xs[i];
    if (ys[i] < minY) minY = ys[i];
    if (ys[i] > maxY) maxY = ys[i];
  });
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const iw = w - 2 * pad;
  const ih = h - 2 * pad;
  const scale = Math.min(iw / spanX, ih / spanY);
  const ox = x + pad + (iw - spanX * scale) / 2;
  const oy = y + pad + (ih - spanY * scale) / 2;
  const pts = Array.from(xs, (px, i) => [ox + (px - minX) * scale, oy + (maxY - ys[i]) * scale]);
  const midLat = latSum / latlngs.length;
  return { pts, metersPerPt: (EARTH_R * Math.cos((midLat * Math.PI) / 180)) / scale };
}
