// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Arc;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

mod pty_session;
use pty_session::{
    PtySessionAttachSnapshot, PtySessionCapability, PtySessionEvent, PtySessionEventCallback,
    PtySessionManager, PtySessionRequest, PtySessionStatus, PtySessionSummary,
};

struct ServerProcess(Mutex<Option<Child>>);

const TERMINAL_SESSION_STARTED_EVENT: &str = "terminal://session-started";
const TERMINAL_OUTPUT_EVENT: &str = "terminal://output";
const TERMINAL_RESIZED_EVENT: &str = "terminal://resized";
const TERMINAL_STATUS_EVENT: &str = "terminal://status";
const TERMINAL_ENDED_EVENT: &str = "terminal://ended";

#[tauri::command]
fn pick_project_directory() -> Result<Option<String>, String> {
    pick_project_directory_native()
}

#[tauri::command]
fn terminal_portable_pty_capability(manager: State<'_, PtySessionManager>) -> PtySessionCapability {
    manager.capability()
}

#[tauri::command]
fn terminal_create_session(
    app: AppHandle,
    manager: State<'_, PtySessionManager>,
    request: PtySessionRequest,
) -> Result<PtySessionSummary, String> {
    let event_sink: PtySessionEventCallback = Arc::new(move |event| {
        emit_terminal_event(&app, event);
    });
    manager.create_session_with_events(request, Some(event_sink))
}

#[tauri::command]
fn terminal_attach_session(
    manager: State<'_, PtySessionManager>,
    session_id: String,
) -> Result<PtySessionAttachSnapshot, String> {
    manager.attach_session(&session_id)
}

#[tauri::command]
fn terminal_write(
    manager: State<'_, PtySessionManager>,
    session_id: String,
    data: String,
) -> Result<PtySessionSummary, String> {
    manager.write(&session_id, &data)
}

#[tauri::command]
fn terminal_resize(
    app: AppHandle,
    manager: State<'_, PtySessionManager>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<PtySessionSummary, String> {
    let summary = manager.resize(&session_id, cols, rows)?;
    emit_terminal_event(&app, PtySessionEvent::Resized(summary.clone()));
    emit_terminal_event(&app, PtySessionEvent::Status(summary.clone()));
    Ok(summary)
}

#[tauri::command]
fn terminal_interrupt(
    app: AppHandle,
    manager: State<'_, PtySessionManager>,
    session_id: String,
) -> Result<PtySessionSummary, String> {
    let summary = manager.interrupt(&session_id)?;
    emit_terminal_event(&app, PtySessionEvent::Status(summary.clone()));
    Ok(summary)
}

#[tauri::command]
fn terminal_close(
    app: AppHandle,
    manager: State<'_, PtySessionManager>,
    session_id: String,
) -> Result<PtySessionSummary, String> {
    let summary = manager.close_session(&session_id, PtySessionStatus::Killed, None)?;
    emit_terminal_event(&app, PtySessionEvent::Status(summary.clone()));
    emit_terminal_event(&app, PtySessionEvent::Ended(summary.clone()));
    Ok(summary)
}

#[tauri::command]
fn terminal_list(
    manager: State<'_, PtySessionManager>,
    run_id: Option<String>,
) -> Result<Vec<PtySessionSummary>, String> {
    manager.list_sessions(run_id.as_deref())
}

fn emit_terminal_event(app: &AppHandle, event: PtySessionEvent) {
    match event {
        PtySessionEvent::SessionStarted(summary) => {
            let _ = app.emit(TERMINAL_SESSION_STARTED_EVENT, summary);
        }
        PtySessionEvent::Output(output) => {
            let _ = app.emit(TERMINAL_OUTPUT_EVENT, output);
        }
        PtySessionEvent::Resized(summary) => {
            let _ = app.emit(TERMINAL_RESIZED_EVENT, summary);
        }
        PtySessionEvent::Status(summary) => {
            let _ = app.emit(TERMINAL_STATUS_EVENT, summary);
        }
        PtySessionEvent::Ended(summary) => {
            let _ = app.emit(TERMINAL_ENDED_EVENT, summary);
        }
    }
}

#[cfg(target_os = "macos")]
fn pick_project_directory_native() -> Result<Option<String>, String> {
    let output = Command::new("osascript")
        .args([
            "-e",
            r#"POSIX path of (choose folder with prompt "Open project directory")"#,
        ])
        .output()
        .map_err(|err| format!("Failed to open folder picker: {}", err))?;

    if output.status.success() {
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!selected.is_empty()).then_some(selected));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("User canceled") {
        return Ok(None);
    }
    Err(stderr.trim().to_string())
}

#[cfg(target_os = "windows")]
fn pick_project_directory_native() -> Result<Option<String>, String> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Open project directory'
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
"#;
    let output = Command::new("powershell")
        .args(["-NoProfile", "-Command", script])
        .output()
        .map_err(|err| format!("Failed to open folder picker: {}", err))?;

    if output.status.success() {
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!selected.is_empty()).then_some(selected));
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn pick_project_directory_native() -> Result<Option<String>, String> {
    let output = Command::new("zenity")
        .args([
            "--file-selection",
            "--directory",
            "--title=Open project directory",
        ])
        .output()
        .map_err(|err| format!("Failed to open folder picker: {}", err))?;

    if output.status.success() {
        let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!selected.is_empty()).then_some(selected));
    }
    Ok(None)
}

fn looks_like_project_root(path: &Path) -> bool {
    path.join("package.json").is_file() && path.join("examples").is_dir()
}

fn find_project_root_from(path: &Path) -> Option<PathBuf> {
    let mut cursor = if path.is_file() {
        path.parent()
    } else {
        Some(path)
    };

    while let Some(candidate) = cursor {
        if looks_like_project_root(candidate) {
            return Some(candidate.to_path_buf());
        }
        cursor = candidate.parent();
    }
    None
}

fn get_project_root() -> PathBuf {
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_project_root_from(&cwd) {
            return root;
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = find_project_root_from(&exe) {
            return root;
        }
    }

    std::env::current_dir().unwrap()
}

fn server_is_running(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok() || TcpStream::connect(("::1", port)).is_ok()
}

fn server_command(project_root: &Path) -> Command {
    if cfg!(windows) {
        let mut command = Command::new("cmd");
        command
            .args([
                "/c", "npm.cmd", "run", "start", "--", "--serve", "--port", "3456",
            ])
            .current_dir(project_root);
        return command;
    }

    let mut command = Command::new("npm");
    command
        .args(["run", "start", "--", "--serve", "--port", "3456"])
        .current_dir(project_root);
    command
}

fn fallback_server_command(project_root: &Path) -> Command {
    if cfg!(windows) {
        let mut command = Command::new("cmd");
        command
            .args([
                "/c",
                "node_modules\\.bin\\tsx.cmd",
                "src/index.ts",
                "--serve",
                "--port",
                "3456",
            ])
            .current_dir(project_root);
        return command;
    }

    let mut command = Command::new("node_modules/.bin/tsx");
    command
        .args(["src/index.ts", "--serve", "--port", "3456"])
        .current_dir(project_root);
    command
}

fn start_server() -> Option<Child> {
    let project_root = get_project_root();

    if server_is_running(3456) {
        println!("AgentGraph server already running on port 3456");
        return None;
    }

    println!("Starting AgentGraph server in {}", project_root.display());

    let child = server_command(&project_root).spawn();

    match child {
        Ok(c) => {
            println!("AgentGraph server started (PID: {})", c.id());
            // Give the server a moment to start
            std::thread::sleep(std::time::Duration::from_secs(3));
            Some(c)
        }
        Err(e) => {
            eprintln!("Failed to start server: {}", e);
            // Try the local tsx shim directly if npm script resolution fails.
            let fallback = fallback_server_command(&project_root).spawn();

            match fallback {
                Ok(c) => {
                    println!("Server started via fallback (PID: {})", c.id());
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    Some(c)
                }
                Err(e2) => {
                    eprintln!("Fallback also failed: {}", e2);
                    None
                }
            }
        }
    }
}

fn main() {
    let server = start_server();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(ServerProcess(Mutex::new(server)))
        .manage(PtySessionManager::default())
        .invoke_handler(tauri::generate_handler![
            pick_project_directory,
            terminal_create_session,
            terminal_attach_session,
            terminal_write,
            terminal_resize,
            terminal_interrupt,
            terminal_close,
            terminal_list,
            terminal_portable_pty_capability
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let pty_state = app.state::<PtySessionManager>();
                let _ = pty_state.shutdown_all();
                let state = app.state::<ServerProcess>();
                let mut guard = state.0.lock().unwrap();
                if let Some(ref mut child) = *guard {
                    let _ = child.kill();
                    println!("Server process terminated");
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
