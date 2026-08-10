[CmdletBinding()]
param()

$ApplicationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source
$Failures = [System.Collections.Generic.List[string]]::new()

function Stop-ManagedComponent {
    param(
        [Parameter(Mandatory)]
        [string]$Label,
        [Parameter(Mandatory)]
        [string]$Path
    )

    Write-Host "`n==> $Label" -ForegroundColor Cyan
    & $PowerShell -NoProfile -ExecutionPolicy Bypass -File $Path
    if ($LASTEXITCODE -ne 0) {
        $Failures.Add("$Label exited with code $LASTEXITCODE")
    }
}

Stop-ManagedComponent -Label '1/2 Stop Gateway and its AgentRuntime sessions' `
    -Path (Join-Path $PSScriptRoot 'stop-gateway.ps1')
Stop-ManagedComponent -Label '2/2 Stop llama-server' `
    -Path (Join-Path $PSScriptRoot 'stop-server.ps1')

if ($Failures.Count -gt 0) {
    Write-Host "`nContextOS shutdown completed with errors:" -ForegroundColor Red
    $Failures | ForEach-Object { Write-Host "- $_" -ForegroundColor Red }
    exit 1
}

Write-Host "`nGateway, AgentRuntime sessions, and llama-server are stopped." -ForegroundColor Green
Write-Host "Logs and Runtime state remain available under $ApplicationRoot."
exit 0
