# 构建与发布

本文档描述 ModDeck 的构建方式。日常开发只需要 `npm run dev`；发布使用免安装 ZIP。

## 环境

- Windows 10 / 11 x64
- Node.js 22+（开发时使用 24）
- Git
- 7-Zip（生成免安装 ZIP 需要）

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

如果 `release\win-unpacked` 被占用（杀毒/资源管理器锁定），可以换一个构建目录：

```powershell
$env:MODDECK_BUILD_ROOT = "release-build"
npm run package:portable
```

ZIP 仍然输出到 `release/`。

## 免安装版

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
release/ModDeck-<version>-win-x64.zip
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

## 安装版：已放弃

V2 不再提供 `.exe` 安装器。

原因是环境限制，不是安装器内容：Inno Setup 和 NSIS 在启动阶段都需要在
`%TEMP%` 创建临时目录，而这台机器上的安全策略会直接返回
`Error 5: 拒绝访问`，即使把 TEMP 指向其他可写目录也一样。MSI 同样依赖临时目录，
换打包工具解决不了。

因此安装方式统一为：

1. 解压 `ModDeck-<version>-win-x64.zip`
2. 双击 `ModDeck.cmd`

如果以后要做安装器，前置条件是：代码签名证书，或在目标机器上把安装器加入安全软件信任区，
并实际验证安装/卸载流程。

## 开发与验证

```bash
npm run dev        # 开发窗口
npm run typecheck  # 类型检查
npm run build      # 只构建 out/
npm run smoke      # 无头冒烟测试
```

`npm run smoke` 会在 `temp/fixture` 生成假 Mod 库，在 `temp/smoke-data` 生成独立配置，
截图与结果输出到 `temp/smoke/`。它不会接触真实 Mods 目录。

## 版本号与发布

版本号在 `package.json` 的 `version`；产物文件名会自动带上这个版本。

发布规则：

- GitHub Release 只发 `1.0.0`、`2.0.0` 这类大版本。
- `2.0.1`、`2.0.2` 这类小版本只在本地构建和验证，不单独发 Release。
- 每次构建前更新根目录 [CHANGELOG.md](../CHANGELOG.md)，写清本地小版本内容。

## 发布检查清单

- [ ] `npm run typecheck`
- [ ] `npm run smoke`
- [ ] `npm run package:portable`
- [ ] 解压 ZIP，双击 `ModDeck.cmd` 能打开
- [ ] 检查 `resources/app.asar` 存在
- [ ] 记录 ZIP 的 SHA256
