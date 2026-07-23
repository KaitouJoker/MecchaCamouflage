[CmdletBinding()]
param(
    [ValidateSet("round", "cube")]
    [string]$BodyType = "round",
    [string]$PaksPath = "",
    [string]$MappingsPath = "",
    [string]$Cue4ParsePath = "",
    [string]$OodlePath = "",
    [string]$ZlibPath = "",
    [string]$GameVersion = "GAME_UE5_6",
    [switch]$CaptureNeutralPose,
    [switch]$SkipMeshDump,
    [switch]$SkipBuild,
    [string]$BuildOutputDir = ".build\bin"
)

$ErrorActionPreference = "Stop"

function Invoke-Step {
    param([string]$Name, [scriptblock]$ScriptBlock)
    $global:LASTEXITCODE = 0
    & $ScriptBlock
    if (-not $?) { throw "$Name failed." }
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE." }
}

function Read-CaptureSnapshot {
    param([string]$CaptureExecutable, [string]$CaptureArgument)
    $output = @(& $CaptureExecutable $CaptureArgument 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw ("Image reference pose capture failed with exit code $LASTEXITCODE." + [Environment]::NewLine + ($output -join [Environment]::NewLine))
    }
    $json = $output |
        ForEach-Object { [string]$_ } |
        Where-Object { $_.StartsWith('{"Success"', [StringComparison]::Ordinal) } |
        Select-Object -Last 1
    if ([string]::IsNullOrWhiteSpace($json)) {
        throw ("Image reference pose capture returned no JSON snapshot." + [Environment]::NewLine + ($output -join [Environment]::NewLine))
    }
    return ($json | ConvertFrom-Json)
}

if (-not $CaptureNeutralPose) {
    throw "Set the selected body to a neutral standing pose, then rerun with -CaptureNeutralPose. This explicit development step prevents baking an arbitrary live pose."
}

$repoRoot = [System.IO.Path]::GetFullPath(
    (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).ProviderPath
)
$configuration = if ($BodyType -eq "cube") {
    [PSCustomObject]@{
        AssetPath = "Chameleon/Content/3Dmodel/cLeon/charactor/paintman/skeltal_cube/paintman_cube.uasset"
        ExportName = "paintman_cube"
        ProfileFile = "paintman_cube.mesh-profile-v2.json"
        ExpectedVertices = 452
        ExpectedIndices = 1080
        ExpectedBones = 28
    }
} else {
    [PSCustomObject]@{
        AssetPath = "Chameleon/Content/3Dmodel/cLeon/charactor/paintman/skeltal/paintman.uasset"
        ExportName = "paintman"
        ProfileFile = "paintman.mesh-profile-v2.json"
        ExpectedVertices = 1660
        ExpectedIndices = 8352
        ExpectedBones = 28
    }
}
$profilePath = Join-Path $repoRoot (Join-Path "resources\mesh-profiles" $configuration.ProfileFile)
$previousProfile = if (Test-Path -LiteralPath $profilePath) {
    [System.IO.File]::ReadAllBytes($profilePath)
} else {
    $null
}

try {
    if (-not $SkipMeshDump) {
        Invoke-Step -Name "regenerate $BodyType mesh profile" -ScriptBlock {
            $meshArguments = @{
                GameVersion = $GameVersion
                OutputPath = $profilePath
                AssetPath = $configuration.AssetPath
                ExportName = $configuration.ExportName
                ExpectedVertices = $configuration.ExpectedVertices
                ExpectedIndices = $configuration.ExpectedIndices
                ExpectedBones = $configuration.ExpectedBones
            }
            if (-not [string]::IsNullOrWhiteSpace($PaksPath)) { $meshArguments.PaksPath = $PaksPath }
            if (-not [string]::IsNullOrWhiteSpace($MappingsPath)) { $meshArguments.MappingsPath = $MappingsPath }
            if (-not [string]::IsNullOrWhiteSpace($Cue4ParsePath)) { $meshArguments.Cue4ParsePath = $Cue4ParsePath }
            if (-not [string]::IsNullOrWhiteSpace($OodlePath)) { $meshArguments.OodlePath = $OodlePath }
            if (-not [string]::IsNullOrWhiteSpace($ZlibPath)) { $meshArguments.ZlibPath = $ZlibPath }
            & (Join-Path $repoRoot "scripts\mesh.ps1") @meshArguments
        }
    }

    if (-not (Test-Path -LiteralPath $profilePath)) {
        throw "Mesh profile is missing after generation: $profilePath"
    }
    if (-not $SkipBuild) {
        Invoke-Step -Name "build capture host" -ScriptBlock {
            & (Join-Path $repoRoot "scripts\build.ps1") -RuntimeRoot $repoRoot -OutDir $BuildOutputDir
        }
    }

    $captureExecutable = Join-Path $repoRoot (Join-Path $BuildOutputDir "meccha-camouflage.exe")
    if (-not (Test-Path -LiteralPath $captureExecutable)) {
        throw "Capture executable is missing: $captureExecutable. Build it or omit -SkipBuild."
    }
    $snapshot = Read-CaptureSnapshot $captureExecutable "--capture-$BodyType-reference-pose"
    if (-not $snapshot.Success) {
        throw "Image reference pose capture was rejected: $($snapshot.Message)"
    }

    $profile = [System.IO.File]::ReadAllText($profilePath) | ConvertFrom-Json
    if ($snapshot.ProfileId -ne $profile.ProfileId) {
        throw "Capture profile mismatch. Expected '$($profile.ProfileId)', received '$($snapshot.ProfileId)'. Keep the requested $BodyType mesh active and retry."
    }
    $expectedTransforms = @($profile.Bones).Count
    $expectedVertices = @($profile.Lod0.Vertices).Count
    if (@($snapshot.ComponentTransforms).Count -ne $expectedTransforms -or @($snapshot.Vertices).Count -ne $expectedVertices) {
        throw "Capture topology mismatch. Expected bones=$expectedTransforms vertices=$expectedVertices; received bones=$(@($snapshot.ComponentTransforms).Count) vertices=$(@($snapshot.Vertices).Count)."
    }

    $referencePose = [PSCustomObject]@{
        Id = "$BodyType-natural-stand-development-capture-v1"
        ComponentTransforms = @($snapshot.ComponentTransforms)
        Vertices = @($snapshot.Vertices)
    }
    if ($profile.PSObject.Properties["ImageReferencePose"]) {
        $profile.ImageReferencePose = $referencePose
    } else {
        $profile | Add-Member -NotePropertyName "ImageReferencePose" -NotePropertyValue $referencePose
    }
    $json = $profile | ConvertTo-Json -Depth 16
    [System.IO.File]::WriteAllText(
        $profilePath,
        $json + [Environment]::NewLine,
        (New-Object System.Text.UTF8Encoding($false))
    )
    Write-Host "Updated $BodyType profile and fixed ImageReferencePose: $profilePath"
}
catch {
    if ($null -ne $previousProfile) {
        [System.IO.File]::WriteAllBytes($profilePath, $previousProfile)
        Write-Warning "Restored the previous profile because refresh did not complete."
    }
    throw
}
