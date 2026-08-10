[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LlamaSource,
    [string]$BuildDirectory,
    [string]$CMake = 'C:\msys64\ucrt64\bin\cmake.exe'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Source = [System.IO.Path]::GetFullPath($LlamaSource)
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $Source 'build-contextos-mcp' }
$Build = [System.IO.Path]::GetFullPath($BuildDirectory)
$Patch = Join-Path $ProjectRoot 'patches\llama.cpp-b10295-windows-mcp-pipe.patch'

if (-not (Test-Path -LiteralPath (Join-Path $Source 'tools\server\server-mcp.cpp') -PathType Leaf)) {
    throw "llama.cpp server source not found: $Source"
}
if (-not (Test-Path -LiteralPath $CMake -PathType Leaf)) {
    throw "CMake not found: $CMake. Install the MSYS2 UCRT64 CMake and Ninja packages or pass -CMake."
}

& git -C $Source apply --check $Patch 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host 'Applying the ContextOS Windows MCP pipe compatibility patch...' -ForegroundColor Cyan
    & git -C $Source apply $Patch
    if ($LASTEXITCODE -ne 0) { throw "git apply failed with exit code $LASTEXITCODE" }
} else {
    & git -C $Source apply --reverse --check $Patch 2>$null
    if ($LASTEXITCODE -ne 0) {
        throw 'The patch does not apply cleanly and is not already applied. Use the pinned llama.cpp b10295 source.'
    }
    Write-Host 'The Windows MCP pipe compatibility patch is already applied.' -ForegroundColor Yellow
}

$ConfigureArguments = @(
    '-S', $Source,
    '-B', $Build,
    '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=ON',
    '-DGGML_CUDA=OFF',
    '-DGGML_BACKEND_DL=ON',
    '-DGGML_NATIVE=OFF',
    '-DGGML_CPU_ALL_VARIANTS=ON',
    '-DGGML_CCACHE=OFF',
    '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=OFF',
    '-DLLAMA_BUILD_SERVER=ON',
    '-DLLAMA_CURL=OFF'
)

Write-Host "Configuring patched llama-server: $Build" -ForegroundColor Cyan
& $CMake @ConfigureArguments
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed with exit code $LASTEXITCODE" }

Write-Host 'Building llama-server...' -ForegroundColor Cyan
& $CMake --build $Build --target llama-server --parallel
if ($LASTEXITCODE -ne 0) { throw "CMake build failed with exit code $LASTEXITCODE" }

$Output = Join-Path $Build 'bin'
if (-not (Test-Path -LiteralPath (Join-Path $Output 'llama-server.exe') -PathType Leaf)) {
    throw 'Build completed without producing bin\llama-server.exe.'
}

Write-Host "Patched llama-server is ready: $Output" -ForegroundColor Green
Write-Host 'Copy the complete output directory into a private runtime directory. Supply CUDA runtime libraries separately.'
