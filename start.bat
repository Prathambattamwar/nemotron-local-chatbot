@echo off
setlocal
cd /d "%~dp0"
if not exist .env (
  echo .env is missing. Run setup.bat and add your NVIDIA API key first.
  pause
  exit /b 1
)
call npm start
pause
