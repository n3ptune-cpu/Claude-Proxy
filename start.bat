@echo off
title Claude local
cd /d \Path\To\claude-proxy

lms server start
start "LM Studio log" cmd /k lms log stream
start /b "" powershell -NoProfile -ExecutionPolicy Bypass -File Caffeinate.ps1
start /b "" node router.js

echo.
echo Running. Press any key in this window to shut everything down.
pause >nul

powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'router\.js|Caffeinate\.ps1|log\sstream' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
lms unload --all
lms server stop