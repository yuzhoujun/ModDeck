#define MyAppName "ModDeck"
#ifndef MyAppVersion
#define MyAppVersion "1.0.0"
#endif
#define MyAppPublisher "ModDeck contributors"
#define MyAppExeName "ModDeck.exe"

#ifndef AppDir
#define AppDir "..\release\win-unpacked"
#endif

[Setup]
AppId={{6F1C7B2E-3A4D-4E8F-9B1A-5C2D7E8F0A31}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\release
OutputBaseFilename=ModDeck-{#MyAppVersion}-Setup
SetupIconFile=..\build\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
Source: "{#AppDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--no-sandbox"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Parameters: "--no-sandbox"; Tasks: desktopicon
Name: "{autoprograms}\{#MyAppName} (CMD)"; Filename: "{app}\ModDeck.cmd"

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--no-sandbox"; Description: "Launch ModDeck"; Flags: nowait postinstall skipifsilent
