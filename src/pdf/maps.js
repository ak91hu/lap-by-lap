// Opcionális térképháttér csempékből (MAP_TILE_URL). A csempék lemezen gyorsítótárazódnak,
// és a térkép visszafogott, deszaturált stílust kap, hogy az útvonal kiemelkedjen.
// Ha nincs csempeszolgáltató beállítva, vagy hiba történik, a könyv vektoros útvonalrajzot használ.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { MAP } from '../config.js';
import { tilesDir } from '../store.js';

const TILE = 256;
const UA = 'LapByLap/2.0 (personal photobook generator; local, low volume)';
const lon2x = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const lat2y = (lat, z) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE * 2 ** z;
};

export const basemapEnabled = () => Boolean(MAP.tileUrl);

const templateKey = () => crypto.createHash('sha1').update(MAP.tileUrl).digest('hex').slice(0, 10);
let sub = 0;

async function tile(z, x, y) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return null;
  const wx = ((x % n) + n) % n;
  const file = path.join(tilesDir(), templateKey(), String(z), String(wx), `${y}.img`);
  try {
    return await fs.readFile(file);
  } catch { /* nincs a gyorsítótárban */ }
  const url = MAP.tileUrl
    .replace('{z}', z).replace('{x}', wx).replace('{y}', y)
    .replace('{s}', 'abc'[sub++ % 3]).replace('{r}', '');
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`tile ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, buf);
  return buf;
}

/**
 * @returns {Promise<null | {buffer: Buffer, project: (lat:number, lng:number)=>[number, number], metersPerPt: number}>}
 */
export async function renderBasemap(latlngs, wPt, hPt, { dpi = 200, pad = 0.14 } = {}) {
  if (!basemapEnabled() || latlngs.length < 2) return null;
  const wPx = Math.round((wPt / 72) * dpi);
  const hPx = Math.round((hPt / 72) * dpi);
  let z = 17;
  let bx0, by0, bx1, by1;
  for (; z >= 2; z--) {
    const xs = latlngs.map(([, lng]) => lon2x(lng, z));
    const ys = latlngs.map(([lat]) => lat2y(lat, z));
    bx0 = Math.min(...xs); bx1 = Math.max(...xs); by0 = Math.min(...ys); by1 = Math.max(...ys);
    if (bx1 - bx0 <= wPx * (1 - 2 * pad) && by1 - by0 <= hPx * (1 - 2 * pad)) break;
  }
  const vx0 = (bx0 + bx1) / 2 - wPx / 2;
  const vy0 = (by0 + by1) / 2 - hPx / 2;
  const tx0 = Math.floor(vx0 / TILE);
  const ty0 = Math.floor(vy0 / TILE);
  const tx1 = Math.floor((vx0 + wPx - 1) / TILE);
  const ty1 = Math.floor((vy0 + hPx - 1) / TILE);
  const nx = tx1 - tx0 + 1;
  const ny = ty1 - ty0 + 1;
  if (nx * ny > 100) return null;

  try {
    const jobs = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) jobs.push({ tx, ty });
    const tiles = [];
    for (let i = 0; i < jobs.length; i += 4) {
      const batch = await Promise.all(jobs.slice(i, i + 4).map(async (j) => ({ ...j, buf: await tile(z, j.tx, j.ty) })));
      tiles.push(...batch);
    }
    const mosaic = await sharp({ create: { width: nx * TILE, height: ny * TILE, channels: 3, background: '#f2efe9' } })
      .composite(await Promise.all(tiles.filter((t) => t.buf).map(async (t) => ({
        input: await sharp(t.buf).resize(TILE, TILE).png().toBuffer(),
        left: (t.tx - tx0) * TILE,
        top: (t.ty - ty0) * TILE,
      }))))
      .png()
      .toBuffer();
    const buffer = await sharp(mosaic)
      .extract({ left: Math.round(vx0 - tx0 * TILE), top: Math.round(vy0 - ty0 * TILE), width: wPx, height: hPx })
      .modulate({ saturation: 0.28, brightness: 1.03 })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    const midLat = latlngs.reduce((s, p) => s + p[0], 0) / latlngs.length;
    const metersPerPx = (156543.03392 * Math.cos((midLat * Math.PI) / 180)) / 2 ** z;
    return {
      buffer,
      project: (lat, lng) => [((lon2x(lng, z) - vx0) / wPx) * wPt, ((lat2y(lat, z) - vy0) / hPx) * hPt],
      metersPerPt: metersPerPx * (wPx / wPt),
    };
  } catch (err) {
    console.warn(`Basemap failed, using vector route: ${err.message}`);
    return null;
  }
}
