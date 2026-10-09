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
!include "nsDialogs.nsh"
!include "LogicLib.nsh"

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
  ; 用**绝对路径**调 PowerShell：机器级 PATH 一旦被别的软件改坏（真机发生过：System32 不在 PATH 里），
  ; 靠名字 `powershell` 就找不到，这一步会静默失效。
  nsExec::ExecToLog "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -Command $\"Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -like '$INSTDIR\*' -and $$_.Name -notlike 'uninstall.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }$\""
  Pop $0
!macroend

; ── 写入：只写 KENFUTWORK_HOME ──
;
; **不再改动 PATH**（2026-09-19 摘除）。原来的做法是「读出旧 PATH → 追加安装目录 → 写回」，
; 看着无害，但有一个致命的失败态：`ReadRegStr` 在值超长（NSIS 字符串上限 1024）或读失败时返回空串，
; 而当时的兜底写的是 `$INSTDIR` —— **一旦发生，机器级 PATH 就只剩安装目录**，
; 用户那边表现为 `where` / `powershell` / `cmd` 这些系统命令全部找不到（System32 不在 PATH 里了）。
; 同一天真机上确实发生了机器级 PATH 被清空（值只剩 `C:\Program Files\AskLink`）——
; 虽然形态与我们的写入不符（我们只会写成 `旧值;安装目录` 或 `安装目录`），但这类「装个软件动全机 PATH」
; 的写法本身就不该出现在安装器里：**收益（命令行少敲几个字）远小于风险（整机环境被毁）**。
; 需要命令行入口的用户，可以用 KENFUTWORK_HOME 自己拼，或手动把安装目录加进 PATH。
!macro KFW_ENV_WRITE ROOT SUBKEY
  WriteRegExpandStr ${ROOT} "${SUBKEY}" "KENFUTWORK_HOME" "$INSTDIR"
!macroend

; ── 清理：只删自己写的那一项（PATH 一律不碰，理由见上面的写入宏） ──
!macro KFW_ENV_REMOVE ROOT SUBKEY
  DeleteRegValue ${ROOT} "${SUBKEY}" "KENFUTWORK_HOME"
!macroend

; ── 内置运行时逐项选择（安装末尾的 nsDialogs 对话框） ──
;
; 五个复选框默认全选；确定后未勾选的目录逐个删除（对应 runtimes.ts 的包内布局：
; app\runtime\{node,python,jdk,uv,git}）。静默安装（/S）直接跳过（默认全保留）；
; 点「取消」时勾选状态保持默认，即不删任何目录（等价「什么都不改」）。
; 变量占用：句柄 $1-$5、读状态 $R0——都在 Section 内临时使用，不跨调用存活。
!macro KFW_RUNTIME_PICK
  IfSilent kfw_runtime_pick_done

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Goto kfw_runtime_pick_done
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 26u "选择要保留的内置运行时（不勾选的将从安装目录删除，Agent 改用系统里已安装的对应工具）："
  Pop $0

  ${NSD_CreateCheckBox} 0 32u 100% 12u "Node（约 63MB）"
  Pop $1
  ${NSD_Check} $1
  ${NSD_CreateCheckBox} 0 46u 100% 12u "Python（约 89MB）"
  Pop $2
  ${NSD_Check} $2
  ${NSD_CreateCheckBox} 0 60u 100% 12u "JDK（约 81MB）"
  Pop $3
  ${NSD_Check} $3
  ${NSD_CreateCheckBox} 0 74u 100% 12u "uv（约 23MB）"
  Pop $4
  ${NSD_Check} $4
  ${NSD_CreateCheckBox} 0 88u 100% 12u "Git（约 65MB；系统已装 Git 时此项无影响）"
  Pop $5
  ${NSD_Check} $5

  nsDialogs::Show

  ${NSD_GetState} $1 $R0
  ${If} $R0 != ${BST_CHECKED}
    RMDir /r "$INSTDIR\app\runtime\node"
  ${EndIf}
  ${NSD_GetState} $2 $R0
  ${If} $R0 != ${BST_CHECKED}
    RMDir /r "$INSTDIR\app\runtime\python"
  ${EndIf}
  ${NSD_GetState} $3 $R0
  ${If} $R0 != ${BST_CHECKED}
    RMDir /r "$INSTDIR\app\runtime\jdk"
  ${EndIf}
  ${NSD_GetState} $4 $R0
  ${If} $R0 != ${BST_CHECKED}
    RMDir /r "$INSTDIR\app\runtime\uv"
  ${EndIf}
  ${NSD_GetState} $5 $R0
  ${If} $R0 != ${BST_CHECKED}
    RMDir /r "$INSTDIR\app\runtime\git"
  ${EndIf}

  ; 全不勾时 runtime 可能已空，顺手收掉空目录（还有别的文件则保留）
  RMDir "$INSTDIR\app\runtime"

  kfw_runtime_pick_done:
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

  ; ── 内置运行时（Node / Python / JDK / uv / Git）：逐项选择是否保留 ──
  ;
  ; 为什么不是标准「组件页」：Tauri 的 NSIS 模板是**单 Section 统一解压** resources，
  ; 配置层面无法把 runtime 分节、hooks 也没有「加页面」的插入点；这里用 nsDialogs
  ; 在安装末尾弹一个五复选框对话框，未勾选的目录逐个删除——磁盘结果与「按需安装」
  ; 一致（下载体积不变，运行时仍在安装器里）。真·「不下载/不解压」需 fork 自定义
  ; NSIS 模板（把 runtime 从 resources 拆出来单独 File），维护成本高，暂不做。
  ; 静默安装（/S）不弹窗，默认全保留；点「取消」等同保持默认（全保留、不删任何东西）。
  !insertmacro KFW_RUNTIME_PICK
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
