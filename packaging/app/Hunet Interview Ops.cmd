:: 인터뷰 운영 대시보드를 열고 로컬 서버를 필요할 때만 시작한다.
@echo off
setlocal
set "APP_ROOT=%~dp0"
set "APP_ROOT=%APP_ROOT:~0,-1%"

powershell.exe -NoProfile -Command "try { $client = New-Object Net.Sockets.TcpClient; $client.Connect('127.0.0.1', 3100); $client.Close(); exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "Hunet Interview Ops Dashboard" /min "%APP_ROOT%\scripts\start-dashboard.cmd"
  timeout /t 2 /nobreak >nul
)

call "%APP_ROOT%\scripts\open-automation-browsers.cmd"

set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME_EXE%" (
  start "Hunet Interview Ops" "%CHROME_EXE%" --new-window "http://127.0.0.1:3100/"
) else (
  start "Hunet Interview Ops" "http://127.0.0.1:3100/"
)
