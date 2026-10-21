$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$version = (Get-Content 'package.json' -Raw | ConvertFrom-Json).version
$appDir = if ($env:MODDECK_APP_DIR) {
  [IO.Path]::GetFullPath($env:MODDECK_APP_DIR)
} else {
  Join-Path $root 'release\win-unpacked'
}
$appExe = Join-Path $appDir 'ModDeck.exe'
if (-not (Test-Path $appExe)) {
  throw "ModDeck.exe not found in $appDir. Run npm run package:portable first."
}

Copy-Item 'packaging\ModDeck.cmd' (Join-Path $appDir 'ModDeck.cmd') -Force
Copy-Item 'packaging\README-portable.txt' (Join-Path $appDir 'README.txt') -Force

$isccCandidates = @(
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
  'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
  'C:\Program Files\Inno Setup 6\ISCC.exe'
)
$iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) {
  $found = Get-Command iscc -ErrorAction SilentlyContinue
  if ($found) { $iscc = $found.Source }
}
if (-not $iscc) {
  throw 'Inno Setup 6 not found. Install it, or build only the portable ZIP.'
}

& $iscc "/DMyAppVersion=$version" "/DAppDir=$appDir" 'installer\ModDeck.iss'
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed' }

Get-ChildItem (Join-Path $root 'release') -Filter 'ModDeck-*-Setup.exe' |
  Select-Object Name, Length, LastWriteTime |
  Format-Table -AutoSize
