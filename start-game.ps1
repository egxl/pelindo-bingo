$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

$CloudflaredPath = Join-Path $Root "tools\cloudflared.exe"
if (-not (Test-Path $CloudflaredPath)) {
    Write-Host "[PELINDO!] Mengunduh portable cloudflared.exe (tanpa admin)..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path (Join-Path $Root "tools") | Out-Null
    Invoke-WebRequest -Uri "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -OutFile $CloudflaredPath
}

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Host "[PELINDO!] Menginstall dependency npm (qrcode)..." -ForegroundColor Cyan
    npm install
}

$TunnelLog = Join-Path $env:TEMP "pelindo-cloudflared.log"
if (Test-Path $TunnelLog) { Remove-Item $TunnelLog -Force }

Write-Host "[PELINDO!] Menjalankan server lokal di 127.0.0.1:3000..." -ForegroundColor Green
$NodeProc = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $Root -PassThru -NoNewWindow

Start-Sleep -Milliseconds 700

Write-Host "[PELINDO!] Membuka Cloudflare Quick Tunnel (http2)..." -ForegroundColor Green
$TunnelProc = Start-Process -FilePath $CloudflaredPath -ArgumentList "tunnel", "--protocol", "http2", "--url", "http://127.0.0.1:3000", "--logfile", $TunnelLog -PassThru -NoNewWindow

$PublicUrl = $null
$Registered = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Path $TunnelLog) {
        if (-not $PublicUrl) {
            $Match = Select-String -Path $TunnelLog -Pattern "https://[a-z0-9-]+\.trycloudflare\.com" -AllMatches | Select-Object -First 1
            if ($Match) { $PublicUrl = $Match.Matches[0].Value }
        }
        if ($PublicUrl -and (Select-String -Path $TunnelLog -Pattern "Registered tunnel connection" -Quiet)) {
            $Registered = $true
            break
        }
    }
}

if ($PublicUrl -and $Registered) {
    Start-Sleep -Seconds 2
    Write-Host "[PELINDO!] Tunnel aktif & terdaftar: $PublicUrl" -ForegroundColor Cyan
    $Body = @{ url = $PublicUrl } | ConvertTo-Json
    Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/host/set-url" -Method POST -ContentType "application/json" -Body $Body | Out-Null
} else {
    Write-Host "[PERINGATAN] Tunnel belum terdaftar dalam 30 detik. Host tetap berjalan di http://127.0.0.1:3000/host" -ForegroundColor Yellow
}

Start-Process "http://127.0.0.1:3000/host"
Write-Host "[PELINDO!] Layar proyektor dibuka. Tekan Ctrl+C untuk menghentikan server & tunnel." -ForegroundColor Cyan

try {
    Wait-Process -Id $NodeProc.Id
} finally {
    if ($TunnelProc -and -not $TunnelProc.HasExited) { Stop-Process -Id $TunnelProc.Id -Force }
    if ($NodeProc -and -not $NodeProc.HasExited) { Stop-Process -Id $NodeProc.Id -Force }
}
