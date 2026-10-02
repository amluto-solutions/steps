# Phase 1 MSIX smoke test: runs the parity test with the prototype inside an MSIX package.
# Needs Windows Developer Mode (loose-layout registration, no signing). Moves the real mouse.
# Registers the package, runs the test, then removes the package again.
#   pwsh tools/msix/smoke.ps1
$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\..\.."
$release = "$repo\apps\desktop\src-tauri\target\release"
$icons = "$repo\apps\desktop\src-tauri\icons"
$layout = Join-Path $env:TEMP "amluto-msix-layout"
$packageName = "AmlutoSolutions.AmlutoStepsCaptureProto"

# 1. Layout
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout -Confirm:$false }
New-Item -ItemType Directory -Force $layout | Out-Null
Copy-Item "$release\proto.exe" $layout
Copy-Item "$icons\Square150x150Logo.png", "$icons\Square44x44Logo.png", "$icons\StoreLogo.png" $layout
Copy-Item "$PSScriptRoot\AppxManifest.xml" $layout

# 2. Validate by packing (unsigned; this package is never installed)
$makeappx = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\makeappx.exe" | Select-Object -Last 1
& $makeappx.FullName pack /d $layout /p (Join-Path $env:TEMP "amluto-capture-proto.msix") /o | Select-Object -Last 1

# 3. Register the loose layout (Developer Mode)
Get-AppxPackage -Name $packageName | Remove-AppxPackage
Add-AppxPackage -Register "$layout\AppxManifest.xml"
$alias = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps\amluto-capture-proto.exe"
"registered: $((Get-AppxPackage -Name $packageName).PackageFullName)"

try {
  # Packaged apps have AppData writes redirected, and %TEMP% is under AppData, so write results
  # somewhere that isn't virtualised.
  $outRoot = Join-Path $env:USERPROFILE "AmlutoProtoMsix"
  & "$repo\tools\parity\run.ps1" -Source raw -Mode window -Name "msix-smoke" -Release `
    -ProtoExe $alias -OutRoot $outRoot 2>&1 | Select-Object -Last 8
  $session = Get-Content (Join-Path $outRoot "msix-smoke\session.json") -Raw | ConvertFrom-Json
  "ran inside package: $($session.packageFullName)"
}
finally {
  Get-AppxPackage -Name $packageName | Remove-AppxPackage
  "package removed"
}
