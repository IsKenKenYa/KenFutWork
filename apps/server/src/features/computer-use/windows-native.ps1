$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $assemblies = @("UIAutomationClient", "UIAutomationTypes", "System.Drawing", "System.Windows.Forms") | ForEach-Object { Add-Type -AssemblyName $_ -PassThru | Select-Object -First 1 -ExpandProperty Assembly | Select-Object -ExpandProperty Location }
  Add-Type -Path (Join-Path $PSScriptRoot "windows-native.cs") -ReferencedAssemblies $assemblies
  Add-Type -AssemblyName System.Web.Extensions
  [KenDesktop]::Initialize()
  $r = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [KenDesktop]::ImageByteBudget = [long]$r.maxOutputBytes
  $pidValue = if ($r.app.pid) { [int]$r.app.pid } else { 0 }
  $name = [string]$r.app.name
  $window = [long]$r.app.windowId
  if ($r.app -and !$r.app.displayId -and $r.operation -ne "release") {
    [KenDesktop]::ExpectedBinding = [string]$r.expectedBinding
    $selected = [KenDesktop]::Select($pidValue,$name,$window)
    $window = $selected.windowId
    [KenDesktop]::ExpectedBinding = $selected.binding
  }
  $l = $r.limits
  switch ($r.operation) {
    "status" { $result = @{ accessibility="granted"; screen="granted"; hint="Windows交互桌面已连接；UIA、截图与输入须以实际目标效果验证。更高完整性目标和安全桌面可能拒绝输入。" } }
    "apps" { $result = @([KenDesktop]::Apps()) }
    "displays" { $result = @([KenDesktop]::Displays()) }
    "windows" { $result = @([KenDesktop]::Windows($pidValue,$name)) }
    "geometry" { $result = [KenDesktop]::Select($pidValue,$name,$window) }
    "observe" { $result = [KenDesktop]::Observe($pidValue,$name,$window,$l.maxDepth,$l.maxChildren,$l.titleMaxChars,$l.valueMaxChars,$l.maxActions) }
    "element" { [KenDesktop]::Element($pidValue,$name,$window,$r.index,$r.text,$l.maxDepth,$l.maxChildren,$l.titleMaxChars,$l.valueMaxChars,$l.maxActions); $result=@{actionSent=$true;detail="已下发UIA动作，请重新观察确认"} }
    "capture" { $result = [KenDesktop]::Capture($pidValue,$name,$window,[string]$r.app.displayId) }
    "focus" { [KenDesktop]::Focus($pidValue,$name,$window); $result=@{actionSent=$true;detail="已激活窗口"} }
    "move" { [KenDesktop]::Move($r.x,$r.y); $result=@{actionSent=$true;detail="已移动指针"} }
    "click" { [KenDesktop]::Click($r.x,$r.y,$r.button,$r.count,$r.delay); $result=@{actionSent=$true;detail="已下发点击"} }
    "drag" { [KenDesktop]::Drag($r.x,$r.y,$r.toX,$r.toY,$r.delay); $result=@{actionSent=$true;detail="已下发拖拽"} }
    "scroll" { [KenDesktop]::Scroll($r.direction,$r.amount,$r.delay); $result=@{actionSent=$true;detail="已下发滚动"} }
    "keys" { [KenDesktop]::Keys([string[]]$r.keys,$r.delay,$false); $result=@{actionSent=$true;detail="已下发组合键"} }
    "type" { [KenDesktop]::Type($r.text,$r.delay); $result=@{actionSent=$true;detail="已下发Unicode输入"} }
    "release" { [KenDesktop]::ReleaseMouse(); if($r.keys){[KenDesktop]::Keys([string[]]$r.keys,0,$true)}; $result=@{ok=$true} }
    default { throw "未知Windows桌面操作" }
  }
  $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
  $serializer.RecursionLimit = [int]::MaxValue
  $serializer.MaxJsonLength = [int]$r.maxOutputBytes
  [Console]::WriteLine($serializer.Serialize(@{ok=$true;result=$result}))
} catch {
  $failureMessage = $_.Exception.Message
  $actionSent = $false
  try { $actionSent = [KenDesktop]::ActionSent } catch {}
  @{ok=$false;error=$failureMessage;actionSent=$actionSent} | ConvertTo-Json -Compress
  exit 1
}
