# ModDeck 构建与发布指南

本文档详细说明 ModDeck 的环境准备、常用开发脚本、多语言维护工作流、绿色便携包打包及版本发布规范。

---

## 一、环境准备

- **操作系统**：Windows 10 / Windows 11 64 位（x64）；
- **运行环境**：Node.js 22+（开发推荐 Node 24），npm；
- **开发工具**：Git，PowerShell；
- **打包辅助**：系统自带或内置 7-Zip（用于生成便携 ZIP 分发包）。

### 1. 源码克隆与依赖安装

```bash
git clone https://github.com/yuzhoujun/ModDeck.git
cd ModDeck
npm install
```

> **提示**：若在国内网络环境下下载 Electron 较慢，可配置镜像源：
> ```powershell
> $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
> npm install
> ```

---

## 二、日常开发指令

| 指令 | 作用说明 |
| :--- | :--- |
| `npm run dev` | 启动热重载（HMR）本地开发环境（Electron + Vite） |
| `npm run typecheck` | 执行主进程、Preload 与渲染层的完整 TypeScript 严格类型检查 |
| `npm run build` | 编译生产环境产物（输出至 `out/` 目录） |
| `npm run smoke` | 执行无头冒烟测试，在虚拟沙箱环境下校验扫描、启停与元数据读写 |
| `npm run scan:report` | 对配置目录执行只读性能测试并输出 `scan-report.json` |
| `npm run i18n:check` | 校验多语言一致性、代码 `t`/`tMain` 调用有效性与未抽取中文扫描 |
| `npm run i18n:extract` | 深度扫描抽取未翻译中文，生成结构化 JSON 树与行列报告 |
| `npm run i18n:extract:apply` | 一键安全增量合并提取词条至基准语言并生成待翻译占位符 |
| `npm run i18n:sync` | 递归对齐所有语言包结构并按字母排序格式化 |

---

## 三、多语言维护与自动化工作流（i18n Toolchain）

ModDeck 内置多语言字典位于 `src/shared/i18n/locales/`，以 `zh-CN.json` 为基准语言，`en-US.json` 保持 100% 结构镜像。当前词典规模已覆盖 **660+** 项核心界面、弹窗、系统托盘及底层 IPC 报错词条。

为了避免手动维护多语言产生遗漏或键位漂移，工程提供了完整的多语言自动化维护工具链（基于 `scripts/i18n.mjs`）：

```bash
# 1. 语法与调用一致性校验（词条对称性 + t/tMain 调用有效性 + 硬编码中文扫描）
npm run i18n:check

# 2. 深度扫描工程代码中未翻译的中文字符串，生成标准结构化 JSON 与位置详表
npm run i18n:extract

# 3. 一键安全增量合并新词条至 zh-CN.json 并自动同步 en-US.json 待翻译占位符
npm run i18n:extract:apply

# 4. 递归对齐所有语言包的键位结构并执行字母顺序深度排序格式化
npm run i18n:sync

# 5. 基于基准模板快速脚手架生成新语言包（例如创建日语 ja-JP.json）
node scripts/i18n.mjs new ja-JP
```

### 1. 自动化工具链核心能力详解

#### ① 词条一致性与代码调用校验（`npm run i18n:check`）

- **结构对称性**：遍历 `src/shared/i18n/locales/` 下所有语言包，比对与 `zh-CN.json` 的键位差异，报告缺失键或多余冗余键；
- **调用有效性扫描**：递归扫描 `src/` 下所有 `.ts` 与 `.tsx` 源码中的 `t('xxx')`（渲染层）及 `tMain('xxx')`（主进程 IPC/托盘/弹窗）调用，确保代码中调用的每一个键在基准字典中真实存在，杜绝运行时报错；
- **硬编码中文扫描**：扫描工程源码中的中文文本，对照字典反查并报告未映射的文本。

#### ② 代码中文深度抽取与结构化生成（`npm run i18n:extract`）

- **全量代码扫描**：覆盖 `src/main`、`src/renderer`、`src/preload`、`src/shared`；
- **智能过滤**：自动过滤单行与多行注释、控制台与调试日志（`console.*`、`logError`）、冒烟测试沙箱逻辑及核心词库数据（`core/roster.ts`）；
- **词条比对与语义归类**：与基准字典自动比对：
  - 若该中文已在字典中存在对应翻译，标记现有 key，提示可直接复用；
  - 若为新词条，根据文件路径与上下文推导所属命名空间（如 `dialog.*`、`tray.*`、`common.*`、`settings.*`、`overlay.*`、`character.*`、`mod.*` 等）；
- **生成产物**：
  - `scripts/extracted-zh-CN.json`：按推导命名空间组织的标准嵌套 JSON 树；
  - `scripts/extracted-details.json`：包含每个中文字符串在工程中出现的精确文件路径与行号清单。

#### ③ 一键增量合并与多语言对比工作流（`npm run i18n:extract:apply`）

1. 自动将抽取出的新词条通过安全深度合并（`deepMerge`）写入 `src/shared/i18n/locales/zh-CN.json`，已存在的叶子节点绝不覆盖；
2. 自动格式化并按字母顺序深度重排所有 key；
3. 自动将新增条目以 `"[TODO: <原中文>]"` 占位符结构同步到 `en-US.json` 等语言包；
4. **Git Diff 极速翻译对比**：
   ```bash
   git diff src/shared/i18n/locales
   ```
   直接通过 Git 差异即可清晰查看所有新增的待翻译项，在 `en-US.json` 中将 `[TODO: ...]` 替换为英文翻译即可完成语言对齐闭环。

#### ④ 语言包递归同步与新语言扩展

- **`npm run i18n:sync`**：当手动调整或删改 `zh-CN.json` 后，运行该指令递归同步补齐所有其他语言包结构，并规范化排序缩进；
- **`node scripts/i18n.mjs new <locale>`**：一键生成如 `ja-JP.json`、`ko-KR.json` 模板，自动填充所有占位符供社区翻译。

### 2. 多语言日常开发实践规范

1. **渲染层文本**：统一使用 `const { t } = useI18n()`，在 JSX 中通过 `{t('namespace.key')}` 渲染；
2. **主进程文本**：涉及 IPC 错误提示、系统托盘右键菜单、文件选择对话框（`dialog.showOpenDialog`）等，统一使用 `tMain('namespace.key', params)`；
3. **新增功能后自检**：
   - 运行 `npm run i18n:extract:apply` 自动提取并合并新词条；
   - 运行 `git diff src/shared/i18n/locales` 补全 `en-US.json` 对应英文；
   - 运行 `npm run i18n:check` 与 `npm run typecheck` 验证词条对齐率 100%。

---

## 四、免安装便携版打包（Portable Build）

```bash
npm run package:portable
```

执行后打包脚本（`scripts/package-portable.ps1`）将自动完成：
1. 调用 `electron-vite build` 编译生产环境资源；
2. 调用 `electron-builder --dir` 生成解压绿色目录 `release/win-unpacked/`；
3. 将独立语言包目录输出到根目录 `languages/`（包含 `zh-CN.json`、`en-US.json`），实现与底层 Chromium 的 50+ 个系统 `.pak` 物理分离；
4. 注入启动入口脚本 `ModDeck.cmd`（内部附带 `--no-sandbox` 参数，防止第三方安全软件误拦截 Chromium 沙箱）及便携说明 `README.txt`；
5. 生成独立的便携 ZIP 分发包：
   ```text
   release/ModDeck-<version>-win-x64.zip
   ```
6. 计算并打印便携包的 SHA256 校验码。

### 便携包目录结构规范

```text
ModDeck/
├── ModDeck.exe                     # [主程序] 应用程序主执行文件
├── ModDeck.cmd                     # [启动器] 兼容启动脚本（携带 --no-sandbox 参数避免误拦截）
├── languages/                      # [多语言] 独立语言包目录（支持热加载与外部扩展）
│   ├── zh-CN.json                  # [基准] 简体中文界面词典
│   └── en-US.json                  # [镜像] 英文界面词典
├── resources/                      # [核心] 运行时资源目录
│   └── app.asar                    # [逻辑] 编译后的核心前端与主进程产物
├── locales/                        # [底层] Chromium 运行库多语言 pak 资源
├── README.txt                      # [指南] 便携版双语快速上手与排错指南
└── ...
```

---

## 五、版本号与发布规范（SemVer）

严格遵循语义化版本规范，软件内禁止出现随意后缀：

1. **正式发布版本（Release / Tag）**：
   - 格式：`x.y.0`（如 `2.3.0`、`2.4.0`）；
   - 规则：大版本与小版本在 GitHub 发布正式 Release 与 Git Tag，并上传对应的便携包 ZIP。
2. **本地测试版本（Test / Milestone）**：
   - 格式：`x.y.z`（如 `2.3.1`、`2.3.2`）；
   - 规则：仅在本地构建、测试验证，同步推送源码至 GitHub `main` 分支，**不单独打 Release Tag**。
3. **测试阶段的修复/优化补丁版本（Patch）**：
   - 格式：`x.y.z-patch.N`（如 `2.3.1-patch.1`、`2.3.1-patch.5`）；
   - 规则：在 `package.json` 中统一记录为 `x.y.z-patch.N`，CHANGELOG 正文与日常交流合并归纳在所属测试版本下（如 `2.3.1.5`）。

---

## 六、构建发布前检查清单

- [ ] `npm run typecheck` 验证无类型错误；
- [ ] `npm run i18n:check` 验证多语言词条对齐率 100%；
- [ ] `npm run build` 验证生产打包无编译错误；
- [ ] `npm run package:portable` 生成绿色便携包；
- [ ] 解压生成的绿色便携包，双击 `ModDeck.cmd` 验证主界面、快捷窗口、方案工作台正常加载；
- [ ] 检查并更新 `CHANGELOG.md` 记录客观务实的改动说明；
- [ ] 提交代码并同步推送至 GitHub `main` 分支。
