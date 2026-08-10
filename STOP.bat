@echo off
setlocal
chcp 65001 >nul
title ContextOS - Stop llama.cpp + MCP

echo Stopping llama.cpp, its ContextOS MCP child, and the Host Context Bridge...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-server.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-bridge.ps1"
if errorlevel 1 set "EXIT_CODE=%ERRORLEVEL%"

echo.
pause
exit /b %EXIT_CODE%
