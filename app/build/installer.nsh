; NSIS additions for the Windows installer (electron-builder.yml: nsis.include). ASCII only.

; --- a running deck is asked to quit before files are replaced or removed ---------------------------
; Closing the deck's window only hides it to the tray, so the plain close electron-builder tries first
; would leave it running. "Hermes Deck.exe --quit" asks the running deck to quit the normal way (it
; closes its Telegram and relay connections). electron-builder's own check runs afterwards and closes
; whatever still runs from the install folder. Defining customCheckAppRunning drops the template's
; include of getProcessInfo.nsh and its pid variable, which that check needs, so both come here.
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
  ${andIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    DetailPrint `Asking "${PRODUCT_NAME}" to quit.`
    nsExec::Exec `"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --quit`
    Pop $R0
    Sleep 3000
  ${endIf}
  !insertmacro _CHECK_APP_RUNNING
!macroend

; --- uninstall also removes the start-at-login entry the app writes (Settings, desktop section) ----------
; The value name must match RUN_NAME in main/autostart.js. An update runs the old uninstaller as well;
; the entry is kept then, since the exe path stays the same.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Hermes Deck"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Hermes Deck"
  ${endIf}
!macroend
