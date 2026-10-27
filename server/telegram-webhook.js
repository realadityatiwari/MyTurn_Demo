/* Telegram webhook management (run by the operator, never automatically).
     node server/telegram-webhook.js check     ask Telegram whether the token is valid (getMe); changes nothing
     node server/telegram-webhook.js info      show what Telegram has registered (url host, pending updates, last error)
     node server/telegram-webhook.js set       register  <PUBLIC_ORIGIN>/telegram/webhook  with the secret token
     node server/telegram-webhook.js delete    remove the webhook (roll back to local long polling)
   Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_ORIGIN from the environment / git-ignored .env.
   The token and the secret are never printed. Pending updates are kept (drop_pending_updates=false) so nothing is lost.
   Exit codes tell the caller WHY it failed (so a network problem is never reported as a bad token):
     0 ok   1 configuration/usage   2 network (DNS, connection, TLS, timeout)   3 unexpected HTTP response (redirect, non-JSON, proxy page)
     4 Telegram answered ok:false (for a bad token: 401 Unauthorized) */
'use strict';
const path = require('path');
const { loadEnv } = require('./server');
const { validWebhookSecret } = require('./auth');

const DEFAULT_API = 'https://api.telegram.org';
const EXIT = { OK: 0, CONFIG: 1, NETWORK: 2, HTTP: 3, TELEGRAM: 4 };
class TgError extends Error { constructor(kind, message, extra) { super(message); this.kind = kind; Object.assign(this, extra); } }

// A fetch() failure only says "fetch failed"; the real reason is in error.cause. Classify it without ever including the request URL.
function describeNetworkError(e) {
  const c = (e && e.cause) || e || {}, code = c.code || e.code || '', name = c.name || e.name || '';
  let what = 'connection problem';
  if (name === 'AbortError' || /TIMEOUT/i.test(code) || code === 'UND_ERR_CONNECT_TIMEOUT') what = 'timeout';
  else if (/^(ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NODATA)$/.test(code)) what = 'DNS lookup failed';
  else if (/^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE|UND_ERR_SOCKET)$/.test(code)) what = 'connection failed';
  else if (/CERT|SSL|TLS|SELF_SIGNED|LEAF_SIGNATURE|ALTNAME/i.test(code + ' ' + (c.message || ''))) what = 'TLS/certificate problem';
  return what + (code ? ' (' + code + ')' : '') + (c.message && c.message !== 'fetch failed' ? ': ' + c.message : '');
}

async function run(cmd, env, { log = console.log, apiBase, timeoutMs = 15000 } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN, secret = env.TELEGRAM_WEBHOOK_SECRET, base = apiBase || env.TELEGRAM_API_BASE || DEFAULT_API;
  const redact = s => { let t = String(s); if (token) t = t.split(token).join('<token>'); if (secret) t = t.split(secret).join('<secret>'); return t; };
  function fail(m) { log('Error: ' + m); return EXIT.CONFIG; }
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token || '')) return fail('TELEGRAM_BOT_TOKEN is missing or malformed.');
  let host; try { host = new URL(base).host; } catch (e) { return fail('TELEGRAM_API_BASE is not a valid URL.'); }
  if (base !== DEFAULT_API) {                                                       // the token travels in the request path: never send it to an unexpected host
    if (!apiBase && env.ALLOW_CUSTOM_TELEGRAM_API !== '1') return fail('TELEGRAM_API_BASE points to "' + host + '" instead of api.telegram.org, so the token would be sent there. Unset it (e.g. remove it from .env), or set ALLOW_CUSTOM_TELEGRAM_API=1 only for a local test server.');
    log('Note: using the non-default Telegram API host ' + host + ' (test/override).');
  }
  log('Contacting Telegram API host: ' + host);

  async function call(method, body) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs); let r, text;
    try {
      r = await fetch(base + '/bot' + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal, redirect: 'manual' });
      text = await r.text();
    } catch (e) { throw new TgError('network', describeNetworkError(e)); } finally { clearTimeout(timer); }
    if (r.status >= 300 && r.status < 400) throw new TgError('http', 'HTTP ' + r.status + ' redirect (not followed): something other than the Telegram API answered');
    let j; try { j = JSON.parse(text); } catch (e) { throw new TgError('http', 'HTTP ' + r.status + ' with a non-JSON body: a proxy, firewall or captive portal may be answering instead of Telegram'); }
    if (j && j.ok === false) throw new TgError('telegram', (j.error_code === 401 || r.status === 401 ? 'Telegram says the token is invalid (401 Unauthorized)' : 'Telegram answered ok:false (' + (j.error_code || r.status) + '): ' + (j.description || 'no description')), { code: j.error_code || r.status });
    if (!j || j.ok !== true || r.status >= 400) throw new TgError('http', 'HTTP ' + r.status + ' with an unexpected JSON body (no "ok" field)');
    return j.result;
  }
  try {
    if (cmd === 'check') {
      const me = await call('getMe');
      if (!me || me.is_bot !== true || typeof me.username !== 'string') throw new TgError('http', 'getMe answered ok but without a bot identity; not treating the token as confirmed');
      log('Token accepted by Telegram for bot @' + me.username + '.'); return EXIT.OK;
    }
    if (cmd === 'set') {
      if (!validWebhookSecret(secret)) return fail('TELEGRAM_WEBHOOK_SECRET must be 32-256 characters from A-Z a-z 0-9 _ - .');
      const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+(:(443|80|88|8443))?$/i.test(origin)) return fail('PUBLIC_ORIGIN must be the public https origin (Telegram accepts ports 443, 80, 88, 8443).');
      await call('setWebhook', { url: origin + '/telegram/webhook', secret_token: secret, allowed_updates: ['message', 'callback_query'], max_connections: 10, drop_pending_updates: false });
      log('Webhook registered for ' + new URL(origin).host + ' (secret token set). Check it with: node server/telegram-webhook.js info'); return EXIT.OK;
    }
    if (cmd === 'delete') { await call('deleteWebhook', { drop_pending_updates: false }); log('Webhook removed. Pending updates were kept. You can now run local long polling (TELEGRAM_MODE=polling).'); return EXIT.OK; }
    if (cmd === 'info') {
      const i = await call('getWebhookInfo') || {};
      log('Registered: ' + (i.url ? 'yes, host ' + new URL(i.url).host + new URL(i.url).pathname : 'no (polling is possible)'));
      log('Pending updates: ' + (i.pending_update_count || 0));
      if (i.last_error_date) log('Last delivery error: ' + redact(i.last_error_message || 'unknown') + ' (' + new Date(i.last_error_date * 1000).toISOString() + ')');
      else log('Last delivery error: none');
      return EXIT.OK;
    }
    return fail('usage: node server/telegram-webhook.js check|info|set|delete');
  } catch (e) {
    if (e instanceof TgError) { log((e.kind === 'network' ? 'Network error: ' : e.kind === 'http' ? 'HTTP error: ' : 'Telegram error: ') + redact(e.message)); return e.kind === 'network' ? EXIT.NETWORK : e.kind === 'http' ? EXIT.HTTP : EXIT.TELEGRAM; }
    return fail(redact(e.message));
  }
}
module.exports = { run, EXIT, describeNetworkError };

if (require.main === module) {
  if (process.env.MYTURN_SKIP_DOTENV !== '1') loadEnv(path.join(__dirname, '..', '.env'));   // (the go-live script sets MYTURN_SKIP_DOTENV so an old .env can never change what is contacted)
  run(process.argv[2], process.env).then(c => process.exit(c));
}
