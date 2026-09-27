@echo off
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Virtual environment not found: .venv\Scripts\python.exe
    echo Create it first with: py -m venv .venv
    exit /b 1
)

where ngrok >nul 2>&1
if errorlevel 1 (
    echo ngrok is not installed or not on PATH.
    echo Install ngrok and run this script again.
    exit /b 1
)

start "Resume AI Backend" cmd /k ".venv\Scripts\python.exe -m uvicorn resumeanalyser:app --host 0.0.0.0 --port 8000"

timeout /t 3 >nul

start "Ngrok Tunnel" cmd /k "ngrok http 8000"

echo.
echo Backend started on: http://localhost:8000
echo Health check: http://localhost:8000/api/health
echo.
echo Wait a few seconds for ngrok to initialize.
echo Then open the public https://...ngrok-free.app URL shown in the ngrok window.
echo.
