[CmdletBinding()]
param()

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ConfigPath = Join-Path $ProjectRoot 'config\server.json'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Host 'Missing config\server.json. Run 00_setup.bat first.' -ForegroundColor Red
    exit 2
}
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Resolve-ProjectPath([string]$Value) {
    if ([System.IO.Path]::IsPathRooted($Value)) { return [System.IO.Path]::GetFullPath($Value) }
    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

$Executable = Resolve-ProjectPath $Config.executable
$Model = Resolve-ProjectPath $Config.model
$Node = Get-Command node -ErrorAction SilentlyContinue
$NvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
$McpConfigPath = Join-Path $ProjectRoot 'config\llama-mcp.json'

Write-Host 'Qwen Context OS doctor' -ForegroundColor Cyan
Write-Host "Project: $ProjectRoot"
Write-Host "Node: $(if ($Node) { & node --version } else { 'NOT FOUND' })"
Write-Host "llama-server: $(if (Test-Path -LiteralPath $Executable) { 'OK' } else { 'MISSING' }) - $Executable"
if (Test-Path -LiteralPath $Model) {
    $Size = [math]::Round((Get-Item -LiteralPath $Model).Length / 1GB, 2)
    Write-Host "Model: OK ($Size GiB) - $Model"
} else {
    Write-Host "Model: MISSING - $Model" -ForegroundColor Red
}

if ($NvidiaSmi) {
    Write-Host "GPU: $(& nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader)"
} else {
    Write-Host 'GPU: nvidia-smi not found' -ForegroundColor Yellow
}

try {
    $Health = Invoke-RestMethod -Uri "http://$($Config.host):$($Config.port)/health" -TimeoutSec 3
    Write-Host "API health: $($Health | ConvertTo-Json -Compress)" -ForegroundColor Green
    $Models = Invoke-RestMethod -Uri "http://$($Config.host):$($Config.port)/v1/models" -TimeoutSec 3
    Write-Host "API model: $($Models.data.id -join ', ')"
} catch {
    Write-Host "API health: OFFLINE ($($_.Exception.Message))" -ForegroundColor Yellow
}

Write-Host "Server config: ctx=$($Config.contextSize), output=$($Config.predict), reasoning-budget=$($Config.reasoningBudget), slots=$($Config.parallel), KV=$($Config.cacheTypeK)/$($Config.cacheTypeV), vision=$($Config.vision)"
Write-Host "MCP config: $(if (Test-Path -LiteralPath $McpConfigPath) { 'OK' } else { 'MISSING - run 00_setup.bat' }) - $McpConfigPath"
if (Test-Path -LiteralPath $McpConfigPath) {
    try {
        $Tools = Invoke-RestMethod -Uri "http://$($Config.host):$($Config.port)/tools" -TimeoutSec 3
        $Names = @($Tools | ForEach-Object { $_.function.name })
        Write-Host "MCP tools: $($Names -join ', ')" -ForegroundColor Green
    } catch {
        Write-Host "MCP tools: unavailable ($($_.Exception.Message))" -ForegroundColor Yellow
    }
}
