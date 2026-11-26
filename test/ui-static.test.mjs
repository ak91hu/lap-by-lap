// A felület statikus ellenőrzése böngésző nélkül: elem-azonosítók, fordítási kulcsok, a magyar és angol
// szövegek egyezése, és hogy minden szerveroldali feladatlépésnek van felirata.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
const { STRINGS } = await import('../public/i18n.js');
const srcFiles = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true }).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'));
const uniq = (arr) => [...new Set(arr)];

test('minden $("#id") hivatkozásnak van eleme a HTML-ben', () => {
  const ids = uniq([...app.matchAll(/\$\('#([\w-]+)/g)].map((m) => m[1]));
  const missing = ids.filter((id) => !html.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('nincs ismétlődő id a HTML-ben', () => {
  const ids = [...html.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, []);
});

test('a magyar és az angol szöveglista kulcsai megegyeznek, nincs üres szöveg', () => {
  const hu = Object.keys(STRINGS.hu);
  const en = Object.keys(STRINGS.en);
  assert.deepEqual(hu.filter((k) => !en.includes(k)), [], 'csak magyarul van meg');
  assert.deepEqual(en.filter((k) => !hu.includes(k)), [], 'csak angolul van meg');
  for (const lang of ['hu', 'en']) for (const [k, v] of Object.entries(STRINGS[lang])) assert.ok(String(v).trim(), `${lang}.${k} üres`);
});

test('a HTML data-i18n* kulcsai és a tr("…") hívások mind léteznek', () => {
  const htmlKeys = [...html.matchAll(/data-i18n(?:-html|-ph)?="([\w.]+)"/g)].map((m) => m[1]);
  const trKeys = [...app.matchAll(/tr\('([\w.]+)'/g)].map((m) => m[1]);
  const missing = uniq([...htmlKeys, ...trKeys]).filter((k) => !(k in STRINGS.en) || !(k in STRINGS.hu));
  assert.deepEqual(missing, []);
});

test('a változós szövegek ({n}, {d} …) mindkét nyelven ugyanazokat a változókat használják', () => {
  const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const diff = Object.keys(STRINGS.en).filter((k) => vars(STRINGS.en[k]) !== vars(STRINGS.hu[k]));
  assert.deepEqual(diff, []);
});

test('minden szerveroldali feladatlépésnek (ctx.phase) van felirata', () => {
  const phases = uniq(srcFiles.flatMap((s) => [...s.matchAll(/(?:ctx\??\.phase\(|phase = )'(\w+)'/g)].map((m) => m[1])));
  assert.ok(phases.includes('phaseQueued') && phases.includes('phasePdf'), phases.join(','));
  const missing = phases.filter((p) => !(`phase.${p}` in STRINGS.en) || !(`phase.${p}` in STRINGS.hu));
  assert.deepEqual(missing, []);
});

test('minden feladattípusnak van értesítési szövege, és minden mutatónak felirata', () => {
  const kinds = uniq([...srcFiles.join('\n').matchAll(/startJob\(req, res, (?:opts\.preview \? '(\w+)' : '(\w+)'|'(\w+)')/g)].flatMap((m) => m.slice(1).filter(Boolean)));
  assert.ok(kinds.length >= 4, kinds.join(','));
  assert.deepEqual(kinds.filter((k) => !(`notify.${k}` in STRINGS.en)), []);
  const stats = JSON.parse(app.match(/const STAT_KEYS = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(stats.filter((k) => !(`stat.${k}` in STRINGS.en)), []);
});

test('a hibaüzenet-kulcsok (err.*) a kezdőoldal ?error= paramétereihez megvannak', () => {
  const codes = uniq([...srcFiles.join('\n').matchAll(/\/\?error=(\w+)/g)].map((m) => m[1]));
  assert.ok(codes.length >= 4);
  assert.deepEqual(codes.filter((c) => !(`err.${c}` in STRINGS.en)), []);
});

test('a kliens nem használ innerHTML-t felhasználói adattal (csak a statikus data-i18n-html szövegeknél)', () => {
  const uses = [...app.matchAll(/\.innerHTML\s*=/g)].length;
  assert.equal(uses, 1);
  assert.match(app, /el\.innerHTML = tr\(el\.dataset\.i18nHtml\)/);
});
