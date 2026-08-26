:: 현재 Windows 로그인 계정으로 인터뷰 운영 대시보드를 실행한다.
@echo off
setlocal
cd /d "%~dp0.."
"C:\Program Files\nodejs\node.exe" ".\node_modules\next\dist\bin\next" start apps/dashboard --hostname 127.0.0.1 --port 3100
