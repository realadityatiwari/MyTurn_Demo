/* MyTurn demo — Staff frame. Demo-only authentication; every action is also role-checked in MT.store. */
(function () {
  'use strict';
  const MT = window.MT, S = MT.store, t = (k, p) => MT.t(k, p), esc = MT.esc;
  const el = () => document.getElementById('sf');

  const P = { user: '', pw: '', authErr: '', tab: 'queue', sheet: null, toast: null, more: false, waitAll: false, regOpen: false, walk: null };
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
  /* ---------- walk-in registration (staff register a patient who is present and cannot use the website or Telegram) ----------
     P.walk = { stage: 'form' | 'dup' | 'uncertain' | 'done', key, name, rid, confirm, busy, err, dup, entry, replayed, reprint }
     - rid is created ONCE per registration attempt and kept until the attempt ends (success, definite refusal, cancel): it is re-sent unchanged on
       "Register anyway" and on every retry, so the server can answer a repeat with the same entry instead of allocating another token.
     - stage 'done' (and the receipt) is reached ONLY from a server answer carrying the created entry. */
  const NAME_MAX = 40;
  const cleanName = s => String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, ' ').trim();
  const nameErr = s => { const n = cleanName(s); return !n ? 'wk.errEmpty' : n.length > NAME_MAX ? 'wk.errLong' : /[\u0000-\u001f\u007f-\u009f]/.test(n) ? 'wk.errChars' : null; };
  const newRid = () => {
    try { const c = typeof crypto !== 'undefined' ? crypto : null; if (c && c.getRandomValues) { const b = new Uint8Array(18); c.getRandomValues(b); return btoa(String.fromCharCode.apply(null, b)).replace(/\+/g, '-').replace(/\//g, '_'); } } catch (e) { /* fall through */ }
    return ('w' + Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 48);   // only where the browser has no crypto API
  };
  const validAt = at => typeof at === 'number' && isFinite(at) && at > 0 && !isNaN(new Date(at).getTime());
  const ERRKEY = { name: 'wk.errGeneric', closed: 'wk.errClosed', forbidden: 'wk.errForbidden', auth: 'wk.errAuth', busy: 'wk.errBusy' };
  const whenText = at => validAt(at) ? new Date(at).toLocaleString(MT.lang === 'hi' ? 'hi-IN' : 'en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : t('rc.timeNA');
  function receiptHtml(entry, key) {
    const info = S.findSession(key); if (!entry || !info) return '';
    return '<div class="rc-in"><div class="rc-brand">' + MT.logo(26, '#000', '#000') + '<span>MyTurn</span></div>' +
      '<div class="rc-lab">' + esc(t('rc.token')) + '</div><div class="rc-tok">' + esc(entry.tok) + '</div>' +
      '<div class="rc-dept">' + esc(MT.loc(info.session)) + '</div><div class="rc-sub">' + esc(MT.loc(info.clinic)) + ' · ' + esc(t('room', { n: info.session.room })) + '</div>' +
      '<dl class="rc-meta"><div><dt>' + esc(t('rc.patient')) + '</dt><dd>' + esc(MT.short(entry.name)) + '</dd></div><div><dt>' + esc(t('rc.when')) + '</dt><dd>' + esc(whenText(entry.at)) + '</dd></div></dl>' +
      '<ol class="rc-steps"><li>' + esc(t('rc.s1')) + '</li><li>' + esc(t('rc.s2')) + '</li><li>' + esc(t('rc.s3')) + '</li></ol></div>';
  }
  function renderReceipt() {
    const n = document.getElementById('receipt'); if (!n) return;
    const w = P.walk, html = w && w.stage === 'done' && w.entry ? receiptHtml(w.entry, w.rkey || w.key) : '';
    if (n.__html !== html) { n.__html = html; n.innerHTML = html; }
  }
  const ICON_ERR = () => MT.icon('x', 16);
  function walkHtml() {
    const w = P.walk; if (!w) return '';
    const info = S.findSession(w.key), where = info ? MT.loc(info.session) + ' · ' + MT.loc(info.clinic) : '', dis = w.busy ? ' aria-disabled="true"' : '';
    let h;
    if (w.stage === 'form') {
      h = '<h3 id="wk_h">' + esc(t('wk.title')) + '</h3><p>' + esc(where) + '</p>' +
        '<label class="fld" for="wk_name"><span>' + esc(t('wk.name')) + '</span><input id="wk_name" data-i="wkname" data-enter="wkSubmit" value="' + esc(w.name) + '" autocomplete="off" aria-describedby="wk_hint' + (w.err ? ' wk_err' : '') + '"' + (w.err ? ' aria-invalid="true"' : '') + (w.busy ? ' readonly' : '') + '></label>' +
        '<p class="demo-tag" id="wk_hint">' + esc(t('wk.hint')) + '</p>' + (w.err ? '<p class="err" id="wk_err" role="alert">' + ICON_ERR() + esc(t(w.err)) + (w.errCode ? ' (' + esc(w.errCode) + ')' : '') + '</p>' : '') +
        '<div class="sheet-actions"><button class="btn primary" data-a="wkSubmit"' + dis + '>' + esc(t(w.busy ? 'wk.busy' : 'wk.submit')) + '</button><button class="btn ghost" data-a="wkClose"' + dis + '>' + esc(t('wk.cancel')) + '</button></div>';
    } else if (w.stage === 'dup') {
      h = '<h3 id="wk_h">' + esc(t('wk.dupT')) + '</h3><p>' + esc(t('wk.dupB')) + '</p>' +
        '<ul class="dups">' + (w.dup || []).map(d => '<li><span class="token sm">' + esc(d.tok) + '</span>' + MT.chip(d.st) + '</li>').join('') + '</ul>' +
        '<p><b>' + esc(MT.short(w.name)) + '</b></p>' +
        '<div class="sheet-actions"><button class="btn primary" data-a="wkConfirm"' + dis + '>' + esc(t(w.busy ? 'wk.busy' : 'wk.dupGo')) + '</button><button class="btn ghost" data-a="wkClose"' + dis + '>' + esc(t('wk.cancel')) + '</button></div>';
    } else if (w.stage === 'uncertain') {
      h = '<h3 id="wk_h">' + esc(t('wk.unT')) + '</h3><div class="notice warn" role="alert">' + MT.icon('lock', 20) + '<span>' + esc(t('wk.unB')) + '</span></div>' +
        '<div class="sheet-actions"><button class="btn primary" data-a="wkRetry"' + dis + '>' + esc(t(w.busy ? 'wk.busy' : 'wk.retry')) + '</button><button class="btn ghost" data-a="wkClose"' + dis + '>' + esc(t('close')) + '</button></div>';
    } else {
      const info2 = S.findSession(w.rkey || w.key), e = w.entry;
      h = '<h3 id="wk_h">' + esc(t(w.reprint ? 'wk.reprintT' : 'wk.okT')) + '</h3><p>' + esc(t(w.reprint ? 'wk.reprintB' : w.replayed ? 'wk.replayed' : 'wk.okB')) + '</p>' +
        '<div class="ticket"><div class="tk-top"><div><span class="lab">' + esc(t('rc.token')) + '</span><div class="token big">' + esc(e.tok) + '</div></div></div><div class="tk-div"></div>' +
        '<div class="tk-bot"><div class="main"><b>' + esc(info2 ? MT.loc(info2.session) : '') + '</b><span>' + esc(info2 ? MT.loc(info2.clinic) + ' · ' + t('room', { n: info2.session.room }) : '') + '</span><span>' + esc(MT.short(e.name)) + ' · ' + esc(whenText(e.at)) + '</span></div></div></div>' +
        '<div class="sheet-actions"><button class="btn primary" data-a="wkPrint">' + esc(t('wk.print')) + '</button><button class="btn ghost" data-a="wkClose">' + esc(t('wk.done')) + '</button></div>';
    }
    return '<div class="sheet-wrap" data-a="wkBackdrop" data-k="wk"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="wk_h" data-a="noop" data-wk="' + w.stage + '">' + h + '</div></div>';
  }
  /* One registration attempt = one walkSend at a time (w.busy), each tagged with w.seq. A result is applied only if its walk is still the open one AND no newer request has
     been started for it, so a late answer can never overwrite a newer one. An answer is classified by S.assisted; ONLY an answer that carries the created entry shows success. */
  async function walkSend(confirm) {
    const w = P.walk; if (!w || w.busy) return;                         // a request is already in flight: repeated clicks / Enter do nothing
    if (w.stage === 'form') { const e = nameErr(w.name); if (e) { w.err = e; return render(); } if (!w.rid) w.rid = newRid(); }
    const seq = w.seq = (w.seq || 0) + 1;
    w.busy = true; w.err = ''; w.errCode = ''; w.confirm = confirm === true; w.name = cleanName(w.name); render();
    let r; try { r = await S.assisted(w.key, w.name, w.rid, w.confirm); } catch (e) { r = { uncertain: true }; }
    if (P.walk !== w || w.seq !== seq) return;                          // the sheet was ended (signed out) or a newer request owns it
    w.busy = false;
    if (r && r.ok === true && r.entry && typeof r.entry.tok === 'string' && typeof r.entry.id === 'string') { w.stage = 'done'; w.entry = r.entry; w.rkey = r.key || w.key; w.replayed = !!r.replayed; w.reprint = false; }
    else if (r && r.err === 'dupWarn') { w.stage = 'dup'; w.dup = Array.isArray(r.dup) ? r.dup : []; }   // nothing was created; the same rid is kept for the explicit confirmation
    else if (r && typeof r.err === 'string') { w.stage = 'form'; w.err = ERRKEY[r.err] || 'wk.errGeneric'; w.errCode = ERRKEY[r.err] ? '' : r.err; w.rid = null; w.confirm = false; }   // refused: nothing exists under this rid
    else { w.stage = 'uncertain'; }                                                 // no trustworthy answer: keep rid, never claim success
    safeRender(w); focusWalk();
  }
  // A failure while drawing must never hide a confirmed registration: fall back to a plain confirmation with the token.
  function safeRender(w) {
    try { render(); } catch (e) {
      if (typeof console !== 'undefined' && console.error) console.error('walk-in render failed', e);
      try { if (w.stage === 'done' && w.entry) el().innerHTML = '<div class="ph-body"><p class="err" role="alert">' + esc(t('wk.okT')) + ' · ' + esc(w.entry.tok) + '</p></div>'; } catch (x) { /* nothing more to do */ }
    }
  }  function focusWalk() { setTimeout(() => { const n = document.querySelector('[data-wk] input, [data-wk] .btn.primary'); if (n && n.focus) n.focus(); }, 0); }
  function wrap(dark, top, body, foot) {
    const tt = P.toast ? '<div class="toast" role="status" data-k="toast" data-s="' + esc(t(P.toast.k, P.toast.p)) + '" data-m="mt-swap">' + esc(t(P.toast.k, P.toast.p)) + '</div>' : '';
    return MT.sb(dark) + top + '<div class="ph-body">' + body + '</div>' + (foot ? '<div class="ph-foot">' + foot + '</div>' : '') + MT.hb() + sheetHtml() + walkHtml() + tt;
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
    return '<div class="qrow' + (o.cls ? ' ' + o.cls : '') + '" data-k="row:' + esc(e.id) + '" data-s="' + ds + '" data-f="1" data-flip="1"><div class="main"><div class="tk"><span class="token sm">' + esc(e.tok) + '</span><span class="nm">' + esc(who(e)) + '</span></div>' + '<div class="cl">' + MT.chip(e.st, o.chipKey, '', ' data-k="rc:' + esc(e.id) + '" data-s="' + ds + '" data-m="mt-pop"') + (o.link || '') + (e.src === 'staff' && validAt(e.at) && S.ACTIVE.includes(e.st) ? L('reprint', e.id, 'a.reprint') : '') + '</div>' + (o.note ? '<div class="note">' + esc(o.note) + '</div>' : '') + (o.html || '') + '</div>' + (o.acts ? '<div class="acts">' + o.acts + '</div>' : '') + '</div>';
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
      '<button class="btn forest block wk-open" data-a="openWalk">' + MT.icon('plus', 18) + esc(t('wk.open')) + '</button>' +
      '<div class="lanes2" role="group">' + tabBtn('queue', 'q.tabQueue') + tabBtn('return', 'q.tabReturn', cnt.late + cnt.ret) + tabBtn('fin', 'q.tabFin') + '</div>' +
      '<div data-k="list:' + P.tab + '">' + list + '</div>' +
      '<button class="morebtn" data-a="toggleMore" aria-expanded="' + !!P.more + '"><span>' + esc(t('q.tools')) + '</span>' + MT.icon(P.more ? 'up' : 'down', 18) + '</button>' +
      (P.more ? '<div data-k="more"><p class="demo-tag amber" style="margin:6px 0 2px">' + esc(t('q.live')) + '</p><p class="muted sm">' + esc(t('q.privacy')) + '</p><button class="btn ghost block' + (isAdmin ? '' : ' locked') + '" data-a="reset">' + MT.icon(isAdmin ? 'x' : 'lock', 18) + esc(t('q.reset')) + '</button>' +
      '<button class="btn ghost block" data-a="closeSession">' + MT.icon('grid', 18) + esc(t('q.switch')) + '</button>' +
      (log ? lbl('q.recent', 'line') + '<ul class="logl">' + log + '</ul>' : '') + '</div>' : ''), foot);
  }

  function render() {
    const st = S.get();
    /* The walk-in sheet outlives a change of the selected session: the server pushes a new epoch whenever the shared demo is reset (anyone can do that), which
       drops every browser's selected session while a registration may be in flight or already confirmed. Dropping the sheet then would lose the answer to a request
       that DID create a token. So only signing out ends it, plus an untouched form/duplicate prompt whose session is gone (nothing is pending or created there). */
    if (P.walk && (!st.staff.role || (st.staff.sess !== P.walk.key && !P.walk.busy && (P.walk.stage === 'form' || P.walk.stage === 'dup')))) P.walk = null;
    let html, key, rank;
    if (!st.staff.role) { P.sheet = null; html = login(); key = 'login'; rank = 0; }
    else if (!st.staff.sess) { html = sessions(); key = 'sessions'; rank = 1; }
    else { html = queue(); key = 'queue:' + st.staff.sess; rank = 2; }
    const dir = lastRank == null ? 0 : Math.sign(rank - lastRank); lastRank = rank;
    MT.renderInto(el(), html, { key, dir });
    renderReceipt();
  }

  const H = {
    lang: v => MT.setLang(v), noop: () => {},
    sheetClose: (v, b) => { if (b.classList.contains('sheet-wrap') || b.classList.contains('btn')) { P.sheet = null; sheetFn = null; render(); } },
    sheetOk: () => { const f = sheetFn; P.sheet = null; sheetFn = null; render(); if (f) f(); },
    input: (n, v) => { if (n === 'user') P.user = v; else if (n === 'pw') P.pw = v; else if (n === 'wkname' && P.walk && P.walk.stage === 'form' && !P.walk.busy) { P.walk.name = v; if (P.walk.err) { P.walk.err = ''; const x = document.getElementById('wk_err'); if (x && x.remove) x.remove(); const i = document.getElementById('wk_name'); if (i) i.removeAttribute('aria-invalid'); } } },
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
    openWalk: () => {
      if (P.walk) return;                                                                          // one registration sheet at a time (a second one could never replace a request in flight)
      const key = S.get().staff.sess;
      if (!key || !S.staffSessions().some(x => x.key === key)) return toast('serr.forbidden');   // only a session this staff member may use and that is open
      P.walk = { stage: 'form', key, name: '', rid: null, confirm: false, busy: false, err: '', dup: [], entry: null }; render(); focusWalk();
    },
    wkSubmit: () => { if (P.walk && P.walk.stage === 'form') walkSend(false); },
    wkConfirm: () => { if (P.walk && P.walk.stage === 'dup') walkSend(true); },
    wkRetry: () => { if (P.walk && P.walk.stage === 'uncertain') walkSend(P.walk.confirm); },       // same rid, same confirm flag as the attempt in doubt
    wkBackdrop: (v, b, e) => { if (e && e.target === b && P.walk && !P.walk.busy && P.walk.stage !== 'uncertain') H.wkClose(); },
    wkClose: () => {
      const w = P.walk; if (!w || w.busy) return;
      P.walk = null; render();
      if (w.stage === 'uncertain') toast('wk.checkQueue');
    },
    wkPrint: () => { renderReceipt(); if (typeof window.print === 'function') window.print(); },
    reprint: v => {                                                                                 // an existing, server-authorised queue entry: no request, no token
      const r = S.byId(v); if (!r || r.e.src !== 'staff' || !validAt(r.e.at)) return toast('serr.state');
      P.walk = { stage: 'done', reprint: true, key: r.key, rkey: r.key, entry: { id: r.e.id, tok: r.e.tok, name: r.e.name, st: r.e.st, at: r.e.at, rby: r.e.rby }, busy: false }; render(); focusWalk();
    },
    reset: () => {
      if (S.get().staff.role !== 'admin') return confirmSheet({ title: 'cf.resetBlockedT', body: 'cf.resetBlockedB' }, null);
      const key = S.get().staff.sess;
      confirmSheet({ title: 'cf.resetT', body: 'cf.resetB', ok: 'q.reset', danger: true }, () => act(S.resetQueue(key), { k: 'toast.reset' }));
    }
  };

  document.addEventListener('DOMContentLoaded', () => {
    MT.bind(el(), H);
    el().addEventListener('keydown', e => {                                                         // Escape closes the walk-in sheet; Tab stays inside it (it is modal)
      if (!P.walk) return;
      if (e.key === 'Escape') { H.wkClose(); return; }
      if (e.key === 'Tab') { const f = [].slice.call(el().querySelectorAll('.sheet button:not([aria-disabled="true"]), .sheet input')); if (!f.length) return; const i = f.indexOf(document.activeElement); if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
    });
    MT.rerenders.push(render); S.subscribe(render); render();
  });
  MT.staff = { P, render, H, receiptHtml, nameErr, cleanName };
})();
