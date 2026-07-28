; NSIS installer hooks -- wired in through `bundle.windows.nsis.installerHooks`.
;
; Pragma is not one process. The desktop app deliberately *detaches* a
; persistent `pragma-server` (it owns the terminal sessions, so it outlives the
; window by design), a `pragma-gateway`, and the sidecars listed under
; `bundle.externalBin`. Every one of them runs from `$INSTDIR` -- which for the
; default `currentUser` install mode is `%LOCALAPPDATA%\Pragma`, i.e. inside
; AppData.
;
; Windows locks a running executable's image file, so installing over a live
; instance fails on the first sidecar the installer tries to overwrite:
;
;   Error opening file for writing:
;   C:\Users\<user>\AppData\Local\Pragma\pragma-server.exe
;
; Tauri's own template only waits for the main binary (it inserts
; `CheckIfAppIsRunning "${MAINBINARYNAME}.exe"` and nothing else), so stopping
; the sidecars is on us. Both hooks below are needed: `PREINSTALL` runs ahead of
; the `File` writes, and `PREUNINSTALL` ahead of the `Delete`s -- a locked file
; there is skipped *silently*, leaving orphaned binaries and a `$INSTDIR` that
; `RMDir` then refuses to remove.
;
; Nothing here ships in the app: these macros run only inside `setup.exe` and
; `uninstall.exe`. The server still detaches and outlives the window at runtime.

; Set while probing, so the warning below is asked at most once.
Var PragmaSidecarRunning

; The bundled sidecars, listed once. `_ACTION` is a macro applied to each name.
;
; Keep this list in step with `bundle.externalBin` in `tauri.conf.json`.
; `installer-hooks.test.ts` fails if the two drift, because a sidecar missing
; from here is invisible until someone installs over a running app.
!macro PragmaForEachSidecar _ACTION
  !insertmacro ${_ACTION} "pragma-server.exe"
  !insertmacro ${_ACTION} "pragma-gateway.exe"
  !insertmacro ${_ACTION} "pragma-cli.exe"
  !insertmacro ${_ACTION} "pragma-ai.exe"
  !insertmacro ${_ACTION} "pragma-github.exe"
  !insertmacro ${_ACTION} "pragma-watch.exe"
  !insertmacro ${_ACTION} "pragma-automations.exe"
  !insertmacro ${_ACTION} "pragma-plugins.exe"
!macroend

; Pushes 0 if `_NAME` is running. The current-user variants are used wherever
; the install itself is per-user: another account's Pragma is neither ours to
; kill nor in our way. `INSTALLMODE` is defined after this file is included, so
; the test has to sit inside a macro body -- it is evaluated on insertion.
!macro PragmaFindProcess _NAME
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::FindProcessCurrentUser "${_NAME}"
  !else
    nsis_tauri_utils::FindProcess "${_NAME}"
  !endif
!macroend

!macro PragmaKillProcess _NAME
  !if "${INSTALLMODE}" == "currentUser"
    nsis_tauri_utils::KillProcessCurrentUser "${_NAME}"
  !else
    nsis_tauri_utils::KillProcess "${_NAME}"
  !endif
!macroend

!macro NotePragmaSidecar _NAME
  ${If} $PragmaSidecarRunning != 1
    !insertmacro PragmaFindProcess "${_NAME}"
    Pop $R0
    ${If} $R0 = 0
      StrCpy $PragmaSidecarRunning 1
    ${EndIf}
  ${EndIf}
!macroend

!macro StopPragmaSidecar _NAME
  !insertmacro PragmaFindProcess "${_NAME}"
  Pop $R0
  ${If} $R0 = 0
    DetailPrint "Stopping ${_NAME}"
    !insertmacro PragmaKillProcess "${_NAME}"
    Pop $R0
    Sleep 500
  ${EndIf}
!macroend

!macro StopPragma
  ; With the window open, Tauri's own prompt (inserted just below) does the
  ; warning. With it closed nothing would ask -- yet the server is still there
  ; holding the user's terminal sessions, and replacing its binary ends them.
  ; Warn for exactly that case, which keeps the total at one dialog either way.
  ; The string is not localized: Tauri owns the `.nsh` language files and a hook
  ; cannot add to them.
  StrCpy $PragmaSidecarRunning 0
  !insertmacro PragmaFindProcess "${MAINBINARYNAME}.exe"
  Pop $R0
  ${If} $R0 <> 0
    !insertmacro PragmaForEachSidecar NotePragmaSidecar
    ; `${Silent}` covers `/S`; `$PassiveMode` covers the updater. Neither may
    ; block on a dialog -- the same rule Tauri's own check follows. LogicLib
    ; generates its own labels, so this macro stays safe to insert twice.
    ${If} $PragmaSidecarRunning = 1
    ${AndIfNot} ${Silent}
    ${AndIf} $PassiveMode != 1
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
        "${PRODUCTNAME} is still running in the background.$\r$\n$\r$\nContinuing will end any active terminal sessions." \
        /SD IDOK IDOK +2
      Quit
    ${EndIf}
  ${EndIf}

  ; The app restarts the server and the gateway as soon as it notices them gone
  ; (`ensure_gateway_in_background`, and the agent-event bridge's reconnect
  ; loop), so it has to stop *first* or the kills below race a respawn and the
  ; file is locked again by the time `File` reaches it. Tauri inserts this same
  ; macro immediately after the hook returns; by then nothing matches and it is
  ; a no-op, so the user is still prompted exactly once.
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  !insertmacro PragmaForEachSidecar StopPragmaSidecar
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro StopPragma
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro StopPragma
!macroend
