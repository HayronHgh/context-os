@echo off
chcp 65001 >nul
title ContextOS
set "TARGET_PROJECT=%~1"
if "%TARGET_PROJECT%"=="" set "TARGET_PROJECT=%~dp0workspace"
node "%~dp0src\index.js" --project "%TARGET_PROJECT%"
pause
