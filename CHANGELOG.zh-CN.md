# 更新日志

[English (CHANGELOG.md)](CHANGELOG.md) | [v1.0.0 ~ v2.5.0 历史归档](docs/CHANGELOG_V2_ARCHIVE.md)

本项目采用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 结构与标准 [SemVer 2.0.0](https://semver.org/lang/zh-CN/) 语义化版本规范。

## [Unreleased]

### 新增（Added）

- **全角色方案分游戏拆分存储与无感自动迁移**：启动或访问预设方案时，自动将根目录遗留的 `%APPDATA%\ModDeck\roster-presets.json` 无感拆分迁移至各游戏独立文件 `%APPDATA%\ModDeck\presets\<gameId>\roster-presets.json` 并按条目 ID 合并去重；完全兼容导入旧版 `.moddeck-bundle` 配置迁移包。
- **`d3dx.ini` 规则直连开关与环境检查重排版（「设置 -> 环境」）**：新增 `[Include]` `exclude_recursive = DISABLED*` 与 `[Rendering]` `cache_shaders = 1 / 0` 一键切换按钮，采用绿/黄底纹规则行直观区分状态，并在卡片右上角展示完整根目录；将 `EFMI-MCP`、`_*`、`.*` 及自定义「**ModDeck 库扫描与冲突审计忽略目录**」拆分为独立卡片，明确区分 ModDeck 自身过滤与 XXMI 加载器规则。
- **在线版本检测、国内镜像加速与一键升级（「设置 -> 关于」）**：遵循默认严格离线原则（默认关闭后台检查，仅在手动点击或用户主动勾选开启后联网）；构建四级抗限流检测链路（`api.github.com` REST API -> 无 API 速率限制的 `github.com/releases/latest` 重定向与 `releases.atom` 订阅 -> 镜像代理 Atom / `raw.githubusercontent.com` -> 区分稳定/预发布信道的 `jsDelivr` CDN）；启动检测到新版时仅在每次软件启动（托盘呼出主窗口不重复弹出）在右下角展示不阻塞点击的轻浮窗提醒，支持悬停暂停、延时自动淡出、关闭以及按版本号生效的「不再提醒此版本」；内置官方直连、`ghfast.top`、`gh-proxy.org` 与自定义镜像，安装版升级调起完整 NSIS 安装向导以保留完成页的启动与桌面快捷方式选项，便携版支持无注册表原地覆盖并前置拉起窗口展示升级成功轻提示。

### 修复（Fixed）

- **修复 NSIS 安装版「打开语言包目录」指向空数据目录（`#4`）**：在 `tauri.conf.json` `bundle.resources` 中将 `languages/*.json` 一并打包至安装包程序同级目录，与便携版目录结构保持一致，同时保留 `%APPDATA%\ModDeck\languages\` 更高优先级的用户自定义覆盖机制。
- **修复零持久化变量 Mod 串读其他 Mod 变量导致默认预设无重复保护（`#5`）**：修复 `read_active_d3dx_user_variables` 在 Mod 无 `persist` 变量声明时未校验路径归属当前 Mod 文件夹，误把 `d3dx_user.ini` 内其他 Mod 变量写入新预设从而绕过与 `__default__` 重复校验的问题。
- **修复英文界面保存预设提示硬编码中文 `"默认"` 并禁止占用保留名**：当实机状态与出厂默认预设一致时，前端结合 `duplicatePresetId` 与当前语言精确本地化提示为 `"Default"` / `"默认"`；前后端同步禁止新建或保存以 `Default`、`默认`、`默认 (初始)` 等保留名称命名的自定义预设。
- 统一 `ini_analysis` 全局冲突审计与 `library` 扫描忽略逻辑，避免 `_ModDeck_Preset_Bridge` 等下划线内部桥接目录及外部沙盒目录产生误报。

## [3.0.1] - 2026-11-19

### 新增（Added）

- **Windows NSIS 安装/卸载包（`ModDeck-<version>-win-x64-setup.exe`）**：新增标准 NSIS 安装包构建脚本 `npm run package:installer`，与便携 ZIP 并行提供下载；支持中英文界面随系统匹配、基于注册表自动定位原安装路径实现后续无感覆盖升级，并通过 `src-tauri/windows/hooks.nsh` 在真实卸载且勾选「删除应用数据」时同步清理 `%APPDATA%\ModDeck\`。
- **旧版 Electron 数据目录检测与一键规范清理**：新增后端命令 `clean_legacy_electron_data` 及主界面横幅 /「设置 -> 存储与备份」清理卡片，自动识别旧版 `v2.x` Electron 浏览器缓存、`ModDeckKeyHelper-v2`、已废弃的 `mod-presets.json` 与 v2 旧日志并安全清除，不触碰任何现用预设、封面、配置与 Mod 备份。
- **仓库内持久化路线图与灵感记录**：新增 [docs/ROADMAP.md](docs/ROADMAP.md) 与 [docs/ROADMAP.zh-CN.md](docs/ROADMAP.zh-CN.md)，记录 `v3.1.0`（全角色池分游戏拆目录无感迁移、支持镜像加速的在线升级）及后续功能待办。

### 修复（Fixed）

- 修正「设置 -> 关于」页中的运行时字段标签（「应用框架」/「后端内核」），移除遗留的 Electron / Node.js 文案标注。

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
