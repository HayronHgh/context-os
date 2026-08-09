[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Pairs = @(
    @{ Example = 'config\agent.example.json'; Local = 'config\agent.json' },
    @{ Example = 'config\server.example.json'; Local = 'config\server.json' }
)

foreach ($Pair in $Pairs) {
    $Example = Join-Path $ProjectRoot $Pair.Example
    $Local = Join-Path $ProjectRoot $Pair.Local
    if (Test-Path -LiteralPath $Local) {
        Write-Host "Keeping existing $($Pair.Local)" -ForegroundColor Yellow
    } else {
        Copy-Item -LiteralPath $Example -Destination $Local
        Write-Host "Created $($Pair.Local)" -ForegroundColor Green
    }
}

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '1. Edit config\server.json with your llama-server and GGUF paths.'
Write-Host '2. Keep config\agent.json model equal to config\server.json alias.'
Write-Host '3. Run 04_health_check.bat, then 01_start_server.bat.'
