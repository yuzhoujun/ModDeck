!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove ModDeck's shared v2/v3 data directory (%APPDATA%\ModDeck) only on real uninstalls
  ; when the user checks "Delete app data", never during in-place upgrades ($UpdateMode = 1).
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RmDir /r "$APPDATA\ModDeck"
  ${EndIf}
!macroend
