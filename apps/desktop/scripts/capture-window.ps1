param(
  # 抓一个窗口的原始像素（含标题栏）到 PNG。
  #
  # 关键点：抓屏进程必须先把自己设成 **PerMonitorV2**（`SetProcessDpiAwarenessContext(-4)`），
  # 否则拿到的是被系统虚拟化过的糊像素，会把「图糊不糊」判反（2026-09-19 踩过）。
  [string]$Exe,
  [string]$Out,
  [int]$WaitMs = 3000
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class KfwCapture {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDpiForWindow(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindByPid(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      uint wpid = 0;
      GetWindowThreadProcessId(h, out wpid);
      if (wpid == pid && IsWindowVisible(h)) {
        RECT r; GetWindowRect(h, out r);
        if ((r.Right - r.Left) > 300 && (r.Bottom - r.Top) > 200) { found = h; return false; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$aware = [KfwCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Drawing

$proc = Start-Process -FilePath $Exe -PassThru
if (-not $proc) { Write-Output "启动失败：$Exe"; exit 1 }
Start-Sleep -Milliseconds $WaitMs

$hwnd = [KfwCapture]::FindByPid([uint32]$proc.Id)
if ($hwnd -eq [IntPtr]::Zero) {
  $proc.Kill()
  Write-Output "没找到窗口（可能是还没画出来，或这个 exe 需要提权）"
  exit 1
}
[void][KfwCapture]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 400

$r = New-Object KfwCapture+RECT
[void][KfwCapture]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
$dpi = [KfwCapture]::GetDpiForWindow($hwnd)

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

$proc.Kill()
Write-Output "dpiAwareCall=$aware window=${w}x${h} dpi=$dpi saved=$Out"
