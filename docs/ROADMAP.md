# ModDeck Roadmap & Backlog

[简体中文 (ROADMAP.zh-CN.md)](ROADMAP.zh-CN.md) | [Changelog](../CHANGELOG.md)

This document serves as the persistent in-repo tracker for upcoming versions, architectural improvements, small feature ideas, and bug notes after ModDeck `v3.0.0`. For public bug/feature threads, also check [GitHub Issues](https://github.com/yuzhoujun/ModDeck/issues).

---

## Completed Milestones (Archive Summary)

### v3.0.0 — Tauri 2 + Rust Migration (Released 2026-11-19)

- Replaced Electron and Chromium with Tauri 2, Rust, and Windows WebView2 across all core features (~3.5 MB portable ZIP), while archiving Electron `v2.5.0` on branch `legacy/electron`.
- Added native archive/charset handling, INI hotkey type diagnostics (`hold` / modifier-only / mouse), import upgrade target selection, WebView2 runtime preflight, and bilingual Route A documentation.

### v3.0.1 — Windows Installer & Legacy Data Cleanup (Current Release)

- Added Windows NSIS installer (`ModDeck-3.0.1-win-x64-setup.exe`) with registry-backed upgrade path resolution (`HKCU\Software\yuzhoujun\ModDeck`) and optional deletion of `%APPDATA%\ModDeck\` + WebView2 data when opting into "Delete app data" on uninstall.
- Added startup and `Settings -> Storage & Backups` detection with one-click safe cleanup for obsolete Electron v2 caches/helpers (`Cache`, `GPUCache`, `GrShaderCache`, `bin/ModDeckKeyHelper-v2.*`, `mod-presets.json`, legacy logs) while preserving all user presets, covers, settings, and backups.

---

## Planned: v3.1.0 (Storage Isolation & Remote Updates)

- **Per-Game Roster Scheme Storage & Seamless Auto-Migration**:
  - Split `%APPDATA%\ModDeck\roster-presets.json` into per-game files under `%APPDATA%\ModDeck\presets\<gameId>\roster-presets.json` (matching the existing `presets/<gameId>/<character>/<mod>.json` isolation model) so multi-game setups remain tidy.
  - Perform automatic non-destructive migration from root `roster-presets.json` on startup/read and retain backwards-compatible `.moddeck-bundle` import support for `v2.5.0` / `v3.0.x` archives.
- **In-App Update Check & Mirrored One-Click Upgrade**:
  - Query latest version metadata from GitHub Releases API / release manifest with user-selectable GitHub mirror endpoints (supporting mainland China acceleration links and direct GitHub fallback).
  - For installer builds, download `ModDeck-<ver>-win-x64-setup.exe` and trigger silent in-place upgrade over the registry-tracked install location (`RestorePreviousInstallLocation` — no environment variable clutter needed); for portable builds, download and guide clean replacement.

---

## Exploratory Backlog & Ideas Scratchpad

> Add new bugs, small UX polish notes, or future ideas directly below as bullet items so nothing gets lost between development cycles.

### Core Engine & Compatibility

- **Complex `[CommandList]` / Float Slider Variant Support**: Explore lightweight AST/expression evaluation for non-discrete sliders and interdependent conditional variable chains in 3DMigoto `.ini` files.
- **Live Verification Beyond Endfield (EFMI)**: Collect community verification feedback and per-game quirks for Wuthering Waves (WWMI), Honkai: Star Rail (SRMI), Zenless Zone Zero (ZZMI), and Neverness to Everness (NEMI).

### Small Polish & Bug Notes

- *(Append minor bug notes or UI ideas here anytime.)*
- **Mod Conflict Audit Hotkey Collision Checks**: Add INI hotkey conflict scanning across both the whole-game audit and per-character views (visually separated from Shader/Texture Hash and FX risks).
- **Optional `d3dx.ini` `cache_shaders` Toggle in Environment Check**:
  - Surface `[Rendering] cache_shaders = 1` as an optional performance check/toggle under **Settings -> Environment** (lossless visual quality; caches compiled shaders into `ShaderCache/` to reduce loading/F10 stutters), paired with the existing **Clear ShaderCache** action.
  - **XXMI Overwrite Behavior Verified**: Unlike `hunting` or `enforce_rendering` keys in `XXMI Launcher Config.json`, `cache_shaders` is not listed for per-launch override when `manage_xxmi_dll_config = true`; it is only reset to `0` if an importer package update re-deploys `d3dx.ini` (`overwrite_ini = true`), so ModDeck can check and restore it cleanly just like `exclude_recursive`.
