[CmdletBinding()]
param()

$ApplicationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PidFile = Join-Path $ApplicationRoot 'runtime\context-os-gateway.pid'

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Host 'No managed ContextOS Gateway PID file was found.' -ForegroundColor Yellow
    exit 0
}

$GatewayPid = [int](Get-Content -LiteralPath $PidFile -Raw)
$Process = Get-Process -Id $GatewayPid -ErrorAction SilentlyContinue
if ($Process) {
    Stop-Process -Id $GatewayPid
    Write-Host "Stopped ContextOS Gateway (PID $GatewayPid)." -ForegroundColor Green
} else {
    Write-Host "ContextOS Gateway PID $GatewayPid was not running." -ForegroundColor Yellow
}
Remove-Item -LiteralPath $PidFile -Force
