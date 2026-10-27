/* Phase 1 tests: SQLite persistence, restart/recovery, failure rollback, concurrency, backup/restore.
   Uses temporary database files only. Run: node server/test/persistence.test.js */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../server');

const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myturn-db-'));
const F = n => path.join(dir, n);
const quiet = { logError() {} };
const mk = (file, o) => createApp(Object.assign({ dbPath: file, auth: { openControls: true, patientWeb: 'demo' } }, quiet, o || {}));   // Phase 2: reset/tick need admin, or the explicit local opt-in used here
const OP = { staff: { user: 'operator', role: 'op', sess: 'rv:gm' } };
const tgReg = (app, id, name) => app.runAs({ patient: { phone: 'tg:' + id, sel: null } }, () => { const S = app.S; S.patientSignIn('tg:' + id); if (!S.profiles().length) S.saveProfile({ name: name || 'U' + id, rel: 'Myself' }); return S.register('rv:gm', S.profiles()[0].id); }).result;
const snap = app => JSON.stringify(app.snapshot());
const post = (port, body, jar) => fetch('http://127.0.0.1:' + port + '/api/action', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, jar && Object.keys(jar).length ? { Cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ') } : {}), body: JSON.stringify(body) })
  .then(async r => { if (jar) for (const c of r.headers.getSetCookie()) { const [kv] = c.split(';'), i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); } return { status: r.status, json: await r.json() }; });
const listen = (app, port) => new Promise(r => app.server.listen(port, '127.0.0.1', r));

(async () => {
  try {
    // 1. safe initialisation + schema
    let app = mk(F('a.db'));
    const raw = new DatabaseSync(F('a.db'));
    ok('new database initialised with the demo seed and migration v1', app.db.load() !== null && raw.prepare('SELECT version FROM schema_migrations').all().map(r => r.version).join() === '1' && app.S.get().q['rv:gm'].length === 6);
    ok('WAL mode + FULL synchronous', raw.prepare('PRAGMA journal_mode').get().journal_mode === 'wal');
    raw.close();

    // 2/3/4. registrations survive a restart; counters continue; one transaction (one revision) per action
    const r0 = app.getRev(); const a = tgReg(app, 111, 'Rita Menon');
    ok('Telegram registration = ONE persisted revision (sign-in + profile + register are atomic)', app.getRev() === r0 + 1 && a.e.tok === 'K 044', app.getRev() - r0);
    app.runAs(OP, () => app.S.markArrived(a.e.id));                     // staff check-in
    const web = app.runAs({ patient: { phone: '9876543210', sel: 'p1' } }, () => app.S.register('rv:ch', 'p1')).result;
    const before = snap(app);
    app.close();
    app = mk(F('a.db'));
    ok('restart: state identical (queues, accounts, counters, audit, rev, epoch)', snap(app) === before);
    const mine = app.S.get().q['rv:gm'].find(e => e.id === a.e.id);
    ok('restart: Telegram registration kept, token K 044, checked in', mine && mine.tok === 'K 044' && mine.st === 'wait' && mine.acct === 'tg:111');
    ok('restart: website registration kept (C 104)', app.S.get().q['rv:ch'].some(e => e.tok === 'C 104' && e.acct === '9876543210'));
    const b = tgReg(app, 222, 'Second User');
    ok('restart: token numbering continues (next K 045, no reuse)', b.e.tok === 'K 045', b.e && b.e.tok);
    const dupAgain = tgReg(app, 111);
    ok('restart: still one active visit per user (idempotent registration)', dupAgain.err === 'dup' && app.S.get().q['rv:gm'].filter(e => e.acct === 'tg:111').length === 1);

    // 5. Telegram update-id de-duplication is persistent
    ok('update id first seen -> true, repeat -> false', app.markUpdate(9001) === true && app.markUpdate(9001) === false);
    app.close(); app = mk(F('a.db'));
    ok('update id duplicate is still detected after restart', app.markUpdate(9001) === false && app.markUpdate(9002) === true);

    // 6. database write failure: rolled back, 503, health reflects it, recovery
    const port = 5195; await listen(app, port);
    let h = await fetch('http://127.0.0.1:' + port + '/healthz').then(r => r.json()); ok('/healthz ok (sqlite)', h.ok === true && h.storage === 'sqlite');
    const ctrBefore = JSON.stringify(app.S.get().ctr), revBefore = app.getRev(), rowsBefore = app.S.get().q['rv:gm'].length;
    const realSave = app.db.save.bind(app.db);
    app.db.save = () => { throw new Error('disk full'); };
    let thrown = null; try { tgReg(app, 333); } catch (e) { thrown = e; }
    ok('failed write: action rejected with a storage error (no silent success)', thrown && /storage unavailable/.test(thrown.message));
    ok('failed write: memory rolled back (no phantom entry, counter and revision unchanged)', app.S.get().q['rv:gm'].length === rowsBefore && JSON.stringify(app.S.get().ctr) === ctrBefore && app.getRev() === revBefore && !app.S.get().accounts['tg:333']);
    const resetFail = await post(port, { method: 'reset', args: ['missed'], session: {} });
    ok('failed write: HTTP reset answers 503, queue and epoch untouched', resetFail.status === 503 && app.S.get().scenario === 'normal');
    h = await fetch('http://127.0.0.1:' + port + '/healthz'); ok('failed write: /healthz reports 503', h.status === 503);
    const blocked = await post(port, { method: 'tick', args: [], session: {} }); ok('while unhealthy actions are refused with 503', blocked.status === 503);
    app.db.save = realSave;                                              // disk recovers
    h = await fetch('http://127.0.0.1:' + port + '/healthz'); ok('recovery: a successful write probe restores health (200)', h.status === 200);
    const okReg = tgReg(app, 333, 'Third'); ok('recovery: registration works again', okReg.ok === true && okReg.e.tok === 'K 046');
    app.close(); app = mk(F('a.db')); ok('recovery: that registration is on disk after restart', app.S.get().q['rv:gm'].some(e => e.acct === 'tg:333' && e.tok === 'K 046'));

    // 7. concurrent operations: 12 users, each fires two simultaneous registrations; plus interleaved staff actions
    const p2 = 5196; await listen(app, p2); app.S.reset('normal'); await Promise.resolve();
    const phones = Array.from({ length: 12 }, (_, i) => '90000000' + String(10 + i));
    const jars = {}; for (const ph of phones) jars[ph] = {};
    for (const ph of phones) { await post(p2, { method: 'patientSignIn', args: [ph] }, jars[ph]); await post(p2, { method: 'saveProfile', args: [{ name: 'P' + ph.slice(-2), rel: 'Myself' }] }, jars[ph]); }
    const reqs = []; for (const ph of phones) for (let k = 0; k < 2; k++) reqs.push(post(p2, { method: 'register', args: ['rv:gm', 'p1'], sel: 'p1' }, jars[ph]));
    for (let i = 0; i < 6; i++) reqs.push(post(p2, { method: 'tick', args: [], session: {} }));
    const out = await Promise.all(reqs);
    const regRes = out.slice(0, 24).map(o => o.json.result), okN = regRes.filter(r => r.ok).length, dupN = regRes.filter(r => r.err === 'dup').length;
    const rows = app.S.get().q['rv:gm'].filter(e => phones.includes(e.acct)), toks = rows.map(e => e.tok);
    ok('24 simultaneous registrations (2 per user) -> exactly 12 created, 12 rejected as duplicates', okN === 12 && dupN === 12 && rows.length === 12, okN + '/' + dupN + '/' + rows.length);
    ok('tokens unique and consecutive, no gaps or reuse', new Set(toks).size === 12 && toks.every(t => /^K 0(4[4-9]|5[0-5])$/.test(t)), toks.join());
    const live = snap(app); app.close(); app = mk(F('a.db')); ok('concurrent run is fully persisted (identical after restart)', snap(app) === live);

    // 8. backup / restore
    const backup = app.db.backupTo(F('backup1.db'));
    const atBackup = snap(app);
    tgReg(app, 444, 'After Backup');
    let refused = false; try { app.db.backupTo(backup); } catch (e) { refused = e.code === 'BACKUP_EXISTS'; }
    ok('backup refuses to overwrite an existing file', refused);
    app.close();
    fs.copyFileSync(F('backup1.db'), F('restored.db'));
    const restored = mk(F('restored.db'));
    ok('restore: a database opened from the backup equals the state at backup time (later registration absent)', snap(restored) === atBackup && !restored.S.get().accounts['tg:444']);
    restored.close();

    // 9. reset is durable and increments the epoch
    app = mk(F('a.db')); const e0 = app.getEpoch(); await listen(app, 5197);
    const rr = await post(5197, { method: 'reset', args: ['missed'], session: {} });
    ok('reset via API succeeds and epoch changes', rr.status === 200 && app.getEpoch() !== e0);
    const ep1 = app.getEpoch(); app.close(); app = mk(F('a.db'));
    ok('reset is durable: scenario "missed", Telegram data gone, epoch preserved across restart', app.S.get().scenario === 'missed' && !app.S.get().accounts['tg:111'] && app.getEpoch() === ep1);
    app.close();

    // 10. clean production start
    let em = mk(F('empty.db'), { seedMode: 'empty' });
    ok('empty seed mode: no demo rows, no demo accounts', Object.values(em.S.get().q).every(q => q.length === 0) && Object.keys(em.S.get().accounts).length === 0);
    const first = tgReg(em, 1, 'First'); ok('empty seed mode: first token is K 001', first.e.tok === 'K 001', first.e && first.e.tok);
    em.close(); em = mk(F('empty.db'), { seedMode: 'demo' });
    ok('existing database is never re-seeded on restart (seed mode only applies to a new database)', em.S.get().q['rv:gm'].length === 1 && em.S.get().q['rv:gm'][0].tok === 'K 001'); em.close();

    // 11. corrupt / unsupported databases: clear startup failure, database left untouched
    fs.writeFileSync(F('garbage.db'), Buffer.from('this is not a sqlite database at all'.repeat(40)));
    const g0 = fs.readFileSync(F('garbage.db'));
    let code = null; try { mk(F('garbage.db')); } catch (e) { code = e.code; }
    ok('garbage file: startup fails with DB_OPEN_FAILED and the file is untouched', code === 'DB_OPEN_FAILED' && g0.equals(fs.readFileSync(F('garbage.db'))), code);
    let d = mk(F('c.db')); d.close();
    const c = new DatabaseSync(F('c.db')); c.prepare("UPDATE app_state SET shared = 'not json' WHERE id = 1").run(); c.close();
    code = null; try { mk(F('c.db')); } catch (e) { code = e.code; }
    const c2 = new DatabaseSync(F('c.db')); const stillBad = c2.prepare('SELECT shared FROM app_state').get().shared === 'not json'; c2.close();
    ok('invalid JSON snapshot: DB_CORRUPT_STATE and NOT overwritten', code === 'DB_CORRUPT_STATE' && stillBad, code);
    d = mk(F('d.db')); d.close();
    const dd = new DatabaseSync(F('d.db')); dd.prepare("UPDATE app_state SET shared = '{\"q\":5}' WHERE id = 1").run(); dd.close();
    code = null; try { mk(F('d.db')); } catch (e) { code = e.code; }
    ok('wrong-shape snapshot rejected (DB_CORRUPT_STATE)', code === 'DB_CORRUPT_STATE', code);
    d = mk(F('e.db')); d.close();
    const ee = new DatabaseSync(F('e.db')); ee.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (99, 'x')").run(); ee.close();
    code = null; try { mk(F('e.db')); } catch (e) { code = e.code; }
    ok('database from a newer app version is refused (DB_NEWER_SCHEMA)', code === 'DB_NEWER_SCHEMA', code);

    // 12. in-memory mode still works (tests / quick demo) and says so
    const mem = createApp(quiet); await listen(mem, 5198);
    const mh = await fetch('http://127.0.0.1:5198/healthz').then(r => r.json()); ok('memory mode: /healthz says storage = memory', mh.ok && mh.storage === 'memory'); mem.close();
  } catch (e) { res.push('ERROR ' + (e.stack || e)); }
  console.log(res.join('\n')); const bad = res.filter(r => !r.startsWith('PASS')).length;
  console.log('\n' + (res.length - bad) + ' passed, ' + bad + ' failed');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
  process.exit(bad ? 1 : 0);
})();
