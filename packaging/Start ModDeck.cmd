@echo off
cd /d "%~dp0"

if not exist "resources\app.asar" (
  echo.
  echo [ModDeck] resources\app.asar is missing.
  echo Please extract the whole ZIP before running ModDeck.
  echo.
  pause
  exit /b 1
)

start "" "%~dp0ModDeck.exe" --no-sandbox
