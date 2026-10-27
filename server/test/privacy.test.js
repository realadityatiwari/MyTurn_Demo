/* Phase 3 tests: privacy of queue data (state + SSE), rate limits, headers, origin/proxy handling, production fail-closed.
   Run: node server/test/privacy.test.js      (local only; test-only passwords generated in memory, never printed) */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), http = require('http');
const { createApp } = require('../server');
const A = require('../auth');

const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-priv-'));
const quiet = { logError() {} };
const OP_PW = crypto.randomBytes(12).toString('base64url'), ADMIN_PW = crypto.randomBytes(12).toString('base64url');
let clock = 1e12; const now = () => clock;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let HASHES = null;
const mk = async (o) => {
  HASHES = HASHES || { operator: await A.hashPassword(OP_PW), admin: await A.hashPassword(ADMIN_PW) };
  const cfg = Object.assign({ users: { operator: { role: 'op', hash: HASHES.operator }, admin: { role: 'admin', hash: HASHES.admin } },
    demoCredentials: false, patientWeb: 'demo', openControls: false, allowReset: true, secureCookie: false, proxyHeader: null, publicOrigin: null, warnings: [] }, o && o.auth);
  const app = createApp(Object.assign({ seedMode: 'empty', now, auth: cfg }, quiet, o && o.rest || {}));
  await new Promise(r => app.server.listen(0, '127.0.0.1', r)); app.port = app.server.address().port; return app;
};
class Client {
  constructor(app, extra) { this.app = app; this.jar = {}; this.extra = extra || {}; }
  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => k + '=' + v).join('; '); }
  async req(method, p, body, headers) {
    const h = Object.assign({}, this.extra, headers || {}); if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
    if (Object.keys(this.jar).length && !h.Cookie) h.Cookie = this.cookieHeader();
    const r = await fetch('http://127.0.0.1:' + this.app.port + p, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.getSetCookie(); for (const c of sc) { const [kv] = c.split(';'), i = kv.indexOf('='), v = kv.slice(i + 1); if (v === '') delete this.jar[kv.slice(0, i)]; else this.jar[kv.slice(0, i)] = v; }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text, headers: r.headers };
  }
  act(method, args, extra) { return this.req('POST', '/api/action', Object.assign({ method, args: args || [] }, extra)); }
  login(user, password) { return this.req('POST', '/api/auth/login', { user, password }); }
  state() { return this.req('GET', '/api/state'); }
  logout() { return this.req('POST', '/api/auth/logout', {}); }
  sse() {                                                  // authenticated EventSource-like stream using this client's cookies
    const events = [], c = this; let raw = '', req;
    const done = new Promise(resolve => {
      req = http.get({ host: '127.0.0.1', port: this.app.port, path: '/api/events', headers: Object.assign({}, c.extra, Object.keys(c.jar).length ? { Cookie: c.cookieHeader() } : {}) }, r => {
        c.status = r.statusCode; c.headers = r.headers; r.setEncoding('utf8');
        r.on('data', d => { raw += d; let i; while ((i = raw.indexOf('\n\n')) >= 0) { const blk = raw.slice(0, i); raw = raw.slice(i + 2); const m = blk.match(/^data: (.*)$/m); if (m) events.push(JSON.parse(m[1])); } });
        r.on('end', resolve); r.on('close', resolve);
      }); req.on('error', resolve);
    });
    return { events, close: () => req.destroy(), done, get status() { return c.status; }, get headers() { return c.headers; } };
  }
}
const until = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(15); } return false; };
const raw = (port, method, p, headers, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => resolve({ status: x.statusCode, headers: x.headers, text: b })); });
  r.on('error', reject); if (body) r.write(body); r.end();
});
const flat = o => JSON.stringify(o);

(async () => {
  try {
    const app = await mk();
    const anon = new Client(app), pa = new Client(app), pb = new Client(app), op = new Client(app), adm = new Client(app);
    await pa.act('patientSignIn', ['9000000001']); await pb.act('patientSignIn', ['9000000002']);
    await pa.act('saveProfile', [{ name: 'Asha Verma', rel: 'Myself' }]); await pb.act('saveProfile', [{ name: 'Bala Krishnan', rel: 'Myself' }]);
    await pa.act('register', ['rv:gm', 'p1']); await pb.act('register', ['rv:gm', 'p1']);
    app.runAs({ patient: { phone: 'tg:555001', sel: null } }, () => { app.S.patientSignIn('tg:555001'); app.S.saveProfile({ name: 'Tele Gram', rel: 'Myself' }); return app.S.register('rv:gm', app.S.profiles()[0].id); });
    const other = app.S.CLINICS.find(c => c.id !== 'rv' && c.sessions.some(s => s.st === 'open')), okey = other.id + ':' + other.sessions.find(s => s.st === 'open').id;
    app.S.get().q[okey] = [{ id: okey + '#1', tok: 'Z 001', name: 'Zed Other', st: 'wait', acct: '9000000077', pid: 'p1', cancelReq: false, note: null, by: null }];
    await op.login('operator', OP_PW); await adm.login('admin', ADMIN_PW);
    await adm.act('markArrived', [app.S.get().q['rv:gm'][0].id]);    // creates an audit row (staff action)
    const SECRETS = ['Asha', 'Verma', 'Bala', 'Krishnan', 'Tele', 'Gram', '9000000001', '9000000002', '9000000077', '555001', 'tg:', 'Zed'];
    const leaks = obj => SECRETS.filter(s => flat(obj).includes(s));

    // ---------- anonymous ----------
    const sa = (await anon.state()).json;
    ok('anonymous /api/state: no names, phones, Telegram ids, tokens, accounts or audit', leaks(sa).length === 0 && !/"tok":"[A-Z] \d/.test(flat(sa)) && Object.keys(sa.shared.accounts).length === 0 && sa.shared.audit.length === 0, leaks(sa).join());
    ok('anonymous view keeps only what a signed-out screen needs (statuses, counters, policy, scenario)', sa.shared.q['rv:gm'].length === 3 && sa.shared.q['rv:gm'].every(e => Object.keys(e).sort().join() === 'id,st,tok') && sa.shared.ctr && sa.shared.policy);
    const evA = anon.sse(); await until(() => evA.events.length >= 1);
    ok('anonymous SSE: same minimal view, no private fields', evA.events[0] && leaks(evA.events[0]).length === 0 && evA.events[0].shared.audit.length === 0);
    const pc = new Client(app); await pc.act('patientSignIn', ['9000000003']); await pc.act('saveProfile', [{ name: 'Chitra Nair', rel: 'Myself' }]); await pc.act('register', ['rv:gm', 'p1']);
    await until(() => evA.events.length >= 3);
    ok('anonymous SSE after new registrations: still nothing identifying', evA.events.length >= 2 && evA.events.every(e => leaks(e).length === 0 && !flat(e).includes('Chitra') && !flat(e).includes('9000000003')));
    evA.close();

    // ---------- patients ----------
    const sA = (await pa.state()).json, rowsA = sA.shared.q['rv:gm'];
    const mine = rowsA.find(e => e.acct === '9000000001'), others = rowsA.filter(e => e.acct !== '9000000001');
    ok('patient A /api/state: own visit in full, own account only', mine && mine.name === 'Asha Verma' && Object.keys(sA.shared.accounts).join() === '9000000001');
    ok("patient A cannot see B's/Telegram user's name, phone, Telegram id or profile data (only id, token, status)", others.length === 3 && others.every(e => Object.keys(e).sort().join() === 'id,st,tok') && !/Bala|Krishnan|Tele|Gram|9000000002|555001|tg:|Chitra/.test(flat(sA)));
    ok("patient A cannot see another clinic's visit details or audit", !flat(sA).includes('Zed') && !flat(sA).includes('9000000077') && sA.shared.audit.length === 0 && sA.shared.q[okey].every(e => Object.keys(e).sort().join() === 'id,st,tok'));
    const evB = pb.sse(); await until(() => evB.events.length >= 1);
    const eB = evB.events[0].shared;
    ok("patient B SSE: sees own visit, never A's/Telegram/other details", eB.q['rv:gm'].some(e => e.acct === '9000000002' && e.name === 'Bala Krishnan') && !/Asha|Verma|9000000001|Tele|555001|tg:|Chitra|Zed/.test(flat(evB.events[0])) && Object.keys(eB.accounts).join() === '9000000002');
    await pa.act('patientCancel', [mine.id]); await until(() => evB.events.length >= 2);
    ok("patient B's stream stays private across later broadcasts (A's cancellation shows only as a status)", evB.events.length >= 2 && evB.events.every(e => !/Asha|Verma|9000000001|tg:|Zed/.test(flat(e))));
    evB.close();
    const forgedCookie = new Client(app); forgedCookie.jar.mt_patient = 'A'.repeat(43);
    ok('forged patient cookie sees only the anonymous view', leaks((await forgedCookie.state()).json).length === 0);

    // ---------- staff ----------
    const sO = (await op.state()).json, rO = sO.shared.q['rv:gm'];
    ok('operator: Riverside queue with names/tokens/status, but no phones, Telegram ids, accounts', rO.length === 4 && sO.shared.audit.length > 0 && rO.some(e => e.name === 'Asha Verma' && /^K \d/.test(e.tok)) && rO.every(e => e.acct === undefined && e.pid === undefined) && Object.keys(sO.shared.accounts).length === 0 && !/9000000|tg:|555001/.test(flat(sO)));
    ok("operator receives NO entries for other clinics' queues", Object.entries(sO.shared.q).every(([k, v]) => k.startsWith('rv:') || v.length === 0) && !flat(sO).includes('Zed'));
    const sAd = (await adm.state()).json;
    ok('admin: all queues with names, still no phones/Telegram ids/accounts', flat(sAd).includes('Zed Other') && !/9000000|tg:|555001/.test(flat(sAd)) && Object.keys(sAd.shared.accounts).length === 0);
    ok('audit log is staff-only (anonymous and patients get none)', sAd.shared.audit.length > 0 && sa.shared.audit.length === 0 && sA.shared.audit.length === 0);
    const evO = op.sse(); await until(() => evO.events.length >= 1);
    ok('operator SSE: same restrictions as /api/state', evO.events[0].shared.q['rv:gm'].some(e => e.name === 'Asha Verma') && !flat(evO.events[0]).includes('Zed') && !/9000000|tg:/.test(flat(evO.events[0])));
    ok('role boundaries unchanged: operator still cannot reset (403); anonymous 401', (await op.act('resetQueue', ['rv:gm'])).status === 403 && (await anon.act('resetQueue', ['rv:gm'])).status === 401);

    // ---------- SSE vs logout / expiry / rotation ----------
    const n0 = evO.events.length, stale = op.jar.mt_staff;
    await op.logout();
    ok('logout: the open stream is downgraded immediately (view event with the anonymous shape)', await until(() => evO.events.length > n0) && evO.events[evO.events.length - 1].view === true && leaks(evO.events[evO.events.length - 1]).length === 0 && !flat(evO.events[evO.events.length - 1]).includes('Asha'));
    await pc.act('patientCancel', [rowsA[0].id]);                     // any later broadcast on the old stream
    await sleep(150);
    ok('after logout every later event on the old stream stays anonymous', evO.events.slice(n0).every(e => !flat(e).includes('Asha') && e.shared.audit.length === 0));
    const replay = new Client(app); replay.jar.mt_staff = stale; const evR = replay.sse(); await until(() => evR.events.length >= 1);
    ok('replaying the old staff cookie on a NEW stream/state gives only the anonymous view', !flat(evR.events[0]).includes('Asha') && leaks((await replay.state()).json).length === 0);
    evR.close(); evO.close();

    await op.login('operator', OP_PW); const evE = op.sse(); await until(() => evE.events.length >= 1);
    ok('fresh login: new stream is personalised again', flat(evE.events[0]).includes('Asha'));
    const nE = evE.events.length; clock += 31 * 60e3;                 // idle expiry (the stream must not keep the session alive)
    await pc.act('patientCancel', [rowsA[1].id]); await until(() => evE.events.length > nE);
    ok('expired staff session: the next broadcast on the open stream carries no staff data', evE.events.slice(nE).every(e => !flat(e).includes('Asha') && e.shared.audit.length === 0), flat(evE.events.slice(nE)).slice(0, 120));
    ok('an open stream does not extend the session lifetime (session is dead via /api/auth/me)', (await op.req('GET', '/api/auth/me')).json.staff === null);
    evE.close();

    await op.login('operator', OP_PW); const evRot = op.sse(); await until(() => evRot.events.length >= 1); const nr = evRot.events.length;
    const op2 = new Client(app); op2.jar = Object.assign({}, op.jar); await op2.login('operator', OP_PW);   // re-login rotates the id: the old one dies
    ok('re-login rotates the staff session: the stream bound to the old id is downgraded', await until(() => evRot.events.length > nr) && !flat(evRot.events[evRot.events.length - 1]).includes('Asha'));
    evRot.close();

    const evP = pb.sse(); await until(() => evP.events.length >= 1); const nP = evP.events.length;
    await pb.act('patientSignOut'); ok('patient sign-out downgrades that patient stream at once', await until(() => evP.events.length > nP) && !/Bala|9000000002/.test(flat(evP.events[evP.events.length - 1]))); evP.close();
    ok('invalid session id / junk cookie header on SSE: anonymous view (not an error leak)', await (async () => { const j = new Client(app); j.jar.mt_staff = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'; const s = j.sse(); await until(() => s.events.length >= 1); const r = s.events[0] && !flat(s.events[0]).includes('Asha'); s.close(); return r; })());

    // ---------- errors do not leak ----------
    const errs = [await anon.req('GET', '/api/nope'), await anon.req('POST', '/api/action', '{bad json', { 'Content-Type': 'application/json' }), await pb.act('checkIn', [mine.id]), await anon.act('call', [mine.id]), await anon.req('GET', '/definitely/missing.html'), await anon.act('patientSignIn', ['tg:555001'])];
    ok('error responses carry no names, phones, Telegram ids, stack traces or file paths', errs.every(r => leaks(r.text).length === 0 && !/at \w+ \(|node_modules|C:\\|server\.js|Error:/.test(r.text)), errs.map(r => r.status + ':' + r.text.slice(0, 40)).join(' | '));
    const big = await anon.req('POST', '/api/action', 'x'.repeat(30000), { 'Content-Type': 'application/json' });
    ok('oversize request body is rejected (413)', big.status === 413);

    // ---------- headers, origin, CORS ----------
    const h = (await anon.state()).headers, hs = await anon.req('GET', '/'), hSse = anon.sse(); await until(() => hSse.status);
    const need = r => r.get('content-security-policy') && r.get('x-content-type-options') === 'nosniff' && r.get('x-frame-options') === 'DENY' && r.get('referrer-policy') === 'no-referrer' && r.get('cross-origin-opener-policy') === 'same-origin' && r.get('cross-origin-resource-policy') === 'same-origin' && /camera=\(\)/.test(r.get('permissions-policy'));
    ok('security headers on API, static pages', need(h) && need(hs.headers));
    ok('security headers on the SSE response', hSse.headers['x-content-type-options'] === 'nosniff' && /frame-ancestors 'none'/.test(hSse.headers['content-security-policy']) && hSse.headers['cache-control'] === 'no-store'); hSse.close();
    const csp = hs.headers.get('content-security-policy');
    ok("CSP: scripts only from self + the page's one inline bootstrap (hash); no unsafe-eval / no unsafe-inline for scripts; no framing", /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/.test(csp) && !/script-src[^;]*unsafe/.test(csp) && /object-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp));
    ok('no HSTS over plain-http development; no CORS headers ever', !h.get('strict-transport-security') && !h.get('access-control-allow-origin'));
    const xo = new Client(app, { Origin: 'https://evil.example' });
    ok('cross-origin GET of state/events/me is refused (403) and carries no data', (await xo.state()).status === 403 && (await xo.req('GET', '/api/auth/me')).status === 403 && !(await xo.state()).text.includes('rv:gm'));
    ok('preflight-style OPTIONS gets no CORS grant', !(await anon.req('OPTIONS', '/api/action')).headers.get('access-control-allow-origin'));

    // ---------- proxy trust ----------
    const px = await mk({ auth: { proxyHeader: 'x-forwarded-for' } });
    const spoof = async (i, ip) => new Client(px, { 'X-Forwarded-For': '203.0.113.9, ' + ip }).login('operator', 'bad' + i);
    const co = []; for (let i = 0; i < 6; i++) co.push((await spoof(i, '198.51.100.7')).status);
    ok('trusted proxy header: throttling keys on the client IP the proxy reports (6th attempt from one IP locked)', co[5] === 429 && (await spoof(9, '198.51.100.8')).status === 401, co.join());
    const np = await mk(); const cn = []; for (let i = 0; i < 6; i++) cn.push((await new Client(np, { 'X-Forwarded-For': '10.1.1.' + i }).login('operator', 'bad' + i)).status);
    ok('without TRUST_PROXY_HEADER a spoofed X-Forwarded-For cannot dodge the lockout', cn[5] === 429, cn.join());
    ok('private-address check (header trusted only from a private/loopback proxy peer)', A.isPrivateAddr('127.0.0.1') && A.isPrivateAddr('::1') && A.isPrivateAddr('172.19.0.2') && A.isPrivateAddr('fdaa:0:1::3') && !A.isPrivateAddr('8.8.8.8') && !A.isPrivateAddr('172.32.0.1') && !A.isPrivateAddr('2001:db8::1'));
    px.close(); np.close();
    let CP = '172.16.9.9'; const cfx = await mk({ auth: { proxyHeader: 'cf-connecting-ip' }, rest: { peerAddress: () => CP } });
    const viaCf = ip => new Client(cfx, ip ? { 'cf-connecting-ip': ip } : {});
    const cfOk = await viaCf('203.0.113.44').login('operator', OP_PW), cfNo = await viaCf(null).login('operator', OP_PW), cfChain = await viaCf('203.0.113.44, 6.6.6.6').login('operator', OP_PW);
    CP = '8.8.8.8'; const cfPub = await viaCf('203.0.113.45').login('operator', OP_PW);
    ok('Render cf-connecting-ip integration: a valid header from the proxy peer signs in; missing/chained headers and an untrusted peer are refused (503, fail closed)', cfOk.status === 200 && cfNo.status === 503 && cfChain.status === 503 && cfPub.status === 503, [cfOk.status, cfNo.status, cfChain.status, cfPub.status].join());
    cfx.close();

    // ---------- Task A: client identity, spoofing, missing IPs, lockout isolation ----------
    const R = A.resolveClient, T = peer => ({ peer, headers: { 'fly-client-ip': '203.0.113.5' }, proxyHeader: 'fly-client-ip' });
    ok('resolveClient: no proxy configured -> the TCP peer is the client; forwarded headers are ignored (spoofing impossible)', (() => { const r = R({ peer: '198.51.100.9', headers: { 'x-forwarded-for': '6.6.6.6', 'fly-client-ip': '7.7.7.7' }, proxyHeader: null }); return r.ip === '198.51.100.9' && r.trusted && r.reason === 'direct' && R({ peer: '::ffff:198.51.100.9', headers: {}, proxyHeader: null }).ip === '198.51.100.9'; })());
    ok('resolveClient: trusted private peer + valid header -> that client (IPv4 and IPv6)', R(T('172.16.3.4')).ip === '203.0.113.5' && R(T('fdaa:0:1::3')).ip === '203.0.113.5' && R(T('::ffff:10.0.0.9')).trusted && R({ peer: '10.0.0.1', headers: { 'fly-client-ip': '2001:DB8::5' }, proxyHeader: 'fly-client-ip' }).ip === '2001:db8::5');
    ok('resolveClient: header from an UNTRUSTED (public) peer is ignored and no identity is invented (not the header, not the peer)', ['8.8.8.8', '2001:db8::1', '172.32.0.1', '100.64.0.1', 'not-an-ip', undefined].every(p => { const r = R(T(p)); return r.ip === null && r.trusted === false && r.reason === 'peer-not-trusted'; }));
    ok('resolveClient: trusted peer but header missing / empty / garbage / with a port / out of range -> unidentified (never the proxy address)', [[undefined, 'header-missing'], ['', 'header-missing'], ['garbage', 'header-invalid'], ['1.2.3.4:80', 'header-invalid'], ['999.1.1.1', 'header-invalid'], ['<script>', 'header-invalid']].every(([h, why]) => { const r = R({ peer: '10.0.0.2', headers: { 'fly-client-ip': h }, proxyHeader: 'fly-client-ip' }); return r.ip === null && !r.trusted && r.reason === why; }));
    ok('resolveClient: x-forwarded-for takes the LAST hop (client-supplied earlier hops are ignored); array-valued headers use the last value', R({ peer: '10.0.0.2', headers: { 'x-forwarded-for': '6.6.6.6, 9.9.9.9, 198.51.100.7' }, proxyHeader: 'x-forwarded-for' }).ip === '198.51.100.7' && R({ peer: '10.0.0.2', headers: { 'fly-client-ip': ['6.6.6.6', '198.51.100.8'] }, proxyHeader: 'fly-client-ip' }).ip === '198.51.100.8');
    const C = ip => ({ peer: '10.0.0.2', headers: { 'cf-connecting-ip': ip }, proxyHeader: 'cf-connecting-ip' });
    ok('resolveClient: Render/Cloudflare cf-connecting-ip is accepted only as ONE valid IP from a trusted peer; chains, duplicates, missing headers and untrusted peers are unidentified', R(C('203.0.113.5')).ip === '203.0.113.5' && R(C('2001:DB8::5')).ip === '2001:db8::5' && R({ peer: '10.0.0.2', headers: { 'cf-connecting-ip': '203.0.113.5, 6.6.6.6' }, proxyHeader: 'cf-connecting-ip' }).reason === 'header-invalid' && R({ peer: '10.0.0.2', headers: { 'cf-connecting-ip': ['203.0.113.5', '6.6.6.6'] }, proxyHeader: 'cf-connecting-ip' }).reason === 'header-invalid' && R({ peer: '10.0.0.2', headers: {}, proxyHeader: 'cf-connecting-ip' }).reason === 'header-missing' && R(C('not-an-ip')).reason === 'header-invalid' && R({ peer: '8.8.8.8', headers: { 'cf-connecting-ip': '203.0.113.5' }, proxyHeader: 'cf-connecting-ip' }).reason === 'peer-not-trusted');
    const narrow = A.parseCidrs(['172.19.0.0/16', 'fdaa::/16']).list;
    ok('TRUSTED_PROXY_CIDRS narrows trust to the listed ranges only (loopback and other private ranges no longer trusted)', A.isTrustedPeer('172.19.0.2', narrow) && A.isTrustedPeer('fdaa:0:1::3', narrow) && !A.isTrustedPeer('10.0.0.1', narrow) && !A.isTrustedPeer('127.0.0.1', narrow) && !A.isTrustedPeer('172.20.0.1', narrow) && R({ peer: '10.0.0.1', headers: { 'fly-client-ip': '203.0.113.5' }, proxyHeader: 'fly-client-ip', trust: narrow }).reason === 'peer-not-trusted');
    ok('CIDR validation: bad entries are reported; production refuses them, and refuses CIDRs without a proxy header', A.parseCidrs(['10.0.0.0/8', 'nope', '1.2.3.4/33', '::1/129', '10.0.0.0']).bad.length === 4 && A.productionErrors(Object.assign(A.authConfig({ NODE_ENV: 'production' }), { trustedProxyCidrs: ['bad'], proxyHeader: 'fly-client-ip' }), {}).some(e => /TRUSTED_PROXY_CIDRS/.test(e)) && A.productionErrors(Object.assign(A.authConfig({ NODE_ENV: 'production' }), { trustedProxyCidrs: ['10.0.0.0/8'], proxyHeader: null }), {}).some(e => /together with TRUST_PROXY_HEADER/.test(e)));

    ok('production accepts cf-connecting-ip for Render and still refuses an unknown proxy header', (() => { const e = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://myturn.example', STAFF_ADMIN_PASSWORD_HASH: HASHES.admin, DATABASE_PATH: path.join(dir, 'prod.db'), TRUST_PROXY_HEADER: 'cf-connecting-ip' }; return A.productionErrors(A.authConfig(e), e).length === 0 && A.productionErrors(A.authConfig(Object.assign({}, e, { TRUST_PROXY_HEADER: 'x-client-ip' })), Object.assign({}, e, { TRUST_PROXY_HEADER: 'x-client-ip' })).some(x => /TRUST_PROXY_HEADER/.test(x)); })());

    // integration: a switchable TCP peer lets us act as the platform proxy (trusted) or as a stranger (untrusted public peer)
    let PEER = '172.16.9.9'; const idLogs = [];
    const fx = await mk({ auth: { proxyHeader: 'fly-client-ip', rate: { ip: [40, 60e3], ipUnidentified: [6, 60e3], login: [100, 60e3], sse: [2, 1e9] } }, rest: { peerAddress: () => PEER, logInfo: m => idLogs.push(m) } });
    const via = ip => new Client(fx, ip ? { 'fly-client-ip': ip } : {});
    const un = await Promise.all([1, 2, 3].map(async i => { PEER = '8.8.8.8'; return via('203.0.113.' + i).login('operator', 'wrong' + i); }));
    ok('untrusted peer (public) sending a client-IP header: sign-in is refused (503), the header is not believed', un.every(r => r.status === 503 && r.json.error === 'client identity unavailable'));
    PEER = '172.16.9.9';
    const noHdr = await via(null).login('operator', 'wrong'), noHdrP = await via(null).act('patientSignIn', ['9000000555']);
    ok('trusted proxy peer but NO client-IP header: sign-in and patient sign-in refused (503) instead of using the proxy address', noHdr.status === 503 && noHdrP.status === 503 && !fx.S.get().accounts['9000000555']);
    PEER = '8.8.8.8'; for (let i = 0; i < 12; i++) await via('198.51.100.1').login('operator', 'bad' + i);        // a stranger hammering the login: nothing is counted anywhere
    PEER = '172.16.9.9'; clock += 61e3;
    ok('unidentified requests create NO lockout state: right after 12 refused attempts, staff sign in normally from their own address', (await via('203.0.113.50').login('operator', OP_PW)).status === 200 && (await via('203.0.113.51').login('admin', ADMIN_PW)).status === 200);
    const att = []; for (let i = 0; i < 6; i++) att.push((await via('198.51.100.77').login('operator', 'guess' + i)).status);
    ok('lockout isolation: one client address guessing is locked after 5 tries (429) ...', att.slice(0, 5).every(s => s === 401) && att[5] === 429, att.join());
    ok('... while the same account still signs in from other addresses, and other accounts from the locked address are only limited by the address-level lock', (await via('203.0.113.60').login('operator', OP_PW)).status === 200 && (await via('198.51.100.77').login('operator', OP_PW)).status === 429);
    clock += 61e3;
    const botnet = []; for (let i = 0; i < 30; i++) for (let k = 0; k < 4; k++) botnet.push((await via('192.0.2.' + (i + 1)).login('operator', 'x' + i + k)).status);
    ok('distributed guessing (30 addresses x 4 failures against one account) never locks the account for everyone: the real owner signs in at once', botnet.every(s => s === 401) && (await via('203.0.113.99').login('operator', OP_PW)).status === 200);
    clock += 61e3; const a20 = []; for (let i = 0; i < 21; i++) a20.push((await via('198.51.100.88').login(i % 2 ? 'admin' : 'operator', 'bad' + i)).status);
    ok('address-level lock: one address failing across accounts is cut off, other addresses unaffected', a20.includes(429) && (await via('203.0.113.98').login('admin', ADMIN_PW)).status === 200);
    clock += 61e3;
    const ca = []; for (let i = 0; i < 43; i++) ca.push((await via('203.0.113.200').state()).status);
    ok('per-client request ceilings still work with a trusted client IP (client A throttled at 40/min) ...', ca.slice(0, 40).every(s => s === 200) && ca[42] === 429);
    ok('... without affecting client B', (await via('203.0.113.201').state()).status === 200);
    clock += 61e3; PEER = '8.8.8.8'; const ub = []; for (let i = 0; i < 8; i++) ub.push((await via(null).state()).status);
    ok('unidentified traffic shares ONE separate global ceiling (6/min here) that trusted clients never touch', ub[0] === 200 && ub.slice(6).every(s => s === 429));
    PEER = '172.16.9.9'; ok('...trusted clients are unaffected by the unidentified bucket being exhausted', (await via('203.0.113.202').state()).status === 200 && (await via('203.0.113.200').state()).status === 200);
    clock += 61e3; const e1 = via('203.0.113.210').sse(), e2 = via('203.0.113.210').sse(), e3 = via('203.0.113.210').sse(), e4 = via('203.0.113.211').sse(); await until(() => e3.status && e4.status);
    ok('event-stream cap is per identified client (3rd stream from one address refused; another address still allowed)', e1.status === 200 && e2.status === 200 && e3.status === 429 && e4.status === 200); [e1, e2, e3, e4].forEach(s => s.close());
    ok('proxy diagnostics: each situation reported once; no client address ever printed', idLogs.length >= 3 && idLogs.filter(l => /peer-not-trusted/.test(l)).length === 1 && idLogs.filter(l => /header-missing/.test(l)).length === 1 && idLogs.filter(l => /trusted proxy and header/.test(l)).length === 1 && !idLogs.join('\n').match(/203\.0\.113|198\.51\.100|8\.8\.8\.8/), idLogs.join(' | '));
    fx.close();
    const direct = await mk({ auth: { proxyHeader: null } }), dsp = []; for (let i = 0; i < 6; i++) dsp.push((await new Client(direct, { 'fly-client-ip': '1.1.1.' + i, 'X-Forwarded-For': '2.2.2.' + i }).login('operator', 'bad' + i)).status);
    ok('without TRUST_PROXY_HEADER, rotating spoofed forwarding headers does not dodge the lockout (peer address is the identity)', dsp[5] === 429, dsp.join()); direct.close();

    // ---------- rate limits ----------
    const rl = await mk({ auth: { rate: { session: [5, 60e3], destructive: [2, 60e3], signIn: [3, 60e3], patientSession: [4, 60e3], ip: [60, 60e3], login: [4, 60e3], sse: [2, 1e9] } } });
    const s1 = new Client(rl); await s1.login('admin', ADMIN_PW);
    const rr = []; for (let i = 0; i < 7; i++) rr.push(await s1.act('tick'));
    ok('per-session rate limit on staff actions: refused (429 + Retry-After) after the budget', rr.slice(0, 4).every(r => r.status === 200) && rr[5].status === 429 && +rr[5].headers.get('retry-after') > 0, rr.map(r => r.status).join());
    clock += 61e3; ok('rate limit window resets', (await s1.act('tick')).status === 200);
    const s2 = new Client(rl); await s2.login('admin', ADMIN_PW); const dd = []; for (let i = 0; i < 3; i++) dd.push((await s2.act('resetQueue', ['rv:gm'])).status);
    ok('destructive actions (reset/resetQueue) have a much tighter limit (2/min here)', dd.join() === '200,200,429', dd.join());
    const si = []; for (let i = 0; i < 4; i++) si.push((await new Client(rl).act('patientSignIn', ['90000001' + String(10 + i)])).status);
    ok('patient sign-in is limited per IP', si.join() === '200,200,200,429', si.join());
    clock += 61e3; const ps = new Client(rl); await ps.act('patientSignIn', ['9000000199']); clock += 61e3;
    const pr = []; for (let i = 0; i < 6; i++) pr.push((await ps.act('saveProfile', [{ name: 'N' + i, rel: 'Other' }])).status);
    ok('per-patient-session limit on patient actions', pr.includes(429) && pr[0] === 200, pr.join());
    clock += 61e3; const lg = []; for (let i = 0; i < 6; i++) lg.push((await new Client(rl).login('admin', ADMIN_PW)).status);
    ok('login endpoint has an IP request ceiling in addition to the failure lockout', lg.includes(429), lg.join());
    const k1 = new Client(rl).sse(), k2 = new Client(rl).sse(), k3 = new Client(rl).sse(); await until(() => k3.status);
    ok('event streams are capped per IP (3rd refused with 429)', k1.status === 200 && k2.status === 200 && k3.status === 429); k1.close(); k2.close(); k3.close();
    const fl = new Client(rl); clock += 61e3; const fr = []; for (let i = 0; i < 70; i++) fr.push((await fl.state()).status);
    ok('anonymous flood on the API is capped per IP', fr.includes(429) && fr[0] === 200, fr.filter(s => s === 429).length + ' refused');
    rl.close();

    // ---------- production fail-closed ----------
    const H = HASHES.admin, tmp = path.join(dir, 'prod.db'), good = { NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://myturn.example', STAFF_ADMIN_PASSWORD_HASH: H, DATABASE_PATH: tmp };
    const bad = (env, re) => { try { createApp(Object.assign({ dbPath: path.join(dir, 'x' + Math.random() + '.db'), env }, quiet)).close(); return false; } catch (e) { return e.code === 'UNSAFE_CONFIG' && re.test(e.message); } };
    ok('production refuses to start without PUBLIC_ORIGIN / with a non-https origin', bad({ NODE_ENV: 'production', STAFF_ADMIN_PASSWORD_HASH: H }, /PUBLIC_ORIGIN/) && bad(Object.assign({}, good, { PUBLIC_ORIGIN: 'http://myturn.example' }), /PUBLIC_ORIGIN/));
    ok('production refuses to start without a staff password hash', bad({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://myturn.example' }, /staff password hash/i));
    ok('production refuses memory storage and unknown proxy headers', bad(Object.assign({}, good, { DATABASE_PATH: 'memory' }), /memory/) && bad(Object.assign({}, good, { TRUST_PROXY_HEADER: 'x-evil' }), /TRUST_PROXY_HEADER/));
    ok('production ignores DEMO_OPEN_CONTROLS and never enables demo credentials', (() => { const c = A.authConfig(Object.assign({}, good, { DEMO_OPEN_CONTROLS: '1' })); return !c.openControls && !c.demoCredentials && c.patientWeb === 'disabled' && c.secureCookie; })());
    const prod = createApp(Object.assign({ dbPath: tmp, env: good, seedMode: 'empty' }, quiet)); await new Promise(r => prod.server.listen(0, '127.0.0.1', r)); const pp = prod.server.address().port;
    const base = { Host: 'myturn.example' };
    const p1 = await raw(pp, 'GET', '/', base);
    ok('production: index carries the require-server marker (no silent browser-only fallback) + HSTS', /name="myturn-require-server"/.test(p1.text) && /max-age=\d+/.test(p1.headers['strict-transport-security'] || ''));
    ok('production: wrong Host header is refused (421, DNS-rebinding guard); /healthz still answers for the platform', (await raw(pp, 'GET', '/api/state', { Host: 'evil.example' })).status === 421 && (await raw(pp, 'GET', '/healthz', { Host: 'internal' })).status === 200);
    const body = JSON.stringify({ user: 'admin', password: ADMIN_PW }), jh = Object.assign({ 'Content-Type': 'application/json' }, base);
    ok('production: POST without the exact configured Origin is refused (403)', (await raw(pp, 'POST', '/api/auth/login', jh, body)).status === 403 && (await raw(pp, 'POST', '/api/auth/login', Object.assign({ Origin: 'https://evil.example' }, jh), body)).status === 403);
    const pl = await raw(pp, 'POST', '/api/auth/login', Object.assign({ Origin: 'https://myturn.example' }, jh), body);
    ok('production: correct Origin + password signs in; cookie is __Host- prefixed, Secure, HttpOnly, SameSite=Strict', pl.status === 200 && /^__Host-mt_staff=.*; Secure/.test(String(pl.headers['set-cookie'])) && /HttpOnly/.test(String(pl.headers['set-cookie'])) && /SameSite=Strict/.test(String(pl.headers['set-cookie'])));
    const ck = String(pl.headers['set-cookie']).split(';')[0];
    ok('production: scenario reset is disabled even for admin, patient web sign-in is disabled', (await raw(pp, 'POST', '/api/action', Object.assign({ Origin: 'https://myturn.example', Cookie: ck }, jh), JSON.stringify({ method: 'reset', args: ['normal'] }))).status === 403 && (await raw(pp, 'POST', '/api/action', Object.assign({ Origin: 'https://myturn.example' }, jh), JSON.stringify({ method: 'patientSignIn', args: ['9000000001'] }))).status === 403);
    const me = JSON.parse((await raw(pp, 'GET', '/api/auth/me', Object.assign({ Cookie: ck }, base))).text);
    ok('production: /api/auth/me reports non-demo authentication and disabled patient web (UI hides demo hints)', me.demoCredentials === false && me.patientWeb === 'disabled' && me.staff.role === 'admin');
    prod.close();

    await Promise.all([app.close()]);
  } catch (e) { ok('test run crashed', false, e.stack); }
  const fail = res.filter(r => r.startsWith('FAIL')); console.log(res.join('\n')); console.log('\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed');
  fs.rmSync(dir, { recursive: true, force: true }); process.exit(fail.length ? 1 : 0);
})();
