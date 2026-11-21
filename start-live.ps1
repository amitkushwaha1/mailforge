# ============================================================
#  MailForge Live Launcher
#  Starts: (1) the MailForge server with password gate
#          (2) a Cloudflare quick tunnel -> public HTTPS URL
#  Saves the current public URL to live-url.txt
#  Put a shortcut to this script in the Windows Startup folder
#  so everything comes back automatically after you sign in.
# ============================================================
$dir = "C:\Users\dell\bulk-mailer"
Set-Location $dir

# --- 1. stop old instances (only ours) ---
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

# --- 3. start Cloudflare quick tunnel ---
Remove-Item "$dir\tunnel.log", "$dir\tunnel-err.log" -ErrorAction SilentlyContinue
Start-Process -WindowStyle Hidden -FilePath "$dir\cloudflared.exe" `
  -ArgumentList "tunnel", "--url", "http://localhost:3456" `
  -RedirectStandardOutput "$dir\tunnel.log" `
  -RedirectStandardError "$dir\tunnel-err.log"

# --- 4. wait for the public URL (quick tunnels get a new one each run) ---
$url = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path "$dir\tunnel-err.log") {
    $m = Select-String -Path "$dir\tunnel-err.log" -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -ErrorAction SilentlyContinue
    if ($m) { $url = $m.Matches[0].Value; break }
  }
}
if ($url) {
  Set-Content "$dir\live-url.txt" $url -Encoding utf8
  Write-Host "MailForge LIVE: $url"
} else {
  Write-Host "WARNING: tunnel URL not found - check tunnel-err.log"
}
