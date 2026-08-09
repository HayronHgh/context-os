@echo off
chcp 65001 >nul
title ContextOS Web Gateway
set "TARGET_PROJECT=%~1"
if "%TARGET_PROJECT%"=="" set "TARGET_PROJECT=%~dp0workspace"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-gateway.ps1" -TargetProject "%TARGET_PROJECT%"
pause
