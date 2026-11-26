// Fájlalapú tár: JSON-gyorsítótár, tokenek, elkészült könyvek.
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, SESSION_SECRET } from './config.js';
import { tokenKey, encryptJson, decryptJson } from './security.js';

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
  const file = path.join(athleteDir(id), 'tokens.json');
  // A memóriabeli példány csak addig érvényes, amíg a fájl létezik: ha az adatokat kívülről törlik
  // (pl. üzemeltetői takarítás), a munkamenet azonnal megszűnik, nem csak újraindításkor.
  if (tokenCache.has(id)) {
    if (await exists(file)) return tokenCache.get(id);
    tokenCache.delete(id);
    return null;
  }
  const stored = await readJson(file);
  const t = decryptJson(stored, TOKEN_KEY);
  if (!t) return null; // hiányzó, sérült vagy más kulccsal titkosított fájl → újra be kell jelentkezni
  tokenCache.set(id, t);
  if (!stored.enc) await saveTokens(id, t); // régi, titkosítatlan fájl → titkosítva újraírjuk
  return t;
}

// A Strava-tokenek titkosítva kerülnek a lemezre (AES-256-GCM), így egy kiszivárgott mentés vagy kötet-pillanatkép
// önmagában nem ad hozzáférést a felhasználók Strava-adataihoz.
const TOKEN_KEY = tokenKey(SESSION_SECRET);

export async function saveTokens(id, tokens) {
  tokenCache.set(id, tokens);
  await writeJson(path.join(athleteDir(id), 'tokens.json'), encryptJson(tokens, TOKEN_KEY), 0o600);
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
