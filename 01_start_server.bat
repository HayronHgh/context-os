@echo off
chcp 65001 >nul
title ContextOS llama-server
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-bridge.ps1"
if errorlevel 1 (
    echo ContextOS Host Bridge failed to start.
    pause
    exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-server.ps1"
if errorlevel 1 powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-bridge.ps1" >nul 2>&1
pause
