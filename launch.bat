@echo off
chcp 65001 >nul
title cli-prompt-cron

:: Check Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [cli-prompt-cron] Node.js not found.
    echo [cli-prompt-cron] Install Node.js 20+ and try again.
    pause
    exit /b 1
)

:: Kill existing process on port 3300
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3300 " ^| findstr LISTEN') do (
    powershell -Command "Stop-Process -Id %%a -Force -ErrorAction SilentlyContinue" >nul 2>&1
)

:: Move to this bat file's directory
cd /d "%~dp0"
echo [cli-prompt-cron] Starting...
node start.js
set EXIT_CODE=%ERRORLEVEL%

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [cli-prompt-cron] Failed to start. Exit code: %EXIT_CODE%
    pause
)

exit /b %EXIT_CODE%
