# ModDeck 构建、测试与发布指南

[English (BUILD.md)](BUILD.md)

本文档介绍 ModDeck v3（Tauri 2 + Rust + React + TypeScript）的开发环境搭建、测试命令、便携打包流程、多语言工具链与发布规范。

---

## 1. 环境准备

- **操作系统**：Windows 10 / Windows 11 64 位（x64）
- **Node.js**：v22+（推荐 v24）与 `npm`
- **Rust 工具链**：`rustup` stable 工具链（`cargo`、`rustc`）
- **C++ 编译环境**：Visual Studio Build Tools（MSVC v143+ 与 Windows SDK）
- **WebView2**：Microsoft Edge WebView2 运行库（Win11 与常见 Win10 已内置）
- **压缩工具（可选）**：7-Zip（`7z.exe`），未安装时脚本自动回退使用 .NET `ZipFile`

### 获取源码与安装依赖

```bash
git clone https://github.com/yuzhoujun/ModDeck.git
cd ModDeck
npm install
```

---

## 2. 常用开发与验证命令

| 指令 | 说明 |
| --- | --- |
| `npm run tauri:dev` | 启动 Tauri 2 + Vite 热重载桌面开发环境 |
| `npm run typecheck` | 运行 TypeScript 类型校验（`tsconfig.web.json`） |
| `npm run i18n:check` | 校验 `zh-CN` / `en-US` 键位对称性与代码 `t(...)` 引用 |
| `npm run i18n:extract` | 扫描源码中未映射词典的中文文本 |
| `npm run i18n:extract:apply` | 合并新词条至 `zh-CN.json` 并在 `en-US.json` 生成 TODO 占位 |
| `npm run i18n:sync` | 同步并按字母顺序格式化全部语言 JSON |
| `npm run tauri:test` | 运行全部 Rust 单元测试与集成测试（`cargo test --manifest-path src-tauri/Cargo.toml`） |
| `npx vite build --config vite.config.ts` | 构建生产前端静态产物至 `out/tauri-renderer/` |
| `npm run package:portable` | 执行校验/单测、编译 Tauri Release 并产出便携 ZIP 与 SHA256 |
| `npm run package:installer` | 执行校验/单测并构建 Windows NSIS 安装/卸载包（`release/ModDeck-<version>-win-x64-setup.exe`）与 SHA256 |

---

## 3. 免安装便携包构建（`npm run package:portable`）

`scripts/package-portable.ps1` 会自动完成：

1. 运行 `npm run typecheck`、`npm run i18n:check` 与 `cargo test --manifest-path src-tauri/Cargo.toml`。
2. 执行 `npx tauri build --no-bundle` 编译发布版原生主程序。
3. 生成干净的 `release/win-unpacked/` 结构：

```text
ModDeck/
├── ModDeck.exe          # 单文件 Tauri 2 + Rust 主程序
├── README.txt           # 中英双语快速上手与排错指南
└── languages/           # 内置 zh-CN.json 与 en-US.json 语言词典
```

4. 打包输出 `release/ModDeck-<version>-win-x64.zip` 并打印 SHA256 校验码。

> 提示：发版与打包前需确保 `package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 中的版本号完全一致。

---

## 4. 版本号与发布规范（SemVer 2.0.0）

自 v3.x 起严格遵守标准三段式 **SemVer 2.0.0**：

1. **开发与测试预发布（Pre-release）**：`3.0.0-alpha.N`、`3.0.0-beta.N`、`3.0.0-rc.N`。用于阶段性本地构建、实机测试与推送 `main`，默认不创建正式 Release。
2. **正式版与修复补丁**：`x.y.0` 与 `x.y.z`。将 `CHANGELOG.md` / `CHANGELOG.zh-CN.md` 中的 `## [Unreleased]` 归并定格为 `## [x.y.z] - YYYY-MM-DD`，推送分支及 `vx.y.z` Tag，并在 GitHub Releases 上传便携 ZIP。
3. **旧版维护分支（`legacy/electron`）**：保留 Electron v2.5.0 代码，仅在过渡期按需接收必要修补（如 `2.5.1`）。

---

## 5. 发版前检查清单

- [ ] `npm run typecheck` 零报错
- [ ] `npm run i18n:check` 词条 100% 对齐
- [ ] `npm run tauri:test` 全部通过且无编译警告
- [ ] `npm run package:portable` 成功输出 `release/ModDeck-<version>-win-x64.zip`
- [ ] 解压后完成桌面端核心流程验证（主界面、浮窗与热键副窗、导入、预设、启动器、托盘）
- [ ] 更新中英文 `CHANGELOG`
