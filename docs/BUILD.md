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

---

## 三、多语言维护与自动化工作流（i18n Toolchain）

ModDeck 内置多语言字典位于 `src/shared/i18n/locales/`，以 `zh-CN.json` 为基准语言，通过自动化脚本确保各语言结构与代码调用的严密对齐：

```bash
# 1. 检查多语言一致性与硬编码中文
npm run i18n:check

# 2. 深度扫描工程代码中未翻译的中文字符串并生成详尽报告
npm run i18n:extract

# 3. 自动以基准语言（zh-CN）递归对齐补全所有语言包并格式化排序
npm run i18n:sync

# 4. 基于基准模版快速脚手架生成新语言包（例如日语 ja-JP）
node scripts/i18n.mjs new ja-JP
```

### 词条规模与对齐保障

- 目前已收录并对齐超过 **585+** 项核心界面词条；
- 每次在代码中添加新界面或调整文案时，建议先使用 `npm run i18n:extract` 检查漏译，修改后运行 `npm run i18n:sync` 自动同步结构，并通过 `npm run i18n:check` 与 `npm run typecheck` 验证。

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
├── ModDeck.exe             # 应用程序主执行文件
├── ModDeck.cmd             # 兼容启动脚本（附带 --no-sandbox，推荐日常双击使用）
├── languages/              # 软件界面语言包（支持外部自定义新增与扩展）
│   ├── zh-CN.json
│   └── en-US.json
├── resources/
│   └── app.asar            # 打包核心业务逻辑
├── locales/                # 底层 Chromium 系统多语言 pak 库
├── README.txt              # 便携说明文档
└── ...
```

### 本地发布归档同步

每次执行 `npm run package:portable` 生成 ZIP 产物后，同步解压复制到本地测试与发布归档目录：
```text
D:\Release\ModDeck\
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
- [ ] 同步解压至 `release\ModDeck\`，双击 `ModDeck.cmd` 验证主界面、快捷窗口、方案工作台正常加载；
- [ ] 检查并更新 `CHANGELOG.md` 记录客观务实的改动说明；
- [ ] 提交代码并同步推送至 GitHub `main` 分支。
