@echo off
chcp 65001 >nul
title ContextOS - Stop Everything

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-all.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo One or more managed processes could not be stopped cleanly.
if "%EXIT_CODE%"=="0" echo All managed ContextOS processes are stopped.
pause
exit /b %EXIT_CODE%
