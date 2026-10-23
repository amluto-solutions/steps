; The setup .exe's hooks (tauri.conf.json > bundle > windows > nsis > installerHooks), included by
; Tauri's installer.nsi before its own !defines, so the old names are spelt out here. In a folder of
; its own: every .nsh directly in nsis/ is taken for one of the setup's languages.
;
; Up to 0.2.6 the product was "Amluto Steps". Tauri finds an earlier install by the product name
; (its folder, its uninstall entry and its Software key), so from 0.2.7 a setup or update never
; saw that copy: it installed Steps beside it in %LOCALAPPDATA%\Steps and left "Amluto Steps" in
; Apps, the Start menu and %LOCALAPPDATA%\Amluto Steps (found 10/10/2026, 0.2.3 updated to 1.0.0).
; Once the new copy is in, the old one is removed with its own uninstaller.

!define OLD_PRODUCTNAME "Amluto Steps"
!define OLD_MANUFACTURER "Amluto Solutions Ltd"
!define OLD_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCTNAME}"
!define OLD_MANUPRODUCTKEY "Software\${OLD_MANUFACTURER}\${OLD_PRODUCTNAME}"

!macro NSIS_HOOK_POSTINSTALL
  ; Both were per-person installs, so the old copy's keys are in HKCU.
  ReadRegStr $R8 HKCU "${OLD_UNINSTKEY}" "Publisher"
  ReadRegStr $R9 HKCU "${OLD_MANUPRODUCTKEY}" ""
  ; Only Amluto's own copy, and never the folder just installed into (someone who chose the old
  ; folder for the new copy would otherwise lose it).
  ${If} $R8 == "${OLD_MANUFACTURER}"
  ${AndIf} $R9 != ""
  ${AndIf} $R9 != $INSTDIR
  ${AndIf} ${FileExists} "$R9\uninstall.exe"
    ; /UPDATE: the old uninstaller then leaves the Start with Windows value (Steps moves it to the
    ; new name when it next starts) and the shortcuts, and never touches the app's data, which
    ; both copies share (com.amluto.steps). _?= makes ExecWait wait for it.
    ExecWait '"$R9\uninstall.exe" /S /UPDATE _?=$R9' $R7
    ${IfNot} ${Errors}
    ${AndIf} $R7 = 0
    ${AndIfNot} ${FileExists} "$R9\${MAINBINARYNAME}.exe"
      ; Run in place, the uninstaller can't delete itself or its folder.
      Delete "$R9\uninstall.exe"
      RMDir "$R9"

      ; The old shortcuts, only where they still point at the old program.
      !insertmacro IsShortcutTarget "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk" "$R9\${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 = 1
        !insertmacro UnpinShortcut "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
        Delete "$SMPROGRAMS\${OLD_PRODUCTNAME}.lnk"
      ${EndIf}
      !insertmacro IsShortcutTarget "$DESKTOP\${OLD_PRODUCTNAME}.lnk" "$R9\${MAINBINARYNAME}.exe"
      Pop $0
      ${If} $0 = 1
        !insertmacro UnpinShortcut "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
        Delete "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
      ${EndIf}

      DeleteRegKey HKCU "${OLD_MANUPRODUCTKEY}"
    ${EndIf}
    ClearErrors
  ${EndIf}
!macroend
