# ModDeck

[![CI](https://github.com/yuzhoujun/ModDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/yuzhoujun/ModDeck/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/yuzhoujun/ModDeck?label=release&cacheSeconds=300)](https://github.com/yuzhoujun/ModDeck/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D4)](#三系统要求与运行)

面向 3DMigoto / XXMI 系游戏的开源、现代、本地优先（Local-First）Windows Mod 管理器与游戏内快捷工作台。

ModDeck 专职管理游戏 `Mods` 目录：秒级启停、智能角色匹配导入、单 Mod 变体预设引擎、全角色阵容方案管理、微秒级文件常驻感知与游戏内沉浸式快捷窗（Overlay）。游戏底层 Direct3D 注入与 Shader 处理严格交给 3DMigoto / XXMI，ModDeck **绝不侵入游戏内存、绝不修改游戏本体代码**，安全零封号风险。

---

## 一、下载与运行

- **最新正式版发布包**：前往 [GitHub Releases](https://github.com/yuzhoujun/ModDeck/releases/latest) 下载 `ModDeck-<version>-win-x64.zip`；
- **运行方式**：
  1. 将 ZIP 压缩包完整解压至任意目录（建议非系统只读盘，路径避免特殊符号）；
  2. **双击 `ModDeck.exe` 即可直接启动**；
  3. （备用）若系统或部分安全软件拦截了 Chromium 沙箱进程导致直接双击无反应，可双击同目录下的 **`ModDeck.cmd`** 脚本启动（内部自动配置 `--no-sandbox` 兼容参数）；
  4. 初次打开进入「设置」，配置对应游戏的 `Mods` 或 MI 根目录。

---

## 二、软件功能总览

### 1. 现代化角色库与封面工作台
- **磁盘原生驱动**：角色与 Mod 直接扫描自磁盘真实结构，不强制绑定外部服务器或写死名单；
- **视觉化管理**：支持一键拖拽卡片自由排序（顺序本机持久化存储），支持模糊搜索角色名、别名、拼音与目录名；
- **专属封面编辑器**：支持拖入任意图片，内置 1:1 视口自由平移与缩放裁剪，自动生成无损 `.preview.png`。

![角色库](docs/screenshot-library.png)

### 2. 批量智能导入与无损修复
- **整页全格式拖拽**：直接向角色库拖入多个 `.zip / .7z / .rar` 压缩包或解压文件夹；
- **离线角色智能匹配**：内置 5 大游戏全量中英/别名/拼音词典，自动识别解压包归属角色；
- **乱码自动修复**：内置 CP437 -> GB18030 字符集无损解码引擎，自动纠正历史压缩包解压后的中文目录与乱码文件名。

### 3. 游戏内快捷操作台（Overlay）与原生键盘驱动
- **游戏沉浸呼出**：默认全局快捷键 `Alt+Shift+M`（支持自定义），无需切屏即可在游戏上层直接呼出；
- **Mod 状态秒级同步**：常驻监听底层的 `Mods` 与 `d3dx_user.ini`，游戏内调完造型外部毫秒级同步；
- **硬件级按键助手**：内置轻量原生按键助手 `ModDeckKeyHelper-v2.exe`，向游戏前台精准模拟硬件级 DirectInput/RawInput 键盘扫描码，支持热键发送与一键重载。

![快捷窗口](docs/screenshot-overlay.png)

---

## 三、进阶功能与高级操作指南

<details>
<summary><strong>👉 点击展开高级功能详述（变体预设引擎、全角色阵容池、DISABLED 规则、错位极速重载与启动参数）</strong></summary>

### 1. 单 Mod 变体预设引擎（Mod Variant Presets）
现代 3DMigoto Mod 通常包含丰富的服装配色、配件开关与体型滑动条。
- **出厂基线保障**：每个 Mod 自动解析原生 `.ini` 声明的作者出厂参数，生成永久内置的「默认 (初始)」预设，随时可一键复原；
- **现场实机快照**：玩家在游戏内按热键或在 GUI 菜单调好造型后，在快捷窗口侧栏直接输入名称即可一键保存为新预设；
- **瞬态变量过滤（Transient Var Filter）**：ModDeck 智能识别并过滤非外观临时变量（如菜单开启 `$ui_menu`、页码、鼠标抓手坐标等），只比对和覆盖真正的服装与体型参数；
- **防误触脏状态对比**：当检测到当前实机参数与已有预设不符（有未保存现场改动）时，切换其他预设会自动弹出防覆盖二次确认弹窗。

### 2. 全角色池阵容预设方案（Roster Presets）
- **全队阵容一键换装**：角色库顶部「预设方案」大模态框，支持集中配置全队每个角色当前激活的 Mod 及对应的单 Mod 变体；
- **单选互斥严格保护**：同角色多 Mod 强制单选互斥，杜绝同角色骨骼模型冲突导致的崩溃；
- **快捷抽屉一键上阵**：快捷窗口（Overlay）底部配备阵容抽屉面板，按一个键即可秒级切换全角色阵容及所有变体。

### 3. 3DMigoto `DISABLED_` 状态机制与文件锁回退
- 3DMigoto 官方通过 `exclude_recursive = DISABLED*` 忽略被禁用的 Mod；
- **智能免关游戏热切换**：当游戏运行导致 Mod 外部文件夹被 Windows 锁定（无法重命名目录）时，ModDeck 会智能降级重命名内部主 `.ini` 为 `DISABLED_*.ini`，配合热重载无需重启游戏即可立刻生效。

### 4. 高级性能架构：错位极速热重载（Fast Config Reload）
在 3DMigoto 原版机制中，热键拆分为两个不同维度的功能：
```ini
; 1. 全局重载所有 Shader 和修复（高开销，重编译整个渲染管道，耗时数百毫秒至数秒）
reload_fixes = no_modifiers VK_F10

; 2. 仅重载配置与运行时变量（极低开销，仅重读 ini 并赋值变量，耗时毫秒级，零掉帧）
reload_config = no_modifiers VK_F10
```
- **错位热键加速原理**：绝大多数整合包默认将两者并绑在 `VK_F10`，导致哪怕仅仅改一个衣服颜色也会引起 Shader 全量重编译掉帧。
- **加速方案**：在 `d3dx.ini` 中将 `reload_config` 错位配置为独立热键（如 `reload_config = alt shift no_ctrl VK_F10`）。切换预设时 ModDeck 仅触发该加速键，实机毫秒级即时换装，彻底告别切预设卡顿。

### 5. 自定义启动参数与命令行
- 在游戏配置面板中支持为游戏主程序自定义追加启动参数（Launch Arguments），如 `-dx11`、`-window-mode exclusive` 或其他调试参数；
- ModDeck 自身启动支持 `--no-sandbox`（跳过沙箱）、`--smoke-test`（自检测试）等调试标识。

</details>

---

## 四、游戏实测与集成状态

| 游戏平台 | 推荐 MI 注入分支 | 兼容与集成状态 | 说明 |
| :--- | :--- | :--- | :--- |
| **明日方舟：终末地** | **EFMI** | **完整实测与深度适配** | 完整验证变体预设引擎、瞬态过滤、快捷侧栏及热重载机制 |
| **鸣潮** | **WWMI** | 规则兼容（待实机验证） | 采用通用 3DMigoto 树型结构与 `DISABLED_` 规范 |
| **崩坏：星穹铁道** | **SRMI** | 规则兼容（待实机验证） | 采用通用 3DMigoto 规范 |
| **绝区零** | **ZZMI** | 规则兼容（待实机验证） | 采用通用 3DMigoto 规范 |
| **异环** | **NEMI** | 规则兼容（待实机验证） | 采用通用 3DMigoto 规范 |

---

## 五、环境要求与兼容说明

- **操作系统**：Windows 10 / Windows 11 64 位（x64）；
- **运行环境**：无需安装 Python、无需全局 Node.js，发布包内已自包含完整运行环境与 native 依赖；
- **游戏窗口化要求**：快捷窗口（Overlay）置顶在游戏上层需要游戏运行于**无边框窗口模式（Borderless Windowed）**或**窗口化模式**。若开启独占全屏（Exclusive Fullscreen），Windows 窗口管理器会强制抢占置顶通道导致快捷窗无法覆顶，请将游戏调为无边框模式；
- **本地优先（Local-First）**：所有预设、角色封面及配置数据严格保存在本地 `%APPDATA%/ModDeck/`，离线断网完全可用，绝不上传玩家任何本地游戏资产。

---

## 六、从源码构建

<details>
<summary><strong>👉 点击展开开发者编译与打包说明</strong></summary>

### 1. 开发环境准备
- Windows 10 / 11 x64
- Node.js 22+ & npm
- Git

### 2. 获取代码与依赖安装
```bash
git clone https://github.com/yuzhoujun/ModDeck.git
cd ModDeck
npm install
```

### 3. 常用开发与打包指令
```bash
# 启动热重载开发模式
npm run dev

# 完整静态类型检查（主进程 + Preload + 渲染层）
npm run typecheck

# 生产环境编译构建
npm run build

# 打包便携绿色免安装 ZIP 分发包
npm run package:portable
```

更多底层构建与打包机制请参阅 [docs/BUILD.md](docs/BUILD.md)。

</details>

---

## 七、版本历史与更新日志

详细版本迭代记录、功能改进与各测试修复版本说明请查阅完整更新日志：
👉 **[CHANGELOG.md](CHANGELOG.md)**

---

## 八、免责声明、版权与致谢

- **免责声明**：本项目为开源本地 Mod 资源辅助管理工具，仅操作玩家本地磁盘文件。本项目不提供任何破解、注入代码或反作弊规避能力；游戏名称、角色形象及官方资产版权均归属各自官方权利人所有。
- **开源许可**：本项目基于 **[MIT License](LICENSE)** 开源发布。
- **项目发起与维护**：由 **yuzhoujun** 发起并维护。
- **致谢**：作者此前使用的 Mod 管理器在功能和操作习惯上不太适应，于是先后委托 **大肥鱼（DeepSeek-Flash）** 与 **银弧（Gemini 4 Argon）** 协助完成软件架构设计、代码实现、疑难调试、构建与测试。
