<#
  MyTurn - consistent online backup of the LIVE database on the weeny server, downloaded to this machine and verified.
  Read-only for the live database (SQLite VACUUM INTO from a separate connection); it never restores or changes anything live.

    powershell -File scripts\backup-live.ps1                 # backup + download + verify
    powershell -File scripts\backup-live.ps1 -SshHost <alias> # if you have more than one weeny host in ~/.ssh/config

  Server side:  /data/myturn-backups/myturn-<UTC>.db   (outside the active database directory /data/myturn)
  Local copy:   $LocalDir\myturn-<UTC>.db              (default %USERPROFILE%\MyTurn-backups; contains personal data - keep it private/encrypted)
  A backup is "recoverable" only after a restore has been rehearsed (see DEPLOYMENT.md, section "Backups and restore").
#>
param(
  [string]$SshHost,
  [string]$App = 'myturn',
  [string]$LocalDir = (Join-Path $env:USERPROFILE 'MyTurn-backups'),
  [string]$RemoteDbPath = '/data/myturn/myturn.db',
  [string]$RemoteBackupDir = '/data/myturn-backups'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
if (-not $SshHost) {                                       # the weeny CLI registers exactly one "Host weeny-<id>" block per server in ~/.ssh/config
  $cfg = Join-Path $env:USERPROFILE '.ssh\config'
  $found = @(); if (Test-Path $cfg) { $found = @(Select-String -Path $cfg -Pattern '^\s*Host\s+(weeny-\S+)\s*$' | ForEach-Object { $_.Matches[0].Groups[1].Value }) }
  if ($found.Count -ne 1) { throw "Pass -SshHost <alias> (found $($found.Count) weeny hosts in ~/.ssh/config)." }
  $SshHost = $found[0]
}
New-Item -ItemType Directory -Force $LocalDir | Out-Null
$remote = @"
set -e
cd /apps/$App/current
DATABASE_PATH='$RemoteDbPath' NODE_ENV=production node server/backup.js backup '$RemoteBackupDir/' 2>&1
f=`$(ls -1t '$RemoteBackupDir' | head -1)
echo "FILE=`$f"
echo "SHA=`$(sha256sum '$RemoteBackupDir/'`$f | cut -d' ' -f1)"
"@ -replace "`r", ''
$tmp = Join-Path $env:TEMP ('myturn-backup-' + [guid]::NewGuid().ToString('N') + '.sh')   # LF, no BOM: Windows PowerShell would otherwise pipe a BOM into bash
[IO.File]::WriteAllText($tmp, $remote, (New-Object Text.UTF8Encoding($false)))
try { $out = cmd /c "ssh -o BatchMode=yes $SshHost bash -s < `"$tmp`" 2>&1" } finally { [IO.File]::WriteAllText($tmp, '') }
$out | Where-Object { $_ -notmatch '^(FILE|SHA)=' } | ForEach-Object { "  server: $_" }
$file = ($out | Where-Object { $_ -match '^FILE=' } | Select-Object -First 1) -replace '^FILE=', ''
$sha = ($out | Where-Object { $_ -match '^SHA=' } | Select-Object -First 1) -replace '^SHA=', ''
if (-not $file -or $file -notmatch '^myturn-\d{8}T\d{6}Z\.db$') { throw "Backup did not report a file name; output above. Nothing was downloaded." }
$dest = Join-Path $LocalDir $file
if (Test-Path -LiteralPath $dest) { throw "Local file already exists (not overwriting): $dest" }
scp -o BatchMode=yes "${SshHost}:$RemoteBackupDir/$file" $dest
if ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower() -ne $sha.Trim().ToLower()) { throw "Checksum mismatch after download: $dest" }
Push-Location $root; try { node server/backup.js verify $dest } finally { Pop-Location }
"Downloaded and verified: $dest"
"Server copy:            $RemoteBackupDir/$file  (sha256 $sha)"
