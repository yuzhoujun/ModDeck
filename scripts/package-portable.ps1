$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
$outputDir = Join-Path $root 'release'
$appDir = Join-Path $outputDir 'win-unpacked'
$zipPath = Join-Path $outputDir "ModDeck-$version-win-x64.zip"
$tempRoot = Join-Path $root 'temp'
$customTmp = Join-Path $tempRoot 'tmp'
New-Item -ItemType Directory -Force $tempRoot, $outputDir, $customTmp | Out-Null
$env:TMP = $customTmp
$env:TEMP = $customTmp

Write-Host "Building ModDeck $version ..."
node node_modules/electron-vite/bin/electron-vite.js build
if ($LASTEXITCODE -ne 0) { throw 'electron-vite build failed' }

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CACHE = Join-Path $tempRoot 'electron-cache'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_BUILDER_CACHE = Join-Path $tempRoot 'electron-builder-cache'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
node node_modules/electron-builder/out/cli/cli.js --win --x64 --dir --publish never "--config.directories.output=$outputDir"
if ($LASTEXITCODE -ne 0) { throw 'electron-builder --dir failed' }

Copy-Item 'packaging\README-portable.txt' (Join-Path $appDir 'README.txt') -Force
Copy-Item 'packaging\ModDeck.cmd' (Join-Path $appDir 'ModDeck.cmd') -Force
$langDir = Join-Path $appDir 'languages'
New-Item -ItemType Directory -Force $langDir | Out-Null
Copy-Item 'src\shared\i18n\locales\*' $langDir -Force
if (Test-Path (Join-Path $appDir 'locales\locales')) { Remove-Item (Join-Path $appDir 'locales\locales') -Recurse -Force }

$sevenZipCandidates = @()
if ($env:ProgramFiles) { $sevenZipCandidates += Join-Path $env:ProgramFiles '7-Zip\7z.exe' }
if (${env:ProgramFiles(x86)}) { $sevenZipCandidates += Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe' }
if ($env:LOCALAPPDATA) { $sevenZipCandidates += Join-Path $env:LOCALAPPDATA 'Programs\7-Zip\7z.exe' }
$sevenZip = $sevenZipCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sevenZip) {
  $found = Get-Command 7z -ErrorAction SilentlyContinue
  if ($found) { $sevenZip = $found.Source }
}
if (-not $sevenZip) {
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

$finalUnpacked = Join-Path $outputDir 'win-unpacked'
if (Test-Path $finalUnpacked) {
  Remove-Item $finalUnpacked -Recurse -Force -ErrorAction SilentlyContinue
}
Copy-Item $appDir $finalUnpacked -Recurse -Force -ErrorAction SilentlyContinue

$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Write-Host ""
Write-Host "ZIP:    $zipPath"
Write-Host "SHA256: $hash"
