param(
    [string]$RuntimeRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
    [string]$OutDir = "",
    [string]$ExeName = "meccha-camouflage",
    [string]$Version = ""
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
Write-Host "Build version: $Version"

if (-not $OutDir) {
    $OutDir = Join-Path $RuntimeRoot ".build\bin"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$ObjDir = Join-Path $RuntimeRoot ".build\obj"
New-Item -ItemType Directory -Force -Path $ObjDir | Out-Null

$BridgeSource = Join-Path $RuntimeRoot "runtime\src\bridge.cpp"
$InjectorSource = Join-Path $RuntimeRoot "runtime\src\injector.cpp"
$ControllerSources = @(
    (Join-Path $RuntimeRoot "runtime\src\controller.cpp"),
    (Join-Path $RuntimeRoot "runtime\src\controller_settings.cpp"),
    (Join-Path $RuntimeRoot "runtime\src\controller_events.cpp"),
    (Join-Path $RuntimeRoot "runtime\src\controller_hotkeys.cpp"),
    (Join-Path $RuntimeRoot "runtime\src\controller_ui.cpp")
)
$ImguiRoot = Join-Path $RuntimeRoot "third_party\imgui"
$ImguiBackendRoot = Join-Path $ImguiRoot "backends"
$IconSource = Join-Path $RuntimeRoot "assets\icon.ico"
$IconPngSource = Join-Path $RuntimeRoot "assets\icon.png"
$MeshProfilesSourceDir = Join-Path $RuntimeRoot "assets\mesh-profiles"
$MeshProfileResourceSource = Join-Path $MeshProfilesSourceDir "paintman.mesh-profile-v2.json"
$PrimaryFontArchive = Join-Path $RuntimeRoot "assets\fonts\arial.zip"
$FallbackFontArchive = Join-Path $RuntimeRoot "assets\fonts\helvetica-255.zip"
$FontExtractDir = Join-Path $ObjDir "fonts"
$FontRegularPath = Join-Path $FontExtractDir "App-Regular.ttf"
$FontSemiBoldPath = Join-Path $FontExtractDir "App-SemiBold.ttf"
$FontBoldPath = Join-Path $FontExtractDir "App-Bold.ttf"
$ImguiSources = @(
    (Join-Path $ImguiRoot "imgui.cpp"),
    (Join-Path $ImguiRoot "imgui_draw.cpp"),
    (Join-Path $ImguiRoot "imgui_tables.cpp"),
    (Join-Path $ImguiRoot "imgui_widgets.cpp"),
    (Join-Path $ImguiBackendRoot "imgui_impl_win32.cpp"),
    (Join-Path $ImguiBackendRoot "imgui_impl_dx11.cpp")
)
foreach ($source in @($BridgeSource, $InjectorSource) + $ControllerSources + $ImguiSources) {
    if (-not (Test-Path $source)) {
        throw "Source not found: $source"
    }
}
if (-not (Test-Path $IconSource)) {
    throw "Application icon not found: $IconSource"
}
if (-not (Test-Path $IconPngSource)) {
    throw "Application icon PNG not found: $IconPngSource"
}
if (-not (Test-Path $MeshProfilesSourceDir -PathType Container)) {
    throw "Mesh profile asset directory not found: $MeshProfilesSourceDir"
}
if (-not (Test-Path $MeshProfileResourceSource -PathType Leaf)) {
    throw "Required mesh profile asset not found: $MeshProfileResourceSource"
}
if (-not (Test-Path $PrimaryFontArchive) -and -not (Test-Path $FallbackFontArchive)) {
    throw "Application font archive not found. Expected $PrimaryFontArchive or $FallbackFontArchive"
}

function Quote-CmdArg([string]$Value) {
    if ($Value -match '^[A-Za-z0-9_./:=+\-\\]+$') {
        return $Value
    }
    return '"' + ($Value -replace '"', '\"') + '"'
}

function Get-VsDevCmd {
    $VsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $VsWhere)) { return "" }
    $VsInstall = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $VsInstall) { return "" }
    $VsDevCmd = Join-Path $VsInstall "Common7\Tools\VsDevCmd.bat"
    if (Test-Path $VsDevCmd) { return $VsDevCmd }
    return ""
}

function Invoke-VsToolCommand {
    param(
        [Parameter(Mandatory = $true)][string]$ToolName,
        [Parameter(Mandatory = $true)][string[]]$ToolArgs
    )
    if (Get-Command $ToolName -ErrorAction SilentlyContinue) {
        & $ToolName @ToolArgs
        if ($LASTEXITCODE -ne 0) { throw "$ToolName failed with exit code $LASTEXITCODE" }
        return
    }
    $VsDevCmd = Get-VsDevCmd
    if (-not $VsDevCmd) {
        throw "$ToolName was not found. Install Visual Studio 2022 Build Tools or run from a VS Developer PowerShell."
    }
    $ArgText = ($ToolArgs | ForEach-Object { Quote-CmdArg $_ }) -join " "
    $CommandLine = "$(Quote-CmdArg $VsDevCmd) -arch=x64 -host_arch=x64 >nul && $ToolName $ArgText"
    cmd /d /c $CommandLine
    if ($LASTEXITCODE -ne 0) { throw "$ToolName failed with exit code $LASTEXITCODE" }
}

function Get-ExeBaseName {
    param([string]$Name)
    $candidate = (New-Object System.IO.FileInfo($Name)).BaseName
    if ([string]::IsNullOrWhiteSpace($candidate)) { return "meccha-camouflage" }
    return $candidate
}

function Convert-ToCStringDefineValue {
    param([string]$Value)
    return (($Value -replace '\\', '\\') -replace '"', '\"')
}

function Extract-ZipEntry {
    param(
        [Parameter(Mandatory = $true)]$Zip,
        [Parameter(Mandatory = $true)][string]$EntryName,
        [Parameter(Mandatory = $true)][string]$OutPath
    )
    $Entry = $Zip.Entries | Where-Object { $_.FullName -ieq $EntryName } | Select-Object -First 1
    if (-not $Entry) { throw "Font entry not found in archive: $EntryName" }
    if (Test-Path $OutPath) { Remove-Item -Force $OutPath }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $OutPath)
}

function Test-ZipEntry {
    param(
        [Parameter(Mandatory = $true)]$Zip,
        [Parameter(Mandatory = $true)][string]$EntryName
    )
    return [bool]($Zip.Entries | Where-Object { $_.FullName -ieq $EntryName } | Select-Object -First 1)
}

function Select-AppFont {
    param([Parameter(Mandatory = $true)]$Candidates)
    foreach ($Candidate in $Candidates) {
        if (-not (Test-Path $Candidate.Archive)) { continue }
        $Zip = [System.IO.Compression.ZipFile]::OpenRead($Candidate.Archive)
        try {
            if ((Test-ZipEntry -Zip $Zip -EntryName $Candidate.Regular) -and
                (Test-ZipEntry -Zip $Zip -EntryName $Candidate.SemiBold) -and
                (Test-ZipEntry -Zip $Zip -EntryName $Candidate.Bold)) {
                return @{
                    Name = $Candidate.Name
                    Archive = $Candidate.Archive
                    Regular = $Candidate.Regular
                    SemiBold = $Candidate.SemiBold
                    Bold = $Candidate.Bold
                }
            }
        } finally {
            $Zip.Dispose()
        }
    }
    throw "No usable application font archive found."
}

$ExeName = Get-ExeBaseName -Name $ExeName

Push-Location $RuntimeRoot
try {
    $BridgeOutput = Join-Path $OutDir "runtime-bridge.dll"
    $InjectorOutput = Join-Path $OutDir "runtime-injector.exe"
    $ControllerOutput = Join-Path $OutDir "$ExeName.exe"

    Invoke-VsToolCommand -ToolName "cl.exe" -ToolArgs @(
        "/nologo", "/std:c++17", "/EHsc", "/O2", "/LD", $BridgeSource,
        "/Fo:$(Join-Path $ObjDir 'bridge.obj')",
        "/Fe:$BridgeOutput",
        "Ws2_32.lib",
        "User32.lib"
    )
    Invoke-VsToolCommand -ToolName "cl.exe" -ToolArgs @(
        "/nologo", "/EHsc", "/O2", $InjectorSource,
        "/Fo:$(Join-Path $ObjDir 'injector.obj')",
        "/Fe:$InjectorOutput"
    )

    if (-not (Test-Path $BridgeOutput)) { throw "Bridge DLL was not produced: $BridgeOutput" }
    $MeshProfilesOutputDir = Join-Path $OutDir "mesh-profiles"
    Remove-Item -Recurse -Force $MeshProfilesOutputDir -ErrorAction SilentlyContinue
    $MeshProfiles = @(Get-ChildItem -Path $MeshProfilesSourceDir -Filter "*.json" -File)
    if ($MeshProfiles.Count -le 0) {
        throw "No mesh profile JSON assets found in: $MeshProfilesSourceDir"
    }
    New-Item -ItemType Directory -Force -Path $MeshProfilesOutputDir | Out-Null
    Copy-Item -Force -Path (Join-Path $MeshProfilesSourceDir "*.json") -Destination $MeshProfilesOutputDir

    $ResourceRc = Join-Path $ObjDir "controller.rc"
    $ResourceRes = Join-Path $ObjDir "controller.res"
    $BridgeResourcePath = ((Resolve-Path $BridgeOutput).Path -replace '\\', '\\')
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Force -Path $FontExtractDir | Out-Null
    $FontChoice = Select-AppFont -Candidates @(
        @{ Name = "Arial"; Archive = $PrimaryFontArchive; Regular = "ARIAL.TTF"; SemiBold = "ARIALBD.TTF"; Bold = "ARIALBD.TTF" },
        @{ Name = "Helvetica-255"; Archive = $FallbackFontArchive; Regular = "Helvetica.ttf"; SemiBold = "Helvetica-Bold.ttf"; Bold = "Helvetica-Bold.ttf" }
    )
    Write-Host "Using application font: $($FontChoice.Name)"
    $FontZip = [System.IO.Compression.ZipFile]::OpenRead($FontChoice.Archive)
    try {
        Extract-ZipEntry -Zip $FontZip -EntryName $FontChoice.Regular -OutPath $FontRegularPath
        Extract-ZipEntry -Zip $FontZip -EntryName $FontChoice.SemiBold -OutPath $FontSemiBoldPath
        Extract-ZipEntry -Zip $FontZip -EntryName $FontChoice.Bold -OutPath $FontBoldPath
    } finally {
        $FontZip.Dispose()
    }
$IconResourcePath = ((Resolve-Path $IconSource).Path -replace '\\', '\\')
$IconPngResourcePath = ((Resolve-Path $IconPngSource).Path -replace '\\', '\\')
$MeshProfileResourcePath = ((Resolve-Path $MeshProfileResourceSource).Path -replace '\\', '\\')
$FontRegularResourcePath = ((Resolve-Path $FontRegularPath).Path -replace '\\', '\\')
$FontSemiBoldResourcePath = ((Resolve-Path $FontSemiBoldPath).Path -replace '\\', '\\')
$FontBoldResourcePath = ((Resolve-Path $FontBoldPath).Path -replace '\\', '\\')
Set-Content -Encoding ASCII -Path $ResourceRc -Value @"
101 RCDATA "$BridgeResourcePath"
201 ICON "$IconResourcePath"
202 RCDATA "$FontRegularResourcePath"
203 RCDATA "$FontSemiBoldResourcePath"
204 RCDATA "$FontBoldResourcePath"
205 RCDATA "$IconPngResourcePath"
301 RCDATA "$MeshProfileResourcePath"
"@
    Invoke-VsToolCommand -ToolName "rc.exe" -ToolArgs @("/nologo", "/fo", $ResourceRes, $ResourceRc)

    $ControllerToolArgs = @(
        "/nologo", "/std:c++17", "/EHsc", "/O2",
        "/DMECCHA_APP_VERSION=`"$(Convert-ToCStringDefineValue $Version)`"",
        "/I$ImguiRoot", "/I$ImguiBackendRoot",
        $ResourceRes
    ) + $ControllerSources + $ImguiSources + @(
        "/Fo:$ObjDir\",
        "/Fe:$ControllerOutput",
        "Ws2_32.lib",
        "User32.lib",
        "Gdi32.lib",
        "D3d11.lib",
        "Shell32.lib",
        "Dwmapi.lib",
        "Windowscodecs.lib",
        "Ole32.lib",
        "/link",
        "/SUBSYSTEM:WINDOWS"
    )
    Invoke-VsToolCommand -ToolName "cl.exe" -ToolArgs $ControllerToolArgs

    if (-not (Test-Path $ControllerOutput)) { throw "Controller EXE was not produced: $ControllerOutput" }
    if (-not (Test-Path $InjectorOutput)) { throw "Injector EXE was not produced: $InjectorOutput" }
}
finally {
    Pop-Location
}

Write-Host "Built runtime artifacts:"
Write-Host "  $(Join-Path $OutDir "$ExeName.exe")"
Write-Host "  $(Join-Path $OutDir 'runtime-bridge.dll')"
Write-Host "  $(Join-Path $OutDir 'runtime-injector.exe')"
