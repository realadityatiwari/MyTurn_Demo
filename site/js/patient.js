/* MyTurn demo — Patient frame. Reads/writes only through MT.store. */
(function () {
  'use strict';
  const MT = window.MT, S = MT.store, t = (k, p) => MT.t(k, p), esc = MT.esc;
  const el = () => document.getElementById('pf');
  const AUTHED = ['home', 'patients', 'visits', 'account', 'pform', 'search', 'fac', 'whofor', 'review', 'success', 'visit'];
  const RELS = ['Myself', 'Father', 'Mother', 'Spouse', 'Child', 'Other'];

  const P = {
    screen: 'launch', hist: [], mode: 'signup', phone: '', consent: false, phoneErr: '',
    otp: '', otpErr: '', tries: 0, resends: 0,
    form: { id: null, name: '', rel: 'Myself', yob: '' }, formErr: '', formFrom: 'patients',
    search: '', fac: null, sess: null, who: null, visit: null,
    sheet: null, toast: null, submitting: false, regErr: ''
  };
  let sheetFn = null, toastTimer = null, lastKey = null, lastDepth = 0, lastSt = null;
  const dirReset = () => {};

  const go = s => { P.hist.push(P.screen); P.screen = s; render(); };
  const back = () => { P.screen = P.hist.pop() || 'home'; render(); };
  const tab = s => { P.hist = []; P.screen = s; render(); };
  const toast = k => { P.toast = k; render(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { P.toast = null; render(); }, 2800); };
  const errKey = e => ({ offline: 'err.offline', closed: 'err.closed', dup: 'err.dup', limit: 'err.limit', name: 'err.name', yob: 'err.yob', state: 'err.state', noProfile: 'err.state', auth: 'err.state', gone: 'err.state' }[e] || 'err.state');
  const confirmSheet = (o, fn) => { P.sheet = o; sheetFn = fn; render(); };

  /* ---------- shell pieces ---------- */
  const backBtn = () => '<button class="icon-btn" data-a="back" aria-label="' + esc(t('back')) + '">' + MT.icon('back', 24) + '</button>';
  const subTop = (title, lang) => '<header class="ph-top sub">' + backBtn() + '<h2 class="ph-title">' + esc(title) + '</h2>' + (lang ? MT.langToggle() : '') + '</header>';
  function homeTop() {
    const st = S.get(), p = S.profiles().find(x => x.id === st.patient.sel);
    return '<header class="ph-top home"><span class="wordmark">' + MT.logo(26, '#0F3D2E') + '<span>MyTurn</span></span>' +
      '<button class="avatar" data-a="tab" data-v="account" aria-label="' + esc(t('tab.account')) + '">' + (p ? esc(MT.initials(MT.nm(p.name))) : MT.icon('user', 20)) + '</button></header>';
  }
  function tabs() {
    const on = P.screen;
    const b = (id, ic, k) => '<button data-a="tab" data-v="' + id + '" class="' + (on === id ? 'on' : '') + '" aria-current="' + (on === id ? 'page' : 'false') + '"><span class="pill">' + MT.icon(ic, 22) + '</span><span>' + esc(t(k)) + '</span></button>';
    return '<nav class="ph-tabs" aria-label="' + esc(t('nav.main')) + '">' + b('home', 'home', 'tab.home') + b('patients', 'users', 'tab.patients') + b('visits', 'clock', 'tab.visits') + b('account', 'user', 'tab.account') + '</nav>';
  }
  function sheetHtml() {
    const s = P.sheet; if (!s) return '';
    return '<div class="sheet-wrap" data-a="sheetClose" data-k="sheet"><div class="sheet" role="dialog" aria-modal="true" data-a="noop">' +
      '<h3>' + esc(t(s.title)) + '</h3><p>' + esc(t(s.body)) + '</p>' +
      '<div class="sheet-actions">' + (s.ok ? '<button class="btn ' + (s.danger ? 'danger' : 'primary') + '" data-a="sheetOk">' + esc(t(s.ok)) + '</button>' : '') +
      '<button class="btn ghost" data-a="sheetClose">' + esc(t(s.ok ? 'cancel.no' : 'close')) + '</button></div></div></div>';
  }
  function frame(top, body, o) {
    o = o || {};
    const st = S.get();
    return MT.sb(false) + top +
      '<div class="ph-body">' + (!st.net ? note('offline.banner', 'warn', 'wifi') : '') + body + '</div>' +
      (o.foot ? '<div class="ph-foot">' + o.foot + '</div>' : '') + (o.tabs ? tabs() : '') + MT.hb() +
      sheetHtml() + (P.toast ? '<div class="toast" role="status" data-k="toast" data-s="' + esc(t(P.toast)) + '" data-m="mt-swap">' + esc(t(P.toast)) + '</div>' : '');
  }
  const field = (id, label, val, o) => { o = o || {}; return '<label class="fld" for="' + id + '"><span>' + esc(t(label)) + '</span><input id="' + id + '" data-i="' + id + '" ' + (o.enter ? 'data-enter="' + o.enter + '" ' : '') + 'value="' + esc(val) + '" ' + (o.attrs || '') + '></label>'; };
  const note = (k, cls, ic) => '<div class="notice ' + (cls || '') + '">' + MT.icon(ic || 'info', 20) + '<span>' + esc(t(k)) + '</span></div>';
  const demoTag = (k, cls) => '<p class="demo-tag ' + (cls || '') + '">' + esc(t(k)) + '</p>';
  const errRow = k => k ? '<p class="err">' + MT.icon('x', 16) + esc(t(k)) + '</p>' : '';
  const lbl = (k, cls) => '<span class="lbl ' + (cls || '') + '">' + esc(t(k)) + '</span>';
  const sline = (cls, glyph, title, small) => '<div class="sline ' + cls + '" data-k="sline" data-s="' + cls + title + '" data-m="mt-swap"><span class="g" aria-hidden="true">' + glyph + '</span><span>' + esc(t(title)) + (small ? '<small>' + esc(t(small.k, small.p)) + '</small>' : '') + '</span></div>';
  const btn = (a, v, k, cls, extra) => '<button class="btn ' + (cls || 'primary') + ' block" data-a="' + a + '"' + (v !== undefined && v !== null ? ' data-v="' + esc(v) + '"' : '') + (extra || '') + '>' + esc(t(k)) + '</button>';

  /* ---------- tickets ---------- */
  function ticket(v, full) {
    const e = v.e, info = S.findSession(v.key), p = S.profiles().find(x => x.id === e.pid), rel = p ? ' (' + t('rel.' + p.rel) + ')' : '';
    const top = '<div class="tk-top"><div><span class="lab">' + esc(t('v.yourToken')) + '</span><div class="token' + (full ? ' big' : '') + '">' + esc(e.tok) + '</div></div>' + MT.chip(e.st, null, '', ' data-k="chip:' + esc(e.id) + '" data-s="' + e.st + '" data-m="mt-pop"') + '</div>';
    const bot = '<div class="tk-bot"><div class="main"><b>' + esc(MT.loc(info.session)) + '</b><span>' + esc(MT.loc(info.clinic)) + ' · ' + esc(MT.lang === 'hi' ? info.session.hours[1] : info.session.hours[0]) + '</span><span>' + esc(t('v.for')) + ' <b style="display:inline">' + esc(MT.nm(e.name)) + rel + '</b></span>' + '' + '</div>' + (full ? '' : '<span class="chev">' + MT.icon('chev', 22) + '</span>') + '</div>';
    const inner = top + '<div class="tk-div"></div>' + bot;
    return full ? '<div class="ticket">' + inner + '</div>' : '<button class="ticket" data-a="openVisit" data-v="' + esc(e.id) + '" data-k="tk:' + esc(e.id) + '" data-s="' + e.st + '" data-f="1">' + inner + '</button>';
  }

  /* ---------- screens ---------- */
  function launch() {
    return MT.sb(false) +
      '<div class="launch"><div class="logo-big"><span class="wordmark">' + MT.logo(28, '#0F3D2E') + '<span>MyTurn</span></span>' + MT.langToggle() + '</div>' +
      '<h1 class="h1" style="margin-top:28px">' + esc(t('tagline')) + '</h1><p class="muted">' + esc(t('launch.sub')) + '</p>' +
      '<ol class="path intro"><li><span class="dot"></span><span>' + esc(t('launch.step1')) + '</span></li><li><span class="dot"></span><span>' + esc(t('launch.step2')) + '</span></li><li><span class="dot"></span><span>' + esc(t('launch.step3')) + '</span></li></ol>' +
      btn('start', 'signup', 'launch.signup', 'primary') + btn('start', 'signin', 'launch.signin', 'ghost') +
      '<span class="lbl line" style="margin-top:28px">' + esc(t('launch.team')) + '</span>' +
      '<button class="team" data-a="toStaff"><span class="sq">' + MT.icon('shield', 18) + '</span><span class="main"><b>' + esc(t('launch.staff')) + '</b><span>' + esc(t('launch.staffSub')) + '</span></span>' + MT.icon('chev', 20) + '</button>' +
      '<p class="demo-tag" style="margin-top:12px">' + esc(t('launch.works')) + '</p>' + demoTag('demo.phoneHint') + '</div>' + MT.hb() + (P.toast ? '<div class="toast" role="status" data-k="toast" data-s="' + esc(t(P.toast)) + '" data-m="mt-swap">' + esc(t(P.toast)) + '</div>' : '');
  }
  function phone() {
    return frame(subTop(t(P.mode === 'signup' ? 'launch.signup' : 'launch.signin'), true),
      '<h1 class="h1">' + esc(t('phone.title')) + '</h1><p class="muted">' + esc(t('phone.sub')) + '</p>' +
      field('phone', 'phone.label', P.phone, { enter: 'sendCode', attrs: 'inputmode="numeric" maxlength="10" autocomplete="off" placeholder="' + esc(t('phone.ph')) + '"' }) + errRow(P.phoneErr) +
      '<label class="chk"><input type="checkbox" data-i="consent" ' + (P.consent ? 'checked' : '') + '><span>' + esc(t('phone.consent')) + '</span></label>' + demoTag('demo.otpOnly'),
      { foot: btn('sendCode', null, 'phone.send', 'primary') });
  }
  function otp() {
    const locked = P.tries >= 5;
    return frame(subTop(t('otp.title'), true),
      '<h1 class="h1">' + esc(t('otp.title')) + '</h1><p class="muted">' + esc(t('otp.sent')) + ' +91 ••••• ••' + esc(P.phone.slice(-3)) + ' · <button class="link" data-a="back">' + esc(t('otp.wrong')) + '</button></p>' +
      field('otp', 'otp.label', P.otp, { enter: 'verify', attrs: 'inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="••••••"' + (locked ? ' disabled' : '') }) + errRow(P.otpErr) +
      btn('resend', null, P.resends >= 3 ? 'otp.limit' : 'otp.resend', 'ghost', P.resends >= 3 ? ' aria-disabled="true"' : '') + demoTag('demo.otpCodes'),
      { foot: btn('verify', null, 'otp.verify', 'primary', locked ? ' disabled' : '') });
  }

  function home() {
    const st = S.get(), ps = S.profiles(), act = S.myVisits().filter(v => S.ACTIVE.includes(v.e.st));
    const strip = '<div class="strip">' + ps.map(p => '<button data-a="selProfile" data-v="' + p.id + '" class="' + (st.patient.sel === p.id ? 'on' : '') + '" aria-pressed="' + (st.patient.sel === p.id) + '"><span class="av">' + (st.patient.sel === p.id ? MT.icon('check2', 20) : esc(MT.initials(MT.nm(p.name)))) + '</span><span>' + esc(MT.nm(p.name.split(' ')[0])) + '</span></button>').join('') +
      (ps.length < S.MAX_PROFILES ? '<button class="add" data-a="addProfile"><span class="av">' + MT.icon('plus', 20) + '</span><span>' + esc(t('home.addShort')) + '</span></button>' : '') + '</div>';
    return frame(homeTop(),
      '<button class="searchbar" data-a="newVisit">' + MT.icon('search', 20) + '<span>' + esc(t('s.ph')) + '</span></button>' +
      '<div class="lbl-row">' + lbl('home.visitFor') + '<span class="lbl nocase"><b style="color:var(--ink)">' + esc(t('pat.ofShort', { n: ps.length, max: S.MAX_PROFILES })) + '</b> · <button class="link" data-a="tab" data-v="patients">' + esc(t('home.manage')) + '</button></span></div>' + strip +
      lbl('home.active') +
      (act.length ? act.map(v => ticket(v)).join('') : '<p class="empty">' + esc(t('home.empty')) + '</p>') +
      '<div class="lbl-row">' + lbl('home.clinics') + '<span class="lbl nocase"><button class="link" data-a="newVisit">' + esc(t('home.seeAll')) + '</button></span></div><div class="list">' + S.CLINICS.slice(0, 3).map(c => { const n = c.sessions.filter(s => s.st === 'open').length; return '<button class="li" data-a="pickFac" data-v="' + c.id + '"><span class="main"><span class="t block">' + esc(MT.loc(c)) + '</span><span class="s block">' + esc(t('s.area')) + '</span></span><span class="r">' + esc(t('s.open', { n })) + '</span><span class="chev">' + MT.icon('chev', 20) + '</span></button>'; }).join('') + '</div>', { tabs: true, foot: btn('newVisit', null, 'home.register', 'primary') });
  }

  function visits() {
    const all = S.myVisits(), act = all.filter(v => S.ACTIVE.includes(v.e.st)), past = all.filter(v => !S.ACTIVE.includes(v.e.st));
    const row = (a, b, c, chipHtml) => '<div class="li"><span class="main"><span class="t block">' + esc(a) + '</span><span class="s block">' + esc(b) + '</span></span>' + chipHtml + '</div>';
    return frame(homeTop(),
      '<h1 class="h2">' + esc(t('visits.title')) + '</h1>' + lbl('home.active') + (act.length ? act.map(v => ticket(v)).join('') : '<p class="empty">' + esc(t('home.empty')) + '</p>') +
      lbl('home.earlier') + '<div class="list">' +
      past.map(v => { const i = S.findSession(v.key); return row(MT.loc(i.session) + ' · ' + MT.loc(i.clinic), v.e.tok, '', MT.chip(v.e.st)); }).join('') +
      row(t('hist1.s'), '12 Oct · K 031', '', MT.chip('done')) + row(t('hist2.s'), '2 Sep · M 017', '', MT.chip('done')) + '</div>' + demoTag('home.retention'), { tabs: true, foot: btn('newVisit', null, 'home.register', 'primary') });
  }

  function patients() {
    const ps = S.profiles(), st = S.get(), full = ps.length >= S.MAX_PROFILES;
    const dupName = n => ps.filter(p => p.name.trim().toLowerCase() === n.trim().toLowerCase()).length > 1;
    const segs = '<div class="segs" style="grid-template-columns:repeat(' + S.MAX_PROFILES + ',1fr)" aria-hidden="true">' + Array.from({ length: S.MAX_PROFILES }, (_, i) => '<i class="' + (i < ps.length ? 'f' : '') + '"></i>').join('') + '</div>';
    return frame(homeTop(),
      '<div class="lbl-row" style="align-items:center"><h1 class="h2">' + esc(t('pat.title')) + '</h1><b>' + esc(t('pat.ofShort', { n: ps.length, max: S.MAX_PROFILES })) + '</b></div>' + segs +
      '<p class="muted sm">' + esc(t('pat.sub')) + '</p>' +
      (ps.length ? '<div class="list" style="margin-top:12px">' + ps.map(p => '<div class="li' + (st.patient.sel === p.id ? ' sel' : '') + '" data-k="prof:' + p.id + '" data-s="' + (st.patient.sel === p.id ? 1 : 0) + '" data-f="1"><button class="li" style="border:0;padding:0;min-height:0;flex:1;width:auto;background:none" data-a="selProfile" data-v="' + p.id + '" aria-pressed="' + (st.patient.sel === p.id) + '"><span class="av">' + (st.patient.sel === p.id ? MT.icon('check2', 18) : esc(MT.initials(MT.nm(p.name)))) + '</span><span class="main"><span class="t block">' + esc(MT.nm(p.name)) + '</span><span class="s block">' + esc(t('rel.' + p.rel)) + (p.yob ? ' · ' + esc(t('pat.age', { n: MT.age(p.yob) })) : '') + '</span>' + (dupName(p.name) ? MT.chipRaw('warn sm', '!', t('pat.dup')) : '') + '</span></button><button class="btn small ghost" data-a="editProfile" data-v="' + p.id + '">' + esc(t('pat.edit')) + '</button></div>').join('') + '</div>' : '<p class="empty">' + esc(t('pat.empty')) + '</p>') +
      (full ? note('pat.full', 'warn', 'warn') + '<p class="muted sm">' + esc(t('pat.fullNote')) + '</p>' : '') + demoTag('pat.minimal'),
      { tabs: true, foot: btn('addProfile', null, full ? 'pat.addLimit' : 'pat.add', 'primary', full ? ' aria-disabled="true"' : '') });
  }
  function pform() {
    const f = P.form;
    return frame(subTop(t(f.id ? 'pf.edit' : 'pf.add')),
      field('pf_name', 'pf.name', f.name, { attrs: 'maxlength="40" autocomplete="off"' }) +
      '<label class="fld" for="pf_rel"><span>' + esc(t('pf.rel')) + '</span><select id="pf_rel" data-c="rel">' + RELS.map(r => '<option value="' + r + '"' + (f.rel === r ? ' selected' : '') + '>' + esc(t('rel.' + r)) + '</option>').join('') + '</select></label>' +
      field('pf_yob', 'pf.yob', f.yob, { attrs: 'inputmode="numeric" maxlength="4" placeholder="1990"' }) + errRow(P.formErr) +
      (f.id ? '<div class="center"><button class="btn danger-link" data-a="delProfile">' + esc(t('pat.remove')) + '</button></div>' : '') + demoTag('pf.notAsked'),
      { foot: btn('saveProfile', null, 'pf.save', 'primary') });
  }

  function search() {
    const q = P.search.trim().toLowerCase();
    const list = S.CLINICS.filter(c => !q || c.en.toLowerCase().includes(q) || c.hi.includes(q));
    return frame(subTop(t('s.title')),
      '<label class="fld search" for="q"><span class="sr">' + esc(t('s.ph')) + '</span>' + MT.icon('search', 20) + '<input id="q" data-i="search" value="' + esc(P.search) + '" placeholder="' + esc(t('s.ph')) + '" autocomplete="off"></label>' +
      '<p class="demo-tag">' + esc(t('s.hint')) + '</p>' + lbl('s.illus', 'amber') +
      (list.length ? '<div class="list">' + list.map(c => { const n = c.sessions.filter(s => s.st === 'open').length; return '<button class="li" data-a="pickFac" data-v="' + c.id + '"><span class="main"><span class="t block">' + esc(MT.loc(c)) + '</span><span class="s block">' + esc(t('s.area')) + ' · ' + esc(t('s.open', { n })) + '</span></span><span class="chev">' + MT.icon('chev', 20) + '</span></button>'; }).join('') + '</div>' : '<p class="empty">' + esc(t('s.none')) + '</p>'));
  }
  function fac() {
    const c = S.CLINICS.find(x => x.id === P.fac);
    const SS = { open: ['ok', '✓', 'ss.open'], later: ['info', 'i', 'ss.later'], closed: ['neutral', '✕', 'ss.closed'], onsite: ['info', 'i', 'ss.onsite'] };
    return frame(subTop(t('fac.nav')),
      '<h1 class="h2">' + esc(MT.loc(c)) + '</h1><p class="muted sm">' + esc(t('s.area')) + '</p><h2 class="ph-title" style="margin:16px 0 4px;white-space:normal">' + esc(t('fac.today')) + '</h2><div class="list">' +
      c.sessions.map(s => { const m = SS[s.st], can = s.st === 'open'; return '<' + (can ? 'button data-a="pickSess" data-v="' + c.id + ':' + s.id + '"' : 'div aria-disabled="true"') + ' class="li' + (can ? '' : ' dim') + '"><span class="main"><span class="t block">' + esc(MT.loc(s)) + '</span><span class="s block">' + esc(MT.lang === 'hi' ? s.hours[1] : s.hours[0]) + '</span>' + MT.chipRaw(m[0] + ' sm', m[1], t(m[2])) + '</span>' + (can ? '<span class="chev">' + MT.icon('chev', 20) + '</span>' : '') + '</' + (can ? 'button' : 'div') + '>'; }).join('') + '</div>' +
      '<div class="rules"><b>' + esc(t('fac.rulesT')) + '</b><ul><li>' + esc(t('fac.r1')) + '</li><li>' + esc(t('fac.r2')) + '</li><li>' + esc(t('fac.r3')) + '</li></ul></div><p class="demo-tag">' + esc(t('fac.rule')) + '</p>');
  }
  function whofor() {
    const ps = S.profiles(), full = ps.length >= S.MAX_PROFILES;
    return frame(subTop(t('who.nav')),
      '<h1 class="h2">' + esc(t('who.title')) + '</h1><div class="list" style="margin-top:8px">' +
      ps.map(p => { const dup = S.activeVisitFor(p.id); return '<button class="li' + (P.who === p.id ? ' sel' : '') + (dup ? ' dim' : '') + '" ' + (dup ? 'aria-disabled="true"' : 'data-a="pickWho" data-v="' + p.id + '"') + '><span class="radio"></span><span class="main"><span class="t block">' + esc(MT.nm(p.name)) + '</span><span class="s block">' + esc(t('rel.' + p.rel)) + '</span>' + (dup ? '<span class="s block" style="color:var(--warn-ink);font-weight:700;font-size:12.5px">' + esc(t('who.dup')) + '</span>' : '') + '</span></button>'; }).join('') + '</div>' +
      '<button class="btn dashed block" data-a="addFromWho"' + (full ? ' aria-disabled="true"' : '') + '>' + MT.icon('plus', 18) + esc(t(full ? 'pat.addLimit' : 'who.addAnother')) + '</button>',
      { foot: btn('whoNext', null, 'continue', 'primary', P.who ? '' : ' disabled') });
  }
  function review() {
    const info = S.findSession(P.sess), p = S.profiles().find(x => x.id === P.who);
    if (!info || !p) { P.screen = 'home'; return home(); }
    return frame(subTop(t('rev.nav')),
      '<h1 class="h2">' + esc(t('rev.title')) + '</h1>' +
      '<div class="rv"><div><span class="k">' + esc(t('rev.clinic')) + '</span><div class="v">' + esc(MT.loc(info.clinic)) + '</div></div></div>' +
      '<div class="rv"><div><span class="k">' + esc(t('rev.session')) + '</span><div class="v">' + esc(MT.loc(info.session)) + '<small>' + esc(MT.lang === 'hi' ? info.session.hours[1] : info.session.hours[0]) + '</small></div></div><button class="btn small ghost" data-a="changeSess">' + esc(t('rev.change')) + '</button></div>' +
      '<div class="rv"><div><span class="k">' + esc(t('rev.patient')) + '</span><div class="v">' + esc(MT.nm(p.name)) + '<small>' + esc(t('rel.' + p.rel)) + '</small></div></div><button class="btn small ghost" data-a="changeWho">' + esc(t('rev.change')) + '</button></div>' +
      '<div class="rules" style="margin-top:16px"><b style="font-size:14px">' + esc(t('rev.next')) + '</b>' + esc(t('rev.body')) + '<span class="demo-tag amber block" style="margin-top:8px">' + esc(t('rev.note')) + '</span></div>' + errRow(P.regErr),
      { foot: btn('submit', null, P.submitting ? 'rev.sending' : 'rev.submit', 'primary', P.submitting ? ' disabled' : '') });
  }
  function success() {
    const r = S.byId(P.visit); if (!r) return home();
    const info = S.findSession(r.key), p = S.profiles().find(x => x.id === r.e.pid);
    return frame('<header class="ph-top"><span style="width:8px"></span></header>',
      '<div class="ok-mark">' + MT.icon('check2', 30) + '</div><h1 class="h2" style="margin-top:0">' + esc(t('suc.title')) + '</h1>' +
      '<div class="ticket"><div class="tk-top"><div><span class="lab">' + esc(t('v.yourToken')) + '</span><div class="token big">' + esc(r.e.tok) + '</div></div></div><div class="tk-div"></div><div class="tk-bot"><div class="main"><b>' + esc(MT.loc(info.session)) + ' · ' + esc(MT.loc(info.clinic)) + '</b><span>' + esc(t('v.for')) + ' ' + esc(MT.nm(r.e.name)) + (p ? ' (' + esc(t('rel.' + p.rel)) + ')' : '') + '</span></div></div></div>' +
      '<h2 class="ph-title" style="margin:16px 0 0;white-space:normal">' + esc(t('suc.next')) + '</h2><ol class="steps"><li><span class="n">1</span><span>' + esc(t('suc.n1', { clinic: MT.loc(info.clinic) })) + '</span></li><li><span class="n">2</span><span><b>' + esc(t('suc.n2b')) + '</b> ' + esc(t('suc.n2')) + '</span></li></ol>' +
      '<div class="center" style="margin-top:12px"><button class="link" data-a="tab" data-v="home">' + esc(t('suc.home')) + '</button></div>',
      { foot: btn('openVisit', r.e.id, 'suc.view', 'primary') });
  }

  function visit() {
    const r = S.byId(P.visit); if (!r) { P.screen = 'home'; return home(); }
    const e = r.e, info = S.findSession(r.key), list = r.list;
    const ahead = list.slice(0, list.indexOf(e)).filter(x => x.st === 'wait').length;
    const svcNow = list.find(x => x.st === 'svc');
    const wi = S.waitInfo(e.id);   // shared estimate (same function the Telegram bot uses)
    const eta = wi.code === 'est' ? (wi.lo === 0 ? t('v.estUpTo', { hi: wi.hi }) : t('v.estRange', { lo: wi.lo, hi: wi.hi })) : t('v.notShown');
    let cur = -1, doneTo = -1, lane = false;
    if (e.st === 'reg') { cur = 0; } else if (e.st === 'wait') { cur = 2; doneTo = 1; } else if (e.st === 'called') { cur = 3; doneTo = 2; } else if (e.st === 'svc' || e.st === 'done') { doneTo = 3; }
    else if (['missed', 'retreq', 'retq'].includes(e.st)) { lane = true; cur = { missed: 0, retreq: 1, retq: 2 }[e.st]; doneTo = cur - 1; }
    const keys = lane ? ['v.l1', 'v.l2', 'v.l3', 'v.l4'] : ['v.t1', 'v.t2', 'v.t3', 'v.t4'];
    const path = (cur >= 0 || doneTo >= 0) ? lbl(lane ? 'v.lane' : 'v.path') + '<ol class="path' + (lane ? ' lane' : '') + '">' + keys.map((k, i) => '<li class="' + (i === cur ? 'cur' : i <= doneTo ? 'done' : '') + '" data-k="path:' + i + '" data-s="' + (i === cur ? 'cur' : i <= doneTo ? 'done' : '') + '" data-m="mt-pop"><span class="dot">' + (i <= doneTo && i !== cur ? MT.icon('check2', 13) : '') + '</span><span>' + esc(t(k)) + '</span></li>').join('') + '</ol>' : '';
    const cancelLink = '<div class="center"><button class="btn danger-link" data-a="cancelVisit" data-v="' + esc(e.id) + '">' + esc(t('v.cancel')) + '</button></div>';
    let main = '', foot = '', extra = '';
    switch (e.st) {
      case 'reg': main = sline('info', 'i', 'v.reg'); extra = lbl('v.todo') + '<p>' + esc(t('v.todoReg')) + '</p><p class="muted sm">' + esc(t('v.checkinNote')) + ' ' + esc(t('v.estReg')) + '</p>' + cancelLink; foot = btn('checkIn', e.id, 'v.checkin', 'primary'); break;
      case 'wait':
        main = ahead === 0 ? sline('amber', '!', 'v.nextBanner') : sline('info', 'i', 'v.inQueue', { k: 'v.confirmed' });
        extra = '<div class="kv"><dt>' + esc(t('v.aheadLabel')) + '</dt><dd data-k="ahead" data-s="' + ahead + '" data-m="mt-tick">' + ahead + '</dd><dt>' + esc(t('v.waitTime')) + '</dt><dd data-k="eta" data-s="' + esc(eta) + '" data-m="mt-tick">' + esc(eta) + '</dd></div>' + (wi.code === 'est' ? '<p class="muted sm" style="margin-top:6px">' + esc(t('v.estNote', { avg: wi.avg })) + '</p>' : '') + (svcNow ? '<p class="muted sm" style="margin-top:8px">' + esc(t('v.inSvc', { tok: svcNow.tok })) + '</p>' : '') + lbl('v.todo') + '<p>' + esc(t('v.todoWait', { room: info.session.room })) + '</p>' + cancelLink; break;
      case 'called': main = sline('amber', '!', 'v.turn', { k: 'v.go', p: { room: info.session.room } }) + (e.cancelReq ? note('v.cancelReq', 'warn', 'info') : ''); extra = e.cancelReq ? '' : cancelLink; break;
      case 'svc': main = sline('ok', '✓', 'v.svc'); break;
      case 'done': main = sline('ok', '✓', 'v.done'); foot = btn('tab', 'home', 'done', 'primary'); break;
      case 'missed': main = sline('amber', '!', 'st.missed', { k: 'v.missed' }); foot = btn('reqReturn', e.id, 'v.reqReturn', 'primary') + btn('back', null, 'v.notNow', 'ghost'); extra = cancelLink; break;
      case 'retreq': main = sline('info', 'i', 'v.retreq', { k: 'v.noPlace' }); extra = cancelLink; break;
      case 'retq': main = sline('ok', '✓', 'v.retq', { k: 'v.noPlace' }); extra = cancelLink; break;
      case 'declined': main = sline('neutral', '—', 'v.declined'); break;
      case 'noshow': main = sline('neutral', '—', 'v.noshow'); break;
      case 'cancelled': main = sline('neutral', '—', e.note === 'staff' ? 'v.cancelledStaff' : 'v.cancelled'); break;
    }
    return frame(subTop(t('v.title')), ticket({ e, key: r.key }, true) + main + path + extra, { foot });
  }

  function account() {
    const ph = S.get().patient.phone || '';
    return frame(homeTop(),
      '<h1 class="h2">' + esc(t('acc.title')) + '</h1><div class="kv"><dt>' + esc(t('phone.label')) + '</dt><dd>+91 ••••• ••' + esc(ph.slice(-3)) + '</dd><dt>' + esc(t('acc.lang')) + '</dt><dd>' + MT.langToggle() + '</dd></div>' +
      btn('signout', null, 'acc.signout', 'ghost') + '<div class="center" style="margin-top:8px"><button class="btn danger-link" data-a="delData">' + esc(t('acc.delete')) + '</button></div>' + demoTag('acc.demo'), { tabs: true });
  }

  const SCREENS = { launch, phone, otp, home, patients, visits, pform, search, fac, whofor, review, success, visit, account };
  function render() {
    const st = S.get();
    // A demo reset / scenario switch replaces the whole state object: drop any half-finished sign-in.
    if (st !== lastSt) {
      if (lastSt && !st.patient.phone && (P.screen === 'phone' || P.screen === 'otp')) { P.screen = 'launch'; P.hist = []; P.phone = ''; P.otp = ''; P.phoneErr = ''; P.otpErr = ''; P.tries = 0; P.resends = 0; }
      lastSt = st;
    }
    if (!st.patient.phone && AUTHED.includes(P.screen)) { P.screen = 'launch'; P.hist = []; P.sheet = null; }
    if (st.patient.phone && ['launch', 'phone', 'otp'].includes(P.screen)) { P.screen = 'home'; P.hist = []; }
    if (P.screen === 'visit' && !S.byId(P.visit)) { P.screen = 'home'; }
    const key = P.screen === 'visit' ? 'visit:' + P.visit : P.screen, depth = P.hist.length;
    const dir = depth > lastDepth ? 1 : depth < lastDepth ? -1 : 0; if (key !== lastKey) { lastKey = key; lastDepth = depth; } else dirReset();
    MT.renderInto(el(), (SCREENS[P.screen] || launch)(), { key, dir });
  }

  /* ---------- actions ---------- */
  const H = {
    lang: v => MT.setLang(v), back, tab: v => tab(v), noop: () => {},
    sheetClose: (v, b) => { if (b.classList.contains('sheet-wrap') || b.classList.contains('btn')) { P.sheet = null; sheetFn = null; render(); } },
    sheetOk: () => { const f = sheetFn; P.sheet = null; sheetFn = null; render(); if (f) f(); },
    toStaff: () => { const s = document.getElementById('staff-col'); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); toast('toast.toStaff'); },
    start: v => { P.mode = v; P.phone = ''; P.consent = false; P.phoneErr = ''; go('phone'); },
    input: (n, v) => {
      if (n === 'phone') P.phone = v.replace(/\D/g, '');
      else if (n === 'otp') P.otp = v.replace(/\D/g, '');
      else if (n === 'consent') { P.consent = v; return; }
      else if (n === 'pf_name') P.form.name = v;
      else if (n === 'pf_yob') P.form.yob = v.replace(/\D/g, '');
      else if (n === 'search') { P.search = v; render(); return; }
      if (n === 'phone' || n === 'otp' || n === 'pf_yob') { const val = n === 'phone' ? P.phone : n === 'otp' ? P.otp : P.form.yob; const i = document.getElementById(n); if (i && i.value !== val) i.value = val; }
    },
    change: (n, v) => { if (n === 'rel') P.form.rel = v; },
    sendCode: () => {
      if (!/^\d{10}$/.test(P.phone)) { P.phoneErr = 'err.phone'; return render(); }
      if (!P.consent) { P.phoneErr = 'err.consent'; return render(); }
      P.phoneErr = ''; P.otp = ''; P.otpErr = ''; P.tries = 0; P.resends = 0; go('otp');
    },
    verify: () => {
      if (P.tries >= 5) return;
      if (!/^\d{6}$/.test(P.otp)) { P.otpErr = 'err.otpLen'; return render(); }
      if (P.otp === '111111') { P.otpErr = 'err.otpExpired'; return render(); }
      if (P.otp === '000000') { P.tries++; P.otpErr = P.tries >= 5 ? 'err.otpLocked' : 'err.otpWrong'; return render(); }
      S.patientSignIn(P.phone); P.hist = []; P.screen = 'home'; P.otp = ''; render();
    },
    resend: () => { if (P.resends >= 3) return; P.resends++; P.otpErr = ''; P.otp = ''; toast('otp.new'); },

    openVisit: v => { P.visit = v; P.hist = P.screen === 'success' ? [] : P.hist.concat(P.screen === 'visit' ? [] : [P.screen]); P.screen = 'visit'; render(); },
    newVisit: () => { P.search = ''; go('search'); },
    pickFac: v => { P.fac = v; go('fac'); },
    pickSess: v => { P.sess = v; P.who = null; P.regErr = ''; if (!S.profiles().length) { P.form = { id: null, name: '', rel: 'Myself', yob: '' }; P.formErr = ''; P.formFrom = 'whofor'; go('pform'); } else { const st = S.get(), sel = S.profiles().find(p => p.id === st.patient.sel && !S.activeVisitFor(p.id)) || S.profiles().find(p => !S.activeVisitFor(p.id)); P.who = sel ? sel.id : null; go('whofor'); } },
    pickWho: v => { P.who = v; render(); },
    addFromWho: () => { if (S.profiles().length >= S.MAX_PROFILES) return toast('err.limit'); P.form = { id: null, name: '', rel: 'Other', yob: '' }; P.formErr = ''; P.formFrom = 'whofor'; go('pform'); },
    whoNext: () => { if (!P.who) return; P.regErr = ''; go('review'); },
    changeSess: () => { P.screen = 'fac'; P.hist = ['home', 'search']; render(); },
    changeWho: () => { P.screen = 'whofor'; P.hist = ['home', 'search', 'fac']; render(); },
    submit: () => {
      if (P.submitting) return; // extra taps are ignored — one entry only
      P.submitting = true; P.regErr = ''; render();
      setTimeout(() => {
        const r = S.register(P.sess, P.who); P.submitting = false;
        if (r.err) { P.regErr = errKey(r.err); return render(); }
        P.visit = r.e.id; P.hist = []; P.screen = 'success'; render();
      }, 700);
    },
    checkIn: v => { const r = S.checkIn(v); if (r.err) { toast(r.err === 'offline' ? 'err.checkOffline' : errKey(r.err)); } },
    cancelVisit: v => { const r = S.byId(v); const called = r && r.e.st === 'called'; confirmSheet({ title: 'cancel.title', body: called ? 'cancel.bodyCalled' : 'cancel.body', ok: 'cancel.yes', danger: true }, () => { const x = S.patientCancel(v); if (x.err) toast(x.err === 'offline' ? 'err.cancelOffline' : errKey(x.err)); else if (x.requested) toast('toast.cancelReq'); else toast('toast.cancelled'); }); },
    reqReturn: v => { const x = S.requestReturn(v); if (x.err) toast(errKey(x.err)); else toast('toast.retSent'); },

    addProfile: () => { if (S.profiles().length >= S.MAX_PROFILES) return toast('err.limit'); P.form = { id: null, name: '', rel: 'Myself', yob: '' }; P.formErr = ''; P.formFrom = P.screen === 'patients' ? 'patients' : 'home'; go('pform'); },
    editProfile: v => { const p = S.profiles().find(x => x.id === v); P.form = { id: p.id, name: p.name, rel: p.rel, yob: p.yob ? String(p.yob) : '' }; P.formErr = ''; P.formFrom = 'patients'; go('pform'); },
    selProfile: v => S.selectProfile(v),
    saveProfile: () => {
      const r = S.saveProfile(P.form); if (r.err) { P.formErr = errKey(r.err); return render(); }
      const was = P.form.id; P.formErr = '';
      if (P.formFrom === 'whofor' && !was) { const ps = S.profiles(); P.who = ps[ps.length - 1].id; if (P.hist.pop() === 'fac') P.hist.push('fac'); P.screen = 'whofor'; render(); }
      else back();
    },
    delProfile: () => { const id = P.form.id; confirmSheet({ title: 'pat.removeTitle', body: 'pat.removeBody', ok: 'pat.remove', danger: true }, () => { S.deleteProfile(id); P.screen = 'patients'; P.hist = []; toast('toast.removed'); }); },
    signout: () => { S.patientSignOut(); P.hist = []; P.screen = 'launch'; render(); },
    delData: () => confirmSheet({ title: 'acc.delTitle', body: 'acc.delBody', ok: 'acc.delSend' }, () => toast('toast.delSent'))
  };

  document.addEventListener('DOMContentLoaded', () => {
    MT.bind(el(), Object.assign({}, H));
    MT.rerenders.push(render); S.subscribe(render); render();
  });
  MT.patient = { P, render };
})();
