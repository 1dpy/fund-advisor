@echo off
setlocal
cd /d "%~dp0"
start "" /min cmd /c "node dashboard_server.js"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8787"
endlocal
