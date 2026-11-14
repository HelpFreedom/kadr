@echo off
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
    echo Electron is not installed. Run npm install first.
    pause
    exit /b 1
)

start "" "node_modules\electron\dist\electron.exe" "."
exit /b 0
