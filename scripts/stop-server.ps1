[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PidFile = Join-Path $ProjectRoot 'runtime\llama-server.pid'
$ConfigPath = Join-Path $ProjectRoot 'config\server.json'

if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Host 'No managed llama-server PID file was found.' -ForegroundColor Yellow
    exit 0
}

$ServerPid = [int](Get-Content -LiteralPath $PidFile -Raw)
$Process = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
if ($Process) {
    if (Test-Path -LiteralPath $ConfigPath) {
        $Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $ExpectedExecutable = if ([System.IO.Path]::IsPathRooted($Config.executable)) {
            [System.IO.Path]::GetFullPath($Config.executable)
        } else {
            [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $Config.executable))
        }
        if ($Process.Path -and -not [string]::Equals($Process.Path, $ExpectedExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to stop PID $ServerPid because it is not the configured llama-server: $($Process.Path)"
        }
    }
    Stop-Process -Id $ServerPid
    $Process.WaitForExit(10000) | Out-Null
    Write-Host "Stopped llama-server PID $ServerPid. Its stdio ContextOS MCP child was closed with the host." -ForegroundColor Green
} else {
    Write-Host "PID $ServerPid was no longer running." -ForegroundColor Yellow
}
Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
