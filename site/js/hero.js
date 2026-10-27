/* MyTurn demo — hero illustration: one patient ticket and one staff list moving through the same
   queue states. It is a self-contained loop (not the live demo state) and uses the same chips,
   path and motion cues as the phones. Autoplay can be paused; with reduced motion it does not
   autoplay and the button steps to the next state instead. */
(function () {
  'use strict';
  const MT = window.MT, t = (k, p) => MT.t(k, p), esc = MT.esc;
  const root = document.getElementById('hero-viz'), btn = document.getElementById('hv-btn');
  if (!root || !btn) return;

  // K 044 is the patient. K 043 is in service ahead; K 045 waits behind.
  // path: lane = dashed return lane; cur = amber step (-1 = none); fill = completed segments.
  const STATES = [
    { me: 'reg',    k43: 'svc',  path: { lane: false, cur: 0, fill: 0, done: 0 } },
    { me: 'wait',   k43: 'svc',  path: { lane: false, cur: 2, fill: 2, done: 2 } },
    { me: 'called', k43: 'done', path: { lane: false, cur: 3, fill: 3, done: 3 } },
    { me: 'missed', k43: 'done', path: { lane: true,  cur: 0, fill: 0, done: 0 } },
    { me: 'retreq', k43: 'done', path: { lane: true,  cur: 1, fill: 1, done: 1 } },
    { me: 'retq',   k43: 'done', path: { lane: true,  cur: 2, fill: 2, done: 2 } },
    { me: 'svc',    k43: 'done', path: { lane: false, cur: -1, fill: 3, done: 4 } },
    { me: 'done',   k43: 'done', path: { lane: false, cur: -1, fill: 3, done: 4 } }
  ];
  const CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const SYNC = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M7 4L3.5 7.5M7 4l3.5 3.5M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5"/></svg>';
  let idx = 1, timer = null, paused = false, visible = true, built = false;

  const chip = (st, staff, id) => MT.chip(st, st === 'called' && staff ? 'st.calledStaff' : null, '', ' id="' + id + '"');
  function build() {
    const names = ['v.t1', 'v.t2', 'v.t3', 'v.t4'];
    root.innerHTML =
      '<p class="art-label mono light">' + esc(t('hero.patientView')) + '</p>' +
      '<div class="ticket" id="hv-ticket"><div class="tk-top"><div><span class="lab">' + esc(t('v.yourToken')) + '</span><div class="token big">K 044</div></div><span id="hv-pchip"></span></div>' +
      '<div class="tk-div"></div><div class="tk-bot"><div class="main"><b>' + esc(t('hero.sess1')) + '</b><span>' + esc(t('hero.sess2')) + '</span></div></div></div>' +
      '<ol class="path track" id="hv-path">' + names.map(k => '<li><span class="dot">' + CHECK + '</span><span class="lb">' + esc(t(k)) + '</span></li>').join('') + '</ol>' +
      '<div class="sync-link"><span class="line"></span><span class="sync-pill" id="hv-sync">' + SYNC + '<span>' + esc(t('hero.sameQueue')) + '</span></span><span class="line"></span></div>' +
      '<p class="art-label mono light">' + esc(t('hero.staffView')) + '</p>' +
      '<ul class="mini-q"><li id="hv-r43"><b>K 043</b><span class="nm">' + esc(MT.nm('Sita D.')) + '</span><span id="hv-c43"></span></li>' +
      '<li class="you" id="hv-r44"><b>K 044</b><span class="nm">' + esc(MT.nm('Asha V.')) + '</span><span id="hv-c44"></span></li>' +
      '<li id="hv-r45"><b>K 045</b><span class="nm">' + esc(MT.nm('Imran K.')) + '</span><span id="hv-c45"></span></li></ul>';
    built = true;
  }

  let prev = null;
  function apply(animate) {
    const s = STATES[idx], $ = id => document.getElementById(id);
    $('hv-pchip').innerHTML = chip(s.me, false, 'hv-pc');
    $('hv-c44').innerHTML = chip(s.me, true, 'hv-c44c');
    $('hv-c43').innerHTML = chip(s.k43, true, 'hv-c43c');
    $('hv-c45').innerHTML = chip('wait', true, 'hv-c45c');
    // path: one continuous track; the amber dot and the filled segment move together
    const p = $('hv-path'), lane = s.path.lane;
    p.classList.toggle('lane', lane);
    p.style.setProperty('--p', s.path.fill);
    const keys = lane ? ['v.l1', 'v.l2', 'v.l3', 'v.l4'] : ['v.t1', 'v.t2', 'v.t3', 'v.t4'];
    [...p.children].forEach((li, i) => {
      li.className = i === s.path.cur ? 'cur' : (i < s.path.done || s.path.done === 4) && i !== s.path.cur ? 'done' : '';
      const lb = li.querySelector('.lb'), tx = t(keys[i]); if (lb.textContent !== tx) lb.textContent = tx;
    });
    if (animate && prev !== null && !MT.reduced()) {
      const changed = prev;
      MT.cue($('hv-pc'), 'mt-pop', 400); MT.cue($('hv-c44c'), 'mt-pop', 400); MT.cue($('hv-r44'), 'mt-flash', 1600);
      if (changed.k43 !== s.k43) { MT.cue($('hv-c43c'), 'mt-pop', 400); MT.cue($('hv-r43'), 'mt-flash', 1600); }
      if (changed.path.lane !== lane) p.querySelectorAll('.lb').forEach(l => MT.cue(l, 'mt-swap', 400));
      MT.cue($('hv-sync'), 'mt-pop', 400);
      if (changed.me === 'wait' && s.me === 'called') MT.cue($('hv-ticket'), 'mt-flash', 1600);
    }
    prev = { me: s.me, k43: s.k43, path: s.path };
  }
  function label() {
    btn.textContent = MT.reduced() ? t('hero.step') : paused ? t('hero.play') : t('hero.pause');
    btn.setAttribute('aria-pressed', MT.reduced() ? 'false' : String(paused));
  }
  const next = () => { idx = (idx + 1) % STATES.length; apply(true); };
  function schedule() {
    clearInterval(timer); timer = null;
    if (!paused && visible && !document.hidden && !MT.reduced()) timer = setInterval(next, 2600);
  }

  MT.hero = { next, index: () => idx, count: STATES.length };
  btn.addEventListener('click', () => { if (MT.reduced()) { next(); return; } paused = !paused; label(); schedule(); });
  document.addEventListener('visibilitychange', schedule);
  if ('IntersectionObserver' in window) new IntersectionObserver(es => { visible = es[0].isIntersecting; schedule(); }, { threshold: 0.2 }).observe(root);

  function render() { build(); prev = null; apply(false); label(); }
  document.addEventListener('DOMContentLoaded', () => {
    render(); schedule();
    setTimeout(() => { const a = root.closest('.hero-art'); if (a) a.classList.add('live'); }, 1800);  // intro entrance finished
    MT.rerenders.push(render);                                                                       // language switch
  });
})();
