# Creates "Hermes Deck" shortcuts (Start menu + Desktop) that launch this checkout of the app.
#   npm run shortcuts            (from the app folder, after npm install)
# Re-running updates the shortcuts; delete them like any other shortcut to uninstall.
#
# Electron 44+ no longer downloads its binary during npm install: it fetches it on first use. On a fresh
# checkout node_modules\electron\dist does not exist yet, so this runs Electron's own installer first.
$ErrorActionPreference = "Stop"
$app = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $app "node_modules\electron"
$exe = Join-Path $electron "dist\electron.exe"
$icon = Join-Path $app "build\icon.ico"
if (-not (Test-Path (Join-Path $electron "install.js"))) { throw "Electron is not installed. Run 'npm install' in $app first." }
if (-not (Test-Path $exe)) {
  Write-Output "Electron binary missing (fresh checkout): downloading it with node_modules\electron\install.js"
  & node (Join-Path $electron "install.js")
  if ($LASTEXITCODE -ne 0) { throw "Electron's installer failed (exit code $LASTEXITCODE). Check the network or proxy, then run 'npm run shortcuts' again." }
  if (-not (Test-Path $exe)) { throw "Electron's installer finished but $exe is still missing." }
}
if (-not (Test-Path $icon)) { & node (Join-Path $PSScriptRoot "make-icon.js") }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Programs")) "Hermes Deck.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "Hermes Deck.lnk")
)
foreach ($t in $targets) {
  $lnk = $shell.CreateShortcut($t)
  $lnk.TargetPath = $exe
  $lnk.Arguments = "`"$app`""
  $lnk.WorkingDirectory = $app
  $lnk.IconLocation = "$icon,0"
  $lnk.Description = "Hermes Deck"
  $lnk.Save()
  Write-Output "shortcut: $t"
}
