param([switch]$Serve)
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Invoke-Request($r) {
  # 常驻模式下每个请求都要重置静态状态，避免上一条动作的状态泄漏到当前请求。
  [KenDesktop]::ActionSent = $false
  [KenDesktop]::ExpectedBinding = ""
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
  if ($r.activate) { [KenDesktop]::Focus($pidValue,$name,$window) }
  switch ($r.operation) {
    "status" { $result = @{ accessibility="granted"; screen="granted"; hint="Windows交互桌面已连接；UIA、截图与输入须以实际目标效果验证。更高完整性目标和安全桌面可能拒绝输入。" } }
    "apps" { $result = @([KenDesktop]::Apps()) }
    "displays" { $result = @([KenDesktop]::Displays()) }
    "windows" { $result = @([KenDesktop]::Windows($pidValue,$name)) }
    "geometry" { $result = [KenDesktop]::Select($pidValue,$name,$window) }
    "observe" { $result = [KenDesktop]::Observe($pidValue,$name,$window,$l.maxDepth,$l.maxChildren,$l.titleMaxChars,$l.valueMaxChars,$l.maxActions) }
    "element" { [KenDesktop]::Element($pidValue,$name,$window,$r.index,($null -ne $r.text),$r.text,$l.maxDepth,$l.maxChildren,$l.titleMaxChars,$l.valueMaxChars,$l.maxActions); $result=@{actionSent=$true;detail="已下发UIA动作，请重新观察确认"} }
    "capture" { $result = [KenDesktop]::Capture($pidValue,$name,$window,[string]$r.app.displayId) }
    "focus" { [KenDesktop]::Focus($pidValue,$name,$window); $result=@{actionSent=$true;detail="已激活窗口"} }
    "move" { [KenDesktop]::Move($r.x,$r.y); $result=@{actionSent=$true;detail="已移动指针"} }
    "click" { [KenDesktop]::Click($r.x,$r.y,$r.button,$r.count,$r.delay); $result=@{actionSent=$true;detail="已下发点击"} }
    "drag" { [KenDesktop]::Drag($r.x,$r.y,$r.toX,$r.toY,$r.delay); $result=@{actionSent=$true;detail="已下发拖拽"} }
    "scroll" { if ($null -ne $r.x -and $null -ne $r.y) { [KenDesktop]::Move([int]$r.x,[int]$r.y) }; [KenDesktop]::Scroll($r.direction,$r.amount,$r.delay); $result=@{actionSent=$true;detail="已下发滚动"} }
    "keys" { [KenDesktop]::Keys([string[]]$r.keys,$r.delay,$false); $result=@{actionSent=$true;detail="已下发组合键"} }
    "type" { [KenDesktop]::Type($r.text,$r.delay); $result=@{actionSent=$true;detail="已下发Unicode输入"} }
    "release" { [KenDesktop]::ReleaseMouse(); if($r.keys){[KenDesktop]::Keys([string[]]$r.keys,0,$true)}; $result=@{ok=$true} }
    default { throw "未知Windows桌面操作" }
  }
  # 用对象包装返回值：PowerShell 函数直接返回数组会展开成单个元素，导致结果丢失数组形状。
  return @{ result = $result }
}
try {
  $assemblies = @("UIAutomationClient", "UIAutomationTypes", "System.Drawing", "System.Windows.Forms") | ForEach-Object { Add-Type -AssemblyName $_ -PassThru | Select-Object -First 1 -ExpandProperty Assembly | Select-Object -ExpandProperty Location }
  Add-Type -Path (Join-Path $PSScriptRoot "windows-native.cs") -ReferencedAssemblies $assemblies
  Add-Type -AssemblyName System.Web.Extensions
  [KenDesktop]::Initialize()
} catch {
  $failure = $_.Exception.Message
  [Console]::Out.WriteLine((@{ok=$false;error=$failure;actionSent=$false} | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  exit 1
}
$serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$serializer.RecursionLimit = [int]::MaxValue
[KenDesktop]::ImageByteBudget = [long]0
if ($Serve) {
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    $id = $null
    $budget = [int]::MaxValue
    try {
      $r = $line | ConvertFrom-Json
      $id = $r.id
      if ($r.maxOutputBytes) { $budget = [int]$r.maxOutputBytes }
      $response = Invoke-Request $r
      $payload = @{ok=$true; id=$id; result=$response.result}
    } catch {
      $actionSent = $false
      try { $actionSent = [KenDesktop]::ActionSent } catch {}
      $payload = @{ok=$false; id=$id; error=$_.Exception.Message; actionSent=$actionSent}
    }
    $serializer.MaxJsonLength = $budget
    [Console]::Out.WriteLine($serializer.Serialize($payload))
    [Console]::Out.Flush()
  }
  exit 0
}
try {
  $r = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $serializer.MaxJsonLength = [int]$r.maxOutputBytes
  $response = Invoke-Request $r
  [Console]::WriteLine($serializer.Serialize(@{ok=$true;result=$response.result}))
} catch {
  $failureMessage = $_.Exception.Message
  $actionSent = $false
  try { $actionSent = [KenDesktop]::ActionSent } catch {}
  @{ok=$false;error=$failureMessage;actionSent=$actionSent} | ConvertTo-Json -Compress
  exit 1
}
