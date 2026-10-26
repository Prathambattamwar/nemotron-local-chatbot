@echo off
setlocal
cd /d "%~dp0"
echo Installing Nemotron Local Chatbot dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo Dependency installation failed. Check your Node.js/npm installation and internet connection.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo.
  echo Created .env from .env.example.
  echo Open .env and add your NVIDIA API key before starting the app.
) else (
  echo Existing .env found; leaving it unchanged.
)
echo.
echo Setup complete. Edit .env, then run start.bat.
pause
