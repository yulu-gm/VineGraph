@echo off
cd /d "%~dp0"

echo ============================================================
echo   AgentGraph - One-Click Launch
echo ============================================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

echo [1/2] Starting AgentGraph server...
start "AgentGraph-Server" cmd /c "npx tsx src/index.ts --serve --port 3456"

echo [2/2] Waiting for server...
timeout /t 3 /nobreak >nul

start http://localhost:3456

echo.
echo ============================================================
echo   AgentGraph is running!
echo   Browser: http://localhost:3456
echo   Close the "AgentGraph-Server" window to stop
echo ============================================================
echo.
pause
