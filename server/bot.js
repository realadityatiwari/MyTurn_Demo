/* MyTurn demo — Telegram bot (long polling, zero dependencies, Node 18+ built-in fetch).
   Every queue operation goes through the SAME store.js rules the website uses (via app.runAs),
   so a Telegram token is a real entry in the shared queue the Staff screen shows.
   A Telegram user is stored as account "tg:<telegram user id>" and can only ever read their own entries.
   Registration is remote only: status 'reg' (NOT checked in) until staff mark the patient as arrived. */
'use strict';

function start({ app, token, apiBase, log = console.log, mode = 'polling', secret }) {
  const { S, runAs } = app;
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) { console.error('Telegram bot: TELEGRAM_BOT_TOKEN is malformed (expected "<digits>:<secret>"). Bot not started; website unaffected.'); return { stop() {} }; }
  const redact = s => { let t = String(s).split(token).join('<token>'); if (secret) t = t.split(secret).join('<secret>'); return t; };
  const isStorage = e => (app.isStorageError ? app.isStorageError(e) : false) || (e && e.message === 'storage unavailable');
  const validId = n => Number.isSafeInteger(n) && n > 0;
  let running = true, offset = 0, abort = null;
  const dupUpdate = id => !app.markUpdate(id);              // persisted (SQLite) duplicate-delivery guard: survives restarts

  async function tg(method, body, timeoutMs = 15000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    if (method === 'getUpdates') abort = ctl;
    try {
      const res = await fetch(apiBase + '/bot' + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal });
      const j = await res.json().catch(() => ({}));
      if (!j.ok) { const e = new Error('Telegram ' + method + ' failed: ' + (j.description || res.status)); e.code = j.error_code; e.retry = j.parameters && j.parameters.retry_after; throw e; }
      return j.result;
    } catch (e) { e.message = redact(e.message); throw e; } finally { clearTimeout(t); }
  }
  const send = (chat, text, kb) => tg('sendMessage', { chat_id: chat, text, reply_markup: kb ? { inline_keyboard: kb } : undefined })
    .catch(e => log('send failed:', e.message));            // a failed message never affects the queue

  // ---- content ----
  const MENU = [[{ text: 'Register for a visit', callback_data: 'menu:reg' }, { text: 'My token', callback_data: 'menu:token' }],
                [{ text: 'Queue status', callback_data: 'menu:status' }, { text: 'Help', callback_data: 'menu:help' }]];
  const WELCOME = 'Welcome to MyTurn.\nI help you register for a clinic visit and follow your turn.\n\nThis is a hackathon prototype with sample clinics. Choose an option below.';
  const HELP = 'MyTurn commands\n/register – register for a clinic visit\n/token – show your token\n/status – show your current visit status\n/help – this message\n\n' +
    'How it works: registering here gives you a token but does NOT put you in the waiting queue. You join the queue only when you check in at the clinic on the day: tell reception you have arrived and staff will mark you as arrived.\n\n' +
    'No waiting time is shown, because it cannot be predicted reliably.';
  const keyFor = id => 'tg:' + id;
  const cleanName = u => (([u.first_name, u.last_name].filter(Boolean).join(' ') || 'Telegram user').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40)) || 'Telegram user';

  function myEntries(userId) {
    const out = [], q = S.get().q, key = keyFor(userId);
    for (const k in q) q[k].forEach(e => { if (e.acct === key) out.push({ e, k, list: q[k] }); });
    return out;
  }
  function describe(v, withGuide) {
    const { e, k, list } = v, info = S.findSession(k), room = info.session.room;
    const head = 'Token: ' + e.tok + '\n' + info.session.en + ' – ' + info.clinic.en + '\nStatus: ';
    const ahead = list.slice(0, list.indexOf(e)).filter(x => x.st === 'wait').length;
    const T = {
      reg: ['Registered – not checked in yet', 'You are NOT in the waiting line yet. Check in at the clinic: tell reception you have arrived and staff will mark you as arrived.'],
      wait: ['Checked in – waiting', ahead === 0 ? 'You are next in line.' : 'Please stay near the waiting area.'],
      called: ['Your turn', 'Please go to Room ' + room + ' now.'],
      svc: ['In service', 'You are being seen now.'],
      done: ['Completed', 'Your visit is completed. Thank you.'],
      missed: ['Missed turn', 'You missed your turn. Please ask reception about next steps; your original place is not guaranteed.'],
      retreq: ['Return requested', 'Waiting for the clinic to review. No place or time can be shown.'],
      retq: ['Return accepted', 'Staff will call you when you are eligible. No place or time can be shown.'],
      declined: ['Cannot rejoin', 'Please ask reception about next steps.'],
      noshow: ['Marked as not arrived', 'Please ask reception if you still need to be seen.'],
      cancelled: ['Cancelled', 'This visit was cancelled.']
    }[e.st] || [e.st, ''];
    // Same shared calculation the website uses (S.waitInfo); estimate only for checked-in patients.
    const w = S.waitInfo(e.id);
    let est = '';
    if (w.code === 'est') est = '\nAhead of you: ' + w.ahead + '\nEstimated wait: ' + (w.lo === 0 ? 'up to about ' + w.hi : 'about ' + w.lo + '–' + w.hi) + ' min (approximate, from an average visit of ' + w.avg + ' min; not a guarantee)';
    else if (w.code === 'reg') est = '\nWaiting-time estimate: not available yet. It appears after you check in at the clinic.';
    return head + T[0] + est + (withGuide && T[1] ? '\n\n' + T[1] : '');
  }
  function showToken(chat, userId, guide) {
    const mine = myEntries(userId), active = mine.filter(v => S.ACTIVE.includes(v.e.st));
    const v = active[0] || mine[mine.length - 1];
    if (!v) return send(chat, 'You have no registration yet. Use /register to start.', MENU);
    return send(chat, (active[0] ? '' : 'No active visit. Your most recent visit:\n\n') + describe(v, guide), MENU);
  }
  function clinicButtons() {
    return S.CLINICS.filter(c => c.sessions.some(s => s.st === 'open')).map(c => [{ text: c.en, callback_data: 'c:' + c.id }]);
  }
  function sessionButtons(cid) {
    const c = S.CLINICS.find(x => x.id === cid); if (!c) return null;
    return c.sessions.filter(s => s.st === 'open').map(s => [{ text: s.en + ' (' + s.hours[0] + ')', callback_data: 's:' + c.id + ':' + s.id }]);
  }
  function openSession(cid, sid) { const i = S.findSession(cid + ':' + sid); return i && i.session.st === 'open' ? i : null; }

  function doRegister(chat, user, cid, sid, updateId) {
    const info = openSession(cid, sid); if (!info) return send(chat, 'That service is not available for registration.', MENU);
    const key = keyFor(user.id);
    let out;
    try { out = runAs({ patient: { phone: key, sel: null }, net: true }, () => {
      S.patientSignIn(key);
      if (!S.profiles().length) S.saveProfile({ name: cleanName(user), rel: 'Myself' });
      const pid = S.profiles()[0].id;
      return S.register(info.key, pid);
    }, { claim: updateId }).result; }   /* the update id is recorded as processed in the SAME database transaction as the registration */
    catch (e) { if (isStorage(e)) throw e; log('registration failed:', redact(e.message)); return send(chat, 'Sorry, I could not register you right now. Please try again in a moment.', MENU); }
    if (out && out.err === 'dup') { const a = myEntries(user.id).filter(v => S.ACTIVE.includes(v.e.st))[0]; return send(chat, 'You already have an active registration, so I did not create another.\n\n' + (a ? describe(a, true) : ''), MENU); }
    if (!out || out.err) return send(chat, 'Sorry, I could not register you right now. Please try again, or ask reception.', MENU);
    return send(chat, 'You are registered (remote registration).\n\nToken: ' + out.e.tok + '\n' + info.session.en + ' – ' + info.clinic.en + '\n\n' +
      'Next step: go to the clinic and check in. Registering here does NOT put you in the waiting queue – tell reception you have arrived and staff will mark you as arrived. Then use /status to follow your turn.', MENU);
  }

  // ---- update handling ----
  async function onMessage(m) {
    if (!m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot || !validId(m.from.id) || m.chat.id !== m.from.id) return;      // private chats only; the sender IS the chat
    const chat = m.chat.id, text = typeof m.text === 'string' ? m.text.trim().split(/\s+/)[0].split('@')[0].toLowerCase() : '';
    if (text === '/start') return send(chat, WELCOME, MENU);
    if (text === '/register') return send(chat, 'Which clinic or hospital?', clinicButtons());
    if (text === '/token') return showToken(chat, m.from.id, false);
    if (text === '/status') return showToken(chat, m.from.id, true);
    if (text === '/help') return send(chat, HELP, MENU);
    return send(chat, 'Sorry, I did not understand that. Use /help to see what I can do.', MENU);
  }
  async function onCallback(q, updateId) {
    tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    const m = q.message; if (!m || !m.chat || m.chat.type !== 'private' || !q.from || q.from.is_bot || !validId(q.from.id) || m.chat.id !== q.from.id) return;
    const chat = m.chat.id, d = typeof q.data === 'string' ? q.data.slice(0, 40) : '', p = d.split(':');
    if (d === 'menu:reg') return send(chat, 'Which clinic or hospital?', clinicButtons());
    if (d === 'menu:token') return showToken(chat, q.from.id, false);
    if (d === 'menu:status') return showToken(chat, q.from.id, true);
    if (d === 'menu:help') return send(chat, HELP, MENU);
    if (p[0] === 'c' && p.length === 2) { const b = sessionButtons(p[1]); return b ? send(chat, 'Which service or department?', b) : send(chat, 'Unknown clinic.', MENU); }
    if (p[0] === 's' && p.length === 3) {
      const i = openSession(p[1], p[2]); if (!i) return send(chat, 'That service is not available for registration.', MENU);
      return send(chat, 'Register for ' + i.session.en + ' at ' + i.clinic.en + '?\n\nThis is a remote registration: you get a token, but you are NOT in the waiting queue until you check in at the clinic.',
        [[{ text: 'Confirm registration', callback_data: 'ok:' + p[1] + ':' + p[2] }, { text: 'Cancel', callback_data: 'menu:help' }]]);
    }
    if (p[0] === 'ok' && p.length === 3) return doRegister(chat, q.from, p[1], p[2], updateId);
    return send(chat, 'Sorry, I did not understand that. Use /help.', MENU);
  }
  /* One entry point for BOTH transports (long polling and webhook). Returns:
       'ok'    processed (or deliberately ignored)        'dup'   this update_id was already processed, or is being processed right now
       'bad'   not a Telegram update                      'retry' storage failed: nothing was changed and nothing was recorded, so the caller
                                                                   must get Telegram to redeliver (HTTP 503 / unconfirmed offset)
     ATOMICITY: an update that changes the queue (registration) is recorded as processed INSIDE the same SQLite transaction as that change
     (runAs claim option). There is no "marked processed but not applied" state: a crash before the commit leaves neither (redelivery is
     processed); a crash after it leaves both (redelivery is a duplicate). Updates that change nothing (commands, rejected requests) are
     recorded afterwards; losing that record only means a harmless repeated reply. */
  const inflight = new Set();                                                       // concurrent deliveries of the same update id
  async function handle(u) {
    if (!u || typeof u !== 'object' || !Number.isSafeInteger(u.update_id) || u.update_id < 0) return 'bad';
    const id = u.update_id;
    if (inflight.has(id) || app.isProcessed(id)) return 'dup';
    inflight.add(id);
    try {
      if (u.message) await onMessage(u.message); else if (u.callback_query) await onCallback(u.callback_query, id);
      app.markUpdate(id);                                                           // no-op when the queue transaction already recorded it
      return 'ok';
    } catch (e) {
      if (isStorage(e)) { log('storage unavailable while handling an update; Telegram will redeliver it'); return 'retry'; }   // nothing was claimed, nothing to release
      app.markUpdate(id); log('update handling error:', redact(e.message)); return 'ok';   // never leak internals to the user; never log the update itself
    } finally { inflight.delete(id); }
  }

  async function loop() {
    for (;;) {
      if (!running) return;
      try {
        const ups = await tg('getUpdates', { offset, timeout: 20, allowed_updates: ['message', 'callback_query'] }, 35000);
        for (const u of ups) {
          const r = await handle(u);
          if (r === 'retry') { await new Promise(x => setTimeout(x, 4000)); break; }       // offset NOT advanced: the same update is fetched again
          if (Number.isSafeInteger(u.update_id)) offset = Math.max(offset, u.update_id + 1);
        }
      } catch (e) {
        if (!running) return;
        if (e.code === 409) log('Another process is polling this bot. Stop the other instance (only one poller per bot token).');
        else log('polling error:', redact(e.message));
        await new Promise(r => setTimeout(r, e.retry ? e.retry * 1000 : 4000));
      }
    }
  }

  (async () => {
    try {
      const me = await tg('getMe');
      if (mode === 'polling') {
        // Safety: polling silently deletes a registered webhook. Never do that by accident (e.g. a developer running with the production token).
        const wi = await tg('getWebhookInfo').catch(() => null);
        if (wi && typeof wi === 'object' && wi.url) {
          if (process.env.TELEGRAM_ALLOW_WEBHOOK_DELETE !== '1') { console.error('Telegram bot: this bot has a webhook registered, so local polling was NOT started (polling would delete it). To roll back deliberately run "node server/telegram-webhook.js delete", or set TELEGRAM_ALLOW_WEBHOOK_DELETE=1.'); running = false; return; }
          await tg('deleteWebhook', { drop_pending_updates: false });
        }
      }
      await tg('setMyCommands', { commands: [{ command: 'start', description: 'Welcome' }, { command: 'register', description: 'Register for a clinic visit' }, { command: 'token', description: 'Show my token' }, { command: 'status', description: 'Show my visit status' }, { command: 'help', description: 'How MyTurn works' }] });
      log('Telegram bot: connected as @' + me.username + (mode === 'webhook' ? ' (webhook mode: updates arrive at /telegram/webhook; register it with "node server/telegram-webhook.js set")' : ' (long polling)') + '. Commands: /start /register /token /status /help');
      if (mode === 'polling') loop();
    } catch (e) { console.error('Telegram bot: could not start – ' + redact(e.message) + '. Check TELEGRAM_BOT_TOKEN and your connection. The website is unaffected.'); }
  })();

  return { mode, handleUpdate: handle, stop() { running = false; if (abort) abort.abort(); } };
}

module.exports = { start };
