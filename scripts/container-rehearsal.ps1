$ErrorActionPreference = 'Continue'
# Local container rehearsal of the PRODUCTION configuration (throwaway data, throwaway password, no network services, nothing is deployed).
# Prerequisites: Docker running, and the image built:  docker build -t myturn:local .
# Usage (from the repo root):  powershell -File scripts\container-rehearsal.ps1
# Creates and removes only: containers myturn-r1/myturn-r2/myturn-nov, volume myturn_rehearsal, ports 18080/18081.
Set-Location (Split-Path $PSScriptRoot)
$PW = 'Throwaway-Rehearsal-Pw-1'                      # throwaway test password, not a real secret
$HASH = node -e "require('./server/auth').hashPassword('$PW').then(h=>process.stdout.write(h))"
$ORIGIN = 'https://myturn.example'
function Env-Args($extra) { @('-e','NODE_ENV=production','-e',"PUBLIC_ORIGIN=$ORIGIN",'-e',"STAFF_ADMIN_PASSWORD_HASH=$HASH",'-e','DATABASE_PATH=/data/myturn.db','-e','TRUST_PROXY_HEADER=fly-client-ip','-e','SEED_MODE=empty','-e','HOST=0.0.0.0','-e','PORT=8080') + $extra }
function Show($t) { "`n=== $t" }
function Curl($args2) { (& curl.exe -s -S -m 8 @args2) }
docker rm -f myturn-r1 myturn-r2 myturn-nov 2>$null | Out-Null
docker volume rm -f myturn_rehearsal 2>$null | Out-Null

Show 'A. production start WITHOUT a volume (must refuse: /data does not exist)'
$out = docker run --name myturn-nov @(Env-Args @()) myturn:local 2>&1; "exit code: $LASTEXITCODE"; $out | Select-Object -First 6
docker rm -f myturn-nov | Out-Null

Show 'B. production start with a fresh (root-owned) named volume, mimicking fly.toml'
docker volume create myturn_rehearsal | Out-Null
docker run -d --name myturn-r1 -p 18080:8080 -v myturn_rehearsal:/data @(Env-Args @()) myturn:local | Out-Null
Start-Sleep 3
"--- logs"; docker logs myturn-r1 2>&1
"--- PID 1 identity (expect Name: node, Uid: 1000)"; docker exec myturn-r1 sh -c "grep -E '^(Name|Uid|Gid):' /proc/1/status"
"--- /data ownership after entrypoint (expect node=1000)"; docker exec myturn-r1 sh -c "ls -ln /data"
"--- healthz"; Curl @('http://127.0.0.1:18080/healthz')
"--- /api/state with the public Host: empty production state?"; $st = Curl @('-H','Host: myturn.example','http://127.0.0.1:18080/api/state'); $o = $st | ConvertFrom-Json; "rev=$($o.rev) queues=" + (($o.shared.q.PSObject.Properties | ForEach-Object { $_.Value.Count } | Measure-Object -Sum).Sum) + " accounts=" + @($o.shared.accounts.PSObject.Properties).Count
"--- wrong Host (expect 421)"; Curl @('-o','NUL','-w','%{http_code}','http://127.0.0.1:18080/api/state'); ''
"--- page marker + headers"; $h = Curl @('-i','-H','Host: myturn.example','http://127.0.0.1:18080/'); ($h -split "`n" | Where-Object { $_ -match '^(HTTP|Strict-Transport|Content-Security|X-Frame|Cache-Control)' }) -join "`n"; "marker: " + [bool]($h -match 'myturn-require-server')
"--- login WITHOUT fly-client-ip header (expect 503 identity unavailable)"
Curl @('-X','POST','-H','Host: myturn.example','-H',"Origin: $ORIGIN",'-H','Content-Type: application/json','-d',"{`"user`":`"admin`",`"password`":`"$PW`"}",'-w',' [%{http_code}]','http://127.0.0.1:18080/api/auth/login'); ''
"--- login WITH header, wrong password (expect 401)"
Curl @('-X','POST','-H','Host: myturn.example','-H',"Origin: $ORIGIN",'-H','fly-client-ip: 203.0.113.5','-H','Content-Type: application/json','-d','{"user":"admin","password":"wrong-password-xyz"}','-w',' [%{http_code}]','http://127.0.0.1:18080/api/auth/login'); ''
"--- login WITH header, throwaway password (expect 200 + Secure __Host- cookie)"
$r = Curl @('-i','-X','POST','-H','Host: myturn.example','-H',"Origin: $ORIGIN",'-H','fly-client-ip: 203.0.113.5','-H','Content-Type: application/json','-d',"{`"user`":`"admin`",`"password`":`"$PW`"}",'http://127.0.0.1:18080/api/auth/login')
($r -split "`n" | Where-Object { $_ -match '^(HTTP|Set-Cookie)' } | ForEach-Object { $_ -replace '(__Host-mt_staff=)[^;]+','$1<redacted>' }) -join "`n"
$cookie = (($r -split "`n" | Where-Object { $_ -match '^Set-Cookie' } | Select-Object -First 1) -replace '^Set-Cookie:\s*','' -split ';')[0].Trim()
"--- demo/demo must not work"
Curl @('-X','POST','-H','Host: myturn.example','-H',"Origin: $ORIGIN",'-H','fly-client-ip: 203.0.113.6','-H','Content-Type: application/json','-d','{"user":"admin","password":"demo"}','-w',' [%{http_code}]','http://127.0.0.1:18080/api/auth/login'); ''
"--- admin writes state (resetQueue) so we can prove persistence across a container restart"
Curl @('-X','POST','-H','Host: myturn.example','-H',"Origin: $ORIGIN",'-H','fly-client-ip: 203.0.113.5','-H',"Cookie: $cookie",'-H','Content-Type: application/json','-d','{"method":"resetQueue","args":["rv:gm"]}','-w',' [%{http_code}]','http://127.0.0.1:18080/api/action'); ''
$rev1 = ((Curl @('-H','Host: myturn.example','http://127.0.0.1:18080/api/state')) | ConvertFrom-Json).rev; "rev before restart: $rev1"
"--- logs after requests (proxy diagnostics)"; docker logs myturn-r1 2>&1 | Select-String 'Proxy check|WARNING'

Show 'C. restart the container: persistence + clean shutdown'
$t0 = Get-Date; docker stop myturn-r1 | Out-Null; "stop took: $([int]((Get-Date) - $t0).TotalMilliseconds) ms"
"exit code: $(docker inspect myturn-r1 --format '{{.State.ExitCode}}')"; "--- last logs"; docker logs --tail 3 myturn-r1 2>&1
"--- files left in /data after clean shutdown (expect no -wal/-shm)"; docker run --rm -v myturn_rehearsal:/data --entrypoint sh myturn:local -c "ls -la /data"
docker start myturn-r1 | Out-Null; Start-Sleep 3
$rev2 = ((Curl @('-H','Host: myturn.example','http://127.0.0.1:18080/api/state')) | ConvertFrom-Json).rev; "rev after restart: $rev2 (expect equal to before: $rev1)"
"--- old session cookie after restart (sessions are in memory: expect 401)"
Curl @('-X','POST','-H','Host: myturn.example','-H',"Origin: $ORIGIN",'-H','fly-client-ip: 203.0.113.5','-H',"Cookie: $cookie",'-H','Content-Type: application/json','-d','{"method":"tick","args":[]}','-w',' [%{http_code}]','http://127.0.0.1:18080/api/action'); ''

Show 'D. backup inside the container (as root via docker exec), verify, then restart (entrypoint re-fixes ownership)'
docker exec myturn-r1 node server/backup.js backup /data/backups
$bk = (docker exec myturn-r1 sh -c "ls /data/backups").Trim(); "backup file: $bk"
docker exec myturn-r1 node server/backup.js verify "/data/backups/$bk"
"--- restore while the app is RUNNING must refuse (DB in use)"
docker exec myturn-r1 node server/backup.js restore "/data/backups/$bk" --yes 2>&1
docker restart myturn-r1 | Out-Null; Start-Sleep 3
"--- ownership after restart (backups dir created by root exec must be node-owned again)"; docker exec myturn-r1 sh -c "ls -ln /data /data/backups"
"--- app still healthy and able to write after the root-owned files were fixed"; Curl @('http://127.0.0.1:18080/healthz'); ''

Show 'E. maintenance-mode restore'
docker stop myturn-r1 | Out-Null
docker run -d --name myturn-r2 -p 18081:8080 -v myturn_rehearsal:/data @(Env-Args @('-e','MYTURN_MAINTENANCE=1')) myturn:local | Out-Null; Start-Sleep 2
"--- maintenance logs"; docker logs myturn-r2 2>&1
"--- healthz while in maintenance (expect connection failure/no answer)"; Curl @('-o','NUL','-w','%{http_code}','http://127.0.0.1:18081/healthz'); ''
"--- restore in maintenance mode"
docker exec myturn-r2 node server/backup.js restore "/data/backups/$bk" --yes 2>&1
"--- /data after restore (previous DB kept as .pre-restore-*)"; docker exec myturn-r2 sh -c "ls -la /data"
docker rm -f myturn-r2 | Out-Null
docker start myturn-r1 | Out-Null; Start-Sleep 3
"--- app after leaving maintenance: healthz + state rev"; Curl @('http://127.0.0.1:18080/healthz'); ''
$rev3 = ((Curl @('-H','Host: myturn.example','http://127.0.0.1:18080/api/state')) | ConvertFrom-Json).rev; "rev after restore: $rev3"
"--- ownership of restored files (restore ran as root; entrypoint must have fixed it)"; docker exec myturn-r1 sh -c "ls -ln /data | head -8"

Show 'F. cleanup (only objects created by this rehearsal)'
docker rm -f myturn-r1 myturn-r2 myturn-nov 2>$null | Out-Null
docker volume rm -f myturn_rehearsal | Out-Null
docker ps -a --filter name=myturn --format '{{.Names}}'; docker volume ls --filter name=myturn --format '{{.Name}}'; "cleanup done"
