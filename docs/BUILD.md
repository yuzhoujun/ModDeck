# 构建与发布

本文档描述 ModDeck 的两种构建方式。日常开发只需要 `npm run dev`；发布时按需选择免安装版或安装版。

## 环境

- Windows 10 / 11 x64
- Node.js 22+（开发时使用 24）
- Git
- 7-Zip（生成免安装 ZIP 需要）
- Inno Setup 6（仅安装版需要，可选）

```bash
git clone https://github.com/yuzhoujun/ModDeck.git
cd ModDeck
npm install
```

如果 Electron 下载慢：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_CACHE = "C:\path\to\temp\electron-cache"
npm install
```

构建缓存、冒烟产物、测试夹具统一放在仓库外的 `..\temp\` 或仓库内被忽略的 `temp\`。

## 方式一：免安装版（推荐）

```bash
npm run package:portable
```

脚本会：

1. `electron-vite build`
2. `electron-builder --dir` 生成 `release/win-unpacked/`
3. 放入 `README.txt` 和启动入口 `ModDeck.cmd`
4. 用 7-Zip 压缩为 `release/ModDeck-<version>-win-x64.zip`
5. 输出 SHA256

产物：

```
release/ModDeck-1.0.0-win-x64.zip
```

ZIP 根目录：

```
ModDeck.exe
ModDeck.cmd        ← 启动入口，内部带 --no-sandbox
README.txt
resources/
locales/
...
```

用户双击 `ModDeck.cmd` 启动。部分安全软件会拦截 Electron 的 Chromium 沙箱，所以启动入口
必须带 `--no-sandbox`；`ModDeck.cmd` 已经处理。

## 方式二：安装版（可选）

安装版使用 Inno Setup，生成单文件安装器，并在开始菜单/桌面快捷方式里自动带
`--no-sandbox` 参数。

先构建免安装目录：

```bash
npm run package:portable
```

再编译安装器：

```bash
npm run package:installer
```

或者手动：

```powershell
& "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe" installer\ModDeck.iss
```

产物：

```
release/ModDeck-1.0.0-Setup.exe
```

安装器行为：

- 默认按当前用户安装到 `%LOCALAPPDATA%\Programs\ModDeck`
- 创建开始菜单快捷方式，参数 `--no-sandbox`
- 可选桌面快捷方式，参数 `--no-sandbox`
- 额外创建一个指向 `ModDeck.cmd` 的开始菜单项

### 为什么不选 MSI

MSI（WiX）同样可以通过快捷方式传参数，但需要额外安装 WiX、维护 `.wxs`，对当前项目收益很低。
Inno Setup 更简单，且能直接控制快捷方式参数；如果以后需要企业部署，再补 MSI。

### 安装版的已知限制

- 安装器本身仍未签名，Windows 可能提示未知发布者
- 当前开发机的安全环境会阻止安装器写临时目录；如果安装器无法运行，直接用免安装版
- 安装器需要在正常 Windows 环境构建/验证；不要把它当作唯一分发方式

## 开发与验证

```bash
npm run dev        # 开发窗口
npm run typecheck  # 类型检查
npm run build      # 只构建 out/
npm run smoke      # 无头冒烟测试
```

`npm run smoke` 会在 `temp/fixture` 生成假 Mod 库，在 `temp/smoke-data` 生成独立配置，
截图与结果输出到 `temp/smoke/`。它不会接触真实 Mods 目录。

## 版本号

版本号在 `package.json` 的 `version`，安装器在 `installer/ModDeck.iss` 的
`MyAppVersion` 也要同步修改。

## 发布检查清单

- [ ] `npm run typecheck`
- [ ] `npm run smoke`
- [ ] `npm run package:portable`
- [ ] 解压 ZIP，双击 `ModDeck.cmd` 能打开
- [ ] 检查 `resources/app.asar` 存在
- [ ] 记录 ZIP 的 SHA256
- [ ] 需要安装版时再跑 `npm run package:installer`
