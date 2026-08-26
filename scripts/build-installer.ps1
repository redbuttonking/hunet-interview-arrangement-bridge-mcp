# 현재 개인용 DB와 빌드 결과를 포함한 Windows 설치형 EXE를 만든다.
[CmdletBinding()]
param(
    [string]$OutputDirectory = "",
    [switch]$KeepStaging
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OutputDirectory = if ($OutputDirectory) {
    $OutputDirectory
} else {
    Join-Path $projectRoot "release"
}
$iexpressPath = Join-Path $env:WINDIR "System32\iexpress.exe"
$nodePath = Join-Path $env:ProgramFiles "nodejs\node.exe"
$seedDatabasePath = Join-Path $projectRoot "data\bridge.db"
$seedEnvPath = Join-Path $projectRoot ".env"

foreach ($requiredPath in @($iexpressPath, $nodePath, $seedDatabasePath, $seedEnvPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "설치 파일 제작에 필요한 파일을 찾지 못했습니다: $requiredPath"
    }
}

Push-Location $projectRoot
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "MCP와 워커 빌드에 실패했습니다." }
    & npm.cmd run build:dashboard
    if ($LASTEXITCODE -ne 0) { throw "대시보드 빌드에 실패했습니다." }
} finally {
    Pop-Location
}

$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
$stagingRoot = Join-Path $outputRoot "installer-staging"
$payloadRoot = Join-Path $stagingRoot "payload"
$applicationRoot = Join-Path $payloadRoot "app"
$seedRoot = Join-Path $payloadRoot "seed"
$payloadArchive = Join-Path $stagingRoot "hunet-interview-ops-payload.zip"
$installerScript = Join-Path $stagingRoot "install.ps1"
$sedPath = Join-Path $stagingRoot "hunet-interview-ops.sed"
$installerPath = Join-Path $outputRoot "HunetInterviewOps-Setup.exe"
$candidateInstallerPath = Join-Path $outputRoot "HunetInterviewOps-Setup.new.exe"
$previousInstallerPath = Join-Path $outputRoot "HunetInterviewOps-Setup.previous.exe"

if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $applicationRoot -Force | Out-Null
New-Item -ItemType Directory -Path $seedRoot -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $applicationRoot "runtime") -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot "dist") -Destination (Join-Path $applicationRoot "dist") -Recurse -Force
Copy-Item -LiteralPath $nodePath -Destination (Join-Path $applicationRoot "runtime\node.exe") -Force
Copy-Item -Path (Join-Path $projectRoot "packaging\app\*") -Destination $applicationRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "package.json") -Destination (Join-Path $applicationRoot "package.json") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "package-lock.json") -Destination (Join-Path $applicationRoot "package-lock.json") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "apps\dashboard\.next\standalone") -Destination (Join-Path $applicationRoot "dashboard") -Recurse -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "apps\dashboard\.next\static") -Destination (Join-Path $applicationRoot "dashboard\apps\dashboard\.next\static") -Recurse -Force
Copy-Item -LiteralPath $seedDatabasePath -Destination (Join-Path $seedRoot "bridge.db") -Force
Copy-Item -LiteralPath $seedEnvPath -Destination (Join-Path $seedRoot ".env") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "packaging\install.ps1") -Destination $installerScript -Force

Push-Location $applicationRoot
try {
    & npm.cmd ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "?뚯빱 ?ㅽ뻾???꾩슂???ㅻ? ?섏튂???ㅽ뙣?덉뒿?덈떎." }
} finally {
    Pop-Location
}

Set-Content -LiteralPath (Join-Path $applicationRoot "dashboard\apps\dashboard\package.json") -Value '{"type":"commonjs"}' -Encoding UTF8

if (Test-Path -LiteralPath $payloadArchive) {
    Remove-Item -LiteralPath $payloadArchive -Force
}

& tar.exe -a -c -f $payloadArchive -C $payloadRoot "app" "seed"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $payloadArchive -PathType Leaf) -or (Get-Item -LiteralPath $payloadArchive).Length -eq 0) {
    throw "?ㅼ튂 ?⑦궎吏 ?뺤텛???ㅽ뙣?덉뒿?덈떎."
}
$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$candidateInstallerPath
FriendlyName=Hunet Interview Ops
AppLaunched=powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="install.ps1"
FILE1="hunet-interview-ops-payload.zip"
[SourceFiles]
SourceFiles0=$stagingRoot\
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
Set-Content -LiteralPath $sedPath -Value $sed -Encoding ASCII

if (Test-Path -LiteralPath $candidateInstallerPath) {
    Remove-Item -LiteralPath $candidateInstallerPath -Force
}

$iexpressProcess = Start-Process -FilePath $iexpressPath -ArgumentList @("/N", "/Q", "/M", $sedPath) -PassThru
try {
    Wait-Process -Id $iexpressProcess.Id -Timeout 600 -ErrorAction Stop
} catch {
    Stop-Process -Id $iexpressProcess.Id -Force -ErrorAction SilentlyContinue
    throw "IExpress 설치 파일 생성 시간이 초과되었습니다. 기존 설치 파일은 유지했습니다."
}
$iexpressProcess.Refresh()
if ($iexpressProcess.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $candidateInstallerPath -PathType Leaf)) {
    throw "IExpress 설치 파일 생성에 실패했습니다. 기존 설치 파일은 유지했습니다."
}
$candidateInstaller = Get-Item -LiteralPath $candidateInstallerPath
if ($candidateInstaller.Length -lt 1MB) {
    throw "새 설치 파일의 크기가 비정상입니다. 기존 설치 파일은 유지했습니다."
}

$movedCurrentInstaller = $false
try {
    if (Test-Path -LiteralPath $previousInstallerPath) {
        Remove-Item -LiteralPath $previousInstallerPath -Force
    }
    if (Test-Path -LiteralPath $installerPath) {
        Move-Item -LiteralPath $installerPath -Destination $previousInstallerPath -Force
        $movedCurrentInstaller = $true
    }
    Move-Item -LiteralPath $candidateInstallerPath -Destination $installerPath -Force
} catch {
    if ($movedCurrentInstaller -and -not (Test-Path -LiteralPath $installerPath) -and (Test-Path -LiteralPath $previousInstallerPath)) {
        Move-Item -LiteralPath $previousInstallerPath -Destination $installerPath -Force
    }
    throw
}

if (-not $KeepStaging) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}

$installer = Get-Item -LiteralPath $installerPath
[PSCustomObject]@{
    FullName = $installer.FullName
    Length = $installer.Length
    LastWriteTime = $installer.LastWriteTime
    Sha256 = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash
}
