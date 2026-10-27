/* Focused tests for the shared approximate waiting-time calculation (S.waitInfo in site/js/store.js).
   Run: node server/test/waiting-time.test.js   (no server, no network) */
'use strict';
const { createApp } = require('../server');
const app = createApp(), S = app.S;
const res = []; const ok = (n, c, x) => res.push((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' :: ' + (x || '')));
const as = (session, fn) => app.runAs(session, fn).result;
const OP = { staff: { user: 'operator', role: 'op', sess: 'rv:gm' } };
const key = 'tg:42', reg = () => as({ patient: { phone: key, sel: null } }, () => { S.patientSignIn(key); if (!S.profiles().length) S.saveProfile({ name: 'T', rel: 'Myself' }); return S.register('rv:gm', S.profiles()[0].id); }).e;
const W = id => S.waitInfo(id), range = w => w.lo + '-' + w.hi;

// 1. registration: remote registration never gets an estimate
S.reset('normal'); let e = reg();
ok('registered (reg): no estimate, must check in first', W(e.id).code === 'reg' && W(e.id).lo === undefined);
// 2. check-in: ahead = waiting entries before them (Asha, Imran), someone in service (Ravi) counts as half a visit; avg 8
as(OP, () => S.markArrived(e.id));
let w = W(e.id);
ok('checked in: ahead 2, in service, range 15-25 (avg 8)', w.code === 'est' && w.ahead === 2 && w.inService && range(w) === '15-25', JSON.stringify(w));
// 3. queue update: step the other patients; estimate must recalculate from current state
S.tick();                                             // Ravi completes -> nobody in service
w = W(e.id); ok('after current service completes: no one in service, 10-20', w.ahead === 2 && !w.inService && range(w) === '10-20', JSON.stringify(w));
S.tick();                                             // Asha called
w = W(e.id); ok('Asha called: ahead 1 (waiting only), in service, 5-15', w.ahead === 1 && w.inService && range(w) === '5-15', JSON.stringify(w));
S.tick(); S.tick(); S.tick(); S.tick();               // Asha svc, done, Imran called, svc, done
for (let i = 0; i < 4; i++) S.tick();
w = W(e.id); ok('everyone ahead finished: next, "up to" range', w.code === 'est' && w.ahead === 0 && !w.inService && w.lo === 0 && w.hi === 5, JSON.stringify(w));
// 4. current service of the patient
as(OP, () => S.callNext('rv:gm')); ok('called: no estimate', W(e.id).code === 'called');
as(OP, () => S.start(e.id)); ok('in service: no estimate', W(e.id).code === 'svc');
as(OP, () => S.complete(e.id)); ok('completed: no estimate (none)', W(e.id).code === 'none');
// 5. missed turn and return handling
S.reset('normal'); e = reg(); as(OP, () => S.markArrived(e.id)); for (let i = 0; i < 30; i++) S.tick();
as(OP, () => S.callNext('rv:gm')); as(OP, () => S.markMissed(e.id));
ok('missed turn: no estimate', W(e.id).code === 'missed');
as({ patient: { phone: key, sel: 'p1' } }, () => S.requestReturn(e.id)); ok('return requested: no estimate', W(e.id).code === 'retreq');
as(OP, () => S.acceptReturn(e.id, false)); ok('return accepted: no estimate (returns have no place or time)', W(e.id).code === 'retq');
// 6. a returning patient does not change the estimate of a checked-in patient behind (returns are served after waiting patients)
const dup = as({ patient: { phone: key, sel: 'p1' } }, () => S.register('rv:gm', 'p1'));
ok('duplicate registration while a return is pending is rejected (one active visit)', dup.err === 'dup');
// 7. other statuses / unknown ids
S.reset('normal'); ok('seed completed row: none', W('rv:gm#38').code === 'none');
ok('seed in-service row: svc', W('rv:gm#39').code === 'svc');
ok('seed missed row: missed', W('rv:gm#43').code === 'missed');
ok('seed not-checked-in row: reg', W('rv:gm#42').code === 'reg');
ok('unknown id: none', W('nope').code === 'none');
// 8. empty queue: patient alone, nobody in service
S.reset('normal'); as({ staff: { role: 'admin', user: 'admin', sess: 'rv:gm' } }, () => S.resetQueue('rv:gm')); e = reg(); as(OP, () => S.markArrived(e.id));
w = W(e.id); ok('empty queue: next, up to 5 min', w.code === 'est' && w.ahead === 0 && !w.inService && w.lo === 0 && w.hi === 5, JSON.stringify(w));
// 9. configuration and missing timing data
ok('invalid average rejected', S.setAvgServiceMin(0).err === 'avg' && S.setAvgServiceMin('abc').err === 'avg' && S.setAvgServiceMin(500).err === 'avg');
S.reset('normal'); e = reg(); as(OP, () => S.markArrived(e.id));
ok('average 8 -> 15-25', range(W(e.id)) === '15-25');
S.setAvgServiceMin(12); w = W(e.id); ok('average 12 changes estimate to 20-40 (ahead 2, in service)', range(w) === '20-40' && w.avg === 12, JSON.stringify(w));
S.reset('normal'); ok('config survives a demo reset', S.get().policy.avgServiceMin === 12);
S.setAvgServiceMin(8);
S.get().policy.avgServiceMin = 0; e = reg(); as(OP, () => S.markArrived(e.id));
ok('missing/zero timing data: no numbers (noavg)', W(e.id).code === 'noavg' && W(e.id).lo === undefined && W(e.id).ahead === 2);
// 10. other session independent
S.reset('normal'); S.setAvgServiceMin(8);
const c = as({ patient: { phone: key, sel: null } }, () => { S.patientSignIn(key); S.saveProfile({ name: 'T', rel: 'Myself' }); return S.register('rv:ch', S.profiles()[0].id); }).e;
as({ staff: { user: 'operator', role: 'op', sess: 'rv:ch' } }, () => S.markArrived(c.id));
w = W(c.id); ok("children's clinic: own queue (1 waiting ahead, in service) -> 5-15", w.code === 'est' && w.ahead === 1 && w.inService && range(w) === '5-15', JSON.stringify(w));

console.log(res.join('\n')); const bad = res.filter(r => !r.startsWith('PASS')).length;
console.log('\n' + (res.length - bad) + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
