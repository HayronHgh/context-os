[CmdletBinding()]
param(
    [switch]$OpenBrowser
)

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

function Get-SmartAppControlState {
    try {
        $Policy = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' `
            -Name VerifiedAndReputablePolicyState -ErrorAction Stop
        return [int]$Policy.VerifiedAndReputablePolicyState
    } catch {
        return $null
    }
}

function Write-ApplicationControlDiagnostic([string]$Path) {
    $SacState = Get-SmartAppControlState
    $Signature = Get-AuthenticodeSignature -LiteralPath $Path
    $Zone = $null
    try {
        $Zone = Get-Content -LiteralPath $Path -Stream Zone.Identifier -ErrorAction Stop
    } catch {}

    Write-Host ''
    Write-Host 'Windows Application Control blocked llama-server.exe before it could start.' -ForegroundColor Red
    Write-Host "Executable: $Path"
    Write-Host "Signature: $($Signature.Status)"
    if ($null -ne $SacState) {
        $StateLabel = switch ($SacState) { 0 { 'Off' } 1 { 'Enforced' } 2 { 'Evaluation' } default { "Unknown ($SacState)" } }
        Write-Host "Smart App Control: $StateLabel"
    }
    if ($Zone -match 'ZoneId=3') {
        Write-Host 'Download marker: Internet (ZoneId=3)'
    }
    Write-Host ''
    Write-Host 'This is a Windows code-integrity decision, not an MCP or PowerShell execution-policy failure.' -ForegroundColor Yellow
    Write-Host 'Smart App Control has no per-app allow switch. Prefer a CA-signed/reputable build or a WSL/container runtime.'
    Write-Host 'If you intentionally turn Smart App Control off, use Windows Security > App & browser control > Smart App Control, then rerun START.bat.'
    Write-Host 'Do not remove security controls solely by changing this script.'
}

function Get-McpToolNames([string]$Uri) {
    $Response = Invoke-RestMethod -Uri $Uri -TimeoutSec 5
    $Items = @($Response)
    if ($Items.Count -eq 1 -and $null -ne $Items[0].tools) {
        $Items = @($Items[0].tools)
    }
    return @($Items | ForEach-Object {
        if ($_.tool) { $_.tool }
        elseif ($_.definition.function.name) { $_.definition.function.name }
        elseif ($_.function.name) { $_.function.name }
    } | Where-Object { $_ })
}

function Assert-CompleteHostIntegration([string]$BaseUri, [string[]]$ToolNames) {
    $BridgeHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8181/health' -TimeoutSec 3
    if ($BridgeHealth.service -ne 'context-os-host-bridge') { throw 'ContextOS Host Bridge health identity is invalid.' }
    $UiMarker = Invoke-RestMethod -Uri "$BaseUri/contextos-host-bridge.json" -TimeoutSec 3
    if ($UiMarker.integration -ne 'context-os-host-bridge') { throw 'llama.cpp is not serving the ContextOS-integrated Web UI.' }
    if ($RequireMutationTools) {
        foreach ($ExpectedTool in @('context-os_write_file', 'context-os_edit_file')) {
            if ($ToolNames -notcontains $ExpectedTool) { throw "Required trusted-local tool is absent: $ExpectedTool" }
        }
    }
}

function Normalize-ProcessPathEnvironment {
    $PathKeys = @([Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -ieq 'Path' })
    if ($PathKeys.Count -le 1) { return }

    # Windows PowerShell 5.1 Start-Process rejects inherited environments that
    # contain both Path and PATH, even though Windows normally treats them alike.
    $PathValue = [Environment]::GetEnvironmentVariable('Path', 'Process')
    [Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
    [Environment]::SetEnvironmentVariable('Path', $PathValue, 'Process')
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
$McpConfig = Join-Path $ProjectRoot 'config\llama-mcp.json'
$McpCapabilityConfig = Join-Path $ProjectRoot 'config\mcp.json'
$RequireMutationTools = $false
if (Test-Path -LiteralPath $McpCapabilityConfig -PathType Leaf) {
    $McpCapabilities = Get-Content -LiteralPath $McpCapabilityConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $RequireMutationTools = $McpCapabilities.mode -eq 'trusted-local'
}
$HostUi = if ($Config.hostUiPath) { Resolve-ProjectPath $Config.hostUiPath } else { $null }

New-Item -ItemType Directory -Force -Path $RuntimeDir, $LogDir | Out-Null

if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "llama-server not found: $Executable" }
if (-not (Test-Path -LiteralPath $Model -PathType Leaf)) { throw "GGUF model not found: $Model" }
if ($Config.vision -and -not (Test-Path -LiteralPath $Mmproj -PathType Leaf)) { throw "Vision projector not found: $Mmproj" }
if (-not $HostUi -or -not (Test-Path -LiteralPath (Join-Path $HostUi 'index.html') -PathType Leaf)) {
    throw 'ContextOS-integrated host-ui is missing. Build it with scripts\build-host-ui.ps1.'
}
if (-not (Test-Path -LiteralPath (Join-Path $HostUi 'contextos-host-bridge.json') -PathType Leaf)) {
    throw 'host-ui does not contain the ContextOS integration marker.'
}

if (Test-Path -LiteralPath $PidFile) {
    $ExistingPid = [int](Get-Content -LiteralPath $PidFile -Raw)
    $Existing = Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue
    if ($Existing) {
        try {
            $ExistingHealth = Invoke-RestMethod -Uri "http://$($Config.host):$($Config.port)/health" -TimeoutSec 3
            Write-Host "llama-server is already healthy (PID $ExistingPid): $($ExistingHealth | ConvertTo-Json -Compress)" -ForegroundColor Green
            if (Test-Path -LiteralPath $McpConfig -PathType Leaf) {
                $ExistingToolNames = @(Get-McpToolNames "http://$($Config.host):$($Config.port)/tools")
                if ($ExistingToolNames.Count -eq 0) { throw 'ContextOS MCP tools are absent from /tools.' }
                Write-Host "ContextOS MCP tools ($($ExistingToolNames.Count)): $($ExistingToolNames -join ', ')" -ForegroundColor Green
            }
            Assert-CompleteHostIntegration "http://$($Config.host):$($Config.port)" $ExistingToolNames
            Write-Host "Web UI: http://$($Config.host):$($Config.port)"
            if ($OpenBrowser) {
                Normalize-ProcessPathEnvironment
                Start-Process "http://$($Config.host):$($Config.port)"
            }
            exit 0
        } catch {
            Write-Host "Managed PID $ExistingPid exists, but the complete stack is not ready: $($_.Exception.Message)" -ForegroundColor Red
            Write-Host 'Run STOP.bat, then START.bat.' -ForegroundColor Yellow
            exit 3
        }
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
$Arguments += @('--path', (Quote-Argument $HostUi))
if ($Config.vision) {
    $Arguments += @('--mmproj', (Quote-Argument $Mmproj))
}
if (Test-Path -LiteralPath $McpConfig -PathType Leaf) {
    $Arguments += @('--mcp-servers-config', (Quote-Argument $McpConfig))
    Write-Host "MCP: ContextOS capability server ($McpConfig)" -ForegroundColor Cyan
}

Write-Host 'Starting llama-server in the background...' -ForegroundColor Cyan
Normalize-ProcessPathEnvironment
try {
    $Process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WorkingDirectory $LlamaRoot `
        -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -WindowStyle Hidden -PassThru
} catch {
    if ($_.Exception.Message -match 'Application Control policy|code integrity policy') {
        Write-ApplicationControlDiagnostic $Executable
        exit 5
    }
    throw
}
Set-Content -LiteralPath $PidFile -Value $Process.Id -Encoding ASCII
Write-Host "PID: $($Process.Id)"
Write-Host "Log: $StderrLog"

$Deadline = (Get-Date).AddMinutes(4)
while ((Get-Date) -lt $Deadline) {
    Start-Sleep -Seconds 2
    $Process.Refresh()
    if ($Process.HasExited) {
        $Process.WaitForExit()
        try { $ProcessExitCode = [int]$Process.ExitCode } catch { $ProcessExitCode = 1 }
        if ($null -eq $ProcessExitCode) { $ProcessExitCode = 1 }
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        Write-Host "llama-server exited with code $ProcessExitCode." -ForegroundColor Red
        if (Test-Path -LiteralPath $StderrLog) { Get-Content -LiteralPath $StderrLog -Tail 80 }
        exit ([int]$ProcessExitCode)
    }
    try {
        $Health = Invoke-RestMethod -Uri "http://$($Config.host):$($Config.port)/health" -TimeoutSec 3
        Write-Host "Ready: $($Health | ConvertTo-Json -Compress)" -ForegroundColor Green
        if (Test-Path -LiteralPath $McpConfig -PathType Leaf) {
            $ToolDeadline = (Get-Date).AddSeconds(30)
            $ToolNames = @()
            while ((Get-Date) -lt $ToolDeadline -and $ToolNames.Count -eq 0) {
                try {
                    $ToolNames = @(Get-McpToolNames "http://$($Config.host):$($Config.port)/tools")
                } catch {
                    Start-Sleep -Seconds 1
                }
            }
            if ($ToolNames.Count -eq 0) {
                Write-Host 'Model health passed, but ContextOS MCP tools were not exposed by /tools.' -ForegroundColor Red
                Stop-Process -Id $Process.Id -ErrorAction SilentlyContinue
                Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $StderrLog) { Get-Content -LiteralPath $StderrLog -Tail 80 }
                exit 3
            }
            Write-Host "ContextOS MCP tools ($($ToolNames.Count)): $($ToolNames -join ', ')" -ForegroundColor Green
        }
        Assert-CompleteHostIntegration "http://$($Config.host):$($Config.port)" $ToolNames
        Write-Host 'Host Context Bridge: automatic request preparation enabled.' -ForegroundColor Green
        Write-Host 'llama.cpp context shift: enabled as a final fallback.' -ForegroundColor Green
        Write-Host "Web UI: http://$($Config.host):$($Config.port)"
        Write-Host 'The complete llama.cpp + ContextOS MCP stack is ready. 02_start_agent.bat remains optional.'
        if ($OpenBrowser) {
            Start-Process "http://$($Config.host):$($Config.port)"
        }
        exit 0
    } catch {
        Write-Host -NoNewline '.'
    }
}

Write-Host 'Timed out waiting for model load. The process is still running; inspect the log.' -ForegroundColor Yellow
Get-Content -LiteralPath $StderrLog -Tail 80
exit 2
