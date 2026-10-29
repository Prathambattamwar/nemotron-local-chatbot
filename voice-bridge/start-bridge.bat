@echo off
setlocal
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
echo Starting local VoiceStudio bridge. Keep this window open.
node bridge.js
if errorlevel 1 (
  echo.
  echo VoiceStudio bridge stopped with an error.
  pause
)
