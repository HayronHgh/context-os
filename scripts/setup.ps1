[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Pairs = @(
    @{ Example = 'config\agent.example.json'; Local = 'config\agent.json' },
    @{ Example = 'config\server.example.json'; Local = 'config\server.json' },
    @{ Example = 'config\mcp.example.json'; Local = 'config\mcp.json' },
    @{ Example = 'config\bridge.example.json'; Local = 'config\bridge.json' }
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

$Npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $Npm) { throw 'npm was not found. Install Node.js 20 or newer.' }
Write-Host 'Installing locked MCP runtime dependencies...' -ForegroundColor Cyan
Push-Location $ProjectRoot
try {
    & $Npm.Source ci --omit=dev
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$LlamaMcpConfig = Join-Path $ProjectRoot 'config\llama-mcp.json'
if (Test-Path -LiteralPath $LlamaMcpConfig) {
    Write-Host 'Keeping existing config\llama-mcp.json' -ForegroundColor Yellow
} else {
    $Node = (Get-Command node -ErrorAction Stop).Source
    $Definition = [ordered]@{
        mcpServers = [ordered]@{
            'context-os' = [ordered]@{
                command = $Node
                args = @(
                    (Join-Path $ProjectRoot 'src\mcp-server.js'),
                    '--config',
                    (Join-Path $ProjectRoot 'config\mcp.json')
                )
                cwd = $ProjectRoot
                # Must exceed security.commandTimeoutSeconds (120s by default),
                # otherwise llama.cpp abandons a valid long-running MCP call first.
                timeout_ms = 150000
            }
        }
    }
    $Json = $Definition | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($LlamaMcpConfig, $Json + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Created config\llama-mcp.json for llama.cpp b10295+' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '1. Edit config\server.json with your llama-server and GGUF paths.'
Write-Host '2. Edit config\mcp.json projectRoot; keep mode read-only unless trusted-local mutation is intentional.'
Write-Host '3. Build host-ui once with scripts\build-host-ui.ps1 against llama.cpp b10295 tools\ui.'
Write-Host '4. Run START.bat. 02_start_agent.bat remains optional.'
