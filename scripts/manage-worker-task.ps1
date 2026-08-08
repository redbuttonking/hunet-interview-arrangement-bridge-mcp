# Windows 작업 스케줄러에 등록된 인터뷰 브리지 워커를 관리한다.
[CmdletBinding()]
param(
    [ValidateSet("Install", "Start", "Stop", "Restart", "Status", "Remove")]
    [string]$Action = "Status",
    [string]$ProjectPath = "",
    [string]$TaskName = "Hunet Interview Arrangement Bridge Worker"
)

$ErrorActionPreference = "Stop"
$ProjectPath = if ($ProjectPath) {
    (Resolve-Path $ProjectPath).Path
} else {
    (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$WorkerEntryPoint = Join-Path $ProjectPath "dist\src\worker\main.js"

function Get-WorkerTask {
    Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Assert-BuiltWorker {
    if (-not (Test-Path -LiteralPath $WorkerEntryPoint -PathType Leaf)) {
        throw "워커 빌드 결과가 없습니다. 먼저 'npm run build'를 실행하세요: $WorkerEntryPoint"
    }
}

switch ($Action) {
    "Install" {
        Assert-BuiltWorker
        $nodePath = (Get-Command node -ErrorAction Stop).Source
        $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
        $taskAction = New-ScheduledTaskAction `
            -Execute $nodePath `
            -Argument ('"{0}"' -f $WorkerEntryPoint) `
            -WorkingDirectory $ProjectPath
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
            -TaskName $TaskName `
            -Action $taskAction `
            -Trigger $taskTrigger `
            -Settings $taskSettings `
            -Principal $taskPrincipal `
            -Description "로그인 후 인터뷰 어레인지 브리지 워커를 장기 실행한다." `
            -Force | Out-Null
        Write-Output "작업 스케줄러 등록 완료: $TaskName"
        break
    }
    "Start" {
        if (-not (Get-WorkerTask)) { throw "등록된 작업을 찾을 수 없습니다. -Action Install을 먼저 실행하세요." }
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "워커 시작 요청 완료: $TaskName"
        break
    }
    "Stop" {
        if (-not (Get-WorkerTask)) { throw "등록된 작업을 찾을 수 없습니다." }
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Write-Output "워커 중지 요청 완료: $TaskName"
        break
    }
    "Restart" {
        if (-not (Get-WorkerTask)) { throw "등록된 작업을 찾을 수 없습니다. -Action Install을 먼저 실행하세요." }
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "워커 재시작 요청 완료: $TaskName"
        break
    }
    "Status" {
        $task = Get-WorkerTask
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
        if (Get-WorkerTask) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Output "작업 스케줄러 등록 해제 완료: $TaskName"
        } else {
            Write-Output "NOT_REGISTERED: $TaskName"
        }
        break
    }
}
