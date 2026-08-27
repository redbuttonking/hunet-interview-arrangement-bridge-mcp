:: 나인하이어와 다우오피스 자동화 전용 Chrome 프로필을 백그라운드에서 연다.
@echo off
setlocal
cd /d "%~dp0.."
set "INTERVIEW_BRIDGE_ROOT=%CD%"

powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '%CD%\runtime\node.exe' -ArgumentList '%CD%\dist\src\cli\open-daou-office.js'"
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '%CD%\runtime\node.exe' -ArgumentList '%CD%\dist\src\cli\open-ninehire-automation.js'"
