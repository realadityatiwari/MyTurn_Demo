/* Sample-demo tests: the landing page's full demo (walkthrough, patient dashboard, staff queue) is available as a clearly labelled, browser-only
   SAMPLE mode (?sample=1) that is isolated from the real queue, while the live page stays empty and connected only to the real server.
   Runs the REAL site/js/{i18n,store,app}.js in a vm against browser stubs (XMLHttpRequest / EventSource / localStorage recorders).
   Run: node server/test/sample.test.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), http = require('http');
const { createApp } = require('../server');

const SITE = path.join(__dirname, '..', '..', 'site'), read = f => fs.readFileSync(path.join(SITE, f), 'utf8');
const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const EMPTY_VIEW = snapshot => ({ rev: snapshot.rev, epoch: snapshot.epoch, shared: snapshot.shared });
const ME = JSON.stringify({ staff: null, patient: null, patientWeb: 'disabled', demoCredentials: false, openControls: false, staffConfigured: true });

function el(id) { const cls = new Set(); return { id, innerHTML: '', textContent: '', dataset: {}, cls, parentElement: null, style: { vars: {}, setProperty(k, v) { this.vars[k] = v; } }, classList: { add: c => cls.add(c), remove: c => cls.delete(c), toggle: () => {} }, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, closest: () => null }; }

/** A fresh browser tab. opts: search, snapshot (what GET /api/state returns; null = server unreachable), requireMeta, app (also load app.js), serverMode (force) */
function browser(opts) {
  const calls = { xhr: [], es: [], fetch: [] }, store = new Map(), written = new Set(); let walls = 0;
  class XHR {
    open(m, u, async) { this.m = m; this.u = u; this.async = async !== false; calls.xhr.push(m + ' ' + u); }
    setRequestHeader() {}
    send() {
      const sync = !this.async; let status = 200, text = '{}';
      if (opts.snapshot === null) status = 0; else if (this.u === '/api/state') text = JSON.stringify(opts.snapshot); else if (this.u === '/api/auth/me') text = ME;
      this.status = status; this.responseText = text; if (!sync && this.onloadend) Promise.resolve().then(() => this.onloadend());
    }
  }
  class ES { constructor(u) { calls.es.push(u); } close() {} }
  const listeners = {}, ids = {}; ['ctl', 'script', 'site-lang', 'wm', 'wm2', 'sample-note'].forEach(i => { ids[i] = el(i); });
  const stage = el('stage'), grid = Object.assign(el('grid'), { clientWidth: 1200 });
  const document = { title: 'x', body: { appendChild() { walls++; } }, createElement: () => Object.assign(el('w'), { style: { cssText: '' } }), addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    getElementById: id => ids[id] || null, querySelector: s => (/myturn-require-server/.test(s) ? (opts.requireMeta ? {} : null) : s === '.stage' ? stage : s === '.demo-grid' ? grid : null),
    querySelectorAll: s => (/\.sec-label/.test(s) ? [el('r')] : []) };
  const MT = {}; const window = { MT, innerHeight: 800, addEventListener() {} };
  const ctx = vm.createContext({ window, document, console: { log() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, Promise, getComputedStyle: () => ({ gridTemplateColumns: '1fr 320px' }),
    location: { search: opts.search || '', protocol: opts.protocol || 'https:' }, XMLHttpRequest: XHR, EventSource: ES,
    fetch: (...a) => { calls.fetch.push(a[0]); return Promise.reject(new Error('no network in test')); },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, v); written.add(k); } } });
  vm.runInContext(read('js/i18n.js'), ctx, { filename: 'i18n.js' });
  Object.assign(MT, { lang: 'en', esc: s => String(s), t: k => { const v = MT.DICT[k]; return v ? v[MT.lang === 'hi' ? 1 : 0] : k; }, langToggle: () => '<button>English</button>', wordmark: () => '<svg></svg>', reduced: () => true, bind() {}, cue() {}, rerenders: [], setLang(v) { MT.lang = v; } });
  vm.runInContext(read('js/store.js'), ctx, { filename: 'store.js' });
  let thrown = null;
  if (opts.app) { vm.runInContext(read('js/app.js'), ctx, { filename: 'app.js' }); try { (listeners.DOMContentLoaded || []).forEach(f => f()); } catch (e) { thrown = e; } }
  const visits = () => Object.values(MT.store.get().q).reduce((n, l) => n + l.length, 0);
  return { MT, S: MT.store, calls, written, ids, store, thrown, visits, walls: () => walls, switchLang: l => { MT.lang = l; MT.rerenders.forEach(f => f()); } };
}
const noNetwork = b => b.calls.xhr.length === 0 && b.calls.es.length === 0 && b.calls.fetch.length === 0;

(async () => {
  const app = createApp({ seedMode: 'empty', logError() {} }); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); const port = app.server.address().port;
  try {
    const prodSnap = EMPTY_VIEW(app.snapshot()), rev0 = app.getRev(), full0 = JSON.stringify(app.snapshot().shared);

    // ---------- the live page: empty, server-connected, NOT sample ----------
    const live = browser({ search: '', snapshot: prodSnap, requireMeta: true, app: true });
    ok('live page: server mode on, sample mode off, GET /api/state and the event stream are used', live.MT.serverMode === true && live.MT.sample === false && live.calls.xhr.includes('GET /api/state') && live.calls.es.includes('/api/events'));
    ok('live page: the queue is EMPTY (scenario "empty", no visits, no accounts) and no walkthrough is shown', live.S.get().scenario === 'empty' && live.visits() === 0 && Object.keys(live.S.get().accounts).length === 0 && live.ids.script.innerHTML === '' && live.thrown === null);
    ok('live page: only the live storage key is written - never the sample key', [...live.written].every(k => k === 'myturn.demo.v1') && !live.written.has('myturn.sample.v1'));
    ok('live page: offers the sample demo with a clear label and a link to ?sample=1', /live clinic view/.test(live.ids['sample-note'].innerHTML) && /href="\?sample=1#demo"/.test(live.ids['sample-note'].innerHTML) && /nothing is saved to the clinic/.test(live.ids['sample-note'].innerHTML));

    // ---------- the sample page: complete demo, simulated in the browser, zero server contact ----------
    const smp = browser({ search: '?sample=1', snapshot: prodSnap, requireMeta: true, app: true });
    ok('sample page: sample mode on, server mode OFF, and NOT A SINGLE network call (no state load, no events, no sign-in)', smp.MT.sample === true && !smp.MT.serverMode && noNetwork(smp), JSON.stringify(smp.calls));
    ok('sample page: the "server required" wall is not raised and the page initialises normally', smp.walls() === 0 && smp.thrown === null && /<svg/.test(smp.ids.wm.innerHTML));
    ok('sample page: sample patients and a populated staff queue are present (scenario normal, queue K 038-K 043 with names and mixed statuses)', smp.S.get().scenario === 'normal' && smp.visits() >= 9 && ['K 038', 'K 039', 'K 040', 'K 041', 'K 042', 'K 043'].every(tk => smp.S.get().q['rv:gm'].some(e => e.tok === tk && e.name)) && new Set(smp.S.get().q['rv:gm'].map(e => e.st)).size >= 4, smp.visits());
    ok('sample page: the demo walkthrough is rendered (7 scripted steps)', /<details class="walk"/.test(smp.ids.script.innerHTML) && (smp.ids.script.innerHTML.match(/<li>/g) || []).length === 7);
    ok('sample page: it is labelled SAMPLE DEMO, says it is not connected to the real queue or Telegram, and links back to the live view', /SAMPLE DEMO/.test(smp.ids['sample-note'].innerHTML) && /Not connected to the real clinic queue or to Telegram/.test(smp.ids['sample-note'].innerHTML) && /href=".\/#demo"/.test(smp.ids['sample-note'].innerHTML));
    smp.S.patientSignIn('9876543210'); const pv = smp.S.myVisits();
    ok('sample page: a sample patient has a dashboard (saved profiles and an active visit with a token)', smp.S.profiles().length >= 1 && Array.isArray(pv), pv.length);
    // exercise the whole demo: staff sign-in (simulated), staff actions, patient actions, scenario switches, reset
    const r1 = smp.S.staffLogin('operator', 'demo'); const q0 = smp.S.get().q['rv:gm'].find(e => e.st === 'wait'); const cn = smp.S.callNext('rv:gm'); smp.S.staffLogout(); smp.S.staffLogin('admin', 'demo');
    for (const s of ['missed', 'late', 'normal', 'empty', 'normal']) smp.S.reset(s); smp.S.patientSignOut(); smp.S.setTicker(true); smp.S.tick(); smp.S.setTicker(false);
    ok('sample page: sign-in, staff actions, scenario switches, reset and the ticker all work locally and STILL make no network call', r1.ok && !!q0 && noNetwork(smp), JSON.stringify(smp.calls));
    ok('sample page: it writes only its OWN storage key, never the live one (the two modes cannot mix)', smp.written.size === 1 && smp.written.has('myturn.sample.v1') && !smp.written.has('myturn.demo.v1'), [...smp.written].join());
    const sw = browser({ search: '?sample=1', snapshot: null, requireMeta: true });
    const lw = browser({ search: '', snapshot: null, requireMeta: true });
    ok('server unreachable: the live page shows the "unavailable" wall (no silent fallback), the sample page does not need the server at all', lw.walls() === 1 && sw.walls() === 0 && noNetwork(sw));

    // ---------- only the exact flag enables sample mode ----------
    const vari = s => browser({ search: s, snapshot: prodSnap }).MT.sample;
    ok('sample mode is enabled only by sample=1 as a whole parameter', vari('?sample=1') && vari('?a=1&sample=1') && vari('?sample=1&b=2') && ['', '?sample=0', '?sample=10', '?samples=1', '?xsample=1', '?sample=', '?a=sample=1', '?sample'].every(s => !vari(s)));

    // ---------- language + the three page modes (static / live / sample) ----------
    const stat = browser({ search: '', snapshot: prodSnap, app: true, protocol: 'file:' });          // opened as a plain file: no server, not sample
    const hiB = browser({ search: '?sample=1', snapshot: prodSnap, app: true }); hiB.switchLang('hi');
    ok('the note is rendered in Hindi as well, and every new string exists in English and Hindi', /नमूना डेमो/.test(hiB.ids['sample-note'].innerHTML) && ['sample.on', 'sample.exit', 'sample.offer', 'sample.open'].every(k => hiB.MT.DICT[k] && hiB.MT.DICT[k][0] && hiB.MT.DICT[k][1]));
    ok('a static/local page (no server, not sample) shows no sample note and works from its own local state', !stat.MT.serverMode && !stat.MT.sample && stat.ids['sample-note'].innerHTML === '' && noNetwork(stat) && stat.visits() >= 9);

    // ---------- production stays empty and isolated, with a real server ----------
    const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, agent: false }, x => { let t = ''; x.on('data', d => t += d); x.on('end', () => resolve({ status: x.statusCode, text: t })); }).on('error', reject));
    const [home, homeS] = [await get('/'), await get('/?sample=1')];
    ok('the server serves the identical page for / and /?sample=1 (the flag is purely client-side; the server ignores it)', home.status === 200 && homeS.status === 200 && home.text === homeS.text && /id="sample-note"/.test(home.text));
    const st = JSON.parse((await get('/api/state')).text);
    ok('the real server state is still EMPTY after the sample sessions above (no visits, no accounts, no audit, scenario empty, same revision)', app.getRev() === rev0 && JSON.stringify(app.snapshot().shared) === full0 && st.shared.scenario === 'empty' && Object.values(st.shared.q).every(l => l.length === 0) && Object.keys(st.shared.accounts).length === 0 && st.shared.audit.length === 0);
    ok('the sample seed lives only in the browser bundle: a production-style server start never creates sample patients (SEED_MODE=empty ignores any sample request)', (() => { const p = createApp({ seedMode: 'empty', logError() {}, auth: { production: false } }); const n = Object.values(p.snapshot().shared.q).reduce((a, l) => a + l.length, 0); p.close(); return n === 0; })());
  } catch (e) { ok('test run crashed', false, e.stack); }
  app.close();
  const fail = res.filter(r => r.startsWith('FAIL')); console.log(res.join('\n')); console.log('\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed');
  process.exit(fail.length ? 1 : 0);
})();
