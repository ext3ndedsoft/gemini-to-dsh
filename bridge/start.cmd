@echo off
rem Start the bridge in this window (Ctrl+C stops it).
rem For a detached start: start "" /b node "%~dp0bridge.js"
setlocal
set "DIR=%~dp0"
if not exist "%DIR%bridge.js" (
  echo bridge.js not found next to this script.
  exit /b 1
)
node "%DIR%bridge.js"