// Lap by Lap – kliensoldali logika (build nélküli ES-modul).
import { STRINGS } from './i18n.js';
import { createFlipbook } from './flipbook.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const form = $('#form');

const state = {
  lang: 'en',
  status: null,
  acts: [], // [id, name, date, type, typeName, distance, photos]
  types: new Set(),
  excluded: new Set(),
  favorites: new Set(),
  stats: new Set(['distance', 'time', 'elevation', 'pace', 'weather', 'hr', 'power', 'calories', 'high', 'kudos']),
  coverId: null,
  coverUrl: null,
  busy: false,
  jobId: null,
  photos: null, // { expected, downloaded, photoActs, groups: [[aktivitás, név, dátum, [[fotó, w, h], …]], …] }
  photoSel: new Set(), // "aktivitás/fotó" – letöltéshez kijelölve
  photoExcl: new Set(), // "aktivitás/fotó" – kimarad a könyvből
  coverRef: null, // a borító forrásfotója a saját fotók közül
  advanced: false, // részletes beállítások láthatók
  settingsReady: false, // a mentett beállítások betöltése után kezdünk menteni
};

const SIZE_MM = { a4: [210, 297], a4l: [297, 210], sq21: [210, 210], sq30: [300, 300], a5: [148, 210] };

// ------------------------------------------------------------------ i18n

function tr(key, vars = {}) {
  const s = STRINGS[state.lang]?.[key] ?? STRINGS.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
const nf = () => new Intl.NumberFormat(state.lang === 'hu' ? 'hu-HU' : 'en-GB', { maximumFractionDigits: 0 });
const fmtDate = (iso) => new Intl.DateTimeFormat(state.lang === 'hu' ? 'hu-HU' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(iso));

function applyI18n() {
  document.documentElement.lang = state.lang;
  document.title = tr('meta.title');
  for (const el of $$('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
  for (const el of $$('[data-i18n-html]')) el.innerHTML = tr(el.dataset.i18nHtml); // csak saját, statikus szövegek
  for (const el of $$('[data-i18n-ph]')) el.placeholder = tr(el.dataset.i18nPh);
  for (const b of $$('.lang button')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
  setHeroCover();
  renderStaticOptions();
  renderStatChips();
  renderFavCount();
  renderAdvanced();
  if (window.__flipbook) window.__flipbook.relabel();
}

async function setLang(lang) {
  state.lang = lang;
  await fetch('/api/lang', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang }) });
  form.elements.lang.value = lang;
  applyI18n();
  $('#lang-note').textContent = '';
  if (state.status?.loggedIn) {
    if (state.status.summary) renderSummary(state.status.summary);
    if (state.acts.length) await loadActivities();
    renderBooks();
    renderArchive();
    renderPhotoStatus();
    renderPhotoGroups();
  }
  updateAll();
}

// ------------------------------------------------------------------ API

async function api(url, { method = 'GET', body, raw, headers = {} } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'X-Lang': state.lang, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showAlert(msg) {
  const el = $('#alert');
  el.textContent = msg || '';
  el.hidden = !msg;
  if (msg) window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ------------------------------------------------------------------ init

async function init() {
  const err = new URLSearchParams(location.search).get('error');
  const st = await api('/api/status');
  state.status = st;
  state.lang = st.lang;
  form.elements.lang.value = st.lang;
  renderSizes();
  renderThemes();
  applyI18n();
  if (st.langSource === 'ip' && st.country) $('#lang-note').textContent = `· ${tr('lang.auto', { c: st.country })}`;
  if (err) {
    showAlert(tr(`err.${err}`));
    history.replaceState(null, '', '/');
  }
  $('#cb-domain').textContent = st.redirectDomain;

  if (!st.loggedIn) {
    $('#landing').hidden = false;
    $('#connect').hidden = !st.configured;
    $('#setup').hidden = st.configured;
    await mountSample();
  } else {
    $('#app').hidden = false;
    $('#user').hidden = false;
    $('#user-name').textContent = [st.athlete?.firstname, st.athlete?.lastname].filter(Boolean).join(' ');
    if (st.athlete?.profile?.startsWith('https://')) $('#user-avatar').src = st.athlete.profile;
    else $('#user-avatar').hidden = true;
    const saved = await api('/api/settings').catch(() => ({}));
    applyFormSettings(saved);
    renderStatChips();
    renderFavCount();
    renderAdvanced();
    if (st.summary) {
      renderSummary(st.summary);
      await loadActivities();
      applyTypeSettings(saved);
      renderChips();
      renderPicker();
      await loadPhotos();
    }
    renderArchive();
    renderBooks();
    state.settingsReady = true;
    if (st.job) resumeJob(st.job);
  }
  document.documentElement.classList.remove('is-loading');
  updateAll();
}

// ------------------------------------------------------------------ mintakönyv (kedvcsináló)

/** A kezdőoldali nagy könyvmakett a mintakönyv valódi borítóját mutatja, az aktuális nyelven. */
function setHeroCover() {
  const cover = $('#hero-cover');
  if (!cover) return;
  const img = new Image();
  img.onload = () => {
    cover.style.backgroundImage = `url("${img.src}")`;
    cover.classList.add('has-image');
  };
  img.onerror = () => cover.classList.remove('has-image'); // tartalék: lefordított szöveges borító
  img.src = `/sample/${state.lang}/p01.webp`;
}

async function loadSampleManifest(lang) {
  const res = await fetch(`/sample/${lang}/manifest.json`);
  return res.ok ? res.json() : null;
}

async function mountSample() {
  const m = await loadSampleManifest(state.lang).catch(() => null);
  if (!m) {
    $('#sample').hidden = true;
    return;
  }
  const src = (lang) => (n) => `/sample/${lang}/p${String(n).padStart(2, '0')}.webp`;
  const fb = createFlipbook($('#flipbook'), {
    src: src(state.lang),
    pages: m.pages,
    ratio: m.width / m.height,
    label: (a, b, n) => (a === b ? tr('sample.page', { a, n }) : tr('sample.spread', { a, b, n })),
  });
  $('#flipbook .fb-prev').setAttribute('aria-label', tr('sample.prev'));
  $('#flipbook .fb-next').setAttribute('aria-label', tr('sample.next'));
  window.__flipbook = {
    relabel: async () => {
      const mm = await loadSampleManifest(state.lang).catch(() => null);
      if (mm) fb.setSource(src(state.lang), mm.pages);
      $('#flipbook .fb-prev').setAttribute('aria-label', tr('sample.prev'));
      $('#flipbook .fb-next').setAttribute('aria-label', tr('sample.next'));
    },
  };
}

// ------------------------------------------------------------------ statikus vezérlők

function renderSizes() {
  const box = $('#sizes');
  box.replaceChildren();
  for (const key of state.status.pageSizes) {
    const [w, h] = SIZE_MM[key];
    const k = 52 / Math.max(w, h);
    const label = document.createElement('label');
    label.className = 'size';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'pageSize', value: key, checked: key === 'a4' });
    const shape = document.createElement('span');
    shape.className = 'shape';
    shape.style.width = `${Math.round(w * k)}px`;
    shape.style.height = `${Math.round(h * k)}px`;
    const text = document.createElement('span');
    text.dataset.i18n = `size.${key}`;
    label.append(input, shape, text);
    box.append(label);
  }
}

function renderThemes() {
  const box = $('#themes');
  box.replaceChildren();
  Object.entries(state.status.themes).forEach(([key, th], i) => {
    const label = document.createElement('label');
    label.className = 'theme';
    const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'theme', value: key, checked: i === 0 });
    const sw = document.createElement('span');
    sw.className = 'sw';
    sw.style.background = `linear-gradient(135deg, ${th.accent} 55%, ${th.tint} 55%)`;
    const text = document.createElement('span');
    text.dataset.i18n = `theme.${key}`;
    label.append(input, sw, text);
    box.append(label);
  });
}

function renderStaticOptions() {
  const fill = (sel, opts) => {
    const cur = sel.value;
    sel.replaceChildren(...opts.map(([v, label]) => Object.assign(document.createElement('option'), { value: v, textContent: label })));
    if (cur && opts.some(([v]) => String(v) === cur)) sel.value = cur;
  };
  fill($('#maxPhotos'), [[0, tr('sel.maxAll')], ...[3, 6, 12, 24].map((n) => [n, tr('sel.maxN', { n })])]);
  fill($('#privacy'), [[0, tr('con.priv0')], ...[200, 500, 1000].map((n) => [n, tr('con.privN', { n })])]);
  if (!$('#privacy').dataset.init) {
    $('#privacy').value = '200';
    $('#privacy').dataset.init = '1';
  }
}

// ------------------------------------------------------------------ szinkron + archívum

// Betöltési animáció: kirajzolódó útvonal futó ponttal, felpörgő számláló és váltakozó üzenetek.
function syncAnimation() {
  const box = $('#sync-anim');
  const num = $('#sync-n');
  let shown = 0;
  let target = 0;
  let raf = 0;
  let msgIdx = 0;
  box.hidden = false;
  box.classList.remove('done');
  num.textContent = '0';
  const msg = () => {
    $('#sync-msg').textContent = tr(`sync.msg${(msgIdx % 5) + 1}`);
    msgIdx++;
  };
  msg();
  const timer = setInterval(msg, 2200);
  const tick = () => {
    if (shown < target) {
      shown = Math.min(target, shown + Math.max(1, Math.ceil((target - shown) / 12)));
      num.textContent = nf().format(shown);
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    set(n) { target = Math.max(target, n); },
    async finish(n) {
      target = n;
      clearInterval(timer);
      await new Promise((r) => setTimeout(r, 650));
      num.textContent = nf().format(n);
      $('#sync-msg').textContent = tr('sync.done');
      box.classList.add('done');
      cancelAnimationFrame(raf);
      await new Promise((r) => setTimeout(r, 900));
      box.hidden = true;
    },
    stop() {
      clearInterval(timer);
      cancelAnimationFrame(raf);
      box.hidden = true;
    },
  };
}

$('#sync').addEventListener('click', async () => {
  const anim = syncAnimation();
  setBusy(true);
  try {
    const { jobId } = await api('/api/sync', { method: 'POST' });
    const job = await runJob(jobId, (j) => {
      anim.set(j.done || 0);
      $('#sync-status').textContent = j.waitUntil ? tr('prog.wait', { k: tr(`wait.${j.waitKind}`), t: countdown(j.waitUntil) }) : '';
    });
    await anim.finish(job.result.summary.count);
    renderSummary(job.result.summary);
    state.status.summary = job.result.summary;
    state.types.clear();
    await loadActivities();
    await loadPhotos();
  } catch (e) {
    anim.stop();
    showAlert(e.message);
  } finally {
    $('#sync-status').textContent = '';
    setBusy(false);
  }
});

function renderSummary(s) {
  const box = $('#summary');
  box.hidden = false;
  const years = Object.keys(s.years);
  const items = [
    [nf().format(s.count), tr('sum.activities')],
    [nf().format(s.photoActivities), tr('sum.photoActs')],
    [nf().format(s.photos), tr('sum.photos')],
    [years.length > 1 ? `${years[0]}–${years[years.length - 1]}` : years[0] || '–', tr('sum.period')],
  ];
  box.replaceChildren(...items.map(([v, l]) => {
    const d = document.createElement('div');
    d.className = 'stat';
    d.append(Object.assign(document.createElement('b'), { textContent: v }), Object.assign(document.createElement('span'), { textContent: l }));
    return d;
  }));
  $('#sync').textContent = tr('sync.refresh');
  $('#sync').dataset.i18n = 'sync.refresh';
}

function renderArchive() {
  const a = state.status?.archive;
  const el = $('#archive-status');
  if (!a) {
    el.textContent = '';
    return;
  }
  el.textContent = `✓ ${tr('arch.done', { d: fmtDate(a.importedAt), p: nf().format(a.photos), t: nf().format(a.tracks) })}${a.skippedVideos ? ` ${tr('arch.extra', { v: a.skippedVideos })}` : ''}`;
}

$('#archive').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  showAlert('');
  const bar = $('#archive-bar');
  bar.hidden = false;
  setBusy(true);
  try {
    // XHR a feltöltési folyamatjelzőhöz; a szerver streamelve írja lemezre.
    const { jobId } = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/archive');
      xhr.setRequestHeader('Content-Type', 'application/zip');
      xhr.setRequestHeader('X-Lang', state.lang);
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const p = Math.round((ev.loaded / ev.total) * 100);
        bar.firstElementChild.style.width = `${p}%`;
        $('#archive-status').textContent = tr('arch.uploading', { p });
      };
      xhr.onload = () => {
        let data = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch { /* */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Upload failed'));
      xhr.send(file);
    });
    const job = await runJob(jobId, (j) => {
      bar.firstElementChild.style.width = j.total ? `${Math.round((j.done / j.total) * 100)}%` : '100%';
      $('#archive-status').textContent = `${phaseLabel(j)}${j.total ? ` ${nf().format(j.done)} / ${nf().format(j.total)}` : ''}`;
    });
    state.status.archive = job.result;
    renderArchive();
    updateAll();
    await loadPhotos();
  } catch (err) {
    showAlert(err.message);
    renderArchive();
  } finally {
    bar.hidden = true;
    setBusy(false);
  }
});

// ------------------------------------------------------------------ aktivitások + válogatás

async function loadActivities() {
  state.acts = await api(`/api/activities?lang=${state.lang}`);
  if (!state.types.size) for (const a of state.acts) state.types.add(a[3]);
  $('#step-select').hidden = !state.acts.length;
  $('#step-quick').hidden = !state.acts.length;
  renderChips();
  renderPicker();
  updateAll();
}

function filtered({ ignoreExcluded = false } = {}) {
  const fd = new FormData(form);
  const from = fd.get('from');
  const to = fd.get('to');
  const onlyPhotos = fd.get('onlyPhotos') === 'on';
  const noPrivate = fd.get('excludePrivate') === 'on';
  const noCommute = fd.get('excludeCommute') === 'on';
  const noIndoor = fd.get('excludeIndoor') === 'on';
  const minM = (Number(fd.get('minKm')) || 0) * 1000;
  return state.acts.filter((a) => {
    const day = a[2].slice(0, 10);
    const flags = a[7] || 0;
    if (from && day < from) return false;
    if (to && day > to) return false;
    if (!state.types.has(a[3])) return false;
    if (onlyPhotos && !a[6]) return false;
    if (noPrivate && flags & 1) return false;
    if (noCommute && flags & 2) return false;
    if (noIndoor && flags & 4) return false;
    if (minM && a[5] > 0 && a[5] < minM) return false;
    if (!ignoreExcluded && state.excluded.has(String(a[0]))) return false;
    return true;
  });
}

function chip(label, pressed, onClick, count) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.setAttribute('aria-pressed', String(pressed));
  if (count != null) b.append(Object.assign(document.createElement('span'), { className: 'n', textContent: nf().format(count) }));
  b.addEventListener('click', onClick);
  return b;
}

function renderChips() {
  const years = new Map();
  const types = new Map();
  for (const a of state.acts) {
    const y = a[2].slice(0, 4);
    years.set(y, (years.get(y) || 0) + 1);
    const t = types.get(a[3]) || { name: a[4], n: 0 };
    t.n++;
    types.set(a[3], t);
  }
  const from = form.elements.from.value;
  const to = form.elements.to.value;
  $('#year-chips').replaceChildren(
    chip(tr('sel.all'), !from && !to, () => setRange('', '')),
    ...[...years].sort().map(([y, n]) => chip(y, from === `${y}-01-01` && to === `${y}-12-31`, () => setRange(`${y}-01-01`, `${y}-12-31`), n)),
  );
  // Gyors könyv: ugyanaz az évválasztó, a legfrissebb évvel kezdve.
  $('#quick-years').replaceChildren(
    chip(tr('sel.all'), !from && !to, () => setRange('', '')),
    ...[...years].sort().reverse().map(([y, n]) => chip(y, from === `${y}-01-01` && to === `${y}-12-31`, () => setRange(`${y}-01-01`, `${y}-12-31`), n)),
  );
  $('#type-chips').replaceChildren(...[...types].sort((a, b) => b[1].n - a[1].n).map(([type, t]) => chip(t.name, state.types.has(type), () => {
    if (state.types.has(type)) state.types.delete(type);
    else state.types.add(type);
    renderChips();
    renderPicker();
    updateAll();
  }, t.n)));
}

function setRange(from, to) {
  form.elements.from.value = from;
  form.elements.to.value = to;
  renderChips();
  renderPicker();
  updateAll();
}

let pickerTimer;
function renderPicker() {
  clearTimeout(pickerTimer);
  pickerTimer = setTimeout(() => {
    if (!$('.picker').open) return; // csak nyitott állapotban rajzolunk (1000+ sornál is gyors marad)
    const q = $('#picker-search').value.trim().toLowerCase();
    const list = filtered({ ignoreExcluded: true }).filter((a) => !q || a[1].toLowerCase().includes(q));
    const LIMIT = 1200;
    const frag = document.createDocumentFragment();
    for (const a of list.slice(-LIMIT).reverse()) {
      const row = document.createElement('label');
      row.className = 'pick';
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !state.excluded.has(String(a[0])) });
      cb.dataset.id = a[0];
      const star = Object.assign(document.createElement('button'), { type: 'button', className: 'star', textContent: '★', title: '★' });
      star.dataset.fav = a[0];
      star.setAttribute('aria-pressed', String(state.favorites.has(String(a[0]))));
      star.disabled = !a[6];
      row.append(cb,
        Object.assign(document.createElement('span'), { className: 'd', textContent: fmtDate(a[2]) }),
        Object.assign(document.createElement('span'), { className: 'nm', textContent: `${a[1]} · ${a[4]}` }),
        Object.assign(document.createElement('span'), { className: `ph${a[6] ? ' has' : ''}`, textContent: a[6] ? `${a[6]} ${tr('sum.photos')}` : '–' }),
        star);
      frag.append(row);
    }
    if (list.length > LIMIT) frag.append(Object.assign(document.createElement('p'), { className: 'muted small', textContent: tr('sel.more', { n: nf().format(list.length - LIMIT) }) }));
    $('#picker-list').replaceChildren(frag);
  }, 60);
}

// Kedvencek (★): a címkére kattintás ne kapcsolja a jelölőnégyzetet.
$('#picker-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.star');
  if (!btn) return;
  e.preventDefault();
  const id = btn.dataset.fav;
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  btn.setAttribute('aria-pressed', String(state.favorites.has(id)));
  renderFavCount();
});

function renderFavCount() {
  $('#fav-count').textContent = state.favorites.size ? tr('sel.favCount', { n: state.favorites.size }) : '';
  scheduleSave();
}

const STAT_KEYS = ['distance', 'time', 'elevation', 'pace', 'weather', 'hr', 'power', 'calories', 'high', 'kudos'];
function renderStatChips() {
  $('#stat-chips').replaceChildren(...STAT_KEYS.map((k) => chip(tr(`stat.${k}`), state.stats.has(k), () => {
    if (state.stats.has(k)) state.stats.delete(k);
    else state.stats.add(k);
    renderStatChips();
    scheduleSave();
  })));
}

// Egyetlen eseménykezelő a teljes listára (eseménydelegálás).
$('#picker-list').addEventListener('change', (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  if (e.target.checked) state.excluded.delete(id);
  else state.excluded.add(id);
  updateAll();
});
$('.picker').addEventListener('toggle', renderPicker);
$('#picker-search').addEventListener('input', renderPicker);
$('#picker-all').addEventListener('click', () => {
  for (const a of filtered({ ignoreExcluded: true })) state.excluded.delete(String(a[0]));
  renderPicker();
  updateAll();
});
$('#picker-none').addEventListener('click', () => {
  for (const a of filtered({ ignoreExcluded: true })) state.excluded.add(String(a[0]));
  renderPicker();
  updateAll();
});

// ------------------------------------------------------------------ összegzés, becslés, makett

function updateAll() {
  updateMock();
  updateFacts();
  $('#spread-opts').hidden = !form.elements.coverSpread.checked;
  scheduleSave();
}

function updateFacts() {
  if (!state.status?.loggedIn) return;
  const sel = filtered();
  const fd = new FormData(form);
  const withPhotos = sel.filter((a) => a[6]);
  const maxP = Number(fd.get('maxPhotos')) || 0;
  const exclBy = new Map();
  for (const ref of state.photoExcl) {
    const act = ref.split('/')[0];
    exclBy.set(act, (exclBy.get(act) || 0) + 1);
  }
  const photos = withPhotos.reduce((n, a) => {
    const k = Math.max(0, a[6] - (exclBy.get(String(a[0])) || 0));
    return n + (maxP ? Math.min(maxP, k) : k);
  }, 0);
  const years = new Set(sel.map((a) => a[2].slice(0, 4))).size;
  let pages = 4 + withPhotos.length + Math.ceil(Math.max(0, photos - withPhotos.length * 3) / 6);
  if (fd.get('yearPages') === 'on') pages += years * 2;
  if (fd.get('routesPage') === 'on') pages += 1;
  if (fd.get('listNoPhoto') === 'on') pages += Math.ceil((sel.length - withPhotos.length) / 60);
  if (fd.get('padToFour') === 'on') pages = Math.ceil(pages / 4) * 4;
  $('#f-acts').textContent = sel.length ? nf().format(sel.length) : '–';
  $('#f-photos').textContent = sel.length ? nf().format(photos) : '–';
  $('#f-pages').textContent = sel.length ? tr('panel.pages', { n: nf().format(pages) }) : '–';

  // API-hívások becslése: az archívum előtti aktivitásokhoz nem kell hívás.
  const archivedUntil = state.status.archive?.importedAt || '';
  const needApi = withPhotos.filter((a) => !archivedUntil || a[2] > archivedUntil);
  const perAct = 1 + (fd.get('showDescriptions') === 'on' ? 1 : 0) + (fd.get('showMaps') === 'on' && fd.get('elevation') === 'on' ? 1 : 0);
  const calls = needApi.length * perAct;
  const eta = $('#eta');
  eta.hidden = !sel.length;
  let label;
  if (calls <= 90) label = tr('panel.timeFast');
  else if (calls <= 1000) {
    const min = Math.ceil(calls / 95) * 15;
    label = min < 90 ? tr('panel.timeMin', { n: min }) : tr('panel.timeH', { n: Math.round(min / 60) });
  } else label = tr('panel.timeDays', { n: Math.ceil(calls / 950) });
  $('#eta-value').textContent = label;
  $('#eta-why').textContent = calls ? tr('panel.timeWhy', { n: nf().format(calls) }) : '';
  $('#eta-tip').hidden = calls <= 200;
  $('#build').disabled = state.busy || !sel.length;
  $('#preview').disabled = state.busy || !sel.length;
  $('#quick-build').disabled = state.busy || !sel.length;
  $('#quick-preview').disabled = state.busy || !sel.length;
  $('#quick-summary').textContent = sel.length ? tr('quick.summary', { a: nf().format(sel.length), p: nf().format(photos), pg: nf().format(pages) }) : '';
}

function updateMock() {
  const fd = new FormData(form);
  const base = state.status?.themes?.[fd.get('theme')];
  const theme = base && fd.get('useAccent') === 'on' ? { ...base, accent: fd.get('accent') } : base;
  if (theme) {
    const root = document.documentElement.style;
    root.setProperty('--accent', theme.accent);
    root.setProperty('--accent-tint', theme.tint);
    root.setProperty('--accent-deep', theme.deep);
  }
  const title = (fd.get('title') || '').trim() || 'Lap by Lap';
  $('#mock-title').textContent = title;
  const tf = fd.get('typeface');
  $('#mock-title').className = `book-title${tf === 'classic' ? '' : ` ${tf}`}`;
  const pos = fd.get('titlePos') || 'bottom';
  $('#mock-cover').dataset.pos = pos;
  $('#mock-sub').textContent = (fd.get('subtitle') || '').trim();
  const sel = state.acts.length ? filtered() : [];
  const ys = sel.map((a) => a[2].slice(0, 4)).sort();
  const range = ys.length ? (ys[0] === ys[ys.length - 1] ? ys[0] : `${ys[0]}–${ys[ys.length - 1]}`) : '';
  $('#mock-meta').textContent = [$('#user-name').textContent, range].filter(Boolean).join('  ·  ');
  const [w, h] = SIZE_MM[fd.get('pageSize')] || SIZE_MM.a4;
  const mock = $('#mock');
  mock.style.aspectRatio = `${w} / ${h}`;
  mock.style.width = w > h ? '290px' : w === h ? '240px' : '210px';
  const routes = fd.get('coverStyle') === 'routes';
  mock.classList.toggle('routes', routes);
  const cover = $('#mock-cover');
  if (!routes && state.coverUrl) {
    cover.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,.66) 100%), url("${state.coverUrl}")`;
  } else if (!routes && theme) {
    cover.style.backgroundImage = `linear-gradient(180deg, rgba(0,0,0,0) 38%, rgba(0,0,0,.66) 100%), linear-gradient(165deg, ${theme.tint} 0%, ${theme.accent} 48%, ${theme.deep} 100%)`;
  } else {
    cover.style.backgroundImage = '';
  }
}

form.addEventListener('input', (e) => {
  if (e.target.closest('#step-photos')) return; // a fotóletöltés nem része a könyv beállításainak
  if (e.target.id === 'picker-search' || e.target.type === 'file' || e.target.dataset.id) return;
  if (['from', 'to', 'onlyPhotos', 'excludePrivate', 'excludeCommute', 'excludeIndoor', 'minKm'].includes(e.target.name)) {
    renderChips();
    renderPicker();
  }
  updateAll();
});
form.addEventListener('submit', (e) => e.preventDefault());

// ------------------------------------------------------------------ borítókép

$('#cover').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { coverId } = await api('/api/cover', { method: 'POST', raw: file, headers: { 'Content-Type': file.type } });
    state.coverId = coverId;
    state.coverRef = null;
    if (state.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(state.coverUrl);
    state.coverUrl = URL.createObjectURL(file);
    markCoverTile();
    $('#cover-clear').hidden = false;
    form.elements.coverStyle.value = 'photo';
    updateAll();
  } catch (err) {
    showAlert(err.message);
  }
});
$('#cover-clear').addEventListener('click', () => {
  state.coverId = null;
  state.coverRef = null;
  if (state.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(state.coverUrl);
  state.coverUrl = null;
  markCoverTile();
  $('#cover').value = '';
  $('#cover-clear').hidden = true;
  updateAll();
});

// ------------------------------------------------------------------ feladatok

function setBusy(b) {
  state.busy = b;
  for (const id of ['#build', '#preview', '#sync', '#photos-fetch', '#quick-build', '#quick-preview']) $(id).disabled = b;
  // Hosszú munkánál értesítést kérünk (csak felhasználói kattintásra, egyszer).
  if (b && 'Notification' in window && Notification.permission === 'default' && navigator.userActivation?.isActive) {
    Notification.requestPermission().catch(() => {});
  }
  if (!b) updateFacts();
}

async function runJob(jobId, onUpdate) {
  state.jobId = jobId;
  try {
    for (;;) {
      const j = await api(`/api/jobs/${jobId}`);
      onUpdate?.(j);
      // Az előrehaladás a böngészőfülön is látszik, ha közben máshol vagy.
      document.title = `${j.total ? `${Math.round((j.done / j.total) * 100)}%` : '…'} · ${tr('meta.title')}`;
      if (j.status === 'done') {
        notifyDone(j.kind, false);
        return j;
      }
      if (j.status === 'error') {
        notifyDone(j.kind, true);
        throw new Error(j.error);
      }
      await new Promise((r) => setTimeout(r, j.waitUntil ? 2000 : 800));
    }
  } finally {
    document.title = tr('meta.title');
  }
}

/** Rendszerértesítés a kész munkáról, ha a lap épp nincs előtérben (és a felhasználó engedélyezte). */
function notifyDone(kind, error) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification('Lap by Lap', { body: tr(error ? 'notify.error' : `notify.${kind}`), icon: '/favicon.svg', tag: 'lap-by-lap' });
  } catch { /* egyes mobilböngészők csak service workerből engedik */ }
}

function countdown(until) {
  const s = Math.max(0, Math.round((until - Date.now()) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

/** A feladat aktuális lépése olvasható formában (indulás előtt „…”, sorban állásnál a hely is). */
const phaseLabel = (j) => (j.phase ? tr(`phase.${j.phase}`, { n: j.queuePos }) : '…');

function renderProgress(j) {
  $('#progress').hidden = false;
  $('#progress-phase').textContent = phaseLabel(j);
  const bar = $('#progress-bar');
  bar.parentElement.classList.toggle('indeterminate', !j.total);
  bar.style.width = j.total ? `${Math.round((j.done / j.total) * 100)}%` : '';
  $('#progress-count').textContent = j.total ? `${nf().format(j.done)} / ${nf().format(j.total)}` : '';
  const w = $('#progress-wait');
  w.hidden = !j.waitUntil;
  if (j.waitUntil) $('#progress-wait-text').textContent = tr('prog.wait', { k: tr(`wait.${j.waitKind}`), t: countdown(j.waitUntil) });
  $('#skip').disabled = j.skipApi;
}

$('#skip').addEventListener('click', async () => {
  if (state.jobId) await api(`/api/jobs/${state.jobId}/skip`, { method: 'POST' }).catch(() => {});
});

function collectOptions(preview) {
  const fd = new FormData(form);
  const on = (n) => fd.get(n) === 'on';
  return {
    preview,
    lang: fd.get('lang'),
    units: fd.get('units'),
    title: fd.get('title'),
    subtitle: fd.get('subtitle'),
    dedication: fd.get('dedication'),
    pageSize: fd.get('pageSize'),
    theme: fd.get('theme'),
    typeface: fd.get('typeface'),
    coverStyle: fd.get('coverStyle'),
    coverId: state.coverId,
    from: fd.get('from') || null,
    to: fd.get('to') || null,
    types: [...state.types],
    exclude: [...state.excluded],
    onlyPhotos: on('onlyPhotos'),
    maxPhotos: Number(fd.get('maxPhotos')) || 0,
    showMaps: on('showMaps'),
    elevation: on('elevation'),
    showDescriptions: on('showDescriptions'),
    showCaptions: on('showCaptions'),
    yearPages: on('yearPages'),
    routesPage: on('routesPage'),
    toc: on('toc'),
    layout: fd.get('layout'),
    tone: fd.get('tone'),
    accent: on('useAccent') ? fd.get('accent') : null,
    titlePos: fd.get('titlePos'),
    chapters: fd.get('chapters'),
    order: fd.get('order'),
    stats: [...state.stats],
    favorites: [...state.favorites],
    excludePhotos: [...state.photoExcl],
    weather: on('weather'),
    qr: on('qr'),
    mapPins: on('mapPins'),
    runningHeads: on('runningHeads'),
    routeColor: fd.get('routeColor'),
    afterword: fd.get('afterword'),
    notesPages: Number(fd.get('notesPages')) || 0,
    excludePrivate: on('excludePrivate'),
    excludeCommute: on('excludeCommute'),
    excludeIndoor: on('excludeIndoor'),
    minKm: Number(fd.get('minKm')) || 0,
    listNoPhoto: on('listNoPhoto'),
    privacyMeters: Number(fd.get('privacyMeters')),
    quality: fd.get('quality'),
    bleed: on('bleed'),
    cropMarks: on('cropMarks'),
    gutter: on('gutter'),
    padToFour: on('padToFour'),
    split: on('split') ? 'year' : 'none',
    coverSpread: on('coverSpread'),
    paper: fd.get('paper'),
    spineMm: Number(fd.get('spineMm')) || 0,
  };
}

async function build(preview) {
  if (state.busy) return;
  if (!state.acts.length) return showAlert(tr('panel.needSync'));
  showAlert('');
  setBusy(true);
  $('#result').hidden = true;
  try {
    const { jobId } = await api('/api/book', { method: 'POST', body: collectOptions(preview) });
    const job = await runJob(jobId, renderProgress);
    renderResult(job.result);
    if (job.result.preview) openViewer(job.result.files[0].name);
    await refreshBooks();
    await loadPhotos(); // a könyvkészítés közben letöltött fotók is elérhetők
  } catch (e) {
    showAlert(e.message);
  } finally {
    $('#progress').hidden = true;
    setBusy(false);
  }
}
$('#build').addEventListener('click', () => build(false));
$('#preview').addEventListener('click', () => build(true));

async function resumeJob(j) {
  setBusy(true);
  try {
    const job = await runJob(j.id, j.kind === 'book' || j.kind === 'preview' ? renderProgress : null);
    if (job.result?.files) renderResult(job.result);
    if (j.kind === 'sync') location.reload();
    await refreshBooks();
    await loadPhotos();
  } catch (e) {
    showAlert(e.message);
  } finally {
    $('#progress').hidden = true;
    setBusy(false);
  }
}

const bookUrl = (name, inline) => `/api/books/${encodeURIComponent(name)}${inline ? '?inline' : ''}`;
const mb = (n) => `${(n / 1e6).toFixed(n > 1e7 ? 0 : 1)} MB`;

function openViewer(name) {
  $('#viewer-frame').src = `${bookUrl(name, true)}#view=FitH`;
  $('#viewer').showModal();
}
$('#viewer').addEventListener('close', () => {
  $('#viewer-frame').src = 'about:blank';
});

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

function renderResult(r) {
  const box = $('#result');
  box.hidden = false;
  box.replaceChildren(el('h3', { textContent: r.preview ? tr('res.previewTitle') : tr('res.title') }));
  for (const f of r.files) {
    const info = f.kind === 'cover'
      ? tr('res.coverInfo', { s: f.spineMm, w: f.widthMm, h: f.heightMm })
      : `${nf().format(f.pages)} ${tr('res.pages')} · ${mb(f.size)}`;
    box.append(el('div', { className: 'file' },
      el('div', {}, el('strong', { textContent: `${f.kind === 'cover' ? tr('res.cover') : tr('res.book')}${f.label ? ` · ${f.label}` : ''}` }), el('small', { textContent: info })),
      el('div', { className: 'row' },
        el('button', { type: 'button', className: 'btn btn-small', textContent: tr('res.open'), onclick: () => openViewer(f.name) }),
        el('a', { className: 'btn btn-small btn-primary', href: bookUrl(f.name), textContent: tr('res.download') }))));
  }
  const warns = [];
  if (r.skipped) warns.push(tr('res.skipped'));
  if (r.failedPhotos) warns.push(tr('res.failed', { n: r.failedPhotos }));
  if (r.lowResCount) warns.push(`${tr('res.lowres', { n: r.lowResCount })} ${r.lowRes.slice(0, 5).map((x) => `${x.page}. (${x.dpi} DPI)`).join(', ')}`);
  if (warns.length) box.append(el('ul', { className: 'warnlist' }, ...warns.map((w) => el('li', { textContent: w }))));
  if (r.preflight && !r.preview) {
    const p = r.preflight;
    const checks = [
      [true, tr('pf.pdf', { v: p.pdfVersion })],
      [true, tr('pf.color', { c: p.outputIntent })],
      [p.bleedMm > 0, p.bleedMm > 0 ? tr('pf.bleed', { b: p.bleedMm }) : tr('pf.noBleed')],
      [true, tr('pf.dpi', { d: p.imageDpi })],
      [!p.lowResImages, p.lowResImages ? tr('pf.lowres', { n: p.lowResImages }) : tr('pf.lowresOk')],
      [p.minFontPt >= 5.5, tr('pf.font', { p: p.minFontPt })],
      [true, tr('pf.safe', { m: p.safeMarginMm })],
      [p.pagesDivisibleBy4, p.pagesDivisibleBy4 ? tr('pf.pages4') : tr('pf.pagesNo4')],
    ];
    if (r.coverSpread) checks.push([true, tr('pf.spread')]);
    box.append(el('div', { className: 'preflight' }, el('strong', { textContent: tr('pf.title') }),
      el('ul', {}, ...checks.map(([ok, label]) => el('li', { className: ok ? 'ok' : 'warn', textContent: label })))));
  }
  if (!r.preview) {
    box.append(el('div', { className: 'tips' }, el('strong', { textContent: tr('res.tips') }),
      el('ul', {}, el('li', { textContent: tr('res.tip1') }), el('li', { textContent: tr('res.tip2') }), el('li', { textContent: tr('res.tip3', { s: r.trimSize }) }))));
  }
}

// ------------------------------------------------------------------ fotók letöltése

const photoUrl = (ref, q = '') => `/api/photos/${ref.split('/').map(encodeURIComponent).join('/')}${q}`;

async function loadPhotos() {
  if (!state.status?.loggedIn) return;
  try {
    state.photos = await api('/api/photos');
  } catch {
    return;
  }
  const known = new Set(state.photos.groups.flatMap(([act, , , list]) => list.map(([pid]) => `${act}/${pid}`)));
  for (const ref of [...state.photoSel]) if (!known.has(ref)) state.photoSel.delete(ref);
  $('#step-photos').hidden = !state.acts.length;
  renderPhotoStatus();
  renderPhotoGroups();
}

function renderPhotoStatus() {
  const p = state.photos;
  if (!p) return;
  $('#photos-status').textContent = p.downloaded
    ? tr('ph.status', { d: nf().format(p.downloaded), e: nf().format(Math.max(p.expected, p.downloaded)) })
    : tr('ph.none');
  $('#photos-zip-all').disabled = !p.downloaded;
  renderBookNote();
  $('#photos-fetch').hidden = !(p.expected > p.downloaded);
  $('#photos-fetch').disabled = state.busy;
  $('#photo-browser').hidden = !p.downloaded;
  renderPhotoSel();
}

function renderPhotoSel() {
  const n = state.photoSel.size;
  $('#photos-sel-count').textContent = n ? tr('ph.selCount', { n: nf().format(n) }) : '';
  const btn = $('#photos-dl-sel');
  btn.textContent = tr('ph.dlSel', { n: nf().format(n) });
  btn.disabled = !n;
  $('#photos-out').disabled = !n;
  $('#photos-in').disabled = !n;
  for (const head of $$('#photo-groups .ph-head input')) {
    const refs = $$('.ph-tile input', head.closest('.ph-group')).map((c) => c.dataset.ref);
    const k = refs.filter((r) => state.photoSel.has(r)).length;
    head.checked = k > 0 && k === refs.length;
    head.indeterminate = k > 0 && k < refs.length;
  }
}

// A rácsot csak nyitott állapotban rajzoljuk ki; a bélyegképek lustán töltődnek.
function renderPhotoGroups() {
  if (!$('#photo-browser').open || !state.photos) return;
  const frag = document.createDocumentFragment();
  for (const [act, name, date, list] of state.photos.groups) {
    const head = el('label', { className: 'ph-head' },
      el('input', { type: 'checkbox' }),
      el('span', { className: 'd', textContent: date ? fmtDate(date) : '' }),
      el('span', { className: 'nm', textContent: name || act }),
      el('span', { className: 'n', textContent: tr('ph.group', { n: list.length }) }));
    const grid = el('div', { className: 'ph-grid' });
    list.forEach(([pid], i) => {
      const ref = `${act}/${pid}`;
      const cb = el('input', { type: 'checkbox', checked: state.photoSel.has(ref) });
      cb.dataset.ref = ref;
      cb.setAttribute('aria-label', `${name || act} · ${i + 1}`);
      const dl = el('a', { className: 'ph-act', href: photoUrl(ref, '?download'), textContent: '↓', title: tr('ph.dlOne') });
      dl.setAttribute('download', '');
      dl.setAttribute('aria-label', tr('ph.dlOne'));
      const ex = el('button', { type: 'button', className: 'ph-act ph-ex' });
      const cv = el('button', { type: 'button', className: 'ph-act ph-cv', textContent: '▣', title: tr('ph.cover') });
      cv.setAttribute('aria-label', tr('ph.cover'));
      ex.dataset.ref = ref;
      cv.dataset.ref = ref;
      const tile = el('label', { className: 'ph-tile' }, cb, el('img', { src: photoUrl(ref, '?thumb'), alt: '', loading: 'lazy', decoding: 'async' }),
        el('span', { className: 'ph-badge' }), el('span', { className: 'ph-actions' }, dl, ex, cv));
      tile.dataset.ref = ref;
      paintTile(tile);
      grid.append(tile);
    });
    frag.append(el('div', { className: 'ph-group' }, head, grid));
  }
  $('#photo-groups').replaceChildren(frag);
  renderPhotoSel();
}

/** Egy csempe állapota: kimarad-e a könyvből, ez-e a borító. */
function paintTile(tile) {
  const ref = tile.dataset.ref;
  const out = state.photoExcl.has(ref);
  const cover = state.coverRef === ref;
  tile.classList.toggle('out', out);
  tile.classList.toggle('is-cover', cover);
  $('.ph-badge', tile).textContent = cover ? tr('ph.isCover') : out ? tr('ph.outBadge') : '';
  const ex = $('.ph-ex', tile);
  ex.textContent = out ? '↺' : '⊘';
  ex.title = tr(out ? 'ph.in' : 'ph.out');
  ex.setAttribute('aria-label', ex.title);
  ex.setAttribute('aria-pressed', String(out));
}

function markCoverTile() {
  for (const t of $$('#photo-groups .ph-tile')) paintTile(t);
}

function renderBookNote() {
  $('#photos-book-note').textContent = state.photoExcl.size ? tr('ph.bookNote', { n: nf().format(state.photoExcl.size) }) : '';
}

function setPhotosOut(refs, out) {
  for (const ref of refs) {
    if (out) state.photoExcl.add(ref);
    else state.photoExcl.delete(ref);
  }
  const set = new Set(refs);
  for (const t of $$('#photo-groups .ph-tile')) if (set.has(t.dataset.ref)) paintTile(t);
  renderBookNote();
  updateAll(); // becslés frissítése + mentés
}

async function setCoverFromPhoto(ref) {
  try {
    const { coverId } = await api('/api/cover/photo', { method: 'POST', body: { ref } });
    if (state.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(state.coverUrl);
    state.coverId = coverId;
    state.coverRef = ref;
    state.coverUrl = `/api/cover/${coverId}`;
    $('#cover-clear').hidden = false;
    form.elements.coverStyle.value = 'photo';
    markCoverTile();
    $('#photos-book-note').textContent = tr('ph.coverSet');
    setTimeout(renderBookNote, 2500);
    updateAll();
  } catch (e) {
    showAlert(e.message);
  }
}

// Csempe-gombok (kihagyás, borító); a letöltés sima link.
$('#photo-groups').addEventListener('click', (e) => {
  const b = e.target.closest('button.ph-act');
  if (!b) return;
  e.preventDefault();
  const ref = b.dataset.ref;
  if (b.classList.contains('ph-ex')) setPhotosOut([ref], !state.photoExcl.has(ref));
  else if (b.classList.contains('ph-cv')) setCoverFromPhoto(ref);
});
$('#photos-out').addEventListener('click', () => setPhotosOut([...state.photoSel], true));
$('#photos-in').addEventListener('click', () => setPhotosOut([...state.photoSel], false));

$('#photo-browser').addEventListener('toggle', renderPhotoGroups);
$('#photo-groups').addEventListener('change', (e) => {
  const cb = e.target;
  if (cb.dataset.ref) {
    if (cb.checked) state.photoSel.add(cb.dataset.ref);
    else state.photoSel.delete(cb.dataset.ref);
  } else if (cb.closest('.ph-head')) { // egy aktivitás összes fotója
    for (const c of $$('.ph-tile input', cb.closest('.ph-group'))) {
      c.checked = cb.checked;
      if (cb.checked) state.photoSel.add(c.dataset.ref);
      else state.photoSel.delete(c.dataset.ref);
    }
  }
  renderPhotoSel();
});

function setAllPhotos(on) {
  state.photoSel.clear();
  if (on) for (const [act, , , list] of state.photos?.groups || []) for (const [pid] of list) state.photoSel.add(`${act}/${pid}`);
  for (const c of $$('#photo-groups .ph-tile input')) c.checked = on;
  renderPhotoSel();
}
$('#photos-all').addEventListener('click', () => setAllPhotos(true));
$('#photos-none').addEventListener('click', () => setAllPhotos(false));

// Egy fotó → közvetlen letöltés; több → ZIP. Hagyományos űrlap-POST, hogy a böngésző streamelve mentse (nagy ZIP-nél is).
function downloadPhotos(refs) {
  if (refs?.length === 1) {
    const a = el('a', { href: photoUrl(refs[0], '?download') });
    a.setAttribute('download', '');
    document.body.append(a);
    a.click();
    a.remove();
    return;
  }
  const f = $('#photo-dl');
  f.elements.ids.value = refs ? refs.join('\n') : '';
  f.elements.all.value = refs ? '' : '1';
  f.submit();
}
$('#photos-dl-sel').addEventListener('click', () => downloadPhotos([...state.photoSel]));
$('#photos-zip-all').addEventListener('click', () => downloadPhotos(null));

$('#photos-fetch').addEventListener('click', async () => {
  if (state.busy) return;
  showAlert('');
  setBusy(true);
  const bar = $('#photos-bar');
  bar.hidden = false;
  try {
    const { jobId } = await api('/api/photos/fetch', { method: 'POST' });
    const job = await runJob(jobId, (j) => {
      bar.firstElementChild.style.width = j.total ? `${Math.round((j.done / j.total) * 100)}%` : '100%';
      const wait = j.waitUntil ? ` · ${tr('prog.wait', { k: tr(`wait.${j.waitKind}`), t: countdown(j.waitUntil) })}` : '';
      $('#photos-status').textContent = `${phaseLabel(j)}${j.total ? ` ${nf().format(j.done)} / ${nf().format(j.total)}` : ''}${wait}`;
    });
    await loadPhotos();
    const r = job.result;
    const warns = [r.skipped && tr('res.skipped'), r.failedPhotos && tr('res.failed', { n: r.failedPhotos })].filter(Boolean);
    $('#photos-status').textContent = [tr('ph.fetchDone', { d: nf().format(r.downloaded) }), ...warns].join(' ');
  } catch (e) {
    showAlert(e.message);
    renderPhotoStatus();
  } finally {
    bar.hidden = true;
    setBusy(false);
  }
});


// ------------------------------------------------------------------ gyors mód + automatikusan mentett beállítások

function renderAdvanced() {
  document.body.classList.toggle('simple', !state.advanced);
  const b = $('#adv-toggle');
  if (!b) return;
  b.textContent = tr(state.advanced ? 'quick.less' : 'quick.more');
  b.setAttribute('aria-expanded', String(state.advanced));
}
$('#adv-toggle').addEventListener('click', () => {
  state.advanced = !state.advanced;
  renderAdvanced();
  scheduleSave();
  if (state.advanced) $('#step-select').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#quick-build').addEventListener('click', () => build(false));
$('#quick-preview').addEventListener('click', () => build(true));

const SETTINGS_SKIP = new Set(['lang']);

function collectSettings() {
  const values = {};
  for (const e of form.elements) {
    if (!e.name || SETTINGS_SKIP.has(e.name) || e.type === 'file' || e.closest('#step-photos')) continue;
    if (e.type === 'checkbox') values[e.name] = e.checked;
    else if (e.type === 'radio') {
      if (e.checked) values[e.name] = e.value;
    } else values[e.name] = e.value;
  }
  const allTypes = new Set(state.acts.map((a) => a[3]));
  return {
    v: 1,
    form: values,
    typesOff: [...allTypes].filter((t) => !state.types.has(t)),
    excluded: [...state.excluded],
    favorites: [...state.favorites],
    stats: [...state.stats],
    photoExcl: [...state.photoExcl],
    coverId: state.coverId,
    coverRef: state.coverRef,
    advanced: state.advanced,
  };
}

function applyFormSettings(saved) {
  const v = saved?.form || {};
  for (const e of form.elements) {
    if (!e.name || !(e.name in v) || SETTINGS_SKIP.has(e.name) || e.type === 'file') continue;
    if (e.type === 'checkbox') e.checked = Boolean(v[e.name]);
    else if (e.type === 'radio') e.checked = e.value === v[e.name];
    else e.value = v[e.name];
  }
  const set = (k) => (Array.isArray(saved?.[k]) ? new Set(saved[k].map(String)) : null);
  state.excluded = set('excluded') || state.excluded;
  state.favorites = set('favorites') || state.favorites;
  state.stats = set('stats') || state.stats;
  state.photoExcl = set('photoExcl') || state.photoExcl;
  if (/^cover-[a-f0-9]{16}\.jpg$/.test(saved?.coverId || '')) {
    state.coverId = saved.coverId;
    state.coverRef = saved.coverRef || null;
    state.coverUrl = `/api/cover/${saved.coverId}`;
    $('#cover-clear').hidden = false;
  }
  state.advanced = Boolean(saved?.advanced);
}

function applyTypeSettings(saved) {
  if (Array.isArray(saved?.typesOff)) for (const t of saved.typesOff) state.types.delete(t);
}

let saveTimer;
function scheduleSave() {
  if (!state.settingsReady) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api('/api/settings', { method: 'PUT', body: collectSettings() });
      const flag = $('#save-state');
      flag.textContent = tr('quick.saved');
      flag.classList.add('on');
      clearTimeout(flag._t);
      flag._t = setTimeout(() => flag.classList.remove('on'), 1800);
    } catch { /* a következő változtatásnál újra próbáljuk */ }
  }, 700);
}

// ------------------------------------------------------------------ korábbi könyvek

async function refreshBooks() {
  state.status.books = await api('/api/books');
  renderBooks();
}

function renderBooks() {
  const list = $('#books');
  const books = state.status?.books || [];
  if (!books.length) {
    list.replaceChildren(el('li', { className: 'muted', textContent: tr('books.empty') }));
    return;
  }
  list.replaceChildren(...books.slice(0, 30).map((b) => el('li', {},
    el('a', { href: bookUrl(b.name), textContent: b.name, title: b.name }),
    el('small', { textContent: mb(b.size) }),
    el('button', {
      type: 'button', className: 'link', textContent: tr('books.delete'),
      onclick: async () => {
        await api(bookUrl(b.name), { method: 'DELETE' });
        await refreshBooks();
      },
    }))));
}

// ------------------------------------------------------------------ fiók

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/';
});
$('#forget').addEventListener('click', async () => {
  if (!confirm(tr('confirm.forget'))) return;
  try {
    await api('/api/forget', { method: 'POST' });
    location.href = '/';
  } catch (e) {
    showAlert(e.message);
  }
});
for (const b of $$('.lang button')) b.addEventListener('click', () => setLang(b.dataset.lang));

init().catch((e) => {
  document.documentElement.classList.remove('is-loading');
  showAlert(e.message);
});
