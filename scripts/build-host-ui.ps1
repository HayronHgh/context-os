[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LlamaUiSource,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$UiSource = [System.IO.Path]::GetFullPath($LlamaUiSource)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $ProjectRoot 'host-ui' }
$Output = [System.IO.Path]::GetFullPath($OutputDirectory)
$Node = (Get-Command node -ErrorAction Stop).Source
$Npm = (Get-Command npm.cmd -ErrorAction Stop).Source

Write-Host 'Applying the bounded ContextOS overlay to llama.cpp b10295 Web UI...' -ForegroundColor Cyan
& $Node (Join-Path $PSScriptRoot 'patch-llama-ui.mjs') $UiSource
if ($LASTEXITCODE -ne 0) { throw "UI overlay failed with exit code $LASTEXITCODE" }

Push-Location $UiSource
$PreviousOutput = [Environment]::GetEnvironmentVariable('LLAMA_UI_OUT_DIR', 'Process')
try {
    Write-Host 'Installing the exact locked llama.cpp UI dependencies...' -ForegroundColor Cyan
    & $Npm ci
    if ($LASTEXITCODE -ne 0) { throw "llama.cpp UI npm ci failed with exit code $LASTEXITCODE" }
    [Environment]::SetEnvironmentVariable('LLAMA_UI_OUT_DIR', $Output, 'Process')
    Write-Host "Building host-integrated Web UI: $Output" -ForegroundColor Cyan
    & $Npm run build
    if ($LASTEXITCODE -ne 0) { throw "llama.cpp UI build failed with exit code $LASTEXITCODE" }
} finally {
    [Environment]::SetEnvironmentVariable('LLAMA_UI_OUT_DIR', $PreviousOutput, 'Process')
    Pop-Location
}

if (-not (Test-Path -LiteralPath (Join-Path $Output 'index.html') -PathType Leaf)) {
    throw 'Host UI build did not produce index.html.'
}
if (-not (Test-Path -LiteralPath (Join-Path $Output 'contextos-host-bridge.json') -PathType Leaf)) {
    throw 'Host UI build is missing the ContextOS integration marker.'
}
Write-Host 'ContextOS host-integrated llama.cpp Web UI is ready.' -ForegroundColor Green
