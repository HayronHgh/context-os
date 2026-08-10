[CmdletBinding()]
param(
    [string]$TargetProject
)

$ErrorActionPreference = 'Stop'
$ApplicationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($TargetProject)) {
    $TargetProject = Join-Path $ApplicationRoot 'workspace'
}
$ResolvedProject = [System.IO.Path]::GetFullPath($TargetProject)
$ServerConfigPath = Join-Path $ApplicationRoot 'config\server.json'
$PowerShell = (Get-Command powershell.exe -ErrorAction Stop).Source

if (-not (Test-Path -LiteralPath $ServerConfigPath -PathType Leaf)) {
    throw 'Missing config\server.json. Run 00_setup.bat before START_ALL.bat.'
}

function Invoke-ManagedScript {
    param(
        [Parameter(Mandatory)]
        [string]$Label,
        [Parameter(Mandatory)]
        [string]$Path,
        [string[]]$Arguments = @()
    )

    Write-Host "`n==> $Label" -ForegroundColor Cyan
    & $PowerShell -NoProfile -ExecutionPolicy Bypass -File $Path @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

try {
    Invoke-ManagedScript -Label '1/4 Start llama-server' `
        -Path (Join-Path $PSScriptRoot 'start-server.ps1')

    Write-Host "`n==> 2/4 Agent Runtime" -ForegroundColor Cyan
    Write-Host 'The Gateway owns one AgentRuntime per browser session; no duplicate CLI agent is started.'

    Invoke-ManagedScript -Label '3/4 Start Runtime Chat Gateway' `
        -Path (Join-Path $PSScriptRoot 'start-gateway.ps1') `
        -Arguments @('-TargetProject', $ResolvedProject)

    Write-Host "`n==> 4/4 Verify health" -ForegroundColor Cyan
    $ServerConfig = Get-Content -LiteralPath $ServerConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ServerUrl = "http://$($ServerConfig.host):$($ServerConfig.port)"
    $ServerHealth = Invoke-RestMethod -Uri "$ServerUrl/health" -TimeoutSec 5
    $GatewayHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 5

    Write-Host "llama-server: READY - $ServerUrl" -ForegroundColor Green
    Write-Host 'Gateway: READY - http://127.0.0.1:8787' -ForegroundColor Green
    Write-Host 'AgentRuntime: READY on session creation' -ForegroundColor Green
    Write-Host "Project: $ResolvedProject"
    Write-Host "Model health: $($ServerHealth | ConvertTo-Json -Compress)"
    Write-Host "Gateway health: $($GatewayHealth | ConvertTo-Json -Compress)"
    Write-Host "`nContextOS startup completed successfully." -ForegroundColor Green
    exit 0
} catch {
    Write-Host "`nContextOS startup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Run STOP_ALL.bat to clean up any component that started before the failure.' -ForegroundColor Yellow
    exit 1
}
