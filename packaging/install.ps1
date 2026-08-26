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
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $installedNodePath -PathType Leaf) {
    Get-Process -Name "node" -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $installedNodePath } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }

  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  Copy-Item -Path (Join-Path $applicationSource "*") -Destination $installRoot -Recurse -Force
  New-Item -ItemType Directory -Path (Join-Path $installRoot "data") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $installRoot "logs") -Force | Out-Null

  $installedEnvPath = Join-Path $installRoot ".env"
  if (-not (Test-Path -LiteralPath $installedEnvPath -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $seedSource ".env") -Destination $installedEnvPath -Force
  }

  $installedDatabasePath = Join-Path $installRoot "data\bridge.db"
  if (-not (Test-Path -LiteralPath $installedDatabasePath -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $seedSource "bridge.db") -Destination $installedDatabasePath -Force
  }

  $nodePath = Join-Path $installRoot "runtime\node.exe"
  $workerEntryPoint = Join-Path $installRoot "dist\src\worker\main.js"
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf) -or -not (Test-Path -LiteralPath $workerEntryPoint -PathType Leaf)) {
    throw "워커 실행 파일이 완전하지 않습니다."
  }

  $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskAction = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument ('"{0}"' -f $workerEntryPoint) `
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

  Start-Process -FilePath (Join-Path $installRoot "Hunet Interview Ops.cmd")
  Write-Output "설치 완료: $installRoot"
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
