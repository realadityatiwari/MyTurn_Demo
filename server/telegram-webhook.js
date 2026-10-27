/* Telegram webhook management (run by the operator, never automatically).
     node server/telegram-webhook.js info      show what Telegram has registered (url host, pending updates, last error)
     node server/telegram-webhook.js set       register  <PUBLIC_ORIGIN>/telegram/webhook  with the secret token
     node server/telegram-webhook.js delete    remove the webhook (roll back to local long polling)
   Reads TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_ORIGIN from the environment / git-ignored .env.
   The token and the secret are never printed. Pending updates are kept (drop_pending_updates=false) so nothing is lost. */
'use strict';
const path = require('path');
const { loadEnv } = require('./server');
const { validWebhookSecret } = require('./auth');

async function run(cmd, env, { log = console.log, apiBase } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN, secret = env.TELEGRAM_WEBHOOK_SECRET, base = apiBase || env.TELEGRAM_API_BASE || 'https://api.telegram.org';
  const redact = s => { let t = String(s); if (token) t = t.split(token).join('<token>'); if (secret) t = t.split(secret).join('<secret>'); return t; };
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token || '')) return fail('TELEGRAM_BOT_TOKEN is missing or malformed.');
  function fail(m) { log('Error: ' + m); return 1; }
  async function call(method, body) {
    const r = await fetch(base + '/bot' + token + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error('Telegram ' + method + ' failed: ' + (j.description || r.status));
    return j.result;
  }
  try {
    if (cmd === 'set') {
      if (!validWebhookSecret(secret)) return fail('TELEGRAM_WEBHOOK_SECRET must be 32-256 characters from A-Z a-z 0-9 _ - .');
      const origin = String(env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+(:(443|80|88|8443))?$/i.test(origin)) return fail('PUBLIC_ORIGIN must be the public https origin (Telegram accepts ports 443, 80, 88, 8443).');
      await call('setWebhook', { url: origin + '/telegram/webhook', secret_token: secret, allowed_updates: ['message', 'callback_query'], max_connections: 10, drop_pending_updates: false });
      log('Webhook registered for ' + new URL(origin).host + ' (secret token set). Check it with: node server/telegram-webhook.js info'); return 0;
    }
    if (cmd === 'delete') { await call('deleteWebhook', { drop_pending_updates: false }); log('Webhook removed. Pending updates were kept. You can now run local long polling (TELEGRAM_MODE=polling).'); return 0; }
    if (cmd === 'info') {
      const i = await call('getWebhookInfo') || {};
      log('Registered: ' + (i.url ? 'yes, host ' + new URL(i.url).host + new URL(i.url).pathname : 'no (polling is possible)'));
      log('Pending updates: ' + (i.pending_update_count || 0));
      if (i.last_error_date) log('Last delivery error: ' + redact(i.last_error_message || 'unknown') + ' (' + new Date(i.last_error_date * 1000).toISOString() + ')');
      else log('Last delivery error: none');
      return 0;
    }
    return fail('usage: node server/telegram-webhook.js info|set|delete');
  } catch (e) { return fail(redact(e.message)); }
}
module.exports = { run };

if (require.main === module) {
  loadEnv(path.join(__dirname, '..', '.env'));
  run(process.argv[2], process.env).then(c => process.exit(c));
}
