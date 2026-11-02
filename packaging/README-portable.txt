ModDeck 2.4.x 免安装便携版 / Portable Edition
===================================================

[中文说明 / Chinese Guide]
--------------------------

重要：请先完整解压，不要直接在压缩包内运行。

正确启动步骤
------------
1. 右键这个 ZIP 压缩包，选择“全部解压缩”。
2. 进入解压后的文件夹，确认能看到：
   - ModDeck.exe
   - ModDeck.cmd
   - resources/ 文件夹（内含 app.asar）
   - languages/ 文件夹（中英文及外部扩展语言包 JSON）
   - locales/ 文件夹（Chromium 底层系统支持）
3. 双击 ModDeck.exe 启动。

为什么直接双击 ModDeck.exe 可能没有反应
--------------------------------------
部分安全软件（腾讯电脑管家、360、Windows Defender 等）会阻止 Electron 的 Chromium 沙箱初始化。
沙箱在应用代码执行前就已初始化，程序内部无法给自己补充启动参数，因此直接双击可能出现没有窗口的现象。
如果遇到此情况，请直接双击同目录下的 ModDeck.cmd 启动，该脚本会自动携带 --no-sandbox 兼容参数绕过此限制。

如何为 ModDeck 创建带参数的桌面快捷方式
----------------------------------------
1. 右键 ModDeck.exe → “显示更多选项” → “发送到” → “桌面快捷方式”；
2. 在桌面上右键该快捷方式 → “属性”；
3. 在“目标”一栏末尾加一个空格，并追加 --no-sandbox（例如："D:\ModDeck\ModDeck.exe" --no-sandbox）；
4. 点击确定，以后直接双击桌面快捷方式即可。

如果 Windows 提示“Windows 已保护你的电脑”
------------------------------------------
点击“更多信息”，再点击“仍要运行”。
这是未签名开源程序的正常系统提示，不代表程序存在安全问题。

排错与日志定位
--------------
如果双击后仍然没有窗口：
1. 确认已完整解压，未在 ZIP 内直接运行；
2. 将解压后的整个目录加入安全软件的信任区；
3. 查看启动排错日志：
   - 优先：%APPDATA%\ModDeck\logs\startup.log
   - 便携数据目录：ModDeck-data\logs\startup.log
4. 将 startup.log 反馈给开发者。

数据存储位置
------------
默认保存在 %APPDATA%\ModDeck\。
若系统限制写入 AppData，ModDeck 会自动降级写入同目录的 ModDeck-data\。
删除数据目录会重置软件设置与角色元数据（绝不会删除您的游戏 Mods 目录文件）。


===================================================

[English Guide]
--------------------------

IMPORTANT: Please extract the entire archive before running. Do not run directly from inside the ZIP.

Quick Start
-----------
1. Right-click the ZIP archive and select "Extract All...".
2. Open the extracted folder and verify the presence of:
   - ModDeck.exe
   - ModDeck.cmd
   - resources/ (contains app.asar)
   - languages/ (UI translation dictionaries)
   - locales/ (Chromium runtime support)
3. Double-click ModDeck.exe to launch.

Why ModDeck.exe May Fail to Open
--------------------------------
Certain antivirus software or Windows Defender policies may restrict Electron's Chromium sandbox initialization.
Because the sandbox initializes before application code runs, ModDeck cannot pass flags to itself from within.
If double-clicking ModDeck.exe produces no window, launch via ModDeck.cmd in the same directory (which automatically passes the `--no-sandbox` flag).

Creating a Desktop Shortcut with `--no-sandbox`
-----------------------------------------------
1. Right-click ModDeck.exe -> "Create shortcut".
2. Right-click the newly created shortcut -> "Properties".
3. In the "Target" field, append a space and `--no-sandbox` to the end (e.g., `"D:\ModDeck\ModDeck.exe" --no-sandbox`).
4. Click OK. You can now launch directly from this desktop shortcut.

If Windows SmartScreen Appears
------------------------------
Click "More info", then click "Run anyway".
This is a standard Windows prompt for newly built, open-source binaries that do not carry commercial code-signing certificates.

Troubleshooting & Startup Logs
------------------------------
If no window appears after launching:
1. Ensure the archive is fully extracted (not running inside ZIP).
2. Add the ModDeck folder to your antivirus whitelist/exclusion list.
3. Check the startup log file:
   - Default: %APPDATA%\ModDeck\logs\startup.log
   - Portable data mode: ModDeck-data\logs\startup.log
4. Provide startup.log to the developer for diagnostics.

Data Storage
------------
ModDeck stores all user presets, character metadata, and configs under `%APPDATA%\ModDeck\`.
If AppData write permissions are restricted, ModDeck automatically falls back to `ModDeck-data\` inside the application folder.
Deleting the data directory resets your app settings and presets, but NEVER deletes your game Mods.
