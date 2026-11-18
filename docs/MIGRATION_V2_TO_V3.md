# Migrating from ModDeck v2 (Electron) to v3 (Tauri 2)

[简体中文 (MIGRATION_V2_TO_V3.zh-CN.md)](MIGRATION_V2_TO_V3.zh-CN.md)

ModDeck v3 replaces the Electron / Chromium shell with Tauri 2, Rust, and Windows WebView2 while preserving **100% schema and directory compatibility** under `%APPDATA%\ModDeck\`.

---

## 1. Zero-Loss Automatic Data Inheritance

Both v2.x and v3.x store all user data in the exact same location and file formats:

- **Default directory**: `%APPDATA%\ModDeck\`
- **Portable fallback directory**: `ModDeck-data\` next to `ModDeck.exe` (when AppData is unavailable/read-only)

Your existing data is automatically loaded on first launch of v3:

- `settings.json` (game paths, custom games, hotkeys, ignore rules, and UI preferences)
- `roster-presets.json` (all saved dual-pool roster schemes)
- `presets/{gameId}/{character}/{mod}.json` (all single-mod variant presets)
- `characters.json`, `roster-cache.json`, and `covers/`
- `backups/` (all previous mod overwrite backups) and `languages/` (community locale files)

---

## 2. How to Upgrade Safely

1. Close ModDeck v2 completely (check the system tray icon as well).
2. Download and extract `ModDeck-3.x.x-win-x64.zip` into a clean folder (or clear out old Electron files such as `icudtl.dat`, `resources.pak`, `dxcompiler.dll`, `ModDeck.cmd`, and `resources/` before extracting v3 into the same folder).
3. Launch `ModDeck.exe`.
   - Do **not** mix old v2 `.dll` / `resources/` files with the single-file v3 executable—delete the old Electron program files (not `%APPDATA%\ModDeck\`) if replacing in-place.
4. Optional backup: before upgrading, you can export a `.moddeck-bundle` archive under **Settings -> Storage & Backup** for peace of mind.

---

## 3. Clean-Up Notes for `%APPDATA%\ModDeck\`

If you inspect `%APPDATA%\ModDeck\` after moving to v3:

- Old Electron Chromium cache folders (`Cache/`, `GPUCache/`, `Code Cache/`, `DawnGraphiteCache/`, `Session Storage/`, etc.) may remain from v2 and are unused by Tauri/WebView2 (WebView2 stores its browser cache in `%LOCALAPPDATA%\dev.moddeck.desktop\`).
- Deleting old Electron cache folders is optional and safe; **never delete `settings.json`, `presets/`, `roster-presets.json`, `characters.json`, `covers/`, or `backups/`** unless you intend to reset your ModDeck configuration.
- Note that ModDeck v3's portable directory uses `ModDeck.exe` directly and no longer uses `ModDeck.cmd` or `--no-sandbox`.
