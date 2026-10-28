/* MyTurn demo — shared queue server (zero dependencies).
   - Loads the website's own site/js/store.js inside an isolated Node `vm`, so queue rules are NOT duplicated.
   - Holds the authoritative queue state; browsers send COMMANDS (never state), so a stale tab cannot overwrite it.
   - Serves the website (site/) and a small JSON API on the same origin.
   - Optionally runs the Telegram bot (server/bot.js) when TELEGRAM_BOT_TOKEN is set.
   Run: node server/server.js        (see .env.example)                                                    */
'use strict';
const http = require('http'), https = require('https'), crypto = require('crypto'), fs = require('fs'), path = require('path'), vm = require('vm');
const auth = require('./auth'), { authConfig } = auth;
const ROOT = path.resolve(__dirname, '..'), SITE = path.join(ROOT, 'site');

function loadEnv(file) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* no .env: fine */ }
}

function createApp(opts) {
  opts = opts || {};
  const dbPath = opts.dbPath || null;                          // null → in-memory only (tests / quick demos)
  const prodEarly = !!((opts.auth && opts.auth.production !== undefined) ? opts.auth.production : authConfig((opts.env || process.env)).production);
  const seedMode = (prodEarly || opts.seedMode === 'empty') ? 'empty' : 'demo';   // first initialisation only; production NEVER seeds demo patients
  if (prodEarly) {                                                // storage preflight BEFORE anything is opened: the persistent volume must be present
    const fail = m => { const e = new Error('Unsafe production configuration:\n - ' + m); e.code = 'UNSAFE_CONFIG'; throw e; };
    if (!dbPath) fail('A database file is required in production (DATABASE_PATH); in-memory storage is not allowed.');
    if (!path.isAbsolute(dbPath)) fail('DATABASE_PATH must be an absolute path on the persistent volume.');
    const dir = path.dirname(dbPath);
    try { if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory'); fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK); }
    catch (e) { fail('The database directory "' + dir + '" is missing or not writable. Is the persistent volume mounted?'); }
  }
  const logE = opts.logError || (m => console.error(m));

  // ---- engine: the website's store.js, unchanged, in an isolated context (no localStorage, no DOM) ----
  const ctx = { window: { MT: {}, addEventListener() {} }, console: { log() {}, error: console.error } };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(SITE, 'js', 'store.js'), 'utf8'), ctx, { filename: 'store.js' });
  const S = ctx.window.MT.store;

  // ---- persistence: load (or safely initialise) before anything is served ----
  const db = dbPath ? require('./db').open(dbPath, { noCreateDir: prodEarly }) : null;    // throws a clear DbError on a bad/corrupt/newer database
  const loaded = db ? db.load() : null;
  let rev = 1, epoch = Date.now();                              // rev: every persisted change; epoch: every reset (clients drop their sessions)
  const NO_PATIENT = () => ({ phone: null, sel: null }), NO_STAFF = () => ({ user: null, role: null, sess: null });
  const shared = () => { const s = S.get(); return { accounts: s.accounts, q: s.q, ctr: s.ctr, audit: s.audit, policy: s.policy, scenario: s.scenario }; };
  if (loaded) { S.hydrate(loaded.shared); rev = loaded.rev; epoch = loaded.epoch; }
  else if (seedMode === 'empty') S.reset('empty');
  if (db && !loaded) db.save({ rev, epoch, shared: shared() });  // safe initialisation of a new database

  /* PRIVACY: browsers never receive the full state. viewOf(who) builds the minimum each caller may see:
       anonymous : queue shape only (statuses; no tokens, names, accounts, audit)
       patient   : own account + own visits in full; other people's visits as {id, token, status} only (needed for "people ahead")
       operator  : names/tokens/status of the Riverside queues only, no accounts/phones/Telegram ids; audit limited to Riverside
       admin     : same fields as operator, for all queues
     Phone numbers and Telegram ids (`acct`) are only ever sent to the account that owns them. */
  const clients = new Map();                                    // SSE connection -> { tokens, ip, id }; identity is RE-EVALUATED on every send
  const snapshot = () => ({ rev, epoch, shared: shared() });    // FULL state: internal only (tests, persistence); never sent to a browser
  const identityOf = who => (who.staff ? who.staff.role : '-') + '|' + (who.patient ? who.patient.phone : '-');
  function viewOf(who) {
    const sh = shared(), staff = who.staff || null, phone = who.patient ? who.patient.phone : null;
    const allowed = k => !!staff && (staff.role === 'admin' || k.split(':')[0] === 'rv');
    const out = { accounts: {}, q: {}, ctr: sh.ctr, audit: [], policy: sh.policy, scenario: sh.scenario };
    for (const k in sh.q) {
      const list = [];
      for (const e of sh.q[k]) {
        if (phone && e.acct === phone) list.push(e);
        else if (allowed(k)) list.push({ id: e.id, tok: e.tok, name: e.name, st: e.st, cancelReq: e.cancelReq, note: e.note, by: e.by, src: e.src, at: e.at, rby: e.rby });   // src/at/rby: walk-in marker, registration time and staff role (receipt/reprint); the request id (rid) is never sent
        else if (phone) list.push({ id: e.id, tok: e.tok, st: e.st });
        else if (!staff) list.push({ id: '', tok: '', st: e.st });
      }
      out.q[k] = list;
    }
    if (phone && sh.accounts[phone]) out.accounts[phone] = sh.accounts[phone];
    if (staff) {
      const letters = new Set(); for (const c of S.CLINICS) if (c.id === 'rv') for (const s of c.sessions) letters.add(s.tok);
      out.audit = sh.audit.filter(a => staff.role === 'admin' || !a.tok || letters.has(String(a.tok).charAt(0)));
    }
    return out;
  }
  const tokensWho = t => ({ staff: staffSessions.peek(t.staff), patient: patientSessions.peek(t.patient) });
  const sseSend = (res, c, extra) => { try { res.write('data: ' + JSON.stringify(Object.assign({ rev, epoch, shared: viewOf(tokensWho(c.tokens)) }, extra || {})) + '\n\n'); } catch (e) { clients.delete(res); } };
  const broadcast = () => { for (const [res, c] of clients) { c.id = identityOf(tokensWho(c.tokens)); sseSend(res, c); } };
  const refreshViews = () => { for (const [res, c] of clients) { const id = identityOf(tokensWho(c.tokens)); if (id !== c.id) { c.id = id; sseSend(res, c, { view: true }); } } };   // a session ended/changed: downgrade open streams at once

  /* Every action is applied in memory, then persisted in ONE transaction, then broadcast.
     If the write fails the in-memory change is rolled back to the last persisted snapshot, so memory never
     contains an acknowledged change that the database does not have. */
  class StorageError extends Error {}
  let lastGood = JSON.stringify({ rev, epoch, shared: shared() }), dirty = false, healthy = true;
  const restore = () => { const p = JSON.parse(lastGood); S.hydrate(p.shared); epoch = p.epoch; dirty = false; };
  let claimNext = null;                                         // Telegram update id to record as processed in the SAME transaction as the next state write
  function flush() {
    if (!dirty) return; dirty = false;
    const next = { rev: rev + 1, epoch, shared: shared() }, claim = claimNext; claimNext = null;
    if (!db && claim != null) memSeen.add(claim);                // (no database: in-memory guard only)
    if (db) {
      try { db.save(next, claim); healthy = true; }
      catch (e) { healthy = false; logE('Database write failed (' + (e.code || 'error') + '): ' + e.message); restore(); throw new StorageError('storage unavailable'); }
    }
    rev = next.rev; lastGood = JSON.stringify(next); broadcast();
  }
  S.subscribe(() => { dirty = true; queueMicrotask(() => { try { flush(); } catch (e) { if (!(e instanceof StorageError)) throw e; } }); });   // direct store calls (tests, ticker)
  // Healthy: cheap read check. Unhealthy: a real WRITE of the last good snapshot must succeed before actions are accepted again (recovery).
  const probe = () => {
    if (!db) return true;
    try {
      if (healthy) healthy = db.check();
      else { const p = JSON.parse(lastGood); db.save({ rev: p.rev, epoch: p.epoch, shared: p.shared }); healthy = true; }
    } catch (e) { healthy = false; }
    return healthy;
  };
  const memSeen = new Set();                                    // in-memory duplicate guard: used when there is no database, or while it is failing
  const markUpdate = id => {                                    // true = first time seen (claimed)
    if (db) { try { return db.markUpdate(id); } catch (e) { logE('Database write failed (update id): ' + e.message); } }
    if (memSeen.has(id)) return false; memSeen.add(id); return true;
  };
  const unmarkUpdate = id => {                                  // release a claim after a failed attempt so Telegram's retry is processed, not dropped
    if (db) { try { db.unmarkUpdate(id); } catch (e) { logE('Database write failed (update id release): ' + e.message); } }
    memSeen.delete(id);
  };

  // Run fn with a caller's session (patient / staff / net) installed, then clear it again. One persisted transaction per call.
  // opts.claim = a Telegram update id: it is recorded as processed in that same transaction (all-or-nothing with the queue change).
  // If fn changes nothing there is no transaction and the caller records the id itself afterwards (markUpdate).
  const clearSession = () => { const a = S.get(); a.patient = NO_PATIENT(); a.staff = NO_STAFF(); a.net = true; };
  function runAs(session, fn, opts2) {
    const st = S.get();
    st.patient = session.patient || NO_PATIENT(); st.staff = session.staff || NO_STAFF(); st.net = session.net !== false;
    claimNext = opts2 && Number.isSafeInteger(opts2.claim) ? opts2.claim : null;
    let result;
    try { result = fn(); } catch (e) { claimNext = null; clearSession(); if (dirty) restore(); throw e; }
    const after = S.get(), out = { result, session: { patient: after.patient, staff: after.staff } };
    clearSession();
    try { flush(); } finally { claimNext = null; }               // may throw StorageError (already rolled back, claim NOT recorded)
    return out;
  }
  const isProcessed = id => (db ? (() => { try { return db.isProcessed(id); } catch (e) { return memSeen.has(id); } })() : memSeen.has(id));

  // ---- HTTP API validation ----
  const METHODS = new Set(['reset', 'tick', 'patientSignIn', 'saveProfile', 'deleteProfile', 'register', 'checkIn', 'patientCancel', 'requestReturn',
    'call', 'callNext', 'start', 'complete', 'markMissed', 'markArrived', 'markNoShow', 'acceptReturn', 'declineReturn', 'cancelVisit', 'resetQueue', 'registerAssisted', 'patientSignOut']);
  const str = (v, n) => typeof v === 'string' && v.length <= n;
  function cleanArgs(method, args) {
    if (method === 'registerAssisted') {                           // (sessionKey, name, requestId, confirmDuplicate?) - strictly typed, the only 4-argument command
      if (!Array.isArray(args) || args.length < 3 || args.length > 4) return null;
      if (!str(args[0], 40) || !str(args[1], 80) || !/^[A-Za-z0-9_-]{16,64}$/.test(args[2] || '') || !(args[3] == null || typeof args[3] === 'boolean')) return null;
      return args;
    }
    if (!Array.isArray(args) || args.length > 3) return null;
    if (method === 'saveProfile') { const a = args[0] || {}; return [{ id: str(a.id, 12) ? a.id : undefined, name: str(a.name, 40) ? a.name : '', rel: str(a.rel, 12) ? a.rel : 'Other', yob: a.yob == null ? '' : String(a.yob).slice(0, 4) }]; }
    for (const a of args) if (!(a === null || typeof a === 'boolean' || (typeof a === 'string' && a.length <= 80))) return null;
    if (method === 'patientSignIn' && !/^\d{10}$/.test(args[0] || '')) return null;
    return args;
  }
  /* ---- authentication / authorization ----
     WHO is acting is decided ONLY by the server-side sessions that the HttpOnly cookies point to.
     Nothing about identity or role is read from the request body. */
  const cfg = Object.assign(authConfig(opts.env || process.env), opts.auth || {});
  cfg.rate = Object.assign({}, authConfig({}).rate, cfg.rate);
  { const errs = auth.productionErrors(cfg, opts.env || process.env); if (errs.length) { const e = new Error('Unsafe production configuration:\n - ' + errs.join('\n - ')); e.code = 'UNSAFE_CONFIG'; if (db) db.close(); throw e; } }
  const limiter = new auth.RateLimiter({ now: opts.now || Date.now });
  const sessionsOpt = { now: opts.now || Date.now };
  const staffSessions = new auth.Sessions(Object.assign({ idleMs: 30 * 60e3, absMs: 8 * 3600e3 }, sessionsOpt));
  const patientSessions = new auth.Sessions(Object.assign({ idleMs: 2 * 3600e3, absMs: 12 * 3600e3 }, sessionsOpt));
  const throttle = new auth.Throttle({ now: opts.now || Date.now });
  const CK = { staff: (cfg.secureCookie ? '__Host-' : '') + (cfg.cookiePrefix || 'mt') + '_staff', patient: (cfg.secureCookie ? '__Host-' : '') + (cfg.cookiePrefix || 'mt') + '_patient' };   // the isolated demo app uses 'mtd' so the two apps' sessions can never be confused
  let demoUsers = null;                                          // local-development credentials, hashed lazily; never used when a real hash is configured or in production
  const usersAsync = async () => {
    if (!cfg.demoCredentials) return cfg.users;
    if (!demoUsers) { const h = await auth.hashPassword(auth.DEMO_PASSWORD); demoUsers = { operator: { role: 'op', hash: h }, admin: { role: 'admin', hash: h } }; }
    return demoUsers;
  };
  const staffConfigured = () => cfg.demoCredentials || Object.keys(cfg.users).length > 0;
  const setC = (kind, token, ttlMs) => auth.cookie(CK[kind], token, { maxAge: ttlMs / 1000, secure: cfg.secureCookie });
  const readAuth = req => {                                      // → { staff: {user, role} | null, patient: rec | null, tokens }
    const c = auth.parseCookies(req.headers.cookie), st = staffSessions.get(c[CK.staff]), pt = patientSessions.get(c[CK.patient]);
    return { staff: st || null, patient: pt || null, tokens: { staff: c[CK.staff], patient: c[CK.patient] } };
  };
  /* Client identity (see auth.resolveClient). { ip, trusted }: trusted=false means "identity could not be established" (proxy configured but the
     peer is not a trusted proxy, or the header is missing/invalid). Such requests never share a per-client bucket with anyone: sign-in is refused
     (fail closed) and the generic ceilings use a separate, much larger, global bucket. Nothing is ever keyed on an untrusted header or a proxy address. */
  const proxyTrust = cfg.trustedProxyCidrs ? auth.parseCidrs(cfg.trustedProxyCidrs).list : null;
  const peerOf = opts.peerAddress || (req => req.socket.remoteAddress);        // (override is for tests only)
  const seenReasons = new Set(), info = opts.logInfo || console.log;
  /* cf-connecting-ip (Render) is not documented by the platform, so it is trusted ONLY after verifyProxy() has shown, through the real public
     path, that the proxy overwrites a forged value (or the operator attested with PROXY_HEADER_VERIFIED=1). Until then every request is
     "unidentified": sign-in is refused (fail closed) and no per-client bucket is used. Other headers keep their existing rules. */
  const needsProxyProof = cfg.proxyHeader === 'cf-connecting-ip' && !cfg.proxyAttested;
  let proxyVerified = !needsProxyProof, lastProxyWhy = needsProxyProof ? 'not-yet-checked' : 'attested-or-not-required';
  const pendingChecks = new Map();                               // nonce -> { seen }: only requests carrying an unguessable nonce are ever answered
  const clientOf = req => {
    if (req._client) return req._client;
    const peer = peerOf(req), c = ((needsProxyProof && !proxyVerified) || (opts.identityGate && !opts.identityGate()))
      ? { ip: null, trusted: false, reason: 'proxy-unverified' }
      : auth.resolveClient({ peer, headers: req.headers, proxyHeader: cfg.proxyHeader, trust: proxyTrust });
    if (cfg.proxyHeader && c.reason !== 'proxy-unverified' && !seenReasons.has(c.reason)) {            // one-time operator diagnostics per situation; a client's own address is never logged
      seenReasons.add(c.reason);
      if (c.reason === 'proxy') info('Proxy check: peer ' + (auth.normalizeIp(peer) || '?') + ' is a trusted proxy and header ' + cfg.proxyHeader + ' carries the client address - per-client throttling is active.');
      else info('WARNING (proxy check): client identity could not be established (' + c.reason + '). Forwarded headers from untrusted peers are ignored; sign-in is refused for such requests. ' +
        (c.reason === 'peer-not-trusted' ? 'If the peer is your platform proxy, set TRUSTED_PROXY_CIDRS to its address range.' : 'Check TRUST_PROXY_HEADER and that the proxy sets it.'));
    }
    return (req._client = c);
  };
  const noIdentity = res => sendR(res, deny(503, 'client identity unavailable'));
  const sameOrigin = req => {
    const o = req.headers.origin;
    if (cfg.publicOrigin) { if (!o) return req.method !== 'POST'; return o === cfg.publicOrigin; }   // production: browsers must send the exact configured origin on POST
    if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
  };
  const hostOk = req => !cfg.publicOrigin || req.headers.host === new URL(cfg.publicOrigin).host;   // DNS-rebinding guard

  const PATIENT_M = new Set(['saveProfile', 'deleteProfile', 'register', 'checkIn', 'patientCancel', 'requestReturn']);
  const OWNED_M = new Set(['checkIn', 'patientCancel', 'requestReturn']);   // patient commands that name a visit by id
  const STAFF_M = new Set(['call', 'callNext', 'start', 'complete', 'markMissed', 'markArrived', 'markNoShow', 'acceptReturn', 'declineReturn', 'cancelVisit', 'registerAssisted']);
  const clinicOf = (method, args) => {                           // clinic a staff command targets (operators are limited to Riverside, as in the UI)
    if (method === 'callNext' || method === 'registerAssisted') return String(args[0] || '').split(':')[0];   // these name a session key, not an entry id
    const q = S.get().q; for (const k in q) if (q[k].some(e => e.id === args[0])) return k.split(':')[0];
    return null;
  };
  const deny = (status, error) => ({ status, json: { error } });

  // Returns { deny } or { session } (the session handed to the store, built from server-side state only).
  function authorize(method, args, who, net) {
    const staff = who.staff ? { user: who.staff.role === 'admin' ? 'admin' : 'operator', role: who.staff.role, sess: null } : null;
    if (STAFF_M.has(method)) {
      if (!staff) return { deny: deny(401, 'sign-in required') };
      if (staff.role === 'op' && clinicOf(method, args) !== 'rv') return { deny: deny(403, 'forbidden') };
      return { session: { staff, patient: null, net } };
    }
    if (method === 'resetQueue') {
      if (!staff) return { deny: deny(401, 'sign-in required') };
      if (staff.role !== 'admin') return { deny: deny(403, 'forbidden') };
      return { session: { staff, patient: null, net } };
    }
    if (method === 'reset' || method === 'tick') {               // presenter/scenario controls: admin only (or the explicit local-only opt-in)
      if (!(cfg.openControls || (staff && staff.role === 'admin'))) return { deny: staff ? deny(403, 'forbidden') : deny(401, 'sign-in required') };
      if (method === 'reset' && !cfg.allowReset) return { deny: deny(403, 'reset is disabled') };
      return { session: { staff, patient: null, net } };
    }
    if (PATIENT_M.has(method)) {
      if (cfg.patientWeb !== 'demo') return { deny: deny(403, 'patient web sign-in is disabled') };
      if (!who.patient) return { deny: deny(401, 'sign-in required') };
      if (OWNED_M.has(method)) {                                  // the store trusts entry ids, so ownership is enforced here: only your own visit
        const q = S.get().q; let own = true;
        for (const k in q) { const e = q[k].find(x => x.id === args[0]); if (e) own = e.acct === who.patient.phone; }
        if (!own) return { deny: deny(403, 'forbidden') };
      }
      return { session: { staff: null, patient: { phone: who.patient.phone, sel: who.patient.sel }, net } };
    }
    return { deny: deny(400, 'bad method') };
  }

  // What the caller is told about an action's outcome: errors by key, plus - for a walk-in registration only - the new entry's receipt fields or the duplicate warning.
  function resultOf(method, r) {
    if (r && r.err) return method === 'registerAssisted' && r.dup ? { err: r.err, dup: r.dup.map(d => ({ id: d.id, tok: d.tok, st: d.st })) } : { err: r.err };
    if (method === 'registerAssisted' && r && r.e) { const e = r.e; return { ok: true, replayed: !!r.replayed, key: r.key, entry: { id: e.id, tok: e.tok, name: e.name, st: e.st, at: e.at, rby: e.rby } }; }
    return { ok: true };
  }
  function handleAction(body, who) {
    who = who || { staff: null, patient: null, tokens: {} };
    if (!body || typeof body !== 'object' || !METHODS.has(body.method)) return { status: 400, json: { error: 'bad method' } };
    const args = cleanArgs(body.method, body.args), net = body.net !== false;
    if (!args) return { status: 400, json: { error: 'bad request' } };
    const cookies = [];
    let session;
    if (body.method === 'patientSignIn') {
      if (cfg.patientWeb !== 'demo') return deny(403, 'patient web sign-in is disabled');
      session = { staff: null, patient: { phone: args[0], sel: null }, net };
    } else if (body.method === 'patientSignOut') {
      patientSessions.destroy(who.tokens.patient); cookies.push(setC('patient', '', 0)); refreshViews();
      return { status: 200, json: { ok: true, result: { ok: true }, rev }, cookies };
    } else {
      const a = authorize(body.method, args, who, net); if (a.deny) return a.deny; session = a.session;
    }
    if (!probe()) return { status: 503, json: { error: 'storage unavailable' } };
    try {
      if (body.method === 'reset') epoch++;
      const before = rev;
      const out = runAs(session, () => S[body.method](...args));
      if (body.method === 'patientSignIn') {                     // fresh session id on every sign-in; any presented id is discarded
        patientSessions.destroy(who.tokens.patient); refreshViews();
        cookies.push(setC('patient', patientSessions.create({ phone: args[0], sel: out.session.patient.sel }), 12 * 3600e3));
      } else if (who.patient && session.patient) {
        const acc = S.get().accounts[who.patient.phone], sel = body.sel;                // client may only pick one of ITS OWN profiles
        who.patient.sel = str(sel, 12) && acc && acc.profiles.some(p => p.id === sel) ? sel : out.session.patient.sel;
      }
      if (rev === before) { dirty = true; flush(); }            // always give clients the authoritative state, even for rejected actions
      return { status: 200, json: { ok: true, result: resultOf(body.method, out.result), rev }, cookies };
    } catch (e) {
      if (e instanceof StorageError) return { status: 503, json: { error: 'storage unavailable' } };
      logE('Action failed: ' + e.message); return { status: 500, json: { error: 'internal error' } };
    }
  }

  async function handleLogin(req, body) {
    const client = clientOf(req); if (!client.trusted) return deny(503, 'client identity unavailable');   // fail closed: no shared lockout bucket exists
    const ip = client.ip, user = typeof body.user === 'string' ? body.user.trim().toLowerCase().slice(0, 32) : '', pw = body.password;
    if (!staffConfigured()) return deny(503, 'staff sign-in is not configured');
    const wait = throttle.retryAfter(ip, user);
    if (wait > 0) return { status: 429, json: { error: 'too many attempts', retryAfter: wait }, headers: { 'Retry-After': String(wait) } };
    const users = await usersAsync(), u = Object.prototype.hasOwnProperty.call(users, user) ? users[user] : null;
    const good = typeof pw === 'string' && pw.length <= 200 && await auth.verifyPassword(pw, u ? u.hash : DUMMY_HASH()) && !!u;   // always one scrypt, known user or not
    if (!good) { throttle.fail(ip, user); return deny(401, 'badcreds'); }
    throttle.ok(ip, user);
    const who = readAuth(req); staffSessions.destroy(who.tokens.staff); refreshViews();   // rotate: a presented session id never becomes authenticated
    const token = staffSessions.create({ user, role: u.role });
    return { status: 200, json: { ok: true, user, role: u.role }, cookies: [setC('staff', token, 8 * 3600e3)] };
  }
  let dummy = null;
  const DUMMY_HASH = () => dummy || (dummy = 'scrypt$16384$8$1$' + Buffer.alloc(16, 7).toString('base64') + '$' + Buffer.alloc(32, 9).toString('base64'));

  // ---- HTTP server ----
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
  // Security headers on EVERY response. The CSP allows only same-origin scripts plus the hash of the page's single inline bootstrap script.
  const CSP = (() => {
    const hashes = []; try { for (const m of fs.readFileSync(path.join(SITE, 'index.html'), 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)) hashes.push("'sha256-" + crypto.createHash('sha256').update(m[1]).digest('base64') + "'"); } catch (e) { /* no page */ }
    return "default-src 'self'; script-src 'self' " + hashes.join(' ') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
  })();
  const SEC = Object.assign({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Resource-Policy': 'same-origin', 'Cache-Control': 'no-store' },
    cfg.production || cfg.secureCookie ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {});
  const send = (res, status, body, type, extra) => { res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json' }, SEC, extra || {})); res.end(body); };
  const tooMany = (res, wait) => sendR(res, { status: 429, json: { error: 'too many requests', retryAfter: wait }, headers: { 'Retry-After': String(wait) } });
  function actionLimit(who, method, ip) {                      // 0 = allowed, else seconds to wait
    const R = cfg.rate; let w;                                  // (the per-IP request ceiling is applied once, in route())
    if (method === 'patientSignIn') return limiter.allow('si:' + ip, R.signIn[0], R.signIn[1]);
    const staffAct = who.staff && (STAFF_M.has(method) || method === 'resetQueue' || method === 'reset' || method === 'tick');
    const sk = staffAct ? 's:' + auth.Sessions.key(who.tokens.staff) : who.patient ? 'p:' + auth.Sessions.key(who.tokens.patient) : null;
    if (sk) { const lim = staffAct ? R.session : R.patientSession; w = limiter.allow(sk, lim[0], lim[1]); if (w) return w; }
    if (method === 'reset' || method === 'resetQueue') return limiter.allow('d:' + (sk || ip || '?'), R.destructive[0], R.destructive[1]);
    return 0;
  }
  const sendR = (res, r) => send(res, r.status, JSON.stringify(r.json), null, Object.assign({}, r.headers, r.cookies && r.cookies.length ? { 'Set-Cookie': r.cookies } : {}));
  const readJson = (req, res, cb, o) => {                       // o.noOrigin: the Telegram webhook (server-to-server, authenticated by its secret header instead)
    if (!(o && o.noOrigin) && !sameOrigin(req)) return sendR(res, deny(403, 'cross-origin request refused'));
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return sendR(res, deny(415, 'application/json required'));
    if (req._preBody !== undefined) { let b; try { b = JSON.parse(req._preBody); } catch (e) { return sendR(res, deny(400, 'bad json')); } if (!b || typeof b !== 'object') return sendR(res, deny(400, 'bad json')); return cb(b); }   // body already read once by the front router
    let size = 0, buf = '', dead = false;
    req.on('data', c => { size += c.length; if (size > 20000 && !dead) { dead = true; res.on('finish', () => req.destroy()); sendR(res, deny(413, 'payload too large')); } else if (!dead) buf += c; });
    req.on('end', () => { if (dead) return; let body; try { body = JSON.parse(buf); } catch (e) { return sendR(res, deny(400, 'bad json')); } if (!body || typeof body !== 'object') return sendR(res, deny(400, 'bad json')); cb(body); });
  };
  const tg = { mode: 'off', hook: null };                       // Telegram transport: 'off' | 'polling' | 'webhook' (set by the process that starts the bot)
  const route = (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (url === '/healthz' && req.method === 'GET') { const ok = probe(); return send(res, ok ? 200 : 503, JSON.stringify({ ok, storage: db ? 'sqlite' : 'memory', telegram: tg.mode, clientIp: needsProxyProof ? (proxyVerified ? 'verified' : 'unverified') : 'n/a' })); }
    if (!hostOk(req)) return send(res, 421, 'misdirected request', 'text/plain');
    const pc = url.match(/^\/__proxycheck\/([A-Za-z0-9_-]{20,64})$/);
    if (pc) {                                                    // self-check endpoint: answers only the pending nonce created by verifyProxy(); otherwise indistinguishable from 404
      const p = req.method === 'GET' ? pendingChecks.get(pc[1]) : null; if (!p) return send(res, 404, '{"error":"not found"}');
      const raw = []; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === cfg.proxyHeader) raw.push(req.rawHeaders[i + 1]);
      p.seen = { values: raw, peer: peerOf(req) }; return send(res, 204, '');
    }
    if (url === '/telegram/webhook') {                          // ONLY accepts Telegram updates, authenticated by Telegram's secret-token header; it is not an action API
      if (!tg.hook) return send(res, 404, '{"error":"not found"}');
      if (req.method !== 'POST') return send(res, 405, '{"error":"method not allowed"}');
      const wc = clientOf(req), w = wc.trusted ? limiter.allow('wh:' + wc.ip, cfg.rate.webhook[0], cfg.rate.webhook[1]) : limiter.allow('wh:?', cfg.rate.ipUnidentified[0], cfg.rate.ipUnidentified[1]); if (w) return tooMany(res, w);
      if (!auth.safeEqual(req.headers['x-telegram-bot-api-secret-token'], tg.hook.secret)) return send(res, 403, '{"error":"forbidden"}', null, { Connection: 'close' });   // missing and wrong look identical; the body is never read
      return readJson(req, res, body => {
        Promise.resolve().then(() => tg.hook.handle(body)).catch(() => 'retry')                   // never log the payload; failures become a retryable 5xx
          .then(r => sendR(res, r === 'retry' ? deny(503, 'try again') : r === 'bad' ? deny(400, 'bad update') : { status: 200, json: { ok: true } }));
      }, { noOrigin: true });
    }
    if (url.startsWith('/api/')) {
      if (!sameOrigin(req)) return sendR(res, deny(403, 'cross-origin request refused'));
      const cc = clientOf(req), w0 = cc.trusted ? limiter.allow('ip:' + cc.ip, cfg.rate.ip[0], cfg.rate.ip[1]) : limiter.allow('ip:?', cfg.rate.ipUnidentified[0], cfg.rate.ipUnidentified[1]); if (w0) return tooMany(res, w0);
    }
    if (url === '/api/state' && req.method === 'GET') { const w = readAuth(req); return send(res, 200, JSON.stringify({ rev, epoch, shared: viewOf(w) })); }
    if (url === '/api/events' && req.method === 'GET') {
      const sc = clientOf(req), ip = sc.trusted ? sc.ip : null; let n = 0; if (ip) for (const c of clients.values()) if (c.ip === ip) n++;   // per-client stream cap only when the client is identifiable
      if (clients.size >= 300 || n >= cfg.rate.sse[0]) return sendR(res, deny(429, 'too many event streams'));
      const w = readAuth(req), c = { tokens: w.tokens, ip, id: identityOf(w) };
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }, SEC));
      res.write('retry: 2000\n\n'); clients.set(res, c);
      const ka = setInterval(() => {                                         // keep-alive; also notices an expired/ended session and downgrades the stream
        try { const id = identityOf(tokensWho(c.tokens)); if (id !== c.id) { c.id = id; sseSend(res, c, { view: true }); } else res.write(': ka\n\n'); } catch (e) { /* closed */ }
      }, 15000);
      req.on('close', () => { clearInterval(ka); clients.delete(res); });
      return sseSend(res, c);
    }
    if (url === '/api/action' && req.method === 'POST') return readJson(req, res, body => {
      const ac0 = clientOf(req); if (body.method === 'patientSignIn' && !ac0.trusted) return noIdentity(res);
      const who = readAuth(req), wait = actionLimit(who, body.method, ac0.ip);
      if (wait) return tooMany(res, wait);
      sendR(res, handleAction(body, who));
    });
    if (url === '/api/auth/me' && req.method === 'GET') {
      const w = readAuth(req);
      return send(res, 200, JSON.stringify({ staff: w.staff ? { user: w.staff.user, role: w.staff.role } : null, patient: w.patient ? { phone: w.patient.phone, sel: w.patient.sel } : null,
        patientWeb: cfg.patientWeb, demoCredentials: !!cfg.demoCredentials, openControls: !!cfg.openControls, staffConfigured: staffConfigured(), mode: cfg.queueMode || 'live' }));
    }
    if (url === '/api/auth/login' && req.method === 'POST') return readJson(req, res, body => { const lc = clientOf(req); if (!lc.trusted) return noIdentity(res); const w = limiter.allow('login:' + lc.ip, cfg.rate.login[0], cfg.rate.login[1]); return w ? tooMany(res, w) : handleLogin(req, body).then(r => sendR(res, r), e => { logE('Login failed: ' + e.message); sendR(res, deny(500, 'internal error')); }); });
    if (url === '/api/auth/logout' && req.method === 'POST') return readJson(req, res, () => {
      staffSessions.destroy(readAuth(req).tokens.staff); sendR(res, { status: 200, json: { ok: true }, cookies: [setC('staff', '', 0)] }); refreshViews();
    });
    if (url.startsWith('/api/')) return send(res, 404, '{"error":"not found"}');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed', 'text/plain');
    let p; try { p = decodeURIComponent(url); } catch (e) { return send(res, 400, 'bad request', 'text/plain'); }
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(SITE, p);
    if (!f.startsWith(SITE + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
    fs.readFile(f, (e, d) => {
      if (e) return send(res, 404, 'not found', 'text/plain');
      // Production pages tell the browser code that the shared server is REQUIRED: no silent fall-back to the browser-only demo.
      if ((cfg.production || cfg.injectRequireServer) && path.basename(f) === 'index.html') d = Buffer.from(String(d).replace('</head>', '<meta name="myturn-require-server" content="1">\n</head>'));
      send(res, 200, d, MIME[path.extname(f)] || 'application/octet-stream');
    });
  };
  const handler = (req, res) => {
    try { route(req, res); }
    catch (e) { logE('Request failed: ' + e.message); if (!res.headersSent) send(res, 500, '{"error":"internal error"}'); else res.end(); }   // never echo internals
  };
  const server = http.createServer(handler);
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.on('clientError', (e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  /* verifyProxy(send): probes through the real public path (the app calls its own PUBLIC_ORIGIN): a CONTROL request without the header, then two
     requests with DIFFERENT forged values. Verified only if the control carries exactly one public IP from a trusted proxy peer, and each forged
     request is either overwritten with that same value or rejected (403) before reaching the app. */
  const defaultProbeSend = ({ path: p, headers }) => new Promise((resolve, reject) => {
    const u = new URL(cfg.publicOrigin), r = https.request({ host: u.hostname, port: u.port || 443, path: p, method: 'GET', headers: Object.assign({ 'User-Agent': 'myturn-proxycheck' }, headers), timeout: 8000 }, x => { x.resume(); x.on('end', () => resolve({ status: x.statusCode })); });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject); r.end();
  });
  async function verifyProxy(send) {
    if (!needsProxyProof) return { ok: true, why: 'not-required' };
    const doSend = send || defaultProbeSend;
    const probe = async headers => {                                // one request through the real public path; returns what the app saw + the HTTP status the caller got
      const nonce = crypto.randomBytes(24).toString('base64url'), rec = { seen: null }; let status, failed = false;
      pendingChecks.set(nonce, rec);
      try { const r = await doSend({ path: '/__proxycheck/' + nonce, headers }); status = r && r.status; } catch (e) { failed = true; }
      pendingChecks.delete(nonce); return { seen: rec.seen, status, failed };
    };
    const judge = s => {                                            // -> { why } or { ip }: is this one observation a single, public IP from a trusted proxy peer?
      if (!s) return { why: 'request-not-seen' };
      if (!auth.isTrustedPeer(s.peer, proxyTrust)) return { why: 'peer-not-trusted' };
      if (s.values.length === 0) return { why: 'header-absent' };
      if (s.values.length > 1) return { why: 'header-duplicated' };
      if (String(s.values[0]).includes(',')) return { why: 'header-chained' };
      const ip = auth.normalizeIp(s.values[0]); if (!ip) return { why: 'header-invalid' };
      if (!auth.isPublicAddr(ip)) return { why: 'header-not-a-public-address' };
      return { ip };
    };
    // 1) CONTROL: with no client-supplied value the app must receive exactly one public IP from the proxy.
    const ctl = await probe({}); let why = null, how = 'overwritten';
    const c = ctl.failed ? { why: 'self-request-failed' } : judge(ctl.seen);
    if (c.why) why = c.why;
    // 2) FORGED (two different values, documentation range 192.0.2.0/24 = never a real client): each must be overwritten by the proxy with the
    //    same value as the control, or REJECTED before it reaches the app (HTTP 403, e.g. Cloudflare answers "error 1000" to a client-supplied
    //    CF-Connecting-IP). A forged value that reaches the app unchanged, or any other outcome, fails the proof.
    let v = crypto.randomInt(250);
    for (let i = 0; i < 2 && !why; i++) {
      if (i) v = (v + crypto.randomInt(1, 250)) % 250;
      const forged = '192.0.2.' + (v + 1), f = await probe({ [cfg.proxyHeader]: forged });
      if (f.failed) { why = 'self-request-failed'; break; }
      if (!f.seen) { if (f.status === 403) { how = 'rejected'; continue; } why = 'request-not-seen'; break; }
      const j = judge(f.seen);
      if (j.why) why = j.why; else if (j.ip === forged) why = 'client-value-passed-through'; else if (j.ip !== c.ip) why = 'value-not-stable';
    }
    const ok = !why, changed = ok !== proxyVerified || lastProxyWhy !== (why || 'ok');
    proxyVerified = ok; lastProxyWhy = why || 'ok';
    if (changed) info(ok ? 'Proxy header verification PASSED: ' + cfg.proxyHeader + ' is set by the proxy and forged values were ' + (how === 'rejected' ? 'rejected before reaching the app' : 'overwritten') + '; per-client throttling and sign-in are enabled.'
      : 'Proxy header verification NOT passed (' + why + '): ' + cfg.proxyHeader + ' is not trusted, so sign-in is refused. It is retried automatically. If the cause persists see DEPLOYMENT.md (or attest with PROXY_HEADER_VERIFIED=1 only after checking manually).');
    return { ok, why: why || 'ok' };
  }
  function startProxyVerification(o) {                          // called once by the process that serves traffic (not by createApp, so tests have no timers)
    if (!needsProxyProof) return { stop() {} };
    o = Object.assign({ firstMs: 2000, retryMs: 10000, recheckMs: 30 * 60e3, send: null }, o); let stopped = false, t = null;
    const tick = async () => { if (stopped) return; let r; try { r = await verifyProxy(o.send); } catch (e) { r = { ok: false }; } if (!stopped) t = setTimeout(tick, r.ok ? o.recheckMs : o.retryMs); if (t && t.unref) t.unref(); };
    t = setTimeout(tick, o.firstMs); if (t.unref) t.unref();
    return { stop() { stopped = true; clearTimeout(t); } };
  }
  const isStorageError = e => e instanceof StorageError;
  const setTelegram = (mode, hook) => { tg.mode = mode; tg.hook = mode === 'webhook' ? hook : null; };   // hook = { secret, handle(update) -> 'ok'|'dup'|'bad'|'retry' }
  return { S, server, handle: handler, hasStaffSession: req => !!staffSessions.peek(auth.parseCookies(req.headers.cookie)[CK.staff]), runAs, snapshot, db, markUpdate, unmarkUpdate, isProcessed, isStorageError, setTelegram, flush, authConfig: cfg, verifyProxy, startProxyVerification, proxyState: () => ({ needed: needsProxyProof, verified: proxyVerified, why: lastProxyWhy }), isHealthy: () => healthy, getRev: () => rev, getEpoch: () => epoch,
    close: () => { for (const r of clients.keys()) { try { r.end(); } catch (e) {} } server.close(); if (db) db.close(); } };
}

/* The isolated DEMO queue: a second, fully separate app (in-memory, demo seed, public demo sign-ins, open scenario/reset/step controls). It shares
   nothing with the real app except configuration of the public origin/cookies and the REAL app's proxy proof (it never weakens it). */
function createDemoApp(real, extra) {
  const rc = real.authConfig;
  return createApp(Object.assign({ env: { NODE_ENV: 'development' }, seedMode: 'demo', dbPath: null }, extra || {}, {
    auth: { production: false, users: {}, demoCredentials: true, patientWeb: 'demo', openControls: true, allowReset: true, secureCookie: rc.secureCookie, publicOrigin: rc.publicOrigin,
      proxyHeader: rc.proxyHeader, trustedProxyCidrs: rc.trustedProxyCidrs, proxyAttested: true, cookiePrefix: 'mtd', queueMode: 'demo', injectRequireServer: true, warnings: [], rate: rc.rate },
    identityGate: () => { const s = real.proxyState(); return !s.needed || s.verified; }          // demo traffic is identified only while the REAL app's proxy proof stands
  }));
}
/* One public site: front router + demo app + the Telegram routing object. Installs itself on the real app's HTTP server. */
function assembleSite(real, { demoTelegramIds, demoExtra } = {}) {
  const { createFront, parseDemoIds, telegramApp } = require('./front');
  const demo = createDemoApp(real, demoExtra), ids = demoTelegramIds instanceof Set ? demoTelegramIds : parseDemoIds(demoTelegramIds);
  const front = createFront({ real, demo });
  real.server.removeAllListeners('request'); real.server.on('request', front.route);
  return { demo, front, demoIds: ids, tgApp: telegramApp({ real, demo, demoIds: ids }), close() { demo.close(); } };
}

module.exports = { createApp, createDemoApp, assembleSite, loadEnv };

if (require.main === module) {
  if (process.env.MYTURN_SKIP_DOTENV !== '1') loadEnv(path.join(ROOT, '.env'));   // (skipped by tests so a developer's real .env can never leak into them)
  const PROD = process.env.NODE_ENV === 'production';
  // Production binds the host-provided PORT on all interfaces (the platform proxy is in front); local development stays on loopback.
  const rawPort = process.env.PORT, PORT = PROD ? (rawPort === undefined || rawPort === '' ? 8080 : Number(rawPort)) : (+rawPort || 5173), HOST = process.env.HOST || (PROD ? '0.0.0.0' : '127.0.0.1');
  if (PROD && !(Number.isInteger(PORT) && PORT > 0 && PORT < 65536)) { console.error('Startup refused [UNSAFE_CONFIG]: PORT must be an integer from 1 to 65535.'); process.exit(1); }
  // Production never falls back to a default/ephemeral path or to memory: DATABASE_PATH must be set explicitly (checked again in createApp).
  const dbPath = PROD ? (process.env.DATABASE_PATH && process.env.DATABASE_PATH !== 'memory' ? process.env.DATABASE_PATH : null)
    : (process.env.DATABASE_PATH === 'memory' ? null : (process.env.DATABASE_PATH || path.join(ROOT, 'server', 'data', 'myturn.db')));
  let app, site = null, botHandle = null;
  try { app = createApp({ dbPath, seedMode: process.env.SEED_MODE }); }
  catch (e) { console.error('Startup refused [' + (e.code || 'ERROR') + ']: ' + e.message); process.exit(1); }   // unsafe production config / bad database: fail closed
  const ac = app.authConfig;
  // Production serves ONE page: the isolated demo queue for everyone, and the real queue only to server-verified real staff (DEMO_QUEUE=off disables the demo).
  if ((PROD && process.env.DEMO_QUEUE !== 'off') || process.env.DEMO_QUEUE === 'on') site = assembleSite(app, { demoTelegramIds: process.env.DEMO_TELEGRAM_IDS });
  for (const w of ac.warnings) console.warn('Auth: ' + w);
  console.log('Staff sign-in: ' + (ac.demoCredentials ? 'DEMO credentials (operator/demo, admin/demo) — LOCAL DEVELOPMENT ONLY, not real security'
    : Object.keys(ac.users).length ? 'server-verified (' + Object.keys(ac.users).join(', ') + ')' : 'NOT CONFIGURED — staff cannot sign in (set STAFF_*_PASSWORD_HASH)')
    + '; patient web sign-in: ' + ac.patientWeb + (ac.openControls ? '; presenter controls OPEN (local only)' : ''));
  if (site) console.log('Demo queue: isolated in-memory DEMO queue served to everyone at /; the real queue is reachable only with a real staff sign-in; Telegram demo identities: ' + site.demoIds.size);
  console.log('Storage: ' + (dbPath ? 'SQLite file ' + path.basename(dbPath) + ' (persistent)' : 'in memory only (data is lost on restart)'));
  if (PROD && !ac.proxyHeader) console.warn('WARNING: TRUST_PROXY_HEADER is not set. If a reverse proxy is in front, every client then looks like the proxy and shares one throttling bucket (set it to cf-connecting-ip on Render or fly-client-ip on Fly.io).');
  if (PROD) console.log('Production mode: public host ' + new URL(ac.publicOrigin).host + ', telegram ' + (process.env.TELEGRAM_BOT_TOKEN ? (process.env.TELEGRAM_MODE || 'polling') : 'off') + ', node ' + process.version + ', listening on ' + HOST + ':' + PORT);
  // Graceful shutdown: every action is persisted synchronously before it is acknowledged, so nothing is pending; stop the bot, close streams and the database (WAL is checkpointed), exit.
  let closing = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (closing) return; closing = true; console.log('Shutting down (' + sig + ')'); try { botHandle && botHandle.stop(); } catch (e) { /* ignore */ } app.close(); if (site) site.close(); process.exit(0); });
  if (process.env.AVG_SERVICE_MINUTES) { const r = app.S.setAvgServiceMin(process.env.AVG_SERVICE_MINUTES); if (r.err) console.warn('AVG_SERVICE_MINUTES must be a number from 1 to 120; using the default (8).'); }
  app.server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is already in use (is another MyTurn server running?).' : 'Server error: ' + e.message); process.exit(1); });
  app.server.listen(PORT, HOST, () => {
    console.log('MyTurn server: http://' + HOST + ':' + PORT + '/  (website + shared queue API)');
    if (app.proxyState().needed) { console.log('Client IP: ' + ac.proxyHeader + ' is NOT trusted until the proxy is verified (self-check through ' + (ac.publicOrigin ? new URL(ac.publicOrigin).host : 'PUBLIC_ORIGIN') + '); sign-in is refused until it passes. Check: /healthz shows "clientIp":"verified".'); if (ac.publicOrigin) app.startProxyVerification(); }
    else if (ac.proxyAttested) console.warn('WARNING: PROXY_HEADER_VERIFIED=1 - the client-IP header is trusted on the operator\'s attestation, without the runtime self-check.');
    // Guard: another process (e.g. a plain static server on [::]:PORT) can answer "localhost" instead of this server,
    // so a browser opened at http://localhost:PORT would load the site WITHOUT the shared queue.
    if (!ac.production) fetch('http://localhost:' + PORT + '/api/state').then(r => r.json()).then(d => {
      if (!d || !d.shared) throw new Error('no api');
    }).catch(() => console.warn('WARNING: http://localhost:' + PORT + '/ is answered by a different process (no MyTurn API). Stop the other server on port ' + PORT + ' or open http://' + HOST + ':' + PORT + '/ . Telegram registrations will NOT appear on pages served by the other process.'));
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) console.log('Telegram bot: disabled (TELEGRAM_BOT_TOKEN is not set). The website works normally.');
    else {
      const mode = process.env.TELEGRAM_MODE === 'webhook' ? 'webhook' : 'polling', secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      if (mode === 'webhook' && !require('./auth').validWebhookSecret(secret)) console.error('Telegram bot: TELEGRAM_MODE=webhook needs TELEGRAM_WEBHOOK_SECRET (32-256 chars: A-Z a-z 0-9 _ -). Bot not started; website unaffected.');
      else {
        const bot = require('./bot').start({ app: site ? site.tgApp : app, token, apiBase: process.env.TELEGRAM_API_BASE || 'https://api.telegram.org', mode, secret });
        botHandle = bot;
        if (bot.mode) app.setTelegram(bot.mode, { secret, handle: bot.handleUpdate });
      }
    }
  });
}
