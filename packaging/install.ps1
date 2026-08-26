# 설치형 EXE가 현재 사용자 로컬 폴더에 인터뷰 운영 앱과 워커를 배치한다.
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$applicationName = "Hunet Interview Ops"
$installRoot = Join-Path $env:LOCALAPPDATA $applicationName
$taskName = "Hunet Interview Ops Worker"
$payloadPath = Join-Path $PSScriptRoot "hunet-interview-ops-payload.zip"
$temporaryDirectory = Join-Path $env:TEMP ("HunetInterviewOps-" + [guid]::NewGuid().ToString("N"))

if (-not (Test-Path -LiteralPath $payloadPath -PathType Leaf)) {
  throw "설치 파일에 앱 패키지가 없습니다."
}

try {
  New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
  Expand-Archive -LiteralPath $payloadPath -DestinationPath $temporaryDirectory -Force
  $applicationSource = Join-Path $temporaryDirectory "app"
  $seedSource = Join-Path $temporaryDirectory "seed"
  if (-not (Test-Path -LiteralPath $applicationSource -PathType Container)) {
    throw "설치 파일의 앱 구성 요소를 찾지 못했습니다."
  }

  $installedNodePath = Join-Path $installRoot "runtime\node.exe"
  $installedDatabasePath = Join-Path $installRoot "data\bridge.db"
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $installedNodePath -PathType Leaf) {
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $installedNodePath } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    $stopDeadline = (Get-Date).AddSeconds(10)
    while (
      (Get-Process -Name "node" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $installedNodePath }) -and
      (Get-Date) -lt $stopDeadline
    ) {
      Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Name "node" -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $installedNodePath }) {
      throw "기존 워커 또는 대시보드를 종료하지 못해 업데이트를 중단했습니다."
    }
  }

  if (Test-Path -LiteralPath $installedDatabasePath -PathType Leaf) {
    $backupScript = Join-Path $applicationSource "scripts\backup-existing-database.mjs"
    $backupNode = Join-Path $applicationSource "runtime\node.exe"
    $backupDirectory = Join-Path $installRoot "data\backups"
    & $backupNode $backupScript $installedDatabasePath $backupDirectory
    if ($LASTEXITCODE -ne 0) {
      throw "업데이트 전 DB 백업에 실패해 설치를 중단했습니다."
    }
  }

  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  Copy-Item -Path (Join-Path $applicationSource "*") -Destination $installRoot -Recurse -Force
  New-Item -ItemType Directory -Path (Join-Path $installRoot "data") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $installRoot "logs") -Force | Out-Null

  $installedEnvPath = Join-Path $installRoot ".env"
  if (-not (Test-Path -LiteralPath $installedEnvPath -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $seedSource ".env") -Destination $installedEnvPath -Force
  }

  if (-not (Test-Path -LiteralPath $installedDatabasePath -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $seedSource "bridge.db") -Destination $installedDatabasePath -Force
  }

  $nodePath = Join-Path $installRoot "runtime\node.exe"
  $workerEntryPoint = Join-Path $installRoot "dist\src\worker\main.js"
  $workerLauncher = Join-Path $installRoot "scripts\start-worker.cmd"
  if (
    -not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $workerEntryPoint -PathType Leaf) -or
    -not (Test-Path -LiteralPath $workerLauncher -PathType Leaf)
  ) {
    throw "워커 실행 파일이 완전하지 않습니다."
  }

  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskAction = New-ScheduledTaskAction `
    -Execute $env:ComSpec `
    -Argument ('/d /c ""{0}""' -f $workerLauncher) `
    -WorkingDirectory $installRoot
  $taskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
  $taskSettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
  $taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType Interactive `
    -RunLevel Limited
  Register-ScheduledTask `
    -TaskName $taskName `
    -Action $taskAction `
    -Trigger $taskTrigger `
    -Settings $taskSettings `
    -Principal $taskPrincipal `
    -Description "인터뷰 어레인지 워커를 Windows 로그인 시 자동으로 실행합니다." `
    -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName

  $desktopPath = [Environment]::GetFolderPath("Desktop")
  $shortcutPath = Join-Path $desktopPath "$applicationName.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $installRoot "Hunet Interview Ops.cmd"
  $shortcut.WorkingDirectory = $installRoot
  $shortcut.Description = "인터뷰 운영 대시보드를 엽니다."
  $shortcut.Save()

  $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $installRoot /inheritance:r /grant:r "*$currentUserSid`:(OI)(CI)F" "*S-1-5-18`:(OI)(CI)F" "*S-1-5-32-544`:(OI)(CI)F" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "설치 폴더의 접근 권한을 안전하게 설정하지 못했습니다."
  }

  Start-Process -FilePath (Join-Path $installRoot "Hunet Interview Ops.cmd")
  Write-Output "설치 완료: $installRoot"
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
