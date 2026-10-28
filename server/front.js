/* MyTurn - front router: ONE public page, two completely separate queues.
     real  = the clinic's real queue (SQLite, server-verified staff, Telegram patients, no demo data, no public controls)
     demo  = an isolated, in-memory DEMO queue (sample data, simulated demo sign-ins, open scenario/reset/step controls)
   The two are separate createApp() instances: separate state, sessions, cookies (mt_* vs mtd_*), rate limits and storage. Nothing a demo visitor does
   can reach the real queue, because the demo app has no access to the real state at all.
   Which app serves a request is decided ONLY on the server, from facts the client cannot forge:
     1. health, the Telegram webhook (its own secret check) and the proxy self-check always go to the real app;
     2. a request carrying a valid, server-verified REAL staff session goes to the real app (real staff see the real queue);
     3. a sign-in goes to the demo app only if it is exactly the public demo credentials (operator/admin + "demo"); anything else is a real sign-in attempt;
     4. everything else - including anonymous visitors and forged query strings or headers - goes to the demo app. */
'use strict';

const DEMO_USERS = new Set(['operator', 'admin']);
const DEMO_PASSWORD = 'demo';

function createFront({ real, demo, maxBody = 20000 }) {
  function route(req, res) {
    const url = (req.url || '/').split('?')[0];
    if (url === '/healthz' || url === '/telegram/webhook' || url.startsWith('/__proxycheck/')) return real.handle(req, res);
    if (real.hasStaffSession(req)) return real.handle(req, res);
    if (url === '/api/auth/login' && req.method === 'POST') {
      let size = 0, over = false; const parts = [];
      req.on('data', c => {
        size += c.length;
        if (size > maxBody) { if (!over) { over = true; res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }); res.end('{"error":"payload too large"}'); req.destroy(); } } else parts.push(c);
      });
      req.on('end', () => {
        if (over) return;
        const text = Buffer.concat(parts).toString('utf8'); let b = null; try { b = JSON.parse(text); } catch (e) { /* the chosen app answers 400 */ }
        req._preBody = text;                                   // the chosen app must not wait for a body that was already consumed
        const isDemo = !!b && typeof b === 'object' && typeof b.user === 'string' && DEMO_USERS.has(b.user.trim().toLowerCase()) && b.password === DEMO_PASSWORD;
        return (isDemo ? demo : real).handle(req, res);
      });
      return;
    }
    return demo.handle(req, res);
  }
  return { route };
}

/* Telegram identities that belong to the DEMO queue: an operator-configured allowlist of numeric Telegram user ids (DEMO_TELEGRAM_IDS).
   Every other Telegram user - the default - belongs to the real queue. */
function parseDemoIds(s) { return new Set(String(s || '').split(',').map(x => x.trim()).filter(x => /^\d{1,15}$/.test(x))); }

/* The object the Telegram bot works with: real queue by default, demo queue for allowlisted ids, one shared duplicate-update ledger. */
function telegramApp({ real, demo, demoIds }) {
  return {
    S: real.S, runAs: real.runAs,
    target: id => (demo && demoIds.has(String(id)) ? demo : real),
    isStorageError: e => real.isStorageError(e) || (demo ? demo.isStorageError(e) : false),
    markUpdate: id => real.markUpdate(id),                      // the real SQLite ledger records EVERY processed update id
    unmarkUpdate: id => real.unmarkUpdate(id),
    isProcessed: id => real.isProcessed(id) || (demo ? demo.isProcessed(id) : false)
  };
}

module.exports = { createFront, parseDemoIds, telegramApp, DEMO_USERS };
