@echo off
setlocal
set SCRIPT_DIR=%~dp0
cd /d "%SCRIPT_DIR%"
for %%I in ("%SCRIPT_DIR%..") do set ROOT_DIR=%%~fI

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 24 LTS and reopen this terminal.
  exit /b 1
)

if "%PYTHON_BIN%"=="" set PYTHON_BIN=%ROOT_DIR%\.venv\Scripts\python.exe
if not exist "%PYTHON_BIN%" (
  echo Python environment was not found at "%PYTHON_BIN%".
  echo Create it with: py -3.11 -m venv .venv
  exit /b 1
)

if "%DINOV2_MODEL_PATH%"=="" set DINOV2_MODEL_PATH=%ROOT_DIR%\backend\dinov2_triplet_v2_best.pt
if "%MPLCONFIGDIR%"=="" set MPLCONFIGDIR=%ROOT_DIR%\data\matplotlib

echo Starting Vacapay backend on http://localhost:3000
node src\server.js
