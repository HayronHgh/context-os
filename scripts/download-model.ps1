[CmdletBinding()]
param(
    [string]$Repo,
    [string]$File,
    [string]$MmprojFile
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ModelsDirectory = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot '..\models'))
New-Item -ItemType Directory -Force -Path $ModelsDirectory | Out-Null

if (-not $Repo) { $Repo = Read-Host 'Hugging Face repository (owner/name)' }
if (-not $File) { $File = Read-Host 'GGUF filename' }
if (-not $Repo -or -not $File) { throw 'Repository and filename are required.' }

function Download-One([string]$Repository, [string]$Filename) {
    $Destination = Join-Path $ModelsDirectory $Filename
    if (Test-Path -LiteralPath $Destination) {
        $Size = [math]::Round((Get-Item -LiteralPath $Destination).Length / 1GB, 2)
        Write-Host "Already present: $Filename ($Size GiB)" -ForegroundColor Green
        return
    }

    $Hf = Get-Command hf -ErrorAction SilentlyContinue
    $HfWorks = $false
    if ($Hf) {
        try {
            & hf version --format quiet 2>$null | Out-Null
            $HfWorks = ($LASTEXITCODE -eq 0)
        } catch { $HfWorks = $false }
    }

    if ($HfWorks) {
        Write-Host "Downloading with hf CLI: $Filename" -ForegroundColor Cyan
        & hf download $Repository --include $Filename --local-dir $ModelsDirectory
        if ($LASTEXITCODE -ne 0) { throw "hf download failed with exit code $LASTEXITCODE" }
    } else {
        $Url = "https://huggingface.co/$Repository/resolve/main/$Filename?download=true"
        Write-Host 'hf CLI is unavailable or broken; using resumable curl fallback.' -ForegroundColor Yellow
        Write-Host "Downloading: $Url"
        & curl.exe -L --fail --retry 5 --retry-delay 5 -C - -o $Destination $Url
        if ($LASTEXITCODE -ne 0) { throw "curl download failed with exit code $LASTEXITCODE" }
    }
}

Download-One $Repo $File
if ($MmprojFile) {
    Download-One $Repo $MmprojFile
}
Write-Host 'Download complete.' -ForegroundColor Green
