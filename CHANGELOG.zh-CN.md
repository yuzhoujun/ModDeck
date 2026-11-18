# 更新日志

[English (CHANGELOG.md)](CHANGELOG.md) | [v1.0.0 ~ v2.5.0 历史归档](docs/CHANGELOG_V2_ARCHIVE.md)

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 结构与标准 [SemVer 2.0.0](https://semver.org/lang/zh-CN/) 语义化版本规范。

## [3.0.0] - 2026-11-19

### 新增（Added）

- **Tauri 2 + Rust 原生后端架构**：以 Tauri 2、Rust 与系统 WebView2 替代原 Electron 主进程、内置 Chromium 运行时及外部 `ModDeckKeyHelper` 辅助程序，打包为单文件 `ModDeck.exe`。
- **原生压缩包与多编码解析引擎**：内置 `.zip` / `.7z` / `.rar` 流式解析解压、多字符集乱码纠偏（`UTF-8`、`CP437`、`GB18030`、`Big5`、`Shift-JIS`、`EUC-KR`）、加密压缩包密码弹窗重试以及拖放暂存目录自动回收。
- **导入升级目标手选与重命名**：在 `ImportPreviewModal` 中支持单条编辑目标文件夹名，以及从所属角色现有 Mod 列表中手选需要覆盖升级的旧版条目（自动备份旧目录，并兼容 `DISABLED_<同名>` 目录触发覆盖备份）。
- **INI 热键类型识别与提醒**：解析 `[Section]` 内的 `type` 属性，在 Mod 详情与 `overlay-detail` 中为 `type = hold`、纯修饰键组合（如 `CTRL ALT`）和鼠标交互键（如 `VK_LBUTTON`）展示轻量标签与提示，防止误触发或报错。
- **WebView2 运行库启动前置检测**：启动前检索 Windows 注册表 Evergreen WebView2 运行库状态，缺失时弹出双语提示并引导打开微软官方下载页面。
- **Win32 原生联动与监听**：实现原生 `SendInput` 扫描码发送（覆盖标点符号键、`VK_*`、十六进制虚拟键与 `no_*` 修饰键释放）、`CreateToolhelp32Snapshot` 进程检测、`ShellExecuteW` UAC 提权启动、`FindFirstChangeNotificationW` 实时目录与 `d3dx_user.ini` 监听、系统回收站删除及双语托盘菜单。

### 变更（Changed）

- **便携分发包结构**：便携 ZIP 精简为单文件 `ModDeck.exe` 搭配 `languages/` 词典目录与 `README.txt`，移除 `ModDeck.cmd` 与 Chromium `--no-sandbox` 兼容启动逻辑，并完整沿用原有 `%APPDATA%\ModDeck\` 用户数据。
- **管理界面与交互优化**：Mod 删除改为先弹窗确认再移入回收站，多选模式补充全选 / 取消全选 / 批量删除，变量与静态诊断详情移入可纵向滚动的弹窗展示，精简 Mod 卡片副行展示；将默认快捷悬浮窗呼出热键调整为 `Alt+\`，并取消方案池批量按钮的 `Alt+U` / `Alt+R` 键盘快捷键绑定。
- **文档与 CI 体系升级**：调整为英文主入口文档与完整简体中文平行文档结构（`README.md` / `README.zh-CN.md`、`CHANGELOG.md` / `CHANGELOG.zh-CN.md`），并将 GitHub CI 更新为校检 `typecheck`、`i18n:check`、`cargo test` 与 `tauri build --no-bundle`。

### 修复（Fixed）

- 修复部分目录权限受限环境下 WebView2 初始化失败的问题，增加 `AppData\Local` 隔离恢复目录回退机制。
- 修复在 Windows 同步命令内创建 `overlay-detail` 窗口导致主消息循环死锁与界面持续转圈的问题，改为 `async` 异步窗口管理并在启动阶段预创建。
- 修复 `open_path` 对 `"data"`、`"logs"`、`"languages"`、`"game"`、`"loader"` 路径的定位逻辑（对 `.exe` 文件改用 `explorer.exe /select` 高亮定位，避免误启动程序）。
- 补充 `set_overlay_hotkey` 与 `set_reload_hotkey` 冲突校验，避免与重载快捷键冲突。
- 修复预设池未保存实机改动（`is-dirty`）下拉框在 WebView2 弹出层中底色发白导致选项文字难以辨认的问题。

### 移除（Removed）

- 在 `main` 主干分支彻底移除 Electron 旧主进程/预加载源码（`src/main`、`src/preload`）、构建与类型配置（`electron.vite.config.ts`、`tsconfig.node.json`、`scripts/prepare-smoke.mjs`）、Electron 相关 npm 依赖（`electron`、`electron-builder`、`electron-vite`、`7zip-bin`、`node-unrar-js`）、`ModDeck.cmd` 启动包装脚本及外部按键 helper 依赖（完整 Electron v2 代码保留在 `legacy/electron` 分支归档）。
