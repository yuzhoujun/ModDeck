# ModDeck 架构

## 目标与非目标

**目标**

- 只做本地 Mod 管理：扫描、启停、导入、整理。
- 兼容现有 3DMigoto / XXMI 目录习惯，可以直接接管已有 `Mods` 文件夹。
- 角色与 Mod 以磁盘为准，元数据外置，游戏更新后不需要发新版客户端。
- 完全离线，不发起网络请求。

**非目标（v1）**

- 不做 Mod 注入、不做启动器、不做 overlay / 热键。
- 不做账号、市场、云同步、付费功能。
- 不内置任何游戏素材。

## 目录约定

```
Mods/
  角色目录A/
    某个Mod/
      mod.ini
      preview.png
    DISABLED_另一个Mod/     ← 禁用状态
  角色目录B/
  Characters/               ← 兼容旧布局
```

- 角色 = `Mods` 下的任意文件夹（`Characters/Characters` 容器也兼容）。
- Mod = 角色目录下的文件夹。
- 禁用 = 目录名前缀 `DISABLED_`，启用 = 去掉前缀。
- 以 `.` 或 `_` 开头的目录不参与扫描（例如 `_efmi_ini_tools`）。

## 数据文件

全部位于 `%APPDATA%/ModDeck/`：

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 游戏路径、导入选项、UI 排序 |
| `characters.json` | 角色显示名、别名、封面、排序、隐藏，以及每个游戏的角色基线时间 |
| `covers/<game>/<hash>.<ext>` | 用户设置的封面副本 |
| `backups/<时间>/...` | 覆盖导入前的旧目录备份 |
| `logs/moddeck.log` | 错误日志 |

`characters.json` 的结构：

```json
{
  "schemaVersion": 1,
  "games": {
    "wuthering-waves": {
      "某个新角色": {
        "displayName": "新角色",
        "aliases": ["NewChar"],
        "canonicalEnName": "NewChar",
        "coverFile": "wuthering-waves/ab12cd34.png",
        "order": 10
      }
    }
  }
}
```

没有这条记录时，角色仍会显示，只是名称等于目录名、使用占位封面。这是“新角色自动出现”的基础。

## 角色基线与新角色

第一次扫描某个游戏的 `Mods` 目录时，ModDeck 会把当时存在的所有角色写入
`characters.json` 的 `games[gameId]`，并记录 `rosterInitialized[gameId]`。

- 基线里的角色：`known = true`，不显示“新”标记。
- 基线之后新增的目录：没有元数据记录，`known = false`，显示“新”，直到用户编辑并保存。
- 用户点“恢复默认”会删除该角色的元数据，它会重新变成“新”。

这样不需要客户端更新角色名单，游戏出新角色时只要目录出现就会被发现。

## 主进程模块

```
src/main/
  index.ts              窗口、IPC、自定义协议、托盘外的生命周期
  core/
    games.ts            5 个游戏的静态定义
    safe-path.ts        路径段校验、越界检查
    fsx.ts              原子写、跨盘移动、唯一命名
  services/
    settings.ts         设置加载/合并/保存
    metadata.ts         角色元数据与封面
    library.ts          扫描角色/Mod、排序、快照
    archive.ts          7za / node-unrar-js 解压
    imports.ts          目录识别、目标角色、落盘
```

渲染层通过 `src/preload/index.ts` 暴露的 `window.moddeck` 调用这些能力；主进程对所有路径做二次校验，不信任渲染层传入的目录名。

## 导入策略

1. 解压到 `%APPDATA%/ModDeck/tmp/import-<uuid>/`。
2. 识别结构：
   - `Mods/<角色>/<Mod>`
   - `<角色>/<Mod>`
   - 单个 `<Mod>`（根目录直接有 `ini`）
3. 有目标角色时，全部落到该角色下；没有目标角色时，必须能从结构里推断角色，否则提示用户进入角色页导入。
4. 目标已存在时不覆盖：自动生成 `名字 (2)`；开启覆盖时先把旧目录移到 `backups/`。
5. 压缩包解压后做一次目录越界检查，拒绝 `..` 与符号链接。

## 安全边界

- `contextIsolation: true`，`nodeIntegration: false`。
- 渲染层只能看到白名单 API。
- 角色/Mod 名称必须是单层安全路径段。
- 图片通过自定义协议 `moddeck://asset/?p=...` 读取，只允许 `covers/` 与已配置的 `Mods` 目录，且只允许图片扩展名。
- 删除操作走系统回收站。

## 快捷窗口与全局快捷键

- 主进程用 `globalShortcut` 注册 `settings.ui.overlayHotkey`，默认 `Alt+Shift+F`。
- 快捷键回调创建/切换一个独立的 `BrowserWindow`，加载同一个渲染入口并带
  `?mode=overlay`，由 `OverlayApp` 渲染紧凑面板。
- 快捷窗口复用同一套 preload API，启停 Mod、读取角色列表都走正常 IPC。
- 注册失败时会回退到上一个可用快捷键，并在启动日志里记录。
- `Escape` 或标题栏按钮隐藏窗口；关闭主窗口不会影响已注册的全局快捷键。

## 排序与筛选

- 角色顺序保存在 `settings.characterOrders[gameId]`，值是角色目录名数组。
- Mod 顺序保存在 `settings.modOrders["gameId:characterFolder"]`，值是去掉
  `DISABLED_` 前缀后的 Mod 名数组，启停不会破坏顺序。
- 自定义排序只影响 `sortCharacters/sortMods = "custom"`；其他排序仍按名称/时间/启用状态。
- 角色筛选（全部 / 有 Mod / 无 Mod）是纯前端过滤，不改变磁盘扫描结果。
- `.`、`_` 开头的目录在扫描阶段就被忽略，不会出现在角色或 Mod 列表里。

## 诊断

- `npm run smoke`：在 `temp/fixture` 的假库上启动应用，自动验证扫描、角色页、
  文件夹导入、启停与元数据，并输出截图和 `smoke-result.json`。
- `--scan-report`：只读扫描 `temp/scan-data/settings.json` 中配置的目录，输出
  `scan-report.json`（角色数、Mod 数、耗时、每个角色的 known 状态）。不会写 Mods 目录。

## 后续路线

1. 冲突检测（重复 `hash`、同一 ini 覆盖）。
2. 预设（启用集合快照）与批量启停。
3. Mod 健康检查（缺 ini、空目录、重复目录）。
4. 标签与本地搜索索引。
5. 可选的角色元数据包导入/导出（社区维护，不依赖服务器）。
