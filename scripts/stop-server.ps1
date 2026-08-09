[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PidFile = Join-Path $ProjectRoot 'runtime\llama-server.pid'

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Host 'No managed llama-server PID file was found.' -ForegroundColor Yellow
    exit 0
}

$ServerPid = [int](Get-Content -LiteralPath $PidFile -Raw)
$Process = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
if ($Process) {
    Stop-Process -Id $ServerPid
    $Process.WaitForExit(10000) | Out-Null
    Write-Host "Stopped llama-server PID $ServerPid." -ForegroundColor Green
} else {
    Write-Host "PID $ServerPid was no longer running." -ForegroundColor Yellow
}
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
