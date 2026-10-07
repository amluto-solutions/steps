# One automated parity run: fresh fixture window, recorder, driver, report.
# Moves the real mouse for about 40 seconds. Usage:
#   pwsh tools/parity/run.ps1 [-Page fixture|forms|overlays] [-Source hook|raw] [-Mode window|monitor]
#                             [-Name run1] [-Release] [-Monitor 0|1|2] (0: the main screen) [-PlaceSize 1500,1000]
#                             [-ProtoExe path] [-OutRoot folder]   (used by tools/msix/smoke.ps1)
param(
  [ValidateSet("fixture", "forms", "overlays")] [string] $Page = "fixture",
  [ValidateSet("hook", "raw")] [string] $Source = "hook",
  [ValidateSet("window", "monitor")] [string] $Mode = "window",
  [string] $Name = "run-$Page-$Source-$Mode",
  [int] $DelayMs = 700,
  [switch] $Release,
  [int] $Monitor = 1,
  [string] $WindowSize = "1100,760",
  [string] $PlaceSize = "",   # physical pixels, applied after the move (for a scaled monitor)
  [string] $ProtoExe = "",
  [string] $OutRoot = (Join-Path $env:TEMP "amluto-proto")
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\..\.."
$profile = if ($Release) { "release" } else { "debug" }
$bin = "$repo\apps\desktop\src-tauri\target\$profile"
$out = Join-Path $OutRoot $Name
$protoPath = if ($ProtoExe) { $ProtoExe } else { "$bin\proto.exe" }
$title = switch ($Page) {
  "forms" { "Amluto Steps sensitive forms fixture" }
  "overlays" { "Amluto Steps overlay fixture" }
  default { "Amluto Steps parity fixture" }
}
if (Test-Path $out) { Remove-Item -Recurse -Force $out -Confirm:$false }
New-Item -ItemType Directory -Force $out | Out-Null

# Open the fixture on the chosen monitor (for the mixed-scaling test).
Add-Type -AssemblyName System.Windows.Forms
# -Monitor 0 is the main screen, wherever it is in the list.
$screen = if ($Monitor -eq 0) { [System.Windows.Forms.Screen]::PrimaryScreen } else { [System.Windows.Forms.Screen]::AllScreens[[Math]::Max(0, $Monitor - 1)] }
$left = $screen.Bounds.X + 40
$top = $screen.Bounds.Y + 40

& "$bin\drive.exe" close --title $title | Out-Null
$fixture = [Uri]::new("$repo\tools\parity\$Page.html").AbsoluteUri
Start-Process msedge -ArgumentList "--new-window", "--app=$fixture", "--window-position=$left,$top", "--window-size=$WindowSize"
Start-Sleep -Seconds 4
# Edge reopens app windows where they last were, so move it explicitly.
$place = @("place", "--title", $title, "--x", $left, "--y", $top)
if ($PlaceSize) { $w, $h = $PlaceSize -split ","; $place += @("--w", $w, "--h", $h) }
& "$bin\drive.exe" @place
if ($LASTEXITCODE -ne 0) { throw "could not place the fixture window" }

$proto = Start-Process -FilePath $protoPath -PassThru -WindowStyle Hidden `
  -ArgumentList "--source", $Source, "--mode", $Mode, "--values", "on", "--seconds", "180", "--out", "`"$out`"" `
  -RedirectStandardOutput "$out\proto-stdout.txt" -RedirectStandardError "$out\proto-stderr.txt"
Start-Sleep -Seconds 2

& "$bin\drive.exe" fixture --title $title --out $out --delay-ms $DelayMs 2>&1 | Tee-Object -FilePath "$out\drive.txt"
$driveExit = $LASTEXITCODE
Start-Sleep -Milliseconds 800
New-Item -ItemType File "$out\STOP" | Out-Null
$proto.WaitForExit(30000) | Out-Null
& "$bin\drive.exe" close --title $title | Out-Null

node "$repo\tools\parity\report.mjs" $out
"driver exit: $driveExit · output: $out"
