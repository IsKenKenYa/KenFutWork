; KenFutWork 安装包自定义钩子（Tauri `bundle.windows.nsis.installerHooks`）。
;
; 这一段补的是「原生安装包」该有的收尾：环境变量 + 注册表 + 广播刷新 + 卸载时逐项清理。
; 目录选择页/桌面快捷方式/开始菜单/卸载入口由 Tauri 的 NSIS 模板本体提供（MUI_PAGE_DIRECTORY
; + MULTIUSER 的「为所有用户 / 仅为我」页），这里不重复实现。
;
; 注意：`WriteRegStr` 这类命令的**根键必须是字面量**（HKLM/HKCU/SHCTX…，不能放变量），
; 所以键位差异（机器级 vs 用户级）只能靠编译期 `!if` 分派，不能靠运行时 `$R0` 拼。
;
; 变量约定：`$INSTDIR` = 安装目录；`SHCTX` = 模板 SetContext 的结果（AllUsers→HKLM，CurrentUser→HKCU）。

!include "WinMessages.nsh"
!include "StrFunc.nsh"
${StrStr}
${UnStrStr}

!define KFW_MACHINE_ENV_KEY "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"

; 让已开着的程序（资源管理器 / cmd）知道环境变量变了
!macro KFW_BROADCAST_ENV
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

/**
 * 收掉「可执行文件在安装目录里」的残留进程（升级/卸载前）。
 *
 * 为什么必须有：模板自带的 `CheckIfAppIsRunning` 只按**主程序名**杀 `kenfutwork-desktop.exe`——
 * 壳一被杀，它拉起的 `app\KenFutWork-server.exe` 与内嵌 `app\pg\bin\postgres.exe` 全成孤儿
 * （Windows 不会连带收子进程），于是安装目录里的文件被占用：实测升级时直接
 * 「无法写入: D:\Program Files\KenFutWork\app\KenFutWork-server.exe」安装中止，
 * 卸载则静默留下 51 MB 删不掉。
 *
 * 按**路径**筛而不是按进程名：按名杀 `postgres.exe` 会误伤用户自己装的 PostgreSQL。
 * 排除 `uninstall.exe`：重装流程里旧卸载器是从 $INSTDIR 里跑的（`_?=` 不复制），杀了它等于自杀。
 */
!macro KFW_KILL_INSTALL_DIR_PROCESSES
  nsExec::ExecToLog "powershell -NoProfile -ExecutionPolicy Bypass -Command $\"Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '$INSTDIR\*' -and $$_.Name -notlike 'uninstall.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\""
  Pop $0
!macroend

; ── 写入：KENFUTWORK_HOME + 安装目录挂 PATH（PATH 是 REG_EXPAND_SZ，读写都要 Expand 版） ──
!macro KFW_ENV_WRITE ROOT SUBKEY
  WriteRegExpandStr ${ROOT} "${SUBKEY}" "KENFUTWORK_HOME" "$INSTDIR"
  ReadRegStr $R0 ${ROOT} "${SUBKEY}" "PATH"
  ${StrStr} $R1 "$R0" "$INSTDIR"
  ${If} $R1 == ""
    ${If} $R0 == ""
      StrCpy $R0 "$INSTDIR"
    ${Else}
      StrCpy $R0 "$R0;$INSTDIR"
    ${EndIf}
    WriteRegExpandStr ${ROOT} "${SUBKEY}" "PATH" "$R0"
  ${EndIf}
!macroend

; ── 清理：只删自己那一段 PATH，不整键覆盖 ──
!macro KFW_ENV_REMOVE ROOT SUBKEY
  DeleteRegValue ${ROOT} "${SUBKEY}" "KENFUTWORK_HOME"
  ReadRegStr $R0 ${ROOT} "${SUBKEY}" "PATH"
  ${If} $R0 != ""
    StrLen $R5 "$INSTDIR"
    ${UnStrStr} $R1 "$R0" ";$INSTDIR"
    ${If} $R1 != ""
      ; 形态 A：<别人>;$INSTDIR[;…]——去掉分隔符与目录本身（IntOp 只吃一个操作数，分两步算）
      IntOp $R4 $R1 + $R5
      IntOp $R4 $R4 + 1
      StrCpy $R2 "$R0" $R1
      StrCpy $R3 "$R0" "" $R4
      StrCpy $R0 "$R2$R3"
    ${Else}
      ; 形态 B：$INSTDIR 就在开头——去掉目录本身与紧随的分号
      StrCpy $R7 "$R0" $R5
      ${If} $R7 == "$INSTDIR"
        StrCpy $R0 "$R0" "" $R5
        StrCpy $R7 "$R0" 1
        ${If} $R7 == ";"
          StrCpy $R0 "$R0" "" 1
        ${EndIf}
      ${EndIf}
    ${EndIf}
    WriteRegExpandStr ${ROOT} "${SUBKEY}" "PATH" "$R0"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; 覆盖安装前先收掉旧版本留下的进程（否则文件被占用，装到一半失败）
  !insertmacro KFW_KILL_INSTALL_DIR_PROCESSES
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !if "${INSTALLMODE}" == "both"
    ${If} $MultiUser.InstallMode == "AllUsers"
      !insertmacro KFW_ENV_WRITE HKLM "${KFW_MACHINE_ENV_KEY}"
    ${Else}
      !insertmacro KFW_ENV_WRITE HKCU "Environment"
    ${EndIf}
  !else if "${INSTALLMODE}" == "perMachine"
    !insertmacro KFW_ENV_WRITE HKLM "${KFW_MACHINE_ENV_KEY}"
  !else
    !insertmacro KFW_ENV_WRITE HKCU "Environment"
  !endif
  ; 安装位置也记一份到自己的注册表键下（卸载器与排障据此知道装在哪）
  WriteRegStr SHCTX "Software\KenFutWork" "InstallDir" "$INSTDIR"
  WriteRegStr SHCTX "Software\KenFutWork" "Version" "${VERSION}"
  !insertmacro KFW_BROADCAST_ENV
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; 卸载前先收掉残留进程，否则安装目录里的文件删不掉（实测残留 51 MB）
  !insertmacro KFW_KILL_INSTALL_DIR_PROCESSES
  !if "${INSTALLMODE}" == "both"
    ${If} $MultiUser.InstallMode == "AllUsers"
      !insertmacro KFW_ENV_REMOVE HKLM "${KFW_MACHINE_ENV_KEY}"
    ${Else}
      !insertmacro KFW_ENV_REMOVE HKCU "Environment"
    ${EndIf}
  !else if "${INSTALLMODE}" == "perMachine"
    !insertmacro KFW_ENV_REMOVE HKLM "${KFW_MACHINE_ENV_KEY}"
  !else
    !insertmacro KFW_ENV_REMOVE HKCU "Environment"
  !endif
  DeleteRegValue SHCTX "Software\KenFutWork" "InstallDir"
  DeleteRegValue SHCTX "Software\KenFutWork" "Version"
  DeleteRegKey /ifempty SHCTX "Software\KenFutWork"
  !insertmacro KFW_BROADCAST_ENV
!macroend
