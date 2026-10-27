/* MyTurn demo — page chrome: explainer, scenario controls, optional ticker. */
(function () {
  'use strict';
  const MT = window.MT, S = MT.store, t = (k, p) => MT.t(k, p), esc = MT.esc;
  const SCEN = ['normal', 'missed', 'late'];
  let timer = null;

  function controls() {
    const st = S.get();
    return '<div class="ctl-group"><span class="ctl-label">' + esc(t('ctl.scenario')) + '</span><div class="seg pills" role="group">' +
      SCEN.map(s => '<button data-a="scen" data-v="' + s + '" class="' + (st.scenario === s ? 'on' : '') + '" aria-pressed="' + (st.scenario === s) + '">' + esc(t('scen.' + s)) + '</button>').join('') + '</div></div>' +
      '<div class="ctl-group"><button class="btn small ghost-d" data-a="reset">' + esc(t('ctl.reset')) + '</button>' +
      '<button class="btn small ghost-d" data-a="step">' + esc(t('ctl.step')) + '</button></div>' +
      '<div class="ctl-group"><label class="switch"><input type="checkbox" data-i="ticker" ' + (st.ticker ? 'checked' : '') + '><span class="knob"></span><span>' + esc(t('ctl.ticker')) + ' <em>' + esc(t(st.ticker ? 'ctl.on' : 'ctl.paused')) + '</em></span></label>' +
      '<label class="switch"><input type="checkbox" data-i="offline" ' + (!st.net ? 'checked' : '') + '><span class="knob"></span><span>' + esc(t('ctl.offline')) + '</span></label></div>';
  }
  const ACT = { normal: ['p', 's', 's', 'p', 's', 'ps', 'p'], missed: ['p', 's', 's', 's', 'p', 's', 's'], late: ['s', 's', 's', 's', 's', 'p'] };
  let walkOpen = true;
  function script() {
    const st = S.get(), acts = ACT[st.scenario];
    if (!acts) return '';        // a scenario without a scripted demo (production starts as 'empty'): no walkthrough, but the rest of the page must still initialise
    let h = '<details class="walk"' + (walkOpen ? ' open' : '') + '><summary><span>' + esc(t('scen.' + st.scenario)) + ' · ' + esc(t('script.title')) + '</span><i aria-hidden="true"></i></summary><ol>';
    acts.forEach((a, i) => { h += '<li><span class="actor a-' + a + '">' + esc(t('actor.' + a)) + '</span><span class="txt">' + esc(t('script.' + st.scenario + '.' + (i + 1))) + '</span></li>'; });
    return h + '</ol><p class="creds">' + esc(t('script.creds')) + '</p></details>';
  }
  /* The controls and walkthrough are built once per language/scenario and then updated in place,
     so pills, switches and the walkthrough keep their DOM nodes and can transition smoothly. */
  let ctlLang = null, scriptKey = null, lastScen = null;
  function syncControls(st) {
    document.querySelectorAll('#ctl [data-a="scen"]').forEach(b => { const on = b.dataset.v === st.scenario; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    const tk = document.querySelector('#ctl [data-i="ticker"]'), of = document.querySelector('#ctl [data-i="offline"]');
    if (tk) { tk.checked = !!st.ticker; const em = tk.closest('label').querySelector('em'); if (em) em.textContent = t(st.ticker ? 'ctl.on' : 'ctl.paused'); }
    if (of) of.checked = !st.net;
  }
  function chrome() {
    const st = S.get();
    document.querySelectorAll('[data-t]').forEach(n => { n.textContent = t(n.dataset.t); });
    if (ctlLang !== MT.lang) { document.getElementById('ctl').innerHTML = controls(); ctlLang = MT.lang; }
    syncControls(st);
    const sk = st.scenario + '|' + MT.lang;
    if (scriptKey !== sk) {
      const host = document.getElementById('script'), first = scriptKey === null, scenChanged = lastScen !== null && lastScen !== st.scenario;
      host.innerHTML = script(); scriptKey = sk;
      if (!first && scenChanged && !MT.reduced()) host.querySelectorAll('.walk li').forEach((li, i) => { li.style.setProperty('--d', (i * 35) + 'ms'); li.classList.add('mt-in'); });
    }
    lastScen = st.scenario;
    const sl = document.getElementById('site-lang'); if (sl.dataset.l !== MT.lang) { sl.innerHTML = MT.langToggle(); sl.dataset.l = MT.lang; }
    else sl.querySelectorAll('button').forEach(b => { const on = b.dataset.v === MT.lang; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    document.title = t('site.title');
    const w = document.getElementById('wm'); if (w && !w.innerHTML) w.innerHTML = MT.wordmark(24);
    const w2 = document.getElementById('wm2'); if (w2 && !w2.innerHTML) w2.innerHTML = MT.wordmark(22);
  }
  // Scroll reveals: tag blocks once, fade/slide them in the first time they enter the viewport.
  function initReveal() {
    const sel = '.sec-label, .sec h2, .sec-lead, .rows li, .route li, .ben-cols > div, .aside-note, .stage-head > *, #ctl, .frame-col, .demo-aside, .foot-grid > div';
    const els = [...document.querySelectorAll(sel)];
    const groups = new Map();
    els.forEach(el => { const g = el.parentElement; const i = groups.get(g) || 0; groups.set(g, i + 1); el.classList.add('reveal'); el.style.setProperty('--d', Math.min(i, 5) * 70 + 'ms'); });
    if (!('IntersectionObserver' in window) || MT.reduced()) { els.forEach(el => el.classList.add('in')); return; }
    const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    els.forEach(el => io.observe(el));
  }
  // Display scale of the 393 x 873 devices: as large as comfortably fits the viewport, never below legibility.
  function fit() {
    const stage = document.querySelector('.stage'), grid = document.querySelector('.demo-grid'); if (!stage || !grid) return;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const w = grid.clientWidth - (cols > 1 ? 320 + 40 : 0);            // space left for the devices
    const side = (w - 36) / (2 * 409), hcap = Math.max(.78, Math.min(.9, (window.innerHeight - 61 - 150 - 50) / 889));
    const s = side >= .7 ? Math.min(hcap, side) : Math.min(.95, w / 409);  // side by side if they fit, else stacked
    stage.style.setProperty('--s', s.toFixed(3));
  }
  function sync() {
    const on = S.get().ticker;
    if (on && !timer) timer = setInterval(() => S.tick(), 4000);
    if (!on && timer) { clearInterval(timer); timer = null; }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // With the shared server, scenario / reset / step controls change shared data, so the server only accepts them from a signed-in admin.
    const can = () => !S.canControl || S.canControl();
    const denied = () => { const b = document.getElementById('step-msg'); if (b) { b.textContent = t('ctl.adminOnly'); setTimeout(() => { b.textContent = ''; }, 3500); } };
    const H = {
      lang: v => MT.setLang(v),
      scen: v => { if (can()) S.reset(v); else denied(); },
      reset: () => { if (can()) S.reset(S.get().scenario); else denied(); },
      step: () => { if (!can()) return denied(); if (!S.tick()) { const b = document.getElementById('step-msg'); if (b) { b.textContent = t('ctl.nothing'); setTimeout(() => { b.textContent = ''; }, 2500); } } },
      input: (n, v) => { if (n === 'ticker') S.setTicker(v); else if (n === 'offline') S.setNet(!v); }
    };
    document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('walk')) { walkOpen = e.target.open; if (walkOpen) MT.cue(e.target.querySelector('ol'), 'mt-in', 300); } }, true);
    MT.bind(document.getElementById('ctl'), H);
    MT.bind(document.getElementById('site-lang'), H);
    MT.rerenders.push(chrome); S.subscribe(() => { chrome(); sync(); });
    chrome(); sync(); fit(); initReveal();
    window.addEventListener('resize', fit);
    if (window.ResizeObserver) new ResizeObserver(fit).observe(document.querySelector('.demo-grid'));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  });
})();
