# 把 installer-art.mjs 生成的 PNG 转成 NSIS 要的 **24 位** BMP（系统编码器 + 显式像素格式）
Add-Type -AssemblyName System.Drawing
$dir = Join-Path (Split-Path -Parent $PSScriptRoot) 'src-tauri'
foreach ($name in @('installer-header', 'installer-sidebar')) {
  $png = Join-Path $dir "$name.png"
  $bmp = Join-Path $dir "$name.bmp"
  if (-not (Test-Path $png)) { Write-Output "缺少 $png"; continue }
  $src = [System.Drawing.Image]::FromFile($png)
  # MUI_HEADERIMAGE 只吃 24bpp：先建一张 24bpp 画布再画进去
  $canvas = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($src, 0, 0, $src.Width, $src.Height)
  $g.Dispose(); $src.Dispose()
  $canvas.Save($bmp, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $canvas.Save((Join-Path $dir "$name.preview.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
  $check = [System.Drawing.Image]::FromFile($bmp)
  Write-Output ("$name.bmp  " + $check.Width + "x" + $check.Height + "  " + $check.PixelFormat)
  $check.Dispose()
}
