# Windows 작업 스케줄러에서 로컬 인터뷰 브리지 DB의 일별 백업 작업을 관리한다.
[CmdletBinding()]
param(
    [ValidateSet("Install", "Start", "Stop", "Status", "Remove")]
    [string]$Action = "Status",
    [string]$ProjectPath = "",
    [string]$TaskName = "Hunet Interview Arrangement Bridge Database Backup"
)

$ErrorActionPreference = "Stop"
$ProjectPath = if ($ProjectPath) {
    (Resolve-Path $ProjectPath).Path
} else {
    (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$BackupEntryPoint = Join-Path $ProjectPath "dist\src\cli\backup-database.js"

function Get-BackupTask {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Assert-BuiltBackup {
    if (-not (Test-Path -LiteralPath $BackupEntryPoint -PathType Leaf)) {
        throw "백업 빌드 결과가 없습니다. 먼저 'npm run build'를 실행하세요. $BackupEntryPoint"
    }
}

switch ($Action) {
    "Install" {
        Assert-BuiltBackup
        $nodePath = (Get-Command node -ErrorAction Stop).Source
        $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $taskAction = New-ScheduledTaskAction `
            -Execute $nodePath `
            -Argument ('"{0}"' -f $BackupEntryPoint) `
            -WorkingDirectory $ProjectPath
        # PC가 꺼져 있던 날에도 다음 로그인에서 한 번 백업하도록 두 트리거를 사용한다.
        $dailyTrigger = New-ScheduledTaskTrigger -Daily -At "03:15"
        $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
        $taskSettings = New-ScheduledTaskSettingsSet `
            -StartWhenAvailable `
            -MultipleInstances IgnoreNew `
            -RestartCount 2 `
            -RestartInterval (New-TimeSpan -Minutes 5) `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
        $taskPrincipal = New-ScheduledTaskPrincipal `
            -UserId $currentUser `
            -LogonType Interactive `
            -RunLevel Limited

        Register-ScheduledTask `
            -TaskName $TaskName `
            -Action $taskAction `
            -Trigger @($dailyTrigger, $logonTrigger) `
            -Settings $taskSettings `
            -Principal $taskPrincipal `
            -Description "로컬 인터뷰 어레인지 브리지 SQLite DB를 하루 한 번 안전하게 백업합니다." `
            -Force | Out-Null
        Write-Output "작업 스케줄러 백업 등록 완료: $TaskName"
        break
    }
    "Start" {
        if (-not (Get-BackupTask)) { throw "등록된 백업 작업을 찾을 수 없습니다. -Action Install을 먼저 실행하세요." }
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "백업 실행 요청 완료: $TaskName"
        break
    }
    "Stop" {
        if (-not (Get-BackupTask)) { throw "등록된 백업 작업을 찾을 수 없습니다." }
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Output "백업 중지 요청 완료: $TaskName"
        break
    }
    "Status" {
        $task = Get-BackupTask
        if (-not $task) {
            Write-Output "NOT_REGISTERED: $TaskName"
            break
        }
        $info = Get-ScheduledTaskInfo -TaskName $TaskName
        [PSCustomObject]@{
            TaskName = $TaskName
            State = $task.State
            LastRunTime = $info.LastRunTime
            LastTaskResult = $info.LastTaskResult
            NextRunTime = $info.NextRunTime
        }
        break
    }
    "Remove" {
        if (Get-BackupTask) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Output "작업 스케줄러 백업 등록 해제 완료: $TaskName"
        } else {
            Write-Output "NOT_REGISTERED: $TaskName"
        }
        break
    }
}
