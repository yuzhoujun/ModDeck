# ModDeck Roadmap & Backlog

[简体中文 (ROADMAP.zh-CN.md)](ROADMAP.zh-CN.md) | [Changelog](../CHANGELOG.md)

This document serves as the persistent in-repo tracker for upcoming versions, architectural improvements, small feature ideas, and bug notes after ModDeck `v3.0.0`. For public bug/feature threads, also check [GitHub Issues](https://github.com/yuzhoujun/ModDeck/issues).

---

## Completed Milestones (Archive Summary)

### v3.0.0 — Tauri 2 + Rust Migration (Released 2026-11-19)

- Replaced Electron and Chromium with Tauri 2, Rust, and Windows WebView2 across all core features (~3.5 MB portable ZIP), while archiving Electron `v2.5.0` on branch `legacy/electron`.
- Added native archive/charset handling, INI hotkey type diagnostics (`hold` / modifier-only / mouse), import upgrade target selection, WebView2 runtime preflight, and bilingual Route A documentation.

### v3.0.1 — Windows Installer & Legacy Data Cleanup (Released 2026-11-19)

- Added Windows NSIS installer (`ModDeck-3.0.1-win-x64-setup.exe`) with registry-backed upgrade path resolution (`HKCU\Software\yuzhoujun\ModDeck`) and optional deletion of `%APPDATA%\ModDeck\` + WebView2 data when opting into "Delete app data" on uninstall.
- Added startup and `Settings -> Storage & Backups` detection with one-click safe cleanup for obsolete Electron v2 caches/helpers (`Cache`, `GPUCache`, `GrShaderCache`, `bin/ModDeckKeyHelper-v2.*`, `mod-presets.json`, legacy logs) while preserving all user presets, covers, settings, and backups.

### v3.1.0 — Per-Game Roster Presets, Mirrored Updater & Loader Rule Toggles (Current Release, 2026-11-23)

- Split `%APPDATA%\ModDeck\roster-presets.json` into per-game files under `%APPDATA%\ModDeck\presets\<gameId>\roster-presets.json` with automatic startup/read migration and legacy `.moddeck-bundle` import merging.
- Added 4-tier mirrored online update checks (`github-api`, `github-web` / `github-atom`, mirror Atom / `raw-fallback`, channel-guarded `jsDelivr`), non-blocking bottom-right update & post-update floating toasts (`ignoredUpdateVersion`, `--updated-from`), interactive NSIS upgrade wizard finish options, and localized Markdown release note rendering.
- Added direct `d3dx.ini` toggles (`exclude_recursive = DISABLED*`, `cache_shaders = 1 / 0`), redesigned Environment game cards, separated ModDeck-only ignore directories (`EFMI-MCP`, `_*`, `.*`, custom), bundled `languages/` in NSIS installers (`#4`), and fixed 0-variable mod `d3dx_user.ini` cross-mod leaks (`#5`).

---

## Planned: v3.2.0 (Static INI Audit & Diagnostics Upgrade)

- **Cross-Mod `IniParams` (`x100..x255`) Write Contention & `[Present]` Guard Checks (High Priority)**:
  - Parse `[Present]` (and called `[CommandList*]`) assignments targeting global `x100..x255` registers to flag unguarded writes missing `$object_detected` / `$active` conditions.
  - Detect cross-mod conflicts when an enabled mod writes `xN` (`N >= 100`) unconditionally while another active mod reads/writes `xN` (including `post run = CustomShader*`), highlighting both files/lines and clearly distinguishing same-character guaranteed collisions vs multi-character shared-template risks (only active when rendered concurrently).
- **Tiered Mod Conflict Audit Hotkey Collision Checks & Modal Category Filters**:
  - Scan active `[Key*]` bindings with low-noise severity separation: same-character mod key collisions or unguarded global hotkeys (missing `$active` / `condition`) surface as `warning`; cross-character coincidental key reuse groups into a collapsible `info` section so alerts stay high-signal.
  - Add category filter pills in the Conflict Audit modal (All / Shader & FX / IniParams & Registers / Hotkeys).
- **Small-Index Unguarded `handling = skip` & EFMI Architecture Advisories**:
  - Emit a low-noise advisory for `[TextureOverride*]` sections containing `handling = skip` with small index counts (`match_index_count <= 24`) and zero `$` variable guards, avoiding false positives on normal single-character mesh hides.
  - For Arknights: Endfield (`game_id == "endfield"` / `loader == "EFMI"`), flag legacy `CrossIBClassifier` / `record_bones_cs` / `redirect_cb1_cs` references and check `$required_efmi_version` mismatch advisories.
- **Oversized `.dds` Texture (`> 32 MiB`) Loading Stall Hint**:
  - Flag oversized single `.dds` files (`> 32 MiB`, such as `8192×8192`) by fast file-size inspection (zero heavy DDS decoding dependencies) in Mod Details / Static Diagnostics and aggregate them in Global Audit (`info`) complementing `cache_shaders = 1`.
- **One-Click Compact Markdown Diagnostic Context Copy**:
  - Add a "Copy Diagnostic Summary" button in the Conflict Audit modal exporting sanitized relative paths, conflict hashes/registers/hotkeys, `.ini` line numbers, and `d3dx.ini` status as compact Markdown for pasting into AI sessions or `EFMI-MCP`.
- **Release Notes Extraction on Non-API Update Fallbacks**:
  - Parse sanitized `<content type="html">` from `releases.atom` (or release tag pages on `github-web` / `mirror-atom`) following the standardized `## English` / `## 简体中文` Release template, so formatted release notes still render cleanly in **Settings -> About** when `api.github.com` is rate-limited.

---

## Exploratory Backlog & Ideas Scratchpad

> Add new bugs, small UX polish notes, or future ideas directly below as bullet items so nothing gets lost between development cycles.

### Core Engine & Compatibility

- **Complex `[CommandList]` / Float Slider Variant Support**: Explore lightweight AST/expression evaluation for non-discrete sliders and interdependent conditional variable chains in 3DMigoto `.ini` files.
- **Live Verification Beyond Endfield (EFMI)**: Collect community verification feedback and per-game quirks for Wuthering Waves (WWMI), Honkai: Star Rail (SRMI), Zenless Zone Zero (ZZMI), and Neverness to Everness (NEMI).
- **Pure-Rust DDS Inspection/Preview (On-Demand)**: Evaluate `ddsfile` + `image_dds` only if direct `.dds` preview conversion becomes necessary, keeping binary size minimal in the meantime.
- **Offline Dictionary & Portrait Maintenance**: Reference external asset pipelines such as `EndfieldStudio` when updating `roster.json` names/covers offline without adding unpacker code into the client.

### Small Polish & Bug Notes

- *(Append minor bug notes or UI ideas here anytime.)*
