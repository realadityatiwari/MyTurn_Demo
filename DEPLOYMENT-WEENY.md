# MyTurn on weeny.cloud – operations handoff

Live URL: **https://myturn-kodd.onweeny.com** (public HTTPS is terminated by weeny's Cloudflare tunnel; the app listens on `127.0.0.1:3000`).
This is the current deployment. `DEPLOYMENT.md` covers the Fly.io/Render alternatives and the general design notes.
Not a claim of production readiness: the Telegram bot is **not yet connected** (needs your rotated token), and every item under "Known limitations" applies.

## Architecture
| Item | Value |
|---|---|
| Server | one weeny Linux VM (root, systemd); Node 22.23 (stable-enough `node:sqlite`, prints an ExperimentalWarning) |
| App unit | `weeny-myturn` (logs: `journalctl -u weeny-myturn -f`; `weeny inspect myturn`) |
| Source | `/workspace/myturn` (a clean copy: `server/`, `site/`, `package.json`, `llms.txt`; **no** `.env`, tests, or databases) |
| Release | `/apps/myturn/current` (symlink to the running release; `weeny releases myturn`, `weeny rollback myturn`) |
| Database | `/data/myturn/myturn.db` (SQLite, WAL) – never touched by deploy/rollback |
| Backups (server) | `/data/myturn-backups/` – a different directory from the live database |
| Backups (local) | `%USERPROFILE%\MyTurn-backups\` – downloaded and verified copies (contain personal data) |
| Instances | exactly one (SQLite single writer; sessions/rate limits/SSE in memory) |
| Client-IP | `TRUST_PROXY_HEADER=cf-connecting-ip`, trusted only after the app's runtime proof (`/healthz` shows `"clientIp":"verified"`; see `DEPLOYMENT.md` §6b). **Never set `PROXY_HEADER_VERIFIED=1`.** |

## Environment variables (names only; values are set with `weeny env`, encrypted, injected on start)
`NODE_ENV=production` · `HOST=127.0.0.1` · `PORT=3000` · `DATABASE_PATH=/data/myturn/myturn.db` · `SEED_MODE=empty` · `TRUST_PROXY_HEADER=cf-connecting-ip` · `PUBLIC_ORIGIN` (exact `https://myturn-kodd.onweeny.com`, no trailing slash) · `STAFF_ADMIN_PASSWORD_HASH` (secret) · `TELEGRAM_MODE=webhook` · `TELEGRAM_WEBHOOK_SECRET` (secret) · `TELEGRAM_BOT_TOKEN` (secret; **not set yet**).
Optional: `STAFF_OPERATOR_PASSWORD_HASH` (operator account; not set). Never run bare `weeny env myturn` in a shared terminal – it prints values.

## Redeploy (after a code change)
```powershell
# from the repo root: build the clean upload copy, then upload and deploy
scp -r server site package.json llms.txt <ssh-host>:/workspace/myturn/      # do NOT upload .env, server/test or *.db
ssh <ssh-host> "weeny deploy myturn"                                     # remembered start/health commands; the old release keeps serving if it fails
curl.exe -s https://myturn-kodd.onweeny.com/healthz                       # expect ok + "clientIp":"verified"
```
`<ssh-host>` is the `Host weeny-…` alias in `%USERPROFILE%\.ssh\config`. After any restart the app needs about a minute to re-prove the proxy header; sign-in returns 503 until `/healthz` shows `verified`.

## Backups and restore
**Back up (read-only for the live database; run any time):**
```powershell
powershell -File scripts\backup-live.ps1
```
It runs `server/backup.js backup` on the server (SQLite `VACUUM INTO`, a consistent snapshot – never a file copy), verifies it, downloads it to `%USERPROFILE%\MyTurn-backups`, and checks the SHA-256. Tested 2026-10-28 against the live server (read-only).
**Restore (destructive – only when you decide to; the app must be stopped; the previous database is kept):**
```powershell
$H = '<ssh-host>'; $F = 'myturn-<UTC>.db'                                                   # a file in /data/myturn-backups on the server
scp "$env:USERPROFILE\MyTurn-backups\$F" "${H}:/data/myturn-backups/"                        # only if restoring a local copy
ssh $H "weeny stop myturn"
ssh $H "cd /apps/myturn/current && DATABASE_PATH=/data/myturn/myturn.db NODE_ENV=production node server/backup.js verify /data/myturn-backups/$F"
ssh $H "cd /apps/myturn/current && DATABASE_PATH=/data/myturn/myturn.db NODE_ENV=production node server/backup.js restore /data/myturn-backups/$F --yes"
ssh $H "weeny start myturn"                                                                 # then check /healthz
```
`restore` refuses while the database is open, verifies the backup and the copy, moves the current database to `myturn.db.pre-restore-<UTC>` (and stale `-wal/-shm`), and rolls back on failure. A backup counts as recoverable only after a restore rehearsal: the restore tool was exercised locally (temporary databases and a downloaded live backup restored into a temporary path); a restore on the live server has **not** been performed.
Retention is manual: nothing prunes `/data/myturn-backups`. Schedule `backup-live.ps1` (e.g. daily) and keep copies off this machine too.

## Telegram: connect, check, roll back
Prerequisite (yours): rotate the bot token in BotFather – the earlier token was exposed.
```powershell
powershell -File scripts\telegram-go-live.ps1            # hidden token prompt; sets token+secret via weeny env; waits for healthy; registers the webhook
powershell -File scripts\telegram-go-live.ps1 -Action info     # what Telegram has registered / pending updates / last error
powershell -File scripts\telegram-go-live.ps1 -Action delete   # remove the webhook (pending updates are kept)
```
The webhook secret already lives on the server and in `%USERPROFILE%\.myturn-secrets\telegram-webhook-secret.txt`. The endpoint `/telegram/webhook` exists only when a token is set (404 otherwise), answers 403 to a wrong/missing secret, ignores duplicate update ids (recorded in the same SQLite transaction as the registration), and returns 503 so Telegram retries on storage failure. Use a dedicated TEST Telegram account first (`/start`, `/register`, `/status`); the website cannot register patients in production.

## Rotating credentials
* **Staff password:** `node server/hash-password.js` (hidden prompt, run locally) → `ssh <ssh-host> "weeny env myturn 'STAFF_ADMIN_PASSWORD_HASH=<hash>'"` (restarts the app). Replace the throwaway staging password (`%USERPROFILE%\.myturn-secrets\staging-admin-password.txt`) now; delete that file afterwards.
* **Bot token:** BotFather → run `scripts\telegram-go-live.ps1` again (re-registers).
* **Webhook secret:** delete `telegram-webhook-secret.txt`, run `scripts\telegram-go-live.ps1` (generates a new one, sets it, re-registers).

## Known limitations / sleep and recovery
* If your weeny plan is the free one the server sleeps after ~30 quiet minutes and wakes on the next request (~15 s). On every wake/restart: staff sessions end (sign in again), rate-limit counters reset, and sign-in answers 503 for about a minute until the proxy proof passes again. Queue data is safe (SQLite on `/data`).
* Patient website sign-in is disabled in production; patients use Telegram only (not connected yet). Only an admin account exists.
* One instance only; a deploy/restart is a short outage. No automatic backups or retention; `/data` is not documented by weeny as backed up (only `/workspace` is) – keep your own copies.
* Other services in the same weeny workspace could reach the app privately with arbitrary headers – run none.
* Recovery: `ssh <ssh-host> "weeny inspect myturn"`, `journalctl -u weeny-myturn -n 50`, `weeny restart myturn`, `weeny rollback myturn` (code only), restore from backup (above). Health: `/healthz`.

## Manual steps still yours
1. Rotate the Telegram token in BotFather, then run `scripts\telegram-go-live.ps1` and paste the token at the hidden prompt.
2. Test with a dedicated test Telegram account: `/start`, `/register`, then confirm the visit in the staff view and `/status`.
3. Replace the throwaway staff password with your own hash and delete the staging password file.
4. Schedule `scripts\backup-live.ps1` and keep an off-machine copy.
