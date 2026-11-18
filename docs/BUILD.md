# ModDeck Build, Verification & Release Guide

[简体中文 (BUILD.zh-CN.md)](BUILD.zh-CN.md)

This document covers local development, testing, portable packaging, localization tooling, and release versioning for ModDeck v3 (Tauri 2 + Rust + React + TypeScript).

---

## 1. Prerequisites

- **OS**: Windows 10 / Windows 11 64-bit (`x64`)
- **Node.js**: v22+ (v24 recommended) & `npm`
- **Rust Toolchain**: `rustup` stable toolchain (`cargo`, `rustc`)
- **C++ Build Tools**: Visual Studio Build Tools (MSVC v143+ & Windows 10/11 SDK)
- **WebView2**: Microsoft Edge WebView2 Runtime (built into Windows 11 / modern Windows 10)
- **Packaging (Optional)**: 7-Zip (`7z.exe`) — falls back automatically to .NET `ZipFile` when unavailable

### Setup

```bash
git clone https://github.com/yuzhoujun/ModDeck.git
cd ModDeck
npm install
```

---

## 2. Development & Verification Commands

| Command | Purpose |
| --- | --- |
| `npm run tauri:dev` | Start Tauri 2 + Vite hot-reload desktop development window |
| `npm run typecheck` | Run TypeScript strict checks (`tsconfig.web.json`) |
| `npm run i18n:check` | Check `zh-CN` / `en-US` key symmetry and `t(...)` key references |
| `npm run i18n:extract` | Scan UI sources for unmapped Chinese strings |
| `npm run i18n:extract:apply` | Merge extracted entries into `zh-CN.json` with `en-US.json` TODO placeholders |
| `npm run i18n:sync` | Alphabetically sync and format locale JSON files |
| `npm run tauri:test` | Run all Rust unit & integration tests (`cargo test --manifest-path src-tauri/Cargo.toml`) |
| `npx vite build --config vite.config.ts` | Build frontend production bundle to `out/tauri-renderer/` |
| `npm run package:portable` | Run checks/tests, build Tauri release binary, and create portable ZIP + SHA256 |
| `npm run package:installer` | Run checks/tests and build Windows NSIS installer (`release/ModDeck-<version>-win-x64-setup.exe`) + SHA256 |

---

## 3. Portable Build Output (`npm run package:portable`)

`scripts/package-portable.ps1` performs:

1. Runs `npm run typecheck`, `npm run i18n:check`, and `cargo test --manifest-path src-tauri/Cargo.toml`.
2. Builds `npx tauri build --no-bundle` (outputs `moddeck.exe`).
3. Stages `release/win-unpacked/` containing:

```text
ModDeck/
├── ModDeck.exe          # Single-file Tauri 2 + Rust executable
├── README.txt           # Bilingual quick-start and troubleshooting guide
└── languages/           # Built-in zh-CN.json & en-US.json locale files
```

4. Packages `release/ModDeck-<version>-win-x64.zip` and prints its SHA256 checksum.

> Note: Keep `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` synchronized on the same SemVer 2.0.0 string.

---

## 4. Semantic Versioning & Release Workflow

ModDeck v3 strictly follows standard **SemVer 2.0.0**:

1. **Pre-release builds** (`3.0.0-alpha.N`, `3.0.0-beta.N`, `3.0.0-rc.N`):
   - Used for local verification and pushes to `main`. Not published as stable Releases (public pre-releases use `--prerelease` if ever needed).
2. **GA releases & patches** (`x.y.0`, `x.y.z`):
   - Consolidate `## [Unreleased]` changes into `## [x.y.z] - YYYY-MM-DD` in `CHANGELOG.md` and `CHANGELOG.zh-CN.md`.
   - Push `main` and annotated tag `vx.y.z` (`git tag -a vx.y.z -m "Release vx.y.z"`), then publish `release/ModDeck-<x.y.z>-win-x64.zip` via GitHub Releases (`gh release create`).
3. **Legacy maintenance branch (`legacy/electron`)**:
   - Retains the v2.5.0 Electron baseline for critical bugfix patches only (`2.5.z`).

---

## 5. Pre-Release Checklist

- [ ] `npm run typecheck` passes cleanly
- [ ] `npm run i18n:check` shows 100% key parity (`zh-CN` / `en-US`)
- [ ] `npm run tauri:test` passes with zero warnings
- [ ] `npm run package:portable` builds `release/ModDeck-<version>-win-x64.zip`
- [ ] Desktop smoke test passes after extracting the ZIP (main window, overlay, detail sidecar, import, presets, launcher, tray)
- [ ] `CHANGELOG.md` and `CHANGELOG.zh-CN.md` are updated objectively
