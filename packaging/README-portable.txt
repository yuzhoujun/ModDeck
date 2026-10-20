ModDeck 1.0.0 免安装版
========================

重要：请先完整解压，并优先运行 Start ModDeck.cmd。

正确步骤
--------
1. 右键这个 ZIP，选择“全部解压缩”。
2. 进入解压后的文件夹，确认能看到：
   - ModDeck.exe
   - Start ModDeck.cmd
   - resources 文件夹（里面应有 app.asar）
   - locales 文件夹
3. 双击 Start ModDeck.cmd。

为什么不要直接双击 ModDeck.exe
------------------------------
部分安全软件（腾讯电脑管家、Windows Defender 等）会阻止 Electron 的 Chromium 沙箱初始化，
表现为双击后没有任何窗口。Start ModDeck.cmd 会用 --no-sandbox 参数启动，绕过这个限制。
如果你要自己建快捷方式，目标应写成：
  "ModDeck.exe" --no-sandbox

如果 Windows 提示“Windows 已保护你的电脑”
------------------------------------------
点击“更多信息”，再点“仍要运行”。
这是未签名程序的正常提示，不代表程序有问题。

如果双击后仍然没有窗口
----------------------
1. 确认不是直接在 ZIP 里运行。
2. 把解压后的整个文件夹加入腾讯电脑管家 / Windows Defender 的信任区。
3. 查看启动日志：
   - 优先：ModDeck-data\logs\startup.log（exe 同目录）
   - 或者：ModDeck-logs\startup.log
   - 如果 %APPDATA% 可写：%APPDATA%\ModDeck\logs\startup.log
   如果所有日志都不存在，说明主程序没有启动，通常是安全软件拦截或文件不全。
4. 把 startup.log 发给开发者。

数据位置
--------
正常情况下是 %APPDATA%\ModDeck\。
如果安全软件拦截了 AppData 写入，ModDeck 会自动改用 exe 同目录的 ModDeck-data\。
删除这个数据目录会重置设置和角色元数据（不会删除 Mods）。
