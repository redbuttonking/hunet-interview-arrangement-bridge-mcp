:: 설치 폴더에서 Codex CLI 대화 터미널을 연다.
@echo off
setlocal
cd /d "%~dp0.."
where codex >nul 2>nul
if errorlevel 1 (
  start "Hunet Interview Ops Codex" cmd.exe /k "echo Codex CLI가 설치되어 있지 않습니다. 회사 PC에 Codex CLI를 설치한 뒤 다시 실행해 주세요."
  exit /b 0
)
start "Hunet Interview Ops Codex" cmd.exe /k "codex"
