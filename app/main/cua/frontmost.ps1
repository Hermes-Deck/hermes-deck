$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DeckFrontmost {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, uint attribute, out Rect rect, int size);
}
'@
[void][DeckFrontmost]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$hwnd = if ($env:HD_WINDOW) { [IntPtr]::new([long]$env:HD_WINDOW) } else { [DeckFrontmost]::GetForegroundWindow() }
if (-not [DeckFrontmost]::IsWindow($hwnd) -or -not [DeckFrontmost]::IsWindowVisible($hwnd) -or [DeckFrontmost]::IsIconic($hwnd)) { throw 'No visible target window' }
[uint32]$ownerPid = 0
[void][DeckFrontmost]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
$process = Get-Process -Id $ownerPid
$executable = [DeckProcessPath]::ImagePath($ownerPid)
if (-not $executable) { throw 'Process identity unavailable' }
if ($env:HD_OWN_PIDS -split ',' -contains [string]$ownerPid -or $executable -eq $env:HD_OWN_EXE) { throw 'Own window blocked' }
# Same executable denylist as windows.js; repeat before native capture so blocked pixels never leave the helper.
if ([IO.Path]::GetFileNameWithoutExtension($executable) -match '^(1password|bitwarden|keepass(xc)?|lastpass|dashlane|keeper|enpass|nordpass|proton ?pass|roboform)$') { throw 'Password manager blocked' }
if ($env:HD_WINDOW_PID -and ($ownerPid -ne [uint32]$env:HD_WINDOW_PID -or $executable -ne $env:HD_WINDOW_EXE)) { throw 'Window identity changed' }
$title = [Text.StringBuilder]::new(301)
[void][DeckFrontmost]::GetWindowText($hwnd, $title, $title.Capacity)
$result = @{ window_id=$hwnd.ToInt64(); pid=$ownerPid; app_name=$process.ProcessName; title=$title.ToString(); executable=$executable }
$windowRect = [DeckFrontmost+Rect]::new()
if (-not [DeckFrontmost]::GetWindowRect($hwnd, [ref]$windowRect)) { throw 'Window bounds unavailable' }
$result.bounds = @{ x=$windowRect.Left; y=$windowRect.Top; width=$windowRect.Right-$windowRect.Left; height=$windowRect.Bottom-$windowRect.Top }
$extended = [DeckFrontmost+Rect]::new()
if ([DeckFrontmost]::DwmGetWindowAttribute($hwnd, 9, [ref]$extended, 16) -eq 0) {
  $result.extendedBounds = @{ x=$extended.Left; y=$extended.Top; width=$extended.Right-$extended.Left; height=$extended.Bottom-$extended.Top }
}
if ($env:HD_CAPTURE -eq '1') {
  Add-Type -AssemblyName System.Drawing
  $rect = [DeckFrontmost+Rect]::new()
  if (-not [DeckFrontmost]::GetWindowRect($hwnd, [ref]$rect)) { throw 'Window bounds unavailable' }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0 -or $width -gt 8192 -or $height -gt 8192 -or [long]$width*$height -gt 32000000) { throw 'Window dimensions unsupported' }
  $bitmap = [Drawing.Bitmap]::new($width, $height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try {
    $dc = $graphics.GetHdc()
    try { $captured = [DeckFrontmost]::PrintWindow($hwnd, $dc, 2) } finally { $graphics.ReleaseHdc($dc) }
    if (-not $captured) { throw 'Window capture unavailable' }
    $scale = [Math]::Min(1, 1920/[Math]::Max($width,$height))
    $small = [Drawing.Bitmap]::new($bitmap, [int][Math]::Max(1,$width*$scale), [int][Math]::Max(1,$height*$scale))
    $stream = [IO.MemoryStream]::new()
    try {
      $small.Save($stream, [Drawing.Imaging.ImageFormat]::Jpeg)
      if ($stream.Length -gt 1000000) { throw 'Window image too large' }
      $result.image = [Convert]::ToBase64String($stream.ToArray())
    } finally { $stream.Dispose(); $small.Dispose() }
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
  # Read only names inside this HWND. No ValuePattern/TextPattern, password subtrees or off-screen controls.
  $names = [Collections.Generic.List[string]]::new()
  try {
    Add-Type -AssemblyName UIAutomationClient
    $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue($root)
    $visited = 0
    while ($queue.Count -gt 0 -and $visited -lt 200 -and ($names -join "`n").Length -lt 16000) {
      $element = $queue.Dequeue()
      $visited++
      $current = $element.Current
      if ($current.IsPassword -or $current.IsOffscreen) { continue }
      if ($current.Name -and -not $names.Contains($current.Name)) { $names.Add($current.Name) }
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child -and $queue.Count -lt 200) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
    }
  } catch { # inaccessible controls still allow the screenshot
  }
  $result.text = ($names -join "`n").Substring(0, [Math]::Min(16000, ($names -join "`n").Length))
}
# Check the HWND again: a destroyed/reused window must never be attached under the old identity.
[uint32]$afterPid = 0
[void][DeckFrontmost]::GetWindowThreadProcessId($hwnd, [ref]$afterPid)
if (-not [DeckFrontmost]::IsWindow($hwnd) -or $afterPid -ne $ownerPid) { throw 'Window closed' }
$result | ConvertTo-Json -Compress
