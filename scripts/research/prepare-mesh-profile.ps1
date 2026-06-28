param(
    [string]$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$MeshPath = "",
    [string]$OutPath = ""
)

$ErrorActionPreference = "Stop"

if (-not $MeshPath) {
    $MeshPath = Join-Path $RuntimeRoot ".build\research\mesh_exports\paintman-Chameleon_Content_3Dmodel_cLeon_charactor_paintman_skeltal_paintman.uasset.lod0.json"
}
if (-not $OutPath) {
    $OutPath = Join-Path $RuntimeRoot ".build\bin\runtime-bridge.dll.mesh-profile.json"
}
if (-not (Test-Path $MeshPath -PathType Leaf)) {
    throw "Mesh export not found: $MeshPath. Run scripts\research\run-asset-probe.ps1 with -ExportTopSkeletal first."
}

$profile = Get-Content -Raw -Path $MeshPath | ConvertFrom-Json
if ($profile.Export -ne "paintman") {
    throw "Unexpected mesh export '$($profile.Export)'. Expected 'paintman'."
}
if ($profile.Lod0.VertexCount -ne 1660 -or $profile.Lod0.IndexCount -ne 8352 -or $profile.Bones.Count -ne 28) {
    throw "Unexpected paintman profile shape. Expected vertices=1660 indices=8352 bones=28."
}

$outDir = Split-Path -Parent $OutPath
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -Force $MeshPath $OutPath
Write-Host "Prepared mesh profile: $OutPath"
