// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod debugger;

use std::fs;
use debugger::{DAPClient, SessionManager};
use std::sync::Arc;

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    content: Option<String>,
    is_dir: bool,
}

#[tauri::command]
async fn read_directory(path: String) -> Result<Vec<FileEntry>, String> {
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut files = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let is_dir = path.is_dir();
        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let content = if !is_dir {
            fs::read_to_string(&path).ok()
        } else {
            None
        };

        files.push(FileEntry {
            name,
            path: path.to_string_lossy().to_string(),
            content,
            is_dir,
        });
    }

    Ok(files)
}

#[tauri::command]
async fn launch_debug_session(
    session_manager: tauri::State<'_, Arc<SessionManager>>,
) -> Result<String, String> {
    // Implementation here
    Ok("token".to_string())
}

#[tauri::command]
async fn set_breakpoint(
    token: String,
    line: u32,
    file: String,
    session_manager: tauri::State<'_, Arc<SessionManager>>,
) -> Result<(), String> {
    // Implementation here
    Ok(())
}

fn main() {
    let session_manager = Arc::new(SessionManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(session_manager)
        .invoke_handler(tauri::generate_handler![
            read_directory,
            launch_debug_session,
            set_breakpoint,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
