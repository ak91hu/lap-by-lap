// Fájlalapú tár: JSON-gyorsítótár, tokenek, elkészült könyvek.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const athleteDir = (id) => path.join(DATA_DIR, 'athletes', String(Number(id)));
export const booksDir = (id) => path.join(DATA_DIR, 'books', String(Number(id)));
export const tilesDir = () => path.join(DATA_DIR, 'tiles');

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomikus írás (ideiglenes fájl + átnevezés), hogy megszakításkor se sérüljön a gyorsítótár. */
export async function writeJson(file, data, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data), mode ? { mode } : undefined);
  await fs.rename(tmp, file);
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ tokenek
// A tokenek a helyi gépen maradnak (data/athletes/<id>/tokens.json), így a több napig tartó
// letöltés a szerver újraindítása után is folytatható.

const tokenCache = new Map();

export async function loadTokens(id) {
  if (tokenCache.has(id)) return tokenCache.get(id);
  const t = await readJson(path.join(athleteDir(id), 'tokens.json'));
  if (t) tokenCache.set(id, t);
  return t;
}

export async function saveTokens(id, tokens) {
  tokenCache.set(id, tokens);
  await writeJson(path.join(athleteDir(id), 'tokens.json'), tokens, 0o600);
}

export async function deleteTokens(id) {
  tokenCache.delete(id);
  await fs.rm(path.join(athleteDir(id), 'tokens.json'), { force: true });
}

export async function deleteAllData(id) {
  tokenCache.delete(id);
  await fs.rm(athleteDir(id), { recursive: true, force: true });
  await fs.rm(booksDir(id), { recursive: true, force: true });
}

// ------------------------------------------------------------------ könyvek

export async function listBooks(id) {
  const dir = booksDir(id);
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.pdf'));
  } catch {
    return [];
  }
  const out = await Promise.all(names.map(async (name) => {
    const st = await fs.stat(path.join(dir, name));
    return { name, size: st.size, createdAt: st.mtimeMs };
  }));
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function safeBookPath(id, name) {
  const base = path.basename(String(name));
  if (!base.endsWith('.pdf') || base !== name) return null;
  return path.join(booksDir(id), base);
}
