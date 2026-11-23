# ModDeck 后续路线图与灵感待办（Roadmap & Backlog）

[English (ROADMAP.md)](ROADMAP.md) | [更新日志 (CHANGELOG.zh-CN.md)](../CHANGELOG.zh-CN.md)

本文件作为 `v3.0.0` 之后随代码库长期演进的持久化清单，用来随时记录后续版本计划、小功能灵感、结构优化想法及待排查问题，避免跨开发周期遗忘。公开反馈或社区议题也可配合 [GitHub Issues](https://github.com/yuzhoujun/ModDeck/issues) 追踪。

---

## 已完结里程碑（归档摘要）

### v3.0.0 — Tauri 2 + Rust 架构迁移（2026-11-19 发布）

- 完成由 Electron 到 Tauri 2 + Rust + WebView2 的全功能对等迁移（便携压缩包约 3.5 MB），Electron `v2.5.0` 源码已完整保留于 `legacy/electron` 分支。
- 新增原生多格式解压与编码纠偏、INI 热键类型识别、导入升级目标手选、WebView2 前置检测及英中双语文档体系。

### v3.0.1 — Windows 安装/卸载包与旧版数据规范化（2026-11-19 发布）

- 新增 Windows NSIS 安装/卸载包（`ModDeck-3.0.1-win-x64-setup.exe`），依赖标准注册表（`HKCU\Software\yuzhoujun\ModDeck`）在后续覆盖升级时自动定位安装目录，并在卸载确认页勾选「删除应用数据」时同步清理 `%APPDATA%\ModDeck\` 与 WebView2 数据（未勾选则完整保留）。
- 在应用启动探测与「设置 -> 存储与备份」新增**旧版 Electron v2 遗留残留检测与一键安全清理**（识别 `Cache`、`GPUCache`、`GrShaderCache`、`bin\ModDeckKeyHelper-v2.*`、`mod-presets.json`、v2 旧日志等，不触碰任何预设、封面、配置与 Mod 备份），同时服务安装版与免安装版用户。

### v3.1.0 — 全角色方案分游戏拆分、在线更新与环境规则开关（当前正式版，2026-11-23 发布）

- 将根目录 `roster-presets.json` 自动拆分迁移至 `presets\<gameId>\roster-presets.json`，同时保持旧版 `.moddeck-bundle` 向下兼容与条目合并。
- 上线默认严格离线的四级抗限流在线更新检测（`github-api` -> `github-web` / `releases.atom` -> 镜像代理 Atom / `raw-fallback` -> 区分信道的 `jsDelivr`）与镜像加速；新增不阻断点击的右下角启动/升级成功轻浮窗（支持悬停暂停淡出、托盘防重弹、`不再提醒此版本` 与 `--updated-from`）、恢复 NSIS 向导完成页选择及按语言截取渲染的 Markdown 更新明细。
- 在「设置 -> 环境」新增 `exclude_recursive = DISABLED*` 与 `cache_shaders = 1 / 0` 一键开关、分拆 ModDeck 自身忽略目录卡片（`EFMI-MCP`、`_*`、`.*` 及自定义），并修复 NSIS 安装包语言目录打包（`#4`）与零变量 Mod 串读 `d3dx_user.ini` 绕过默认预设重复校验的问题（`#5`）。

---

## 计划版本：v3.2.0（INI 静态冲突审计与诊断能力升级）

- **跨 Mod `IniParams`（`x100..x255`）抢写与 `[Present]` 延迟覆写检测（高优先级）**：
  - 解析活跃 `.ini` 的 `[Present]`（及通过 `run = CommandList*` 调用的子节）向全局槽位 `x100..x255` 的写入，校验是否缺少 `$object_detected` / `$active` 等条件门控；
  - 对「多 Mod 无门控抢写同一全局寄存器」及「同时启用的 Mod B 依赖 `post run = CustomShader*` 同槽位读写」进行高危/警告标注，定位文件与行号，并清晰提示「同角色必撞」与「跨角色仅同场渲染时互相影响」的区别。
- **Mod 冲突审计分级热键碰撞检测与弹窗分区过滤**：
  - 采用低噪音分层策略：同一角色下启用中多个 Mod 撞键或无 `$active`/`condition` 门控的全局快捷键撞车标为 `warning`；跨角色之间的巧合重键归入可折叠 `info` 分区，避免无谓警报刷屏；
  - 在冲突审计弹窗补充分类过滤芯片（全部 / 渲染与插件 / 变量寄存器 / 快捷键）。
- **低面数无门控 `handling = skip` 与 EFMI 旧架构兼容性提示**：
  - 仅在 `[TextureOverride*]` 同时满足小索引计数（`match_index_count <= 24`）且含 `handling = skip` 但没有任何 `$` 变量门控时给出温和提示，避免误伤常规人物部件消隐 Mod；
  - 仅针对终末地（`game_id == "endfield"` / `loader == "EFMI"`），检测旧版 `CrossIBClassifier` / `record_bones_cs` / `redirect_cb1_cs` 引用及 `$required_efmi_version` 不匹配提示。
- **超大 `.dds` 贴图（`> 32 MiB`）加载耗时提醒**：
  - 通过零依赖文件体积扫描直接统计启用中 Mod 内单文件超过 `32 MiB`（如 `8192×8192`）的 `.dds` 贴图，在「Mod 详情 / 静态诊断」与全局审计 `info` 汇总中提示首帧/重载卡顿风险（可联动推荐开启 `cache_shaders = 1`）。
- **一键复制精简 Markdown 诊断上下文**：
  - 在冲突审计弹窗新增「复制诊断摘要」按钮，生成脱敏相对路径、冲突 Hash / 寄存器 / 热键、`.ini` 行号与环境状态的紧凑 Markdown，方便直接粘贴给外部 AI 会话或 `EFMI-MCP` 接力排障。
- **非 API 更新兜底链路（`github-atom` / `github-web` / 镜像）补全更新明细**：
  - 从 `releases.atom` 的 `<content type="html">`（或对应 Release 页面）提取并清洗标准化双语 Release 说明（遵循统一的 `## English` / `## 简体中文` / `### Checksums` 发版模板），使 `api.github.com` 触发 403 限流退至兜底数据源时，「设置 -> 关于」仍能完整渲染更新说明。

---

## 长期灵感池与待查记录（Ideas & Bug Scratchpad）

> 今后随时想到的细小功能优化、边界体验问题或待修 Bug 可直接按条目追加在下方，方便下次集中迭代时逐一核销。

### 核心引擎与游戏实机适配

- **复杂 `[CommandList]` 与连续滑条变量支持**：调研针对非离散整型/浮点连续滑条及多变量条件钳制脚本的轻量 AST 解析。
- **非终末地游戏实机适配验证**：汇总鸣潮（WWMI）、崩铁（SRMI）、绝区零（ZZMI）、异环（NEMI）在社区玩家实机环境下的兼容反馈。
- **纯 Rust DDS 预览按需评估**：仅在未来确需支持直接将 `.dds` 转为缩略图或解析贴图尺寸/BC 格式时，再评估引入 `ddsfile` + `image_dds`（当前保持轻量）。
- **词典与封面离线维护流程参考**：维护 `roster.json` 与社区封面库时，可结合 `EndfieldStudio` 等外部解包/分类工具在开发侧提取新角色中英文名与立绘底图（不进客户端代码）。

### 零碎想法与待修细节

- *(后续有任何小想法或待修问题可直接追加在此处)*
