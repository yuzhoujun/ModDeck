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
$stageDir = Join-Path $outputDir 'win-unpacked'
$zipPath = Join-Path $outputDir "ModDeck-$version-win-x64.zip"

New-Item -ItemType Directory -Force $outputDir | Out-Null

Write-Host "Running typecheck & i18n verification..."
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
npm run i18n:check
if ($LASTEXITCODE -ne 0) { throw 'i18n:check failed' }

Write-Host "Running Rust tests..."
cargo test --manifest-path src-tauri/Cargo.toml
if ($LASTEXITCODE -ne 0) { throw 'cargo test failed' }

Write-Host "Building ModDeck $version (Tauri 2)..."
npx tauri build --no-bundle
if ($LASTEXITCODE -ne 0) { throw 'tauri build failed' }

$candidateExes = @()
if ($env:CARGO_TARGET_DIR) {
  $candidateExes += (Join-Path $env:CARGO_TARGET_DIR 'release\moddeck.exe')
}
$candidateExes += (Join-Path $root 'src-tauri\target\release\moddeck.exe')
$builtExe = $candidateExes | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $builtExe) {
  throw "Built executable not found in candidate paths: $($candidateExes -join ', ')"
}

if (Test-Path $stageDir) {
  Remove-Item $stageDir -Recurse -Force
}
New-Item -ItemType Directory -Force $stageDir | Out-Null

Copy-Item $builtExe (Join-Path $stageDir 'ModDeck.exe') -Force
Copy-Item 'packaging\README-portable.txt' (Join-Path $stageDir 'README.txt') -Force

$langDir = Join-Path $stageDir 'languages'
New-Item -ItemType Directory -Force $langDir | Out-Null
Copy-Item 'src\shared\i18n\locales\*' $langDir -Force

$sevenZipCandidates = @()
if ($env:ProgramFiles) { $sevenZipCandidates += Join-Path $env:ProgramFiles '7-Zip\7z.exe' }
if (${env:ProgramFiles(x86)}) { $sevenZipCandidates += Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe' }
if ($env:LOCALAPPDATA) { $sevenZipCandidates += Join-Path $env:LOCALAPPDATA 'Programs\7-Zip\7z.exe' }
$sevenZip = $sevenZipCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sevenZip) {
  $found = Get-Command 7z -ErrorAction SilentlyContinue
  if ($found) { $sevenZip = $found.Source }
}

Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
if ($sevenZip) {
  Push-Location $stageDir
  try {
    & $sevenZip a -tzip -mx=5 $zipPath '.\*' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '7-Zip compression failed' }
  } finally {
    Pop-Location
  }
} else {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stageDir,
    $zipPath,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
}

$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Write-Host ""
Write-Host "ZIP:    $zipPath"
Write-Host "SHA256: $hash"
