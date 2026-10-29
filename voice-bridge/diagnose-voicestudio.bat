@echo off
setlocal
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
node diagnose-voicestudio.js
 echo.
 pause
