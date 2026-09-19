# 修复系统 PATH（机器级）——把 Windows 自带的默认目录与盘上确实存在的工具目录写回去。
#
# 背景：机器级 PATH 现在只剩 `C:\Program Files\AskLink`，Windows 自带的
# `%SystemRoot%\system32` 等全没了，于是 `where` / `powershell` / `cmd` 这类系统命令都找不到。
# 本脚本只做一件事：把机器级 PATH 写回一份**可用且可解释**的值，并先备份当前值。
#
# 需要管理员权限（HKLM 写入）。请用同目录的「修复系统PATH.cmd」双击运行——它会自动提权。

$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment'

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host '需要管理员权限：请双击同目录的「修复系统PATH.cmd」（会自动提权）。' -ForegroundColor Red
  exit 1
}

$before = (Get-ItemProperty -Path $key).Path
Write-Host '=== 修改前的机器级 PATH ==='
Write-Host $before
Write-Host ''

# 备份到脚本同目录（带时间戳），万一要回退有据可查
$backup = Join-Path $PSScriptRoot ('机器PATH备份-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
Set-Content -Path $backup -Value $before -Encoding UTF8
Write-Host ("已备份到：" + $backup)

# 目标值：Windows 默认项 + 盘上确实存在的常见机器级工具目录（不存在的自动跳过）
$wanted = @(
  '%SystemRoot%\system32',
  '%SystemRoot%',
  '%SystemRoot%\System32\Wbem',
  '%SYSTEMROOT%\System32\WindowsPowerShell\v1.0\',
  '%SYSTEMROOT%\System32\OpenSSH\',
  'C:\Program Files\dotnet\',
  'C:\Program Files\Docker\Docker\resources\bin',
  'C:\Program Files\AskLink',
  'C:\Program Files\NVIDIA Corporation\NVIDIA app\NvDLISR',
  'C:\Program Files (x86)\NVIDIA Corporation\PhysX\Common'
)
$expanded = [Environment]::ExpandEnvironmentVariables(($wanted -join ';'))
$keep = @()
for ($i = 0; $i -lt $wanted.Count; $i++) {
  $check = ([Environment]::ExpandEnvironmentVariables($wanted[$i])).TrimEnd('\')
  if (Test-Path $check) { $keep += $wanted[$i] }
}
$after = ($keep -join ';')

Write-Host ''
Write-Host '=== 将要写入的机器级 PATH ==='
Write-Host $after
Write-Host ''

# 写回：REG_EXPAND_SZ（保留 %SystemRoot% 这类变量，别写死）
New-ItemProperty -Path $key -Name Path -Value $after -PropertyType ExpandString -Force | Out-Null

# 通知已打开的进程：环境变量变了（不通知的话新开的窗口仍拿旧值）
$signature = @'
using System;
using System.Runtime.InteropServices;
public static class EnvBcast {
  [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
}
'@
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
[void][EnvBcast]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [IntPtr]::Zero, 'Environment', 2, 5000, [ref]([IntPtr]::Zero))

$verify = (Get-ItemProperty -Path $key).Path
Write-Host '=== 写回后从注册表读到的值 ==='
Write-Host $verify
Write-Host ''
if ($verify -like '*System32*' -and $verify -like '*AskLink*') {
  Write-Host '修复完成。请关掉所有已打开的 cmd / PowerShell 窗口再开新的（旧窗口还带着旧环境）。' -ForegroundColor Green
  Write-Host '验证：新开一个 cmd，敲 `where cmd` 与 `where node`。' -ForegroundColor Green
} else {
  Write-Host '写入结果看起来不完整，请把上面的输出发出来。' -ForegroundColor Yellow
}
