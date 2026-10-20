$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
$releaseDir = Join-Path $root 'release'
$appDir = Join-Path $releaseDir 'win-unpacked'
$zipPath = Join-Path $releaseDir "ModDeck-$version-win-x64.zip"

Write-Host "Building ModDeck $version ..."
node node_modules/electron-vite/bin/electron-vite.js build
if ($LASTEXITCODE -ne 0) { throw 'electron-vite build failed' }

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CACHE = 'C:\Users\Administrator\Projects\APP\.electron-cache'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_BUILDER_CACHE = 'C:\Users\Administrator\Projects\APP\.eb-cache'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
node node_modules/electron-builder/out/cli/cli.js --win --x64 --dir --publish never
if ($LASTEXITCODE -ne 0) { throw 'electron-builder --dir failed' }

Copy-Item 'packaging\README-portable.txt' (Join-Path $appDir 'README.txt') -Force
Copy-Item 'packaging\Start ModDeck.cmd' (Join-Path $appDir 'Start ModDeck.cmd') -Force

$sevenZip = 'C:\Program Files\7-Zip\7z.exe'
if (-not (Test-Path $sevenZip)) {
  $found = Get-Command 7z -ErrorAction SilentlyContinue
  if ($found) { $sevenZip = $found.Source }
}
if (-not (Test-Path $sevenZip)) {
  throw '7-Zip not found. Install 7-Zip or add 7z.exe to PATH.'
}

Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
Push-Location $appDir
try {
  & $sevenZip a -tzip -mx=5 $zipPath '.\*' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '7-Zip compression failed' }
} finally {
  Pop-Location
}

$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Write-Host ""
Write-Host "ZIP:    $zipPath"
Write-Host "SHA256: $hash"
