@echo off
cd /d "%~dp0"

echo ============================================================
echo   AgentGraph - Tauri Desktop Launch
echo ============================================================
echo.

where cargo >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Rust/Cargo not found. Install from https://rustup.rs
    pause
    exit /b 1
)

REM Kill any existing server on port 3456
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3456 ^| findstr LISTENING') do (
    echo Killing existing server PID %%a...
    taskkill /f /pid %%a >nul 2>&1
)

echo Starting Tauri desktop app...
cd src-tauri
cargo tauri dev

echo.
echo Tauri closed.
pause
