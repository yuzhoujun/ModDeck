$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
$buildRootName = if ($env:MODDECK_BUILD_ROOT) { $env:MODDECK_BUILD_ROOT } else { 'release' }
$buildRoot = Join-Path $root $buildRootName
$outputDir = Join-Path $root 'release'
$appDir = Join-Path $buildRoot 'win-unpacked'
$zipPath = Join-Path $outputDir "ModDeck-$version-win-x64.zip"
$tempRoot = Join-Path (Split-Path -Parent $root) 'temp'
New-Item -ItemType Directory -Force $tempRoot, $outputDir | Out-Null

Write-Host "Building ModDeck $version ..."
node node_modules/electron-vite/bin/electron-vite.js build
if ($LASTEXITCODE -ne 0) { throw 'electron-vite build failed' }

$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_CACHE = Join-Path $tempRoot 'electron-cache'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
$env:ELECTRON_BUILDER_CACHE = Join-Path $tempRoot 'electron-builder-cache'
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
node node_modules/electron-builder/out/cli/cli.js --win --x64 --dir --publish never "--config.directories.output=$buildRoot"
if ($LASTEXITCODE -ne 0) { throw 'electron-builder --dir failed' }

Copy-Item 'packaging\README-portable.txt' (Join-Path $appDir 'README.txt') -Force
Copy-Item 'packaging\ModDeck.cmd' (Join-Path $appDir 'ModDeck.cmd') -Force

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
