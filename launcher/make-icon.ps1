# Draws the Mark's Render PDF Editor icon (a document in the colours of the Indian flag with the
# Ashoka Chakra) at several sizes and packs them into launcher\icon.ico. Run: powershell -File make-icon.ps1
Add-Type -AssemblyName System.Drawing
$navy    = [Drawing.Color]::FromArgb(0, 0, 128)

function Draw([int]$s) {
  $bmp = New-Object Drawing.Bitmap $s, $s
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.PixelOffsetMode = 'HighQuality'
  $x0 = [single]($s * 0.12); $x1 = [single]($s * 0.88); $y0 = [single]($s * 0.03); $y1 = [single]($s * 0.97)
  $fold = [single]($s * 0.22)
  # document outline with folded top-right corner
  $doc = New-Object Drawing.Drawing2D.GraphicsPath
  $doc.AddLines([Drawing.PointF[]]@(
    (New-Object Drawing.PointF $x0, $y0), (New-Object Drawing.PointF ($x1 - $fold), $y0),
    (New-Object Drawing.PointF $x1, ($y0 + $fold)), (New-Object Drawing.PointF $x1, $y1),
    (New-Object Drawing.PointF $x0, $y1)))
  $doc.CloseFigure()
  $g.FillPath([Drawing.Brushes]::White, $doc)
  $h = ($y1 - $y0) / 3
  # fold
  $f = New-Object Drawing.Drawing2D.GraphicsPath
  $f.AddLines([Drawing.PointF[]]@((New-Object Drawing.PointF ($x1 - $fold), $y0), (New-Object Drawing.PointF ($x1 - $fold), ($y0 + $fold)), (New-Object Drawing.PointF $x1, ($y0 + $fold))))
  $f.CloseFigure()
  $g.FillPath((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(214, 220, 235))), $f)
  $pw = [single][Math]::Max(1, $s / 48)
  $g.DrawPath((New-Object Drawing.Pen ([Drawing.Color]::FromArgb(40, 50, 90)), $pw), $doc)
  $g.DrawPath((New-Object Drawing.Pen ([Drawing.Color]::FromArgb(40, 50, 90)), $pw), $f)
  # Ashoka Chakra
  $cx = ($x0 + $x1) / 2; $cy = $y0 + 1.25 * $h; $r = $h * 0.62
  $np = New-Object Drawing.Pen $navy, ([single][Math]::Max(1, $s / 40))
  $g.DrawEllipse($np, $cx - $r, $cy - $r, 2 * $r, 2 * $r)
  if ($s -ge 32) {
    $sp = New-Object Drawing.Pen $navy, ([single][Math]::Max(0.6, $s / 140))
    for ($i = 0; $i -lt 24; $i++) {
      $a = $i * [Math]::PI / 12
      $g.DrawLine($sp, $cx, $cy, [single]($cx + [Math]::Cos($a) * $r), [single]($cy + [Math]::Sin($a) * $r))
    }
  }
  $hub = [single][Math]::Max(1, $r * 0.22)
  $g.FillEllipse((New-Object Drawing.SolidBrush $navy), $cx - $hub, $cy - $hub, 2 * $hub, 2 * $hub)
  # "PDF" under the wheel
  if ($s -ge 48) {
    $font = New-Object Drawing.Font 'Segoe UI', ([single]($h * 0.55)), ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
    $g.DrawString('PDF', $font, (New-Object Drawing.SolidBrush $navy), (New-Object Drawing.RectangleF $x0, ($y0 + 2 * $h), ($x1 - $x0), $h), $sf)
  }
  $g.Dispose()
  $ms = New-Object IO.MemoryStream
  $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png)
  if ($s -eq 256) { $bmp.Save((Join-Path $PSScriptRoot 'icon-256.png'), [Drawing.Imaging.ImageFormat]::Png) }
  if ($s -eq 1024) { $bmp.Save((Join-Path $PSScriptRoot 'icon-1024.png'), [Drawing.Imaging.ImageFormat]::Png) } # Mac app icon
  return ,$ms.ToArray()
}

$sizes = 16, 24, 32, 48, 64, 128, 256
Draw 1024 | Out-Null  # large PNG for the Mac app icon (not part of the .ico)
$pngs = $sizes | ForEach-Object { ,(Draw $_) }
$out = New-Object IO.MemoryStream
$w = New-Object IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $w.Write([byte]($s % 256)); $w.Write([byte]($s % 256)); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$d.Length); $w.Write([UInt32]$offset)
  $offset += $d.Length
}
foreach ($d in $pngs) { $w.Write($d) }
[IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'icon.ico'), $out.ToArray())
"icon.ico written"
