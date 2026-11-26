// Lapozható könyvnézet (függőség nélkül): 3D lapfordítás oldalpárokkal, mobilon egyoldalas nézet.
// Vezérlés: kattintás a lap jobb/bal felére, nyilak, ← → billentyűk, húzás, csúszka.

export function createFlipbook(root, { src, pages, ratio, label }) {
  root.classList.add('fb');
  root.tabIndex = 0;
  root.innerHTML = `
    <div class="fb-viewport">
      <div class="fb-stage">
        <div class="fb-book">
          <div class="fb-page fb-left"><img alt="" draggable="false"></div>
          <div class="fb-page fb-right"><img alt="" draggable="false"></div>
          <div class="fb-leaf"><div class="fb-face fb-front"><img alt="" draggable="false"></div><div class="fb-face fb-back"><img alt="" draggable="false"></div></div>
          <div class="fb-spine"></div>
        </div>
      </div>
    </div>
    <div class="fb-controls">
      <button type="button" class="fb-btn fb-prev" aria-label="prev">‹</button>
      <input type="range" class="fb-range" min="0" value="0" aria-label="page">
      <span class="fb-label" aria-live="polite"></span>
      <button type="button" class="fb-btn fb-next" aria-label="next">›</button>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const book = $('.fb-book');
  const L = $('.fb-left img');
  const R = $('.fb-right img');
  const leaf = $('.fb-leaf');
  const F = $('.fb-front img');
  const B = $('.fb-back img');
  const range = $('.fb-range');
  root.style.setProperty('--fb-ratio', ratio);

  let single = false;
  let pos = 0; // oldalpár-index (kétoldalas nézet) vagy oldalindex 0-tól (egyoldalas)
  let busy = false;
  const url = (n) => (n >= 1 && n <= pages ? src(n) : '');
  const set = (img, n) => {
    const u = url(n);
    img.parentElement.classList.toggle('empty', !u);
    if (u) img.src = u;
    else img.removeAttribute('src');
  };
  const spreadPages = (sp) => [sp * 2, sp * 2 + 1]; // 0. pár: [–, 1] (borító)
  const maxPos = () => (single ? pages - 1 : Math.floor(pages / 2));
  const preload = (ns) => ns.forEach((n) => { if (url(n)) new Image().src = url(n); });

  function layout() {
    const wasSingle = single;
    single = root.clientWidth < 720;
    if (wasSingle !== single) pos = single ? Math.max(0, pos * 2 - 1) : Math.floor((pos + 1) / 2);
    root.classList.toggle('fb-single', single);
    range.max = String(maxPos());
    render();
  }

  function render() {
    leaf.hidden = true;
    if (single) {
      set(R, pos + 1);
      L.parentElement.classList.add('empty');
      book.style.setProperty('--shift', '0%');
    } else {
      const [a, b] = spreadPages(pos);
      set(L, a);
      set(R, b);
      // Zárt könyv (borító / hátlap) középre kerül.
      book.style.setProperty('--shift', !url(a) ? '-25%' : !url(b) ? '25%' : '0%');
    }
    range.value = String(pos);
    const [a, b] = single ? [pos + 1, pos + 1] : spreadPages(pos);
    const vis = [a, b].filter((n) => url(n));
    $('.fb-label').textContent = label(vis[0], vis[vis.length - 1], pages);
    $('.fb-prev').disabled = pos <= 0;
    $('.fb-next').disabled = pos >= maxPos();
    preload(single ? [pos, pos + 2] : [...spreadPages(pos + 1), ...spreadPages(pos - 1)]);
  }

  function go(dir) {
    const target = pos + dir;
    if (busy || target < 0 || target > maxPos()) return;
    if (single || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      pos = target;
      root.classList.add('fb-fade');
      render();
      setTimeout(() => root.classList.remove('fb-fade'), 220);
      return;
    }
    busy = true;
    const [oa, ob] = spreadPages(pos);
    const [na, nb] = spreadPages(target);
    leaf.hidden = false;
    leaf.style.transition = 'none';
    if (dir > 0) {
      set(F, ob);
      set(B, na);
      set(R, nb);
      leaf.style.transform = 'rotateY(0deg)';
    } else {
      set(F, nb);
      set(B, oa);
      set(L, na);
      leaf.style.transform = 'rotateY(-180deg)';
    }
    book.style.setProperty('--shift', !url(na) ? '-25%' : !url(nb) ? '25%' : '0%');
    leaf.getBoundingClientRect(); // reflow
    leaf.style.transition = '';
    leaf.style.transform = dir > 0 ? 'rotateY(-180deg)' : 'rotateY(0deg)';
    const done = () => {
      leaf.removeEventListener('transitionend', done);
      pos = target;
      busy = false;
      render();
    };
    leaf.addEventListener('transitionend', done);
    setTimeout(() => busy && done(), 1200); // biztonsági háló
  }

  $('.fb-prev').addEventListener('click', () => go(-1));
  $('.fb-next').addEventListener('click', () => go(1));
  range.addEventListener('input', () => {
    pos = Number(range.value);
    render();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { go(1); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { go(-1); e.preventDefault(); }
  });
  // Kattintás a lapra: jobb fele előre, bal fele vissza; húzás (swipe) ugyanígy.
  let startX = null;
  const stage = $('.fb-stage');
  stage.addEventListener('pointerdown', (e) => { startX = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 40) return go(dx < 0 ? 1 : -1);
    const r = stage.getBoundingClientRect();
    go(e.clientX - r.left > r.width / 2 ? 1 : -1);
  });
  new ResizeObserver(layout).observe(root);
  layout();
  return {
    relabel() { render(); },
    setSource(nextSrc, nextPages) {
      src = nextSrc;
      pages = nextPages;
      pos = Math.min(pos, maxPos());
      range.max = String(maxPos());
      render();
    },
  };
}
