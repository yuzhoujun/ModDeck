# Changelog

[简体中文 (CHANGELOG.zh-CN.md)](CHANGELOG.zh-CN.md) | [v1.0.0 - v2.5.0 Archive](docs/CHANGELOG_V2_ARCHIVE.md)

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning 2.0.0](https://semver.org/).

## [Unreleased]

### Added

- **Per-Game Roster Scheme Storage & Seamless Auto-Migration**: Split roster schemes from root `%APPDATA%\ModDeck\roster-presets.json` into per-game `%APPDATA%\ModDeck\presets\<gameId>\roster-presets.json` automatically on startup/access, while maintaining full backwards compatibility and per-item ID merging when importing legacy `.moddeck-bundle` archives.
- **Optional `d3dx.ini` Loader Rule Toggles (`Settings -> Environment`)**: Added direct toggles for `[Include]` `exclude_recursive = DISABLED*` and `[Rendering]` `cache_shaders = 1 / 0` in `d3dx.ini`, refactored game cards with color-coded rule rows + full root path headers, and separated **ModDeck Library & Audit Ignores** (`EFMI-MCP`, `_*`, `.*`, plus custom entries) into its own card so ModDeck filters and XXMI loader rules remain clearly distinguished.
- **Mirrored Online Update Check & One-Click Upgrade (`Settings -> About`)**: Added offline-first manual update checks (plus opt-in startup checks, off by default) with a 4-tier detection chain (`api.github.com` REST API -> rate-limit-free `github.com/releases/latest` redirect & `releases.atom` feed -> configured proxy mirror Atom / `raw.githubusercontent.com` -> channel-guarded `jsDelivr` CDN), mirror prefix selection (`Direct`, `ghfast.top`, `gh-proxy.org`, `Custom`), a non-blocking bottom-right floating update toast that triggers once per app launch with auto-fade, close button, and per-version skip persistence (`ignoredUpdateVersion`), distribution mode detection (`installer` vs `portable`), and one-click upgrades launching the interactive NSIS setup wizard (with finish-page launch and shortcut options) or portable in-place self-replacement with foreground relaunch and post-update confirmation toast, plus formatted release notes that auto-select the active Chinese/English section.

### Fixed

- **Fixed NSIS Installer Languages Folder Packaging (`#4`)**: Bundled `languages/*.json` beside `ModDeck.exe` in Windows NSIS installer packages via `tauri.conf.json` `bundle.resources`, matching the portable layout so **Open Languages Directory** opens populated built-in dictionaries directly while keeping `%APPDATA%\ModDeck\languages\` overrides functional.
- **Fixed Cross-Mod Variable Leak & Missing `__default__` Duplicate Guard on 0-Variable Mods (`#5`)**: Fixed `read_active_d3dx_user_variables` fallback branch ingesting unrelated `$\\mods\\...` entries from `d3dx_user.ini` when a mod declared zero `persist` variables (e.g. INI-toggle UI mods), which had caused saving a new preset on Default to bypass duplicate protection against `__default__`.
- **Localized `"Default"` Duplicate Error & Reserved Name Guard**: Fixed `save_mod_preset` returning hardcoded Chinese `"默认"` when matching `__default__` under non-Chinese UI locales, and rejected reserved default preset names (`Default`, `默认`, `默认 (初始)`) when creating custom mod presets.
- Aligned global conflict audit folder skipping in `ini_analysis` with `library` rules so internal bridge folders (such as `_ModDeck_Preset_Bridge`) and external tool sandboxes do not produce false conflict warnings.

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
