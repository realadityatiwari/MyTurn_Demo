/* Landing-page regression test (behavioural, no browser): runs the REAL site/js/store.js and site/js/app.js in a vm against a small DOM stub
   and checks that the page chrome initialises for EVERY scenario the store can produce - in particular 'empty', which production starts in.
   Regression: with scenario 'empty' app.js threw in script() (no walkthrough actions), which aborted chrome(), so the logo, language toggle,
   page title, scroll reveals and demo scaling were never set up.
   Run: node server/test/landing.test.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { createApp } = require('../server');

const SITE = path.join(__dirname, '..', '..', 'site', 'js');
const read = f => fs.readFileSync(path.join(SITE, f), 'utf8');
const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const HTML_TITLE = (fs.readFileSync(path.join(SITE, '..', 'index.html'), 'utf8').match(/<title>(.*?)<\/title>/) || [])[1];

function el(id) {
  const cls = new Set();
  return { id, innerHTML: '', textContent: '', dataset: {}, cls, parentElement: null, style: { vars: {}, setProperty(k, v) { this.vars[k] = v; } },
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: (c, on) => (on === undefined ? (cls.has(c) ? cls.delete(c) : cls.add(c)) : on ? cls.add(c) : cls.delete(c)) },
    setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, closest: () => null };
}

/** A fresh "browser": real store.js + app.js, stubbed DOM and MT helpers. */
function page(scenario) {
  const errors = [], ids = {}; ['ctl', 'script', 'site-lang', 'wm', 'wm2'].forEach(i => { ids[i] = el(i); });
  const revealEls = [el('r1'), el('r2'), el('r3')], stage = el('stage'), grid = Object.assign(el('grid'), { clientWidth: 1200 }), listeners = {};
  const document = { title: HTML_TITLE, addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, getElementById: id => ids[id] || null,
    querySelector: s => (s === '.stage' ? stage : s === '.demo-grid' ? grid : null),
    querySelectorAll: s => (s === '[data-t]' ? [] : /\.sec-label/.test(s) ? revealEls : []) };
  const MT = {}; const window = { MT, innerHeight: 800, addEventListener() {} };
  const ctx = vm.createContext({ window, document, console: { log() {}, error: (...a) => errors.push(a.join(' ')) }, setTimeout, clearTimeout, setInterval, clearInterval, getComputedStyle: () => ({ gridTemplateColumns: '1fr 320px' }) });
  vm.runInContext(read('i18n.js'), ctx, { filename: 'i18n.js' });
  Object.assign(MT, { lang: 'en', esc: s => String(s), t: (k, p) => { const v = MT.DICT[k]; return v ? v[MT.lang === 'hi' ? 1 : 0] : k; }, langToggle: () => '<button data-v="en">English</button><button data-v="hi">हिन्दी</button>',
    wordmark: n => '<svg data-size="' + n + '"></svg>', reduced: () => true, bind() {}, cue() {}, rerenders: [], setLang(v) { MT.lang = v; } });
  vm.runInContext(read('store.js'), ctx, { filename: 'store.js' });
  MT.store.reset(scenario);
  vm.runInContext(read('app.js'), ctx, { filename: 'app.js' });
  let thrown = null; try { (listeners.DOMContentLoaded || []).forEach(f => f()); } catch (e) { thrown = e; }
  return { MT, S: MT.store, ids, revealEls, stage, document, errors, thrown, switchLang: l => { MT.lang = l; MT.rerenders.forEach(f => f()); } };
}

(async () => {
  try {
    // Every scenario the store can produce: the branches seed() knows, plus the default - and 'empty', which production really starts in.
    const src = read('store.js'), found = new Set(['normal']); for (const m of src.matchAll(/scenario === '(\w+)'/g)) found.add(m[1]);
    const SCEN = [...found].sort();
    ok('the store produces the scenarios normal, missed, late and empty (a new one must be given UI support or this list is revisited)', SCEN.join() === 'empty,late,missed,normal', SCEN.join());
    const prod = createApp({ seedMode: 'empty', logError() {} }); const realProd = prod.snapshot().shared.scenario; prod.close();
    ok("production's first start (SEED_MODE=empty) really produces the scenario \"empty\"", realProd === 'empty', realProd);

    const NEW_TITLE = (() => { const p = page('normal'); return p.document.title; })();
    ok('the HTML default title differs from the title app.js sets, so "title initialised" is observable', HTML_TITLE && NEW_TITLE && HTML_TITLE !== NEW_TITLE, HTML_TITLE + ' / ' + NEW_TITLE);

    const ACT_LEN = { normal: 7, missed: 7, late: 6 };
    for (const s of SCEN) {
      const p = page(s);
      ok('[' + s + '] page initialisation does not throw and logs no errors', p.thrown === null && p.errors.length === 0, p.thrown ? p.thrown.stack : p.errors.join(' | '));
      ok('[' + s + '] logo (wordmark) is rendered in the header and footer slots', /<svg/.test(p.ids.wm.innerHTML) && /<svg/.test(p.ids.wm2.innerHTML));
      ok('[' + s + '] English/Hindi toggle is rendered', /English/.test(p.ids['site-lang'].innerHTML) && /हिन्दी/.test(p.ids['site-lang'].innerHTML) && p.ids['site-lang'].dataset.l === 'en');
      ok('[' + s + '] page title is set from the dictionary (not left at the HTML default)', p.document.title === NEW_TITLE && p.document.title !== HTML_TITLE, p.document.title);
      ok('[' + s + '] scenario controls are rendered', /data-a="scen"/.test(p.ids.ctl.innerHTML) && /data-a="reset"/.test(p.ids.ctl.innerHTML));
      ok('[' + s + '] initialisation CONTINUES after the walkthrough step: demo scaling is set and scroll reveals are armed', /^\d\.\d{3}$/.test(p.stage.style.vars['--s'] || '') && p.revealEls.every(e => e.cls.has('reveal') && e.cls.has('in')), JSON.stringify(p.stage.style.vars));
      const wt = p.ids.script.innerHTML, items = (wt.match(/<li>/g) || []).length;
      if (s === 'empty') ok('[empty] no walkthrough is rendered (there is no demo script for an empty production queue)', wt === '');
      else ok('[' + s + '] the demo walkthrough is rendered with its ' + ACT_LEN[s] + ' steps', /<details class="walk"/.test(wt) && items === ACT_LEN[s], items + ' steps');
    }

    // live state updates and language changes after initialisation (the page also re-runs chrome() on every shared-state push)
    const p = page('empty'); let errAfter = null;
    try {
      for (const s of [...SCEN, 'empty', 'normal', 'empty']) { p.S.reset(s); }
      p.switchLang('hi'); const hiTitle = p.document.title; p.switchLang('en');
      ok('state changes between every pair of scenarios (including to/from empty) and a language switch never throw', p.errors.length === 0 && hiTitle !== NEW_TITLE && p.document.title === NEW_TITLE, p.errors.join(' | '));
    } catch (e) { errAfter = e; ok('state changes between every pair of scenarios never throw', false, e.stack); }
    p.S.reset('empty'); p.S.reset('normal');
    ok('switching empty -> normal shows the walkthrough; normal -> empty hides it again', /<details class="walk"/.test(p.ids.script.innerHTML)); p.S.reset('empty');
    ok('...and the page stays fully initialised afterwards (logo, toggle, title)', p.ids.script.innerHTML === '' && /<svg/.test(p.ids.wm.innerHTML) && /English/.test(p.ids['site-lang'].innerHTML) && p.document.title === NEW_TITLE);
    // an UNKNOWN scenario value (e.g. from a newer server) must not take the page down either
    const q = page('normal'); q.S.get().scenario = 'future-scenario'; let unk = null; try { q.MT.rerenders.forEach(f => f()); } catch (e) { unk = e; }
    ok('an unknown scenario value degrades to "no walkthrough" instead of breaking the page', unk === null && q.errors.length === 0 && q.ids.script.innerHTML === '' && /<svg/.test(q.ids.wm.innerHTML), unk && unk.message);
  } catch (e) { ok('test run crashed', false, e.stack); }
  const fail = res.filter(r => r.startsWith('FAIL')); console.log(res.join('\n')); console.log('\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed');
  process.exit(fail.length ? 1 : 0);
})();
