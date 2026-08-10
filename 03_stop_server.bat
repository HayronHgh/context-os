@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-server.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-bridge.ps1"
pause
