/* Phase 2 tests: server-side authentication and authorization.
   Run: node server/test/auth.test.js      (no network; temporary SQLite files; test-only passwords generated in memory) */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { createApp } = require('../server');
const A = require('../auth');

const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-auth-'));
const quiet = { logError() {} };
const OP_PW = crypto.randomBytes(12).toString('base64url'), ADMIN_PW = crypto.randomBytes(12).toString('base64url');   // random, test-only, never printed
let clock = 1e12; const now = () => clock;

const mk = async (o) => {
  const cfg = Object.assign({ users: { operator: { role: 'op', hash: await A.hashPassword(OP_PW) }, admin: { role: 'admin', hash: await A.hashPassword(ADMIN_PW) } },
    demoCredentials: false, patientWeb: 'demo', openControls: false, allowReset: true, secureCookie: false, proxyHeader: null, warnings: [] }, o && o.auth);
  const app = createApp(Object.assign({ dbPath: o && o.dbPath || null, seedMode: 'empty', now, auth: cfg }, quiet, o && o.rest || {}));
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); app.port = app.server.address().port; return app;
};
class Client {                                           // minimal cookie-jar browser
  constructor(app, extra) { this.app = app; this.jar = {}; this.extra = extra || {}; }
  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => k + '=' + v).join('; '); }
  async req(method, p, body, headers) {
    const h = Object.assign({}, this.extra, headers || {}); if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (Object.keys(this.jar).length && !h.Cookie) h.Cookie = this.cookieHeader();
    const r = await fetch('http://127.0.0.1:' + this.app.port + p, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.getSetCookie(); for (const c of sc) { const [kv] = c.split(';'), i = kv.indexOf('='); const v = kv.slice(i + 1); if (v === '') delete this.jar[kv.slice(0, i)]; else this.jar[kv.slice(0, i)] = v; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text, setCookie: sc, headers: r.headers };
  }
  act(method, args, extra) { return this.req('POST', '/api/action', Object.assign({ method, args: args || [] }, extra)); }
  login(user, password) { return this.req('POST', '/api/auth/login', { user, password }); }
  me() { return this.req('GET', '/api/auth/me').then(r => r.json); }
}
const state = app => JSON.stringify(app.snapshot().shared);
const rv = app => app.S.get().q['rv:gm'];

(async () => {
  try {
    // ---------- password hashing ----------
    const h1 = await A.hashPassword('correct horse'), h2 = await A.hashPassword('correct horse');
    ok('scrypt hash has the documented format and a per-hash random salt', /^scrypt\$16384\$8\$1\$/.test(h1) && h1 !== h2 && !h1.includes('correct horse'));
    ok('verify: right password true, wrong false, malformed/empty stored hash false', await A.verifyPassword('correct horse', h1) && !(await A.verifyPassword('correct horsf', h1)) && !(await A.verifyPassword('x', 'plain')) && !(await A.verifyPassword('x', '')) && !(await A.verifyPassword('x', 'scrypt$9999999$8$1$AA==$AA==')));

    // ---------- unauthenticated + body-supplied identity ----------
    const dbFile = path.join(dir, 'a.db');
    let app = await mk({ dbPath: dbFile });
    const anon = new Client(app), before = state(app), rev0 = app.getRev();
    const staffCalls = ['call', 'callNext', 'start', 'complete', 'markMissed', 'markArrived', 'markNoShow', 'acceptReturn', 'declineReturn', 'cancelVisit', 'resetQueue', 'reset', 'tick'];
    const un = []; for (const m of staffCalls) un.push((await anon.act(m, [m === 'callNext' || m === 'resetQueue' ? 'rv:gm' : m === 'reset' ? 'normal' : 'x'])).status);
    ok('unauthenticated: every staff/admin/control action is refused with 401', un.every(s => s === 401), un.join());
    ok('unauthenticated requests changed nothing (state and revision identical)', state(app) === before && app.getRev() === rev0);
    const forged = await anon.req('POST', '/api/action', { method: 'resetQueue', args: ['rv:gm'], session: { staff: { user: 'admin', role: 'admin', sess: null } }, role: 'admin', staff: { role: 'admin' } });
    ok('role/user supplied in the request body is ignored (still 401)', forged.status === 401);
    const forgedP = await anon.req('POST', '/api/action', { method: 'saveProfile', args: [{ name: 'X', rel: 'Myself' }], session: { patient: { phone: '9876543210' } } });
    ok('patient phone supplied in the body is ignored (401, nothing created)', forgedP.status === 401 && !app.S.get().accounts['9876543210']);
    const me0 = await anon.me(); ok('/api/auth/me for an anonymous browser: no staff, no patient', me0.staff === null && me0.patient === null);

    // ---------- staff login ----------
    const bad = new Client(app);
    const b1 = await bad.login('operator', 'wrong-password'), b2 = await bad.login('nobody', 'whatever');
    ok('wrong password and unknown user both get the same 401 "badcreds"', b1.status === 401 && b2.status === 401 && b1.text === b2.text && !b1.setCookie.length);
    const op = new Client(app), lo = await op.login('Operator', OP_PW);
    ok('operator logs in (user name case-insensitive); response has role, never a password or hash', lo.status === 200 && lo.json.role === 'op' && !lo.text.includes(OP_PW) && !/scrypt\$/.test(lo.text));
    const sc = lo.setCookie.join(' | ');
    ok('staff cookie is HttpOnly + SameSite=Strict + Path=/ + Max-Age (no Secure over plain-http dev)', /mt_staff=[A-Za-z0-9_-]{40,}/.test(sc) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc) && /Path=\//.test(sc) && /Max-Age=\d+/.test(sc) && !/Secure/.test(sc));
    ok('/api/auth/me shows the server-side identity', (await op.me()).staff.role === 'op');

    // ---------- registration by a website patient (demo mode) so staff have something to act on ----------
    const pa = new Client(app), pb = new Client(app);
    ok('patient sign-in creates a patient session cookie (HttpOnly)', (await pa.act('patientSignIn', ['9000000001'])).setCookie.some(c => /^mt_patient=/.test(c) && /HttpOnly/.test(c)));
    await pb.act('patientSignIn', ['9000000002']);
    await pa.act('saveProfile', [{ name: 'Asha', rel: 'Myself' }]); await pb.act('saveProfile', [{ name: 'Bala', rel: 'Myself' }]);
    const ra = await pa.act('register', ['rv:gm', 'p1']), rb = await pb.act('register', ['rv:gm', 'p1']);
    ok('existing queue behaviour: patients register through authenticated sessions (status reg, tokens issued)', ra.json.result.ok && rb.json.result.ok && rv(app).length === 2 && rv(app).every(e => e.st === 'reg') && rv(app)[0].tok !== rv(app)[1].tok);
    const ea = rv(app).find(e => e.acct === '9000000001'), eb = rv(app).find(e => e.acct === '9000000002');

    // ---------- patient isolation ----------
    const snapA = JSON.stringify(ea);
    const x1 = await pb.act('patientCancel', [ea.id]), x2 = await pb.act('checkIn', [ea.id]), x3 = await pb.act('requestReturn', [ea.id]), x4 = await pb.act('deleteProfile', ['p1']);
    ok("patient B cannot cancel/check in/request-return on patient A's entry (403, entry unchanged)", [x1, x2, x3].every(r => r.status === 403) && JSON.stringify(rv(app).find(e => e.id === ea.id)) === snapA);
    ok("patient B's deleteProfile only ever touches B's own account (A's profile untouched)", app.S.get().accounts['9000000001'].profiles.length === 1);
    const spoof = await pb.req('POST', '/api/action', { method: 'patientCancel', args: [ea.id], session: { patient: { phone: '9000000001' } } });
    ok("body-supplied phone cannot make B act as A", spoof.status === 403 && rv(app).find(e => e.id === ea.id).st === 'reg');
    const pOnlyStaff = await pa.act('markArrived', [ea.id]);
    ok('a patient session cannot perform staff actions (401)', pOnlyStaff.status === 401 && rv(app).find(e => e.id === ea.id).st === 'reg');
    const eve = new Client(app); eve.jar.mt_patient = 'A'.repeat(43);
    ok('invented / unknown patient session id is refused (401)', (await eve.act('saveProfile', [{ name: 'E', rel: 'Other' }])).status === 401);

    // ---------- Telegram identity ----------
    const tgSign = await anon.act('patientSignIn', ['tg:123456']);
    ok("website cannot sign in as a reserved Telegram account ('tg:*' -> 400, no account)", tgSign.status === 400 && !app.S.get().accounts['tg:123456']);
    const tgReg = app.runAs({ patient: { phone: 'tg:777', sel: null } }, () => { app.S.patientSignIn('tg:777'); app.S.saveProfile({ name: 'Tele', rel: 'Myself' }); return app.S.register('rv:gm', app.S.profiles()[0].id); }).result;
    const et = rv(app).find(e => e.acct === 'tg:777');
    ok('in-process Telegram registration still works and is its own account', tgReg.ok && et && et.st === 'reg');
    const tgSnap = JSON.stringify(et);
    const tc = [await pa.act('patientCancel', [et.id]), await pb.act('requestReturn', [et.id]), await pa.act('checkIn', [et.id])];
    ok("website patients cannot read-modify a Telegram user's registration", tc.every(r => r.status === 403) && JSON.stringify(rv(app).find(e => e.id === et.id)) === tgSnap);
    ok('Telegram ids can never become staff (no API route assigns staff from a patient/tg identity)', (await anon.act('call', [et.id])).status === 401);

    // ---------- operator permissions and role boundaries ----------
    const cA = await op.act('markArrived', [ea.id]);
    ok('operator (Riverside) can mark a patient arrived; audit name derives from the server role', cA.json.result.ok && rv(app).find(e => e.id === ea.id).st === 'wait');
    const cB = await op.act('callNext', ['rv:gm']), cs = await op.act('start', [ea.id]), cc = await op.act('complete', [ea.id]);
    ok('existing queue behaviour: callNext -> start -> complete by operator', cB.json.result.ok && cs.json.result.ok && cc.json.result.ok && rv(app).find(e => e.id === ea.id).st === 'done');
    ok('audit log records "operator" taken from the session role', app.S.get().audit.some(a => a.who === 'operator' || a.by === 'operator' || a.user === 'operator'), JSON.stringify(app.S.get().audit.slice(-2)));
    const otherKey = app.S.CLINICS.find(c => c.id !== 'rv' && c.sessions.some(s => s.st === 'open')); const okey = otherKey.id + ':' + otherKey.sessions.find(s => s.st === 'open').id;
    app.S.get().q[okey] = app.S.get().q[okey] || []; app.S.get().q[okey].push({ id: 'zz9', tok: 'Z 001', st: 'wait', acct: 'seed', name: 'Other', rel: 'Other', pid: 'x' });
    const beforeOther = JSON.stringify(app.S.get().q[okey]);
    const xo = [await op.act('callNext', [okey]), await op.act('call', ['zz9']), await op.act('cancelVisit', ['zz9'])];
    ok("operator is limited to Riverside: 403 on another clinic's queue, which stays unchanged", xo.every(r => r.status === 403) && JSON.stringify(app.S.get().q[okey]) === beforeOther);
    const scen0 = app.S.get().scenario, opAdmin = [await op.act('resetQueue', ['rv:gm']), await op.act('reset', ['missed']), await op.act('tick')];
    ok('operator cannot reset a queue, switch scenarios or tick (403)', opAdmin.every(r => r.status === 403) && app.S.get().scenario === scen0 && rv(app).length === 3, opAdmin.map(r => r.status).join() + ' ' + app.S.get().scenario + ' ' + rv(app).length);
    const ov = await op.act('acceptReturn', [eb.id, true]);
    ok('operator cannot use the admin override on returns (store enforces role from the server session)', ov.json.result.err === 'state' || ov.json.result.err === 'forbidden');

    // ---------- admin ----------
    const adm = new Client(app); await adm.login('admin', ADMIN_PW);
    const rq = await adm.act('resetQueue', ['rv:gm']);
    ok('admin can reset one queue', rq.status === 200 && rq.json.result.ok && rv(app).length === 0);
    const epoch0 = app.getEpoch(), rs = await adm.act('reset', ['missed']);
    ok('admin can switch scenario (reset); epoch changes; session survives', rs.status === 200 && app.S.get().scenario === 'missed' && app.getEpoch() !== epoch0 && (await adm.me()).staff.role === 'admin');
    ok('admin can tick', (await adm.act('tick')).status === 200);

    // ---------- invalid / expired / replayed sessions ----------
    const junk = new Client(app); junk.jar.mt_staff = 'not-a-real-session-token-0123456789abcdef';
    ok('garbage staff cookie -> 401 and /me reports signed out', (await junk.act('callNext', ['rv:gm'])).status === 401 && (await junk.me()).staff === null);
    const half = new Client(app); half.jar.mt_staff = adm.jar.mt_staff.slice(0, 20);
    ok('truncated real token -> 401', (await half.act('resetQueue', ['rv:gm'])).status === 401);
    const stolen = adm.jar.mt_staff, out = await adm.req('POST', '/api/auth/logout', {});
    const replay = new Client(app); replay.jar.mt_staff = stolen;
    ok('logout destroys the server session: the old cookie is dead (replay -> 401) and the cookie is cleared', out.status === 200 && (await replay.act('resetQueue', ['rv:gm'])).status === 401 && !adm.jar.mt_staff && /mt_staff=;/.test(out.setCookie.join()));
    const idle = new Client(app); await idle.login('operator', OP_PW);
    clock += 29 * 60e3; ok('staff session still valid just inside the 30-minute idle limit', (await idle.me()).staff !== null);
    clock += 31 * 60e3; ok('staff session expires after 30 minutes idle', (await idle.act('callNext', ['rv:gm'])).status === 401 && (await idle.me()).staff === null);
    const abs = new Client(app); await abs.login('operator', OP_PW);
    for (let i = 0; i < 17; i++) { clock += 29 * 60e3; await abs.me(); }
    ok('staff session has an absolute 8-hour lifetime even when kept active', (await abs.me()).staff === null);

    // ---------- session fixation ----------
    const fx = new Client(app); fx.jar.mt_staff = 'attacker-chosen-session-id-0123456789abcdef'; fx.jar.mt_patient = 'attacker-chosen-session-id-fedcba9876543210';
    const fl = await fx.login('operator', OP_PW), newTok = fx.jar.mt_staff;
    const attacker = new Client(app); attacker.jar.mt_staff = 'attacker-chosen-session-id-0123456789abcdef';
    ok('fixation: login issues a NEW staff session id; the pre-set id never becomes authenticated', fl.status === 200 && newTok !== 'attacker-chosen-session-id-0123456789abcdef' && (await attacker.me()).staff === null);
    const ps = new Client(app); ps.jar.mt_patient = 'attacker-chosen-session-id-fedcba9876543210'; await ps.act('patientSignIn', ['9000000009']);
    const att2 = new Client(app); att2.jar.mt_patient = 'attacker-chosen-session-id-fedcba9876543210';
    ok('fixation: patient sign-in also rotates the id (pre-set id stays anonymous)', ps.jar.mt_patient !== 'attacker-chosen-session-id-fedcba9876543210' && (await att2.me()).patient === null);
    const old = fx.jar.mt_staff; await fx.login('operator', OP_PW);
    const oldC = new Client(app); oldC.jar.mt_staff = old;
    ok('re-login rotates again and invalidates the previous staff session id', fx.jar.mt_staff !== old && (await oldC.me()).staff === null);
    ok('staff and patient sessions are independent (staff login did not create a patient session)', (await new Client(app).login('operator', OP_PW)).setCookie.every(c => !/mt_patient/.test(c)));

    // ---------- brute force ----------
    clock += 3600e3;
    const bf = new Client(app), codes = [];
    for (let i = 0; i < 6; i++) codes.push((await bf.login('operator', 'guess-' + i)).status);
    ok('brute force: 5 wrong guesses allowed, the 6th is throttled (429)', codes.slice(0, 5).every(s => s === 401) && codes[5] === 429, codes.join());
    const thr = await bf.login('operator', OP_PW);
    ok('throttled: even the CORRECT password is refused, with Retry-After', thr.status === 429 && +thr.headers.get('retry-after') > 0 && !thr.setCookie.length);
    ok('lockout is per IP+user: another account from the same IP can still sign in', (await new Client(app).login('admin', ADMIN_PW)).status === 200);
    clock += 16 * 60e3; ok('lockout ends after the window; the correct password works again', (await bf.login('operator', OP_PW)).status === 200);
    const bf2 = new Client(app); for (let i = 0; i < 5; i++) await bf2.login('operator', 'x' + i); await bf2.login('operator', 'x'); clock += 16 * 60e3; await bf2.login('operator', 'y');
    for (let i = 0; i < 5; i++) await bf2.login('operator', 'z' + i);
    ok('repeat offenders get a longer lock (doubling)', (await bf2.login('operator', OP_PW)).status === 429 && (clock += 16 * 60e3, (await bf2.login('operator', OP_PW)).status === 429));

    // ---------- CSRF-style protections ----------
    const cs1 = await adm.login('admin', ADMIN_PW); const csrf = new Client(app, { Origin: 'https://evil.example' });
    csrf.jar = Object.assign({}, adm.jar);
    ok('cross-origin POST (Origin differs from Host) is refused (403) even with a valid cookie', (await csrf.act('resetQueue', ['rv:gm'])).status === 403 && (await csrf.login('admin', ADMIN_PW)).status === 403);
    const ct = new Client(app); ct.jar = Object.assign({}, adm.jar);
    ok('non-JSON content type is refused (415) so plain HTML forms cannot post actions', (await ct.req('POST', '/api/action', 'method=resetQueue', { 'Content-Type': 'text/plain' })).status === 415);
    ok('same-origin Origin header is accepted', (await new Client(app, { Origin: 'http://127.0.0.1:' + app.port }).login('admin', ADMIN_PW)).status === 200);

    // ---------- persistence still works with auth; sessions are not persisted ----------
    const admP = new Client(app); await admP.login('admin', ADMIN_PW); await admP.act('reset', ['normal']);
    const live = state(app), epochLive = app.getEpoch(); app.close();
    app = await mk({ dbPath: dbFile });
    ok('queue state and epoch survive restart exactly as in Phase 1', state(app) === live && app.getEpoch() === epochLive);
    const afterRestart = new Client(app); afterRestart.jar = Object.assign({}, admP.jar);
    ok('staff sessions are in memory only: after a restart the old cookie is refused (staff must sign in again)', (await afterRestart.act('tick')).status === 401);
    app.close();

    // ---------- configuration modes ----------
    const dm = await mk({ auth: { users: {}, demoCredentials: true } }), dc = new Client(dm);
    ok('local demo credentials are verified by the SERVER (scrypt), and wrong ones fail', (await dc.login('operator', 'demo')).status === 200 && (await new Client(dm).login('operator', 'nope')).status === 401 && (await dc.me()).staff.role === 'op');
    ok('/api/auth/me labels demo credentials so the UI never presents them as real security', (await dc.me()).demoCredentials === true);
    dm.close();
    const real = await mk({ auth: { demoCredentials: false } });
    ok('with a real hash configured, the demo password "demo" does NOT work', (await new Client(real).login('operator', 'demo')).status === 401 && (await new Client(real).login('admin', 'demo')).status === 401);
    real.close();
    const off = await mk({ auth: { users: {}, demoCredentials: false } });
    ok('no staff passwords configured (and not demo): staff sign-in is disabled (503), nothing is guessable', (await new Client(off).login('admin', 'demo')).status === 503 && (await new Client(off).login('admin', '')).status === 503);
    off.close();
    const nr = await mk({ auth: { allowReset: false } }), ar = new Client(nr); await ar.login('admin', ADMIN_PW);
    ok('reset can be disabled by configuration: even admin gets 403 for scenario reset, but can still reset a queue', (await ar.act('reset', ['missed'])).status === 403 && (await ar.act('resetQueue', ['rv:gm'])).status === 200);
    nr.close();
    const dis = await mk({ auth: { patientWeb: 'disabled' } }), dp = new Client(dis);
    ok('PATIENT_WEB_MODE=disabled: website patient sign-in and actions are refused (403)', (await dp.act('patientSignIn', ['9000000001'])).status === 403 && (await dp.act('saveProfile', [{ name: 'A', rel: 'Myself' }])).status === 403);
    dis.close();
    const oc = await mk({ auth: { openControls: true } });
    ok('opt-in local presenter controls allow reset/tick without sign-in, but still not staff actions', (await new Client(oc).act('reset', ['normal'])).status === 200 && (await new Client(oc).act('call', ['x'])).status === 401);
    oc.close();
    const sec = await mk({ auth: { secureCookie: true } }), sk = new Client(sec), sl = await sk.login('operator', OP_PW);
    ok('secure mode: __Host- prefixed cookie with the Secure flag', /^__Host-mt_staff=/.test(sl.setCookie[0]) && /; Secure/.test(sl.setCookie[0]));
    sec.close();
    const P = A.authConfig({ NODE_ENV: 'production', DEMO_OPEN_CONTROLS: '1' });
    ok('production defaults: no demo credentials, patient web disabled, Secure cookies, reset disabled, open controls ignored', !P.demoCredentials && P.patientWeb === 'disabled' && P.secureCookie && !P.allowReset && !P.openControls && P.warnings.length === 1);
    ok('production + hashes from env: configured users only; malformed hash disables just that account', (() => { const c = A.authConfig({ NODE_ENV: 'production', STAFF_ADMIN_PASSWORD_HASH: h1, STAFF_OPERATOR_PASSWORD_HASH: 'garbage' }); return !c.users.operator && c.users.admin.role === 'admin' && !c.demoCredentials && c.warnings.length === 1; })());
    ok('development default: demo credentials only while no real hash is set', A.authConfig({}).demoCredentials === true && A.authConfig({ STAFF_ADMIN_PASSWORD_HASH: h1 }).demoCredentials === false);

    // ---------- read endpoints / misc ----------
    const pub = new Client(await mk({}));
    ok('no secrets in any auth response or /api/state (hashes, cookies, passwords)', !/scrypt\$|password|mt_staff/i.test((await pub.req('GET', '/api/state')).text + (await pub.me() && JSON.stringify(await pub.me()))));
  } catch (e) { ok('test run crashed', false, e.stack); }
  const fail = res.filter(r => r.startsWith('FAIL')); console.log(res.join('\n')); console.log('\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed');
  fs.rmSync(dir, { recursive: true, force: true }); process.exit(fail.length ? 1 : 0);
})();
