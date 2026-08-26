:: 설치형 대시보드 서버를 로그 파일과 함께 실행한다.
@echo off
setlocal
cd /d "%~dp0.."
set "PORT=3100"
set "HOSTNAME=127.0.0.1"
set "INTERVIEW_BRIDGE_ROOT=%CD%"
set "LOG_DIR=%CD%\logs"
set "LOG_FILE=%LOG_DIR%\dashboard.log"

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
if exist "%LOG_FILE%" for %%F in ("%LOG_FILE%") do if %%~zF GTR 5242880 move /y "%LOG_FILE%" "%LOG_DIR%\dashboard.previous.log" >nul

"%CD%\runtime\node.exe" "%CD%\dashboard\apps\dashboard\server.js" 1>>"%LOG_FILE%" 2>>&1
