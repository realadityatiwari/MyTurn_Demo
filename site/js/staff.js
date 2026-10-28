/* MyTurn demo — Staff frame. Demo-only authentication; every action is also role-checked in MT.store. */
(function () {
  'use strict';
  const MT = window.MT, S = MT.store, t = (k, p) => MT.t(k, p), esc = MT.esc;
  const el = () => document.getElementById('sf');

  const P = { user: '', pw: '', authErr: '', tab: 'queue', sheet: null, toast: null, more: false, waitAll: false, regOpen: false };
  let sheetFn = null, toastTimer = null, lastRank = null;

  const toast = (k, p) => { P.toast = { k, p }; render(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { P.toast = null; render(); }, 2800); };
  const errKey = e => ({ forbidden: 'serr.forbidden', adminOnly: 'serr.adminOnly', busy: 'serr.busy', empty: 'serr.empty', state: 'serr.state', auth: 'serr.state' }[e] || 'serr.state');
  const confirmSheet = (o, fn) => { P.sheet = o; sheetFn = fn; render(); };
  const roleLabel = r => t(r === 'admin' ? 'role.admin' : 'role.op');
  const act = (r, ok) => { if (r.err) toast(errKey(r.err)); else if (ok) toast(ok.k, ok.p); };
  const lbl = (k, cls) => '<span class="lbl ' + (cls || '') + '">' + esc(t(k)) + '</span>';

  /* ---------- shell pieces ---------- */
  function lightTop() { return '<header class="ph-top home"><span class="wordmark">' + MT.logo(26, '#0F3D2E') + '<span>MyTurn</span></span>' + MT.langToggle() + '</header>'; }
  function darkTop(back) {
    const st = S.get();
    return '<header class="staffhead">' + (back ? '<button class="icon-btn" data-a="closeSession" aria-label="' + esc(t('s.sessions')) + '">' + MT.icon('back', 24) + '</button>' : '<span style="width:8px"></span>') +
      '<div class="ttl"><div class="t1">MyTurn <span>' + esc(t('staff')) + '</span></div><div class="t2">' + esc(roleLabel(st.staff.role)) + ' · ' + esc(t(MT.auth && MT.auth.mode === 'live' ? 'login.liveTag' : 'login.demoTag')) + '</div></div>' +
      MT.langToggle() + '<button class="icon-btn so" data-a="logout" aria-label="' + esc(t('logout')) + '" title="' + esc(t('logout')) + '">' + MT.icon('out', 22) + '</button></header>';
  }
  function sheetHtml() {
    const s = P.sheet; if (!s) return '';
    return '<div class="sheet-wrap" data-a="sheetClose" data-k="sheet"><div class="sheet" role="dialog" aria-modal="true" data-a="noop"><h3>' + esc(t(s.title, s.p)) + '</h3><p>' + esc(t(s.body, s.p)) + '</p><div class="sheet-actions">' +
      (s.ok ? '<button class="btn ' + (s.danger ? 'danger' : 'primary') + '" data-a="sheetOk">' + esc(t(s.ok)) + '</button>' : '') + '<button class="btn ghost" data-a="sheetClose">' + esc(t(s.ok ? 'cancel.no' : 'close')) + '</button></div></div></div>';
  }
  function wrap(dark, top, body, foot) {
    const tt = P.toast ? '<div class="toast" role="status" data-k="toast" data-s="' + esc(t(P.toast.k, P.toast.p)) + '" data-m="mt-swap">' + esc(t(P.toast.k, P.toast.p)) + '</div>' : '';
    return MT.sb(dark) + top + '<div class="ph-body">' + body + '</div>' + (foot ? '<div class="ph-foot">' + foot + '</div>' : '') + MT.hb() + sheetHtml() + tt;
  }

  /* ---------- login ---------- */
  // Demo credentials and quick-fill buttons are shown only for the simulated demo; hidden once the server reports real (non-demo) authentication.
  const demoHints = () => !(MT.auth && MT.auth.demoCredentials === false);
  function login() {
    return wrap(false, lightTop(),
      '<h1 class="h1">' + esc(t('login.h')) + '</h1><p class="muted">' + esc(t('login.sub')) + '</p>' +
      (demoHints() ? '<div class="notice warn">' + MT.icon('lock', 20) + '<span><b>' + esc(t('login.demoOnly')) + '</b> ' + esc(t('login.demoCreds')) + '</span></div>' : '') +
      '<label class="fld" for="s_user"><span>' + esc(t('login.user')) + '</span><input id="s_user" data-i="user" data-enter="login" value="' + esc(P.user) + '" autocomplete="off" autocapitalize="none" spellcheck="false"></label>' +
      '<label class="fld" for="s_pw"><span>' + esc(t('login.pw')) + '</span><input id="s_pw" type="password" data-i="pw" data-enter="login" value="' + esc(P.pw) + '" autocomplete="off"></label>' +
      (P.authErr ? '<p class="err">' + MT.icon('x', 16) + esc(t(P.authErr)) + '</p>' : '') +
      (demoHints() ? '<div class="quick"><button class="btn small ghost" data-a="quick" data-v="operator">' + esc(t('login.fillOp')) + '</button><button class="btn small ghost" data-a="quick" data-v="admin">' + esc(t('login.fillAdmin')) + '</button></div>' +
      '<p class="demo-tag">' + esc(t('login.note')) + '</p>' : ''),
      '<button class="btn primary block" data-a="login">' + esc(t('login.btn')) + '</button>');
  }

  /* ---------- sessions ---------- */
  function sessions() {
    const list = S.staffSessions(), st = S.get();
    return wrap(true, darkTop(false),
      '<h1 class="h2">' + esc(t('ss.h')) + '</h1><p class="muted sm">' + esc(t('ss.sub')) + '</p><div class="list" style="margin-top:12px">' +
      list.map(x => { const w = S.entries(x.key).filter(e => e.st === 'wait').length; return '<button class="li" data-a="openSession" data-v="' + x.key + '"><span class="main"><span class="t block">' + esc(MT.loc(x.session)) + '</span><span class="s block">' + esc(MT.loc(x.clinic)) + ' · ' + esc(t('room', { n: x.session.room })) + ' · ' + esc(MT.lang === 'hi' ? x.session.hours[1] : x.session.hours[0]) + '</span><span class="s block"><b>' + esc(t('role.line', { r: roleLabel(st.staff.role) })) + '</b> · ' + esc(t('ss.waiting', { n: w })) + '</span></span><span class="chev">' + MT.icon('chev', 20) + '</span></button>'; }).join('') + '</div>' +
      '<p class="muted sm" style="margin-top:12px">' + esc(t('ss.notFound')) + '</p>');
  }

  /* ---------- queue ---------- */
  const who = e => MT.nm(MT.short(e.name));
  const B = (a, v, k, cls, dis) => '<button class="btn small ' + (cls || 'ghost') + '" data-a="' + a + '" data-v="' + esc(v) + '"' + (dis ? ' aria-disabled="true"' : '') + '>' + esc(t(k)) + '</button>';
  const L = (a, v, k) => '<button class="link sm" data-a="' + a + '" data-v="' + esc(v) + '" style="min-height:32px">' + esc(t(k)) + '</button>';
  function row(e, o) {
    o = o || {};
    const ds = e.st + (e.cancelReq ? '!' : '');
    return '<div class="qrow' + (o.cls ? ' ' + o.cls : '') + '" data-k="row:' + esc(e.id) + '" data-s="' + ds + '" data-f="1" data-flip="1"><div class="main"><div class="tk"><span class="token sm">' + esc(e.tok) + '</span><span class="nm">' + esc(who(e)) + '</span></div>' + '<div class="cl">' + MT.chip(e.st, o.chipKey, '', ' data-k="rc:' + esc(e.id) + '" data-s="' + ds + '" data-m="mt-pop"') + (o.link || '') + '</div>' + (o.note ? '<div class="note">' + esc(o.note) + '</div>' : '') + (o.html || '') + '</div>' + (o.acts ? '<div class="acts">' + o.acts + '</div>' : '') + '</div>';
  }

  function queue() {
    const st = S.get(), key = st.staff.sess, info = S.findSession(key);
    if (!info) { P.sheet = null; return sessions(); }
    const q = S.entries(key), isAdmin = st.staff.role === 'admin';
    const svc = q.find(e => e.st === 'svc'), called = q.find(e => e.st === 'called');
    const busy = !!(svc || called);
    const hasNext = q.some(e => e.st === 'wait' || e.st === 'retq');
    const cnt = { w: q.filter(e => e.st === 'wait').length, s: svc || called ? 1 : 0, late: q.filter(e => ['missed', 'retreq'].includes(e.st)).length, ret: q.filter(e => e.st === 'retq').length };
    const policyAdmin = st.policy.returns === 'admin';
    const cur = svc || called;

    const notice = '<div class="notice slim"><b aria-hidden="true">▶</b><span>' + (cur ? esc(t('q.finishTok', { tok: cur.tok })) : esc(t('q.one'))) + '</span></div>';
    let list = '';
    if (P.tab === 'queue') {
      if (called) list += lbl('q.svcNow') + row(called, { cls: 'now', chipKey: 'st.calledStaff', acts: B('start', called.id, 'a.start', 'primary') + B('missed', called.id, 'a.missed'), note: called.cancelReq ? t('q.cancelReq') : '' }) + (called.cancelReq ? '<div class="center">' + L('cancel', called.id, 'a.cancel') + '</div>' : '');
      else if (svc) list += lbl('q.svcNow') + row(svc, { cls: 'now', acts: B('complete', svc.id, 'a.complete', 'primary') });
      else list += lbl('q.svcNow') + '<p class="muted">' + esc(t('q.noSvc')) + '</p>';
      const w = q.filter(e => e.st === 'wait'), r = q.filter(e => e.st === 'reg');
      const shown = P.waitAll ? w : w.slice(0, 3);
      list += lbl('q.laneWait') + (w.length ? shown.map(e => row(e, { link: L('noshow', e.id, 'a.noshow'), acts: B('call', e.id, 'a.call', 'primary', busy), note: e.cancelReq ? t('q.cancelReq') : '' })).join('') : '<p class="muted">' + esc(t('q.noneWaiting')) + '</p>');
      if (w.length > 3) list += '<button class="morebtn" style="margin-top:0" data-a="toggleWait"><span>' + esc(P.waitAll ? t('q.showLess') : t('q.showMore', { n: w.length - 3 })) + '</span>' + MT.icon(P.waitAll ? 'up' : 'down', 18) + '</button>';
      if (r.length) list += '<button class="morebtn" data-a="toggleReg" aria-expanded="' + !!P.regOpen + '"><span>' + esc(t('q.laneReg')) + ' · ' + r.map(e => esc(e.tok)).join(', ') + '</span>' + MT.icon(P.regOpen ? 'up' : 'down', 18) + '</button>' +
        (P.regOpen ? r.map(e => row(e, { link: L('noshow', e.id, 'a.noshow'), acts: B('arrived', e.id, 'a.arrived', 'primary') })).join('') : '');
      if (!w.length && !r.length && !cur) list = '<p class="muted" style="margin-top:12px">' + esc(t('q.empty')) + '</p>';
    } else if (P.tab === 'return') {
      const miss = q.filter(e => e.st === 'missed'), req = q.filter(e => e.st === 'retreq'), rq = q.filter(e => e.st === 'retq');
      if (!miss.length && !req.length && !rq.length) list = '<div class="notice" style="margin-top:12px"><span><b>' + esc(t('q.retEmpty')) + '</b><br>' + esc(t('q.retEmptySub')) + '</span></div>';
      if (miss.length) list += lbl('q.laneLate') + miss.map(e => row(e, { cls: 'late', note: t('q.missedNote'), acts: B('arrived', e.id, 'a.lateArrived', 'forest') + L('cancel', e.id, 'a.cancel') })).join('');
      if (req.length) list += lbl('q.laneReview') + req.map(e => {
        const blocked = policyAdmin && !isAdmin;
        const accept = policyAdmin ? (isAdmin ? B('override', e.id, 'a.override', 'forest') : B('blocked', e.id, 'a.accept', 'ghost', true)) : B('accept', e.id, 'a.accept', 'forest');
        const extra = policyAdmin ? '<div class="notice ' + (blocked ? 'warn' : '') + '" style="margin:8px 0 0;font-size:13px">' + MT.icon('lock', 16) + '<span>' + esc(t(blocked ? 'q.retBlocked' : 'q.retOverride')) + '</span></div>' : '';
        return row(e, { cls: 'late stack', note: t(e.note === 'staff' ? 'q.retStaff' : 'q.retApp'), html: extra, acts: accept + B('decline', e.id, 'a.decline', 'ghost') });
      }).join('');
      if (rq.length) list += lbl('q.laneRet') + rq.map(e => row(e, { acts: B('call', e.id, 'a.call', 'primary', busy) + L('cancel', e.id, 'a.cancel'), note: t(e.note === 'override' ? 'q.retqOverride' : 'q.retqOk') + ' ' + t('q.notAhead') })).join('');
    } else {
      const rows = q.filter(e => ['done', 'noshow', 'declined', 'cancelled'].includes(e.st)).reverse();
      list = rows.length ? lbl('q.tabFin') + rows.map(e => row(e)).join('') : '<p class="muted" style="margin-top:12px">' + esc(t('q.finEmpty')) + '</p>';
    }

    const tabBtn = (id, k, n) => '<button data-a="tab" data-v="' + id + '" class="' + (P.tab === id ? 'on' : '') + '" aria-pressed="' + (P.tab === id) + '">' + esc(t(k)) + (n ? ' · ' + n : '') + '</button>';
    const log = st.audit.slice(0, 6).map(a => '<li><span>' + esc(MT.time(a.t)) + '</span> ' + esc(t('log.' + a.action, { who: a.who })) + (a.tok ? ' <b>' + esc(a.tok) + '</b>' : '') + '</li>').join('');
    const foot = busy ? '<button class="btn primary block big" data-a="noop" aria-disabled="true">' + esc(t('q.callBlocked')) + '</button>' : !hasNext ? '<button class="btn primary block big" data-a="noop" aria-disabled="true">' + esc(t('q.noneWaiting')) + '</button>' : '<button class="btn primary block big" data-a="callNext">' + MT.icon('arrow', 20) + esc(t('q.callNext')) + '</button>';

    return wrap(true, darkTop(true),
      '<div class="lbl-row" style="align-items:center"><h1 class="h2" style="margin:0">' + esc(MT.loc(info.session)) + '</h1>' + MT.chipRaw('ok', '✓', t('q.open')) + '</div>' +
      '<div class="muted sm">' + esc(MT.loc(info.clinic)) + ' · ' + esc(t('room', { n: info.session.room })) + ' · ' + esc(MT.lang === 'hi' ? info.session.hours[1] : info.session.hours[0]) + '</div>' +
      (cur ? notice : '') +
      '<div class="stats"><div data-k="st-w" data-s="' + cnt.w + '" data-m="mt-tick"><b>' + cnt.w + '</b><span>' + esc(t('q.statWait')) + '</span></div><div data-k="st-s" data-s="' + cnt.s + '" data-m="mt-tick"><b>' + cnt.s + '</b><span>' + esc(t('q.statSvc')) + '</span></div><div data-k="st-l" data-s="' + cnt.late + '" data-m="mt-tick"><b>' + cnt.late + '</b><span>' + esc(t('q.statLate')) + '</span></div><div data-k="st-r" data-s="' + cnt.ret + '" data-m="mt-tick"><b>' + cnt.ret + '</b><span>' + esc(t('q.statRet')) + '</span></div></div>' +
      '<div class="lanes2" role="group">' + tabBtn('queue', 'q.tabQueue') + tabBtn('return', 'q.tabReturn', cnt.late + cnt.ret) + tabBtn('fin', 'q.tabFin') + '</div>' +
      '<div data-k="list:' + P.tab + '">' + list + '</div>' +
      '<button class="morebtn" data-a="toggleMore" aria-expanded="' + !!P.more + '"><span>' + esc(t('q.tools')) + '</span>' + MT.icon(P.more ? 'up' : 'down', 18) + '</button>' +
      (P.more ? '<div data-k="more"><p class="demo-tag amber" style="margin:6px 0 2px">' + esc(t('q.live')) + '</p><p class="muted sm">' + esc(t('q.privacy')) + '</p><button class="btn ghost block' + (isAdmin ? '' : ' locked') + '" data-a="reset">' + MT.icon(isAdmin ? 'x' : 'lock', 18) + esc(t('q.reset')) + '</button>' +
      '<button class="btn ghost block" data-a="closeSession">' + MT.icon('grid', 18) + esc(t('q.switch')) + '</button>' +
      (log ? lbl('q.recent', 'line') + '<ul class="logl">' + log + '</ul>' : '') + '</div>' : ''), foot);
  }

  function render() {
    const st = S.get();
    let html, key, rank;
    if (!st.staff.role) { P.sheet = null; html = login(); key = 'login'; rank = 0; }
    else if (!st.staff.sess) { html = sessions(); key = 'sessions'; rank = 1; }
    else { html = queue(); key = 'queue:' + st.staff.sess; rank = 2; }
    const dir = lastRank == null ? 0 : Math.sign(rank - lastRank); lastRank = rank;
    MT.renderInto(el(), html, { key, dir });
  }

  const H = {
    lang: v => MT.setLang(v), noop: () => {},
    sheetClose: (v, b) => { if (b.classList.contains('sheet-wrap') || b.classList.contains('btn')) { P.sheet = null; sheetFn = null; render(); } },
    sheetOk: () => { const f = sheetFn; P.sheet = null; sheetFn = null; render(); if (f) f(); },
    input: (n, v) => { if (n === 'user') P.user = v; else if (n === 'pw') P.pw = v; },
    quick: v => { P.user = v; P.pw = 'demo'; P.authErr = ''; render(); },
    login: () => {
      const r = S.staffLogin(P.user, P.pw);
      if (r.err) { P.authErr = r.err === 'throttled' ? 'login.wait' : 'login.bad'; P.pw = ''; return render(); }
      P.authErr = ''; P.user = ''; P.pw = ''; P.tab = 'queue'; render();
    },
    logout: () => { S.staffLogout(); P.sheet = null; render(); },
    openSession: v => { const r = S.openSession(v); if (r.err) toast(errKey(r.err)); else { P.tab = 'queue'; } },
    closeSession: () => S.closeSession(),
    tab: v => { P.tab = v; render(); },
    toggleMore: () => { P.more = !P.more; render(); },
    toggleWait: () => { P.waitAll = !P.waitAll; render(); },
    toggleReg: () => { P.regOpen = !P.regOpen; render(); },
    callNext: () => { const st = S.get(); const r = S.callNext(st.staff.sess); act(r, r.e && { k: 'toast.called', p: { tok: r.e.tok } }); },
    call: v => act(S.call(v), { k: 'toast.calledGeneric' }),
    start: v => act(S.start(v)),
    complete: v => act(S.complete(v), { k: 'toast.completed' }),
    missed: v => act(S.markMissed(v), { k: 'toast.missed' }),
    arrived: v => act(S.markArrived(v), { k: 'toast.arrived' }),
    noshow: v => { const e = S.byId(v).e; confirmSheet({ title: 'cf.noshowT', body: 'cf.noshowB', ok: 'a.noshow', danger: true, p: { tok: e.tok } }, () => act(S.markNoShow(v), { k: 'toast.noshow' })); },
    accept: v => act(S.acceptReturn(v, false), { k: 'toast.accepted' }),
    override: v => confirmSheet({ title: 'cf.overT', body: 'cf.overB', ok: 'a.override', p: {} }, () => act(S.acceptReturn(v, true), { k: 'toast.overridden' })),
    blocked: () => toast('serr.adminOnly'),
    decline: v => confirmSheet({ title: 'cf.decT', body: 'cf.decB', ok: 'a.decline', danger: true }, () => act(S.declineReturn(v), { k: 'toast.declined' })),
    cancel: v => confirmSheet({ title: 'cf.canT', body: 'cf.canB', ok: 'a.cancel', danger: true }, () => act(S.cancelVisit(v), { k: 'toast.cancelledV' })),
    reset: () => {
      if (S.get().staff.role !== 'admin') return confirmSheet({ title: 'cf.resetBlockedT', body: 'cf.resetBlockedB' }, null);
      const key = S.get().staff.sess;
      confirmSheet({ title: 'cf.resetT', body: 'cf.resetB', ok: 'q.reset', danger: true }, () => act(S.resetQueue(key), { k: 'toast.reset' }));
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    MT.bind(el(), H);
    MT.rerenders.push(render); S.subscribe(render); render();
  });
  MT.staff = { P, render };
})();
