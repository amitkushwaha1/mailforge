# ============================================================
#  MailForge Live Launcher (v2 — permanent URL via Tailscale Funnel)
#  Starts: the MailForge server with password gate.
#  The public URL is PERMANENT (Tailscale Funnel -> *.ts.net)
#  and is saved in live-url.txt. Funnel config survives reboots;
#  this script re-ensures it just in case.
#  A shortcut to this script lives in the Windows Startup folder
#  so everything comes back automatically at sign-in.
# ============================================================
$dir = "C:\Users\dell\bulk-mailer"
$ts = "C:\Program Files\Tailscale\tailscale.exe"
Set-Location $dir

# --- 1. stop old instances (ours only) ---
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like "*server.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

# --- 2. start server with password gate (password read from local file) ---
$line = (Get-Content "$dir\.mailforge-password.txt" -Raw) -split "`n" | Where-Object { $_ -match '^\s*Password:' } | Select-Object -First 1
$pw = ($line -replace '^\s*Password:\s*', '').Trim()
$env:APP_PASSWORD = $pw
Start-Process -WindowStyle Hidden -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $dir
Remove-Item Env:APP_PASSWORD -ErrorAction SilentlyContinue

# --- 3. ensure Tailscale Funnel is up (idempotent; URL never changes) ---
Remove-Item "$env:TEMP\ts-funnel-bg.txt","$env:TEMP\ts-funnel-bg-err.txt" -ErrorAction SilentlyContinue
Start-Process -WindowStyle Hidden -FilePath $ts -ArgumentList "funnel","--bg","3456" `
  -RedirectStandardOutput "$env:TEMP\ts-funnel-bg.txt" `
  -RedirectStandardError "$env:TEMP\ts-funnel-bg-err.txt"

# --- 4. refresh the saved URL if the command reports one ---
for ($i = 0; $i -lt 8; $i++) {
  Start-Sleep -Seconds 1
  $out = ""
  foreach ($f in @("$env:TEMP\ts-funnel-bg.txt","$env:TEMP\ts-funnel-bg-err.txt")) {
    if (Test-Path $f) { $out += (Get-Content $f -Raw -ErrorAction SilentlyContinue) }
  }
  $m = [regex]::Match($out, "https://[a-z0-9-]+\.[a-z0-9-]+\.ts\.net")
  if ($m.Success) { Set-Content "$dir\live-url.txt" $m.Value -Encoding utf8; break }
}
Write-Host ("MailForge LIVE: " + (Get-Content "$dir\live-url.txt" -Raw).Trim())
