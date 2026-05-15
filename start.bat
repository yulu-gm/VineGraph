@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "PORT=3456"
set "LOG_DIR=%CD%\.agentgraph"
set "SERVER_LOG=%LOG_DIR%\agentgraph-server.log"

echo ============================================================
echo   AgentGraph - One-Click Launch
echo ============================================================
echo.

if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm.cmd not found
    pause
    exit /b 1
)

call :stop_existing_server

echo [1/3] Starting AgentGraph server...
start "AgentGraph-Server" cmd /c "npm.cmd run start -- --serve --port %PORT% > %SERVER_LOG% 2>&1"

echo [2/3] Waiting for graph API...
call :wait_for_server || goto fail

echo [3/3] Opening browser UI...
start http://localhost:%PORT%

echo.
echo ============================================================
echo   AgentGraph is running!
echo   Browser: http://localhost:%PORT%
echo   Server log: %SERVER_LOG%
echo ============================================================
echo.
pause
exit /b 0

:wait_for_server
for /l %%i in (1,1,30) do (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:%PORT%/api/graphs -TimeoutSec 1; if ($r.StatusCode -eq 200 -and $r.Content -match 'project-task-loop') { exit 0 } } catch {}; exit 1" >nul 2>&1
    if not errorlevel 1 exit /b 0
    timeout /t 1 /nobreak >nul
)
echo [ERROR] AgentGraph server did not become ready. See %SERVER_LOG%.
exit /b 1

:stop_existing_server
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
    echo Stopping existing server PID %%a on port %PORT%...
    taskkill /f /pid %%a >nul 2>&1
)
exit /b 0

:fail
echo.
echo Launch failed.
pause
exit /b 1
