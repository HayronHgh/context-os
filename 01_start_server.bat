@echo off
chcp 65001 >nul
title ContextOS llama-server
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-server.ps1"
pause
