# Queue-pressure tests (Phase 1): a burst of clicks, with and without a stalled worker.
# Clicks the fixture's harmless "Finish" button. Moves the real mouse for about 30 seconds.
#   pwsh tools/parity/stress.ps1 [-Source hook|raw] [-Release]
param(
  [ValidateSet("hook", "raw")] [string] $Source = "raw",
  [switch] $Release
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path "$PSScriptRoot\..\.."
$profile = if ($Release) { "release" } else { "debug" }
$bin = "$repo\apps\desktop\src-tauri\target\$profile"

function Invoke-Burst([string] $Name, [string[]] $ProtoArgs, [int] $Count, [int] $IntervalMs) {
  $out = Join-Path $env:TEMP "amluto-proto\$Name"
  if (Test-Path $out) { Remove-Item -Recurse -Force $out -Confirm:$false }
  New-Item -ItemType Directory -Force $out | Out-Null

  & "$bin\drive.exe" close | Out-Null
  $fixture = [Uri]::new("$repo\tools\parity\fixture.html").AbsoluteUri
  Start-Process msedge -ArgumentList "--new-window", "--app=$fixture"
  Start-Sleep -Seconds 4

  $proto = Start-Process -FilePath "$bin\proto.exe" -PassThru -WindowStyle Hidden `
    -ArgumentList (@("--source", $Source, "--seconds", "120", "--out", "`"$out`"") + $ProtoArgs) `
    -RedirectStandardOutput "$out\proto-stdout.txt" -RedirectStandardError "$out\proto-stderr.txt"
  Start-Sleep -Seconds 2
  & "$bin\drive.exe" burst --count $Count --interval-ms $IntervalMs 2>&1 | Tee-Object -FilePath "$out\drive.txt"
  Start-Sleep -Seconds 2
  New-Item -ItemType File "$out\STOP" | Out-Null
  $proto.WaitForExit(60000) | Out-Null
  & "$bin\drive.exe" close | Out-Null

  $s = (Get-Content "$out\session.json" -Raw | ConvertFrom-Json).summary
  $accounted = $s.clicks + $s.doubles + $s.missed
  $verdict = if ($accounted -eq $Count) { "PASS" } else { "FAIL" }
  "{0}  {1}: sent {2} · clicks {3} + doubles {4} + missed {5} = {6} · degraded {7} · queue p95 {8} ms" -f `
    $verdict, $Name, $Count, $s.clicks, $s.doubles, $s.missed, $accounted, $s.degraded, $s.queueDelayMs.p95
}

Invoke-Burst -Name "stress-burst" -ProtoArgs @() -Count 50 -IntervalMs 20
Invoke-Burst -Name "stress-stalled" -ProtoArgs @("--queue", "16", "--stall-ms", "150") -Count 50 -IntervalMs 20
