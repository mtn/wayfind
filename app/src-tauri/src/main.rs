#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod debug_state;
mod debugger;

use debug_state::DebugSessionState;
use debugger::client::{emit_status_update, BreakpointInput, DAPClient};
use serde_json::Value;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::thread;
use tauri::Emitter;

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    content: Option<String>,
    is_dir: bool,
}

#[derive(serde::Serialize)]
struct FrameInfo {
    id: i64,
    name: String,
    line: i64,
    column: Option<i64>,
    file: Option<String>,
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
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
) -> Result<String, String> {
    // 1. Find an available port to use for debugpy (starting at 5679)
    let debugpy_port = crate::debugger::util::find_available_port(5678)
        .map_err(|e| format!("Could not find available port: {}", e))?;

    println!("Using port {} for debugpy", debugpy_port);

    // 2. Spawn the Python process running debugpy.
    // TODO need to not hardcode this :)
    let mut child = Command::new("/Users/mtn/.pyenv/versions/dbg/bin/python")
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
    let (mut dap_client, _rx) = DAPClient::new(app_handle.clone(), Arc::clone(&*debug_state));
    dap_client
        .connect("127.0.0.1", debugpy_port as u16)
        .map_err(|e| format!("Error connecting DAPClient: {}", e))?;

    // Get a clone of the status_seq counter for the receiver thread
    let status_seq = Arc::clone(&debug_state.status_seq);

    // Start the receiver loop so incoming DAP messages get handled.
    {
        // We call start_receiver() on the mutable client.
        let mut client = dap_client;
        // Pass the status_seq to start_receiver
        client.start_receiver(Some(status_seq));

        // Initialize and attach.
        client
            .initialize()
            .await
            .map_err(|e| format!("Initialize failed: {}", e))?;
        client
            .attach("127.0.0.1", debugpy_port as u16)
            .await
            .map_err(|e| format!("Attach failed: {}", e))?;

        // Store the DAPClient in debug_state.
        {
            let mut client_lock = debug_state.client.lock().await;
            client_lock.replace(client);
        }
    }

    {
        let mut proc_lock = debug_state.process.lock().await;
        proc_lock.replace(child);
    }

    // Emit an initializing status (to be updated by canonical events later)
    emit_status_update(&app_handle, &debug_state.status_seq, "initializing", None)?;
    println!("Debug session launched successfully");
    Ok("Debug session launched successfully".into())
}

#[tauri::command]
async fn set_breakpoints(
    breakpoints: Vec<BreakpointInput>,
    file_path: String,
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
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
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
) -> Result<String, String> {
    let client_lock = debug_state.client.lock().await;
    if client_lock.is_none() {
        return Err("No active debug session".into());
    }
    let dap_client = client_lock.as_ref().unwrap();
    dap_client
        .configuration_done()
        .await
        .map_err(|e| format!("ConfigurationDone failed: {}", e))?;
    // Use the canonical state update for configurationDone
    debug_state.handle_configuration_done();
    Ok("configurationDone sent; target program is now running.".into())
}

#[tauri::command]
async fn get_paused_location(
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
    thread_id: i64,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let client_lock = debug_state.client.lock().await;
    let dap_client = client_lock.as_ref().ok_or("No active debug session")?;
    match dap_client.stack_trace(thread_id).await {
        Ok(stack_resp) => {
            if let Some(stack_body) = stack_resp.body {
                if let Some(frames) = stack_body.get("stackFrames").and_then(|sf| sf.as_array()) {
                    if let Some(frame) = frames.first() {
                        // Extract source file and line
                        let source = frame.get("source");
                        let line = frame.get("line").and_then(|l| l.as_i64());
                        if let (Some(source), Some(line)) = (source, line) {
                            let file_path = source.get("path").and_then(|p| p.as_str());
                            if let Some(file_path) = file_path {
                                // Emit the debug location event with file and line info
                                let _ = app_handle.emit(
                                    "debug-location",
                                    serde_json::json!({
                                        "file": file_path,
                                        "line": line
                                    }),
                                );
                                println!(
                                    "Emitted debug-location event: file={}, line={}",
                                    file_path, line
                                );
                            }
                        }
                    }
                }
            }
            Ok(())
        }
        Err(e) => Err(format!("Error getting stack trace: {}", e)),
    }
}

#[tauri::command]
async fn continue_debug(
    thread_id: i64,
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
) -> Result<String, String> {
    let client_lock = debug_state.client.lock().await;
    let dap_client = client_lock.as_ref().ok_or("No active debug session")?;
    match dap_client.continue_execution(thread_id).await {
        Ok(_) => {
            // Do not manually emit "running" status; canonical events will update the state.
            Ok("Execution continued".into())
        }
        Err(e) => Err(format!("Failed to continue execution: {}", e)),
    }
}

#[tauri::command]
async fn step_in(
    thread_id: i64,
    granularity: Option<String>,
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
) -> Result<String, String> {
    let client_lock = debug_state.client.lock().await;
    let dap_client = client_lock.as_ref().ok_or("No active debug session")?;
    match dap_client.step_in(thread_id, granularity.as_deref()).await {
        Ok(_) => {
            // Do not manually emit "running" status; canonical events will update the state.
            Ok("Step in executed".into())
        }
        Err(e) => Err(format!("Failed to step in: {}", e)),
    }
}

#[tauri::command]
async fn step_over(
    thread_id: i64,
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
) -> Result<String, String> {
    let client_lock = debug_state.client.lock().await;
    let dap_client = client_lock.as_ref().ok_or("No active debug session")?;

    match dap_client.next(thread_id).await {
        Ok(_) => {
            // Status updates will be handled by the events system
            Ok("Step over executed".into())
        }
        Err(e) => Err(format!("Failed to step over: {}", e)),
    }
}

#[tauri::command]
async fn step_out(
    thread_id: i64,
    granularity: Option<String>,
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
) -> Result<String, String> {
    let client_lock = debug_state.client.lock().await;
    let dap_client = client_lock.as_ref().ok_or("No active debug session")?;
    match dap_client.step_out(thread_id, granularity.as_deref()).await {
        Ok(_) => {
            // Do not manually emit "running" status; canonical events will update the state.
            Ok("Step out executed".into())
        }
        Err(e) => Err(format!("Failed to step out: {}", e)),
    }
}

#[tauri::command]
async fn evaluate_expression(
    expression: String,
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
) -> Result<String, String> {
    // Get the DAP client
    let client_lock = debug_state.client.lock().await;
    let dap_client = client_lock.as_ref().ok_or("No active debug session")?;

    // Instead of needing the current state, simply hardcode the threadId as 1.
    // TODO get rid of this hardcoding
    // Also, we ask the DAP client for a stack trace so we can extract a frame id.
    let frame_id = match dap_client.stack_trace(1).await {
        Ok(st_resp) => {
            if let Some(body) = st_resp.body {
                if let Some(stack_frames) = body.get("stackFrames").and_then(|sf| sf.as_array()) {
                    if let Some(first_frame) = stack_frames.first() {
                        // Extract the frame id
                        first_frame
                            .get("id")
                            .and_then(|v| v.as_i64())
                            .map(|id| id as i32)
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            }
        }
        Err(e) => {
            println!("Failed to get stack trace: {}", e);
            None
        }
    };

    // Now call the evaluate command, passing in the frame id (if we obtained one)
    let eval_resp = dap_client
        .evaluate(&expression, frame_id)
        .await
        .map_err(|e| format!("Failed to evaluate expression: {}", e))?;

    if let Some(body) = eval_resp.body {
        if let Some(result_val) = body.get("result") {
            return Ok(result_val.to_string());
        }
    }
    Err("No result returned from evaluate".into())
}

#[tauri::command]
async fn get_call_stack(
    thread_id: i64,
    debug_state: tauri::State<'_, std::sync::Arc<DebugSessionState>>,
) -> Result<Vec<FrameInfo>, String> {
    // Grab the DAP client
    let client_lock = debug_state.client.lock().await;
    let dap_client = client_lock.as_ref().ok_or("No active debug session")?;

    // Issue the stackTrace request
    let resp = dap_client
        .stack_trace(thread_id)
        .await
        .map_err(|e| format!("stack_trace request failed: {e}"))?;

    // The response body should have something like { "stackFrames": [ { "id": ..., "name": ..., "line": ..., "column": ..., "source": {...} }, ... ] }
    if let Some(body) = resp.body {
        let frames = body
            .get("stackFrames")
            .and_then(|val| val.as_array())
            .unwrap_or(&vec![])
            .iter()
            .map(|f| {
                // Extract fields
                let id = f.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                let name = f
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<unknown>")
                    .to_string();
                let line = f.get("line").and_then(|v| v.as_i64()).unwrap_or(0);
                let column = f.get("column").and_then(|v| v.as_i64());
                let file = f
                    .get("source")
                    .and_then(|src| src.get("path"))
                    .and_then(|p| p.as_str())
                    .map(String::from);

                FrameInfo {
                    id,
                    name,
                    line,
                    column,
                    file,
                }
            })
            .collect::<Vec<FrameInfo>>();

        Ok(frames)
    } else {
        Err("No stackFrames in the response".to_owned())
    }
}

#[tauri::command]
async fn terminate_program(
    debug_state: tauri::State<'_, Arc<DebugSessionState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let client_lock = debug_state.client.lock().await;

    if let Some(client) = client_lock.as_ref() {
        // Send the terminate request
        // Note: We're properly handling the error here by converting it to a String
        match client.terminate().await {
            Ok(_) => {
                println!("Terminate request sent successfully");
            }
            Err(e) => {
                // Convert the boxed error to a String right away
                let error_str = e.to_string();
                println!("Error sending terminate request: {}", error_str);

                // Emit terminated status in case of error
                emit_status_update(&app_handle, &debug_state.status_seq, "terminated", None)?;

                // Try to kill the process directly
                // We need to drop the client_lock before acquiring process_lock to avoid deadlock
            }
        }
    } else {
        // No active debug session, just emit terminated status
        emit_status_update(&app_handle, &debug_state.status_seq, "terminated", None)?;
    }

    // After we're done with client_lock, it's safe to acquire process_lock
    let mut proc_lock = debug_state.process.lock().await;
    if let Some(child) = proc_lock.as_mut() {
        let _ = child.kill();
    }
    *proc_lock = None;

    Ok("Debug session terminated".into())
}

fn main() {
    let debug_session_state = Arc::new(DebugSessionState::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(debug_session_state)
        .invoke_handler(tauri::generate_handler![
            read_directory,
            launch_debug_session,
            set_breakpoints,
            configuration_done,
            get_paused_location,
            continue_debug,
            step_in,
            step_over,
            step_out,
            evaluate_expression,
            get_call_stack,
            terminate_program,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
