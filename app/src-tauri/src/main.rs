#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod debug_state;
mod debugger;

use debug_state::DebugSessionState;
use debugger::client::{BreakpointInput, DAPClient};
use serde_json::Value;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::process::Command;
use std::process::Stdio;
use std::thread;
use tauri::Emitter;

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
        let name = path
            .file_name()
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
    app_handle: tauri::AppHandle,
    script_path: String,
    debug_state: tauri::State<'_, DebugSessionState>,
) -> Result<String, String> {
    // 1. Find an available port to use for debugpy (starting at 5678)
    let debugpy_port = crate::debugger::util::find_available_port(5678)
        .map_err(|e| format!("Could not find available port: {}", e))?;

    println!("Using port {} for debugpy", debugpy_port);

    // 2. Spawn the Python process running debugpy.
    let mut child = Command::new("python")
        .args(&[
            "-Xfrozen_modules=off",
            "-u",
            "-m",
            "debugpy",
            "--listen",
            &format!("127.0.0.1:{}", debugpy_port),
            "--wait-for-client",
            &script_path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn debugpy process: {}", e))?;

    println!("Spawned debugpy process with PID: {}", child.id());

    if let Some(stdout) = child.stdout.take() {
        let app_handle_clone = app_handle.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                println!("Python stdout: {}", line);
                let _ = app_handle_clone.emit("program-output", line);
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let app_handle_clone = app_handle.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().flatten() {
                println!("Python stderr: {}", line);
                let _ = app_handle_clone.emit("program-error", line);
            }
        });
    }

    // Give debugpy time to start up.
    std::thread::sleep(std::time::Duration::from_secs(2));

    // 3. Create a new DAPClient, connect it, and start its receiver.
    let (mut dap_client, _rx) = DAPClient::new(app_handle.clone());
    dap_client
        .connect("127.0.0.1", debugpy_port as u16)
        .map_err(|e| format!("Error connecting DAPClient: {}", e))?;

    // Start the receiver loop so incoming DAP messages get handled.
    {
        // We call start_receiver() on the mutable client.
        let mut client = dap_client;
        client.start_receiver();

        // Initialize and attach.
        client
            .initialize()
            .await
            .map_err(|e| format!("Initialize failed: {}", e))?;
        client
            .attach("127.0.0.1", debugpy_port as u16)
            .await
            .map_err(|e| format!("Attach failed: {}", e))?;

        // Store the DAPClient and the Python process in debug_state.
        {
            let mut client_lock = debug_state.client.lock().await;
            client_lock.replace(client);
        }
    }

    {
        let mut proc_lock = debug_state.process.lock().await;
        proc_lock.replace(child);
    }

    app_handle
        .emit(
            "debug-status",
            serde_json::json!({"status": "Initializing"}),
        )
        .map_err(|e| e.to_string())?;

    println!("Debug session launched successfully");
    Ok("Debug session launched successfully".into())
}

#[tauri::command]
async fn set_breakpoints(
    _token: String,
    breakpoints: Vec<BreakpointInput>,
    file_path: String,
    debug_state: tauri::State<'_, DebugSessionState>,
) -> Result<Value, String> {
    println!("Setting breakpoints");
    let client_lock = debug_state.client.lock().await;
    let dap_client = client_lock.as_ref().ok_or("No active debug session")?;
    let response = dap_client
        .set_breakpoints(file_path.clone(), breakpoints)
        .await
        .map_err(|e| format!("Failed to set breakpoints: {}", e))?;
    if let Some(body) = response.body {
        Ok(body)
    } else {
        Err("No breakpoints information in response.".into())
    }
}

#[tauri::command]
async fn configuration_done(
    debug_state: tauri::State<'_, DebugSessionState>,
) -> Result<String, String> {
    let client_lock = debug_state.client.lock().await;
    if client_lock.is_none() {
        return Err("No active debug session".into());
    }
    let dap_client = client_lock.as_ref().unwrap();
    let _conf_resp = dap_client
        .configuration_done()
        .await
        .map_err(|e| format!("ConfigurationDone failed: {}", e))?;

    // Update status to Running after configurationDone is sent
    dap_client
        .app_handle
        .emit("debug-status", serde_json::json!({"status": "Running"}))
        .map_err(|e| format!("Failed to emit status update: {}", e))?;

    Ok("configurationDone sent; target program is now running.".into())
}

#[tauri::command]
async fn terminate_program() -> Result<String, String> {
    Ok("Debug session terminated".into())
}

fn main() {
    let debug_session_state = DebugSessionState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(debug_session_state)
        .invoke_handler(tauri::generate_handler![
            read_directory,
            launch_debug_session,
            set_breakpoints,
            configuration_done,
            terminate_program,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
