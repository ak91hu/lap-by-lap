// A könyvhöz letöltött fotók böngészése és letöltése (egyenként vagy ZIP-ben).
// Ugyanazokat a helyi fájlokat adja ki, amelyekből a könyv készül (data/athletes/<id>/images/<aktivitás>/<fotó>.jpg).
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import yazl from 'yazl';
import { athleteDir, readJson, exists } from './store.js';
import { loadActivities } from './sync.js';

const ACT_RE = /^\d{1,20}$/;
const PID_RE = /^[\w.-]{1,120}$/;

/** "aktivitás/fotó" azonosító → [aktivitás, fotó], vagy null, ha érvénytelen. */
export function parseRef(ref) {
  const [act, pid, extra] = String(ref).split('/');
  if (extra !== undefined || !ACT_RE.test(act || '') || !PID_RE.test(pid || '')) return null;
  return [act, pid];
}

export function photoFile(athleteId, act, pid) {
  return path.join(athleteDir(athleteId), 'images', act, `${pid}.jpg`);
}

/** Kis előnézeti kép (lemezen gyorsítótárazva, hogy a rács ne a teljes felbontású fájlokat töltse). */
export async function thumbFile(athleteId, act, pid) {
  const src = photoFile(athleteId, act, pid);
  const out = path.join(athleteDir(athleteId), 'thumbs', act, `${pid}.jpg`);
  if (await exists(out)) return out;
  if (!(await exists(src))) return null;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  await sharp(src, { failOn: 'none' }).rotate()
    .resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true }).toFile(tmp);
  await fs.rename(tmp, out);
  return out;
}

/**
 * A helyben meglévő fotók aktivitásonként, a legfrissebb aktivitással kezdve.
 * Tömör formátum: groups = [[aktivitás-id, név, dátum, [[fotó-id, szélesség, magasság], …]], …]
 */
export async function listPhotos(athleteId) {
  const dir = athleteDir(athleteId);
  const acts = (await loadActivities(athleteId)) || [];
  const byId = new Map(acts.map((a) => [String(a.id), a]));
  const expected = acts.reduce((n, a) => n + (a.total_photo_count || 0), 0);
  let ids = [];
  try {
    ids = (await fs.readdir(path.join(dir, 'images'))).filter((n) => ACT_RE.test(n));
  } catch { /* még nincs letöltött fotó */ }

  const groups = [];
  for (const id of ids) {
    const index = (await readJson(path.join(dir, 'images', id, 'index.json'))) || {};
    const list = await readJson(path.join(dir, 'photos', `${id}.json`));
    // A fotólista sorrendje (útvonal/időrend) a könyvével egyezik; a listán kívüli fájlok a végére kerülnek.
    const order = list?.items?.map((p) => p.id).filter((pid) => index[pid]) || [];
    const rest = Object.keys(index).filter((pid) => !order.includes(pid));
    const photos = [...order, ...rest].filter((pid) => PID_RE.test(pid)).map((pid) => [pid, index[pid].w || 0, index[pid].h || 0]);
    if (!photos.length) continue;
    const a = byId.get(id);
    groups.push([id, a?.name || '', a?.start_date_local || '', photos]);
  }
  groups.sort((x, y) => String(y[2]).localeCompare(String(x[2])));
  const downloaded = groups.reduce((n, g) => n + g[3].length, 0);
  const photoActs = acts.filter((a) => (a.total_photo_count || 0) > 0).length;
  return { expected, downloaded, photoActs, groups };
}

const cleanName = (s) => String(s || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '');

/** Fájlnév a letöltéshez: "2024-05-12 Reggeli futás 03.jpg". */
export function downloadName(activity, index) {
  const day = (activity?.start_date_local || '').slice(0, 10);
  const name = cleanName(activity?.name) || 'photo';
  return `${[day, name].filter(Boolean).join(' ')} ${String(index + 1).padStart(2, '0')}.jpg`;
}

/**
 * A kért fotók ZIP-be csomagolva, közvetlenül a válaszba streamelve (tömörítés nélkül: a JPEG úgysem tömörödik,
 * így gyors és kevés CPU kell). Mappák aktivitásonként: "2024-05-12 Reggeli futás/01.jpg".
 * @param {Set<string>|null} refs "aktivitás/fotó" azonosítók; null = minden letöltött fotó
 */
export async function streamZip(athleteId, refs, res, filename) {
  const { groups } = await listPhotos(athleteId);
  const zip = new yazl.ZipFile();
  const folders = new Set();
  let count = 0;
  for (const [act, name, date, photos] of [...groups].reverse()) { // időrendben
    const chosen = photos.filter(([pid]) => !refs || refs.has(`${act}/${pid}`));
    if (!chosen.length) continue;
    const base = [date.slice(0, 10), cleanName(name)].filter(Boolean).join(' ') || act;
    let folder = base;
    for (let i = 2; folders.has(folder.toLowerCase()); i++) folder = `${base} (${i})`;
    folders.add(folder.toLowerCase());
    for (const [pid] of chosen) {
      // A sorszám az aktivitás teljes fotólistájában elfoglalt hely, így részleges letöltésnél is stabil.
      const n = photos.findIndex(([p]) => p === pid) + 1;
      zip.addFile(photoFile(athleteId, act, pid), `${folder}/${String(n).padStart(2, '0')}.jpg`, { compress: false });
      count++;
    }
  }
  if (!count) return false;
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  zip.on('error', () => res.destroy()); // pl. közben törölt fájl
  zip.outputStream.on('error', () => res.destroy());
  zip.outputStream.pipe(res);
  zip.end();
  return true;
}
