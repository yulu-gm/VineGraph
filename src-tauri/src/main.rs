// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct ServerProcess(Mutex<Option<Child>>);

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
    TcpStream::connect(("127.0.0.1", port)).is_ok()
        || TcpStream::connect(("::1", port)).is_ok()
}

fn start_server() -> Option<Child> {
    let project_root = get_project_root();

    if server_is_running(3456) {
        println!("AgentGraph server already running on port 3456");
        return None;
    }

    println!(
        "Starting AgentGraph server in {}",
        project_root.display()
    );

    let child = Command::new("cmd")
        .args([
            "/c",
            "npm.cmd",
            "run",
            "start",
            "--",
            "--serve",
            "--port",
            "3456",
        ])
        .current_dir(&project_root)
        .spawn();

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
            let fallback = Command::new("cmd")
                .args([
                    "/c",
                    "node_modules\\.bin\\tsx.cmd",
                    "src/index.ts",
                    "--serve",
                    "--port",
                    "3456",
                ])
                .current_dir(&project_root)
                .spawn();

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
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
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
