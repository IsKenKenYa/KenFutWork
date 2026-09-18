import { spawn } from "node:child_process";

/**
 * 在**受控浏览器窗口**里唤起它自己的开发者工具（F12）。
 *
 * 为什么非得走这条路：Chrome 打包的 DevTools 前端要靠浏览器的 `InspectorFrontendHost` 桥才能
 * 连上页面——用 CDP `Target.createTarget` 开出来的 `devtools://` 窗口没有那个桥，只会显示
 * 「调试连接已关闭」（真机实测：换会话、换窗口、换中继都试过，一律连不上）。**只有浏览器自己
 * 开的 DevTools 才是真的**，所以这里像人一样：把那个窗口激活，按 F12。
 *
 * 各平台的做法（与 `features/system/directory-picker` 同一个套路：系统级小动作各写各的）：
 * - Windows：PowerShell + Win32（`SetForegroundWindow` + `SendKeys`）
 * - macOS：`osascript`（激活应用 + System Events 按键）
 * - Linux：`xdotool`（`windowactivate` + `key F12`；没装就如实报不可用）
 */

/** 在标题以 `title` 开头的窗口里按 F12（不代表浏览器一定开出来了，调用方要等目标出现）。 */
export type KeySender = (title: string) => Promise<void>;

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} 退出码 ${code ?? "未知"}`)),
    );
  });
}

/**
 * Windows：激活标题匹配的窗口并按 F12（PowerShell 里做，免得多引一个原生依赖）。
 *
 * 标题**内联进脚本**（`$TitleLike = '…'`）而不是当参数传：`-EncodedCommand` 后面不能再带参数
 * （真机踩到：带上 `-TitleLike` 直接以奇怪退出码终止）。单引号按 PS 的规矩翻倍转义。
 */
const WINDOWS_SCRIPT = (title: string): string => `
$TitleLike = '${title.replaceAll("'", "''")}'
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class KfwKeys {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachFlag);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
'@
Add-Type -AssemblyName System.Windows.Forms
$target = [IntPtr]::Zero
[KfwKeys]::EnumWindows({
  param($h, $l)
  $sb = New-Object System.Text.StringBuilder 300
  [void][KfwKeys]::GetWindowText($h, $sb, 300)
  if ($sb.ToString().StartsWith($TitleLike) -and [KfwKeys]::IsWindowVisible($h)) { $script:target = $h; return $false }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($target -eq [IntPtr]::Zero) { Write-Error "找不到窗口：$TitleLike"; exit 2 }
[void][KfwKeys]::ShowWindow($target, 9)
# 前台锁：后台进程直接 SetForegroundWindow 会被 Windows 拒掉（服务端就是这么跑的），
# 先把自己挂到当前前台线程上再抢——这是绕开前台锁的常规做法。
$fore = [KfwKeys]::GetForegroundWindow()
$foreThread = [KfwKeys]::GetWindowThreadProcessId($fore, [IntPtr]::Zero)
$selfThread = [KfwKeys]::GetCurrentThreadId()
[void][KfwKeys]::AttachThreadInput($selfThread, $foreThread, $true)
[void][KfwKeys]::SetForegroundWindow($target)
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("{F12}")
[void][KfwKeys]::AttachThreadInput($selfThread, $foreThread, $false)
Write-Output "ok"
`;

export const sendDevToolsKey: KeySender = async (title) => {
  const platform = process.platform;
  if (platform === "win32") {
    // 脚本走 `-EncodedCommand`（UTF-16LE base64）：命令行里带中文标题不会被转义炸掉
    const encoded = Buffer.from(WINDOWS_SCRIPT(title), "utf16le").toString(
      "base64",
    );
    await run("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ]);
    return;
  }
  if (platform === "darwin") {
    // 先把自己激活（F12 只落在前台窗口），再按键（key code 111 = F12）
    await run("osascript", [
      "-e",
      'tell application "System Events" to set frontmost of (first application process whose name contains "Chrome") to true',
    ]);
    await run("osascript", [
      "-e",
      'tell application "System Events" to key code 111',
    ]);
    return;
  }
  if (platform === "linux") {
    await run("xdotool", [
      "search",
      "--name",
      title,
      "windowactivate",
      "key",
      "F12",
    ]);
    return;
  }
  throw new Error(
    `这个平台（${platform}）还不能唤起开发者工具：请在受控浏览器窗口里按 F12。`,
  );
};
