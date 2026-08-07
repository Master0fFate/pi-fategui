!include LogicLib.nsh
!include StrFunc.nsh
!include WinMessages.nsh

!ifndef BUILD_UNINSTALLER
  ${StrRep}
  !include nsDialogs.nsh

  Var FateAddToPath
  Var FateAddToPathCheckbox

  !macro customPageAfterChangeDir
    Page custom FateCliPageCreate FateCliPageLeave
  !macroend

  Function FateCliPageCreate
    ${If} ${Silent}
      Abort
    ${EndIf}
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "Command-line launcher"
    Pop $0
    CreateFont $1 "$(^Font)" "$(^FontSize)" "700"
    SendMessage $0 ${WM_SETFONT} $1 1
    ${NSD_CreateCheckbox} 0 34u 100% 18u "Add Fate UI to PATH (enables the fate command)"
    Pop $FateAddToPathCheckbox
    ${NSD_Check} $FateAddToPathCheckbox
    ${NSD_CreateLabel} 0 58u 100% 36u "After installation, open a new terminal in any project and run fate. Fate UI will open that folder through its normal trust prompt."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function FateCliPageLeave
    ${NSD_GetState} $FateAddToPathCheckbox $FateAddToPath
  FunctionEnd

  Function FateAddUserPath
    ReadRegStr $0 HKCU "Environment" "Path"
    ${If} $0 == ""
      StrCpy $0 "$INSTDIR"
    ${Else}
      StrCpy $0 "$0;$INSTDIR"
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
  FunctionEnd

  Function FateAddMachinePath
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    ${If} $0 == ""
      StrCpy $0 "$INSTDIR"
    ${Else}
      StrCpy $0 "$0;$INSTDIR"
    ${EndIf}
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
  FunctionEnd

  Function FateRemoveUserPath
    ReadRegStr $0 HKCU "Environment" "Path"
    StrCpy $0 ";$0;"
    ${StrRep} $0 "$0" ";$INSTDIR;" ";"
    StrCpy $0 "$0" "" 1
    StrLen $1 "$0"
    ${If} $1 > 0
      IntOp $1 $1 - 1
      StrCpy $0 "$0" $1
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
  FunctionEnd

  Function FateRemoveMachinePath
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    StrCpy $0 ";$0;"
    ${StrRep} $0 "$0" ";$INSTDIR;" ";"
    StrCpy $0 "$0" "" 1
    StrLen $1 "$0"
    ${If} $1 > 0
      IntOp $1 $1 - 1
      StrCpy $0 "$0" $1
    ${EndIf}
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
  FunctionEnd

  !macro customInstall
    ${If} $FateAddToPath == ""
      ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "FateCliPath"
      ${If} $0 == "0"
        StrCpy $FateAddToPath "0"
      ${Else}
        StrCpy $FateAddToPath "1"
      ${EndIf}
    ${EndIf}
    ${If} $installMode == "all"
      ${If} $FateAddToPath == "1"
        Call FateRemoveMachinePath
        Call FateAddMachinePath
      ${Else}
        Call FateRemoveMachinePath
      ${EndIf}
    ${Else}
      ${If} $FateAddToPath == "1"
        Call FateRemoveUserPath
        Call FateAddUserPath
      ${Else}
        Call FateRemoveUserPath
      ${EndIf}
    ${EndIf}
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "FateCliPath" "$FateAddToPath"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  !macroend
!else
  ${UnStrRep}

  Function un.FateRemoveUserPath
    ReadRegStr $0 HKCU "Environment" "Path"
    StrCpy $0 ";$0;"
    ${UnStrRep} $0 "$0" ";$INSTDIR;" ";"
    StrCpy $0 "$0" "" 1
    StrLen $1 "$0"
    ${If} $1 > 0
      IntOp $1 $1 - 1
      StrCpy $0 "$0" $1
    ${EndIf}
    WriteRegExpandStr HKCU "Environment" "Path" "$0"
  FunctionEnd

  Function un.FateRemoveMachinePath
    ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
    StrCpy $0 ";$0;"
    ${UnStrRep} $0 "$0" ";$INSTDIR;" ";"
    StrCpy $0 "$0" "" 1
    StrLen $1 "$0"
    ${If} $1 > 0
      IntOp $1 $1 - 1
      StrCpy $0 "$0" $1
    ${EndIf}
    WriteRegExpandStr HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path" "$0"
  FunctionEnd

  !macro customUnInstall
    ${IfNot} ${isUpdated}
      ${If} $installMode == "all"
        Call un.FateRemoveMachinePath
      ${Else}
        Call un.FateRemoveUserPath
      ${EndIf}
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  !macroend
!endif
