@echo off
chcp 65001 >nul
title ContextOS - Start Everything
set "TARGET_PROJECT=%~1"
if "%TARGET_PROJECT%"=="" set "TARGET_PROJECT=%~dp0workspace"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-all.ps1" -TargetProject "%TARGET_PROJECT%"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo ContextOS startup failed. Review the message above and logs in "%~dp0logs".
if "%EXIT_CODE%"=="0" echo ContextOS is ready. You may close this window.
pause
exit /b %EXIT_CODE%
