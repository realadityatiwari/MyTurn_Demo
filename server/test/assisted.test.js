/* Assisted (walk-in) token registration - backend. Real server code over real HTTP, SQLite on disk, a LOCAL FAKE of the Telegram Bot API (no token, no network).
   Run: node server/test/assisted.test.js */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { createApp, assembleSite } = require('../server');
const { start } = require('../bot');
const A = require('../auth');

const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-assist-'));
const OP_PW = crypto.randomBytes(12).toString('base64url'), AD_PW = crypto.randomBytes(12).toString('base64url');      // test-only, never printed
const TOKEN = '987654321:' + crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x'), SECRET = crypto.randomBytes(32).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(20); } return false; };
const rid = () => crypto.randomBytes(12).toString('base64url');                 // 16 chars
for (const k of ['log', 'warn']) console[k] = () => {};

class Client {
  constructor(port) { this.port = port; this.jar = {}; }
  async req(method, p, body) {
    const h = {}; if (body !== undefined) h['Content-Type'] = 'application/json';
    const ck = Object.entries(this.jar).map(([k, v]) => k + '=' + v).join('; '); if (ck) h.Cookie = ck;
    const r = await fetch('http://127.0.0.1:' + this.port + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'), i = kv.indexOf('='), v = kv.slice(i + 1); if (v === '') delete this.jar[kv.slice(0, i)]; else this.jar[kv.slice(0, i)] = v; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  }
  act(method, args) { return this.req('POST', '/api/action', { method, args: args || [] }); }
  login(user, password) { return this.req('POST', '/api/auth/login', { user, password }); }
  state() { return this.req('GET', '/api/state').then(r => r.json.shared); }
  reg(key, name, id, confirm) { return this.act('registerAssisted', confirm === undefined ? [key, name, id || rid()] : [key, name, id || rid(), confirm]); }
}

// fake Telegram Bot API
const sent = [];
const fake = http.createServer((req, rs) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/), body = b ? JSON.parse(b) : {};
    if (!m || m[1] !== TOKEN) { rs.writeHead(401); return rs.end('{"ok":false}'); }
    const reply = r => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ ok: true, result: r })); };
    if (m[2] === 'getMe') return reply({ username: 'fake_bot' }); if (m[2] === 'sendMessage') { sent.push(body); return reply({ message_id: 1 }); } return reply(true);
  });
});
let uid = 100;
const cbq = (id, data) => ({ update_id: uid++, callback_query: { id: 'q' + uid, from: { id, first_name: 'Tg' + id }, message: { chat: { id, type: 'private' } }, data } });
const hook = (port, upd) => fetch('http://127.0.0.1:' + port + '/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, body: JSON.stringify(upd) }).then(r => r.status);

const visits = (app, key) => app.S.get().q[key];
const total = app => Object.values(app.S.get().q).reduce((n, l) => n + l.length, 0);

async function build(o) {
  o = o || {};
  const auth = { users: { operator: { role: 'op', hash: await A.hashPassword(OP_PW) }, admin: { role: 'admin', hash: await A.hashPassword(AD_PW) } },
    demoCredentials: false, patientWeb: 'demo', openControls: false, allowReset: false, secureCookie: false, proxyHeader: null, publicOrigin: null, warnings: [], queueMode: 'live' };
  const real = createApp({ dbPath: o.db || null, seedMode: 'empty', logError() {}, logInfo() {}, auth });
  await new Promise(r => real.server.listen(0, '127.0.0.1', r)); real.port = real.server.address().port;
  return real;
}

(async () => {
  try {
    await new Promise(r => fake.listen(0, '127.0.0.1', r)); const apiBase = 'http://127.0.0.1:' + fake.address().port;
    const dbFile = path.join(dir, 'real.db');
    let app = await build({ db: dbFile }), port = app.port;
    const bot = start({ app, token: TOKEN, apiBase, log() {}, mode: 'webhook', secret: SECRET }); app.setTelegram('webhook', { secret: SECRET, handle: bot.handleUpdate });

    const anon = new Client(port), op = new Client(port), ad = new Client(port), pat = new Client(port);
    await op.login('operator', OP_PW); await ad.login('admin', AD_PW); await pat.act('patientSignIn', ['9876543210']);
    const K = 'rv:gm';

    // ---------------- authorization ----------------
    const rev0 = app.getRev();
    const d1 = await anon.reg(K, 'Anon Person'), d2 = await pat.reg(K, 'Patient Person');
    ok('anonymous requests are denied (401) and change nothing', d1.status === 401 && d2.status !== 200 && total(app) === 0 && app.getRev() === rev0, JSON.stringify([d1.status, d2.status]));
    ok('a signed-in PATIENT session is denied too (no staff session)', d2.status === 401 || d2.status === 403, String(d2.status));
    const o1 = await op.reg('lv:gp', 'Outside Clinic'), o2 = await op.reg('ng:pd', 'Outside Clinic');
    ok('an operator cannot register outside their permitted clinic (Riverside only) - 403', o1.status === 403 && o2.status === 403 && total(app) === 0);
    const bads = [await ad.reg('zz:zz', 'Valid Name'), await ad.reg('rv:xx', 'Valid Name'), await ad.reg('rv:dn', 'Valid Name'), await ad.reg('rv:ey', 'Valid Name'), await ad.reg('', 'Valid Name'), await ad.reg('rv', 'Valid Name')];
    ok('unknown, malformed and not-open sessions (closed / later / onsite-only) are rejected with "closed"', bads.every(r => r.status === 200 && r.json.result.err === 'closed') && total(app) === 0, JSON.stringify(bads.map(r => r.json && r.json.result)));
    const names = ['', '   ', '\t\n', 'x'.repeat(41), 'A\u0000B', 'Tab\u0007Bell', 'y'.repeat(81)];
    const nres = []; for (const n of names) nres.push(await ad.reg(K, n));
    ok('invalid names are rejected: empty, blank, control characters, over 40 characters, and over the 80-character transport limit (400)', nres.slice(0, 6).every(r => r.status === 200 && r.json.result.err === 'name') && nres[6].status === 400 && total(app) === 0, JSON.stringify(nres.map(r => r.status + ':' + (r.json && r.json.result && r.json.result.err))));
    const shape = [await ad.act('registerAssisted', [K, 'Name Ok']), await ad.act('registerAssisted', [K, 'Name Ok', 'short']), await ad.act('registerAssisted', [K, 'Name Ok', rid(), 'yes']), await ad.act('registerAssisted', [K, 'Name Ok', rid(), true, 'extra']), await ad.act('registerAssisted', [K, { a: 1 }, rid()]), await ad.act('registerAssisted', 'x')];
    ok('missing/short request id, non-boolean confirm, extra arguments and non-string names are refused as bad requests (400)', shape.every(r => r.status === 400) && total(app) === 0, JSON.stringify(shape.map(r => r.status)));

    // ---------------- valid registration ----------------
    await ad.act('resetQueue', [K]);
    const before = visits(app, K).length, t0 = Date.now(), ctr0 = app.S.get().ctr[K];
    const r1 = await op.reg(K, '  Ramesh   Kumar  ', rid());
    const list1 = visits(app, K), e1 = list1[list1.length - 1];
    ok('operator registers a walk-in: exactly ONE new entry, status "wait", next token, at the END of the queue', r1.status === 200 && r1.json.result.ok && list1.length === before + 1 && e1.st === 'wait' && e1.tok === 'K ' + String(ctr0).padStart(3, '0') && e1.id === K + '#' + ctr0 && app.S.get().ctr[K] === ctr0 + 1);
    ok('the entry has no patient account/profile association, is a walk-in by the creating ROLE with the original timestamp, and the name is normalised', e1.acct === null && e1.pid === null && e1.src === 'staff' && e1.rby === 'op' && e1.at >= t0 && e1.at <= Date.now() && e1.name === 'Ramesh Kumar' && e1.cancelReq === false && e1.note === null && e1.by === null);
    ok('the response carries what the receipt needs (id, token, name, status, time, role) and nothing else', JSON.stringify(Object.keys(r1.json.result.entry).sort()) === JSON.stringify(['at', 'id', 'name', 'rby', 'st', 'tok']) && r1.json.result.key === K && r1.json.result.replayed === false && r1.json.result.entry.tok === e1.tok);
    const r2 = await ad.reg(K, 'Sunita Devi'), e2 = visits(app, K).slice(-1)[0];
    ok('a second registration gets the next token behind the first; admin attribution is role "admin"; admin may register in another clinic', r2.json.result.ok && e2.tok === 'K ' + String(ctr0 + 1).padStart(3, '0') && e2.rby === 'admin' && (await ad.reg('lv:gp', 'Other Clinic Person')).json.result.ok && visits(app, 'lv:gp').slice(-1)[0].tok === 'G 001');

    // ---------------- duplicates ----------------
    const nBefore = visits(app, K).length;
    const w = await ad.reg(K, ' ramesh KUMAR ');
    ok('a probable same-name duplicate (case/space-insensitive) is NOT created: a structured warning names the existing entry', w.json.result.err === 'dupWarn' && w.json.result.dup.length === 1 && w.json.result.dup[0].tok === e1.tok && w.json.result.dup[0].st === 'wait' && visits(app, K).length === nBefore && app.S.get().ctr[K] === ctr0 + 2);
    ok('the warning exposes only id/token/status of the existing entry', Object.keys(w.json.result.dup[0]).sort().join() === 'id,st,tok');
    const w2 = await ad.reg(K, 'Ramesh Kumar', rid(), false);
    ok('confirm=false behaves like no confirmation (still warned)', w2.json.result.err === 'dupWarn' && visits(app, K).length === nBefore);
    const ov = await ad.reg(K, ' ramesh kumar', rid(), true), e3 = visits(app, K).slice(-1)[0];
    ok('a second, explicit request (confirm=true) creates the duplicate with its own token', ov.json.result.ok && visits(app, K).length === nBefore + 1 && e3.name === 'ramesh kumar' && e3.tok !== e1.tok);
    const sk = await ad.reg('lv:gp', 'Ramesh Kumar');
    ok('same name in a DIFFERENT session is not a duplicate; finished/cancelled visits do not count', sk.json.result.ok);
    const c = visits(app, K).find(x => x.name === 'Sunita Devi'); await ad.act('callNext', [K]); await ad.act('cancelVisit', [c.id]);
    ok('a cancelled earlier entry does not block re-registering the same name', (await ad.reg(K, 'Sunita Devi')).json.result.ok);

    // ---------------- retries / idempotency ----------------
    await ad.act('resetQueue', [K]);
    const R = rid(), n0 = visits(app, K).length, ctr1 = app.S.get().ctr[K];
    const a1 = await ad.reg(K, 'Retry Person', R), a2 = await ad.reg(K, 'Retry Person', R), a3 = await ad.reg(K, ' retry   person', R), a4 = await op.reg(K, 'Retry Person', R);
    ok('retrying the same request (same request id) returns the SAME entry: one entry, one token consumed, replayed=true', a1.json.result.replayed === false && [a2, a3, a4].every(r => r.json.result.ok && r.json.result.replayed === true && r.json.result.entry.tok === a1.json.result.entry.tok) && visits(app, K).length === n0 + 1 && app.S.get().ctr[K] === ctr1 + 1);
    ok('a retry is not mistaken for a duplicate (no warning) and does not need confirm', [a2, a3].every(r => !r.json.result.err));
    const mis = [await ad.reg(K, 'Somebody Else', R), await ad.reg('rv:ch', 'Retry Person', R)];
    ok('re-using a request id for a DIFFERENT name or session is refused ("idem") and creates nothing', mis.every(r => r.json.result.err === 'idem') && visits(app, K).length === n0 + 1 && visits(app, 'rv:ch').length === 0);
    const opMis = await op.reg('lv:gp', 'Retry Person', R);
    ok('a request id cannot be used to reach an entry in a clinic the caller may not use (403 before anything is looked up)', opMis.status === 403);
    const R2 = rid(); const par = await Promise.all(Array.from({ length: 12 }, () => ad.reg(K, 'Parallel Same Request', R2)));
    ok('12 concurrent submissions of ONE request: exactly one entry is created', visits(app, K).filter(x => x.name === 'Parallel Same Request').length === 1 && par.filter(r => r.json.result.replayed === false).length === 1 && par.every(r => r.json.result.ok));
    const ctr2 = app.S.get().ctr[K], len2 = visits(app, K).length;
    const many = await Promise.all(Array.from({ length: 25 }, (_, i) => (i % 2 ? op : ad).reg(K, 'Walk In ' + String.fromCharCode(65 + i) + i)));
    const toks = visits(app, K).map(x => x.tok);
    ok('25 concurrent registrations (different people): 25 entries, all tokens unique and consecutive, counter advanced by exactly 25', many.every(r => r.json.result.ok) && visits(app, K).length === len2 + 25 && new Set(toks).size === toks.length && app.S.get().ctr[K] === ctr2 + 25 && visits(app, K).slice(-25).every((x, i, a) => i === 0 || Number(x.tok.slice(2)) === Number(a[i - 1].tok.slice(2)) + 1));
    const sameName = await Promise.all(Array.from({ length: 6 }, () => ad.reg(K, 'Twin Name')));
    ok('6 concurrent DIFFERENT requests with the same new name: one is created, the rest get the duplicate warning (no accidental duplicates)', sameName.filter(r => r.json.result.ok).length === 1 && sameName.filter(r => r.json.result.err === 'dupWarn').length === 5 && visits(app, K).filter(x => x.name === 'Twin Name').length === 1);

    // ---------------- queue consistency / transitions ----------------
    await ad.act('resetQueue', [K]);
    const ra = await ad.reg(K, 'First Walkin'), rb = await ad.reg(K, 'Second Walkin'), ea = visits(app, K)[0], eb = visits(app, K)[1];
    const est = app.S.waitInfo(eb.id);
    ok('assisted entries count in the waiting line and the wait estimate like any checked-in patient (1 ahead)', est.code === 'est' && est.ahead === 1);
    const cn = await ad.act('callNext', [K]);
    ok('callNext serves the FIRST walk-in (queue order preserved)', cn.json.result.ok && visits(app, K)[0].st === 'called' && visits(app, K)[0].id === ea.id);
    const flow = [(await ad.act('start', [ea.id])).json.result, (await ad.act('complete', [ea.id])).json.result, (await ad.act('callNext', [K])).json.result, (await ad.act('markMissed', [eb.id])).json.result];
    ok('call -> start -> complete and call -> missed work for assisted entries', flow.every(x => x.ok) && visits(app, K)[0].st === 'done' && visits(app, K)[1].st === 'missed');
    const rr = await ad.reg(K, 'Third Walkin'), ec = visits(app, K)[2];
    const ns = await ad.act('markNoShow', [ec.id]), cv = await ad.reg(K, 'Fourth Walkin'), ed = visits(app, K)[3], cc = await op.act('cancelVisit', [ed.id]);
    ok('no-show and cancel work for assisted entries', ns.json.result.ok && visits(app, K)[2].st === 'noshow' && cc.json.result.ok && visits(app, K)[3].st === 'cancelled');
    const ma = await ad.act('markArrived', [visits(app, K)[1].id]);
    ok('return flow works: a missed walk-in can be marked arrived (return requested) - and a waiting one cannot be "arrived" twice', ma.json.result.ok && visits(app, K)[1].st === 'retreq' && (await ad.act('markArrived', [(await ad.reg(K, 'Fifth Walkin')).json.result.entry.id])).json.result.err === 'state');
    const tk = await ad.act('tick', []);
    ok('tick through the API (admin) does not auto-advance real walk-ins', tk.status === 200 && visits(app, K).find(x => x.name === 'Fifth Walkin').st === 'wait');
    app.S.tick();
    ok('tick() applied directly also leaves walk-ins untouched', visits(app, K).filter(x => x.src === 'staff').every(x => ['done', 'missed', 'retreq', 'noshow', 'cancelled', 'wait'].includes(x.st)) && visits(app, K).find(x => x.name === 'Fifth Walkin').st === 'wait');

    // ---------------- audit ----------------
    await ad.act('resetQueue', [K]);
    const au = await ad.reg(K, 'Audit Person'), eu = visits(app, K)[0];
    const log0 = app.S.get().audit[0];
    ok('an audit event {who, action:"assist", tok, t} is recorded by the existing mechanism with the staff ROLE name', log0.action === 'assist' && log0.tok === eu.tok && log0.who === 'admin' && Math.abs(log0.t - Date.now()) < 5000 && JSON.stringify(Object.keys(log0).sort()) === JSON.stringify(['action', 't', 'tok', 'who']));
    await ad.act('resetQueue', [K]); const a0 = app.S.get().audit.length; const ra0 = await ad.reg(K, 'Audit Two', 'auditreplayid12345'); await ad.reg(K, 'Audit Two', 'auditreplayid12345'); await ad.reg(K, 'Audit Two', rid()); await ad.reg(K, 'Audit Two', rid(), true);
    ok('a warning and a replay write NO audit entry; the first registration and the confirmed duplicate write exactly one each', app.S.get().audit.slice(0, 3).map(a => a.action).join() === 'assist,assist,reset');
    const dict = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'js', 'i18n.js'), 'utf8');
    ok('the audit action has English and Hindi wording (log.assist)', /'log\.assist': \['\{who\} registered a walk-in', '[^']*\{who\}[^']*'\]/.test(dict));

    // ---------------- privacy ----------------
    await ad.act('resetQueue', [K]); await ad.reg(K, 'Private Person'); await op.reg('rv:ch', 'Child Walkin'); await ad.reg('lv:gp', 'Lakeview Walkin');
    const aSt = await anon.state(), pSt = await pat.state(), oSt = await op.state(), adSt = await ad.state();
    ok('anonymous view: statuses only (no names, tokens, times, roles, request ids)', Object.values(aSt.q).flat().every(e => Object.keys(e).sort().join() === 'id,st,tok') && !JSON.stringify(aSt).match(/Private Person|"rby"|"at"|"rid"|"src"/));
    ok('patient view: other people\'s walk-ins appear only as {id, tok, st}', Object.values(pSt.q).flat().every(e => Object.keys(e).sort().join() === 'id,st,tok') && !JSON.stringify(pSt).match(/Private Person|"rby"|"rid"/));
    const oe = oSt.q[K].find(e => e.name === 'Private Person'), ae = adSt.q['lv:gp'].find(e => e.name === 'Lakeview Walkin');
    ok('operator view: walk-ins in Riverside carry name + src/at/rby (needed for receipt and reprint); never the request id; no other clinic', oe.name === 'Private Person' && oe.src === 'staff' && typeof oe.at === 'number' && oe.rby === 'admin' && !('rid' in oe) && !('acct' in oe) && !('pid' in oe) && (oSt.q['lv:gp'] || []).length === 0);
    ok('operator cannot read other clinics\' walk-ins or their audit lines (only Riverside token letters K C E D)', !JSON.stringify(oSt).includes('Lakeview Walkin') && oSt.audit.length > 0 && oSt.audit.every(a => !a.tok || 'KCED'.includes(a.tok[0])) && adSt.audit.some(a => a.tok && a.tok[0] === 'G'));
    ok('admin view: all clinics, still no request id / account', ae.name === 'Lakeview Walkin' && !JSON.stringify(adSt).includes('"rid"') && !JSON.stringify(adSt).includes('"acct":"'));
    ok('the full snapshot (internal only) does keep rid for idempotency', visits(app, K)[0].rid && /^[A-Za-z0-9_-]{16,64}$/.test(visits(app, K)[0].rid));

    // ---------------- Telegram unchanged ----------------
    await ad.act('resetQueue', [K]); await ad.reg(K, 'Walkin Before Telegram');
    const tgN = visits(app, K).length;
    const st1 = await hook(port, cbq(555001, 'ok:rv:gm')); await until(() => visits(app, K).some(e => e.acct === 'tg:555001'));
    const te = visits(app, K).find(e => e.acct === 'tg:555001');
    ok('Telegram registration still creates a "reg" (remote, not checked in) entry with account tg:<id>, behind the walk-in, with a unique token; no walk-in fields', st1 === 200 && te && te.st === 'reg' && te.pid && !('src' in te) && !('at' in te) && !('rid' in te) && visits(app, K).length === tgN + 1 && te.tok !== visits(app, K)[0].tok);
    const dupStatus = await hook(port, cbq(555001, 'ok:rv:gm')); await sleep(150);
    ok('Telegram duplicate protection is unchanged (second attempt: no second entry); walk-in numbering continues after the Telegram token', visits(app, K).filter(e => e.acct === 'tg:555001').length === 1 && dupStatus === 200 && (await ad.reg(K, 'Walkin After Telegram')).json.result.entry.tok === 'K ' + String(Number(te.tok.slice(2)) + 1).padStart(3, '0'));
    const sv = await ad.act('markArrived', [te.id]);
    ok('a Telegram patient can still be checked in by staff next to walk-ins (reg -> wait, moves to the end)', sv.json.result.ok && visits(app, K).slice(-1)[0].id === te.id && visits(app, K).slice(-1)[0].st === 'wait');

    // ---------------- persistence / restart ----------------
    const rev = app.getRev(), snap = JSON.stringify(app.snapshot().shared), keep = visits(app, K).filter(e => e.src === 'staff').map(e => e.tok + '|' + e.name + '|' + e.at + '|' + e.rby);
    const keepRid = visits(app, K).find(e => e.src === 'staff').rid, firstTok = visits(app, K).find(e => e.src === 'staff').tok;
    bot.stop(); app.close(); await sleep(100);
    app = await build({ db: dbFile }); port = app.port; const ad2 = new Client(port); await ad2.login('admin', AD_PW);
    ok('after a restart the walk-ins (token, name, registration time, role) are restored from SQLite exactly; revision preserved', app.getRev() === rev && JSON.stringify(app.snapshot().shared) === snap && visits(app, K).filter(e => e.src === 'staff').map(e => e.tok + '|' + e.name + '|' + e.at + '|' + e.rby).join() === keep.join());
    const replay = await ad2.reg(K, visits(app, K).find(e => e.src === 'staff').name, keepRid);
    ok('idempotency survives a restart: retrying a request from before the restart returns the same entry and creates nothing', replay.json.result.replayed === true && replay.json.result.entry.tok === firstTok && JSON.stringify(app.snapshot().shared) === snap);
    const next = await ad2.reg(K, 'After Restart'), nt = next.json.result.entry.tok, all = visits(app, K).map(e => e.tok);
    ok('token allocation continues without reuse after a restart', next.json.result.ok && new Set(all).size === all.length && Number(nt.slice(2)) === Math.max(...all.map(t => Number(t.slice(2)))));
    const raw = new (require('node:sqlite').DatabaseSync)(dbFile, { readOnly: true }); let dbRows; try { dbRows = JSON.parse(raw.prepare('SELECT shared FROM app_state WHERE id = 1').get().shared); } finally { raw.close(); }
    ok('the database row itself holds the entries (not just memory)', dbRows.q[K].some(e => e.name === 'After Restart' && e.src === 'staff' && e.st === 'wait') && dbRows.q[K].length === visits(app, K).length);

    // ---------------- retention of idempotency memory ----------------
    const R3 = rid(), old = await ad2.reg(K, 'Old Request Person', R3), oe2 = visits(app, K).find(e => e.rid === R3);
    oe2.at = Date.now() - 13 * 3600e3;                                      // simulate: entry registered 13 hours ago (older than the 12 h idempotency window)
    const late = await ad2.reg(K, 'Old Request Person', R3, true);
    ok('a request id is only honoured for 12 hours: afterwards it is treated as a new request (bounded memory)', old.json.result.ok && late.json.result.ok && late.json.result.replayed === false && late.json.result.entry.id !== oe2.id);
    app.close();

    // ---------------- demo isolation ----------------
    const dbIso = path.join(dir, 'iso.db');
    const real = await build({ db: dbIso }); const site = assembleSite(real, { demoTelegramIds: '' });
    await real.server.listening; const p = real.port, demo = site.demo;
    const realSnap = JSON.stringify(real.snapshot().shared), realRev = real.getRev();
    const dop = new Client(p); await dop.login('operator', 'demo');
    ok('demo sign-in routes to the demo app (cookie mtd_*)', Object.keys(dop.jar).join() === 'mtd_staff');
    const dr = await dop.reg(K, 'Demo Walkin'), dd = await dop.reg(K, 'demo walkin'), dr2 = await dop.reg(K, 'demo walkin', rid(), true);
    ok('assisted registration works in the DEMO queue, with the same duplicate warning and override', dr.json.result.ok && dd.json.result.err === 'dupWarn' && dr2.json.result.ok && demo.S.get().q[K].filter(e => e.src === 'staff').length === 2);
    const dall = await dop.reg('lv:gp', 'Demo Walkin Elsewhere'), dsame = await dop.reg(K, 'Third Demo', 'a'.repeat(15));
    ok('demo operator restrictions and request-id validation apply there too (403 outside Riverside, 400 for a short id)', dall.status === 403 && dsame.status === 400);
    ok('REAL queue unchanged by demo registrations: same revision, byte-identical state, no demo names anywhere, and the real database file stays empty', real.getRev() === realRev && JSON.stringify(real.snapshot().shared) === realSnap && !realSnap.includes('Demo Walkin') && (() => { const d = new (require('node:sqlite').DatabaseSync)(dbIso, { readOnly: true }); try { const s = JSON.parse(d.prepare('SELECT shared FROM app_state WHERE id = 1').get().shared); return Object.values(s.q).every(l => l.length === 0); } finally { d.close(); } })());
    const rad = new Client(p); await rad.login('admin', AD_PW); const rreg = await rad.reg(K, 'Real Walkin');
    ok('real staff register into the REAL queue (real cookie); the demo queue does not see it; real ticker control does not touch it', rreg.json.result.ok && real.S.get().q[K].length === 1 && !JSON.stringify(demo.snapshot().shared).includes('Real Walkin') && (await rad.act('tick')).status !== undefined && real.S.get().q[K][0].st === 'wait');
    const demoStaffOnReal = new Client(p); demoStaffOnReal.jar = { mt_staff: dop.jar.mtd_staff };
    ok('a demo session token presented as a real cookie does not authorise anything on the real queue', (await demoStaffOnReal.reg(K, 'Forged')).status === 401 && real.S.get().q[K].length === 1);
    site.close(); real.close();
  } catch (e) { ok('test run crashed', false, e.stack); }
  fake.close(); const fail = res.filter(r => r.startsWith('FAIL'));
  process.stdout.write(res.join('\n') + '\n\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed\n');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail.length ? 1 : 0);
})();
