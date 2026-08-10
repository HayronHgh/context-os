[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PidFile = Join-Path $ProjectRoot 'runtime\host-context-bridge.pid'
$ConfigPath = Join-Path $ProjectRoot 'config\bridge.json'
if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Host 'No managed ContextOS Host Bridge PID file was found.' -ForegroundColor Yellow
    exit 0
}
$RawPidRecord = Get-Content -LiteralPath $PidFile -Raw
try {
    $PidRecord = $RawPidRecord | ConvertFrom-Json
    if ($PidRecord.PSObject.Properties.Name -notcontains 'pid') { throw 'legacy PID record' }
    $BridgePid = [int]$PidRecord.pid
} catch {
    $PidRecord = $null
    $BridgePid = [int]$RawPidRecord
}
$Process = Get-Process -Id $BridgePid -ErrorAction SilentlyContinue
if ($Process) {
    if ($PidRecord -and $PidRecord.executable -and $Process.Path -and
        -not [string]::Equals($Process.Path, [System.IO.Path]::GetFullPath($PidRecord.executable), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to stop PID $BridgePid because its executable identity changed: $($Process.Path)"
    }
    if ($PidRecord -and $PidRecord.startedAtUtc) {
        $RecordedStart = [DateTime]::Parse($PidRecord.startedAtUtc).ToUniversalTime()
        if ([Math]::Abs(($Process.StartTime.ToUniversalTime() - $RecordedStart).TotalSeconds) -gt 1) {
            throw "Refusing to stop PID $BridgePid because its start-time identity changed."
        }
    }
    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
        $Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $Health = Invoke-RestMethod -Uri "http://$($Config.host):$($Config.port)/health" -TimeoutSec 3
        if ($Health.service -ne 'context-os-host-bridge') {
            throw "Refusing to stop PID $BridgePid because the managed health identity is absent."
        }
    }
    Stop-Process -Id $BridgePid
    $Process.WaitForExit(10000) | Out-Null
    Write-Host "Stopped ContextOS Host Bridge PID $BridgePid." -ForegroundColor Green
} else {
    Write-Host "ContextOS Host Bridge PID $BridgePid was no longer running." -ForegroundColor Yellow
}
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
