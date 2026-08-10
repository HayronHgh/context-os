[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ConfigPath = Join-Path $ProjectRoot 'config\bridge.json'
$RuntimeDir = Join-Path $ProjectRoot 'runtime'
$LogDir = Join-Path $ProjectRoot 'logs'
$PidFile = Join-Path $RuntimeDir 'host-context-bridge.pid'
$StdoutLog = Join-Path $LogDir 'host-context-bridge.stdout.log'
$StderrLog = Join-Path $LogDir 'host-context-bridge.stderr.log'
$ServerScript = Join-Path $ProjectRoot 'src\host-context-bridge-server.js'
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Missing config\bridge.json. Run 00_setup.bat.' }
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$HealthUri = "http://$($Config.host):$($Config.port)/health"

function Normalize-ProcessPathEnvironment {
    $PathKeys = @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ieq 'Path' })
    if ($PathKeys.Count -le 1) { return }
    $PathValue = [Environment]::GetEnvironmentVariable('Path', 'Process')
    [Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
    [Environment]::SetEnvironmentVariable('Path', $PathValue, 'Process')
}

New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir | Out-Null
if (Test-Path -LiteralPath $PidFile) {
    $RawPidRecord = Get-Content -LiteralPath $PidFile -Raw
    try {
        $ParsedPidRecord = $RawPidRecord | ConvertFrom-Json
        if ($ParsedPidRecord.PSObject.Properties.Name -notcontains 'pid') { throw 'legacy PID record' }
        $ExistingPid = [int]$ParsedPidRecord.pid
    } catch { $ExistingPid = [int]$RawPidRecord }
    $Existing = Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue
    if ($Existing) {
        $Health = Invoke-RestMethod -Uri $HealthUri -TimeoutSec 3
        if ($Health.service -ne 'context-os-host-bridge') { throw "PID $ExistingPid is not a healthy ContextOS Host Bridge." }
        Write-Host "ContextOS Host Bridge is already healthy (PID $ExistingPid)." -ForegroundColor Green
        exit 0
    }
    Remove-Item -LiteralPath $PidFile -Force
}

try {
    $Unexpected = Invoke-RestMethod -Uri $HealthUri -TimeoutSec 2
    throw "Bridge port is already serving an unmanaged process: $($Unexpected | ConvertTo-Json -Compress)"
} catch {
    if ($_.Exception.Message -like 'Bridge port is already*') { throw }
}

$Node = (Get-Command node -ErrorAction Stop).Source
Normalize-ProcessPathEnvironment
$Arguments = @(
    '"' + $ServerScript + '"',
    '--config',
    '"' + $ConfigPath + '"'
)
$Process = Start-Process -FilePath $Node -ArgumentList $Arguments -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -WindowStyle Hidden -PassThru
$PidRecord = [ordered]@{
    pid = $Process.Id
    executable = [System.IO.Path]::GetFullPath($Node)
    startedAtUtc = $Process.StartTime.ToUniversalTime().ToString('O')
}
Set-Content -LiteralPath $PidFile -Value ($PidRecord | ConvertTo-Json -Compress) -Encoding ASCII

$Deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Milliseconds 500
    $Process.Refresh()
    if ($Process.HasExited) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $StderrLog) { Get-Content -LiteralPath $StderrLog -Tail 50 }
        throw "ContextOS Host Bridge exited during startup with code $($Process.ExitCode)."
    }
    try {
        $Health = Invoke-RestMethod -Uri $HealthUri -TimeoutSec 2
        if ($Health.service -eq 'context-os-host-bridge') {
            Write-Host "ContextOS Host Bridge ready (PID $($Process.Id)): $HealthUri" -ForegroundColor Green
            exit 0
        }
    } catch {}
}
Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
throw 'Timed out waiting for ContextOS Host Bridge.'
