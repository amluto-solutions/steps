# Desktop-app capture test (Phase 1): Calculator, Excel (a throwaway CSV) and File Explorer
# (a temp folder of dummy files). Only harmless clicks; each window is closed afterwards.
# Moves the real mouse for about a minute.
#   pwsh tools/parity/desktop.ps1 [-Source hook|raw] [-Release]
param(
  [ValidateSet("hook", "raw")] [string] $Source = "raw",
  [switch] $Release
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\..\.."
$profile = if ($Release) { "release" } else { "debug" }
$bin = "$repo\apps\desktop\src-tauri\target\$profile"
$out = Join-Path $env:TEMP "amluto-proto\desktop-$Source"
if (Test-Path $out) { Remove-Item -Recurse -Force $out -Confirm:$false }
New-Item -ItemType Directory -Force $out | Out-Null

# Throwaway files, so no real documents appear in screenshots.
$files = Join-Path $env:TEMP "amluto-proto-files"
if (Test-Path $files) { Remove-Item -Recurse -Force $files -Confirm:$false }
New-Item -ItemType Directory -Force $files | Out-Null
"Q3 report" | Set-Content "$files\Q3 report.txt"
"Supplier list" | Set-Content "$files\Supplier list.txt"
"Onboarding checklist" | Set-Content "$files\Onboarding checklist.txt"
"Item,Qty`nWidgets,4`nGadgets,7" | Set-Content "$files\stock-sample.csv"

$proto = Start-Process -FilePath "$bin\proto.exe" -PassThru -WindowStyle Hidden `
  -ArgumentList "--source", $Source, "--mode", "window", "--seconds", "300", "--out", "`"$out`"" `
  -RedirectStandardOutput "$out\proto-stdout.txt" -RedirectStandardError "$out\proto-stderr.txt"
Start-Sleep -Seconds 2

function Drive-App([string] $Title, [string] $Names) {
  & "$bin\drive.exe" app --title $Title --names $Names 2>&1 | Tee-Object -Append -FilePath "$out\drive.txt"
  Start-Sleep -Milliseconds 500
  & "$bin\drive.exe" close --title $Title | Out-Null
}

Start-Process calc.exe
Drive-App "Calculator" "One|Plus|Two|Equals|Three|Multiply by|Four|Equals"

Start-Process "C:\Program Files\Microsoft Office\root\Office16\EXCEL.EXE" -ArgumentList "`"$files\stock-sample.csv`""
Drive-App "stock-sample" "Home|Insert|Formulas|Data|View"

# File names appear with or without extensions depending on the user's Explorer setting (read only).
$hideExt = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -ErrorAction SilentlyContinue).HideFileExt
$ext = if ($hideExt -eq 0) { ".txt" } else { "" }
Start-Process explorer.exe -ArgumentList "`"$files`""
Drive-App "amluto-proto-files" "Q3 report$ext|Supplier list$ext|Onboarding checklist$ext"

Start-Sleep -Milliseconds 800
New-Item -ItemType File "$out\STOP" | Out-Null
$proto.WaitForExit(30000) | Out-Null
node "$repo\tools\parity\report.mjs" $out
"output: $out"
