# MyTurn – deployment runbook

**Current deployment: weeny.cloud - see [DEPLOYMENT-WEENY.md](DEPLOYMENT-WEENY.md)** (live URL, environment variables, backups/restore, Telegram, credential rotation, limitations). The sections below describe the general design and the Render/Fly.io alternatives, which were prepared but not deployed. **This document is not a claim of production readiness.**
Legend: **[auto]** verified by automated tests in this repository · **[manual]** needs your accounts / public HTTPS · **[unverified]** written but not run.

## Render target (prepared, NOT deployed)

Render is the target host. The Fly.io sections below are kept as an alternative and are **not** Render configuration.

Why the same Docker image fits: MyTurn is one long-running Node process with SSE streams, one SQLite file (single writer, WAL) and a
Telegram webhook. Render's Docker web service provides a long-running instance, HTTPS at its edge, and (on a paid plan) a persistent disk.
A disk restricts the service to one instance, which matches MyTurn's single-writer design. Render cannot use a disk on the Free plan.

| Render setting | Value | Source / status |
|---|---|---|
| Runtime | Docker, repo root `Dockerfile` (`node:24-slim`) | `render.yaml`; image rehearsed locally **[auto]** |
| Compute | `0.5c-512mb`, one instance | `render.yaml`; disk requires a paid plan and forbids scaling **[verified from Render docs]** |
| Region | `singapore` | `render.yaml`; change before first sync if needed |
| Port | `PORT=10000`, bind `0.0.0.0` | Render injects `PORT` (default 10000); the app already binds the `PORT` it is given **[auto]** |
| Disk | `myturn-data` at `/data`, 1 GB, DB `/data/myturn.db` | `render.yaml`; `/data` is an allowed mount path **[verified from Render docs]** |
| Health check | `GET /healthz` (200 healthy, 503 unhealthy) | `render.yaml`; `/healthz` is exempt from the app's Host check **[auto]** |
| TLS / cookies | HTTPS terminated at Render's edge; `Secure` `__Host-` cookies | No code change; browser sees HTTPS **[verified from Render docs; real HTTPS manual]** |
| Public origin | `PUBLIC_ORIGIN` derived from `RENDER_EXTERNAL_URL` | `render.yaml` self-reference; for a custom domain set `PUBLIC_ORIGIN` to the exact custom https origin |
| Client identity | `TRUST_PROXY_HEADER=cf-connecting-ip` | Render fronts every web service with Cloudflare; Cloudflare sets the single-IP `CF-Connecting-IP` header **[verified from Render + Cloudflare docs; end-to-end delivery unverified until the first request]** |
| Telegram | `TELEGRAM_MODE=webhook`; register after the service is healthy | Bot token/secret are `sync: false`; registration is manual and **not done** |
| Shutdown | Render sends `SIGTERM`; default 30 s grace | The app already handles SIGTERM/SIGINT and closes the database; a disk service cannot customize the shutdown delay **[verified from Render docs; signal path manual]** |

### Blockers found and fixes applied

1. **Proxy header was Fly-specific.** `TRUST_PROXY_HEADER=fly-client-ip` does nothing on Render, and Render/Cloudflare appends to a
   client-supplied `X-Forwarded-For`, so the app's existing "last XFF hop" rule would key on Render's load balancer (or a client-supplied
   value), not the client. Fixed by accepting `cf-connecting-ip` as a third supported header and using it in `render.yaml`. It is honoured
   only when the TCP peer is a trusted private/loopback proxy, and a multi-value chain is rejected. If the header is absent, sign-in fails
   closed (503) instead of silently sharing a throttling bucket. `fly-client-ip` remains for the Fly alternative; no Fly setting is reused
   for Render. **[auto]** for parsing; **[unverified]** for Render actually delivering the header.
2. **Port.** Render's default is `PORT=10000`; the app already reads `PORT`. `render.yaml` pins 10000. The Dockerfile's `EXPOSE 8080` is
   metadata only and does not affect Render's routing. **[auto]**
3. **Persistence.** Render's default filesystem is ephemeral; without the disk the database would disappear on every deploy. The blueprint
   mounts a 1 GB disk at `/data` and sets `DATABASE_PATH=/data/myturn.db`. The entrypoint refuses to create a missing volume. **[auto]** for
   the app's volume checks; **[unverified]** for Render disk ownership.
4. **Deploy downtime.** A Render disk disables zero-downtime deploys: the old instance is stopped before the new one starts, so expect a
   brief outage on each deploy. Never scale this service to two instances. **[verified from Render docs]**
5. **Startup validation.** `PUBLIC_ORIGIN` is derived from `RENDER_EXTERNAL_URL` (the exact `https://<name>.onrender.com` URL). If the
   service uses a custom domain, set `PUBLIC_ORIGIN` manually or every POST is refused (403) and every wrong-Host request gets 421. **[auto]**
   for the app rules; **[manual]** for the URL.
6. **Telegram.** The app does not register a webhook by itself. Register only after the service is healthy; the webhook URL is
   `<PUBLIC_ORIGIN>/telegram/webhook`. No webhook was registered during this preparation. **[manual]**
7. **Local tooling.** `.claude/launch.json` contains machine-specific absolute paths and a temp-directory runner. It is local-only and is now
   git-ignored; it contains no secret. No project instructions live in it. **Fixed in `.gitignore`.**

### Render deployment order (manual; none of these steps were run)

1. Push the intended files to a **private** GitHub repository (see the staging/commit commands in the final report).
2. In Render: **New > Blueprint**, connect the repository, and apply `render.yaml`. Choose a unique service name; the onrender.com URL
   follows it. Keep the paid `0.5c-512mb` plan (a disk is not available on Free).
3. When prompted, enter the secret values. Generate them yourself; never paste them into `render.yaml`, Git, chat or logs:
   - staff hashes: `node server/hash-password.js`
   - webhook secret: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
   The Telegram bot token is the one from BotFather. At least one staff hash is required; production refuses to start otherwise.
4. Wait for the deploy. Check the logs for `Production mode: public host ...`, `MyTurn server: http://0.0.0.0:10000/`, the Telegram line,
   and the one-time proxy diagnostic. Check `https://<name>.onrender.com/healthz`.
5. **Go/no-go proxy check.** Make one browser request, then confirm the log says
   `Proxy check: peer <address> is a trusted proxy and header cf-connecting-ip carries the client address - per-client throttling is active.`
   If instead you see `WARNING (proxy check): client identity could not be established (...)`, stop: staff sign-in will be refused (503).
   The likely causes are a missing `CF-Connecting-IP` or an untrusted peer; do not weaken the trust check by trusting arbitrary headers.
   The exact end-to-end delivery of `CF-Connecting-IP` by Render is **not documented explicitly by Render** and remains unverified until
   this check passes.
6. Sign in with a real staff hash; verify the `__Host-` cookies in the browser, that `demo`/`demo` fails, and that the site is served over
   HTTPS. Confirm the Host/Origin checks work on the onrender.com hostname (or set `PUBLIC_ORIGIN` for a custom domain first).
7. Rehearse backup/restore on the real disk before calling backups recoverable: use Render's Shell (paid service) to run
   `node server/backup.js backup /data/backups`, copy the file off the instance, run `verify`, then rehearse the maintenance-mode restore
   from the Fly section below (the entrypoint is platform-neutral; `MYTURN_MAINTENANCE=1` still applies). Render's daily disk snapshots are
   an additional layer, not a substitute for a verified backup.
8. Only after the service is healthy, register the Telegram webhook from a Render Shell with `TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_WEBHOOK_SECRET` and `PUBLIC_ORIGIN` present: `node server/telegram-webhook.js set`, then `info`. Test `/start`, `/register`
   and `/status` from a real Telegram account.

### Render status summary

Prepared and locally tested: Docker image, port handling, `/healthz`, `/data` configuration, `cf-connecting-ip` parsing, production
startup validation, graceful shutdown, backup/restore tooling, and the blueprint itself. **Not yet verified:** the first real Render
deploy, Render's delivery of `CF-Connecting-IP`, Render disk ownership/permissions, real HTTPS/Host/Origin behavior, a real Telegram
webhook, and backup/restore on a Render disk. Do not treat these as deployment-ready until they are exercised on the actual service.

## 1. Alternative hosting: Fly.io, one Machine + one Volume

Why: MyTurn is a long-running Node process with SSE streams, one SQLite file (single writer, WAL) and a Telegram webhook. It needs a
persistent disk, a public HTTPS URL that Telegram can reach, and exactly one instance. Fly.io Machines + Volumes provide that, with a free
`*.fly.dev` HTTPS hostname (no domain needed). Any container/VM host with a persistent disk and HTTPS termination would also work;
serverless/ephemeral-filesystem platforms do **not** (they would lose the database).

| Item | Value | Where |
|---|---|---|
| Runtime | Node 24 (`node:24-slim`); app needs Node ≥ 22.13 for stable `node:sqlite` | Dockerfile, package.json **[auto]** (tests ran on Node 24.21, SQLite 3.53) |
| Instances | exactly 1 machine, never auto-stopped | fly.toml **[auto: config consistency]** |
| Storage | 1 Volume `myturn_data` mounted at `/data`, DB at `/data/myturn.db` | fly.toml **[manual: create the volume]** |
| TLS | terminated by Fly (`force_https`); app adds HSTS and `Secure` `__Host-` cookies | fly.toml, server.js |
| Health check | `GET /healthz` every 15 s (exempt from the Host check) | fly.toml |
| Deploy strategy | `immediate` (replace in place, brief downtime) | fly.toml |
| Size | `shared-cpu-1x`, 256 MB (scrypt login uses ~16 MB per attempt) | fly.toml |

`fly.toml`, `Dockerfile`, `docker-entrypoint.sh`, `.dockerignore` and `package.json` were added.
**Docker: validated locally (2026-10-28, Docker Desktop 29.8.0)** - the image builds, and a local production-mode rehearsal (§6a) confirmed: refusal without a volume, root-to-`node` privilege drop with Node as PID 1, volume ownership repair, `/healthz`, headers, empty production state, sign-in rules, persistence across restart, clean SIGTERM shutdown (exit 0), online backup, restore refusal while running, and the maintenance-mode restore. All 7 test suites also pass inside the image's Linux Node 24.22.1.
**Fly: NOT validated** - the `fly` CLI was not available, so `fly.toml` has only been checked as TOML plus by `deploy.test.js` (internal consistency, no secrets, fly `[env]` + documented secrets passes the app's own production validation). Run `fly config validate` and the Fly steps in §6.

### Why more than one instance is NOT supported
SQLite allows one writer and lives on one volume (a volume attaches to one machine). The queue state is held in process memory and mirrored to
the file, SSE streams are per process, and staff/patient sessions, login throttles and rate limits are in-memory. Two instances would
diverge (two writers, split state, sessions valid on only one, throttles halved). Moving to multiple instances needs a different design
(shared database, shared session/rate-limit store, pub/sub) and is out of scope. `min_machines_running = 1`, no autoscaling, `strategy = "immediate"`.

## 2. Environment variables

Non-secret values live in `fly.toml [env]`. Secrets are set with `fly secrets set` (values you generate; never paste them into chat, git or logs).
The server **refuses to start** (exit 1, message `Startup refused [...]`, nothing served) if production validation fails **[auto]**.

| Variable | Secret? | Required (prod) | Validation / behaviour |
|---|---|---|---|
| `NODE_ENV=production` | no | yes | Enables every production rule below. |
| `PUBLIC_ORIGIN` | no | yes | Exact public origin `https://<host>[:port]`, no path. Used for the Origin check (POST), the Host check (421), `Secure` cookies and webhook URL. Must be `https`. |
| `STAFF_ADMIN_PASSWORD_HASH` / `STAFF_OPERATOR_PASSWORD_HASH` | **yes** | at least one | scrypt string made by `node server/hash-password.js` (run it yourself; the password is never printed or sent). Malformed hash = account disabled with a warning; none valid = refuse to start. |
| `DATABASE_PATH` | no | yes | Absolute path on the volume (`/data/myturn.db`). No default, no `memory`. The parent directory must **already exist and be writable** (the app never creates it, so an unmounted volume stops startup instead of silently using the container disk). |
| `SEED_MODE` | no | `empty` or unset | `demo` is refused. Production always initialises an empty database (no demo patients), regardless of the setting. |
| `HOST`, `PORT` | no | defaults ok | Production defaults `0.0.0.0:8080`; `PORT` must be an integer 1–65535. Must equal `internal_port` in fly.toml. |
| `TRUST_PROXY_HEADER` | no | `fly-client-ip` | Only `fly-client-ip`, `cf-connecting-ip` or `x-forwarded-for` accepted (use `fly-client-ip` on Fly.io and `cf-connecting-ip` on Render; do not trust `x-forwarded-for` unless its chain semantics are known). Honoured **only** when the TCP peer is a trusted proxy address (see below) and the value is a valid IP. Drives login/action throttling per real client IP; when identity cannot be established, sign-in is refused (fail closed). |
| `TRUSTED_PROXY_CIDRS` | no | optional | Comma-separated CIDRs (e.g. `172.16.0.0/12,fdaa::/16`) that REPLACE the default private/loopback trust. Invalid entries, or use without `TRUST_PROXY_HEADER`, are refused at startup. Set it once the proxy's address range has been observed in the startup/first-request log. |
| `TELEGRAM_BOT_TOKEN` | **yes** | optional | If set, `TELEGRAM_MODE=webhook` and a valid secret are mandatory. Unset = website only (bot disabled). |
| `TELEGRAM_MODE=webhook` | no | with token | Polling is refused in production. |
| `TELEGRAM_WEBHOOK_SECRET` | **yes** | with webhook | 32–256 chars `A-Za-z0-9_-`, random. |
| `TELEGRAM_API_BASE` | no | leave unset | Anything other than `https://api.telegram.org` is refused (it would receive the token). |
| `PATIENT_WEB_MODE` | no | unset | Production forces `disabled`; `demo` is refused. Patients use Telegram. |
| `DEMO_OPEN_CONTROLS`, `ALLOW_PRODUCTION_RESET`, `COOKIE_SECURE` | no | unset | Open controls ignored/refused in production; scenario reset stays off unless `ALLOW_PRODUCTION_RESET=1`; cookies are always `Secure`. |
| `AVG_SERVICE_MINUTES` | no | optional | 1–120, default 8. |
| `MYTURN_SKIP_DOTENV=1` | no | n/a | Ignores a local `.env` file (used by tests). Fly does not have a `.env` (not copied into the image). |

Production also guarantees **[auto]**: no demo credentials, no simulated patient sign-in, no open reset/scenario controls, pages carry the
"server required" marker (no browser-only fallback), HSTS and CSP, generic error bodies.

## 3. Startup, health, shutdown

- **Startup log** (no secrets): `Staff sign-in: server-verified (admin)…`, `Storage: SQLite file myturn.db (persistent)`, `Production mode: public host <host>, telegram webhook, node v24…, listening on 0.0.0.0:8080`, then `Telegram bot: connected as @… (webhook mode…)` **[auto: format; real Telegram manual]**.
- **Refusals** print `Startup refused [UNSAFE_CONFIG|DB_*]: <reason>` and exit 1; the platform shows the machine failing health checks – read `fly logs`.
- **Health**: `GET /healthz` → `{"ok":true,"storage":"sqlite","telegram":"webhook"}` (200). 503 when the database cannot be read/written; it recovers automatically once a write succeeds **[auto]**. It does not reveal data.
- **Container user and volume** (`docker-entrypoint.sh`, **[unverified]** until built): the entrypoint starts as root, runs `chown -R node:node` on the database directory **only if it is `/data` or below** (never `/`, never created), then `exec setpriv --reuid=node …` so Node runs unprivileged as PID 1 and receives the stop signal. `MYTURN_MAINTENANCE=1` runs `sleep infinity` instead (restore procedure, §4). Files must keep LF line endings (`.gitattributes` enforces it; a CRLF shebang would break the container).
- **Shutdown**: on SIGTERM/SIGINT the bot is stopped, event streams closed, the database closed (WAL checkpointed, no `-wal`/`-shm` left **[auto]**) and the process exits 0. Every action is persisted *before* it is acknowledged, so nothing is lost on shutdown; an action in flight during a hard kill is simply not acknowledged. (The signal path itself could not be exercised on Windows; the close routine is tested **[auto]**, signal delivery on Fly is **[manual]**.)

## 4. Backups and restore (SQLite-safe)

Tool: `node server/backup.js` (reads `DATABASE_PATH`).

- `backup <dest.db>` – **online**, uses SQLite `VACUUM INTO` from a separate connection: a transactionally consistent snapshot while the app runs. Never copy `/data/myturn.db`, `-wal` or `-shm` with `cp`/`sftp` from a running app – that can produce a torn file. The result is verified (integrity check, MyTurn tables, schema version, state validation) and removed if it does not verify. Never overwrites. Owner-only permissions. **[auto]**
- `verify <backup.db>` – read-only validation; reports counts only, never names. Rejects garbage, empty, foreign SQLite files, tampered state, newer schema. **[auto]**
- `restore <backup.db> --yes` – **app must be stopped** (it refuses if the database is open elsewhere, detected with an exclusive-lock probe). Verifies the backup, copies it next to the target, verifies the copy, moves the current database and any stale `-wal/-shm` aside as `<db>.pre-restore-<timestamp>*` (nothing is ever deleted), then installs atomically with rename; rolls the old files back on failure. Preserves Telegram duplicate-protection ids as of the backup. **[auto]**

What is proven: backup of a live database, restore into a fresh/replaced volume, app start from the restored file, continuing token numbers, persistence after restart, refusal paths (`deploy.test.js`, 56 checks incl. CLI; additionally rehearsed by hand in a local container, see §6a). What is **not** proven: backup/restore on a real Fly volume, off-machine storage, encryption and retention. **Treat a backup as recoverable only after you have rehearsed a restore on the real platform** (step 7 in §6).

Backups contain patient names, tokens and Telegram ids. Keep them out of git/images, store them encrypted and access-controlled, and delete per your retention policy.
Suggested routine **[manual]**: before every deploy and daily: `fly ssh console -C "node server/backup.js backup /data/backups"` (a directory argument creates `myturn-<UTC timestamp>.db` inside it; backups land on the same volume, so keep the volume large enough for a few copies and prune old ones), then copy the file off the machine (e.g. `fly ssh sftp get`; Fly volume snapshots are an additional layer – crash-consistent, not a substitute for a verified `backup`). In production the tool refuses to run unless `DATABASE_PATH` is set in that shell; confirm once with `fly ssh console -C "printenv DATABASE_PATH"` (non-secret) – if it is empty, prefix the command with `DATABASE_PATH=/data/myturn.db` inside an interactive `fly ssh console` session.

**Restore procedure (matches the implementation; the app must not have the database open).** A stopped Fly machine cannot be reached with `fly ssh`, so the image has a **maintenance mode**: with `MYTURN_MAINTENANCE=1` the entrypoint still fixes volume ownership but runs `sleep infinity` instead of the app, so nothing opens the database.
1. `fly secrets set MYTURN_MAINTENANCE=1` (machine restarts into maintenance mode; the health check fails and the site is down – expected).
2. `fly ssh console`, then inside it: `node server/backup.js verify /data/backups/<file>.db` and `node server/backup.js restore /data/backups/<file>.db --yes` (if the backup is elsewhere, upload it with `fly ssh sftp shell` first).
3. Note the printed `Previous database kept at: …` path (safety copy; delete it yourself only when you are sure).
4. `fly secrets unset MYTURN_MAINTENANCE` (restarts into the app; the entrypoint re-applies `chown -R node:node /data`, which also fixes ownership of files created by the root shell). Check `/healthz` and the data.
If step 2 fails, nothing is changed (every refusal path leaves the database untouched; a failure mid-swap rolls back). **[auto]** for the tool; the maintenance-mode entrypoint and Fly behaviour are **[manual/unverified]**.

### Migration failure and rollback limits
- Migrations are append-only, each in its own transaction; a failing migration rolls back, the app refuses to start (`DB_MIGRATION_FAILED`) and the database is unchanged.
- A database written by a *newer* schema is refused by older code (`DB_NEWER_SCHEMA`; the same check applies to backups). **Rolling back code after a migration has run therefore requires restoring the pre-deploy backup, which loses everything written since.** Take a verified backup before every deploy; only one migration (v1) exists today, so this path has not been exercised on a real upgrade **[unverified]**.
- A corrupt or invalid database is never "repaired" or overwritten: startup stops with `DB_OPEN_FAILED`/`DB_CORRUPT_STATE` **[auto]**. Recover with `restore`.

## 5. Review against the hosting configuration

| Topic | Configuration | Verdict |
|---|---|---|
| Cookies | `__Host-mt_staff/__Host-mt_patient`, `HttpOnly; Secure; SameSite=Strict; Path=/` (no Domain) – valid because the browser sees HTTPS at the Fly edge | **[auto]** attributes; real HTTPS **[manual]** |
| `PUBLIC_ORIGIN` | must equal the exact `https://<app>.fly.dev` the browser uses; wrong value = every POST 403, every request 421 | **[manual]** set after the app name is known |
| Client identity / proxy trust | `server/auth.js resolveClient`. With `TRUST_PROXY_HEADER=fly-client-ip` the header is believed **only if** the TCP peer is in the trusted-proxy range (default: private/loopback `10/8, 172.16/12, 192.168/16, 127/8, fc00::/7, ::1`; narrow it with `TRUSTED_PROXY_CIDRS`), it is a valid IP literal, and (for `x-forwarded-for`) only its LAST hop is used. Otherwise the request is **unidentified**: it is never keyed on the header or on the proxy's address. Unidentified requests: **sign-in and patient sign-in are refused (503, fail closed)**, they share one separate, large global ceiling (3000/min) that identified clients never touch, and they have no per-client stream cap. So a missing/untrusted IP can never create a shared lockout bucket and cannot lock staff out. There is **no global per-username lockout** any more: guessing is limited per client IP (5 tries per IP+account, 20 per IP, doubling locks), so a botnet cannot lock the owner out; passwords must be 12+ random characters (`hash-password.js` enforces it). **[auto]** (privacy.test.js: trusted/untrusted/public/IPv6/mapped peers, spoofed, missing, invalid and multi-hop headers, narrowed CIDRs, lockout isolation, 30-address distributed guessing, per-client ceilings, stream caps). | **Cannot be verified locally (Fly platform behaviour):** (1) that Fly's proxy connects from an address inside the trusted range (believed to be private 172.16.x / `fdaa:` 6PN, **unconfirmed**); (2) that Fly sets `Fly-Client-IP` on every request and overwrites a client-supplied one; (3) whether other apps in the same Fly organisation can reach the machine over the private network and thereby spoof the header (if so, narrow `TRUSTED_PROXY_CIDRS` to the proxy's range and run nothing untrusted in the org). **[manual]** On the first request the app logs either `Proxy check: peer <proxy address> is a trusted proxy and header fly-client-ip carries the client address - per-client throttling is active.` (the *proxy's* private address is printed so you can narrow `TRUSTED_PROXY_CIDRS`; client addresses never are) or `WARNING (proxy check): client identity could not be established (peer-not-trusted / header-missing / header-invalid)`. A WARNING means staff cannot sign in (503) until fixed – set `TRUSTED_PROXY_CIDRS` to the logged proxy range or correct the header name. |
| HTTPS | `force_https`, HSTS 1 year, Telegram needs a valid public cert (Fly provides one for `*.fly.dev`) | **[manual]** |
| Webhook secret | random 32+ chars, constant-time check, 403 otherwise; token never in URLs or logs | **[auto]** logic; real Telegram **[manual]** |
| Rate limits | per real client IP (from `fly-client-ip`), in-memory, reset on restart. Telegram's source IPs share the 600/min webhook budget each | **[auto]** logic; tuning **[manual]** |
| SSE | 15 s keep-alive keeps streams alive behind the proxy; cap 10 per IP / 300 total | **[manual]** observe on Fly |
| Secrets | only in `fly secrets`; not in fly.toml, Dockerfile, image (`.dockerignore`), git (`.gitignore`) or logs; `.env.example` has placeholders only | **[auto]** scan of repo files (`.env` itself is never read) |

## 6. Deployment order (all steps manual; none were run)

1. **Rotate the Telegram token** in BotFather (the earlier one was exposed). Keep the new one private.
2. Install the Fly CLI and log in (`fly auth login`). Choose an app name and region; edit `app` and `primary_region` in `fly.toml`.
3. Validate: `fly config validate` **[manual: needs the Fly CLI]**. The Docker part was rehearsed locally already (§6a); repeat it on your machine if you like.
4. `fly apps create <name>`; `fly volumes create myturn_data --size 1 --region <region> --count 1`.
5. Generate secrets yourself: staff hash(es) with `node server/hash-password.js`; webhook secret with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`. Then
   `fly secrets set PUBLIC_ORIGIN=https://<name>.fly.dev STAFF_ADMIN_PASSWORD_HASH='<hash>' STAFF_OPERATOR_PASSWORD_HASH='<hash>' TELEGRAM_BOT_TOKEN='<token>' TELEGRAM_WEBHOOK_SECRET='<secret>'`
   (type them in your own terminal; do not paste them anywhere else).
6. `fly deploy` (single machine). Check `fly status` (1 machine, volume attached), `fly logs` for the startup lines in §3 and – after your first request to the site – the `Proxy check: … per-client throttling is active` line (a `WARNING (proxy check)` line means staff sign-in is refused until fixed, see §5), and `https://<name>.fly.dev/healthz`.
7. **Backup rehearsal before real use:** create a backup on the machine, download it, run `verify`, then rehearse the full **restore procedure in §4 (maintenance mode)** → `/healthz` → check data. Only then call backups recoverable.
8. Open the site: staff sign-in, the "server unavailable" wall when stopped, no demo hints, CSP clean in the console.
9. **Register the webhook** (only after the app is healthy): in a terminal that has `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `PUBLIC_ORIGIN` in its environment: `node server/telegram-webhook.js set`, then `info` (expect your host, `pending_update_count`, no last error).
10. From a real Telegram account: `/start`, `/register`, `/status`; confirm the visit appears for staff and survives `fly machine restart` (restart the machine, repeat `/status`).

**Rollback.** Code only (no schema change since the last deploy): `fly releases` → `fly deploy --image <previous image>`; `/healthz`; data is untouched. After a migration: restore the pre-deploy backup (§4). Telegram: `node server/telegram-webhook.js delete` stops deliveries (pending updates are kept); for local polling set `TELEGRAM_MODE=polling` outside production.
**Secret rotation:** `fly secrets set …` restarts the machine; for the bot token also re-run `set` only if the secret/URL changed, otherwise just `info`.

## 6a. Local container rehearsal and Fly validation commands

**Local rehearsal (done on 2026-10-28; repeatable by you).** Needs Docker running. From the repo root in PowerShell:

```powershell
docker build -t myturn:local .
powershell -File scripts\container-rehearsal.ps1
```
The script runs the *production* configuration (NODE_ENV=production, `PUBLIC_ORIGIN=https://myturn.example`, a throw-away password hash, `TRUST_PROXY_HEADER=fly-client-ip`) against a throw-away volume and prints each result. It mimics Fly by sending `Host: myturn.example` and a `fly-client-ip` header; the Docker bridge address plays the proxy. It creates and removes only `myturn-r1`, `myturn-r2`, `myturn-nov` and the volume `myturn_rehearsal` (it never touches other containers/volumes).

Results recorded in this audit (Docker Desktop 29.8.0, image Node v24.22.1 / SQLite 3.53.4): start **without** a volume → exit 1 `Startup refused … /data is missing`; with a volume → PID 1 runs as uid 1000 (`node`), `/data` files owned by 1000 after the entrypoint ran as root; `/healthz` `{"ok":true,"storage":"sqlite","telegram":"off"}`; empty production state (0 queues, 0 accounts); wrong `Host` → 421; page has the require-server marker, CSP and HSTS; sign-in without `fly-client-ip` → 503, wrong password → 401, `demo`/`demo` → 401, throw-away password → 200 with `__Host-…; HttpOnly; SameSite=Strict; Secure`; state written by an admin action survived `docker stop`/`start` (rev 2 → 2); `docker stop` took ~0.3 s, exit code 0, log `Shutting down (SIGTERM)`, no `-wal`/`-shm` left; the session cookie did not survive the restart (401, expected); `backup /data/backups` (via `docker exec` as root) wrote `/data/backups/myturn-<UTC>.db` and `verify` passed; `restore` while the app ran → `DB_IN_USE`, nothing changed; after a restart the root-created files were chowned back to uid 1000; in maintenance mode (`MYTURN_MAINTENANCE=1`) the app did not start (no health answer) and `restore … --yes` installed the backup, kept `myturn.db.pre-restore-<UTC>`, and the app then started normally. All 7 test suites also pass inside the image's Linux Node 24.22.1 (run with `-e NODE_ENV=test`, because the image sets `NODE_ENV=production`).
Limits of the rehearsal: empty queue data only (data-bearing backup/restore is covered by `deploy.test.js`); Docker bridge networking, not Fly's proxy/Firecracker VM/volume; no real Telegram.
A defect found by the rehearsal and fixed: `backup <path-without-extension>` created a *file* named like the directory instead of a timestamped file inside it (now a directory; regression test added).

**Fly validation (needs the Fly CLI and your account; NOT done).**
```powershell
# install (one of):  winget install Fly-io.flyctl     or     iwr https://fly.io/install.ps1 -useb | iex
fly version
fly auth login
# edit fly.toml: app = "<your-app-name>", primary_region = "<region>"
fly config validate
fly apps create <your-app-name>
fly volumes create myturn_data --size 1 --region <region> --count 1
# optional: build on Fly's builder without deploying
fly deploy --build-only
```
Then continue with §6 step 5 (secrets) onward. Nothing in this runbook deploys by itself.

## 6b. Render: client-IP proof (automatic) and the one manual check

Render documents only `X-Forwarded-For` for client IPs; it does **not** document `CF-Connecting-IP`. So the app does not trust that header by default. On start it calls its own `PUBLIC_ORIGIN` twice through the real public path with two different forged `CF-Connecting-IP` values (documentation range `192.0.2.0/24`) and trusts the header only if a control request (no forged value) carries exactly one public IP from a trusted proxy peer AND each forged request is either overwritten with that same value or rejected with HTTP 403 before reaching the app (observed on weeny.cloud/Cloudflare: a client-supplied `CF-Connecting-IP` is answered with 403 "error 1000", so it cannot be forged through the edge). Until it passes (normally within about a minute of a deploy, retried every 10 s) sign-in is refused with 503 and no per-client rate-limit bucket is used; the check repeats every 30 minutes and withdraws trust immediately if the platform stops overwriting the header.

**The one manual check after deploying:** `curl.exe -s https://<service>.onrender.com/healthz` - wait until it shows `"clientIp":"verified"`, then sign in. If it stays `"unverified"`, the Render log says why (`Proxy header verification NOT passed (<reason>)`): `client-value-passed-through` means the header is client-controlled (do **not** attest); `header-absent` means Render does not send it; `peer-not-trusted` means the proxy peer is outside the private ranges (see `TRUSTED_PROXY_CIDRS`). Only after verifying by hand may you set `PROXY_HEADER_VERIFIED=1` to skip the check. Residual: other services in the same Render workspace can reach the app privately with arbitrary headers - run none, or narrow `TRUSTED_PROXY_CIDRS`.

## 7. Unresolved risks (honest list)

- **Exactly one machine must exist.** `fly deploy` may create two machines for an app with an http service; with one volume only one can mount it. After the first deploy `fly status` must show **1** machine (`fly scale count 1` if not), never more.
- **Telegram update processing is now atomic (fixed):** a registration and its update id are written in ONE SQLite transaction (`runAs(..., { claim })` → `db.save(state, claimId)`), so there is no "marked processed but not applied" state. A kill before the commit leaves neither (redelivery is processed); a kill after it leaves both (redelivery is a duplicate). **Remaining limitation:** if the process dies after the commit but before the confirmation message, the user is registered but never receives the confirmation, and redelivery is (correctly) ignored – they can send `/status`. Updates that change nothing (`/start`, `/status`, a rejected duplicate registration) are recorded *after* processing; losing that record only repeats a harmless reply. **[auto]** (real killed child processes in `webhook.test.js`).
- **Keep-alive vs proxy:** Node closes idle keep-alive connections after 5 s. If the Fly proxy reuses a connection at that moment it can see a rare 502/reset (Telegram retries; browsers retry). Watch `fly logs`; raise `keepAliveTimeout` only if it happens.
- `fly.toml` is **not validated by Fly**, and nothing has run on Fly yet. The image and entrypoint were validated in a local Docker (§6a) but not on Fly's Firecracker VM (volume ownership/`setpriv` behave the same in Docker; Fly volumes are a different mount type).
- No real HTTPS, Fly proxy, Fly volume, SIGTERM-on-Fly or Telegram verification has happened.
- Backups are tested locally only; off-site copy, encryption and retention are your responsibility.
- Single instance = a restart or deploy means brief downtime; Telegram retries for a limited time, then drops updates.
- Sessions, throttles and rate limits are in memory (a restart signs staff out and resets limits).
- Staff and patient names are visible to staff by design; patient web sign-in is disabled in production (Telegram only).
- The hackathon prototype has known product defects listed in the system documentation (Appendix C).
