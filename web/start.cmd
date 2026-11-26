@echo off
setlocal
node --version >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install Node.js and run start.cmd again.
  goto :failed
)
node "%~dp0transport.mjs" --authorize --open
if errorlevel 1 goto :failed
node "%~dp0server.mjs" --open
if not errorlevel 1 exit /b 0
:failed
pause
exit /b 1
