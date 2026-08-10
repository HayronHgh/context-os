@echo off
setlocal
chcp 65001 >nul
title ContextOS - Start llama.cpp + MCP

echo Starting the complete local stack:
echo   Context Bridge ^> llama.cpp server ^> ContextOS MCP ^> health and tool checks ^> Web UI
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-bridge.ps1"
if errorlevel 1 (
    set "EXIT_CODE=1"
    goto :failed
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-server.ps1" -OpenBrowser
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-bridge.ps1" >nul 2>&1
    goto :failed
)

echo.
echo ContextOS stack is ready.
pause
exit /b 0

:failed
echo.
echo ContextOS stack did not start. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
