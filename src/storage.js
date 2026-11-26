// Az elkészült PDF-ek tárolása és megőrzése.
//
// • Helyben (alapértelmezés): DATA_DIR/books/<sportoló>/<név>.pdf + <név>.json (metaadatok).
// • S3-kompatibilis tárolóban (Backblaze B2, Cloudflare R2, MinIO …), ha az S3_* változók be vannak állítva:
//   a kész könyv feltöltődik, a helyi példány törlődik (a szerver kis lemeze nem telik meg), a letöltés pedig
//   a szerveren át, streamelve megy (Range-kérésekkel, így a böngésző PDF-nézője is gyors).
// • Megőrzés mindkét módban: az előnézetek PREVIEW_TTL_HOURS után törlődnek, felhasználónként a legutóbbi
//   BOOKS_KEEP könyv (kötetek + borító-terítők együtt egy könyvnek számítanak) marad meg, opcionálisan
//   BOOKS_TTL_DAYS lejárattal.
import fs from 'node:fs/promises';
import path from 'node:path';
import { AwsClient } from 'aws4fetch';
import { DATA_DIR } from './config.js';
import { booksDir, readJson, writeJson } from './store.js';

const S3 = (() => {
  const e = process.env;
  if (!e.S3_ENDPOINT || !e.S3_BUCKET || !e.S3_ACCESS_KEY_ID || !e.S3_SECRET_ACCESS_KEY) return null;
  return {
    endpoint: e.S3_ENDPOINT.replace(/\/$/, ''),
    bucket: e.S3_BUCKET,
    prefix: (e.S3_PREFIX || 'books/').replace(/^\//, ''),
    client: new AwsClient({ accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY, service: 's3', region: e.S3_REGION || 'auto' }),
  };
})();

export const RETENTION = {
  previewTtlMs: Number(process.env.PREVIEW_TTL_HOURS ?? 24) * 3600 * 1000,
  keepBooks: Math.max(1, Number(process.env.BOOKS_KEEP) || 5),
  bookTtlMs: Number(process.env.BOOKS_TTL_DAYS || 0) * 86400 * 1000,
};

export const remoteEnabled = () => Boolean(S3);
export const remoteOrigin = () => (S3 ? new URL(S3.endpoint).origin : null);

const keyOf = (athleteId, name) => `${S3.prefix}${Number(athleteId)}/${name}`;
const objectUrl = (key) => `${S3.endpoint}/${encodeURIComponent(S3.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function s3(method, key, init = {}) {
  const res = await S3.client.fetch(objectUrl(key), { method, ...init });
  if (!res.ok && !(method === 'DELETE' && res.status === 404) && !(method === 'GET' && res.status === 206)) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`S3 ${method} ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
  }
  return res;
}

const metaFile = (athleteId, name) => path.join(booksDir(athleteId), `${name}.json`);
const pdfFile = (athleteId, name) => path.join(booksDir(athleteId), name);

/** Biztonságos fájlnév-ellenőrzés: csak a könyvtárban lévő, .pdf végű név. */
export function validName(name) {
  const base = path.basename(String(name));
  return base === name && /^[\w.-]+\.pdf$/.test(base) ? base : null;
}

/**
 * Egy elkészült fájl nyilvántartásba vétele (és feltöltése, ha van S3). A hívó a PDF-et már a könyvtárba írta.
 * @param {object} info { name, build, kind, preview, pages, label }
 */
export async function storeBook(athleteId, info) {
  const file = pdfFile(athleteId, info.name);
  const st = await fs.stat(file);
  const meta = { ...info, size: st.size, createdAt: Date.now(), remote: false };
  if (S3 && !info.preview) {
    try {
      await s3('PUT', keyOf(athleteId, info.name), { body: await fs.readFile(file), headers: { 'Content-Type': 'application/pdf' } });
      meta.remote = true;
      await fs.rm(file, { force: true });
    } catch (err) {
      console.warn(`[storage] upload failed, keeping local copy (${info.name}): ${err.message}`);
    }
  }
  await writeJson(metaFile(athleteId, info.name), meta);
  return meta;
}

/** A sportoló könyvei (legújabb elöl). A metaadat nélküli régi PDF-eket is felveszi. */
export async function listBooks(athleteId) {
  const dir = booksDir(athleteId);
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const n of names.filter((x) => x.endsWith('.pdf.json'))) {
    const m = await readJson(path.join(dir, n));
    if (m?.name && validName(m.name)) {
      out.push(m);
      seen.add(m.name);
    }
  }
  for (const n of names.filter((x) => x.endsWith('.pdf') && !seen.has(x))) {
    const st = await fs.stat(path.join(dir, n)).catch(() => null);
    if (st) out.push({ name: n, size: st.size, createdAt: st.mtimeMs, remote: false, preview: n.startsWith('preview-'), build: n.replace(/(-cover)?\.pdf$/, '') });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getBook(athleteId, name) {
  const n = validName(name);
  if (!n) return null;
  const m = await readJson(metaFile(athleteId, n));
  if (m) return m;
  const st = await fs.stat(pdfFile(athleteId, n)).catch(() => null);
  return st ? { name: n, size: st.size, createdAt: st.mtimeMs, remote: false } : null;
}

/**
 * Könyv kiszolgálása: helyben sendFile, S3-ból streamelt továbbítás (Range-kérésekkel).
 * @param {'inline'|'attachment'} disposition
 */
export async function sendBook(athleteId, meta, req, res, disposition) {
  const cd = `${disposition}; filename="${meta.name}"`;
  if (!meta.remote) {
    res.set('Content-Disposition', cd);
    return res.sendFile(pdfFile(athleteId, meta.name), (err) => err && !res.headersSent && res.status(404).end());
  }
  const headers = req.headers.range ? { Range: req.headers.range } : {};
  const up = await s3('GET', keyOf(athleteId, meta.name), { headers });
  res.status(up.status);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': cd, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' });
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) if (up.headers.get(h)) res.set(h, up.headers.get(h));
  const reader = up.body.getReader();
  res.on('close', () => reader.cancel().catch(() => {}));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!res.write(value)) await new Promise((r) => res.once('drain', r));
  }
  res.end();
}

export async function deleteBook(athleteId, name) {
  const n = validName(name);
  if (!n) return false;
  const m = await readJson(metaFile(athleteId, n));
  if (m?.remote && S3) await s3('DELETE', keyOf(athleteId, n));
  await fs.rm(pdfFile(athleteId, n), { force: true });
  await fs.rm(metaFile(athleteId, n), { force: true });
  return true;
}

/** Minden könyv törlése (az adattörlésnél), a távoli példányokkal együtt. */
export async function deleteAllBooks(athleteId) {
  for (const b of await listBooks(athleteId)) await deleteBook(athleteId, b.name).catch(() => {});
  await fs.rm(booksDir(athleteId), { recursive: true, force: true });
}

/**
 * Megőrzési szabályok egy sportolóra: lejárt előnézetek, a BOOKS_KEEP-nél régebbi könyvek, lejárt könyvek.
 * @returns {Promise<string[]>} a törölt fájlok nevei
 */
export async function applyRetention(athleteId, now = Date.now()) {
  const books = await listBooks(athleteId);
  const removed = [];
  const previews = books.filter((b) => b.preview);
  const full = books.filter((b) => !b.preview);
  for (const b of previews) if (now - b.createdAt > RETENTION.previewTtlMs) removed.push(b.name);
  // a legutóbbi BOOKS_KEEP könyv-összeállítás marad (egy összeállítás = kötetek + borítók)
  const builds = [...new Set(full.map((b) => b.build || b.name))];
  const keep = new Set(builds.slice(0, RETENTION.keepBooks));
  for (const b of full) {
    if (!keep.has(b.build || b.name) || (RETENTION.bookTtlMs && now - b.createdAt > RETENTION.bookTtlMs)) removed.push(b.name);
  }
  for (const n of removed) await deleteBook(athleteId, n).catch((e) => console.warn(`[storage] retention delete failed (${n}): ${e.message}`));
  return removed;
}

/** Óránkénti takarítás minden sportolóra (az előnézetek lejárata miatt). */
export function startRetentionTimer(intervalMs = 3600 * 1000) {
  const run = async () => {
    let ids = [];
    try {
      ids = (await fs.readdir(path.join(DATA_DIR, 'books'))).filter((n) => /^\d+$/.test(n));
    } catch { /* még nincs könyv */ }
    for (const id of ids) await applyRetention(Number(id)).catch(() => {});
  };
  const t = setInterval(run, intervalMs);
  t.unref();
  run();
  return t;
}
