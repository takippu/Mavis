@echo off
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [brain-viz] Node.js not found.
  echo Install from https://nodejs.org and re-run this script.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo [brain-viz] First run - installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [brain-viz] npm install failed. See output above.
    pause
    exit /b 1
  )
)

echo [brain-viz] Building brain data...
call npm run build:data
if errorlevel 1 (
  echo [brain-viz] Parser failed. See output above.
  pause
  exit /b 1
)

echo [brain-viz] Starting dev server (browser will open)...
call npm run dev
