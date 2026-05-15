@echo off
setlocal EnableExtensions

cd /d "%~dp0"
set "ROOT=%CD%"
set "PORT=3456"
set "LOG_DIR=%ROOT%\.agentgraph"
set "SERVER_LOG=%LOG_DIR%\agentgraph-server.log"
set "CARGO_EXE=cargo.exe"

echo ============================================================
echo   AgentGraph - Tauri Desktop Launch
echo ============================================================
echo.

call :refresh_path
call :load_local_env
call :ensure_node || goto fail
call :ensure_windows_build_tools || goto fail
call :ensure_rust || goto fail
call :install_project_deps || goto fail
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
call :stop_existing_desktop_app
call :stop_existing_server
call :clear_webview_cache
call :build_tauri_debug || goto fail
call :start_server || goto fail

echo Starting Tauri desktop app...
start /wait "AgentGraph" "%ROOT%\src-tauri\target\debug\agentgraph.exe"
set "EXIT_CODE=%ERRORLEVEL%"
call :stop_existing_server

echo.
if not "%EXIT_CODE%"=="0" (
    echo Tauri exited with code %EXIT_CODE%.
) else (
    echo Tauri closed.
)
pause
exit /b %EXIT_CODE%

:ensure_node
where node.exe >nul 2>&1
if errorlevel 1 goto install_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto install_node
exit /b 0

:install_node
echo Node.js was not found. Installing Node.js LTS with winget...
where winget.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] winget is required to install Node.js automatically.
    exit /b 1
)
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 exit /b 1
call :refresh_path
where node.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js installed but is still not visible in PATH. Open a new terminal and run this script again.
    exit /b 1
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm.cmd is still not visible in PATH. Open a new terminal and run this script again.
    exit /b 1
)
exit /b 0

:ensure_rust
where cargo.exe >nul 2>&1
if not errorlevel 1 (
    set "CARGO_EXE=cargo.exe"
    exit /b 0
)
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "CARGO_EXE=%USERPROFILE%\.cargo\bin\cargo.exe"
    exit /b 0
)

echo Rust/Cargo was not found. Installing Rustup with winget...
where rustup.exe >nul 2>&1
if errorlevel 1 (
    where winget.exe >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] winget is required to install Rust automatically.
        exit /b 1
    )
    winget install --id Rustlang.Rustup -e --accept-package-agreements --accept-source-agreements
    if errorlevel 1 exit /b 1
    call :refresh_path
)

rustup default stable-msvc
if errorlevel 1 exit /b 1
call :refresh_path
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    set "CARGO_EXE=%USERPROFILE%\.cargo\bin\cargo.exe"
    exit /b 0
)
where cargo.exe >nul 2>&1
if not errorlevel 1 (
    set "CARGO_EXE=cargo.exe"
    exit /b 0
) else (
    echo [ERROR] Cargo is still not visible in PATH. Open a new terminal and run this script again.
    exit /b 1
)

:ensure_windows_build_tools
if not "%OS%"=="Windows_NT" exit /b 0
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "%VSWHERE%" (
    for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do (
        if not "%%i"=="" exit /b 0
    )
)

echo Microsoft C++ Build Tools were not found. Installing Visual Studio Build Tools with winget...
where winget.exe >nul 2>&1
if errorlevel 1 (
    echo [ERROR] winget is required to install Microsoft C++ Build Tools automatically.
    exit /b 1
)
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-package-agreements --accept-source-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
if errorlevel 1 exit /b 1
exit /b 0

:install_project_deps
echo Installing project dependencies...
call npm.cmd install
if errorlevel 1 exit /b 1

if not exist "node_modules\.bin\tauri.cmd" (
    echo [ERROR] Local Tauri CLI was not installed at node_modules\.bin\tauri.cmd.
    exit /b 1
)
exit /b 0

:build_tauri_debug
echo Building stable Tauri desktop client...
pushd "%ROOT%\src-tauri"
"%CARGO_EXE%" build
set "BUILD_EXIT=%ERRORLEVEL%"
popd
if not "%BUILD_EXIT%"=="0" exit /b %BUILD_EXIT%
if not exist "%ROOT%\src-tauri\target\debug\agentgraph.exe" (
    echo [ERROR] Expected Tauri executable was not built: %ROOT%\src-tauri\target\debug\agentgraph.exe
    exit /b 1
)
exit /b 0

:start_server
echo Starting AgentGraph server in the background...
echo Server log: %SERVER_LOG%
start "AgentGraph-Server" /min cmd /c "npm.cmd run start -- --serve --port %PORT% > %SERVER_LOG% 2>&1"
call :wait_for_server
exit /b %ERRORLEVEL%

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

:stop_existing_desktop_app
taskkill /f /im agentgraph.exe >nul 2>&1
exit /b 0

:clear_webview_cache
set "WEBVIEW_CACHE=%LOCALAPPDATA%\com.agentgraph.app\EBWebView"
if exist "%WEBVIEW_CACHE%" (
    echo Clearing cached desktop UI assets...
    rmdir /s /q "%WEBVIEW_CACHE%" >nul 2>&1
)
exit /b 0

:refresh_path
set "PATH=%ProgramFiles%\nodejs;%USERPROFILE%\.cargo\bin;%APPDATA%\npm;%PATH%"
exit /b 0

:load_local_env
call :load_env_file ".env"
call :load_env_file ".env.local"
if defined DEEPSEEK_API_KEY echo DeepSeek API key loaded.
exit /b 0

:load_env_file
if not exist "%~1" exit /b 0
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~1") do (
    if not "%%a"=="" set "%%a=%%b"
)
exit /b 0

:fail
echo.
echo Launch failed.
pause
exit /b 1
