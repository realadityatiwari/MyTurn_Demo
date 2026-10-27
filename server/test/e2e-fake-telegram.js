/* End-to-end test of the Telegram bot against a LOCAL FAKE of the Telegram Bot API (no real bot, no network).
   Run: node server/test/e2e-fake-telegram.js      */
'use strict';
const http = require('http');
const { createApp } = require('../server');
const { start } = require('../bot');

const FAKE_TOKEN = '123456789:FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE000';
const results = []; const ok = (n, c, x) => { results.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || ''))); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- fake Telegram ----
const sent = [], pending = []; let nextId = 1000; const apiCalls = [];
const fake = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/); const body = b ? JSON.parse(b) : {};
    if (!m || m[1] !== FAKE_TOKEN) { res.writeHead(401); return res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })); }
    apiCalls.push(m[2]);
    const reply = r => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: r })); };
    if (m[2] === 'getMe') return reply({ username: 'fake_bot' });
    if (m[2] === 'sendMessage') { sent.push(body); return reply({ message_id: 1 }); }
    if (m[2] === 'getUpdates') { const take = () => { const u = pending.splice(0); return u; }; if (pending.length) return reply(take()); return setTimeout(() => reply(take()), 150); }
    return reply(true);
  });
});
const push = u => pending.push(Object.assign({ update_id: nextId++ }, u));
const msg = (uid, text) => push({ message: { chat: { id: uid, type: 'private' }, from: { id: uid, first_name: 'User' + uid, last_name: 'Test' }, text } });
const cb = (uid, data) => push({ callback_query: { id: 'q' + nextId, from: { id: uid, first_name: 'User' + uid }, message: { chat: { id: uid, type: 'private' } }, data } });
const lastTo = (chat, n = 1) => sent.filter(s => s.chat_id === chat).slice(-n).map(s => s.text).join(' || ');
const flush = () => sleep(500);

(async () => {
  await new Promise(r => fake.listen(5191, '127.0.0.1', r));
  const app = createApp(); await new Promise(r => app.server.listen(5190, '127.0.0.1', r));
  const logs = [];
  const bot = start({ app, token: FAKE_TOKEN, apiBase: 'http://127.0.0.1:5191', log: (...a) => logs.push(a.join(' ')) });
  await sleep(600);
  const S = app.S, q = () => S.get().q['rv:gm'];
  try {
    ok('bot connected + commands configured', logs.some(l => /connected as @fake_bot/.test(l)) && apiCalls.includes('setMyCommands'));
    // malformed token is refused safely (no throw, no secret printed)
    const errs = []; const oe = console.error; console.error = (...a) => errs.push(a.join(' ')); start({ app, token: 'bad', apiBase: 'http://x' }); console.error = oe;
    ok('malformed token -> safe message, token not echoed', errs.length === 1 && !/bad/.test(errs[0].replace('"<digits>:<secret>"', '')) );

    msg(1, '/start'); await flush();
    ok('/start shows welcome + 4 buttons', /Welcome to MyTurn/.test(lastTo(1)) && sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text).join() === 'Register for a visit,My token,Queue status,Help');

    msg(1, '/register'); await flush();
    const clinics = sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text);
    ok('/register offers only clinics with open sessions from shared data', clinics.join() === 'Riverside Hospital,Lakeview Family Clinic,Northgate Children\'s Hospital,Maple Street Eye Clinic', clinics.join());
    cb(1, 'c:rv'); await flush();
    const svcs = sent.at(-1).reply_markup.inline_keyboard.flat().map(b => b.text);
    ok('services = open sessions only', svcs.length === 2 && /General Medicine/.test(svcs[0]) && /Children/.test(svcs[1]), svcs.join());
    cb(1, 's:rv:gm'); await flush();
    ok('confirmation says remote registration is not check-in', /NOT in the waiting queue/.test(lastTo(1)));
    const before = q().length;
    cb(1, 'ok:rv:gm'); await flush();
    const mine = q().filter(e => e.acct === 'tg:1');
    ok('registration creates ONE real entry in the shared store, token K 044', mine.length === 1 && mine[0].tok === 'K 044' && q().length === before + 1, JSON.stringify(mine));
    ok('remote registration is NOT checked in (status reg)', mine[0].st === 'reg');
    ok('confirmation message shows token + check-in instruction', /Token: K 044/.test(lastTo(1)) && /does NOT put you in the waiting queue/.test(lastTo(1)));

    // idempotency
    cb(1, 'ok:rv:gm'); cb(1, 'ok:rv:gm'); await flush();
    ok('repeated confirm taps do not duplicate', q().filter(e => e.acct === 'tg:1').length === 1 && /already have an active registration/.test(lastTo(1)));
    const dup = { update_id: 777, message: { chat: { id: 1, type: 'private' }, from: { id: 1, first_name: 'U' }, text: '/help' } }; const n0 = sent.length; pending.push(dup, dup); await flush();
    ok('duplicate update_id delivered twice is handled once', sent.length === n0 + 1);

    // token/status before check-in
    msg(1, '/token'); await flush(); ok('/token shows token + Registered – not checked in, and NO estimate yet', /K 044/.test(lastTo(1)) && /not checked in/.test(lastTo(1)) && /not available yet/.test(lastTo(1)) && !/Estimated wait: (about|up to)/.test(lastTo(1)), lastTo(1));
    msg(1, '/status'); await flush(); ok('/status explains how to check in and gives no estimate', /NOT in the waiting line/.test(lastTo(1)) && !/Estimated wait: (about|up to)/.test(lastTo(1)));

    // the entry is what the website's Staff UI reads
    // Phase 3: queue data needs a signed-in staff session (local demo credentials, verified by the server); no Telegram id is ever sent
    const lg = await fetch('http://127.0.0.1:5190/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'operator', password: 'demo' }) });
    const ck = lg.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const getState = async () => (await fetch('http://127.0.0.1:5190/api/state', { headers: { Cookie: ck } })).json();
    const stateRes = await getState();
    ok('token visible through the same API the website Staff queue uses (signed-in staff; no Telegram id exposed)', stateRes.shared.q['rv:gm'].some(e => e.tok === 'K 044' && e.st === 'reg' && e.acct === undefined) && !JSON.stringify(stateRes).includes('tg:1'));

    // staff (existing rules) check the patient in, advance and call
    const id = mine[0].id;
    app.runAs({ staff: { user: 'operator', role: 'op', sess: 'rv:gm' } }, () => S.markArrived(id));
    const w1 = S.waitInfo(id); const est1 = 'Estimated wait: about ' + w1.lo + '–' + w1.hi + ' min';
    msg(1, '/status'); await flush(); ok('after staff Mark arrived: Checked in – waiting, ahead count and estimate equal S.waitInfo', /Checked in – waiting/.test(lastTo(1)) && lastTo(1).includes('Ahead of you: ' + w1.ahead) && lastTo(1).includes(est1) && /not a guarantee/.test(lastTo(1)), lastTo(1));
    msg(1, '/token'); await flush(); ok('/token shows the same estimate as /status', lastTo(1).includes('Ahead of you: ' + w1.ahead) && lastTo(1).includes(est1), lastTo(1));
    const apiW = await getState();
    const rowsAhead = apiW.shared.q['rv:gm'].slice(0, apiW.shared.q['rv:gm'].findIndex(e => e.id === id)).filter(e => e.st === 'wait').length;
    ok('website/API replica of the queue gives the same ahead count as the bot', rowsAhead === w1.ahead && apiW.shared.policy.avgServiceMin === w1.avg);
    for (let i = 0; i < 12; i++) S.tick();
    msg(1, '/status'); await flush(); ok('queue advanced by existing logic: bot says next in line with an up-to estimate', /next in line/.test(lastTo(1)) && /Estimated wait: up to about 5 min/.test(lastTo(1)), lastTo(1));
    app.runAs({ staff: { user: 'operator', role: 'op', sess: 'rv:gm' } }, () => S.callNext('rv:gm'));
    msg(1, '/status'); await flush(); ok('staff Call next -> bot shows Your turn + room, no estimate', /Status: Your turn/.test(lastTo(1)) && /Room 4/.test(lastTo(1)) && !/Estimated wait/.test(lastTo(1)), lastTo(1));
    app.runAs({ staff: { user: 'operator', role: 'op', sess: 'rv:gm' } }, () => S.markMissed(id));
    msg(1, '/status'); await flush(); ok('missed turn visible, no estimate', /Missed turn/.test(lastTo(1)) && !/Estimated wait/.test(lastTo(1)));
    app.runAs({ patient: { phone: 'tg:1', sel: 'p1' } }, () => S.requestReturn(id));   // (the bot has no return command in this phase)
    app.runAs({ staff: { user: 'operator', role: 'op', sess: 'rv:gm' } }, () => { S.acceptReturn(id, false); S.call(id); S.start(id); S.complete(id); });
    msg(1, '/token'); await flush(); ok('after service completes: Completed', /Completed/.test(lastTo(1)));

    // isolation
    msg(2, '/token'); await flush(); ok('another Telegram user sees NO data of user 1', /no registration yet/.test(lastTo(2)) && !/K 044/.test(lastTo(2)));
    msg(2, '/status'); await flush(); ok('another user /status leaks nothing', !/K 044/.test(lastTo(2)));
    const web = app.runAs({ patient: { phone: '9876543210', sel: 'p1' } }, () => S.myVisits().length).result;
    ok('website phone account cannot see Telegram entries', web === 0);

    // robustness
    msg(2, 'hello?'); await flush(); ok('unknown text -> help hint', /did not understand/.test(lastTo(2)));
    push({ message: { chat: { id: 5, type: 'group' }, from: { id: 5 }, text: '/start' } }); const n1 = sent.length; await flush(); ok('group chats ignored', sent.length === n1);
    push({ update_id: 'x' }); push({ foo: 1 }); push({ callback_query: { id: 'z', from: { id: 9 }, data: 'ok:../../x:y' } }); await flush();
    ok('malformed updates / bad callback data do not crash', logs.every(l => !/undefined|TypeError/.test(l)));
    cb(2, 's:zz:yy'); await flush(); ok('unknown clinic/session rejected', /not available/.test(lastTo(2)));
    cb(2, 's:rv:ey'); await flush(); ok('non-open session cannot be registered', /not available/.test(lastTo(2)));

    // reset consistency
    S.reset('normal'); await sleep(50);
    msg(1, '/token'); await flush(); ok('after demo reset the bot keeps working and shows no stale token', /no registration yet/.test(lastTo(1)));
    cb(1, 'ok:rv:gm'); await flush(); ok('can register again after reset, token K 044 again', q().some(e => e.acct === 'tg:1' && e.tok === 'K 044' && e.st === 'reg'));

    // API failure handling
    const failing = start({ app, token: '987654321:WRONGWRONGWRONGWRONGWRONGWRONGWRONG1', apiBase: 'http://127.0.0.1:5191' });
    await sleep(400); failing.stop();
    ok('token never appears in logs', logs.concat(results).every(l => !l.includes(FAKE_TOKEN)));
  } catch (e) { results.push('ERROR ' + e.stack); }
  bot.stop(); app.close(); fake.close();
  console.log(results.join('\n'));
  console.log('\n' + results.filter(r => r.startsWith('PASS')).length + ' passed, ' + results.filter(r => !r.startsWith('PASS')).length + ' failed');
  process.exit(results.some(r => !r.startsWith('PASS')) ? 1 : 0);
})();
