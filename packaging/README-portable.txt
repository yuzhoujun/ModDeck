ModDeck 3.x Portable Edition / 免安装便携版
============================================

[English Guide]
---------------

IMPORTANT: Please extract the entire archive before running. Do not launch directly from inside a ZIP viewer.

Quick Start
-----------
1. Right-click the ZIP archive and choose "Extract All...".
2. Open the extracted folder and verify the files:
   - ModDeck.exe      (Single-file Tauri 2 + Rust native application)
   - languages/       (Built-in zh-CN / en-US dictionaries & external locale drop-in folder)
   - README.txt       (This guide)
3. Double-click ModDeck.exe to launch.

System Requirements (Windows WebView2)
--------------------------------------
- Windows 10 / Windows 11 64-bit (x64).
- Requires Microsoft Edge WebView2 Runtime (pre-installed on Windows 11 and updated Windows 10).
- If WebView2 Runtime is missing on stripped Windows builds, ModDeck will notify you on startup and offer to open Microsoft's official download page:
  https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section

If Windows SmartScreen Appears
------------------------------
Click "More info", then click "Run anyway".
This is a normal Windows prompt for unsigned open-source binaries.

Troubleshooting & Crash Logs
----------------------------
If no window appears or startup fails:
1. Ensure the archive is fully extracted to a writable folder (not inside the ZIP).
2. Add the extracted ModDeck folder to your antivirus whitelist if blocked.
3. Check diagnostic logs:
   - Default: %APPDATA%\ModDeck\logs\tauri-crash.log
   - Portable fallback: ModDeck-data\logs\tauri-crash.log
4. Attach tauri-crash.log when opening a GitHub Issue.

Data Storage Location
---------------------
Settings, variant presets, roster schemes, and backups are stored in %APPDATA%\ModDeck\ by default
(identical to ModDeck v2.x, allowing seamless lossless migration).
If AppData is unavailable/read-only, ModDeck falls back to ModDeck-data\ next to ModDeck.exe.
Deleting ModDeck data will never delete files inside your game's Mods folder.


============================================

[简体中文说明]
--------------

重要：请先将压缩包完整解压到普通文件夹，不要在压缩包预览窗口内直接双击运行。

正确启动步骤
------------
1. 右键下载的 ZIP 压缩包，选择“全部解压缩”。
2. 确认解压后的目录内包含：
   - ModDeck.exe      （Tauri 2 + Rust 原生单文件主程序）
   - languages/       （界面词典与社区扩展语言包目录）
   - README.txt       （本说明文件）
3. 直接双击 ModDeck.exe 即可启动。

运行环境要求（Windows WebView2）
--------------------------------
- 支持 Windows 10 / Windows 11 64 位（x64）。
- 依赖系统内置的 Microsoft Edge WebView2 运行库（Win11 及常规 Win10 已自带）。
- 若精简版系统缺少 WebView2 运行库，ModDeck 启动时会主动提示并引导打开微软官方下载页（安装 Evergreen Bootstrapper 后重启即可）。

若出现“Windows 已保护你的电脑”
--------------------------------
请点击“更多信息” -> “仍要运行”。未签名的开源独立可执行文件均会出现此系统提示，属于正常现象。

排错与日志定位
--------------
如果双击无法启动或创建窗口报错：
1. 确认已完整解压至非只读目录（不要在压缩包内直接运行）；
2. 如被安全软件拦截，请将解压目录加入信任区；
3. 查看运行日志：
   - 默认路径：%APPDATA%\ModDeck\logs\tauri-crash.log
   - 便携数据路径：同目录 ModDeck-data\logs\tauri-crash.log
4. 提交 GitHub Issue 时可一并附上 tauri-crash.log。

本地数据目录说明
----------------
默认保存在 %APPDATA%\ModDeck\（与 ModDeck v2.x 完全共用同一目录与 JSON 结构，升级后可直接无损继承全部设置、预设、方案与封面）。
当系统限制写入 AppData 时会自动降级使用程序同级目录 ModDeck-data\。
清理 ModDeck 数据目录绝不会影响或删除您游戏 Mods 目录内的 Mod 文件。
