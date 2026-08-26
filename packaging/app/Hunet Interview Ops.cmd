:: 인터뷰 운영 대시보드를 열고 로컬 서버를 필요할 때만 시작한다.
@echo off
setlocal
set "APP_ROOT=%~dp0"
set "APP_ROOT=%APP_ROOT:~0,-1%"

powershell.exe -NoProfile -Command "try { $client = New-Object Net.Sockets.TcpClient; $client.Connect('127.0.0.1', 3100); $client.Close(); exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "Hunet Interview Ops Dashboard" /min "%APP_ROOT%\scripts\start-dashboard.cmd"
  set "DASHBOARD_READY="
  for /L %%I in (1,1,30) do (
    if not defined DASHBOARD_READY (
      powershell.exe -NoProfile -Command "try { $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:3100/login'; if ($response.StatusCode -eq 200) { exit 0 }; exit 1 } catch { exit 1 }"
      if not errorlevel 1 set "DASHBOARD_READY=1"
      if not defined DASHBOARD_READY timeout /t 1 /nobreak >nul
    )
  )
  if not defined DASHBOARD_READY (
    if not exist "%APP_ROOT%\logs" mkdir "%APP_ROOT%\logs"
    echo [%DATE% %TIME%] Dashboard did not become ready within 30 seconds. >> "%APP_ROOT%\logs\dashboard-launch.log"
  )
)

call "%APP_ROOT%\scripts\open-automation-browsers.cmd"

set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME_EXE%" (
  start "Hunet Interview Ops" "%CHROME_EXE%" --new-window "http://127.0.0.1:3100/"
) else (
  start "Hunet Interview Ops" "http://127.0.0.1:3100/"
)
