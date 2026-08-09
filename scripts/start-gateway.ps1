[CmdletBinding()]
param(
    [string]$TargetProject,
    [ValidateRange(1, 65535)]
    [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$ApplicationRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($TargetProject)) {
    $TargetProject = Join-Path $ApplicationRoot 'workspace'
}
$ResolvedProject = [System.IO.Path]::GetFullPath($TargetProject)
$RuntimeDir = Join-Path $ApplicationRoot 'runtime'
$LogDir = Join-Path $ApplicationRoot 'logs'
$PidFile = Join-Path $RuntimeDir 'context-os-gateway.pid'
$StdoutLog = Join-Path $LogDir 'context-os-gateway.stdout.log'
$StderrLog = Join-Path $LogDir 'context-os-gateway.stderr.log'
$GatewayEntry = Join-Path $ApplicationRoot 'src\gateway.js'
$Node = Get-Command node -ErrorAction Stop
$Url = "http://127.0.0.1:$Port"

New-Item -ItemType Directory -Force -Path $ResolvedProject, $RuntimeDir, $LogDir | Out-Null

if (Test-Path -LiteralPath $PidFile) {
    $ExistingPid = [int](Get-Content -LiteralPath $PidFile -Raw)
    $Existing = Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue
    if ($Existing) {
        Write-Host "ContextOS Gateway is already running (PID $ExistingPid)." -ForegroundColor Green
        Start-Process $Url
        exit 0
    }
    Remove-Item -LiteralPath $PidFile -Force
}

$Arguments = @(
    ('"' + $GatewayEntry + '"'),
    '--project', ('"' + $ResolvedProject + '"'),
    '--port', [string]$Port
)
$Process = Start-Process -FilePath $Node.Source -ArgumentList $Arguments -WorkingDirectory $ApplicationRoot `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -WindowStyle Hidden -PassThru
Set-Content -LiteralPath $PidFile -Value $Process.Id -Encoding ASCII

$Deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Milliseconds 300
    $Process.Refresh()
    if ($Process.HasExited) {
        Write-Host "ContextOS Gateway exited with code $($Process.ExitCode)." -ForegroundColor Red
        if (Test-Path -LiteralPath $StderrLog) { Get-Content -LiteralPath $StderrLog -Tail 80 }
        exit $Process.ExitCode
    }
    try {
        Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2 | Out-Null
        Write-Host "ContextOS Gateway ready: $Url" -ForegroundColor Green
        Write-Host "Project: $ResolvedProject"
        Write-Host "Log: $StderrLog"
        Start-Process $Url
        exit 0
    } catch {
        # Continue until the local HTTP listener is ready.
    }
}

Write-Host 'Timed out waiting for the ContextOS Gateway.' -ForegroundColor Yellow
if (Test-Path -LiteralPath $StderrLog) { Get-Content -LiteralPath $StderrLog -Tail 80 }
exit 2
