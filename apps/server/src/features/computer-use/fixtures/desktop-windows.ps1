$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProbeDpi {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
}
'@
[ProbeDpi]::SetThreadDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
[Windows.Forms.Application]::EnableVisualStyles()
$form = [Windows.Forms.Form]::new()
$form.Text = "KenFutWork Windows 桌面验收"
$form.StartPosition = "Manual"
$form.Location = [Drawing.Point]::new(150,150)
$form.ClientSize = [Drawing.Size]::new(480,360)
$form.AutoScaleMode = "None"
$button = [Windows.Forms.Button]::new()
$button.Text = "验收按钮"
$button.AccessibleName = "验收按钮"
$button.SetBounds(40,30,180,40)
$label = [Windows.Forms.Label]::new()
$label.Text = "点击数：0"
$label.SetBounds(40,80,250,24)
$entry = [Windows.Forms.TextBox]::new()
$entry.AccessibleName = "验收输入"
$entry.SetBounds(40,115,300,30)
$panel = [Windows.Forms.Panel]::new()
$panel.BackColor = [Drawing.Color]::White
$panel.TabStop = $true
$panel.SetBounds(0,180,480,180)
$script:count = 0
$button.Add_Click({ $script:count++; $label.Text="点击数：$script:count"; [Console]::WriteLine("EVENT click $script:count") })
$panel.Add_MouseDown({ $panel.Focus() | Out-Null; [Console]::WriteLine("EVENT down") })
$panel.Add_MouseUp({ [Console]::WriteLine("EVENT up") })
$panel.Add_MouseMove({
  if ([Windows.Forms.Control]::MouseButtons -band [Windows.Forms.MouseButtons]::Left) { [Console]::WriteLine("EVENT drag") }
  else { [Console]::WriteLine("EVENT move") }
})
$panel.Add_MouseWheel({ [Console]::WriteLine("EVENT scroll") })
$panel.Add_KeyDown({ [Console]::WriteLine("EVENT key") })
$form.Controls.AddRange([Windows.Forms.Control[]]@($button,$label,$entry,$panel))
$form.Add_Shown({ $form.Activate(); [Console]::WriteLine("READY") })
[Windows.Forms.Application]::Run($form)
