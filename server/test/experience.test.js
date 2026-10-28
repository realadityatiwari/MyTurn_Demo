/* One root page, two isolated queues. Real server code (createApp x2 + front router + bot) over real HTTP, against a LOCAL FAKE of the Telegram
   Bot API (no real token, no network). Proves: the root page is the full demo; the demo queue is isolated from the real queue in both directions;
   which queue a request/Telegram user reaches is decided by the server only; auth, webhook secret, rate limits and the proxy gate still apply;
   the page hides controls that cannot work. Run: node server/test/experience.test.js */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto'), vm = require('vm');
const { createApp, assembleSite } = require('../server');
const { start } = require('../bot');
const { parseDemoIds } = require('../front');
const A = require('../auth');

const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-exp-'));
const REAL_PW = crypto.randomBytes(12).toString('base64url');            // test-only, never printed
const TOKEN = '987654321:' + crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x'), SECRET = crypto.randomBytes(32).toString('base64url');
const DEMO_TG = 777001, REAL_TG = 888001;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(20); } return false; };
const logged = []; for (const k of ['log', 'warn']) { const o = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); }; }

// ---- fake Telegram Bot API ----
const sent = [], calls = [];
const fake = http.createServer((req, rs) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/), body = b ? JSON.parse(b) : {};
    if (!m || m[1] !== TOKEN) { rs.writeHead(401); return rs.end('{"ok":false,"error_code":401}'); }
    calls.push(m[2]); const reply = r => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ ok: true, result: r })); };
    if (m[2] === 'getMe') return reply({ username: 'fake_bot' }); if (m[2] === 'sendMessage') { sent.push(body); return reply({ message_id: 1 }); }
    return reply(true);
  });
});
const uid = (() => { let n = 9000; return () => n++; })();
const cbq = (id, data) => ({ update_id: uid(), callback_query: { id: 'q' + uid(), from: { id, first_name: 'User' + id }, message: { chat: { id, type: 'private' } }, data } });
const msg = (id, text) => ({ update_id: uid(), message: { chat: { id, type: 'private' }, from: { id, first_name: 'User' + id }, text } });
const lastTo = chat => sent.filter(s => s.chat_id === chat).slice(-1).map(s => s.text).join('');

class Client {
  constructor(port, extra) { this.port = port; this.jar = {}; this.extra = extra || {}; }
  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => k + '=' + v).join('; '); }
  async req(method, p, body, headers) {
    const h = Object.assign({}, this.extra, headers || {}); if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (Object.keys(this.jar).length && !h.Cookie) h.Cookie = this.cookieHeader();
    const r = await fetch('http://127.0.0.1:' + this.port + p, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.getSetCookie(); for (const c of sc) { const [kv] = c.split(';'), i = kv.indexOf('='), v = kv.slice(i + 1); if (v === '') delete this.jar[kv.slice(0, i)]; else this.jar[kv.slice(0, i)] = v; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text, headers: r.headers, setCookie: sc };
  }
  act(method, args, extra) { return this.req('POST', '/api/action', Object.assign({ method, args: args || [] }, extra)); }
  login(user, password) { return this.req('POST', '/api/auth/login', { user, password }); }
  state() { return this.req('GET', '/api/state'); }
  me() { return this.req('GET', '/api/auth/me').then(r => r.json); }
}
const hook = (port, upd, secret) => fetch('http://127.0.0.1:' + port + '/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret === undefined ? SECRET : secret }, body: JSON.stringify(upd) }).then(async r => ({ status: r.status, text: await r.text() }));

const rows = (app, id) => Object.values(app.S.get().q).flat().filter(e => e.acct === 'tg:' + id);
const visits = app => Object.values(app.S.get().q).reduce((n, l) => n + l.length, 0);

async function build(o) {
  o = o || {};
  const realCfg = { users: { admin: { role: 'admin', hash: await A.hashPassword(REAL_PW) } }, demoCredentials: false, patientWeb: 'disabled', openControls: false, allowReset: false, secureCookie: false, proxyHeader: null, publicOrigin: null, warnings: [], queueMode: 'live' };
  const real = createApp({ dbPath: o.db || null, seedMode: 'empty', logError() {}, auth: Object.assign(realCfg, o.realAuth || {}), peerAddress: o.peer, logInfo() {} });
  const site = assembleSite(real, { demoTelegramIds: o.demoIds === undefined ? String(DEMO_TG) : o.demoIds, demoExtra: { logError() {}, peerAddress: o.peer, logInfo() {} } });
  await new Promise(r => real.server.listen(0, '127.0.0.1', r)); real.port = real.server.address().port;
  return { real, site, demo: site.demo, port: real.port, close() { site.close(); real.close(); } };
}

(async () => {
  try {
    await new Promise(r => fake.listen(0, '127.0.0.1', r)); const apiBase = 'http://127.0.0.1:' + fake.address().port;
    const dbFile = path.join(dir, 'real.db');
    let X = await build({ db: dbFile }); const { real, demo } = X, port = X.port;
    const bot = start({ app: X.site.tgApp, token: TOKEN, apiBase, log() {}, mode: 'webhook', secret: SECRET }); real.setTelegram('webhook', { secret: SECRET, handle: bot.handleUpdate }); await sleep(100);
    const realSnap0 = JSON.stringify(real.snapshot().shared), realRev0 = real.getRev();

    // ================= the root page =================
    const anon = new Client(port), home = await anon.req('GET', '/'), homeQ = await anon.req('GET', '/?sample=1'), homeM = await anon.req('GET', '/?mode=live&real=1', undefined, { 'X-Mode': 'live' });
    ok('/ is the single page: full UI (both phones, walkthrough host, scenario controls, language toggle slot, mode note), identical whatever query string or header is sent', home.status === 200 && ['id="pf"', 'id="sf"', 'id="script"', 'id="ctl"', 'id="site-lang"', 'id="mode-note"'].every(s => home.text.includes(s)) && home.text === homeQ.text && home.text === homeM.text);
    ok('no ?sample=1 and no separate live landing: the page has no sample/live-clinic page content', !/sample-note|\?sample=1/.test(home.text + fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'js', 'store.js'), 'utf8')));
    const me0 = await anon.me();
    ok('an anonymous visitor is served the DEMO queue: mode "demo", public demo sign-ins, demo patient sign-in, open controls (decided by the server)', me0.mode === 'demo' && me0.demoCredentials === true && me0.patientWeb === 'demo' && me0.openControls === true && me0.staff === null);
    const st0 = (await anon.state()).json.shared;
    ok('the demo queue has sample content (scenario normal, 9 visits in the shared queue) while the REAL queue is empty', st0.scenario === 'normal' && visits(demo) === 9 && st0.q['rv:gm'].length === 6 && visits(real) === 0 && real.S.get().scenario === 'empty');
    ok('anonymous visitors get only statuses (no names/tokens/accounts) even on the demo queue, as before', st0.q['rv:gm'].every(e => Object.keys(e).sort().join() === 'id,st,tok') && Object.keys(st0.accounts).length === 0);

    // ================= demo: full interactive experience =================
    const dstaff = new Client(port), dl = await dstaff.login('operator', 'demo');
    ok('demo staff sign-in (operator/demo) works and sets the DEMO cookie (mtd_staff), never the real one', dl.status === 200 && dl.json.role === 'op' && dl.setCookie.some(c => /^mtd_staff=/.test(c)) && !dl.setCookie.some(c => /^mt_staff=/.test(c)));
    const sv = (await dstaff.state()).json.shared;
    ok('demo staff see the sample queue with names (K 038-K 043) and the audit', sv.q['rv:gm'].length === 6 && sv.q['rv:gm'].every(e => e.name) && (await dstaff.me()).mode === 'demo');
    const dpat = new Client(port); await dpat.act('patientSignIn', ['9876543210']); const dme = await dpat.me();
    ok('demo patient dashboard: sample patient 9876543210 signs in and has its saved profiles', dme.patient && dme.patient.phone === '9876543210' && demo.S.get().accounts['9876543210'].profiles.length === 3);
    const pr = await dpat.act('register', ['rv:gm', 'p1']); const myEntry = demo.S.get().q['rv:gm'].find(e => e.acct === '9876543210');
    ok('demo patient registers; staff mark arrived and the token is visible on both sides (shared state works inside the demo)', pr.json.result.ok && myEntry && (await dstaff.act('markArrived', [myEntry.id])).json.result.ok && demo.S.get().q['rv:gm'].find(e => e.id === myEntry.id).st === 'wait');
    const ctl = [(await anon.act('reset', ['missed'])).status, (await anon.act('tick')).status, (await anon.act('reset', ['normal'])).status];
    ok('scenario switch, queue stepping and Reset demo work from the page for anyone - on the DEMO queue', ctl.join() === '200,200,200' && demo.S.get().scenario === 'normal' && visits(demo) === 9);
    ok('demo staff actions still need a staff session (anonymous callNext/markArrived/resetQueue -> 401)', [(await anon.act('callNext', ['rv:gm'])).status, (await anon.act('markArrived', ['x'])).status, (await anon.act('resetQueue', ['rv:gm'])).status].join() === '401,401,401');

    // ================= isolation: demo -> real =================
    ok('after all demo activity the REAL queue is byte-identical (same revision, same state, no demo data) and nothing was written to the real database', real.getRev() === realRev0 && JSON.stringify(real.snapshot().shared) === realSnap0 && (() => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(dbFile, { readOnly: true }); try { const r = d.prepare('SELECT rev, shared FROM app_state WHERE id = 1').get(); const s = JSON.parse(r.shared); return r.rev === realRev0 && Object.values(s.q).every(l => l.length === 0) && Object.keys(s.accounts).length === 0 && s.scenario === 'empty'; } finally { d.close(); } })());

    // ================= real staff: the real queue, server-verified =================
    const rstaff = new Client(port), rbad = await rstaff.login('admin', 'wrong-password-123'), rl = await rstaff.login('admin', REAL_PW), rme = await rstaff.me();
    ok('real staff sign-in needs the REAL password (wrong -> 401); success sets the REAL cookie (mt_staff) and the page switches to mode "live"', rbad.status === 401 && rl.status === 200 && rl.setCookie.some(c => /^mt_staff=/.test(c)) && !rl.setCookie.some(c => /mtd_/.test(c)) && rme.mode === 'live' && rme.demoCredentials === false && rme.patientWeb === 'disabled' && rme.openControls === false);
    const rsv = (await rstaff.state()).json.shared;
    ok('signed-in real staff see the REAL queue (empty, scenario empty) - not the demo', rsv.scenario === 'empty' && Object.values(rsv.q).every(l => l.length === 0));
    ok('on the real queue, scenario reset is disabled (403) even for real admin, while real staff queue actions are authorized; anonymous scenario controls act on the demo only', (await rstaff.act('reset', ['normal'])).status === 403 && (await rstaff.act('resetQueue', ['rv:gm'])).status === 200 && real.S.get().scenario === 'empty');
    const dSnapBeforeReal = JSON.stringify(demo.snapshot().shared);
    await rstaff.act('resetQueue', ['rv:gm']);
    ok('isolation real -> demo: real staff actions leave the demo queue untouched', JSON.stringify(demo.snapshot().shared) === dSnapBeforeReal);
    // the demo credentials never open the real queue; the real password never opens a demo session
    const mix = new Client(port), ml = await mix.login('admin', 'demo'), mst = (await mix.state()).json.shared;
    ok('"admin"/"demo" is the DEMO admin only: it shows the demo queue and cannot see or change the real one', ml.status === 200 && ml.setCookie.some(c => /^mtd_staff=/.test(c)) && (await mix.me()).mode === 'demo' && mst.q['rv:gm'].length > 0);
    const forged = new Client(port); forged.jar = { mt_staff: dstaff.jar.mtd_staff, mtd_staff: rstaff.jar.mt_staff };
    const fme = await forged.me();
    ok('forged cookies (demo token under the real cookie name and vice versa) give nothing: the visitor is anonymous on the demo', fme.staff === null && fme.mode === 'demo' && (await forged.act('markArrived', ['x'])).status === 401);
    const sneaky = new Client(port, { 'X-Forwarded-Host': 'evil', 'X-Queue': 'real', 'X-Real-Staff': 'admin' }); const sm = await sneaky.me();
    ok('no query string or header can select the real queue (only a server-verified real staff cookie can)', sm.mode === 'demo' && (await sneaky.req('GET', '/api/state?queue=real&mode=live')).json.shared.scenario === 'normal');
    const out = await rstaff.req('POST', '/api/auth/logout', {});
    ok('real sign-out returns the page to the demo queue', out.status === 200 && !rstaff.jar.mt_staff && (await rstaff.me()).mode === 'demo' && (await rstaff.state()).json.shared.scenario === 'normal');
    await rstaff.login('admin', REAL_PW);                                                   // back in for the Telegram part

    // ================= Telegram: allowlisted demo identity -> demo queue; everyone else -> real queue =================
    const dTg = cbq(DEMO_TG, 'ok:rv:gm'), rTg = cbq(REAL_TG, 'ok:rv:gm');
    const demoRev = demo.getRev(), realRevBeforeTg = real.getRev();
    const h1 = await hook(port, dTg); await until(() => rows(demo, DEMO_TG).length === 1);
    ok('Telegram registration of an allowlisted DEMO identity lands in the DEMO queue (shown to demo staff), not in the real queue', h1.status === 200 && rows(demo, DEMO_TG).length === 1 && rows(real, DEMO_TG).length === 0 && /You are registered/.test(lastTo(DEMO_TG)) && real.getRev() === realRevBeforeTg);
    const h2 = await hook(port, rTg); await until(() => rows(real, REAL_TG).length === 1);
    ok('Telegram registration of any other user lands in the REAL queue and never in the demo', h2.status === 200 && rows(real, REAL_TG).length === 1 && rows(demo, REAL_TG).length === 0);
    const dEntry = rows(demo, DEMO_TG)[0], rEntry = rows(real, REAL_TG)[0];
    const dsv = (await dstaff.state()).json.shared.q['rv:gm'], rsv2 = (await rstaff.state()).json.shared.q['rv:gm'];
    ok('staff updates reach the intended queue: demo staff see the demo Telegram patient; real staff see the real one - never each other', dsv.some(e => e.id === dEntry.id) && !dsv.some(e => e.id === rEntry.id) && rsv2.some(e => e.id === rEntry.id) && !rsv2.some(e => e.id === dEntry.id) && dsv.every(e => e.acct === undefined));
    // status / check-in / missed turn, through each queue's own staff
    await hook(port, msg(DEMO_TG, '/status')); await hook(port, msg(REAL_TG, '/status')); await sleep(150);
    ok('/status works for both users against their own queue (registered, not yet checked in)', /Registered – not checked in yet/.test(lastTo(DEMO_TG)) && /Registered – not checked in yet/.test(lastTo(REAL_TG)));
    await dstaff.act('markArrived', [dEntry.id]); await rstaff.act('markArrived', [rEntry.id]);
    await hook(port, msg(DEMO_TG, '/status')); await hook(port, msg(REAL_TG, '/status')); await sleep(150);
    ok('after staff mark them arrived (check-in), each /status shows "Checked in – waiting" with an estimate from its own queue', /Checked in – waiting/.test(lastTo(DEMO_TG)) && /Checked in – waiting/.test(lastTo(REAL_TG)) && /Estimated wait/.test(lastTo(DEMO_TG)));
    const svc = demo.S.get().q['rv:gm'].find(e => e.st === 'svc'); if (svc) await dstaff.act('complete', [svc.id]);
    await dstaff.act('call', [dEntry.id]); await rstaff.act('call', [rEntry.id]); await dstaff.act('markMissed', [dEntry.id]); await rstaff.act('markMissed', [rEntry.id]);
    await hook(port, msg(DEMO_TG, '/status')); await hook(port, msg(REAL_TG, '/status')); await sleep(150);
    ok('missed-turn flow: both /status answers say "Missed turn" (Telegram has no return command; return requests are a website-patient flow)', /Missed turn/.test(lastTo(DEMO_TG)) && /Missed turn/.test(lastTo(REAL_TG)));
    ok('a Telegram user sees only their own visit: /token of the real user never shows the demo token and vice versa', (() => { return !lastTo(REAL_TG).includes('K 044') || rEntry.tok === 'K 044'; })() && lastTo(DEMO_TG).includes(dEntry.tok) && lastTo(REAL_TG).includes(rEntry.tok));
    // duplicates, secret, malformed
    const demoCountBefore = visits(demo), realCountBefore = visits(real);
    const d1 = await hook(port, dTg), d2 = await hook(port, rTg), d3 = await Promise.all([hook(port, dTg), hook(port, rTg)]); await sleep(150);
    ok('duplicate deliveries (also concurrent) create no second entry in either queue', [d1, d2, ...d3].every(r => r.status === 200) && visits(demo) === demoCountBefore && visits(real) === realCountBefore && rows(demo, DEMO_TG).length === 1 && rows(real, REAL_TG).length === 1);
    const bad = [await hook(port, msg(1, '/start'), 'wrong'), await hook(port, msg(1, '/start'), ''), await fetch('http://127.0.0.1:' + port + '/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => ({ status: r.status }))];
    ok('webhook secret validation is intact behind the front router (wrong/empty/missing -> 403)', bad.every(r => r.status === 403));
    const spoof = cbq(DEMO_TG, 'ok:rv:gm'); spoof.callback_query.message.chat.id = REAL_TG; const before = visits(demo) + visits(real); await hook(port, spoof); await sleep(100);
    ok('a forged update (sender id != chat id) is ignored and cannot move a user between queues', visits(demo) + visits(real) === before);
    ok('allowlist parsing accepts digits only (server env, never a request field)', [...parseDemoIds('123, 456 ,x,12a,,9999999999999999,789')].join() === '123,456,789' && parseDemoIds('').size === 0 && parseDemoIds(undefined).size === 0);

    // ================= unauthorized access / privacy =================
    const nobody = new Client(port);
    ok('anonymous users cannot reach any real-queue data: every state/event/me answer comes from the demo, real names and Telegram ids never appear', (() => { const t = JSON.stringify(demo.snapshot().shared); return !t.includes('tg:' + REAL_TG); })() && !(await nobody.state()).text.includes('tg:'));
    const evs = await new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: '/api/events', agent: false }, x => { let t = ''; x.on('data', d => { t += d; if (/data:/.test(t) && t.includes('\n\n')) { r.destroy(); resolve(t); } }); }); r.on('error', () => resolve('')); setTimeout(() => { r.destroy(); resolve(''); }, 2000); });
    ok('the anonymous event stream is the demo stream (scenario normal), with no real data', /"scenario":"normal"/.test(evs) && !evs.includes('tg:' + REAL_TG));

    // ================= rate limits, proxy gate, health =================
    const rl2 = new Client(port, {}); const codes = []; for (let i = 0; i < 6; i++) codes.push((await rl2.login('admin', 'guess' + i)).status);
    const dAfter = new Client(port); const dok = await dAfter.login('operator', 'demo');
    ok('real login throttling still applies (6th wrong real password -> 429) and does not lock the demo sign-in (separate apps)', codes[5] === 429 && dok.status === 200, codes.join());
    const hz = await new Client(port).req('GET', '/healthz');
    ok('/healthz is the real app\'s: healthy storage, telegram webhook mode', hz.status === 200 && hz.json.ok === true && hz.json.storage === 'sqlite' && hz.json.telegram === 'webhook');

    // ================= restart: real data persists, demo is recreated =================
    const realAfter = JSON.stringify(real.snapshot().shared); bot.stop(); X.close(); await sleep(100);
    X = await build({ db: dbFile }); const r2 = X.real;
    ok('after a restart the REAL queue (incl. its Telegram patient) is restored from SQLite and the demo queue starts fresh from its sample seed', JSON.stringify(r2.snapshot().shared) === realAfter && rows(r2, REAL_TG).length === 1 && rows(X.demo, DEMO_TG).length === 0 && visits(X.demo) === 9);
    X.close();

    // ================= the proxy proof gate covers the demo app too =================
    let PEER = '172.16.9.9'; const G = await build({ realAuth: { proxyHeader: 'cf-connecting-ip', proxyAttested: false }, peer: () => PEER });
    const gc = hdr => new Client(G.port, hdr ? { 'cf-connecting-ip': hdr } : {});
    ok('before the REAL app proves the proxy header, the demo sign-in is refused too (503, fail closed) - the gate is not weakened', (await gc('203.0.113.5').login('operator', 'demo')).status === 503 && (await gc('203.0.113.5').login('admin', REAL_PW)).status === 503);
    const sim = async ({ path: p, headers }) => new Promise((rs, rj) => { const h = Object.assign({}, headers, { 'cf-connecting-ip': '203.0.113.200' }); const r = http.request({ host: '127.0.0.1', port: G.port, path: p, headers: h, agent: false }, x => { x.resume(); x.on('end', rs); }); r.on('error', rj); r.end(); });
    const vp = await G.real.verifyProxy(sim);
    ok('the proxy self-check is served by the real app through the router; once it passes, demo and real sign-in work with per-client identity', vp.ok && (await gc('203.0.113.5').login('operator', 'demo')).status === 200 && (await gc('203.0.113.6').login('admin', REAL_PW)).status === 200);
    PEER = '8.8.8.8'; ok('an untrusted peer is refused on both apps', (await gc('203.0.113.7').login('operator', 'demo')).status === 503 && (await gc('203.0.113.7').login('admin', REAL_PW)).status === 503); PEER = '172.16.9.9';
    G.close();

    // ================= the page hides controls that cannot work =================
    const SITE = path.join(__dirname, '..', '..', 'site', 'js'), read = f => fs.readFileSync(path.join(SITE, f), 'utf8');
    const page = authMode => {
      const el = id => ({ id, innerHTML: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, closest: () => null, style_: 0 });
      const ids = {}; ['ctl', 'script', 'site-lang', 'wm', 'wm2', 'mode-note', 'step-msg'].forEach(i => { ids[i] = el(i); }); const aside = el('aside'), stage = Object.assign(el('stage'), { style: { setProperty() {} } }), grid = Object.assign(el('grid'), { clientWidth: 1200 }), L = {};
      const document = { title: '', addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); }, getElementById: i => ids[i] || null, querySelector: s => (s === '.demo-aside' ? aside : s === '.stage' ? stage : s === '.demo-grid' ? grid : null), querySelectorAll: () => [] };
      const MT = { auth: authMode ? { mode: authMode } : undefined }; const window = { MT, innerHeight: 800, addEventListener() {} };
      const ctx = vm.createContext({ window, document, console: { log() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, getComputedStyle: () => ({ gridTemplateColumns: '1fr' }) });
      vm.runInContext(read('i18n.js'), ctx); Object.assign(MT, { lang: 'en', esc: s => String(s), t: k => (MT.DICT[k] || [k])[MT.lang === 'hi' ? 1 : 0], langToggle: () => '<b>EN</b>', wordmark: () => '<svg></svg>', reduced: () => true, bind() {}, cue() {}, rerenders: [], setLang(v) { MT.lang = v; } });
      vm.runInContext(read('store.js'), ctx); vm.runInContext(read('app.js'), ctx); (L.DOMContentLoaded || []).forEach(f => f());
      return { MT, ids, aside, rerender: () => MT.rerenders.forEach(f => f()) };
    };
    const pd = page('demo'), pl = page('live'), pn = page(null);
    ok('demo mode: labelled DEMO, controls + step message + walkthrough aside are visible and the walkthrough is rendered', /DEMO - test data/.test(pd.ids['mode-note'].innerHTML) && pd.ids.ctl.style.display === '' && pd.ids['step-msg'].style.display === '' && pd.aside.style.display === '' && /<details class="walk"/.test(pd.ids.script.innerHTML));
    ok('live mode (real staff signed in): labelled LIVE CLINIC QUEUE, and the demo controls, step message and walkthrough are HIDDEN (they would not work)', /LIVE CLINIC QUEUE/.test(pl.ids['mode-note'].innerHTML) && pl.ids.ctl.style.display === 'none' && pl.ids['step-msg'].style.display === 'none' && pl.aside.style.display === 'none');
    pd.MT.auth = { mode: 'live' }; pd.rerender(); const flipped = pd.ids.ctl.style.display === 'none'; pd.MT.auth = { mode: 'demo' }; pd.rerender();
    ok('the page follows the server-reported mode live (sign in -> controls hide, sign out -> they return) and offers the note in Hindi', flipped && pd.ids.ctl.style.display === '' && (pd.MT.setLang('hi'), pd.rerender(), /डेमो/.test(pd.ids['mode-note'].innerHTML)));
    ok('a page with no server (static/file) shows no mode note and keeps its local demo controls', pn.ids['mode-note'].innerHTML === '' && pn.ids.ctl.style.display === '');
  } catch (e) { ok('test run crashed', false, e.stack); }
  fake.close(); const fail = res.filter(r => r.startsWith('FAIL'));
  process.stdout.write(res.join('\n') + '\n\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed\n');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail.length ? 1 : 0);
})();
