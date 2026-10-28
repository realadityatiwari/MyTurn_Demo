/* Walk-in registration: staff UI logic, server-response handling, receipt, print rules.
   Part A drives the REAL staff.js / store.js / ui.js / i18n.js in a vm with a minimal fake DOM (no browser needed).
   Part B runs the REAL store.js client code against the REAL server over HTTP through a fake XMLHttpRequest (so network loss, lost responses, 5xx, malformed answers
   and demo/real isolation can be provoked precisely). Layout/print-preview behaviour needs a real browser and is NOT claimed here (see the checks marked static).
   Run: node server/test/walkin-ui.test.js */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), crypto = require('crypto');
const { createApp, assembleSite } = require('../server');
const A = require('../auth');

const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const SITE = path.join(__dirname, '..', '..', 'site'), read = f => fs.readFileSync(path.join(SITE, f), 'utf8');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tick = () => new Promise(r => setImmediate(r));
const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };
const RID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-wkui-'));
for (const k of ['log', 'warn']) console[k] = () => {};

/* ================= Part A: staff UI logic ================= */
function el(id) { const L = {}; return { id, innerHTML: '', __html: undefined, dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, addEventListener(t, f) { (L[t] = L[t] || []).push(f); }, fire(t, e) { (L[t] || []).forEach(f => f(e)); }, querySelectorAll: () => [], querySelector: () => null, contains: () => false, closest: () => null, remove() {}, removeAttribute() {}, focus() {} }; }
function harness(opts) {
  opts = opts || {};
  const ids = { sf: el('sf'), pf: el('pf'), receipt: el('receipt'), 'site-lang': el('site-lang') }, DOC = {};
  const printed = [];
  const document = { documentElement: { lang: 'en', setAttribute() {}, classList: { add() {} } }, body: { classList: { add() {}, remove() {} }, appendChild() {} }, title: '', activeElement: null,
    addEventListener(t, f) { (DOC[t] = DOC[t] || []).push(f); }, getElementById: i => ids[i] || null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('x') };
  const window = { innerHeight: 800, addEventListener() {}, print: () => printed.push(1), matchMedia: () => ({ matches: true }) };
  const store = {}; const localStorage = { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); } };
  const errors = []; const ctx = vm.createContext({ window, document, localStorage, console: { log() {}, error: (...a) => errors.push(a.join(' ')) }, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Date, crypto: crypto.webcrypto, btoa: s => Buffer.from(s, 'binary').toString('base64'), navigator: {}, XMLHttpRequest: opts.xhr, location: opts.xhr ? { protocol: 'http:' } : undefined });
  for (const f of ['i18n.js', 'store.js', 'ui.js']) vm.runInContext(read('js/' + f), ctx, { filename: f });
  const MT = window.MT; MT.renderInto = (e, html) => { e.innerHTML = html; }; MT.bind = () => {};
  vm.runInContext(read('js/staff.js'), ctx, { filename: 'staff.js' });
  (DOC.DOMContentLoaded || []).forEach(f => f());
  return { MT, S: MT.store, P: MT.staff.P, H: MT.staff.H, sf: ids.sf, receipt: ids.receipt, printed, window, errors, ctx, signIn(role) { MT.store.staffLogin(role === 'admin' ? 'admin' : 'operator', 'demo'); MT.store.openSession('rv:gm'); MT.staff.render(); } };
}
const deferred = () => { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; };
const entryOf = (tok, name, at) => ({ id: 'rv:gm#' + Number(tok.slice(2)), tok, name: name || 'Ravi Kumar', st: 'wait', at: at === undefined ? Date.now() : at, rby: 'op' });
const stub = h => { const calls = []; h.S.assisted = (...a) => { calls.push(a); const d = deferred(); calls.last = d; calls.deferreds = (calls.deferreds || []); calls.deferreds.push(d); return d.p; }; return calls; };
const type = (h, v) => h.H.input('wkname', v);

async function partA() {
  const h = harness(), T = k => h.MT.t(k);
  h.signIn('op');
  const html0 = h.sf.innerHTML;
  ok('the staff queue screen offers a "Register walk-in" action for the selected session', /data-a="openWalk"/.test(html0) && html0.includes(T('wk.open')));

  // ---- form & validation ----
  const calls = stub(h);
  h.H.openWalk();
  ok('opening the sheet shows a labelled, modal form bound to the CURRENT session only (name input, dialog role, labelled heading)', h.P.walk && h.P.walk.stage === 'form' && h.P.walk.key === 'rv:gm' && /role="dialog"/.test(h.sf.innerHTML) && /aria-modal="true"/.test(h.sf.innerHTML) && /<label class="fld" for="wk_name">/.test(h.sf.innerHTML) && /aria-labelledby="wk_h"/.test(h.sf.innerHTML) && h.sf.innerHTML.includes('General Medicine'));
  const bad = [['', 'wk.errEmpty'], ['   ', 'wk.errEmpty'], ['x'.repeat(41), 'wk.errLong'], ['A\u0007B', 'wk.errChars']];
  const got = bad.map(([v]) => { type(h, v); h.H.wkSubmit(); return h.P.walk.err; });
  ok('empty, blank, over-40-character and control-character names are refused with a specific message and NO request', got.join() === bad.map(b => b[1]).join() && calls.length === 0 && /role="alert"/.test(h.sf.innerHTML) && /aria-invalid="true"/.test(h.sf.innerHTML));
  ok('exactly 40 characters (after trimming/collapsing spaces) is accepted by the form', h.MT.staff.nameErr('  ' + 'y'.repeat(40) + '  ') === null && h.MT.staff.nameErr('a   b') === null && h.MT.staff.cleanName('  Asha    Verma ') === 'Asha Verma');

  // ---- submit: one request, trimmed name, strong request id, no success before the server answers ----
  type(h, '  Ravi    Kumar  '); h.H.wkSubmit(); h.H.wkSubmit(); h.H.wkSubmit();            // three rapid clicks / Enter presses
  ok('submit sends ONE request (repeat clicks while in flight are ignored) with session key, trimmed name and a valid request id; confirm is not set', calls.length === 1 && calls[0][0] === 'rv:gm' && calls[0][1] === 'Ravi Kumar' && RID_RE.test(calls[0][2]) && calls[0][3] === false);
  ok('while in flight: busy label, disabled buttons, name locked, and NO success or receipt yet', h.P.walk.busy && h.sf.innerHTML.includes(T('wk.busy')) && /aria-disabled="true"/.test(h.sf.innerHTML) && /readonly/.test(h.sf.innerHTML) && h.P.walk.stage === 'form' && h.receipt.innerHTML === '' && !h.sf.innerHTML.includes(T('wk.okT')));
  h.H.wkClose(); ok('Cancel/Escape are inert while a request is in flight (the attempt cannot be abandoned half-way)', h.P.walk && h.P.walk.busy);
  const rid1 = calls[0][2];
  const localBefore = JSON.stringify(h.S.get().q['rv:gm']);
  calls.deferreds[0].resolve({ ok: true, replayed: false, key: 'rv:gm', entry: entryOf('K 777', 'Ravi Kumar', Date.UTC(2026, 9, 28, 5, 30)) }); await flush();
  ok('success is shown ONLY from the server answer: the token comes from the server entry (K 777), not from the local store, which was not touched', h.P.walk.stage === 'done' && h.sf.innerHTML.includes('K 777') && JSON.stringify(h.S.get().q['rv:gm']) === localBefore && !h.S.get().q['rv:gm'].some(e => e.tok === 'K 777'));
  const rc = h.receipt.innerHTML;
  ok('the receipt is filled from the server entry: token, department, clinic, room, ABBREVIATED name, date/time from entry.at, three instructions', rc.includes('K 777') && rc.includes('General Medicine') && rc.includes('Riverside Hospital') && rc.includes('Room 4') && rc.includes('Ravi K.') && !rc.includes('Ravi Kumar') && rc.includes(new Date(Date.UTC(2026, 9, 28, 5, 30)).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })) && ['rc.s1', 'rc.s2', 'rc.s3'].every(k => rc.includes(T(k))) && /class="rc-tok"/.test(rc));
  ok('the receipt carries no phone, account, profile id, request id, role, status or other patients', !/rby|acct|pid|rid|tg:|\d{10}|9876543210|Asha|Imran|Ramesh|Sita|K 04\d/.test(rc.replace(/K 777/g, '')) && !/\bop\b/.test(h.MT.staff.receiptHtml(entryOf('K 5', 'Q R'), 'rv:gm')));
  h.H.wkPrint(); ok('Print receipt opens the browser print dialog (window.print) and creates nothing', h.printed.length === 1 && calls.length === 1);
  h.H.wkClose(); ok('closing the sheet removes the receipt content from the page', h.P.walk === null && h.receipt.innerHTML === '');

  // ---- duplicate warning: explicit confirmation, same request id ----
  const c2 = stub(h); h.H.openWalk(); type(h, 'ravi kumar'); h.H.wkSubmit(); const ridD = c2[0][2];
  c2.deferreds[0].resolve({ err: 'dupWarn', dup: [{ id: 'rv:gm#44', tok: 'K 044', st: 'wait' }, { id: 'rv:gm#45', tok: 'K 045', st: 'missed' }] }); await flush();
  const dh = h.sf.innerHTML;
  ok('a duplicate warning lists the matching tokens and statuses, says it may be a different person, and offers Register anyway / Cancel - no success, no receipt', h.P.walk.stage === 'dup' && dh.includes('K 044') && dh.includes('K 045') && dh.includes(T('st.wait')) && dh.includes(T('st.missed')) && dh.includes(T('wk.dupB')) && dh.includes(T('wk.dupGo')) && dh.includes(T('wk.cancel')) && h.receipt.innerHTML === '');
  ok('the warning does not claim the patients are the same person', !/same person\b(?! with)/i.test(T('wk.dupB')) && /different person/i.test(T('wk.dupB')));
  h.H.wkConfirm(); h.H.wkConfirm();
  ok('Register anyway sends ONE more request with the SAME request id and confirm=true (double click ignored)', c2.length === 2 && c2[1][2] === ridD && c2[1][3] === true && c2[1][0] === 'rv:gm' && c2[1][1] === 'ravi kumar');
  c2.deferreds[1].resolve({ ok: true, replayed: false, key: 'rv:gm', entry: entryOf('K 778', 'ravi kumar') }); await flush();
  ok('after the confirmed request succeeds the receipt shows the new server token', h.P.walk.stage === 'done' && h.receipt.innerHTML.includes('K 778'));
  h.H.wkClose();
  const c3 = stub(h); h.H.openWalk(); type(h, 'ravi kumar'); h.H.wkSubmit(); c3.deferreds[0].resolve({ err: 'dupWarn', dup: [{ id: 'rv:gm#44', tok: 'K 044', st: 'wait' }] }); await flush(); h.H.wkClose();
  ok('Cancel on the warning ends the attempt without a second request', h.P.walk === null && c3.length === 1 && h.receipt.innerHTML === '');

  // ---- uncertain responses: same request id, never a new one ----
  const c4 = stub(h); h.H.openWalk(); type(h, 'Meena Rao'); h.H.wkSubmit(); const ridU = c4[0][2];
  c4.deferreds[0].resolve({ uncertain: true }); await flush();
  ok('an uncertain answer is NOT success: warning shown, no receipt, name locked, nothing claimed', h.P.walk.stage === 'uncertain' && h.sf.innerHTML.includes(T('wk.unB')) && h.sf.innerHTML.includes(T('wk.retry')) && h.receipt.innerHTML === '' && !h.sf.innerHTML.includes(T('wk.okT')));
  h.H.wkBackdrop(null, null, null); ok('the uncertain sheet cannot be dismissed by a stray backdrop click', h.P.walk && h.P.walk.stage === 'uncertain');
  h.H.wkRetry(); h.H.wkRetry();
  ok('Retry re-sends with the SAME request id (one request per click burst)', c4.length === 2 && c4[1][2] === ridU && c4[1][1] === 'Meena Rao');
  c4.deferreds[1].resolve({ uncertain: true }); await flush(); h.H.wkRetry(); c4.deferreds[2].resolve({ ok: true, replayed: true, key: 'rv:gm', entry: entryOf('K 779', 'Meena Rao') }); await flush();
  ok('repeated retries all carry the same id; a replayed success shows the EXISTING token with the "already registered, no new token" notice', c4.length === 3 && c4[2][2] === ridU && h.P.walk.stage === 'done' && h.P.walk.replayed === true && h.sf.innerHTML.includes(T('wk.replayed')) && h.sf.innerHTML.includes('K 779'));
  h.H.wkClose();
  const c5 = stub(h); h.H.openWalk(); type(h, 'Confirm Retry'); h.H.wkSubmit(); c5.deferreds[0].resolve({ err: 'dupWarn', dup: [{ id: 'a', tok: 'K 1', st: 'wait' }] }); await flush(); h.H.wkConfirm(); c5.deferreds[1].resolve({ uncertain: true }); await flush(); h.H.wkRetry();
  ok('retrying an uncertain CONFIRMED request keeps both the request id and confirm=true', c5.length === 3 && c5[2][2] === c5[0][2] && c5[2][3] === true && c5[1][3] === true && c5[0][3] === false);
  c5.deferreds[2].resolve({ err: 'closed' }); await flush(); h.H.wkClose();
  const c5b = stub(h); h.H.openWalk(); h.H.wkClose();
  const c6 = stub(h); h.H.openWalk(); type(h, 'Uncertain Close'); h.H.wkSubmit(); c6.deferreds[0].resolve({ uncertain: true }); await flush(); h.H.wkClose();
  ok('closing after an uncertain attempt tells staff to check the Waiting list before registering again', h.P.walk === null && h.P.toast && h.P.toast.k === 'wk.checkQueue');

  // ---- definite refusals: nothing was created, a later attempt uses a NEW id ----
  const map = { closed: 'wk.errClosed', forbidden: 'wk.errForbidden', auth: 'wk.errAuth', busy: 'wk.errBusy', bad: 'wk.errGeneric', idem: 'wk.errGeneric', name: 'wk.errGeneric', rid: 'wk.errGeneric', whatever: 'wk.errGeneric' };
  const mapped = {}; let sameId = 0;
  for (const code of Object.keys(map)) { const c = stub(h); h.H.openWalk(); type(h, 'Err ' + code); h.H.wkSubmit(); const r1 = c[0][2]; c.deferreds[0].resolve({ err: code }); await flush(); mapped[code] = h.P.walk.err; const stillForm = h.P.walk.stage === 'form' && !h.receipt.innerHTML; h.H.wkSubmit(); if (c.length === 2 && c[1][2] === r1) sameId++; if (!stillForm) mapped[code] = 'NOT-FORM'; h.P.walk && (h.P.walk.busy = false); h.P.walk = null; }
  ok('every refusal maps to a clear message, returns to the form and never shows success', Object.keys(map).every(k => mapped[k] === map[k]), JSON.stringify(mapped));
  ok('after a definite refusal the next attempt gets a NEW request id (nothing exists under the old one)', sameId === 0);

  // ---- session / sign-out safety ----
  const c7 = stub(h); h.H.openWalk(); type(h, 'Sign Out Test'); h.H.wkSubmit(); h.S.staffLogout(); h.MT.staff.render(); c7.deferreds[0].resolve({ ok: true, replayed: false, key: 'rv:gm', entry: entryOf('K 800', 'Sign Out Test') }); await flush();
  ok('signing out while a request is in flight closes the sheet; a late answer does not resurrect a receipt', h.P.walk === null && h.receipt.innerHTML === '');
  h.signIn('op');
  const lines = []; h.S.get().staff.sess = null; h.H.openWalk();
  ok('the walk-in sheet cannot be opened without an open session of this staff member', h.P.walk === null);
  h.S.openSession('rv:gm'); h.MT.staff.render();

  // ---- reprint: existing entry, no request, no new token ----
  const rcalls = stub(h); const ctr0 = h.S.get().ctr['rv:gm'];
  const mk = h.S.registerAssisted('rv:gm', 'Print Again Person', 'r'.repeat(20), false); h.MT.staff.render();     // an existing server-style walk-in entry in the local simulation
  const html1 = h.sf.innerHTML;
  ok('walk-in rows get a Reprint action; ordinary rows (seeded / Telegram-style) do not', mk.ok && new RegExp('data-a="reprint" data-v="' + mk.e.id.replace(/[#:]/g, c => '\\' + c) + '"').test(html1) && (html1.match(/data-a="reprint"/g) || []).length === h.S.get().q['rv:gm'].filter(e => e.src === 'staff' && ['reg', 'wait', 'called', 'svc', 'missed', 'retreq', 'retq'].includes(e.st)).length);
  const ctr1 = h.S.get().ctr['rv:gm'], len1 = h.S.get().q['rv:gm'].length;
  h.H.reprint(mk.e.id);
  ok('Reprint shows the existing entry\'s receipt (token, abbreviated name) with NO request, NO new entry and NO token consumed', h.P.walk.stage === 'done' && h.P.walk.reprint === true && rcalls.length === 0 && h.receipt.innerHTML.includes(mk.e.tok) && h.receipt.innerHTML.includes('Print P.') && !h.receipt.innerHTML.includes('Print Again') && h.S.get().ctr['rv:gm'] === ctr1 && h.S.get().q['rv:gm'].length === len1 && h.sf.innerHTML.includes(T('wk.reprintB')), JSON.stringify([h.P.walk && h.P.walk.stage, h.P.walk && h.P.walk.reprint, rcalls.length, h.receipt.innerHTML.slice(0, 200), mk.e && mk.e.tok]));
  h.H.wkPrint(); h.H.wkClose();
  const seeded = h.S.get().q['rv:gm'][0]; h.H.reprint(seeded.id);
  ok('Reprint of an entry that is not a walk-in is refused', h.P.walk === null);
  const noTime = h.S.get().q['rv:gm'].find(e => e.id === mk.e.id); const keepAt = noTime.at; noTime.at = undefined; h.MT.staff.render(); const noLink = !new RegExp('data-v="' + mk.e.id.replace(/[#:]/g, c => '\\' + c) + '"[^>]*>' + h.MT.t('a.reprint')).test(h.sf.innerHTML);
  h.H.reprint(mk.e.id); ok('without a valid registration time there is no Reprint action and a forced reprint is refused', noLink && h.P.walk === null); noTime.at = keepAt;

  // ---- receipt: honest time fallback, Hindi ----
  const rcNA = h.MT.staff.receiptHtml(entryOf('K 900', 'Time Missing', undefined), 'rv:gm'), rcBad = h.MT.staff.receiptHtml(entryOf('K 901', 'Time Bad', NaN), 'rv:gm'), rcStr = h.MT.staff.receiptHtml(Object.assign(entryOf('K 902', 'Time Str'), { at: 'yesterday' }), 'rv:gm');
  const rcNone = h.MT.staff.receiptHtml(Object.assign(entryOf('K 903', 'T'), { at: undefined }), 'rv:gm');
  ok('a missing/invalid timestamp prints "Time not available" instead of inventing a time', [rcNone, rcBad, rcStr].every(x => x.includes(T('rc.timeNA'))) && !/1970/.test(rcNone + rcBad + rcStr));
  h.MT.setLang('hi'); const rcHi = h.MT.staff.receiptHtml(entryOf('K 910', 'Asha Verma', Date.UTC(2026, 9, 28, 5, 30)), 'rv:gm');
  ok('the receipt follows the language: Hindi labels, Hindi department/clinic, Hindi date', rcHi.includes(h.MT.t('rc.token')) && /[ऀ-ॿ]/.test(rcHi) && rcHi.includes('सामान्य चिकित्सा') && rcHi.includes('Asha V.') && rcHi.includes(new Date(Date.UTC(2026, 9, 28, 5, 30)).toLocaleString('hi-IN', { dateStyle: 'medium', timeStyle: 'short' })));
  h.MT.setLang('en');
  ok('Escape (keydown on the staff frame) closes the idle sheet', (() => { stub(h); h.H.openWalk(); let prevented = 0; h.sf.fire('keydown', { key: 'Escape' }); const closed = h.P.walk === null; return closed; })());
  const hs = harness(); hs.signIn('op'); ok('opening the sheet after sign-in is possible for a fresh page (no leftover state)', (hs.H.openWalk(), hs.P.walk && hs.P.walk.stage === 'form'));
}

function partStatic() {
  const dict = (() => { const w = { MT: {} }; vm.runInContext(read('js/i18n.js'), vm.createContext({ window: w, document: { documentElement: {} }, localStorage: { getItem: () => null } })); return w.MT.DICT; })();
  const keys = Object.keys(dict).filter(k => /^(wk\.|rc\.|a\.reprint$|log\.assist$)/.test(k));
  ok('every walk-in / receipt string exists in English AND Hindi (Hindi in Devanagari, differing from English)', keys.length >= 38 && keys.every(k => dict[k][0] && dict[k][1] && dict[k][0] !== dict[k][1] && /[ऀ-ॿ]/.test(dict[k][1])), keys.filter(k => !(dict[k][0] && dict[k][1] && /[ऀ-ॿ]/.test(dict[k][1]))).join());
  const used = [...new Set([...read('js/staff.js').matchAll(/'((?:wk|rc)\.[A-Za-z0-9]+|a\.reprint)'/g)].map(m => m[1]))];
  ok('every user-facing key staff.js refers to is defined (no hard-coded or missing strings)', used.length > 25 && used.every(k => dict[k]), used.filter(k => !dict[k]).join());
  const staff = read('js/staff.js');
  ok('(static) no English sentences are hard-coded in the new walk-in markup', !/Register walk-in|Possible duplicate|Print receipt|Retry safely/.test(staff.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
  const css = read('css/styles.css'), html = read('index.html');
  const pm = css.match(/@media print\s*\{([\s\S]*?)\n\}\s*(?:\n|$)/), print = pm ? pm[1] : '';
  ok('(static) #receipt exists as a direct child of <body>, after the footer, before the scripts, hidden from assistive tech', /<\/footer>\s*(?:<!--[\s\S]*?-->\s*)?<div id="receipt" class="receipt" aria-hidden="true"><\/div>\s*<script src="js\/i18n\.js">/.test(html));
  ok('(static) on screen the receipt is display:none; the @media print block shows only #receipt and hides every other body child', /\.receipt\s*\{\s*display:\s*none;?\s*\}/.test(css) && /body > \*:not\(#receipt\)\s*\{\s*display:\s*none !important/.test(print) && /#receipt\s*\{[^}]*display:\s*block !important/.test(print));
  ok('(static) print layout: ~80 mm paper (@page size 80mm), 72 mm content, black on white, no shadows/animation, one-page slip', /@page\s*\{\s*size:\s*80mm auto/.test(print) && /width:\s*72mm/.test(print) && /background:\s*#fff !important/.test(print) && /color:\s*#000 !important/.test(print) && /box-shadow:\s*none !important/.test(print) && /break-inside:\s*avoid/.test(print));
  ok('(static) the screen/app styles are not touched by print rules (all .rc-* rules live inside @media print)', !/\.rc-[a-z]+\s*\{/.test(css.replace(print, '')));
  ok('(static) the sheet and receipt use no fixed widths that exceed a 375px phone (sheet is width:100%, receipt max-width:100%)', /\.sheet\s*\{[^}]*width:\s*100%/.test(css) && /max-width:\s*100%/.test(print));
}

/* ================= Part B: the real client against the real server ================= */
const OP_PW = crypto.randomBytes(12).toString('base64url'), AD_PW = crypto.randomBytes(12).toString('base64url');
async function buildServer(o) {
  o = o || {};
  const auth = { users: { operator: { role: 'op', hash: await A.hashPassword(OP_PW) }, admin: { role: 'admin', hash: await A.hashPassword(AD_PW) } }, demoCredentials: false, patientWeb: 'disabled', openControls: false, allowReset: false, secureCookie: false, proxyHeader: null, publicOrigin: null, warnings: [], queueMode: 'live' };
  const real = createApp({ dbPath: o.db || null, seedMode: 'empty', logError() {}, logInfo() {}, auth });
  await new Promise(r => real.server.listen(0, '127.0.0.1', r)); real.port = real.server.address().port; return real;
}
async function login(port, user, pw) {
  const r = await fetch('http://127.0.0.1:' + port + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user, password: pw }) });
  return r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
}
/* A real store.js in "server mode", wired to the real server through a fake XMLHttpRequest. net.mode decides what the network does to the next POSTs:
   pass | drop (the server processes the request, the browser never sees the answer) | fail (the request never reaches the server) | status:<n> | garbage | noentry */
function makeXHR(app, cookie, who, opts) {
  opts = opts || {}; const net = { mode: 'pass', sent: [], times: Infinity, stateFails: false };
  class XHR {
    open(m, u, a) { this.m = m; this.u = u; this.async = a !== false; this.h = {}; }
    setRequestHeader(k, v) { this.h[k] = v; }
    send(b) {
      if (!this.async) {                                          // the synchronous bootstrap / resync reads
        if (this.u === '/api/state') { if (net.stateFails) throw new Error('state read failed'); const s = app.snapshot(); this.status = 200; this.responseText = JSON.stringify({ rev: s.rev, epoch: s.epoch, shared: s.shared }); }
        else if (this.u === '/api/auth/me') { this.status = 200; this.responseText = JSON.stringify({ staff: who, patient: null, patientWeb: 'disabled', demoCredentials: false, openControls: false, mode: opts.mode || 'live' }); }
        else { this.status = 404; this.responseText = ''; }
        return;
      }
      net.sent.push({ u: this.u, body: b });
      if (net.times <= 0) net.mode = 'pass'; const mode = net.mode; net.times--;
      const later = f => setTimeout(f, 0), fin = (status, text) => { this.status = status; this.responseText = text; if (this.onload) this.onload(); };
      if (mode === 'fail') return void later(() => this.onerror && this.onerror());
      if (mode === 'timeout') return void later(() => this.ontimeout && this.ontimeout());
      if (mode === 'abort') return void later(() => this.onabort && this.onabort());
      if (mode === 'hang') return;                                // no event ever fires (only the client's own watchdog can settle it)
      if (mode.startsWith('status:')) return void later(() => fin(Number(mode.slice(7)), '{"error":"x"}'));
      if (mode.startsWith('bare:')) return void later(() => fin(Number(mode.slice(5)), ''));          // e.g. the 400 Node writes for a connection-level parse error: no JSON, never reached the application
      const canned = { garbage: '<html>oops', noentry: '{"ok":true,"result":{"ok":true},"rev":1}', resultarray: '{"ok":true,"result":[],"rev":1}', resultnull: '{"ok":true,"result":null,"rev":1}', entrybad: '{"ok":true,"result":{"ok":true,"key":"rv:gm","entry":{"tok":"K 9"}},"rev":1}', errnum: '{"ok":true,"result":{"err":7},"rev":1}', emptyobj: '{}', array: '[]', jsonnull: 'null' };
      if (canned[mode] !== undefined) return void later(() => fin(200, canned[mode]));
      fetch('http://127.0.0.1:' + app.port + this.u, { method: this.m, headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: b }).then(async r => {
        const text = await r.text(); if (mode === 'drop') return this.onerror && this.onerror(); fin(r.status, text);
      }).catch(() => this.onerror && this.onerror());
    }
  }
  return { XHR, net };
}
function clientFor(app, cookie, who, opts) {
  opts = opts || {}; const { XHR, net } = makeXHR(app, cookie, who, opts);  const window = { addEventListener() {}, MT: undefined }, store = {};
  const ctx = vm.createContext({ window, document: { querySelector: () => null, body: null, documentElement: {} }, location: { protocol: 'http:' }, localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); }, removeItem() {} },
    XMLHttpRequest: opts.noServer ? undefined : XHR, console: { log() {}, error() {} }, setTimeout: opts.setTimeout || setTimeout, clearTimeout: opts.clearTimeout || clearTimeout, Promise, Date });
  if (opts.noServer) ctx.location = { protocol: 'file:' };
  vm.runInContext(read('js/store.js'), ctx, { filename: 'store.js' });
  const S = window.MT.store; let localRuns = 0; const orig = S.registerAssisted; S.registerAssisted = (...a) => { localRuns++; return orig(...a); };
  return { S, net, localRuns: () => localRuns, MT: window.MT, XHR };
}

async function partB() {
  const rid = () => crypto.randomBytes(12).toString('base64url'), K = 'rv:gm';
  const dbFile = path.join(dir, 'b.db'); const app = await buildServer({ db: dbFile }), port = app.port;
  const adC = await login(port, 'admin', AD_PW), opC = await login(port, 'operator', OP_PW);
  const q = () => app.S.get().q[K], n = () => q().length;

  let c = clientFor(app, adC, { user: 'admin', role: 'admin' });
  ok('real client in server mode: the page is live-mode and the registration helper is the HTTP one', c.MT.serverMode === true && c.MT.auth.mode === 'live');
  const R1 = rid(), r1 = await c.S.assisted(K, 'Asha Verma', R1);
  ok('success: the client returns the SERVER\'s entry (id, token, name, status wait, time, role) and key, and never runs registerAssisted locally', r1.ok && r1.replayed === false && r1.key === K && r1.entry.tok === q()[0].tok && r1.entry.st === 'wait' && typeof r1.entry.at === 'number' && r1.entry.rby === 'admin' && n() === 1 && c.localRuns() === 0);
  ok('exactly one HTTP request was made: POST /api/action with [key, name, rid] only (no confirm, no client-built state)', c.net.sent.length === 1 && c.net.sent[0].u === '/api/action' && JSON.stringify(JSON.parse(c.net.sent[0].body)) === JSON.stringify({ method: 'registerAssisted', args: [K, 'Asha Verma', R1] }));
  ok('the browser store picked up the server state afterwards (the new entry is in its queue)', c.S.get().q[K].some(e => e.tok === r1.entry.tok && e.name === 'Asha Verma'));

  const rLost = rid(); c.net.mode = 'drop'; c.net.times = 1;
  const lost = await c.S.assisted(K, 'Lost Reply', rLost);
  ok('LOST RESPONSE: the server created the entry but the browser saw a network error -> "uncertain" (never success)', lost.uncertain === true && !lost.ok && n() === 2 && q()[1].name === 'Lost Reply');
  const retry = await c.S.assisted(K, 'Lost Reply', rLost);
  ok('retry with the SAME request id returns the existing entry (replayed) - still 2 entries, the counter advanced once', retry.ok && retry.replayed === true && retry.entry.tok === q()[1].tok && n() === 2 && app.S.get().ctr[K] === 3);

  const rF = rid(); c.net.mode = 'fail'; c.net.times = 2;
  const f1 = await c.S.assisted(K, 'Never Sent', rF), f2 = await c.S.assisted(K, 'Never Sent', rF);
  ok('request that never reaches the server (offline): uncertain twice, nothing created; the retry afterwards creates exactly one', f1.uncertain && f2.uncertain && n() === 2 && (await c.S.assisted(K, 'Never Sent', rF)).ok && n() === 3);

  const bad = {};
  for (const m of ['status:500', 'status:502', 'status:503', 'garbage', 'noentry']) { c.net.mode = m; c.net.times = 1; bad[m] = await c.S.assisted(K, 'Odd Reply', rid()); }
  ok('5xx, a non-JSON reply and a "success" without an entry are all treated as UNCERTAIN (never as success)', Object.values(bad).every(r => r.uncertain === true && !r.ok) && n() === 3, JSON.stringify(bad));
  c.net.mode = 'status:429'; c.net.times = 1; const b429 = await c.S.assisted(K, 'Slow Down', rid()); c.net.mode = 'status:400'; c.net.times = 1; const b400 = await c.S.assisted(K, 'Bad Req', rid());
  c.net.mode = 'bare:400'; c.net.times = 1; const bare = await c.S.assisted(K, 'Bare 400', rid());
  ok('429 is "busy" and a JSON 400 is "bad": definite refusals with nothing created; a BARE 400 (no JSON body: connection-level, never reached the app) is uncertain so it is retried safely instead of shown as a failure', b429.err === 'busy' && b400.err === 'bad' && bare.uncertain === true && n() === 3);

  const d1 = await c.S.assisted(K, 'ASHA   verma', rid());
  ok('duplicate: the server answer {err:"dupWarn", dup:[{id,tok,st}]} reaches the UI unchanged and NOTHING is created', d1.err === 'dupWarn' && d1.dup.length === 1 && d1.dup[0].tok === r1.entry.tok && Object.keys(d1.dup[0]).sort().join() === 'id,st,tok' && n() === 3);
  const RD = rid(); const w = await c.S.assisted(K, 'Same Name', rid()); const w2 = await c.S.assisted(K, 'same name', RD); const sentBefore = c.net.sent.length;
  const cf = await c.S.assisted(K, 'same name', RD, true), cf2 = await c.S.assisted(K, 'same name', RD, true);
  ok('explicit confirmation (same request id, confirm=true) creates ONE entry; repeating it replays that entry', w.ok && w2.err === 'dupWarn' && cf.ok && cf.replayed === false && cf2.ok && cf2.replayed === true && cf2.entry.tok === cf.entry.tok && n() === 5 && JSON.parse(c.net.sent[sentBefore].body).args[3] === true);
  const burst = await Promise.all(Array.from({ length: 8 }, () => c.S.assisted(K, 'Burst Person', 'burstburstburst01')));
  ok('8 simultaneous submissions with one request id: one entry is created, all callers get that same token', burst.every(r => r.ok && r.entry.tok === burst[0].entry.tok) && burst.filter(r => r.replayed === false).length === 1 && q().filter(e => e.name === 'Burst Person').length === 1);

  const op = clientFor(app, opC, { user: 'operator', role: 'op' }), out = await op.S.assisted('lv:gp', 'Wrong Clinic', rid());
  ok('authorization is the server\'s: an operator outside Riverside gets {err:"forbidden"} (HTTP 403) and nothing is created', out.err === 'forbidden' && app.S.get().q['lv:gp'].length === 0);
  const anon = clientFor(app, '', { user: 'admin', role: 'admin' }), au = await anon.S.assisted(K, 'No Cookie', rid());
  ok('a browser without a valid staff session gets {err:"auth"} (HTTP 401) even if its page believes it is signed in', au.err === 'auth' && n() === 6, JSON.stringify([au, n()]));
  const cl = await c.S.assisted('rv:dn', 'Closed Service', rid());
  ok('a closed service is refused by the server with "closed"', cl.err === 'closed');
  const long = await c.S.assisted(K, 'z'.repeat(60), rid());
  ok('an over-long name that slips past the form is still refused by the server ("name")', long.err === 'name' && n() === 6, JSON.stringify([long, n()]));

  // restart: the id memory survives
  const snap = JSON.stringify(app.snapshot().shared); app.close(); await sleep(80);
  const app2 = await buildServer({ db: dbFile }); const ad2 = await login(app2.port, 'admin', AD_PW), c2 = clientFor(app2, ad2, { user: 'admin', role: 'admin' });
  const again = await c2.S.assisted(K, 'Lost Reply', rLost);
  ok('after a server restart a retry of an old request still returns the same entry (id memory is persisted)', again.ok && again.replayed === true && again.entry.tok === retry.entry.tok && JSON.stringify(app2.snapshot().shared) === snap);
  app2.close();

  // ---- demo isolation ----
  const dbIso = path.join(dir, 'iso.db'), real = await buildServer({ db: dbIso }), site = assembleSite(real, { demoTelegramIds: '' });
  const demoCookie = await login(real.port, 'operator', 'demo'); const demoApp = site.demo; demoApp.port = real.port;      // the demo is served on the same port: routing is by cookie
  const realSnap = JSON.stringify(real.snapshot().shared), realRev = real.getRev();
  const dc = clientFor(demoApp, demoCookie, { user: 'operator', role: 'op' }, { mode: 'demo' });
  const dr = await dc.S.assisted(K, 'Demo Walkin', rid()), dd = await dc.S.assisted(K, 'demo walkin', rid());
  ok('DEMO mode (server): the walk-in goes to the demo queue through the demo session; duplicates behave the same there', dr.ok && dd.err === 'dupWarn' && demoApp.S.get().q[K].some(e => e.name === 'Demo Walkin' && e.src === 'staff'));
  ok('the REAL queue and real database are untouched by demo registrations (same revision, byte-identical state, file empty)', real.getRev() === realRev && JSON.stringify(real.snapshot().shared) === realSnap && !realSnap.includes('Demo Walkin') && (() => { const d = new (require('node:sqlite').DatabaseSync)(dbIso, { readOnly: true }); try { const s = JSON.parse(d.prepare('SELECT shared FROM app_state WHERE id = 1').get().shared); return Object.values(s.q).every(l => l.length === 0); } finally { d.close(); } })());
  const realCookie = await login(real.port, 'admin', AD_PW), rcl = clientFor(real, realCookie, { user: 'admin', role: 'admin' }), rr = await rcl.S.assisted(K, 'Demo Walkin', rid());
  ok('the same name in the real queue is NOT a duplicate of the demo entry (separate queues) and lands in the real queue only', rr.ok && real.S.get().q[K].length === 1 && demoApp.S.get().q[K].filter(e => e.name === 'Demo Walkin').length === 1);
  site.close(); real.close();

  // ---- no server at all (static page): local simulation, no network ----
  const loc = clientFor(app2, '', null, { noServer: true });
  loc.S.staffLogin('operator', 'demo'); loc.S.openSession('rv:gm');
  const lr = await loc.S.assisted(K, 'Local Only', rid()), lr2 = await loc.S.assisted(K, 'local only', rid());
  ok('static/local demo: no server exists, so NO network request is possible; the local simulation answers with the same result shape (entry, dupWarn) and only local state changes', loc.MT.serverMode !== true && loc.net.sent.length === 0 && lr.ok && lr.entry.tok && lr2.err === 'dupWarn' && loc.S.get().q[K].some(e => e.name === 'Local Only'));
}


/* ================= Part C: regression tests for the "server created it but the sheet did not show it" failure =================
   ROOT CAUSE (reproduced in a real browser, 5 of 16 registrations with a concurrent demo reset): the server pushes a new epoch whenever the shared demo is reset;
   the browser then drops its selected staff session, and render() closed the walk-in sheet because "the session changed" - while a request was in flight or already
   confirmed. The answer to a request that HAD created a token was discarded silently (stale-callback guard), so staff saw nothing. */
async function partC() {
  const rejections = []; const onRej = e => rejections.push(String(e)); process.on('unhandledRejection', onRej);
  const T = (h, k) => h.MT.t(k);
  const loseSession = h => { h.S.get().staff.sess = null; h.MT.staff.render(); };          // what clearSessions()+applyMe() do on a new epoch
  const ENTRY = (tok, name) => ({ id: 'rv:gm#' + Number(tok.slice(2)), tok, name: name || 'Ravi Kumar', st: 'wait', at: Date.now(), rby: 'op' });

  // --- the reproduced failure: session lost while the request is in flight ---
  let h = harness(); h.signIn('op'); let calls = stub(h);
  h.H.openWalk(); type(h, 'Epoch Race'); h.H.wkSubmit(); const w0 = h.P.walk;
  loseSession(h);
  ok('REGRESSION: a session reset (new epoch) while the registration is in flight does NOT close the sheet or orphan the request', h.P.walk === w0 && w0.busy && /role="dialog"/.test(h.sf.innerHTML));
  calls.deferreds[0].resolve({ ok: true, replayed: false, key: 'rv:gm', entry: ENTRY('K 321') }); await flush();
  ok('REGRESSION: the server-created entry is shown with its receipt even though the session was reset meanwhile', h.P.walk === w0 && w0.stage === 'done' && h.sf.innerHTML.includes('K 321') && h.receipt.innerHTML.includes('K 321'));
  loseSession(h); ok('a confirmed receipt also survives further session resets (staff can still print it)', h.P.walk === w0 && h.receipt.innerHTML.includes('K 321'));
  h.S.staffLogout(); h.MT.staff.render(); ok('signing out ends the sheet and clears the receipt', h.P.walk === null && h.receipt.innerHTML === '');

  h = harness(); h.signIn('op'); calls = stub(h); h.H.openWalk(); type(h, 'Uncertain Reset'); h.H.wkSubmit(); calls.deferreds[0].resolve({ uncertain: true }); await flush(); const wu = h.P.walk; loseSession(h);
  ok('an UNCERTAIN attempt survives a session reset, so staff can still retry it with the same request id', h.P.walk === wu && wu.stage === 'uncertain' && (h.H.wkRetry(), calls.length === 2 && calls[1][2] === calls[0][2]));
  h = harness(); h.signIn('op'); stub(h); h.H.openWalk(); type(h, 'Idle Form'); loseSession(h);
  ok('an untouched form whose session is gone is closed (nothing pending or created there)', h.P.walk === null);
  h = harness(); h.signIn('op'); calls = stub(h); h.H.openWalk(); type(h, 'Dup Idle'); h.H.wkSubmit(); calls.deferreds[0].resolve({ err: 'dupWarn', dup: [{ id: 'a', tok: 'K 1', st: 'wait' }] }); await flush(); loseSession(h);
  ok('an idle duplicate prompt whose session is gone is closed; no entry was created', h.P.walk === null && calls.length === 1);

  // --- duplicate responses always render the duplicate state ---
  const shapes = [['full list', { err: 'dupWarn', dup: [{ id: 'a', tok: 'K 044', st: 'wait' }] }, 1], ['empty list', { err: 'dupWarn', dup: [] }, 0], ['no list', { err: 'dupWarn' }, 0], ['list not an array', { err: 'dupWarn', dup: 'x' }, 0]];
  for (const [name, resp, n] of shapes) {
    h = harness(); h.signIn('op'); calls = stub(h); h.H.openWalk(); type(h, 'Dup Shape'); h.H.wkSubmit(); calls.deferreds[0].resolve(resp); await flush();
    ok('duplicate response (' + name + ') renders the duplicate-warning state with Register anyway / Cancel, never a generic failure', h.P.walk.stage === 'dup' && !h.P.walk.err && h.sf.innerHTML.includes(T(h, 'wk.dupGo')) && !h.sf.innerHTML.includes(T(h, 'wk.errGeneric')) && h.P.walk.dup.length === n);
  }

  // --- no false success from malformed / rejected answers ---
  const odd = [['undefined', undefined], ['null', null], ['empty object', {}], ['ok without entry', { ok: true }], ['entry without id', { ok: true, key: 'rv:gm', entry: { tok: 'K 9' } }], ['entry without token', { ok: true, key: 'rv:gm', entry: { id: 'x' } }], ['ok:"true" string', { ok: 'true', entry: ENTRY('K 9') }], ['numeric err', { err: 7 }], ['array', []], ['string', 'ok']];
  for (const [name, resp] of odd) {
    h = harness(); h.signIn('op'); calls = stub(h); h.H.openWalk(); type(h, 'Odd Reply'); h.H.wkSubmit(); calls.deferreds[0].resolve(resp); await flush();
    ok('malformed answer (' + name + ') is never success: explicit uncertain state, no receipt, retry keeps the id', h.P.walk.stage === 'uncertain' && h.receipt.innerHTML === '' && !h.sf.innerHTML.includes(T(h, 'wk.okT')) && (h.H.wkRetry(), calls.length === 2 && calls[1][2] === calls[0][2]));
  }
  h = harness(); h.signIn('op'); h.S.assisted = () => Promise.reject(new Error('boom')); h.H.openWalk(); type(h, 'Rejects'); h.H.wkSubmit(); await flush();
  ok('a rejected/throwing registration helper becomes the uncertain state (no unhandled rejection, no success)', h.P.walk.stage === 'uncertain' && h.receipt.innerHTML === '' && rejections.length === 0, rejections.join());
  h = harness(); h.signIn('op'); calls = stub(h); h.H.openWalk(); type(h, 'Weird Code'); h.H.wkSubmit(); calls.deferreds[0].resolve({ err: 'weird_code' }); await flush();
  ok('an unrecognised refusal shows the generic message WITH its code, so a future occurrence can be diagnosed', h.P.walk.stage === 'form' && h.sf.innerHTML.includes(T(h, 'wk.errGeneric')) && h.sf.innerHTML.includes('(weird_code)'));

  // --- a drawing error can never hide a confirmed registration ---
  h = harness(); h.signIn('op'); calls = stub(h); h.H.openWalk(); type(h, 'Render Boom'); h.H.wkSubmit();
  const realRender = h.MT.renderInto; let boomed = 0; h.MT.renderInto = (e, html) => { if (!boomed++) throw new Error('render boom'); realRender(e, html); };
  calls.deferreds[0].resolve({ ok: true, replayed: false, key: 'rv:gm', entry: ENTRY('K 654') }); await flush();
  ok('if drawing the result throws, the confirmed token is still shown in a plain fallback and the state is "done" (no silent failure)', boomed >= 1 && h.P.walk.stage === 'done' && h.sf.innerHTML.includes('K 654') && h.errors.some(e => /walk-in render failed/.test(e)) && rejections.length === 0, JSON.stringify([boomed, h.P.walk.stage, h.sf.innerHTML.slice(0, 120)]));
  h.MT.renderInto = realRender;

  // --- concurrent UI events cannot overwrite a newer request ---
  h = harness(); h.signIn('op'); calls = stub(h); h.H.openWalk(); type(h, 'Person A'); h.H.wkSubmit(); const wA = h.P.walk;
  h.H.openWalk(); type(h, 'Intruder'); ok('while a request is in flight a second sheet cannot be opened and typing cannot change the name being registered', h.P.walk === wA && wA.name === 'Person A' && (h.H.wkConfirm(), h.H.wkRetry(), h.H.wkSubmit(), calls.length === 1));
  h.S.staffLogout(); h.MT.staff.render(); ok('(setup) signing out mid-flight drops the sheet of request A', h.P.walk === null);
  h.signIn('op'); h.H.openWalk(); type(h, 'Person B'); h.H.wkSubmit(); const wB = h.P.walk; const ridB = calls[1][2];
  calls.deferreds[0].resolve({ ok: true, replayed: false, key: 'rv:gm', entry: ENTRY('K 501', 'Person A') }); await flush();
  ok('a LATE answer for the old request cannot touch the newer request or show the old patient\'s receipt', h.P.walk === wB && wB.busy && wB.stage === 'form' && h.receipt.innerHTML === '' && wA.stage === 'form');
  calls.deferreds[1].resolve({ ok: true, replayed: false, key: 'rv:gm', entry: ENTRY('K 502', 'Person B') }); await flush();
  ok('the newer request\'s own answer is applied: its token and nothing from the older one', wB.stage === 'done' && h.receipt.innerHTML.includes('K 502') && !h.receipt.innerHTML.includes('K 501') && calls[1][2] === ridB);

  // --- end to end with the REAL client store, the REAL staff UI and the REAL server: lost answers, retries, session reset ---
  const app = await buildServer({ db: path.join(dir, 'c.db') }), cookie = await login(app.port, 'admin', AD_PW), { XHR, net } = makeXHR(app, cookie, { user: 'admin', role: 'admin' });
  const q = () => app.S.get().q['rv:gm'];
  const modes = ['drop', 'fail', 'timeout', 'abort', 'bare:400', 'bare:413', 'bare:415', 'status:500', 'status:503', 'garbage', 'noentry', 'resultarray', 'resultnull', 'entrybad', 'emptyobj', 'array', 'jsonnull'];
  const out = [];
  for (const mode of modes) {
    const hh = harness({ xhr: XHR }); hh.S.openSession('rv:gm'); hh.MT.staff.render(); const before = q().length, ctr = app.S.get().ctr['rv:gm'];
    hh.H.openWalk(); type(hh, 'Net ' + mode.replace(/\W/g, '')); net.mode = mode; net.times = 1; net.sent.length = 0; hh.H.wkSubmit(); await until2(() => hh.P.walk.stage !== 'form' || !hh.P.walk.busy);
    const created = q().length - before, st1 = hh.P.walk.stage;
    hh.H.wkRetry(); await until2(() => hh.P.walk.stage === 'done');
    const sent = net.sent.map(s => JSON.parse(s.body).args), sameRid = sent.every(a => a[2] === sent[0][2]);
    out.push({ mode, st1, created, done: hh.P.walk.stage, tok: hh.P.walk.entry && hh.P.walk.entry.tok, total: q().length - before, ctr: app.S.get().ctr['rv:gm'] - ctr, sameRid, shown: hh.receipt.innerHTML.includes(hh.P.walk.entry ? hh.P.walk.entry.tok : '??'), matchesServer: q().some(e => hh.P.walk.entry && e.tok === hh.P.walk.entry.tok && e.name === 'Net ' + mode.replace(/\W/g, '')) });
  }
  ok('END TO END (14 failure modes): the first answer is never "done" unless it carries the entry; the UI then shows an explicit uncertain state', out.every(o => o.st1 === 'uncertain'), JSON.stringify(out.filter(o => o.st1 !== 'uncertain')));
  ok('END TO END: every retry reuses the original request id and ends in a confirmed receipt for exactly ONE server entry (one token consumed)', out.every(o => o.sameRid && o.done === 'done' && o.total === 1 && o.ctr === 1 && o.shown && o.matchesServer), JSON.stringify(out.filter(o => !(o.sameRid && o.done === 'done' && o.total === 1 && o.ctr === 1 && o.shown && o.matchesServer))));
  const lostOnes = out.filter(o => o.mode === 'drop'); ok('END TO END: a dropped answer had created the entry on the server (created=1) and the replay returned the same token', lostOnes.every(o => o.created === 1 && o.total === 1));

  // dup + lost confirmation, end to end
  const hd = harness({ xhr: XHR }); hd.S.openSession('rv:gm'); hd.MT.staff.render(); const nBefore = q().length;
  hd.H.openWalk(); type(hd, 'Twin Person'); hd.H.wkSubmit(); await until2(() => hd.P.walk.stage === 'done'); hd.H.wkClose();
  hd.H.openWalk(); type(hd, 'twin person'); net.sent.length = 0; hd.H.wkSubmit(); await until2(() => hd.P.walk.stage === 'dup');
  ok('END TO END: a real duplicate answer from the server renders the duplicate state (not "Could not register")', hd.P.walk.stage === 'dup' && hd.P.walk.dup.length === 1 && hd.sf.innerHTML.includes(T(hd, 'wk.dupGo')) && !hd.sf.innerHTML.includes(T(hd, 'wk.errGeneric')) && q().length === nBefore + 1);
  net.mode = 'drop'; net.times = 1; hd.H.wkConfirm(); await until2(() => hd.P.walk.stage === 'uncertain'); const mid = q().length;
  hd.H.wkRetry(); await until2(() => hd.P.walk.stage === 'done'); const ids = net.sent.map(s => JSON.parse(s.body).args);
  ok('END TO END: a confirmed duplicate whose answer is lost is retried with the SAME id and confirm=true and yields exactly one extra entry', mid === nBefore + 2 && q().length === nBefore + 2 && ids.length === 3 && ids.every(a => a[2] === ids[0][2]) && ids[1][3] === true && ids[2][3] === true && ids[0][3] === undefined && hd.receipt.innerHTML.includes(hd.P.walk.entry.tok));

  // reset of the session mid-flight, end to end
  const hr = harness({ xhr: XHR }); hr.S.openSession('rv:gm'); hr.MT.staff.render(); hr.H.openWalk(); type(hr, 'Reset Mid Flight'); hr.H.wkSubmit(); loseSession(hr); await until2(() => hr.P.walk && hr.P.walk.stage === 'done');
  ok('END TO END: the reproduced failure - session reset while the real request is in flight - now ends in a confirmed receipt for the created entry', hr.P.walk.stage === 'done' && hr.receipt.innerHTML.includes(hr.P.walk.entry.tok) && q().some(e => e.tok === hr.P.walk.entry.tok && e.name === 'Reset Mid Flight'));
  app.close();

  // --- timeouts: the client never waits forever ---
  const timers = []; const fakeST = (f, ms) => { timers.push({ f, ms, live: true }); return timers.length; }, fakeCT = id => { if (timers[id - 1]) timers[id - 1].live = false; };
  const app2 = await buildServer({}), ck2 = await login(app2.port, 'admin', AD_PW), c = clientFor(app2, ck2, { user: 'admin', role: 'admin' }, { setTimeout: fakeST, clearTimeout: fakeCT });
  c.net.mode = 'hang'; c.net.times = 1; let settled = null; const pending = c.S.assisted('rv:gm', 'Hang Person', 'hanghanghanghang01').then(r => { settled = r; }); await flush();
  const dog = timers.find(t => t.live && t.ms === 15000);
  ok('when no XHR event ever fires, a 15 s watchdog (longer than the 12 s XHR timeout) settles the call as uncertain', !!dog && settled === null && (dog.f(), await pending, settled && settled.uncertain === true) && app2.S.get().q['rv:gm'].length === 0, JSON.stringify([!!dog, settled]));
  const retryOk = await c.S.assisted('rv:gm', 'Hang Person', 'hanghanghanghang01');
  ok('after a watchdog timeout the retry with the same id creates exactly one entry', retryOk.ok && app2.S.get().q['rv:gm'].length === 1);
  c.net.mode = 'pass'; const xs = c.net.sent.length; await c.S.assisted('rv:gm', 'Hang Person', 'hanghanghanghang01'); ok('a replayed call still makes exactly one request', c.net.sent.length === xs + 1);
  const live15 = timers.filter(t => t.ms === 15000 && t.live).length; ok('(timers) every completed call cleared its own watchdog', live15 === 0, String(live15));
  c.net.stateFails = true; const rf = await c.S.assisted('rv:gm', 'Resync Fails', 'resyncfailsresync1');
  ok('if the follow-up state read throws, the call still settles with the confirmed entry', rf.ok === true && rf.entry.tok && app2.S.get().q['rv:gm'].length === 2);
  app2.close();
  process.off('unhandledRejection', onRej);
  ok('no unhandled promise rejection happened in any scenario above', rejections.length === 0, rejections.join());
}
const until2 = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(5); } return false; };
(async () => {
  try { await partA(); partStatic(); await partB(); await partC(); } catch (e) { ok('test run crashed', false, e.stack); }
  const fail = res.filter(r => r.startsWith('FAIL'));
  process.stdout.write(res.join('\n') + '\n\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed\n');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail.length ? 1 : 0);
})();
