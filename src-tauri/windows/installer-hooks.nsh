!macro NSIS_HOOK_PREINSTALL
  Delete "$INSTDIR\vterminal-docs.exe"
  Delete "$INSTDIR\llama.dll"
  Delete "$INSTDIR\ggml.dll"
  Delete "$INSTDIR\ggml-base.dll"
  Delete "$INSTDIR\llama-backends\*.dll"
  RMDir "$INSTDIR\llama-backends"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$LOCALAPPDATA\Programs\VTerminal\bin"

  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\vterminal-docs.exe"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\vterminal-docs.exe" "$LOCALAPPDATA\Programs\VTerminal\bin\vterminal-docs.exe"
  IfErrors 0 +2
    Abort "Could not install the VTerminal companion."

  ; Clear any local payload left by a same-user feature-on installation before
  ; either installing its replacement or deliberately downgrading feature-off.
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\llama.dll"
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\ggml.dll"
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\ggml-base.dll"
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\llama-backends\*.dll"
  RMDir "$LOCALAPPDATA\Programs\VTerminal\bin\llama-backends"

  ; Feature-off preview installers have no local runtime. Their companion is a
  ; pure-Rust/cloud binary, so skip this optional block when llama.dll is absent.
  IfFileExists "$INSTDIR\llama.dll" vterminal_install_local_runtime vterminal_install_path
vterminal_install_local_runtime:
  ; The companion imports these before Rust main(), so they must sit beside it.
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\llama.dll" "$LOCALAPPDATA\Programs\VTerminal\bin\llama.dll"
  CopyFiles /SILENT "$INSTDIR\ggml.dll" "$LOCALAPPDATA\Programs\VTerminal\bin\ggml.dll"
  CopyFiles /SILENT "$INSTDIR\ggml-base.dll" "$LOCALAPPDATA\Programs\VTerminal\bin\ggml-base.dll"
  IfErrors 0 +2
    Abort "Could not install the VTerminal companion runtime."

  CreateDirectory "$LOCALAPPDATA\Programs\VTerminal\bin\llama-backends"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\llama-backends\*.dll" "$LOCALAPPDATA\Programs\VTerminal\bin\llama-backends"
  IfErrors 0 +2
    Abort "Could not install the VTerminal local-inference backends."

vterminal_install_path:
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows-cli-path.ps1" -Mode add -Directory "$LOCALAPPDATA\Programs\VTerminal\bin"'
  Pop $0
  StrCmp $0 "0" +2
    Abort "Could not add the VTerminal companion directory to the user PATH (exit $0)."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows-cli-path.ps1" -Mode remove -Directory "$LOCALAPPDATA\Programs\VTerminal\bin"'
  Pop $0
  StrCmp $0 "0" +2
    Abort "Could not remove the VTerminal companion directory from the user PATH (exit $0)."
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\llama-backends\*.dll"
  RMDir "$LOCALAPPDATA\Programs\VTerminal\bin\llama-backends"
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\llama.dll"
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\ggml.dll"
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\ggml-base.dll"
  Delete "$LOCALAPPDATA\Programs\VTerminal\bin\vterminal-docs.exe"
  RMDir "$LOCALAPPDATA\Programs\VTerminal\bin"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
!macroend
