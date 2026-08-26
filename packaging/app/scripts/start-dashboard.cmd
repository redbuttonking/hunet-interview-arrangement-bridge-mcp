:: 설치된 대시보드 서버를 현재 Windows 사용자 권한으로 실행한다.
@echo off
setlocal
cd /d "%~dp0.."
set "PORT=3100"
set "HOSTNAME=127.0.0.1"
set "INTERVIEW_BRIDGE_ROOT=%CD%"
"%CD%\runtime\node.exe" "%CD%\dashboard\apps\dashboard\server.js"
