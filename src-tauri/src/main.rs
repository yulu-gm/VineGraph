// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct ServerProcess(Mutex<Option<Child>>);

fn get_project_root() -> std::path::PathBuf {
    // During development, CWD is src-tauri/, so go up one level
    let cwd = std::env::current_dir().unwrap();
    if cwd.ends_with("src-tauri") {
        cwd.parent().unwrap().to_path_buf()
    } else {
        cwd
    }
}

fn find_node() -> String {
    // Try common locations
    let candidates = [
        "node",
        "C:/Program Files/nodejs/node.exe",
    ];
    for c in &candidates {
        if std::process::Command::new(c)
            .arg("--version")
            .output()
            .is_ok()
        {
            return c.to_string();
        }
    }
    "node".to_string()
}

fn start_server() -> Option<Child> {
    let project_root = get_project_root();
    let node = find_node();

    println!(
        "Starting AgentGraph server in {}",
        project_root.display()
    );

    let child = Command::new("cmd")
        .args([
            "/c",
            &node,
            "C:/Program Files/nodejs/node_modules/npm/bin/npx-cli.js",
            "--yes",
            "tsx",
            "src/index.ts",
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
            // Try fallback with tsx directly
            let fallback = Command::new("cmd")
                .args([
                    "/c",
                    &node,
                    "--import",
                    "tsx",
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
