@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [error] Node.js 22+ is required. Install Node.js and try again.
  pause
  exit /b 1
)
node tools\start-client.mjs %*
pause
