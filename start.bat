@echo off
title Momentum Chasers PRO - Live Multi-Key Gateway
cd /d "%~dp0"
echo ========================================================
echo   Starting Momentum Chasers Pro (Live Multi-Key Gateway)
echo ========================================================
echo.
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js is not found in your PATH.
    echo Opening index.html directly in your default browser...
    start index.html
    pause
    exit /b
)

echo [1/2] Launching server on http://localhost:3000 ...
echo [INFO] Keep this black window OPEN while using the app!
echo.

:: Open browser after 1.5 seconds in background so server is listening first
start /b "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"

:: Start the gateway server
node server.js
pause
