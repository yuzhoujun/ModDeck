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

## Active Development: v3.1.0 (`3.1.0-alpha.3` Pre-release Testing)

- **Per-Game Roster Scheme Storage & Seamless Auto-Migration** (`Done in 3.1.0-alpha.1`):
  - Split `%APPDATA%\ModDeck\roster-presets.json` into per-game files under `%APPDATA%\ModDeck\presets\<gameId>\roster-presets.json` (matching the existing `presets/<gameId>/<character>/<mod>.json` isolation model) so multi-game setups remain tidy.
  - Perform automatic non-destructive migration from root `roster-presets.json` on startup/read and retain backwards-compatible `.moddeck-bundle` import support for `v2.5.0` / `v3.0.x` archives.
- **In-App Update Check & Mirrored One-Click Upgrade** (`Updated in 3.1.0-alpha.3`):
  - Uses a 4-tier detection chain (`api.github.com` -> rate-limit-free `github.com/releases/latest` redirect & `releases.atom` -> mirror proxy Atom / `raw.githubusercontent.com` -> channel-guarded `jsDelivr` CDN) with user-selectable download mirrors (`Direct`, `ghfast.top`, `gh-proxy.org`, `Custom`; offline-first with optional opt-in startup check).
  - Shows a non-blocking bottom-right floating update toast once per app process launch (unaffected by tray hide/restore), featuring hover-paused auto-fade, dismiss button, and persistent `ignoredUpdateVersion` per-version skip checkbox that resumes automatically for newer versions.
  - Detect distribution mode (`installer` vs `portable`): installer builds launch `ModDeck-<ver>-win-x64-setup.exe /P` over the registry-tracked install location (`RestorePreviousInstallLocation`); portable builds download and extract `ModDeck-<ver>-win-x64.zip` via a detached PowerShell swapper.
- **Localized Default Preset Name, Duplicate Guard & Reserved Name Validation** (`Done in 3.1.0-alpha.1`, `#5` fixed in `3.1.0-alpha.2`):
  - Fixed duplicate-preset toast messages showing hardcoded `"默认"` instead of `"Default"` in non-Chinese UI when matching `__default__`, blocked saving reserved names (`"默认"` / `"默认 (初始)"` / `"default"`), and fixed 0-variable INI mods leaking unrelated `d3dx_user.ini` keys that bypassed `__default__` duplicate detection.
- **Optional `d3dx.ini` Rule Toggles & Environment Layout** (`Done in 3.1.0-alpha.1`):
  - Surfaced `[Include] exclude_recursive = DISABLED*` and `[Rendering] cache_shaders = 1 / 0` toggles under **Settings -> Environment**, paired with existing **Clear ShaderCache** action, full root path headers, and color-coded status rows.
  - **XXMI Overwrite Behavior Verified**: Unlike `hunting` or `enforce_rendering` keys in `XXMI Launcher Config.json`, `cache_shaders` is not listed for per-launch override when `manage_xxmi_dll_config = true`; it is only reset to `0` if an importer package update re-deploys `d3dx.ini` (`overwrite_ini = true`), so ModDeck can check and restore it cleanly just like `exclude_recursive`.
- **External Tool Sandbox Isolation (e.g. `Mods\EFMI-MCP\`)** (`Done in 3.1.0-alpha.1`):
  - Excluded `EFMI-MCP`, leading-underscore (`_*`), leading-dot (`.*`), and user-configured `ignoredModDirs` folders from ModDeck library scans and conflict audits in a dedicated Environment card clearly marked ModDeck-only (does not alter `d3dx.ini`), while aligning `_`-prefixed skip rules in `ini_analysis.rs`.
- **NSIS Installer `languages/` Bundling (`#4`)** (`Fixed in 3.1.0-alpha.2`):
  - Bundled `languages/*.json` into NSIS installer resources alongside `ModDeck.exe` so **Open Languages Directory** aligns cleanly with portable builds while preserving `%APPDATA%\ModDeck\languages\` overrides.

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
