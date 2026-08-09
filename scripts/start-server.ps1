[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ConfigPath = Join-Path $ProjectRoot 'config\server.json'
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    throw 'Missing config\server.json. Run 00_setup.bat, then edit the model and llama.cpp paths.'
}
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

function Resolve-ProjectPath([string]$Value) {
    if ([System.IO.Path]::IsPathRooted($Value)) {
        return [System.IO.Path]::GetFullPath($Value)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Value))
}

function Quote-Argument([string]$Value) {
    return '"' + $Value.Replace('"', '\"') + '"'
}

$LlamaRoot = Resolve-ProjectPath $Config.llamaRoot
$Executable = Resolve-ProjectPath $Config.executable
$Model = Resolve-ProjectPath $Config.model
$Mmproj = Resolve-ProjectPath $Config.mmproj
$RuntimeDir = Join-Path $ProjectRoot 'runtime'
$LogDir = Join-Path $ProjectRoot 'logs'
$PidFile = Join-Path $RuntimeDir 'llama-server.pid'
$StdoutLog = Join-Path $LogDir 'llama-server.stdout.log'
$StderrLog = Join-Path $LogDir 'llama-server.stderr.log'

New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir | Out-Null

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "llama-server not found: $Executable" }
if (-not (Test-Path -LiteralPath $Model -PathType Leaf)) { throw "GGUF model not found: $Model" }
if ($Config.vision -and -not (Test-Path -LiteralPath $Mmproj -PathType Leaf)) { throw "Vision projector not found: $Mmproj" }

if (Test-Path -LiteralPath $PidFile) {
    $ExistingPid = [int](Get-Content -LiteralPath $PidFile -Raw)
    $Existing = Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue
    if ($Existing) {
        Write-Host "llama-server is already running (PID $ExistingPid)." -ForegroundColor Green
        Write-Host "Inference endpoint: http://$($Config.host):$($Config.port)"
        Write-Host 'For evidence-aware Browser work, run 03_start_gateway.bat.'
        exit 0
    }
    Remove-Item -LiteralPath $PidFile -Force
}

try {
    $ExistingHealth = Invoke-RestMethod -Uri "http://$($Config.host):$($Config.port)/health" -TimeoutSec 2
    throw "Port $($Config.port) is already serving another process: $($ExistingHealth | ConvertTo-Json -Compress)"
} catch {
    if ($_.Exception.Message -like 'Port * is already serving*') { throw }
}

$Arguments = @(
    '-m', (Quote-Argument $Model),
    '--alias', $Config.alias,
    '-c', [string]$Config.contextSize,
    '-n', [string]$Config.predict,
    '-np', [string]$Config.parallel,
    '-ngl', [string]$Config.gpuLayers,
    '-ctk', [string]$Config.cacheTypeK,
    '-ctv', [string]$Config.cacheTypeV,
    '-fa', [string]$Config.flashAttention,
    '--fit', 'on',
    '--fit-target', [string]$Config.fitTargetMiB,
    '-ctxcp', [string]$Config.ctxCheckpoints,
    '-cms', [string]$Config.checkpointMinStep,
    '-cram', [string]$Config.cacheRamMiB,
    '--jinja',
    '--cache-prompt',
    '--no-context-shift',
    '--reasoning', [string]$Config.reasoning,
    '--reasoning-budget', [string]$Config.reasoningBudget,
    '--metrics',
    '--slots',
    '--cors-origins', 'localhost',
    '--host', [string]$Config.host,
    '--port', [string]$Config.port,
    '--log-timestamps',
    '--log-verbosity', '3'
)
if ($Config.vision) {
    $Arguments += @('--mmproj', (Quote-Argument $Mmproj))
}

Write-Host 'Starting llama-server in the background...' -ForegroundColor Cyan
$Process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $LlamaRoot `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $PidFile -Value $Process.Id -Encoding ASCII
Write-Host "PID: $($Process.Id)"
Write-Host "Log: $StderrLog"

$Deadline = (Get-Date).AddMinutes(4)
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 2
    $Process.Refresh()
    if ($Process.HasExited) {
        Write-Host "llama-server exited with code $($Process.ExitCode)." -ForegroundColor Red
        if (Test-Path -LiteralPath $StderrLog) { Get-Content -LiteralPath $StderrLog -Tail 80 }
        exit $Process.ExitCode
    }
    try {
        $Health = Invoke-RestMethod -Uri "http://$($Config.host):$($Config.port)/health" -TimeoutSec 3
        Write-Host "Ready: $($Health | ConvertTo-Json -Compress)" -ForegroundColor Green
        Write-Host "Inference endpoint: http://$($Config.host):$($Config.port)"
        Write-Host 'Next: run 03_start_gateway.bat (Browser) or 02_start_agent.bat (CLI).'
        exit 0
    } catch {
        Write-Host -NoNewline '.'
    }
}

Write-Host 'Timed out waiting for model load. The process is still running; inspect the log.' -ForegroundColor Yellow
Get-Content -LiteralPath $StderrLog -Tail 80
exit 2
