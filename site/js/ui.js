/* MyTurn demo — shared UI helpers: language, escaping, icons, logo, rendering. */
(function () {
  'use strict';
  const MT = (window.MT = window.MT || {});

  MT.lang = 'en';
  try { const l = localStorage.getItem('myturn.lang'); if (l === 'hi' || l === 'en') MT.lang = l; } catch (e) {}
  document.documentElement.lang = MT.lang;

  MT.t = function (k, p) {
    const d = MT.DICT[k];
    let s = d ? d[MT.lang === 'hi' ? 1 : 0] : k;
    if (p) s = s.replace(/\{(\w+)\}/g, (m, n) => (p[n] !== undefined ? p[n] : m));
    return s;
  };
  MT.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  MT.loc = o => (MT.lang === 'hi' && o.hi) ? o.hi : o.en;
  MT.nm = n => (MT.lang === 'hi' && MT.store.HI_NAMES[n]) || n;
  // Staff view shows first name + last initial only (privacy default from the brand board).
  MT.short = name => {
    const p = String(name).trim().split(/\s+/);
    return p.length > 1 ? p[0] + ' ' + p[p.length - 1][0].toUpperCase() + '.' : p[0];
  };
  MT.age = yob => (yob ? new Date().getFullYear() - yob : null);
  MT.time = ts => { const d = new Date(ts); const h = d.getHours() % 12 || 12; return h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + (d.getHours() < 12 ? 'AM' : 'PM'); };

  MT.rerenders = [];
  MT.rerender = () => MT.rerenders.forEach(f => f());
  MT.setLang = l => {
    MT.lang = l;
    try { localStorage.setItem('myturn.lang', l); } catch (e) {}
    document.documentElement.lang = l;
    MT.rerender();
    if (!reduced()) { document.body.classList.add('mt-lang'); clearTimeout(MT._lt); MT._lt = setTimeout(() => document.body.classList.remove('mt-lang'), 300); }
  };

  const I = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.01"/>',
    warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4.5M12 17.5v.01"/>',
    x: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>',
    users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 5.2a3.2 3.2 0 010 5.8M18 14.3c1.9.8 3 2.7 3 5.7"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    out: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
    up: '<path d="M6 15l6-6 6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
    check2: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    wifi: '<path d="M3 9a14 14 0 0118 0M6 12.5a9.5 9.5 0 0112 0M9.2 16a5 5 0 015.6 0M12 19.5v.01"/>'
  };
  MT.icon = (n, s) => '<svg class="ic" width="' + (s || 20) + '" height="' + (s || 20) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[n] + '</svg>';

  // Brand mark: rounded "m" path + amber dot (from the approved brand board).
  MT.logo = (size, ink, dot) => '<svg class="logo-m" width="' + size + '" height="' + size + '" viewBox="22 30 84 70" aria-hidden="true"><path d="M36 84 V54 a14 14 0 0 1 28 0 V84 M64 54 a14 14 0 0 1 28 0 V66" fill="none" stroke="' + (ink || 'currentColor') + '" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><circle cx="92" cy="84" r="9" fill="' + (dot || '#E8A33D') + '"/></svg>';
  MT.wordmark = (size, ink) => '<span class="wordmark" style="font-size:' + size + 'px">' + MT.logo(Math.round(size * 1.15), ink) + '<span>MyTurn</span></span>';

  // short=true gives the compact EN / हिं labels used in dark staff headers.
  MT.langToggle = short => '<div class="seg lang" role="group" aria-label="Language"><button data-a="lang" data-v="en" class="' + (MT.lang === 'en' ? 'on' : '') + '" aria-pressed="' + (MT.lang === 'en') + '">' + (short ? 'EN' : 'English') + '</button><button data-a="lang" data-v="hi" class="' + (MT.lang === 'hi' ? 'on' : '') + '" aria-pressed="' + (MT.lang === 'hi') + '" lang="hi">' + (short ? 'हिं' : 'हिन्दी') + '</button></div>';

  // Status chips shared by both frames so wording stays identical. Every status = glyph + word + colour.
  const CHIP = { reg: ['info', 'i'], wait: ['info', 'i'], called: ['attn', '!'], svc: ['live', '▶'], done: ['ok', '✓'], missed: ['warn', '!'], retreq: ['attn', '!'], retq: ['info', 'i'], declined: ['neutral', '—'], cancelled: ['neutral', '—'], noshow: ['neutral', '—'] };
  MT.chip = (st, labelKey, extra, attrs) => { const c = CHIP[st] || ['info', 'i']; return '<span class="chip ' + c[0] + (extra ? ' ' + extra : '') + '"' + (attrs || '') + '><i aria-hidden="true">' + c[1] + '</i><span>' + MT.esc(MT.t(labelKey || 'st.' + st)) + '</span></span>'; };
  MT.chipRaw = (cls, glyph, text) => '<span class="chip ' + cls + '"><i aria-hidden="true">' + glyph + '</i><span>' + MT.esc(text) + '</span></span>';
  MT.initials = name => { const p = String(name).trim().split(/\s+/); return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); };
  MT.sb = dark => '<div class="sb' + (dark ? ' dark' : '') + '" aria-hidden="true"><span>9:41</span><span class="cam"></span><span class="sys"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2 20h20L22 4z"/></svg><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 9a14 14 0 0118 0M6.5 12.8a9 9 0 0111 0M10 16.4a4 4 0 014 0"/></svg><svg width="22" height="12" viewBox="0 0 22 12" fill="none"><rect x="1" y="1" width="17" height="10" rx="2.5" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="3" width="11" height="6" rx="1" fill="currentColor"/><rect x="19.5" y="4" width="2" height="4" rx="1" fill="currentColor"/></svg></span></div>';
  MT.hb = () => '<div class="hb" aria-hidden="true"><span></span></div>';
  /* ---------- motion system ----------
     Animations only describe change: a screen entering, a keyed element appearing, or a keyed
     element whose data-s signature changed. Everything is driven by classes added after the DOM
     is updated, so state is always current before any visual feedback starts. */
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  MT.reduced = reduced;
  MT.actor = null; // which frame (pf / sf / ctl) caused the latest change, to cue the other one
  const restart = (n, cls) => { n.classList.remove(cls); void n.offsetWidth; n.classList.add(cls); };
  MT.cue = function (el, cls, ms) { if (!el || reduced()) return; restart(el, cls); clearTimeout(el['_t' + cls]); el['_t' + cls] = setTimeout(() => el.classList.remove(cls), ms || 1000); };

  // Re-render a container while keeping scroll position, focus and caret; animate only what changed.
  // opts: { key: screen identity, dir: -1 | 0 | 1 slide direction when the screen changes }
  MT.renderInto = function (el, html, opts) {
    opts = opts || {};
    const body = el.querySelector('.ph-body'); const sc = body ? body.scrollTop : 0;
    const a = document.activeElement; let fid = null, ss = null, se = null, fsel = null;
    if (a && el.contains(a)) {
      if (a.id) { fid = a.id; try { ss = a.selectionStart; se = a.selectionEnd; } catch (e) {} }
      else if (a.dataset && a.dataset.a) fsel = '[data-a="' + a.dataset.a + '"]' + (a.dataset.v !== undefined ? '[data-v="' + a.dataset.v.replace(/"/g, '\\"') + '"]' : '');
    }
    const old = {};
    el.querySelectorAll('[data-k]').forEach(n => { old[n.dataset.k] = { s: n.dataset.s || '', top: n.getBoundingClientRect().top }; });
    const k = el.offsetHeight ? el.getBoundingClientRect().height / el.offsetHeight : 1; // device display scale
    const prev = el.__mt; el.__mt = { key: opts.key };
    el.innerHTML = html;
    const nb = el.querySelector('.ph-body'); if (nb) nb.scrollTop = sc;
    if (fid) { const n = document.getElementById(fid); if (n) { n.focus(); try { if (ss != null) n.setSelectionRange(ss, se); } catch (e) {} } }
    else if (fsel) { const n = el.querySelector(fsel); if (n) n.focus({ preventScroll: true }); }
    if (!prev || reduced()) return;

    let changed = 0; const now = performance.now(), applied = {};
    if (prev.key !== opts.key) {                                   // a different screen: slide/fade the content in
      const dir = opts.dir || 0;
      el.querySelectorAll('.ph-body, .launch, .ph-foot').forEach(n => { n.style.setProperty('--dx', (dir * 14) + 'px'); n.classList.add('mt-screen'); });
      applied.__screen = { cls: ['mt-screen'], dx: dir * 14, t0: now }; changed = 1;
    } else {
      const entering = new Set();
      el.querySelectorAll('[data-k]').forEach(n => {
        const o = old[n.dataset.k];
        if (!o) { entering.add(n); return; }
        if (o.s !== (n.dataset.s || '')) n.__changed = o;
      });
      el.querySelectorAll('[data-k]').forEach(n => {
        const inside = n.parentElement && n.parentElement.closest('[data-k]');
        if (inside && entering.has(inside)) return;                // children of a new block ride along with it
        if (entering.has(n)) { const c = ['mt-in']; if (n.dataset.f) c.push('mt-flash'); n.classList.add(...c); applied[n.dataset.k] = { cls: c, t0: now }; changed++; return; }
        if (n.__changed) {
          const o = n.__changed; n.__changed = null; changed++;
          const mc = n.dataset.m || 'mt-flash'; n.classList.add(mc); applied[n.dataset.k] = { cls: [mc], t0: now };
          const dy = (o.top - n.getBoundingClientRect().top) / k;  // FLIP: glide from the old position
          if (n.dataset.flip && Math.abs(dy) > 4 && n.animate) n.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' });
        }
      });
    }
    // A follow-up render (e.g. a toast) must not cut a running animation short: re-apply it at its current phase.
    const carried = prev.anims && prev.anims.items;
    if (carried) Object.keys(carried).forEach(key => {
      const c = carried[key], el0 = now - c.t0; if (applied[key] || el0 >= 1500) return;
      const targets = key === '__screen' ? el.querySelectorAll('.ph-body, .launch, .ph-foot') : el.querySelectorAll('[data-k="' + key + '"]');
      targets.forEach(n => { if (key === '__screen') n.style.setProperty('--dx', c.dx + 'px'); n.classList.add(...c.cls); n.style.animationDelay = (-el0) + 'ms'; });
      applied[key] = c;
    });
    el.__mt.anims = { items: applied };
    // cue the device that did NOT cause the change
    if (changed && MT.actor && MT.actor !== el.id) MT.cue(el.closest('.phone'), 'mt-sync', 1100);
  };
  // Delegated click/input binding.
  MT.bind = function (el, h) {
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-a]'); if (!b || !el.contains(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') return;
      const f = h[b.dataset.a]; if (f) { MT.actor = el.id || 'ctl'; f(b.dataset.v, b, e); }
    });
    el.addEventListener('input', e => { const n = e.target.dataset && e.target.dataset.i; if (n && h.input) { MT.actor = el.id || 'ctl'; } if (n && h.input) h.input(n, e.target.type === 'checkbox' ? e.target.checked : e.target.value, e.target); });
    el.addEventListener('change', e => { const n = e.target.dataset && e.target.dataset.c; if (n && h.change) h.change(n, e.target.type === 'checkbox' ? e.target.checked : e.target.value, e.target); });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.enter && h[e.target.dataset.enter]) { e.preventDefault(); h[e.target.dataset.enter](); } });
  };
})();
