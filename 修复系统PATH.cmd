@echo off
chcp 65001 >nul
rem 一键修复系统 PATH：自动提权后运行同目录的 修复系统PATH.ps1
rem 背景：机器级 PATH 被改坏（只剩 C:\Program Files\AskLink），where/powershell 等系统命令找不到。
setlocal
set "SCRIPT=%~dp0修复系统PATH.ps1"
if not exist "%SCRIPT%" (
  echo 找不到 %SCRIPT%
  pause
  exit /b 1
)
echo 正在请求管理员权限（会弹一次 UAC）…
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','\"%SCRIPT%\"') -Verb RunAs -Wait"
echo.
echo 完成。关掉这个窗口，重新开一个 cmd 验证：where cmd / where node
pause
