/* Phase 4A tests: Telegram webhook endpoint (secret token, idempotency, retry, malformed input, authorization boundaries,
   logging hygiene), webhook-management CLI, polling safety. Uses a LOCAL FAKE of the Telegram Bot API; no real token, no network.
   Run: node server/test/webhook.test.js */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createApp } = require('../server');
const { start } = require('../bot');
const A = require('../auth');
const cli = require('../telegram-webhook');

const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-wh-'));
const TOKEN = '987654321:' + crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'x'), SECRET = crypto.randomBytes(32).toString('base64url');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(15); } return false; };

// ---- capture EVERYTHING written to the console (to prove no secret / phone / payload ever reaches the logs) ----
const logged = []; for (const k of ['log', 'error', 'warn']) { const o = console[k]; console[k] = (...a) => { logged.push(a.join(' ')); if (k === 'log' && a[0] === '__RESULT__') o(...a.slice(1)); }; }
const out = (...a) => process.stdout.write(a.join(' ') + '\n');

// ---- fake Telegram Bot API ----
const sent = [], calls = []; let webhookInfo = {}, queue = [], sendDelay = 0;
// Child process used to kill the server at an exact point of update processing (real SIGKILL-like exit, no clean shutdown).
const CHILD = `
const path = require('path'); const E = process.env;
const { createApp } = require(path.join(E.ROOT, 'server', 'server.js')); const { start } = require(path.join(E.ROOT, 'server', 'bot.js'));
const app = createApp({ dbPath: E.DBP, seedMode: 'empty', logError() {} });
const bot = start({ app, token: E.TOK, apiBase: E.API, log() {}, mode: 'webhook', secret: E.SEC });
const real = app.db.save.bind(app.db);
if (E.MODE === 'before') app.db.save = () => process.exit(137);                      // die before the transaction commits
if (E.MODE === 'after') app.db.save = (...a) => { real(...a); process.exit(137); };  // die right after it commits
bot.handleUpdate(JSON.parse(E.UPD)).then(r => { console.log('RESULT ' + r); process.exit(0); });
`;
const fake = http.createServer((req, rs) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/), body = b ? JSON.parse(b) : {};
    if (!m || m[1] !== TOKEN) { rs.writeHead(401); return rs.end('{"ok":false,"error_code":401,"description":"Unauthorized"}'); }
    calls.push({ method: m[2], body });
    const reply = r => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ ok: true, result: r })); };
    if (m[2] === 'getMe') return reply({ username: 'fake_bot' });
    if (m[2] === 'sendMessage') { if (sendDelay) return setTimeout(() => { sent.push(body); reply({ message_id: 1 }); }, sendDelay); sent.push(body); return reply({ message_id: 1 }); }
    if (m[2] === 'getWebhookInfo') return reply(webhookInfo);
    if (m[2] === 'getUpdates') { const off = body.offset || 0, r = queue.filter(u => u.update_id >= off); return r.length ? reply(r) : setTimeout(() => reply([]), 120); }
    return reply(true);
  });
});
const uid = (() => { let n = 5000; return () => n++; })();
const msg = (id, text, extra) => Object.assign({ update_id: uid(), message: { chat: { id, type: 'private' }, from: { id, first_name: 'User' + id, last_name: 'Test' }, text } }, extra);
const cbq = (id, data) => ({ update_id: uid(), callback_query: { id: 'q' + uid(), from: { id, first_name: 'User' + id }, message: { chat: { id, type: 'private' } }, data } });
const lastTo = chat => sent.filter(s => s.chat_id === chat).slice(-1).map(s => s.text).join('');
const raw = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, x => { let t = ''; x.on('data', d => t += d); x.on('end', () => resolve({ status: x.statusCode, headers: x.headers, text: t })); });
  r.on('error', e => resolve({ status: 0, headers: {}, text: '', error: e.code })); if (body !== undefined) r.write(body); r.end();   // status 0 = connection cut by the server
});
const hook = (port, upd, headers) => {
  const h = Object.assign({ 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, headers); for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  return raw(port, 'POST', '/telegram/webhook', h, typeof upd === 'string' ? upd : JSON.stringify(upd));
};
const mk = async (file, o) => {
  const app = createApp(Object.assign({ dbPath: file || null, seedMode: 'empty', logError() {}, auth: Object.assign({ users: {}, demoCredentials: false, patientWeb: 'demo', openControls: false, allowReset: true, secureCookie: false, publicOrigin: null, warnings: [] }, o && o.auth) }, o && o.rest));
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); app.port = app.server.address().port;
  const bot = start({ app, token: TOKEN, apiBase: 'http://127.0.0.1:' + fake.address().port, log: m => logged.push(m), mode: 'webhook', secret: SECRET });
  app.setTelegram('webhook', { secret: SECRET, handle: bot.handleUpdate }); app.bot = bot; await sleep(80); return app;
};
const rows = (app, id) => app.S.get().q['rv:gm'].filter(e => e.acct === 'tg:' + id);

(async () => {
  try {
    await new Promise(r => fake.listen(0, '127.0.0.1', r));
    const dbFile = path.join(dir, 'w.db');
    let app = await mk(dbFile); let P = app.port;
    ok('webhook mode does NOT poll and does NOT delete or register any webhook by itself', calls.some(c => c.method === 'getMe') && !calls.some(c => c.method === 'getUpdates' || c.method === 'deleteWebhook' || c.method === 'setWebhook'));
    ok('/healthz reports the Telegram transport', JSON.parse((await raw(P, 'GET', '/healthz', {})).text).telegram === 'webhook');

    // ---------- secret token ----------
    const before = JSON.stringify(app.snapshot().shared), nSent = sent.length, u0 = cbq(11, 'ok:rv:gm');
    const bad = [await hook(P, u0, { 'X-Telegram-Bot-Api-Secret-Token': undefined }), await hook(P, u0, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' }), await hook(P, u0, { 'X-Telegram-Bot-Api-Secret-Token': SECRET + 'x' }),
      await hook(P, u0, { 'X-Telegram-Bot-Api-Secret-Token': SECRET.slice(0, -1) }), await hook(P, u0, { 'X-Telegram-Bot-Api-Secret-Token': '' }), await hook(P, u0, { 'X-Telegram-Bot-Api-Secret-Token': SECRET.toUpperCase() })];
    ok('missing / wrong / truncated / extended / empty / case-changed secret -> 403, identical safe body', bad.every(r => r.status === 403 && r.text === bad[0].text) && !bad[0].text.includes(SECRET));
    ok('rejected requests had no effect (no state change, no reply sent, update id not claimed)', JSON.stringify(app.snapshot().shared) === before && sent.length === nSent && app.markUpdate(u0.update_id) === true);
    app.unmarkUpdate(u0.update_id);
    ok('secret is only accepted in the Telegram header (not as a query string or cookie)', (await raw(P, 'POST', '/telegram/webhook?secret=' + SECRET, { 'Content-Type': 'application/json', Cookie: 'x=' + SECRET }, JSON.stringify(u0))).status === 403);
    const good = await hook(P, msg(11, '/start'));
    ok('valid secret: 200 and the existing command handler answers (/start)', good.status === 200 && await until(() => /Welcome to MyTurn/.test(lastTo(11))));
    ok('GET on the webhook path -> 405; other paths 404', (await raw(P, 'GET', '/telegram/webhook', {})).status === 405 && (await raw(P, 'GET', '/telegram/other', {})).status === 404 && (await raw(P, 'GET', '/telegram', {})).status === 404);

    // ---------- shared queue logic ----------
    await hook(P, cbq(11, 'ok:rv:gm')); await until(() => rows(app, 11).length === 1);
    const r11 = rows(app, 11)[0];
    ok('registration via webhook uses the shared queue logic (reg status, token, tg: account, Telegram text unchanged)', r11 && r11.st === 'reg' && /^[A-Z] \d{3}$/.test(r11.tok) && /You are registered \(remote registration\)/.test(lastTo(11)) && app.S.get().accounts['tg:11']);
    await hook(P, msg(11, '/status')); await until(() => /Registered – not checked in yet/.test(lastTo(11)));
    ok('/status and /token behave as before', /Waiting-time estimate: not available yet/.test(lastTo(11)));

    // ---------- duplicates ----------
    const dupUpd = cbq(12, 'ok:rv:gm'), d1 = await hook(P, dupUpd), d2 = await hook(P, dupUpd), d3 = await hook(P, dupUpd);
    await sleep(100);
    ok('duplicate delivery of the same update_id: all 200, processed exactly once (one entry, one confirmation)', [d1, d2, d3].every(r => r.status === 200) && rows(app, 12).length === 1 && sent.filter(s => s.chat_id === 12 && /You are registered/.test(s.text)).length === 1);
    const concurrent = cbq(13, 'ok:rv:gm'); await Promise.all([hook(P, concurrent), hook(P, concurrent), hook(P, concurrent)]); await sleep(150);
    ok('three CONCURRENT deliveries of one update: still exactly one registration', rows(app, 13).length === 1);
    const snapBefore = JSON.stringify(app.snapshot().shared); app.close();
    app = await mk(dbFile); P = app.port;
    const again = await hook(P, dupUpd); await sleep(100);
    ok('duplicate protection survives a restart (SQLite): replay after restart is ignored', again.status === 200 && rows(app, 12).length === 1 && JSON.stringify(app.snapshot().shared) === snapBefore);

    // ---------- retry after persistence failure ----------
    const realSave = app.db.save.bind(app.db), realMark = app.db.markUpdate.bind(app.db), failUpd = cbq(14, 'ok:rv:gm'), sentBefore = sent.length;
    app.db.save = () => { throw new Error('disk full'); };
    const f1 = await hook(P, failUpd);
    ok('storage failure while processing: 503 so Telegram redelivers; nothing registered; user gets no false "registered"/"sorry" message', f1.status === 503 && rows(app, 14).length === 0 && sent.length === sentBefore && !app.S.get().accounts['tg:14']);
    app.db.save = realSave;
    const f2 = await hook(P, failUpd); await until(() => rows(app, 14).length === 1);
    ok('retry after recovery: the SAME update id is processed (claim was released), exactly one entry', f2.status === 200 && rows(app, 14).length === 1);
    ok('...and a further redelivery is now a harmless duplicate', (await hook(P, failUpd)).status === 200 && rows(app, 14).length === 1);
    const failUpd2 = cbq(15, 'ok:rv:gm'); app.db.save = () => { throw new Error('disk full'); }; app.db.markUpdate = () => { throw new Error('disk full'); };
    const f3 = await hook(P, failUpd2); app.db.save = realSave; app.db.markUpdate = realMark;
    ok('even when the duplicate-claim write ALSO fails, the retry is not lost (503 now, processed on redelivery)', f3.status === 503 && (await hook(P, failUpd2)).status === 200 && await until(() => rows(app, 15).length === 1));
    app.close(); app = await mk(dbFile); P = app.port;
    ok('retried registrations are on disk after restart', rows(app, 14).length === 1 && rows(app, 15).length === 1);

    // ---------- Task B: update claim and registration are ONE transaction ----------
    const adb = path.join(dir, 'atomic.db'), childFile = path.join(dir, 'atomic-child.js'); fs.writeFileSync(childFile, CHILD);
    const runChild = (mode, upd) => spawnSync(process.execPath, [childFile], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ROOT: path.resolve(__dirname, '..', '..'), DBP: adb, TOK: TOKEN, SEC: SECRET, API: 'http://127.0.0.1:' + fake.address().port, MODE: mode, UPD: JSON.stringify(upd) }, encoding: 'utf8', windowsHide: true });
    app.close(); let at = await mk(adb);
    // (1) the process dies BEFORE the transaction commits: neither the registration nor the claim exists, so Telegram's redelivery is processed
    const kUpd = cbq(701, 'ok:rv:gm'), k1 = runChild('before', kUpd);
    at.close(); at = await mk(adb);
    ok('kill between receiving the update and the commit: no registration AND the update is NOT marked processed (the old "claimed but lost" state cannot occur)', k1.status === 137 && rows(at, 701).length === 0 && !at.isProcessed(kUpd.update_id), k1.status + ' ' + k1.stderr.slice(0, 200));
    const kr = await hook(at.port, kUpd); await until(() => rows(at, 701).length === 1);
    ok('...Telegram redelivers it: registered exactly once, now recorded, and the confirmation is sent', kr.status === 200 && rows(at, 701).length === 1 && at.isProcessed(kUpd.update_id) && /You are registered/.test(lastTo(701)));
    ok('...and a further redelivery is a duplicate', (await hook(at.port, kUpd)).status === 200 && rows(at, 701).length === 1 && sent.filter(s => s.chat_id === 701).length === 1);
    // (2) the process dies right AFTER the commit (before replying/acknowledging): registration and claim are both durable
    const aUpd = cbq(702, 'ok:rv:gm'), k2 = runChild('after', aUpd);
    at.close(); at = await mk(adb);
    ok('kill right after the commit: the registration AND the processed-mark are both on disk (all-or-nothing)', k2.status === 137 && rows(at, 702).length === 1 && at.isProcessed(aUpd.update_id), k2.status + ' ' + k2.stderr.slice(0, 200));
    const sentBeforeRe = sent.filter(s => s.chat_id === 702).length, ar = await hook(at.port, aUpd); await sleep(150);
    ok('...Telegram redelivers: acknowledged as a duplicate, still exactly one registration (the user gets no second confirmation; /status shows the visit)', ar.status === 200 && rows(at, 702).length === 1 && sent.filter(s => s.chat_id === 702).length === sentBeforeRe);
    // (3) the claim insert fails INSIDE the transaction: the registration must roll back with it (proves they are one transaction)
    const tUpd = cbq(703, 'ok:rv:gm'), { DatabaseSync } = require('node:sqlite'), raw2 = new DatabaseSync(adb);
    raw2.exec('PRAGMA busy_timeout = 5000'); raw2.exec('CREATE TRIGGER fail_claim BEFORE INSERT ON tg_updates WHEN NEW.update_id = ' + tUpd.update_id + " BEGIN SELECT RAISE(ABORT, 'simulated disk error'); END");
    const revT = at.getRev(), t1 = await hook(at.port, tUpd);
    const persisted = (() => { const d = new DatabaseSync(adb, { readOnly: true }); try { const r = d.prepare('SELECT rev, shared FROM app_state WHERE id = 1').get(); return { rev: r.rev, has: r.shared.includes('tg:703') }; } finally { d.close(); } })();
    ok('claim insert fails inside the transaction: 503, the registration is rolled back in memory AND on disk, nothing recorded, no reply sent', t1.status === 503 && rows(at, 703).length === 0 && !persisted.has && persisted.rev === revT && !at.isProcessed(tUpd.update_id) && !sent.some(s => s.chat_id === 703));
    raw2.exec('DROP TRIGGER fail_claim'); raw2.close();
    ok('after the fault clears, the same update is processed once and recorded together with its registration', (await hook(at.port, tUpd)).status === 200 && await until(() => rows(at, 703).length === 1) && at.isProcessed(tUpd.update_id));
    // (4) concurrent duplicates while the first is still talking to Telegram (slow reply): exactly one registration, one confirmation
    sendDelay = 400; const cUpd = cbq(704, 'ok:rv:gm'), cr = await Promise.all([hook(at.port, cUpd), hook(at.port, cUpd), hook(at.port, cUpd), hook(at.port, cUpd)]); sendDelay = 0; await sleep(100);
    ok('four concurrent deliveries during a slow Telegram reply: all 200, ONE registration, ONE confirmation', cr.every(r => r.status === 200) && rows(at, 704).length === 1 && sent.filter(s => s.chat_id === 704 && /You are registered/.test(s.text)).length === 1);
    // (5) updates that change nothing are recorded after processing, so redelivery does not repeat the reply
    const cmd = msg(705, '/start'); await hook(at.port, cmd); await until(() => /Welcome/.test(lastTo(705))); const n705 = sent.filter(s => s.chat_id === 705).length;
    await hook(at.port, cmd); await sleep(100);
    ok('a command (no queue change) is recorded once processed; redelivery sends nothing again', at.isProcessed(cmd.update_id) && sent.filter(s => s.chat_id === 705).length === n705);
    const rejUpd = cbq(701, 'ok:rv:gm'); await hook(at.port, rejUpd); await until(() => /already have an active registration/.test(lastTo(701)));
    ok('a registration rejected as "already registered" changes nothing, is still recorded, and is not repeated on redelivery', at.isProcessed(rejUpd.update_id) && rows(at, 701).length === 1 && (await hook(at.port, rejUpd)).status === 200 && sent.filter(s => s.chat_id === 701 && /already have an active/.test(s.text)).length === 1);
    // (6) storage down for the WHOLE request (probe fails): retry, nothing recorded
    const dUpd = cbq(706, 'ok:rv:gm'), realS2 = at.db.save.bind(at.db); at.db.save = () => { throw new Error('disk full'); };
    const dres = await hook(at.port, dUpd); at.db.save = realS2;
    ok('persistence failure: 503, nothing recorded; retry after recovery is processed (claim + registration together)', dres.status === 503 && !at.isProcessed(dUpd.update_id) && rows(at, 706).length === 0 && (await hook(at.port, dUpd)).status === 200 && rows(at, 706).length === 1 && at.isProcessed(dUpd.update_id));
    // (7) restart recovery: everything above survives a restart and replays are still ignored
    const snapAt = JSON.stringify(at.snapshot().shared); at.close(); at = await mk(adb);
    const replays = [kUpd, aUpd, tUpd, cUpd, dUpd, cmd]; for (const u of replays) await hook(at.port, u); await sleep(100);
    ok('restart recovery: state identical after restart, all six processed updates are still recognised as duplicates and change nothing', JSON.stringify(at.snapshot().shared) === snapAt && replays.every(u => at.isProcessed(u.update_id)));
    at.close();
    // (8) no database (in-memory mode) keeps the same guarantees in memory
    const mem2 = await mk(null), mUpd = cbq(707, 'ok:rv:gm'); await hook(mem2.port, mUpd); await hook(mem2.port, mUpd); await until(() => rows(mem2, 707).length === 1); await sleep(80);
    ok('in-memory mode: duplicate deliveries still register once and are recognised', rows(mem2, 707).length === 1 && mem2.isProcessed(mUpd.update_id)); mem2.close();
    app = await mk(dbFile); P = app.port;

    // ---------- malformed payloads / HTTP controls ----------
    const snapM = JSON.stringify(app.snapshot().shared), sentM = sent.length;
    ok('invalid JSON -> 400', (await hook(P, '{not json')).status === 400);
    ok('wrong content type -> 415', (await hook(P, '{}', { 'Content-Type': 'text/plain' })).status === 415);
    const badBodies = [[], 'str', 42, null, {}, { update_id: 'abc' }, { update_id: -5 }, { update_id: 1.5 }, { update_id: 1e20 }, { message: {} }];
    const br = []; for (const b of badBodies) br.push((await hook(P, JSON.stringify(b))).status);
    ok('non-update bodies (array, scalar, null, no/invalid update_id) -> 400, no effect', br.every(s => s === 400) && JSON.stringify(app.snapshot().shared) === snapM && sent.length === sentM, br.join());
    const odd = [{ update_id: uid(), edited_message: { text: 'x' } }, { update_id: uid(), message: null }, { update_id: uid(), message: { chat: { id: 1, type: 'private' }, from: null, text: '/start' } },
      { update_id: uid(), message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: { evil: 1 } } }, { update_id: uid(), callback_query: { id: 'x', from: { id: 1 }, message: null, data: 'ok:rv:gm' } },
      { update_id: uid(), callback_query: { id: 'x', from: { id: 1 }, message: { chat: { id: 1, type: 'private' } }, data: { a: 1 } } }, msg(1, 'x'.repeat(5000))];
    const or = []; for (const b of odd) or.push((await hook(P, b)).status);
    ok('unsupported / partial / wrongly-typed updates are accepted-and-ignored (200) or answered safely, never crash', or.every(s => s === 200), or.join());
    const spoofed = [msg(2001, '/start', { message: { chat: { id: 2002, type: 'private' }, from: { id: 2001 }, text: '/register' } }), { update_id: uid(), message: { chat: { id: 2003, type: 'private' }, from: { id: '2003' }, text: '/register' } },
      { update_id: uid(), message: { chat: { id: -100, type: 'group' }, from: { id: 2004 }, text: '/register' } }, { update_id: uid(), message: { chat: { id: 2005, type: 'private' }, from: { id: 2005, is_bot: true }, text: '/register' } },
      { update_id: uid(), message: { chat: { id: 2006, type: 'private' }, from: { id: 0 }, text: '/register' } }];
    const sentS = sent.length; for (const b of spoofed) await hook(P, b); await sleep(120);
    ok('sender spoofing is ignored: chat id != sender id, string/zero ids, groups and bots get no reply and no account', sent.length === sentS && !['2001', '2002', '2003', '2004', '2005', '2006', '-100'].some(i => app.S.get().accounts['tg:' + i]));
    const big = await hook(P, JSON.stringify({ update_id: uid(), message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, text: 'a'.repeat(30000) } }));
    ok('oversize body is refused (413, or the connection is cut while it is still being sent) and nothing is processed', (big.status === 413 || (big.status === 0 && big.error === 'ECONNRESET')) && sent.length === sentS);
    ok('request/header timeouts configured on the same HTTP server (slow-body / slowloris protection)', app.server.requestTimeout === 15000 && app.server.headersTimeout === 10000);
    const sec = await hook(P, msg(31, '/help')); ok('security headers also apply to webhook responses', sec.headers['x-content-type-options'] === 'nosniff' && !!sec.headers['content-security-policy']);

    // ---------- authorization boundaries ----------
    const snapA = JSON.stringify(app.snapshot().shared);
    const api = [await hook(P, { update_id: uid(), method: 'resetQueue', args: ['rv:gm'], session: { staff: { role: 'admin' } }, role: 'admin' }), await hook(P, { update_id: uid(), action: 'reset', args: ['missed'] })];
    ok('the webhook is not an action API: bodies carrying API-style commands / roles change nothing', api.every(r => r.status === 400 || r.status === 200) && JSON.stringify(app.snapshot().shared) === snapA && app.S.get().scenario !== 'missed');
    await hook(P, msg(41, '/reset')); await hook(P, msg(41, '/admin')); await sleep(80);
    ok('Telegram text cannot reach staff/admin functions (unknown command reply only)', /did not understand/.test(lastTo(41)) && JSON.stringify(app.snapshot().shared.q) === JSON.stringify(JSON.parse(snapA).q));
    await hook(P, cbq(51, 'ok:rv:gm')); await hook(P, cbq(52, 'ok:rv:gm')); await until(() => rows(app, 51).length && rows(app, 52).length);
    await hook(P, msg(52, '/token')); await until(() => /Token:/.test(lastTo(52)));
    ok("a Telegram user only ever sees their own token (user 52 never receives user 51's)", lastTo(52).includes(rows(app, 52)[0].tok) && !lastTo(52).includes(rows(app, 51)[0].tok + '\n'));
    ok('each Telegram user is confined to their own tg:<id> account (no website/staff identity is created)', Object.keys(app.S.get().accounts).filter(k => k.startsWith('tg:')).length >= 5 && Object.keys(app.S.get().accounts).every(k => k.startsWith('tg:')) );
    const viaApi = await raw(P, 'POST', '/api/action', { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET }, JSON.stringify({ method: 'resetQueue', args: ['rv:gm'] }));
    ok('the webhook secret grants nothing on the HTTP API (still 401 without a staff session)', viaApi.status === 401);
    const state = JSON.parse((await raw(P, 'GET', '/api/state', {})).text);
    ok('anonymous state still exposes no Telegram data (Phase 3 redaction intact)', !/tg:|User\d/.test(JSON.stringify(state)));

    // ---------- rate limit ----------
    const rl = await mk(null, { auth: { rate: { webhook: [3, 60e3], ip: [300, 60e3] } } }), rr = []; for (let i = 0; i < 5; i++) rr.push((await hook(rl.port, msg(61, '/help'))).status);
    ok('webhook has its own per-IP ceiling (429 after the budget)', rr.slice(0, 3).every(s => s === 200) && rr[4] === 429, rr.join()); rl.close();

    // ---------- origin handling in a production-like configuration ----------
    const po = await mk(null, { auth: { publicOrigin: 'https://myturn.example' } }), hp = { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET };
    const w1 = await raw(po.port, 'POST', '/telegram/webhook', Object.assign({ Host: 'myturn.example' }, hp), JSON.stringify(msg(71, '/help')));
    ok('production-like origin config: Telegram (no Origin header) is accepted on the right Host...', w1.status === 200);
    ok('...refused on a wrong Host (421, DNS-rebinding guard), and the browser API still requires the exact Origin', (await raw(po.port, 'POST', '/telegram/webhook', Object.assign({ Host: 'evil.example' }, hp), JSON.stringify(msg(72, '/help')))).status === 421 && (await raw(po.port, 'POST', '/api/action', { Host: 'myturn.example', 'Content-Type': 'application/json' }, '{}')).status === 403);
    po.close();
    const off = createApp({ seedMode: 'empty', logError() {} }); await new Promise(r => off.server.listen(0, '127.0.0.1', r));
    ok('no bot / polling mode: the webhook path does not exist (404)', (await hook(off.server.address().port, msg(1, '/start'))).status === 404 && (off.setTelegram('polling'), (await hook(off.server.address().port, msg(1, '/start'))).status === 404)); off.close();

    // ---------- production fail-closed configuration ----------
    const h = await A.hashPassword('x'.repeat(14)), base = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://myturn.example', STAFF_ADMIN_PASSWORD_HASH: h, DATABASE_PATH: path.join(dir, 'p.db'), TELEGRAM_BOT_TOKEN: TOKEN };
    const errs = env => A.productionErrors(A.authConfig(env), env).join(' | ');
    ok('production + bot token requires TELEGRAM_MODE=webhook (no polling in production)', /TELEGRAM_MODE=webhook/.test(errs(base)) && /TELEGRAM_MODE=webhook/.test(errs(Object.assign({}, base, { TELEGRAM_MODE: 'polling' }))));
    ok('webhook mode requires a strong secret (missing / short / bad characters refused)', [undefined, 'short', 'x'.repeat(31), 'has space ' + 'x'.repeat(30), 'x'.repeat(257)].every(s => /TELEGRAM_WEBHOOK_SECRET/.test(errs(Object.assign({}, base, { TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: s })))));
    ok('a valid production webhook configuration passes', errs(Object.assign({}, base, { TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: SECRET })) === '' && A.validWebhookSecret(SECRET));
    ok('production without a bot token (website only) is unaffected', errs({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://myturn.example', STAFF_ADMIN_PASSWORD_HASH: h, DATABASE_PATH: path.join(dir, 'p.db') }) === '');
    ok('constant-time secret comparison helper', A.safeEqual('abc', 'abc') && !A.safeEqual('abc', 'abd') && !A.safeEqual('abc', undefined) && !A.safeEqual(undefined, undefined));

    // ---------- local development: polling still works, and refuses to delete a registered webhook ----------
    const lp = createApp({ seedMode: 'empty', logError() {} }); const api0 = 'http://127.0.0.1:' + fake.address().port;
    calls.length = 0; webhookInfo = { url: 'https://prod.example/telegram/webhook', pending_update_count: 0 };
    const e0 = []; const oe = console.error; console.error = (...a) => e0.push(a.join(' '));
    const pb1 = start({ app: lp, token: TOKEN, apiBase: api0, log: m => logged.push(m) }); await sleep(300); pb1.stop(); console.error = oe;
    ok('polling refuses to start while a webhook is registered (would silently delete it); explains how to roll back', !calls.some(c => c.method === 'getUpdates' || c.method === 'deleteWebhook') && e0.some(l => /webhook registered/.test(l) && /telegram-webhook\.js delete/.test(l)));
    webhookInfo = {}; calls.length = 0; queue = [msg(81, '/start')]; sent.length = 0;
    const pb2 = start({ app: lp, token: TOKEN, apiBase: api0, log: m => logged.push(m) }); await until(() => /Welcome/.test(lastTo(81)));
    ok('local long polling still works exactly as before (no webhook registered)', /Welcome to MyTurn/.test(lastTo(81)) && calls.some(c => c.method === 'getUpdates'));
    // polling + persistence failure: offset is not advanced, update is retried
    const lpDb = createApp({ dbPath: path.join(dir, 'poll.db'), seedMode: 'empty', logError() {} }); const realS = lpDb.db.save.bind(lpDb.db);
    pb2.stop(); await sleep(200); queue = []; sent.length = 0; calls.length = 0;
    const pu = cbq(91, 'ok:rv:gm'); queue = [pu]; lpDb.db.save = () => { throw new Error('disk full'); };
    const pb3 = start({ app: lpDb, token: TOKEN, apiBase: api0, log: m => logged.push(m) });
    await until(() => calls.filter(c => c.method === 'getUpdates').length >= 1); await sleep(200);
    ok('polling: storage failure leaves the update unconfirmed (nothing registered, no message)', !lpDb.S.get().accounts['tg:91'] && !sent.some(s => s.chat_id === 91));
    lpDb.db.save = realS; const ok4 = await until(() => lpDb.S.get().q['rv:gm'].some(e => e.acct === 'tg:91'), 9000);
    ok('polling: after recovery the SAME update is redelivered and processed once', ok4 && lpDb.S.get().q['rv:gm'].filter(e => e.acct === 'tg:91').length === 1 && calls.some(c => c.method === 'getUpdates' && c.body.offset <= pu.update_id));
    pb3.stop(); queue = []; await sleep(200); lpDb.close(); lp.close();

    // ---------- webhook management CLI (against the fake API; nothing real is contacted) ----------
    const lines = [], L = m => lines.push(m), env = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, PUBLIC_ORIGIN: 'https://myturn.example/' };
    calls.length = 0;
    const c1 = await cli.run('set', env, { log: L, apiBase: api0 }), sw = calls.find(c => c.method === 'setWebhook');
    ok('CLI set: registers <PUBLIC_ORIGIN>/telegram/webhook with secret_token, only message+callback_query, keeps pending updates', c1 === 0 && sw && sw.body.url === 'https://myturn.example/telegram/webhook' && sw.body.secret_token === SECRET && sw.body.allowed_updates.join() === 'message,callback_query' && sw.body.drop_pending_updates === false);
    webhookInfo = { url: 'https://myturn.example/telegram/webhook', pending_update_count: 3, last_error_date: 1700000000, last_error_message: 'Wrong response from the webhook: 403 ' + SECRET };
    const c2 = await cli.run('info', env, { log: L, apiBase: api0 });
    const c3 = await cli.run('delete', env, { log: L, apiBase: api0 });
    ok('CLI info/delete work; delete keeps pending updates (rollback to polling)', c2 === 0 && c3 === 0 && calls.some(c => c.method === 'deleteWebhook' && c.body.drop_pending_updates === false) && lines.some(l => /Pending updates: 3/.test(l)));
    ok('CLI output never contains the token or the secret (even if Telegram echoes it back)', !lines.join('\n').includes(TOKEN) && !lines.join('\n').includes(SECRET) && lines.some(l => /<secret>/.test(l)));
    const l2 = []; const bads = [await cli.run('set', { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: 'short', PUBLIC_ORIGIN: 'https://a.example' }, { log: m => l2.push(m), apiBase: api0 }),
      await cli.run('set', { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, PUBLIC_ORIGIN: 'http://a.example' }, { log: m => l2.push(m), apiBase: api0 }),
      await cli.run('set', { TELEGRAM_WEBHOOK_SECRET: SECRET, PUBLIC_ORIGIN: 'https://a.example' }, { log: m => l2.push(m), apiBase: api0 }), await cli.run('bogus', env, { log: m => l2.push(m), apiBase: api0 })];
    ok('CLI refuses weak secret, non-https origin, missing token and unknown commands (exit 1, nothing sent)', bads.every(c => c === 1) && calls.filter(c => c.method === 'setWebhook').length === 1);

    // ---------- token verification diagnostics (regression: a network failure was reported as "Telegram rejected the token") ----------
    const behave = { mode: 'ok' }, seenPaths = [];
    const diag = http.createServer((req, rs) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        seenPaths.push(req.url.replace(TOKEN, '<token>'));
        const send = (st, body, type, hdr) => { rs.writeHead(st, Object.assign({ 'Content-Type': type || 'application/json' }, hdr || {})); rs.end(body); };
        switch (behave.mode) {
          case 'ok': return send(200, JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'my_test_bot' } }));
          case 'invalid': return send(401, JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
          case 'invalid-echo': return send(400, JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: url ' + TOKEN }));
          case 'ok-no-bot': return send(200, JSON.stringify({ ok: true, result: { id: 1 } }));
          case 'ok-false-200': return send(200, JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests' }));
          case 'html-200': return send(200, '<html>captive portal</html>', 'text/html');
          case 'bad-gateway': return send(502, '<html>502 Bad Gateway</html>', 'text/html');
          case 'redirect': return send(302, '', 'text/plain', { Location: 'https://example.invalid/' });
          case 'json-no-ok': return send(200, JSON.stringify({ hello: 'world' }));
          case 'ok-but-500': return send(500, JSON.stringify({ ok: true, result: true }));
          case 'hang': return;                                           // never answers
        }
      });
    });
    await new Promise(r => diag.listen(0, '127.0.0.1', r)); const dBase = 'http://127.0.0.1:' + diag.address().port;
    const tokEnv = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET, PUBLIC_ORIGIN: 'https://myturn.example' };
    const chk = async (mode, o) => { behave.mode = mode; seenPaths.length = 0; const out = []; const code = await cli.run('check', tokEnv, Object.assign({ log: m => out.push(m), apiBase: dBase }, o)); return { code, text: out.join('\n'), paths: seenPaths.slice() }; };
    const g1 = await chk('ok');
    ok('token check: Telegram confirms (ok:true + bot identity) -> exit 0, only getMe is called, the bot username (public) is shown', g1.code === cli.EXIT.OK && /@my_test_bot/.test(g1.text) && g1.paths.length === 1 && /\/getMe$/.test(g1.paths[0]));
    const g2 = await chk('invalid');
    ok('token check: explicit ok:false 401 -> exit 4 and a message that says the token is invalid (NOT a network problem)', g2.code === cli.EXIT.TELEGRAM && /Telegram error: Telegram says the token is invalid \(401 Unauthorized\)/.test(g2.text) && !/Network error/.test(g2.text));
    const g3 = await chk('invalid-echo');
    ok('token check: a token echoed back by Telegram in the error text is redacted', g3.code === cli.EXIT.TELEGRAM && !g3.text.includes(TOKEN) && /<token>/.test(g3.text));
    const g4 = await chk('html-200'), g5 = await chk('bad-gateway'), g6 = await chk('redirect'), g7 = await chk('json-no-ok'), g8 = await chk('ok-but-500'), g9 = await chk('ok-no-bot');
    ok('token check: HTTP-level problems (200 with HTML, 502, redirect, JSON without "ok", ok:true with a 500, ok without a bot identity) -> exit 3, each explained, never "invalid token"',
      [g4, g5, g6, g7, g8, g9].every(g => g.code === cli.EXIT.HTTP && /^HTTP error: /m.test(g.text) && !/token is invalid/.test(g.text)) && /non-JSON/.test(g4.text) && /HTTP 502/.test(g5.text) && /redirect \(not followed\)/.test(g6.text) && /without a bot identity/.test(g9.text), [g4, g5, g6, g7, g8, g9].map(g => g.code).join());
    const ga = await chk('ok-false-200');
    ok('token check: ok:false with another error code is a Telegram answer (exit 4) that shows the code, not a "bad token" claim', ga.code === 4 && /429/.test(ga.text) && !/token is invalid/.test(ga.text));
    const gh = await chk('hang', { timeoutMs: 300 });
    ok('token check: a server that never answers -> timeout reported as a NETWORK problem (exit 2)', gh.code === cli.EXIT.NETWORK && /Network error: timeout/.test(gh.text));
    const dead = http.createServer(); await new Promise(r => dead.listen(0, '127.0.0.1', r)); const deadBase = 'http://127.0.0.1:' + dead.address().port; await new Promise(r => dead.close(r));
    behave.mode = 'ok'; const out2 = []; const gn = await cli.run('check', tokEnv, { log: m => out2.push(m), apiBase: deadBase });
    ok('token check: connection refused -> exit 2 and the REAL cause (ECONNREFUSED) is shown instead of just "fetch failed"; no URL, no token', gn === cli.EXIT.NETWORK && /Network error: connection failed \(ECONNREFUSED\)/.test(out2.join('\n')) && !out2.join('\n').includes(TOKEN) && !/\/bot/.test(out2.join('\n')));
    const mk2 = (code, cause) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(cause || 'x'), { code }) });
    ok('describeNetworkError classifies DNS, connection, TLS and timeout causes', [['ENOTFOUND', /DNS lookup failed \(ENOTFOUND\)/], ['EAI_AGAIN', /DNS lookup failed/], ['ETIMEDOUT', /connection failed/], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', /TLS\/certificate/], ['CERT_HAS_EXPIRED', /TLS\/certificate/], ['UND_ERR_CONNECT_TIMEOUT', /timeout/]].every(([c, re]) => re.test(cli.describeNetworkError(mk2(c)))) && /^timeout/.test(cli.describeNetworkError(Object.assign(new Error('x'), { name: 'AbortError' }))) && !/fetch failed$/.test(cli.describeNetworkError(mk2('ENOTFOUND', 'getaddrinfo ENOTFOUND api.telegram.org'))));
    const warnOut = []; const gRefuse = await cli.run('check', Object.assign({ TELEGRAM_API_BASE: 'https://evil.example' }, tokEnv), { log: m => warnOut.push(m) });
    ok('a TELEGRAM_API_BASE override (e.g. from an old .env) is REFUSED for real use, so the token is never sent to another host; the host name is shown', gRefuse === cli.EXIT.CONFIG && /evil\.example/.test(warnOut.join('\n')) && /instead of api\.telegram\.org/.test(warnOut.join('\n')) && !warnOut.join('\n').includes(TOKEN));
    const okOut = []; await cli.run('check', Object.assign({ TELEGRAM_API_BASE: dBase, ALLOW_CUSTOM_TELEGRAM_API: '1' }, tokEnv), { log: m => okOut.push(m) });
    ok('...unless explicitly allowed for a local test server (and then it says so)', /non-default Telegram API host/.test(okOut.join('\n')) && /Token accepted/.test(okOut.join('\n')));
    ok('every run says which API host it contacts (host only, never the path that contains the token)', /Contacting Telegram API host: 127\.0\.0\.1:\d+/.test(g1.text) && !g1.text.includes(TOKEN));
    const gset = await (async () => { behave.mode = 'invalid'; const o = []; const code = await cli.run('set', tokEnv, { log: m => o.push(m), apiBase: dBase }); return { code, text: o.join('\n') }; })();
    ok('set/info/delete use the same diagnostics (a 401 on setWebhook is exit 4 with the same explanation)', gset.code === 4 && /token is invalid/.test(gset.text));
    diag.close();

    // ---------- logging hygiene ----------
    const dump = logged.join('\n');
    ok('nothing logged anywhere contains the bot token, the webhook secret, phone numbers or update payload text', !dump.includes(TOKEN) && !dump.includes(SECRET) && !/9000000\d{3}|SENSITIVE/.test(dump) && !/"update_id"|"callback_query"/.test(dump), dump.slice(0, 200));
    app.close();
  } catch (e) { ok('test run crashed', false, e.stack); }
  const fail = res.filter(r => r.startsWith('FAIL')); out(res.join('\n')); out('\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed');
  fs.rmSync(dir, { recursive: true, force: true }); process.exit(fail.length ? 1 : 0);
})();
