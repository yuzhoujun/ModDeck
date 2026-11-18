# Changelog

[简体中文 (CHANGELOG.zh-CN.md)](CHANGELOG.zh-CN.md) | [v1.0.0 - v2.5.0 Archive](docs/CHANGELOG_V2_ARCHIVE.md)

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning 2.0.0](https://semver.org/).

## [3.0.1] - 2026-11-19

### Added

- **Windows NSIS Installer & Uninstaller (`ModDeck-<version>-win-x64-setup.exe`)**: Added native NSIS installer packaging alongside the portable ZIP (`npm run package:installer`), supporting English/Simplified Chinese OS language matching, registry install-path persistence for automatic in-place upgrade targeting (`RestorePreviousInstallLocation`), and custom uninstaller hooks (`src-tauri/windows/hooks.nsh`) that also remove `%APPDATA%\ModDeck\` when opting into "Delete app data".
- **Legacy Electron Data Detection & Cleanup**: Added `clean_legacy_electron_data` plus startup banner and **Settings -> Storage & Backups** card to detect and safely clear obsolete Electron v2 Chromium caches, `ModDeckKeyHelper-v2`, `mod-presets.json`, and v2 logs for upgrading portable and installer users without touching current presets, covers, settings, or backups.
- **In-Repo Roadmap & Backlog**: Added `docs/ROADMAP.md` and `docs/ROADMAP.zh-CN.md` to track upcoming releases (`v3.1.0` per-game roster scheme split & mirrored online updater) and open ideas.

### Fixed

- Updated runtime labels under **Settings -> About** (`App Framework` / `Backend Core`) to accurately reflect Tauri 2 + Rust instead of Electron / Node.js.

## [3.0.0] - 2026-11-19

### Added

- **Tauri 2 + Rust Backend Migration**: Replaced the Electron main process, Chromium runtime, and external `ModDeckKeyHelper` executable with a single native `ModDeck.exe` powered by Tauri 2, Rust, and system WebView2.
- **Native Archive & Encoding Engine**: Built-in Rust handlers for `.zip`, `.7z`, and `.rar` streaming extraction, multi-charset entry auto-repair (`UTF-8`, `CP437`, `GB18030`, `Big5`, `Shift-JIS`, `EUC-KR`), encrypted archive password prompts, and automatic cleanup of HTML5 drag-and-drop staging folders.
- **Import Target Editing & Manual Upgrade Selection**: Added inline target folder renaming and per-candidate existing mod replacement selection in `ImportPreviewModal`, supporting backups for matching disabled folders (`DISABLED_<name>`).
- **INI Hotkey Type Awareness**: Extended `.ini` hotkey extraction to parse `type` per section and label `type = hold`, modifier-only triggers (`CTRL ALT`), and mouse buttons (`VK_LBUTTON`) cleanly with non-clickable passive badges in both Mod Details and `overlay-detail`.
- **WebView2 Runtime Preflight Check**: Detects missing Evergreen WebView2 Runtime entries in the Windows Registry at startup and offers a localized prompt linking to Microsoft's official download page.
- **Native Windows Integrations**: Implemented Win32 `SendInput` hotkey simulation (including punctuation keys, `VK_*`, hex keys, and `no_*` modifier releases), `CreateToolhelp32Snapshot` game process detection, `ShellExecuteW` UAC launcher elevation fallback, `FindFirstChangeNotificationW` directory/file watchers (`Mods` and `d3dx_user.ini`), Recycle Bin deletion (`trash`), and a localized system tray icon.

### Changed

- **Portable Distribution Layout**: Portable builds now package a single `ModDeck.exe` alongside `languages/` dictionaries and `README.txt`, removing `ModDeck.cmd`, Electron runtime `.dll`/`.pak` files, and `--no-sandbox` workarounds while retaining full compatibility with `%APPDATA%\ModDeck\`.
- **Mod Details & Multi-Select UX**: Converted mod deletion confirmation to an in-app modal before trashing, added batch Select All / Clear / Delete in multi-select mode, moved variable/diagnostic details into a scrollable inspection modal, simplified mod card subtitles, updated the default Quick Overlay hotkey to `Alt+\`, and made Roster Scheme pool actions mouse-only (removing `Alt+U` / `Alt+R` bindings).
- **Documentation & CI Structure**: Adopted English primary docs (`README.md`, `CHANGELOG.md`, `docs/`) with Simplified Chinese mirrors (`README.zh-CN.md`, `CHANGELOG.zh-CN.md`), and updated GitHub CI workflows to run `typecheck`, `i18n:check`, `cargo test`, and `tauri build --no-bundle`.

### Fixed

- Fixed WebView2 startup initialization failure on accounts or folders with restrictive ACLs via automatic `EBWebView-recovery` fallback in `AppData\Local`.
- Fixed UI deadlock when opening the floating `overlay-detail` sidecar window on Windows by pre-initializing it in setup and moving creation/navigation off the synchronous UI thread.
- Fixed `open_path` resolving `"data"`, `"logs"`, `"languages"`, `"game"`, and `"loader"` targets properly (using `explorer.exe /select` for executable files).
- Fixed `set_overlay_hotkey` and `set_reload_hotkey` to reject conflicting assignments with the reload hotkey.
- Fixed unreadable pale background on dirty `.roster-mod-preset-select` dropdown menus in WebView2.

### Removed

- Removed legacy Electron source (`src/main`, `src/preload`), build/typecheck configs (`electron.vite.config.ts`, `tsconfig.node.json`, `scripts/prepare-smoke.mjs`), Electron/Chromium runtime dependencies (`electron`, `electron-builder`, `electron-vite`, `7zip-bin`, `node-unrar-js`), `ModDeck.cmd` wrapper, and external key-helper binaries from `main` (preserved on `legacy/electron`).
