# 설치형 EXE가 현재 사용자 로컬 폴더에 인터뷰 운영 앱과 워커를 배치한다.
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$applicationName = "Hunet Interview Ops"
$installRoot = Join-Path $env:LOCALAPPDATA $applicationName
$taskName = "Hunet Interview Ops Worker"
$payloadPath = Join-Path $PSScriptRoot "hunet-interview-ops-payload.zip"
$temporaryDirectory = Join-Path $env:TEMP ("HunetInterviewOps-" + [guid]::NewGuid().ToString("N"))

function Test-SqliteDatabaseHeader {
  param([string]$Path)

  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    try {
      if ($stream.Length -lt 16) { return $false }
      $header = New-Object byte[] 16
      if ($stream.Read($header, 0, $header.Length) -ne $header.Length) { return $false }
      return [System.Text.Encoding]::ASCII.GetString($header) -eq ("SQLite format 3" + [char]0)
    } finally {
      $stream.Dispose()
    }
  } catch {
    return $false
  }
}

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
  $installedDataDirectory = Join-Path $installRoot "data"
  $installedDatabasePath = Join-Path $installRoot "data\bridge.db"
  $installationMarkerPath = Join-Path $installRoot ".installation-complete"
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $installedDataDirectory -Force | Out-Null
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

  $hasExistingDatabase = Test-Path -LiteralPath $installedDatabasePath -PathType Leaf
  $hasValidExistingDatabase = $hasExistingDatabase -and (Test-SqliteDatabaseHeader -Path $installedDatabasePath)
  $hasCompletedPreviousInstallation = $hasValidExistingDatabase -and (Test-Path -LiteralPath $installationMarkerPath -PathType Leaf)
  if ($hasExistingDatabase) {
    if (-not $hasValidExistingDatabase) {
      $invalidDatabasePath = Join-Path $installedDataDirectory (
        "bridge.incomplete-" + (Get-Date -Format "yyyyMMddHHmmss") + ".db"
      )
      try {
        Move-Item -LiteralPath $installedDatabasePath -Destination $invalidDatabasePath -Force
      } catch {
        throw "기존 DB가 유효한 SQLite 파일이 아니며 안전하게 보관하지 못했습니다. 경로: $installedDatabasePath"
      }
      Write-Warning "이전 설치에서 남은 불완전한 DB를 보관하고 새 DB를 준비합니다: $invalidDatabasePath"
    } elseif ($hasCompletedPreviousInstallation) {
      $backupScript = Join-Path $applicationSource "scripts\backup-existing-database.mjs"
      $backupNode = Join-Path $applicationSource "runtime\node.exe"
      $backupDirectory = Join-Path $installedDataDirectory "backups"
      & $backupNode $backupScript $installedDatabasePath $backupDirectory
      if ($LASTEXITCODE -ne 0) {
        throw "업데이트 전 DB 백업에 실패해 설치를 중단했습니다. DB는 변경하지 않았습니다. 경로: $installedDatabasePath"
      }
    } else {
      Write-Warning "기존 설치 완료 표식이 없어 DB를 그대로 유지하고 업데이트 전 자동 백업은 건너뜁니다."
    }
  }

  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  Copy-Item -Path (Join-Path $applicationSource "*") -Destination $installRoot -Recurse -Force
  New-Item -ItemType Directory -Path $installedDataDirectory -Force | Out-Null
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

  $shortcutTarget = Join-Path $installRoot "Hunet Interview Ops.cmd"
  $shell = New-Object -ComObject WScript.Shell
  $desktopCandidates = @([Environment]::GetFolderPath("Desktop"))
  try {
    $desktopCandidates += [string]$shell.SpecialFolders.Item("Desktop")
  } catch {
    # 기본 Windows 바탕화면 경로가 이미 후보에 포함되어 있다.
  }
  $shortcutPaths = @()
  foreach ($desktopPath in ($desktopCandidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
    New-Item -ItemType Directory -Path $desktopPath -Force | Out-Null
    $shortcutPath = Join-Path $desktopPath "$applicationName.lnk"
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $shortcutTarget
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = "인터뷰 운영 대시보드를 엽니다."
    $shortcut.Save()
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
      throw "바탕화면 바로가기를 만들지 못했습니다. 경로: $shortcutPath"
    }
    $shortcutPaths += $shortcutPath
  }
  if ($shortcutPaths.Count -eq 0) {
    throw "바탕화면 경로를 확인하지 못해 바로가기를 만들지 못했습니다."
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

  $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $installRoot /inheritance:r /grant:r "*$currentUserSid`:(OI)(CI)F" "*S-1-5-18`:(OI)(CI)F" "*S-1-5-32-544`:(OI)(CI)F" /T /C | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "설치 폴더의 접근 권한을 안전하게 설정하지 못했습니다."
  }

  Set-Content -LiteralPath $installationMarkerPath -Value "completed $(Get-Date -Format o)" -NoNewline -Encoding UTF8

  Start-Process -FilePath (Join-Path $installRoot "Hunet Interview Ops.cmd")
  Write-Output "설치 완료: $installRoot"
  Write-Output "바탕화면 바로가기: $($shortcutPaths -join '; ')"
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
  }
}
