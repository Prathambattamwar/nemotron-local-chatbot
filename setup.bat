@echo off
setlocal
cd /d "%~dp0"
if not exist .env copy .env.example .env
echo Add your NVIDIA_API_KEY to .env, then run start.bat.
pause
