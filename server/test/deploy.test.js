/* Phase 4B tests: backup / verify / restore, production startup safety (real processes), hosting-config consistency.
   Run: node server/test/deploy.test.js     (local only; no network beyond 127.0.0.1; test-only secrets generated in memory) */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { createApp } = require('../server');
const B = require('../backup');
const A = require('../auth');

const ROOT = path.resolve(__dirname, '..', '..');
const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-deploy-'));
const F = n => path.join(dir, n);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quiet = { logError() {} };
const code = fn => { try { fn(); return 'none'; } catch (e) { return e.code || e.message; } };
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const mk = (file, o) => createApp(Object.assign({ dbPath: file, seedMode: 'demo', auth: { openControls: true } }, quiet, o || {}));
const reg = (app, id, name) => app.runAs({ patient: { phone: 'tg:' + id, sel: null } }, () => { const S = app.S; S.patientSignIn('tg:' + id); S.saveProfile({ name: name || 'U' + id, rel: 'Myself' }); return S.register('rv:gm', S.profiles()[0].id); }).result;
const state = app => JSON.stringify(app.snapshot());
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// ---- run the REAL server process with a clean environment (never loads the developer's .env) ----
function runServer(env, { waitFor = /MyTurn server:/, ms = 6000 } = {}) {
  const base = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MYTURN_SKIP_DOTENV: '1', TELEGRAM_BOT_TOKEN: '' };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: Object.assign(base, env), cwd: dir, windowsHide: true });
  let out = '', err = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => err += d);
  const exited = new Promise(r => child.on('exit', c => r(c)));
  const ready = new Promise(async r => { const t = Date.now(); while (Date.now() - t < ms) { if (waitFor.test(out) || child.exitCode !== null) return r(true); await sleep(40); } r(false); });
  return { child, get out() { return out; }, get err() { return err; }, exited, ready, kill: async () => { child.kill(); await Promise.race([exited, sleep(2000)]); } };
}
const http = require('http');
const hreq = (port, method, p, headers, body) => new Promise(resolve => {      // raw http so the Host header can be set (fetch ignores it)
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, x => { let t = ''; x.on('data', d => t += d); x.on('end', () => resolve({ status: x.statusCode, headers: x.headers, text: async () => t, json: async () => JSON.parse(t) })); });
  r.on('error', () => resolve({ status: 0, text: async () => '', json: async () => ({}) })); if (body) r.write(body); r.end();
});
const get = (port, p, host) => hreq(port, 'GET', p, host ? { Host: host } : {});

(async () => {
  try {
    // ================= Node / SQLite compatibility =================
    const major = +process.versions.node.split('.')[0], pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    let sqliteOk = false; try { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(':memory:'); d.exec('PRAGMA journal_mode=WAL'); d.prepare('VACUUM INTO ?'); sqliteOk = true; d.close(); } catch (e) { /* reported below */ }
    ok('runtime: Node >= 22.13 (engines) with node:sqlite, WAL and VACUUM INTO available (running Node ' + process.version + ')', major >= 22 && sqliteOk && pkg.engines.node === '>=22.13');

    // ================= backup / verify / restore =================
    const live = F('live.db');
    let app = mk(live); reg(app, 111, 'Alpha One'); reg(app, 112, 'Beta Two'); app.markUpdate(777);
    const b1 = F('backups/b1.db'), r1 = B.backup(live, b1);               // ONLINE: the app still has the database open
    const atB1 = state(app);
    ok('online backup while the app is running succeeds, is verified, and reports counts only (no names)', r1.visits === app.S.get().q['rv:gm'].length + Object.entries(app.S.get().q).filter(([k]) => k !== 'rv:gm').reduce((n, [, v]) => n + v.length, 0) && !JSON.stringify(r1).includes('Alpha'));
    ok('backup refuses to overwrite and refuses a missing database', code(() => B.backup(live, b1)) === 'BACKUP_EXISTS' && code(() => B.backup(F('nope.db'), F('x.db'))) === 'DB_MISSING');
    reg(app, 113, 'Gamma Three'); app.markUpdate(778);                      // changes AFTER the backup
    const atLater = state(app);
    ok('the backup is a self-contained consistent snapshot (opens on its own, equals the state at backup time, not the later state)', (() => { fs.copyFileSync(b1, F('probe.db')); const p = mk(F('probe.db')); const same = state(p) === atB1 && state(p) !== atLater; p.close(); return same; })());
    ok('verify accepts the good backup', B.verify(b1).schema === 1 && B.verify(b1).rev === r1.rev);

    // verify rejects bad files (and never modifies them)
    fs.writeFileSync(F('garbage.db'), 'this is not sqlite at all'); fs.writeFileSync(F('empty.db'), '');
    const { DatabaseSync } = require('node:sqlite'); const other = new DatabaseSync(F('other.db')); other.exec('CREATE TABLE t(x)'); other.close();
    fs.copyFileSync(b1, F('tamper.db')); let tdb = new DatabaseSync(F('tamper.db')); tdb.prepare('UPDATE app_state SET shared = ?').run('{"accounts":1}'); tdb.close();
    fs.copyFileSync(b1, F('newer.db')); tdb = new DatabaseSync(F('newer.db')); tdb.prepare("INSERT INTO schema_migrations VALUES (99, 'x')").run(); tdb.close();
    fs.copyFileSync(b1, F('nostate.db')); tdb = new DatabaseSync(F('nostate.db')); tdb.exec('DELETE FROM app_state'); tdb.close();
    const gh = sha(F('garbage.db'));
    ok('verify rejects: missing file, garbage, empty, a foreign SQLite file, tampered state, newer schema, missing state', [code(() => B.verify(F('missing.db'))), code(() => B.verify(F('garbage.db'))), code(() => B.verify(F('empty.db'))), code(() => B.verify(F('other.db'))), code(() => B.verify(F('tamper.db'))), code(() => B.verify(F('newer.db'))), code(() => B.verify(F('nostate.db')))].join() === 'BACKUP_MISSING,BACKUP_INVALID,BACKUP_INVALID,BACKUP_INVALID,BACKUP_INVALID,BACKUP_NEWER_SCHEMA,BACKUP_INVALID' && sha(F('garbage.db')) === gh);

    // restore safety
    const liveBefore = sha(live);
    ok('restore refuses without explicit confirmation (nothing changes)', code(() => B.restore(b1, live, {})) === 'RESTORE_NOT_CONFIRMED' && sha(live) === liveBefore);
    ok('restore refuses while the app has the database open (nothing changes)', code(() => B.restore(b1, live, { confirm: true })) === 'DB_IN_USE' && sha(live) === liveBefore && app.S.get().q['rv:gm'].some(e => e.acct === 'tg:113'));
    app.close();
    ok('after a clean shutdown no -wal/-shm file is left behind (WAL checkpointed on close)', !fs.existsSync(live + '-wal') && !fs.existsSync(live + '-shm'));
    const liveClosed = sha(live);
    ok('restore refuses invalid backups and leaves the live database untouched', ['garbage.db', 'tamper.db', 'newer.db', 'empty.db'].every(f => ['BACKUP_INVALID', 'BACKUP_NEWER_SCHEMA'].includes(code(() => B.restore(F(f), live, { confirm: true })))) && sha(live) === liveClosed && !fs.existsSync(live + '.restore-tmp'));
    ok('restore refuses a backup that is the target itself, and a missing target directory', code(() => B.restore(live, live, { confirm: true })) === 'RESTORE_SAME_FILE' && code(() => B.restore(b1, F('no-such-dir/x.db'), { confirm: true })) === 'DB_DIR_MISSING');
    fs.writeFileSync(live + '-wal', 'stale wal from the old database');       // a leftover must never be applied to the restored file
    const rr = B.restore(b1, live, { confirm: true });
    ok('restore: installs the verified backup, keeps the previous database aside (never deletes), removes stale -wal', rr.restored === live && rr.previous && fs.existsSync(rr.previous) && B.verify(rr.previous).visits > r1.visits && !fs.existsSync(live + '-wal') && !fs.existsSync(live + '-shm'));
    app = mk(live);
    ok('restored database starts normally and equals the state at backup time (later registration gone)', state(app) === atB1 && !app.S.get().accounts['tg:113']);
    ok('restore preserved Telegram duplicate protection as of the backup (777 known, 778 not)', app.markUpdate(777) === false && app.markUpdate(778) === true);
    const next = reg(app, 114, 'Delta Four');
    ok('the restored app keeps working: new registration gets the next token, and is persisted', next.ok === true && next.e.tok === (() => { const q = atB1 && JSON.parse(atB1).shared.ctr['rv:gm']; return 'K ' + String(q).padStart(3, '0'); })());
    app.close(); app = mk(live); ok('...and survives a restart', app.S.get().q['rv:gm'].some(e => e.acct === 'tg:114')); app.close();
    const old = mk(rr.previous.replace(/\\/g, '/')); ok('the pre-restore copy is itself a valid, openable database containing the later data', old.S.get().q['rv:gm'].some(e => e.acct === 'tg:113')); old.close();
    const fresh = B.restore(b1, F('newvolume/x.db'.replace('newvolume/', '')), { confirm: true });
    ok('restore onto an empty volume (no existing database) works and reports no previous file', fresh.previous === null && B.verify(F('x.db')).visits === r1.visits);

    // CLI (real process)
    const cliEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MYTURN_SKIP_DOTENV: '1', DATABASE_PATH: F('cli.db') };
    const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'server', 'backup.js'), ...a], { env: cliEnv, encoding: 'utf8', cwd: dir });
    app = mk(F('cli.db')); reg(app, 120, 'Secret Name'); app.close();
    const c1 = run('backup', F('cli-b.db')), c2 = run('backup', F('cli-b.db')), c3 = run('verify', F('cli-b.db')), c4 = run('verify', F('garbage.db')), c5 = run('restore', F('cli-b.db')), c6 = run('restore', F('cli-b.db'), '--yes'), c7 = run('bogus');
    ok('CLI: backup / verify / restore commands work with the documented exit codes and messages', c1.status === 0 && /Backup written and verified/.test(c1.stdout) && c2.status === 1 && /BACKUP_EXISTS/.test(c2.stderr) && c3.status === 0 && c4.status === 1 && c5.status === 1 && /not confirmed/i.test(c5.stderr) && c6.status === 0 && /Restored/.test(c6.stdout) && c7.status === 2, [c1, c2, c3, c4, c5, c6, c7].map(c => c.status).join());
    ok('CLI output never prints patient data or file contents', ![c1, c2, c3, c6].some(c => /Secret Name|tg:120/.test(c.stdout + c.stderr)));

    // ================= production startup safety (createApp) =================
    const hash = await A.hashPassword('p'.repeat(16)), pubEnv = (extra) => Object.assign({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://myturn.example', STAFF_ADMIN_PASSWORD_HASH: hash, DATABASE_PATH: F('prod/myturn.db') }, extra);
    fs.mkdirSync(F('prod'));
    ok('production without a database path / with a relative path is refused', code(() => createApp(Object.assign({ env: pubEnv(), dbPath: null }, quiet))) === 'UNSAFE_CONFIG' && code(() => createApp(Object.assign({ env: pubEnv(), dbPath: 'relative/x.db' }, quiet))) === 'UNSAFE_CONFIG');
    ok('production with a missing volume directory is refused AND the directory is not created', code(() => createApp(Object.assign({ env: pubEnv(), dbPath: F('unmounted/data/myturn.db') }, quiet))) === 'UNSAFE_CONFIG' && !fs.existsSync(F('unmounted')));
    const prodApp = createApp(Object.assign({ env: pubEnv(), dbPath: F('prod/myturn.db'), seedMode: 'demo' }, quiet));   // even an explicit seedMode:'demo' is ignored
    const ps = prodApp.S.get();
    ok('production never seeds demo patients, even if asked: empty queues, no accounts, empty audit', Object.values(ps.q).every(l => l.length === 0) && Object.keys(ps.accounts).length === 0 && ps.audit.length === 0);
    const pc = prodApp.authConfig;
    ok('production never enables simulated auth, demo credentials, open controls or non-Secure cookies', !pc.demoCredentials && pc.patientWeb === 'disabled' && !pc.openControls && pc.secureCookie && !pc.allowReset);
    prodApp.close();
    ok('production refuses: SEED_MODE=demo, PATIENT_WEB_MODE=demo, a foreign TELEGRAM_API_BASE, an invalid PORT, no DATABASE_PATH', [{ SEED_MODE: 'demo' }, { PATIENT_WEB_MODE: 'demo' }, { TELEGRAM_API_BASE: 'http://evil.example' }, { PORT: 'abc' }, { PORT: '70000' }, { DATABASE_PATH: undefined }].every(x => A.productionErrors(A.authConfig(pubEnv(x)), pubEnv(x)).length > 0));
    ok('production accepts the official Telegram API base and a valid PORT', A.productionErrors(A.authConfig(pubEnv({ PORT: '8080', TELEGRAM_API_BASE: 'https://api.telegram.org' })), pubEnv({ PORT: '8080', TELEGRAM_API_BASE: 'https://api.telegram.org' })).length === 0);

    // ================= production startup (real process) =================
    const port = await freePort(), dbp = F('proc/data/myturn.db'); fs.mkdirSync(F('proc/data'), { recursive: true });
    const good = pubEnv({ DATABASE_PATH: dbp, PORT: String(port), HOST: '127.0.0.1' });
    const s1 = runServer(good); await s1.ready;
    const hz = await (await get(port, '/healthz')).json().catch(() => ({}));
    ok('real process: binds the host-provided PORT, serves /healthz (ok, sqlite), Telegram off without a token', hz.ok === true && hz.storage === 'sqlite' && hz.telegram === 'off', s1.out + s1.err);
    ok('real process: the database was created at DATABASE_PATH on the (pre-existing) volume directory', fs.existsSync(dbp) && !fs.existsSync(path.join(dir, 'server')) && !fs.existsSync(path.join(ROOT, 'server', 'data', 'myturn.db.prodtest')));
    const st = await (await get(port, '/api/state', 'myturn.example')).json(), me = await (await get(port, '/api/auth/me', 'myturn.example')).json(), page = await (await get(port, '/', 'myturn.example')).text();
    const dbRows = () => { const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(dbp, { readOnly: true }); try { const r = d.prepare('SELECT shared FROM app_state WHERE id = 1').get(); const s = JSON.parse(r.shared); return { visits: Object.values(s.q).reduce((n, l) => n + l.length, 0), accounts: Object.keys(s.accounts).length, scenario: s.scenario }; } finally { d.close(); } };
    ok('real process (default DEMO queue ON): the anonymous page is served the isolated DEMO queue - labelled mode "demo", sample data, public demo sign-ins', me.mode === 'demo' && me.demoCredentials === true && st.shared.scenario === 'normal' && Object.values(st.shared.q).reduce((n, l) => n + l.length, 0) === 9);
    ok('real process: the REAL database starts EMPTY (no demo patients, no accounts, scenario empty) and stays empty while demo visitors act', (() => { const r = dbRows(); return r.visits === 0 && r.accounts === 0 && r.scenario === 'empty'; })());
    ok('real process: page carries the require-server marker (no browser-only fallback); wrong Host is refused (421)', /myturn-require-server/.test(page) && (await get(port, '/api/state', 'evil.example')).status === 421);
    const H = { Host: 'myturn.example', Origin: 'https://myturn.example', 'Content-Type': 'application/json' };
    const login = await hreq(port, 'POST', '/api/auth/login', H, JSON.stringify({ user: 'admin', password: 'demo' }));
    const demoAct = await hreq(port, 'POST', '/api/action', Object.assign({ Cookie: (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ') }, H), JSON.stringify({ method: 'reset', args: ['missed'] }));
    ok('real process: admin/demo is only the DEMO admin (demo cookie) - it can reset the demo, and the real database is still untouched', login.status === 200 && (login.headers['set-cookie'] || []).some(c => /^__Host-mtd_staff=|^mtd_staff=/.test(c)) && !(login.headers['set-cookie'] || []).some(c => /(^|__Host-)mt_staff=/.test(c)) && demoAct.status === 200 && (() => { const r = dbRows(); return r.visits === 0 && r.scenario === 'empty'; })());    ok('startup log summarises mode without secrets (no hash, no token, no origin path)', /Production mode: public host myturn\.example/.test(s1.out) && !s1.out.includes(hash) && !/scrypt\$/.test(s1.out + s1.err));
    await s1.kill();

    // with the demo queue switched off the page is the plain live clinic: empty queue, no demo sign-ins at all
    const portOff = await freePort(), dbOff = F('proc/data/off.db'); const sOff = runServer(pubEnv({ DATABASE_PATH: dbOff, PORT: String(portOff), HOST: '127.0.0.1', DEMO_QUEUE: 'off' })); await sOff.ready;
    const stO = await (await get(portOff, '/api/state', 'myturn.example')).json(), meO = await (await get(portOff, '/api/auth/me', 'myturn.example')).json();
    const loginO = await hreq(portOff, 'POST', '/api/auth/login', { Host: 'myturn.example', Origin: 'https://myturn.example', 'Content-Type': 'application/json' }, JSON.stringify({ user: 'admin', password: 'demo' }));
    ok('real process, DEMO_QUEUE=off: production starts EMPTY (no demo patients), patient web sign-in disabled, no demo credentials, demo/demo does not sign in', Object.values(stO.shared.q).every(l => l.length === 0) && meO.mode === 'live' && meO.patientWeb === 'disabled' && meO.demoCredentials === false && meO.openControls === false && loginO.status === 401);
    await sOff.kill();

    const s2 = runServer(Object.assign({}, good, { HOST: undefined, PORT: undefined, DATABASE_PATH: F('proc/data/other.db') })); await s2.ready; await sleep(100);
    ok('production defaults: all interfaces (0.0.0.0) on port 8080 when the platform sets nothing else', /listening on 0\.0\.0\.0:8080/.test(s2.out) || /already in use/.test(s2.err), s2.out + s2.err); await s2.kill();

    const refuse = async (env, why, re) => { const s = runServer(env, { waitFor: /Startup refused|MyTurn server:/ }); await s.ready; const c = await Promise.race([s.exited, sleep(3000).then(() => 'running')]); const o = s.out + s.err; await s.kill(); return { c, o }; };
    const f1 = await refuse(pubEnv({ DATABASE_PATH: undefined, PORT: String(await freePort()) })), f2 = await refuse(pubEnv({ DATABASE_PATH: F('gone/volume/myturn.db'), PORT: String(await freePort()) })),
      f3 = await refuse(Object.assign(pubEnv({ DATABASE_PATH: F('proc/data/s.db'), PORT: String(await freePort()) }), { SEED_MODE: 'demo' })), f4 = await refuse(pubEnv({ DATABASE_PATH: F('proc/data/p.db'), PORT: 'not-a-port' })),
      f5 = await refuse(pubEnv({ DATABASE_PATH: F('proc/data/q.db'), PORT: String(await freePort()), PUBLIC_ORIGIN: 'http://insecure.example' })), f6 = await refuse(pubEnv({ DATABASE_PATH: F('proc/data/r.db'), PORT: String(await freePort()), STAFF_ADMIN_PASSWORD_HASH: undefined }));
    ok('real process exits 1 (fail closed) when: no DATABASE_PATH / volume missing / SEED_MODE=demo / bad PORT / http origin / no staff hash', [f1, f2, f3, f4, f5, f6].every(f => f.c === 1 && /Startup refused/.test(f.o)), [f1, f2, f3, f4, f5, f6].map(f => f.c).join());
    ok('...and a missing volume was not silently created, and nothing was served', !fs.existsSync(F('gone')) && [f1, f2, f3, f4, f5, f6].every(f => !/MyTurn server:/.test(f.o)));

    // ================= pre-deployment audit additions =================
    const bd = F('autobk'); app = mk(F('auto.db')); reg(app, 130, 'Zed Nine'); app.close();
    const ab = B.backup(F('auto.db'), bd + path.sep);
    ok('backup into a directory picks a timestamped name inside it (no path guessing, no overwrite)', /myturn-\d{8}T\d{6}Z\.db$/.test(ab.file) && path.dirname(ab.file) === bd && B.verify(ab.file).visits > 0 && code(() => B.backup(F('auto.db'), ab.file)) === 'BACKUP_EXISTS');
    const ab2 = B.backup(F('auto.db'), F('newdir-no-slash'));          // regression (container rehearsal): no trailing slash, directory does not exist yet
    ok('backup <name-without-extension> creates that DIRECTORY with a timestamped file inside (not a file called "backups")', fs.statSync(F('newdir-no-slash')).isDirectory() && path.dirname(ab2.file) === F('newdir-no-slash') && B.verify(ab2.file).visits > 0);
    const ab3 = B.backup(F('auto.db'), F('named-backup.db'));
    ok('backup <file.db> still writes exactly that file', ab3.file === F('named-backup.db') && fs.statSync(F('named-backup.db')).isFile());
    const dbR = F('twice.db'); app = mk(dbR); reg(app, 131, 'First'); app.close(); const good1 = B.backup(dbR, F('t1.db')).file;
    app = mk(dbR); reg(app, 132, 'Second'); app.close(); const good2 = B.backup(dbR, F('t2.db')).file;
    const x1 = B.restore(good1, dbR, { confirm: true }), x2 = B.restore(good2, dbR, { confirm: true });    // two restores inside the same second
    ok('two restores in the same second keep BOTH safety copies (nothing is overwritten)', x1.previous && x2.previous && x1.previous !== x2.previous && B.verify(x1.previous).visits > 0 && B.verify(x2.previous).visits > 0);
    const cliProd = spawnSync(process.execPath, [path.join(ROOT, 'server', 'backup.js'), 'restore', good1, '--yes'], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MYTURN_SKIP_DOTENV: '1', NODE_ENV: 'production' }, encoding: 'utf8', cwd: dir });
    ok('backup CLI in production refuses to run without an explicit DATABASE_PATH (never acts on a guessed default)', cliProd.status === 1 && /NO_DATABASE_PATH/.test(cliProd.stderr));

    const ent = fs.readFileSync(path.join(ROOT, 'docker-entrypoint.sh'), 'utf8'), entCode = ent.replace(/^\s*#.*$/gm, '');
    ok('entrypoint: LF only, POSIX shell, set -e, chown limited to /data (never "/"), directory never created, exec to the app', !ent.includes('\r') && /^#!\/bin\/sh\n/.test(ent) && /^set -e$/m.test(ent) && /\/data\|\/data\/\*\)/.test(entCode) && !/mkdir/.test(entCode) && /exec "\$@"\s*$/.test(entCode));
    ok('entrypoint: maintenance mode (no app, no database opened) comes BEFORE dropping privileges so restores can run; app drops to the node user via exec (Node is PID 1)', entCode.indexOf('MYTURN_MAINTENANCE') > 0 && entCode.indexOf('MYTURN_MAINTENANCE') < entCode.indexOf('setpriv') && /exec sleep infinity/.test(entCode) && /exec setpriv --reuid=node --regid=node --init-groups -- "\$@"/.test(entCode));
    ok('.gitattributes forces LF for the entrypoint and container files (Windows checkouts)', /\*\.sh text eol=lf/.test(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')) && /Dockerfile text eol=lf/.test(fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')));
    const gattr = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
    ok('.gitattributes also forces LF for fly.toml and render.yaml (Windows checkouts)', /fly\.toml text eol=lf/.test(gattr) && /render\.yaml text eol=lf/.test(gattr));
    const dockerTxt = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8').replace(/#.*$/gm, '');
    ok('Dockerfile: entrypoint is made executable and used as ENTRYPOINT; no USER line (the entrypoint drops root after fixing the volume)', /RUN chmod \+x \/usr\/local\/bin\/docker-entrypoint\.sh/.test(dockerTxt) && /ENTRYPOINT \["docker-entrypoint\.sh"\]/.test(dockerTxt) && !/^USER /m.test(dockerTxt));

    const infoLogs = [];
    const pxApp = createApp(Object.assign({ seedMode: 'empty', logInfo: m => infoLogs.push(m), auth: { proxyHeader: 'fly-client-ip' } }, quiet)); await new Promise(r => pxApp.server.listen(0, '127.0.0.1', r)); const pxp = pxApp.server.address().port;
    await hreq(pxp, 'GET', '/api/state', {}); await hreq(pxp, 'GET', '/api/state', { 'fly-client-ip': '203.0.113.5' });
    ok('proxy diagnostic: one message per situation (header missing -> warning; header present -> confirmation), the client address is never printed', infoLogs.length === 2 && /header-missing/.test(infoLogs[0]) && /WARNING/.test(infoLogs[0]) && !/\d+\.\d+\.\d+\.\d+/.test(infoLogs[0]) && /per-client throttling is active/.test(infoLogs[1]) && !infoLogs.join('').includes('203.0.113.5'), infoLogs.join('|'));
    pxApp.close(); const info2 = []; const pxApp2 = createApp(Object.assign({ seedMode: 'empty', logInfo: m => info2.push(m), auth: { proxyHeader: 'fly-client-ip' } }, quiet)); await new Promise(r => pxApp2.server.listen(0, '127.0.0.1', r));
    await hreq(pxApp2.server.address().port, 'GET', '/api/state', { 'fly-client-ip': '203.0.113.5' });
    ok('proxy diagnostic: confirms per-client throttling when the header arrives from a trusted proxy peer (client address not printed)', info2.length === 1 && /per-client throttling is active/.test(info2[0]) && !info2[0].includes('203.0.113.5'), info2.join('|')); pxApp2.close();

    // secrets must not leak through stdout/stderr, health or error responses (fake credentials; Telegram API pointed at a dead local port)
    const LEAK_TOKEN = '555000111:' + crypto.randomBytes(24).toString('base64url').replace(/[^A-Za-z0-9_-]/g, 'q'), LEAK_SECRET = crypto.randomBytes(32).toString('base64url');
    const lp = await freePort(), sl = runServer({ PORT: String(lp), HOST: '127.0.0.1', DATABASE_PATH: F('leak.db'), TELEGRAM_BOT_TOKEN: LEAK_TOKEN, TELEGRAM_MODE: 'webhook', TELEGRAM_WEBHOOK_SECRET: LEAK_SECRET, TELEGRAM_API_BASE: 'http://127.0.0.1:9', STAFF_ADMIN_PASSWORD_HASH: hash });
    await sl.ready; await sleep(800);
    const probes = [await hreq(lp, 'GET', '/healthz', {}), await hreq(lp, 'GET', '/api/auth/me', {}), await hreq(lp, 'POST', '/telegram/webhook', { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }, '{}'),
      await hreq(lp, 'POST', '/telegram/webhook', { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': LEAK_SECRET }, '{bad'), await hreq(lp, 'POST', '/api/action', { 'Content-Type': 'application/json' }, '{"method":"nope"}'), await get(lp, '/missing')];
    const bodies = (await Promise.all(probes.map(p => p.text()))).join('\n'), all = sl.out + '\n' + sl.err + '\n' + bodies;
    ok('no bot token, webhook secret or password hash appears in process output, health, error or auth responses (bot start failure path included)', !all.includes(LEAK_TOKEN) && !all.includes(LEAK_SECRET) && !all.includes(hash) && /could not start/.test(sl.err + sl.out), all.slice(0, 300));
    await sl.kill();

    // go-live script fail-safe ordering (the hidden token prompt cannot be automated, so the gating is asserted on the script itself)
    const gl = fs.readFileSync(path.join(ROOT, 'scripts', 'telegram-go-live.ps1'), 'utf8');
    const iCheck = gl.indexOf("& $run 'check'; if ($script:rc -ne 0) { throw (Explain $script:rc) }", gl.indexOf('The server is changed ONLY if Telegram explicitly confirms it')), iEnv = gl.indexOf('weeny env $App'), iSet = gl.indexOf("& $run 'set'");
    ok('go-live script: the token is set on the server / webhook registered ONLY after `check` exits 0 (a failed check throws first); every failure class has its own explanation', iCheck > 0 && iCheck < iEnv && iEnv < iSet && /2 \{ 'NETWORK problem/.test(gl) && /3 \{ 'UNEXPECTED HTTP/.test(gl) && /4 \{ 'TELEGRAM answered ok:false/.test(gl) && !/Telegram rejected the token/.test(gl) && /MYTURN_SKIP_DOTENV/.test(gl));
    ok('go-live script: -Action check exists and changes nothing (no weeny env / ssh in that branch)', /\[ValidateSet\('set', 'check', 'info', 'delete'\)\]/.test(gl) && (() => { const b = gl.slice(gl.indexOf("if ($Action -eq 'check')"), gl.indexOf("if ($Action -eq 'info')")); return b.length > 0 && !/weeny env|ssh /.test(b); })());
    ok('telegram-webhook CLI honours MYTURN_SKIP_DOTENV (an old .env cannot change what is contacted)', /MYTURN_SKIP_DOTENV !== '1'\) loadEnv/.test(fs.readFileSync(path.join(ROOT, 'server', 'telegram-webhook.js'), 'utf8')));

    // ================= hosting configuration consistency =================
    const fly = fs.readFileSync(path.join(ROOT, 'fly.toml'), 'utf8'), docker = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'), dign = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8'), gign = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    const envBlock = (fly.match(/\[env\]([\s\S]*?)(?=\n\[)/) || [, ''])[1], flyEnv = {}; for (const m of envBlock.matchAll(/^\s*([A-Z_]+)\s*=\s*"([^"]*)"/gm)) flyEnv[m[1]] = m[2];
    const SECRET_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'STAFF_OPERATOR_PASSWORD_HASH', 'STAFF_ADMIN_PASSWORD_HASH'];
    const secrets = { STAFF_ADMIN_PASSWORD_HASH: hash, PUBLIC_ORIGIN: 'https://myturn.example', TELEGRAM_BOT_TOKEN: '123456789:' + 'a'.repeat(30), TELEGRAM_WEBHOOK_SECRET: crypto.randomBytes(32).toString('base64url') };
    const merged = Object.assign({}, flyEnv, secrets);
    ok('fly.toml [env] plus the documented secrets is a valid production configuration (no startup errors)', A.productionErrors(A.authConfig(merged), merged).length === 0, A.productionErrors(A.authConfig(merged), merged).join(' | '));
    ok('fly.toml: no secret or origin values in the file; secrets are listed as set-with-`fly secrets`', !SECRET_KEYS.some(k => new RegExp('^\\s*' + k + '\\s*=', 'm').test(fly)) && !/PUBLIC_ORIGIN\s*=/.test(fly) && !/\d{8,}:[A-Za-z0-9_-]{30,}/.test(fly));
    ok('fly.toml: exactly one machine (min 1, no auto-stop/auto-start), one mount, immediate in-place deploys', /min_machines_running\s*=\s*1/.test(fly) && /auto_stop_machines\s*=\s*"off"/.test(fly) && /auto_start_machines\s*=\s*false/.test(fly) && (fly.match(/\[\[mounts\]\]/g) || []).length === 1 && /strategy\s*=\s*"immediate"/.test(fly) && !/max_machines|\[\[services\]\]/.test(fly));
    ok('fly.toml: internal_port = PORT, DATABASE_PATH is inside the mounted volume, HTTPS forced, /healthz check', new RegExp('internal_port\\s*=\\s*' + flyEnv.PORT).test(fly) && path.posix.dirname(flyEnv.DATABASE_PATH) === (fly.match(/destination\s*=\s*"([^"]+)"/) || [])[1] && /force_https\s*=\s*true/.test(fly) && /path\s*=\s*"\/healthz"/.test(fly));
    ok('fly.toml: proxy header + webhook mode set; app/region are placeholders (no invented account, app or domain)', flyEnv.TRUST_PROXY_HEADER === 'fly-client-ip' && flyEnv.TELEGRAM_MODE === 'webhook' && /REPLACE-WITH-YOUR-APP-NAME/.test(fly) && /REPLACE-WITH-YOUR-REGION/.test(fly));
    ok('Dockerfile: pinned Node 24 base, copies only package.json/server/site/entrypoint (no .env, no COPY . .), exposes the same port', /^FROM node:24/m.test(docker) && !/COPY \. /.test(docker) && !/\.env/.test(docker.replace(/#.*$/gm, '')) && new RegExp('EXPOSE ' + flyEnv.PORT).test(docker));
    ok('.dockerignore / .gitignore keep .env, local config, databases, backups and server/data out of images and git', ['.env', '*.db', 'server/data', '.claude', 'fly.toml', 'render.yaml'].every(p => dign.split(/\r?\n/).includes(p)) && ['.env', '*.db', 'server/data/', 'backups/', '.claude/'].every(p => gign.split(/\r?\n/).includes(p)));
    const render = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');
    const rvar = k => { const m = render.match(new RegExp('^\\s*- key: ' + k + '\\n\\s+value: "?([^"\\n#]+)"?', 'm')); return m && m[1].trim(); };
    ok('render.yaml: one Docker web service with the repo Dockerfile, the /healthz check, one paid instance and the Singapore region', /type: web/.test(render) && /runtime: docker/.test(render) && /dockerfilePath: \.\/Dockerfile/.test(render) && /healthCheckPath: \/healthz/.test(render) && /plan: 0\.5c-512mb\b/.test(render) && /region: singapore/.test(render) && /numInstances: 1\b/.test(render) && !/type: worker|type: cron|type: static/.test(render));
    ok('render.yaml: one persistent disk at /data, at least 1 GB, and DATABASE_PATH is inside that mount', /disk:\s*\n\s+name: myturn-data\s*\n\s+mountPath: \/data\s*\n\s+sizeGB: ([1-9]\d*)/.test(render) && path.posix.dirname(rvar('DATABASE_PATH')) === '/data');
    ok('render.yaml: production env is 0.0.0.0, Render port 10000, empty seed, cf-connecting-ip and webhook mode', rvar('NODE_ENV') === 'production' && rvar('HOST') === '0.0.0.0' && rvar('PORT') === '10000' && rvar('SEED_MODE') === 'empty' && rvar('TRUST_PROXY_HEADER') === 'cf-connecting-ip' && rvar('TELEGRAM_MODE') === 'webhook');
    ok('render.yaml: PUBLIC_ORIGIN is derived from RENDER_EXTERNAL_URL (no guessed domain); no Fly-only internal_port/mounts', /fromService:\s*\n\s+name: myturn\s*\n\s+type: web\s*\n\s+envVarKey: RENDER_EXTERNAL_URL/.test(render) && !/- key: PUBLIC_ORIGIN\n\s+value:/.test(render) && !/internal_port|\[\[mounts\]\]|primary_region/.test(render));
    ok('render.yaml: every secret is sync:false with no value; no token or password hash is embedded', SECRET_KEYS.every(k => new RegExp('- key: ' + k + '\\n\\s+sync: false').test(render)) && !/scrypt\$/.test(render) && !/\d{8,}:[A-Za-z0-9_-]{30,}/.test(render));
    const renderEnv = { NODE_ENV: rvar('NODE_ENV'), HOST: rvar('HOST'), PORT: rvar('PORT'), DATABASE_PATH: rvar('DATABASE_PATH'), SEED_MODE: rvar('SEED_MODE'), TRUST_PROXY_HEADER: rvar('TRUST_PROXY_HEADER'), TELEGRAM_MODE: rvar('TELEGRAM_MODE'), PUBLIC_ORIGIN: 'https://myturn.onrender.com' };
    const renderFull = Object.assign({}, renderEnv, { STAFF_ADMIN_PASSWORD_HASH: hash, TELEGRAM_BOT_TOKEN: secrets.TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: secrets.TELEGRAM_WEBHOOK_SECRET });
    ok('render.yaml [env] plus the documented secrets is a valid production configuration (cf-connecting-ip is accepted)', A.productionErrors(A.authConfig(renderFull), renderFull).length === 0, A.productionErrors(A.authConfig(renderFull), renderFull).join(' | '));
    const ex = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'), vals = {}; for (const m of ex.matchAll(/^([A-Z_0-9]+)=(.*)$/gm)) vals[m[1]] = m[2];
    const allowed = new Set(['PORT', 'HOST', 'AVG_SERVICE_MINUTES', 'DATABASE_PATH', 'SEED_MODE']);
    ok('.env.example contains placeholders only (every variable is empty except the non-secret local defaults)', Object.entries(vals).every(([k, v]) => v === '' || allowed.has(k)) && SECRET_KEYS.every(k => k in vals && vals[k] === ''), JSON.stringify(Object.entries(vals).filter(([k, v]) => v !== '' && !allowed.has(k))));
    // nothing token-shaped in files that could be committed or baked into an image (the developer's own .env is deliberately not read)
    const scan = []; const walk = d => { for (const n of fs.readdirSync(d)) { if (['node_modules', '.git', '.claude', 'test', 'data'].includes(n)) continue; const p = path.join(d, n), s = fs.statSync(p); if (s.isDirectory()) walk(p); else if (/\.(js|json|toml|yaml|md|html|css|sh|example)$|^Dockerfile$|\.dockerignore$|\.gitignore$/.test(n) && !/standalone|support\.js/.test(n)) scan.push(p); } };
    walk(ROOT);
    const hits = scan.filter(f => /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/.test(fs.readFileSync(f, 'utf8')) || /scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]{20,}\$[A-Za-z0-9+/=]{40,}/.test(fs.readFileSync(f, 'utf8')));
    ok('no bot-token-shaped string or real password hash in source, config or docs (' + scan.length + ' files scanned; .env not read)', hits.length === 0, hits.join());
  } catch (e) { ok('test run crashed', false, e.stack); }
  const fail = res.filter(r => r.startsWith('FAIL')); console.log(res.join('\n')); console.log('\n' + (res.length - fail.length) + ' passed, ' + fail.length + ' failed');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail.length ? 1 : 0);
})();
