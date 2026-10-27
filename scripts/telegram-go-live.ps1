<#
  MyTurn - connect the Telegram bot to the LIVE weeny deployment (or roll it back / inspect it).
  You run this yourself: it asks for the bot token with a hidden prompt, so the token is never typed into chat, a file, git or logs.

    powershell -File scripts\telegram-go-live.ps1              # set token+secret on the server, wait for health, register the webhook
    powershell -File scripts\telegram-go-live.ps1 -Action info # show what Telegram has registered (token still needed)
    powershell -File scripts\telegram-go-live.ps1 -Action delete   # roll back: remove the webhook (pending updates are kept)
    powershell -File scripts\telegram-go-live.ps1 -DryRun      # print the steps, change nothing, contact nothing

  BEFORE the first real run: rotate the bot token in BotFather (/revoke or /token) - the earlier token was exposed.
  The token is sent to the server only through `weeny env` (encrypted, injected into the app process). The webhook secret is generated
  here if missing (%USERPROFILE%\.myturn-secrets\telegram-webhook-secret.txt, owner-only) and set the same way.
#>
param(
  [ValidateSet('set', 'info', 'delete')][string]$Action = 'set',
  [string]$SshHost, [string]$App = 'myturn', [string]$PublicOrigin,
  [string]$SecretFile = (Join-Path $env:USERPROFILE '.myturn-secrets\telegram-webhook-secret.txt'),
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
function Step($m) { Write-Host "==> $m" }
if (-not $SshHost) {
  $cfg = Join-Path $env:USERPROFILE '.ssh\config'; $found = @()
  if (Test-Path $cfg) { $found = @(Select-String -Path $cfg -Pattern '^\s*Host\s+(weeny-\S+)\s*$' | ForEach-Object { $_.Matches[0].Groups[1].Value }) }
  if ($found.Count -ne 1) { throw "Pass -SshHost <alias> (found $($found.Count) weeny hosts in ~/.ssh/config)." }
  $SshHost = $found[0]
}
$ssh = { param($cmd) ssh -o BatchMode=yes $SshHost $cmd 2>&1 }

# 1) public origin of the live app (not a secret)
if (-not $PublicOrigin) {
  if ($DryRun) { $PublicOrigin = 'https://<your-app>.onweeny.com' }
  else { $u = (& $ssh "weeny inspect $App" | Select-String -Pattern '^\s*url\s+(https://\S+)' | ForEach-Object { $_.Matches[0].Groups[1].Value } | Select-Object -First 1); if (-not $u) { throw 'Could not read the app URL from `weeny inspect`; pass -PublicOrigin.' }; $PublicOrigin = $u }
}
Step "Public origin: $PublicOrigin"

# 2) bot token: hidden prompt, kept only in memory
if ($DryRun) { $token = '123456789:DRYRUN-NOT-A-REAL-TOKEN-0000000' }          # a dry run never reads or needs a real token
else { $sec = Read-Host -AsSecureString 'Paste the NEW bot token from BotFather (input hidden)'; $token = [System.Net.NetworkCredential]::new('', $sec).Password }
if ($token -notmatch '^\d{5,}:[A-Za-z0-9_-]{20,}$') { throw 'That does not look like a bot token (<digits>:<secret>). Nothing was changed.' }

# 3) webhook secret: generated once, kept in an owner-only local file
if (-not (Test-Path -LiteralPath $SecretFile)) {
  Step "Generating a webhook secret in $SecretFile (owner-only)"
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force (Split-Path $SecretFile) | Out-Null
    [IO.File]::WriteAllText($SecretFile, (node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"), (New-Object Text.UTF8Encoding($false)))
    icacls (Split-Path $SecretFile) /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
  }
}
$secret = if ($DryRun -and -not (Test-Path -LiteralPath $SecretFile)) { 'x' * 43 } else { [IO.File]::ReadAllText($SecretFile).Trim() }

$env:MYTURN_SKIP_DOTENV = '1'                                   # never mix in an old local .env
$env:TELEGRAM_BOT_TOKEN = $token; $env:TELEGRAM_WEBHOOK_SECRET = $secret; $env:PUBLIC_ORIGIN = $PublicOrigin
$run = { param($a) Push-Location $root; try { node server/telegram-webhook.js $a } finally { Pop-Location } }
try {
  if ($Action -eq 'info') { Step 'Telegram webhook status'; if (-not $DryRun) { & $run 'info' } else { Write-Host '(dry run) would run: node server/telegram-webhook.js info' }; return }
  if ($Action -eq 'delete') { Step 'Removing the webhook (pending updates are kept)'; if (-not $DryRun) { & $run 'delete'; & $run 'info' } else { Write-Host '(dry run) would run: node server/telegram-webhook.js delete' }; return }

  Step 'Checking the token with Telegram (getWebhookInfo; nothing is changed yet)'
  if (-not $DryRun) { & $run 'info'; if ($LASTEXITCODE -ne 0) { throw 'Telegram rejected the token. Nothing was changed on the server.' } } else { Write-Host '(dry run) would run: node server/telegram-webhook.js info' }

  Step 'Setting TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and TELEGRAM_MODE=webhook on the server through weeny env (app restarts)'
  if (-not $DryRun) {
    $res = & $ssh "weeny env $App 'TELEGRAM_BOT_TOKEN=$token' 'TELEGRAM_WEBHOOK_SECRET=$secret' TELEGRAM_MODE=webhook"
    ($res | ForEach-Object { "$_" -replace [regex]::Escape($token), '<token>' -replace [regex]::Escape($secret), '<secret>' }) | Select-Object -First 3
  } else { Write-Host '(dry run) would run: ssh <host> weeny env <app> TELEGRAM_BOT_TOKEN=<hidden> TELEGRAM_WEBHOOK_SECRET=<hidden> TELEGRAM_MODE=webhook' }

  Step 'Waiting for /healthz: telegram=webhook and clientIp=verified (the proxy-verification gate stays in force)'
  if (-not $DryRun) {
    $ok = $false
    for ($i = 0; $i -lt 24 -and -not $ok; $i++) {
      Start-Sleep 8; $h = curl.exe -s -m 15 "$PublicOrigin/healthz"
      if ($h -match '"telegram":"webhook"' -and $h -match '"clientIp":"verified"' -and $h -match '"ok":true') { $ok = $true } else { Write-Host "  not ready yet: $h" }
    }
    if (-not $ok) { throw 'The app did not become healthy with the bot enabled. The webhook was NOT registered. See: ssh <host> journalctl -u weeny-myturn -n 40' }
  } else { Write-Host '(dry run) would poll /healthz' }

  Step 'Registering the webhook (URL = <origin>/telegram/webhook, secret token, updates: message + callback_query)'
  if (-not $DryRun) { & $run 'set'; if ($LASTEXITCODE -ne 0) { throw 'Registration failed.' }; & $run 'info' } else { Write-Host '(dry run) would run: node server/telegram-webhook.js set' }
  Write-Host "`nDone. Now send /start to your bot from a TEST Telegram account (not a real patient), then /register and /status." -ForegroundColor Green
}
finally { $token = $null; $secret = $null; $env:TELEGRAM_BOT_TOKEN = $null; $env:TELEGRAM_WEBHOOK_SECRET = $null; $env:PUBLIC_ORIGIN = $null; $env:MYTURN_SKIP_DOTENV = $null }
