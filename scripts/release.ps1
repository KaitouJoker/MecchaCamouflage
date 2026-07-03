param(
    [string]$Version = "",
    [string]$OutDir = "",
    [string]$ExePath = "",
    [string]$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [switch]$IncludeRuntimeSource = $false
)

$ErrorActionPreference = "Stop"

function Resolve-ProjectVersion {
    param(
        [string]$Requested,
        [string]$Root
    )
    if (-not [string]::IsNullOrWhiteSpace($Requested)) {
        return $Requested
    }
    if (Get-Command git -ErrorAction SilentlyContinue) {
        $exact = & git -C $Root describe --tags --exact-match 2>$null
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($exact)) {
            return $exact.Trim()
        }
        $described = & git -C $Root describe --tags --dirty --always 2>$null
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($described)) {
            return $described.Trim()
        }
    }
    return "unversioned"
}

$Version = Resolve-ProjectVersion -Requested $Version -Root $RuntimeRoot
Write-Host "Package version: $Version"

if (-not $OutDir) { $OutDir = Join-Path $RuntimeRoot ".build\package" }
$ArtifactName = "meccha-camouflage-$Version"
if (-not $ExePath) { $ExePath = Join-Path $RuntimeRoot ".build\bin\meccha-camouflage.exe" }
if (-not (Test-Path $ExePath -PathType Leaf)) { throw "Executable not found: $ExePath. Run scripts/build.ps1 first." }

$TmpRoot = Join-Path $OutDir "tmp-release"
Remove-Item -Recurse -Force $TmpRoot -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $TmpRoot | Out-Null

Copy-Item -Force $ExePath (Join-Path $TmpRoot $([System.IO.Path]::GetFileName($ExePath)))
$MeshProfileDir = Join-Path (Split-Path -Parent $ExePath) "mesh-profiles"
if (Test-Path $MeshProfileDir -PathType Container) {
    Copy-Item -Recurse -Force $MeshProfileDir (Join-Path $TmpRoot "mesh-profiles")
}
Copy-Item -Force (Join-Path $RuntimeRoot "README.md") (Join-Path $TmpRoot "README.md")
Copy-Item -Force (Join-Path $RuntimeRoot "LICENSE.txt") (Join-Path $TmpRoot "LICENSE.txt")
Copy-Item -Force (Join-Path $RuntimeRoot "BRANDING.md") (Join-Path $TmpRoot "BRANDING.md")
$AssetOutDir = Join-Path $TmpRoot "assets"
New-Item -ItemType Directory -Force -Path $AssetOutDir | Out-Null
Copy-Item -Force (Join-Path $RuntimeRoot "assets\icon.png") (Join-Path $AssetOutDir "icon.png")

Set-Content -Encoding ASCII -Path (Join-Path $TmpRoot "runtime-config.json") -Value @'
{
  "version": "%VERSION%",
  "runtime": "cpp",
  "mode": "service",
  "game_process_name": "PenguinHotel-Win64-Shipping.exe",
  "config_dir": "%LOCALAPPDATA%\\MecchaCamouflage\\versions\\%VERSION%",
  "log_dir": "%LOCALAPPDATA%\\MecchaCamouflage\\runtime"
}
'@.Replace("%VERSION%", $Version)

if ($IncludeRuntimeSource) {
    Copy-Item -Recurse -Force (Join-Path $RuntimeRoot "runtime") (Join-Path $TmpRoot "runtime")
    Copy-Item -Recurse -Force (Join-Path $RuntimeRoot "scripts") (Join-Path $TmpRoot "scripts")
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$ZipPath = Join-Path $OutDir "$ArtifactName.zip"
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
$Zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $Root = (Resolve-Path $TmpRoot).Path.TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
    Get-ChildItem $TmpRoot -Recurse -File | ForEach-Object {
        $FullPath = (Resolve-Path $_.FullName).Path
        $RelativePath = $FullPath.Substring($Root.Length).Replace("\", "/")
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Zip, $_.FullName, $RelativePath, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally {
    $Zip.Dispose()
}

Remove-Item -Recurse -Force $TmpRoot
Write-Host "Wrote $ZipPath"
