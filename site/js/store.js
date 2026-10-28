/* MyTurn demo — shared state store.
   Both the Patient and Staff frames read and write ONLY through this module,
   so every action on one side is immediately visible on the other.
   Persistence: localStorage (demo only, no backend). */
(function () {
  'use strict';
  const KEY = 'myturn.demo.v1';
  const MAX_PROFILES = 7;
  let DEFAULT_AVG_MIN = 8;      // average minutes per visit; configurable (server: AVG_SERVICE_MINUTES), shared via state.policy
  const ACTIVE = ['reg', 'wait', 'called', 'svc', 'missed', 'retreq', 'retq'];
  const DEMO_USERS = { operator: { pw: 'demo', role: 'op' }, admin: { pw: 'demo', role: 'admin' } };

  const CLINICS = [
    { id: 'rv', en: 'Riverside Hospital', hi: 'रिवरसाइड अस्पताल', sessions: [
      { id: 'gm', tok: 'K', room: '4', en: 'General Medicine', hi: 'सामान्य चिकित्सा', hours: ['8:00 AM – 12:00 PM', 'सुबह 8:00 – दोपहर 12:00'], st: 'open' },
      { id: 'ch', tok: 'C', room: '2', en: "Children's Clinic", hi: 'बाल क्लिनिक', hours: ['8:30 AM – 11:30 AM', 'सुबह 8:30 – 11:30'], st: 'open' },
      { id: 'ey', tok: 'E', room: '6', en: 'Eye Clinic', hi: 'नेत्र क्लिनिक', hours: ['1:30 PM – 4:00 PM', 'दोपहर 1:30 – 4:00'], st: 'later' },
      { id: 'dn', tok: 'D', room: '7', en: 'Dental Clinic', hi: 'दंत क्लिनिक', hours: ['Next session Tuesday', 'अगला सत्र मंगलवार'], st: 'closed' }] },
    { id: 'lv', en: 'Lakeview Family Clinic', hi: 'लेकव्यू फ़ैमिली क्लिनिक', sessions: [
      { id: 'gp', tok: 'G', room: '1', en: 'General Practice', hi: 'सामान्य परामर्श', hours: ['9:00 AM – 1:00 PM', 'सुबह 9:00 – दोपहर 1:00'], st: 'open' },
      { id: 'sk', tok: 'S', room: '3', en: 'Skin Clinic', hi: 'त्वचा क्लिनिक', hours: ['2:00 PM – 5:00 PM', 'दोपहर 2:00 – 5:00'], st: 'later' }] },
    { id: 'ng', en: "Northgate Children's Hospital", hi: 'नॉर्थगेट बाल अस्पताल', sessions: [
      { id: 'pd', tok: 'P', room: '5', en: 'Paediatrics OPD', hi: 'बाल रोग ओपीडी', hours: ['8:00 AM – 12:00 PM', 'सुबह 8:00 – दोपहर 12:00'], st: 'open' },
      { id: 'vc', tok: 'V', room: '8', en: 'Vaccination', hi: 'टीकाकरण', hours: ['9:00 AM – 12:00 PM', 'सुबह 9:00 – दोपहर 12:00'], st: 'onsite' }] },
    { id: 'me', en: 'Maple Street Eye Clinic', hi: 'मेपल स्ट्रीट नेत्र क्लिनिक', sessions: [
      { id: 'ey', tok: 'M', room: '2', en: 'Eye Clinic', hi: 'नेत्र क्लिनिक', hours: ['10:00 AM – 2:00 PM', 'सुबह 10:00 – दोपहर 2:00'], st: 'open' }] }
  ];

  // Hindi renderings for the illustrative seed names (names typed by users stay as typed).
  const HI_NAMES = { 'Meena R.': 'मीना आर.', 'Ravi S.': 'रवि एस.', 'Asha V.': 'आशा वी.', 'Imran K.': 'इमरान के.', 'Ramesh V.': 'रमेश वी.', 'Sita D.': 'सीता डी.', 'Lata P.': 'लता पी.', 'Dev S.': 'देव एस.', 'Neha T.': 'नेहा टी.', 'Asha Verma': 'आशा वर्मा', 'Ramesh Verma': 'रमेश वर्मा', 'Meera Verma': 'मीरा वर्मा' };

  const sessKey = (c, s) => c + ':' + s;
  function findSession(key) {
    const [c, s] = key.split(':');
    const cl = CLINICS.find(x => x.id === c);
    const se = cl && cl.sessions.find(x => x.id === s);
    return se ? { clinic: cl, session: se, key } : null;
  }
  const pad = n => String(n).padStart(3, '0');

  function seed(scenario) {
    const q = {}, ctr = {};
    CLINICS.forEach(c => c.sessions.forEach(s => { q[sessKey(c.id, s.id)] = []; ctr[sessKey(c.id, s.id)] = 1; }));
    const fill = (key, tok, start, list) => {
      q[key] = list.map(([name, st, extra], i) => Object.assign({ id: key + '#' + (start + i), tok: tok + ' ' + pad(start + i), name, st, acct: null, pid: null, cancelReq: false, note: null, by: null }, extra || {}));
      ctr[key] = start + list.length;
    };
    if (scenario === 'empty') {
      /* clean start for a real deployment: no demo queue rows, no demo accounts */
    } else if (scenario === 'missed') {
      fill('rv:gm', 'K', 38, [['Meena R.', 'done'], ['Ravi S.', 'done'], ['Asha V.', 'done'], ['Imran K.', 'done'], ['Ramesh V.', 'svc'], ['Sita D.', 'wait']]);
    } else if (scenario === 'late') {
      fill('rv:gm', 'K', 38, [['Meena R.', 'done'], ['Ravi S.', 'svc'], ['Asha V.', 'wait'], ['Imran K.', 'retreq', { note: 'app' }], ['Ramesh V.', 'reg'], ['Sita D.', 'missed']]);
    } else {
      fill('rv:gm', 'K', 38, [['Meena R.', 'done'], ['Ravi S.', 'svc'], ['Asha V.', 'wait'], ['Imran K.', 'wait'], ['Ramesh V.', 'reg'], ['Sita D.', 'missed']]);
    }
    if (scenario !== 'empty') fill('rv:ch', 'C', 101, [['Lata P.', 'done'], ['Dev S.', 'svc'], ['Neha T.', 'wait']]);
    return {
      v: 1, scenario, net: true, ticker: false,
      accounts: scenario === 'empty' ? {} : { '9876543210': { nid: 4, profiles: [
        { id: 'p1', name: 'Asha Verma', rel: 'Myself', yob: 1991 },
        { id: 'p2', name: 'Ramesh Verma', rel: 'Father', yob: 1958 },
        { id: 'p3', name: 'Meera Verma', rel: 'Child', yob: 2019 }] } },
      patient: { phone: null, sel: null },
      staff: { user: null, role: null, sess: null },
      policy: { returns: scenario === 'late' ? 'admin' : 'allow', avgServiceMin: DEFAULT_AVG_MIN },
      q, ctr, audit: []
    };
  }

  let state;
  const subs = [];
  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) { const s = JSON.parse(raw); if (s && s.v === 1) return s; } } catch (e) {}
    return seed('normal');
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function commit() { save(); subs.forEach(f => { try { f(state); } catch (e) { console.error(e); } }); }
  state = load();
  window.addEventListener('storage', e => { if (e.key === KEY && e.newValue) { try { state = JSON.parse(e.newValue); subs.forEach(f => f(state)); } catch (x) {} } });

  const entries = key => state.q[key] || [];
  const byId = id => { for (const k in state.q) { const e = state.q[k].find(x => x.id === id); if (e) return { e, key: k, list: state.q[k] }; } return null; };
  const isRole = r => state.staff.role === r;
  const log = (who, action, e) => { state.audit.unshift({ who, action, tok: e ? e.tok : '', t: Date.now() }); state.audit.length = Math.min(state.audit.length, 30); };
  const ok = () => ({ ok: true });
  const err = k => ({ err: k });
  const busy = list => list.some(x => x.st === 'called' || x.st === 'svc');
  const moveToEnd = (list, e) => { list.splice(list.indexOf(e), 1); list.push(e); };
  const myPhone = () => state.patient.phone;
  const staffName = () => state.staff.role === 'admin' ? 'admin' : 'operator';

  const S = {
    MAX_PROFILES, CLINICS, HI_NAMES, ACTIVE, DEMO_USERS, findSession, sessKey,
    get: () => state,
    subscribe: f => { subs.push(f); },
    entries, byId,

    /* ---- approximate waiting time (shared by the website and the Telegram bot) ----
       Only a CHECKED-IN patient ('wait') gets an estimate. Remote registration ('reg') never does.
       ahead     = checked-in patients before them in the session queue (same count the UI shows)
       inService = someone is currently called or in service (counted as half a visit on average)
       range     = 75%..125% of  avg * (ahead + 0.5 if inService), rounded outward to 5 minutes. Not a guarantee. */
    /* server only: load previously persisted shared state (already validated by server/db.js) */
    hydrate(sh) { ['accounts', 'q', 'ctr', 'audit', 'policy', 'scenario'].forEach(k => { if (sh && sh[k] !== undefined) state[k] = sh[k]; }); },
    setAvgServiceMin(n) { n = Math.round(Number(n)); if (!(n >= 1 && n <= 120)) return err('avg'); DEFAULT_AVG_MIN = n; state.policy.avgServiceMin = n; commit(); return ok(); },
    waitInfo(id) {
      const r = byId(id); if (!r) return { code: 'none' };
      const e = r.e, list = r.list;
      if (['reg', 'called', 'svc', 'missed', 'retreq', 'retq'].includes(e.st)) return { code: e.st };   // no estimate for these
      if (e.st !== 'wait') return { code: 'none' };                                                        // finished / cancelled / no-show
      const ahead = list.slice(0, list.indexOf(e)).filter(x => x.st === 'wait').length;
      const inService = list.some(x => x.st === 'called' || x.st === 'svc');
      const avg = state.policy && state.policy.avgServiceMin != null ? state.policy.avgServiceMin : DEFAULT_AVG_MIN;
      if (!(avg > 0)) return { code: 'noavg', ahead, inService };                                          // timing data missing
      const mid = avg * (ahead + (inService ? 0.5 : 0));
      let lo = Math.floor(0.75 * mid / 5) * 5, hi = Math.ceil(1.25 * mid / 5) * 5; if (hi <= lo) hi = lo + 5;
      return { code: 'est', ahead, inService, lo, hi, avg };
    },

    /* ---- demo controls ---- */
    reset(scenario) { const keepNet = false; state = seed(scenario || state.scenario || 'normal'); commit(); return keepNet; },
    setNet(v) { state.net = !!v; commit(); },
    setTicker(v) { state.ticker = !!v; commit(); },
    tick() {
      let changed = false;
      for (const key in state.q) {
        const list = state.q[key];
        const svc = list.find(x => x.st === 'svc'), called = list.find(x => x.st === 'called');
        let e = null, to = null;
        if (svc && !svc.acct) { e = svc; to = 'done'; }
        else if (called && !called.acct) { e = called; to = 'svc'; }
        else if (!svc && !called) { const w = list.find(x => x.st === 'wait'); if (w && !w.acct) { e = w; to = 'called'; } }
        if (e) { e.st = to; changed = true; }
      }
      if (changed) commit();
      return changed;
    },

    /* ---- patient actions ---- */
    patientSignIn(phone) {
      const acc = state.accounts[phone] || (state.accounts[phone] = { nid: 1, profiles: [] });
      state.patient.phone = phone;
      state.patient.sel = acc.profiles[0] ? acc.profiles[0].id : null;
      commit();
    },
    patientSignOut() { state.patient = { phone: null, sel: null }; commit(); },
    account() { return state.accounts[myPhone()] || null; },
    profiles() { const a = S.account(); return a ? a.profiles : []; },
    selectProfile(id) { state.patient.sel = id; commit(); },
    saveProfile(p) {
      const a = S.account(); if (!a) return err('auth');
      const name = (p.name || '').trim();
      if (!name) return err('name');
      const yob = parseInt(p.yob, 10);
      if (p.yob && !(yob >= 1900 && yob <= new Date().getFullYear())) return err('yob');
      if (p.id) {
        const x = a.profiles.find(z => z.id === p.id); if (!x) return err('gone');
        Object.assign(x, { name, rel: p.rel || 'Other', yob: yob || '' });
      } else {
        if (a.profiles.length >= MAX_PROFILES) return err('limit');
        const np = { id: 'p' + a.nid++, name, rel: p.rel || 'Other', yob: yob || '' };
        a.profiles.push(np);
        if (!state.patient.sel) state.patient.sel = np.id;
      }
      commit(); return ok();
    },
    deleteProfile(id) {
      const a = S.account(); if (!a) return err('auth');
      a.profiles = a.profiles.filter(x => x.id !== id);
      if (state.patient.sel === id) state.patient.sel = a.profiles[0] ? a.profiles[0].id : null;
      commit(); return ok();
    },
    myVisits() { const ph = myPhone(), out = []; for (const k in state.q) state.q[k].forEach(e => { if (e.acct === ph) out.push(Object.assign({ key: k }, { e })); }); return out; },
    activeVisitFor(pid) { return S.myVisits().find(v => v.e.pid === pid && ACTIVE.includes(v.e.st)) || null; },
    register(key, pid) {
      if (!state.net) return err('offline');
      const info = findSession(key); if (!info || info.session.st !== 'open') return err('closed');
      if (!S.profiles().find(p => p.id === pid)) return err('noProfile');
      if (S.activeVisitFor(pid)) return err('dup');
      const n = state.ctr[key]++;
      const prof = S.profiles().find(p => p.id === pid);
      const e = { id: key + '#' + n, tok: info.session.tok + ' ' + pad(n), name: prof.name, st: 'reg', acct: myPhone(), pid, cancelReq: false, note: null, by: null };
      entries(key).push(e); commit(); return { ok: true, e, key };
    },
    checkIn(id) {
      if (!state.net) return err('offline');
      const r = byId(id); if (!r || r.e.st !== 'reg') return err('state');
      r.e.st = 'wait'; moveToEnd(r.list, r.e); commit(); return ok();
    },
    patientCancel(id) {
      if (!state.net) return err('offline');
      const r = byId(id); if (!r) return err('state');
      if (['reg', 'wait', 'retreq', 'retq'].includes(r.e.st)) { r.e.st = 'cancelled'; r.e.note = 'patient'; commit(); return ok(); }
      if (r.e.st === 'called') { r.e.cancelReq = true; commit(); return { ok: true, requested: true }; }
      return err('state');
    },
    requestReturn(id) {
      if (!state.net) return err('offline');
      const r = byId(id); if (!r || r.e.st !== 'missed') return err('state');
      r.e.st = 'retreq'; r.e.note = 'app'; commit(); return ok();
    },

    /* ---- staff actions (checked against role here, not just in the UI) ---- */
    staffLogin(u, p) {
      const d = DEMO_USERS[(u || '').trim().toLowerCase()];
      if (!d || d.pw !== p) return err('badcreds');
      state.staff = { user: (u || '').trim().toLowerCase(), role: d.role, sess: null }; commit(); return ok();
    },
    staffLogout() { state.staff = { user: null, role: null, sess: null }; commit(); },
    staffSessions() {
      const out = [];
      CLINICS.forEach(c => c.sessions.forEach(s => {
        if (s.st !== 'open') return;
        if (state.staff.role === 'op' && c.id !== 'rv') return;
        out.push({ clinic: c, session: s, key: sessKey(c.id, s.id) });
      }));
      return out;
    },
    openSession(key) { if (!S.staffSessions().some(x => x.key === key)) return err('forbidden'); state.staff.sess = key; commit(); return ok(); },
    closeSession() { state.staff.sess = null; commit(); },
    _staff() { return state.staff.role ? null : err('auth'); },
    call(id) {
      if (S._staff()) return err('auth');
      const r = byId(id); if (!r || !['wait', 'retq'].includes(r.e.st)) return err('state');
      if (busy(r.list)) return err('busy');
      r.e.st = 'called'; log(staffName(), 'call', r.e); commit(); return ok();
    },
    callNext(key) {
      if (S._staff()) return err('auth');
      const list = entries(key); if (busy(list)) return err('busy');
      const e = list.find(x => x.st === 'wait') || list.find(x => x.st === 'retq');
      if (!e) return err('empty');
      e.st = 'called'; log(staffName(), 'call', e); commit(); return { ok: true, e };
    },
    start(id) { if (S._staff()) return err('auth'); const r = byId(id); if (!r || r.e.st !== 'called') return err('state'); r.e.st = 'svc'; r.e.cancelReq = false; log(staffName(), 'start', r.e); commit(); return ok(); },
    complete(id) { if (S._staff()) return err('auth'); const r = byId(id); if (!r || r.e.st !== 'svc') return err('state'); r.e.st = 'done'; log(staffName(), 'done', r.e); commit(); return ok(); },
    markMissed(id) { if (S._staff()) return err('auth'); const r = byId(id); if (!r || r.e.st !== 'called') return err('state'); r.e.st = 'missed'; log(staffName(), 'missed', r.e); commit(); return ok(); },
    markArrived(id) {
      if (S._staff()) return err('auth');
      const r = byId(id); if (!r) return err('state');
      if (r.e.st === 'reg') { r.e.st = 'wait'; moveToEnd(r.list, r.e); }
      else if (r.e.st === 'missed') { r.e.st = 'retreq'; r.e.note = 'staff'; }
      else return err('state');
      log(staffName(), 'arrived', r.e); commit(); return ok();
    },
    markNoShow(id) { if (S._staff()) return err('auth'); const r = byId(id); if (!r || !['reg', 'wait'].includes(r.e.st)) return err('state'); r.e.st = 'noshow'; log(staffName(), 'noshow', r.e); commit(); return ok(); },
    acceptReturn(id, override) {
      if (S._staff()) return err('auth');
      const r = byId(id); if (!r || r.e.st !== 'retreq') return err('state');
      const restricted = state.policy.returns === 'admin';
      if (override && !isRole('admin')) return err('forbidden');
      if (restricted && !override) return err('adminOnly');
      r.e.st = 'retq'; r.e.by = state.staff.role; r.e.note = override ? 'override' : 'ok';
      log(staffName(), override ? 'override' : 'accept', r.e); commit(); return ok();
    },
    declineReturn(id) { if (S._staff()) return err('auth'); const r = byId(id); if (!r || r.e.st !== 'retreq') return err('state'); r.e.st = 'declined'; log(staffName(), 'decline', r.e); commit(); return ok(); },
    cancelVisit(id) { if (S._staff()) return err('auth'); const r = byId(id); if (!r || !ACTIVE.includes(r.e.st)) return err('state'); r.e.st = 'cancelled'; r.e.note = 'staff'; log(staffName(), 'cancel', r.e); commit(); return ok(); },
    resetQueue(key) {
      if (!isRole('admin')) return err('forbidden');
      state.q[key] = []; log('admin', 'reset', null); commit(); return ok();
    }
  };
  /* ---- Optional shared-server mode ----
     When served by server/server.js the queue lives on the server. This browser then
       1. loads the server's queue state before anything renders (one synchronous request),
       2. still runs every action locally (instant UI) and forwards it to the server as a COMMAND,
       3. replaces its queue data with the server's authoritative state whenever the server pushes it.
     The browser never sends state, so a stale tab cannot overwrite newer server state.
     Per-browser session data (who is signed in, offline switch, ticker) stays local.
     Without the server (static hosting, file://) none of this runs and the demo behaves as before. */
  if (typeof XMLHttpRequest !== 'undefined' && typeof location !== 'undefined' && /^https?:$/.test(location.protocol)) {
    const SHARED = ['accounts', 'q', 'ctr', 'audit', 'policy', 'scenario'];
    const mergeShared = sh => SHARED.forEach(k => { state[k] = sh[k]; });
    const clearSessions = () => { state = Object.assign({}, state, { patient: { phone: null, sel: null }, staff: { user: null, role: null, sess: null }, net: true, ticker: false }); };
    let serverMode = false, lastRev = 0;
    try {
      const x = new XMLHttpRequest(); x.open('GET', '/api/state', false); x.send();
      if (x.status === 200) {
        const d = JSON.parse(x.responseText);
        if (d && d.shared) {
          if (state.epoch !== d.epoch) clearSessions();       // the server was reset/restarted since this browser last synced
          mergeShared(d.shared); state.epoch = d.epoch; lastRev = d.rev; serverMode = true; save();
        }
      }
    } catch (e) { /* no server: stay local */ }
    // Production pages carry <meta name="myturn-require-server">: there the browser-only demo (simulated data/sign-in) must never be used as a fallback.
    const requireServer = typeof document !== 'undefined' && !!document.querySelector('meta[name="myturn-require-server"]');
    const hi = () => { try { return localStorage.getItem('myturn.lang') === 'hi'; } catch (e) { return false; } };
    const MSG = {
      down: ['MyTurn is temporarily unavailable. Please try again in a few minutes.', 'MyTurn अभी उपलब्ध नहीं है। कृपया कुछ मिनट बाद फिर कोशिश करें।'],
      lost: ["Can't reach MyTurn. Your last action may not have been saved. Please check the queue.", 'MyTurn से संपर्क नहीं हो पा रहा। आपकी आख़िरी कार्रवाई सहेजी न गई हो। कृपया कतार जाँचें।'],
      busy: ['Too many actions. Please wait a moment and try again.', 'बहुत अधिक कार्रवाइयाँ। कृपया थोड़ा रुककर फिर कोशिश करें।'],
      noweb: ['Sign-in on this website is turned off. Please use the MyTurn Telegram bot.', 'इस वेबसाइट पर साइन-इन बंद है। कृपया MyTurn टेलीग्राम बॉट का उपयोग करें।']
    };
    let noticeEl = null, noticeT = 0;
    const notice = (k, sticky) => {
      if (typeof document === 'undefined' || !document.body) return;
      if (!noticeEl) { noticeEl = document.createElement('div'); noticeEl.setAttribute('role', 'alert'); noticeEl.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:2147483000;max-width:min(92vw,520px);padding:12px 16px;border-radius:12px;background:#0F3D2E;color:#F7F3E9;font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);text-align:center'; document.body.appendChild(noticeEl); }
      noticeEl.textContent = MSG[k][hi() ? 1 : 0]; noticeEl.style.display = 'block'; clearTimeout(noticeT);
      if (!sticky) noticeT = setTimeout(() => { noticeEl.style.display = 'none'; }, 7000);
    };
    if (!serverMode && requireServer) {
      window.MT = window.MT || {}; window.MT.blocked = true;
      const wall = document.createElement('div'); wall.style.cssText = 'position:fixed;inset:0;z-index:2147483600;background:#0F3D2E;color:#F7F3E9;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font:600 18px/1.5 system-ui,sans-serif';
      wall.textContent = MSG.down[hi() ? 1 : 0]; document.body.appendChild(wall);
    }
    if (serverMode) {
      /* Authentication is decided by the SERVER (HttpOnly session cookies). state.staff / state.patient here are only a
         mirror of /api/auth/me so the UI knows what to show; the server ignores anything the browser says about identity. */
      let authInfo = { patientWeb: 'demo', demoCredentials: false, openControls: false };
      const notify = () => subs.forEach(f => { try { f(state); } catch (e) { console.error(e); } });
      const applyMe = () => {
        try {
          const x = new XMLHttpRequest(); x.open('GET', '/api/auth/me', false); x.send();
          if (x.status !== 200) return false;
          const m = JSON.parse(x.responseText); authInfo = m; window.MT = window.MT || {}; window.MT.auth = m;
          state.staff = m.staff ? { user: m.staff.user, role: m.staff.role, sess: state.staff && state.staff.user === m.staff.user ? state.staff.sess : null } : { user: null, role: null, sess: null };
          state.patient = m.patient ? { phone: m.patient.phone, sel: m.patient.sel } : { phone: null, sel: null };
          return true;
        } catch (e) { return false; }
      };
      const sync = (path, body) => { try { const x = new XMLHttpRequest(); x.open('POST', path, false); x.setRequestHeader('Content-Type', 'application/json'); x.send(JSON.stringify(body || {})); return x.status; } catch (e) { return 0; } };
      applyMe(); save();
      S.canControl = () => authInfo.openControls || state.staff.role === 'admin';
      S.staffLogin = (u, p) => {
        const st = sync('/api/auth/login', { user: u, password: p });
        if (st === 429) return err('throttled');
        if (st !== 200) return err('badcreds');
        applyMe(); refetch(true); connect(); commit(); return ok();   // new connection: the event stream is personalised by the cookies it was opened with
      };
      S.staffLogout = () => { sync('/api/auth/logout'); state.staff = { user: null, role: null, sess: null }; refetch(true); connect(); commit(); };
      const FORWARD = ['reset', 'tick', 'patientSignIn', 'patientSignOut', 'saveProfile', 'deleteProfile', 'register', 'checkIn', 'patientCancel', 'requestReturn',
        'call', 'callNext', 'start', 'complete', 'markMissed', 'markArrived', 'markNoShow', 'acceptReturn', 'declineReturn', 'cancelVisit', 'resetQueue'];
      let chain = Promise.resolve(), lastResync = 0;         // keep commands in order
      const post = (method, args, net, sel) => { chain = chain.then(() => new Promise(done => {
        try {
          const x = new XMLHttpRequest(); x.open('POST', '/api/action'); x.setRequestHeader('Content-Type', 'application/json');
          x.onloadend = () => {                              // refused / failed: re-read who the server thinks we are and what the queue really is
            const s = x.status;
            if (s === 200 && (method === 'patientSignIn' || method === 'patientSignOut')) { refetch(true); connect(); }   // the patient cookie just changed
            if (s === 403 && method === 'patientSignIn' && authInfo.patientWeb !== 'demo') notice('noweb');
            else if (s === 429) notice('busy');
            else if (s === 0 || s >= 500) notice('lost');
            if ((s === 0 || s === 401 || s === 403 || s === 429 || s >= 500) && Date.now() - lastResync > 1000) {
              lastResync = Date.now(); const okMe = applyMe(); refetch(); if (okMe) { save(); notify(); }
            }
            done();
          };
          x.send(JSON.stringify({ method, args, net, sel }));
        } catch (e) { done(); }
      })); };
      FORWARD.forEach(name => {
        const orig = S[name];
        S[name] = function () {
          const args = Array.prototype.slice.call(arguments);
          if ((name === 'reset' || name === 'tick') && !S.canControl()) return name === 'tick' ? false : err('forbidden');   // would be refused by the server
          const r = orig.apply(S, args);
          post(name, args, state.net, state.patient.sel);
          return r;
        };
      });
      const take = d => {
        if (!d || !d.shared || (d.rev <= lastRev && !d.view)) return;   // ignore older / duplicate pushes (but always take a "your access changed" push)
        lastRev = Math.max(lastRev, d.rev);
        if (d.view) applyMe();                                          // this browser's server session changed (e.g. signed out in another tab)
        if (d.epoch !== state.epoch) { clearSessions(); state.epoch = d.epoch; applyMe(); }   // another client reset the demo (server sessions are re-read, not assumed)
        mergeShared(d.shared); save(); notify();
      };
      const refetch = force => { try { const x = new XMLHttpRequest(); x.open('GET', '/api/state', false); x.send(); if (x.status === 200) { const d = JSON.parse(x.responseText); if (force) d.view = true; take(d); } } catch (e) { /* offline */ } };
      let es = null;
      function connect() {                                              // (re)open the event stream so it carries the CURRENT cookies
        if (typeof EventSource === 'undefined') return;
        if (es) es.close();
        lastRev = 0; es = new EventSource('/api/events');
        es.onmessage = ev => { let d; try { d = JSON.parse(ev.data); } catch (e) { return; } take(d); };
      }
      connect();
      window.MT = window.MT || {}; window.MT.serverMode = true;
    }
  }
  window.MT = window.MT || {};
  window.MT.store = S;
})();
