$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeckForeground {
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
}
'@
[void][DeckForeground]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$hwnd = [IntPtr]::new([long]$env:HD_WINDOW)
if ([DeckForeground]::IsWindow($hwnd) -and [DeckForeground]::GetForegroundWindow() -ne $hwnd) {
  if ([DeckForeground]::IsIconic($hwnd)) { [void][DeckForeground]::ShowWindow($hwnd, 9) }
  [DeckForeground]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [DeckForeground]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [void][DeckForeground]::SetForegroundWindow($hwnd)
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while ([DeckForeground]::GetForegroundWindow() -ne $hwnd -and $timer.ElapsedMilliseconds -lt 300) {
    Start-Sleep -Milliseconds 10
  }
}
@{ raised = ([DeckForeground]::GetForegroundWindow() -eq $hwnd) } | ConvertTo-Json -Compress
