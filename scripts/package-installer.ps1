$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($env:USERPROFILE) {
  $cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
  if ((Test-Path $cargoBin) -and -not ($env:PATH -split ';' | Where-Object { $_ -eq $cargoBin })) {
    $env:PATH = "$cargoBin;$env:PATH"
  }
}

$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
$outputDir = Join-Path $root 'release'
$destSetup = Join-Path $outputDir "ModDeck-$version-win-x64-setup.exe"

New-Item -ItemType Directory -Force $outputDir | Out-Null

Write-Host "Running typecheck & i18n verification..."
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm run i18n:check
if ($LASTEXITCODE -ne 0) { throw 'i18n:check failed' }

Write-Host "Running Rust tests..."
cargo test --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw 'cargo test failed' }

Write-Host "Building ModDeck $version NSIS Installer (Tauri 2)..."
npx tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw 'tauri NSIS build failed' }

$nsisName = "ModDeck_${version}_x64-setup.exe"
$candidates = @()
if ($env:CARGO_TARGET_DIR) {
  $candidates += (Join-Path $env:CARGO_TARGET_DIR "release\bundle\nsis\$nsisName")
}
$candidates += (Join-Path $root "src-tauri\target\release\bundle\nsis\$nsisName")

$builtSetup = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $builtSetup) {
  $searchRoots = @()
  if ($env:CARGO_TARGET_DIR -and (Test-Path $env:CARGO_TARGET_DIR)) { $searchRoots += $env:CARGO_TARGET_DIR }
  $localTarget = Join-Path $root 'src-tauri\target'
  if (Test-Path $localTarget) { $searchRoots += $localTarget }
  $builtSetup = Get-ChildItem -Path $searchRoots -Recurse -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $builtSetup) {
  throw "Built NSIS setup executable not found in candidate paths: $($candidates -join ', ')"
}

Copy-Item $builtSetup $destSetup -Force
$hash = (Get-FileHash $destSetup -Algorithm SHA256).Hash
Write-Host ""
Write-Host "SETUP:  $destSetup"
Write-Host "SHA256: $hash"
