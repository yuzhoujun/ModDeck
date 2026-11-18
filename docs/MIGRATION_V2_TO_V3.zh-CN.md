# ModDeck v2 (Electron) -> v3 (Tauri 2) 无损迁移指南

[English (MIGRATION_V2_TO_V3.md)](MIGRATION_V2_TO_V3.md)

ModDeck v3 将底层外壳由 Electron / Chromium 替换为 Tauri 2 + Rust + Windows WebView2，同时**完整沿用 `%APPDATA%\ModDeck\` 数据目录与全部 JSON 配置格式**。

---

## 1. 无损自动继承机制

v2.x 与 v3.x 共用同一套本地数据目录和文件 schema：

- **默认目录**：`%APPDATA%\ModDeck\`
- **便携兜底目录**：`ModDeck.exe` 同级的 `ModDeck-data\`（当系统限制写入 AppData 时自动启用）

首次启动 v3 时会自动无缝读取原有的全部资产：

- `settings.json`（各游戏路径、自定义游戏、快捷键、变量忽略规则与偏好开关）
- `roster-presets.json`（全角色池搭配方案）
- `presets/{gameId}/{character}/{mod}.json`（全部单 Mod 变体预设）
- `characters.json`、`roster-cache.json` 与 `covers/`（角色别名、排序与裁切封面）
- `backups/`（Mod 覆盖历史备份）与 `languages/`（外挂语言包）

---

## 2. 推荐升级步骤

1. 完全退出旧版 ModDeck v2（包括右下角系统托盘驻留进程）。
2. 解压 `ModDeck-3.x.x-win-x64.zip` 到新文件夹；若希望覆写到原程序安装目录，请**先清空原目录下的 Electron 运行库残留**（如 `icudtl.dat`、`resources.pak`、`dxcompiler.dll`、`ModDeck.cmd`、`locales/`、`resources/` 等程序文件，切勿删除 `%APPDATA%\ModDeck\`），再解压 v3 单文件包。
3. 双击 `ModDeck.exe` 启动即可。
4. （可选保险操作）升级前可在「设置 -> 存储与备份」导出一份 `.moddeck-bundle` 全量配置包作为快照。

---

## 3. 关于 `%APPDATA%\ModDeck\` 残留缓存的说明

- v2 运行时会在 `%APPDATA%\ModDeck\` 内留下 Chromium 运行缓存目录（如 `Cache/`、`GPUCache/`、`Code Cache/`、`DawnGraphiteCache/`、`Session Storage/` 等），而 v3 的 WebView2 网页缓存位于 `%LOCALAPPDATA%\dev.moddeck.desktop\`，两者互不干扰。
- 如果希望节省空间，可仅清理上述 Electron 网页缓存文件夹，**切勿删除 `settings.json`、`presets/`、`roster-presets.json`、`characters.json`、`covers/` 与 `backups/`**。
- v3 不再需要 `ModDeck.cmd` 或 `--no-sandbox` 兼容参数。
