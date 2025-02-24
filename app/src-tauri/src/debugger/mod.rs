mod async_listener;
mod util;

use self::async_listener::async_listen_debugpy;
use self::util::find_available_port;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Emitter;
use tokio::spawn;

#[derive(Debug, Serialize, Clone)]
pub enum DebugStatus {
    Starting,
    Running,
    Terminated,
    Error(String),
}

pub struct DebugManager {
    process: Mutex<Option<Child>>,
}

impl DebugManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
        }
    }

    pub fn launch_debugpy(
        &self,
        app_handle: tauri::AppHandle,
        script_path: &str,
    ) -> Result<(), String> {
        // Find an available port for debugpy to listen on (starting at 5678)
        let debugpy_port = find_available_port(5678).map_err(|e| e.to_string())?;
        println!(
            "Launching debugpy for script: {} on port: {}",
            script_path, debugpy_port
        );

        let mut child = Command::new("python")
            .args(&[
                "-Xfrozen_modules=off",
                "-u", // Unbuffered output
                "-m",
                "debugpy",
                "--listen",
                &format!("127.0.0.1:{}", debugpy_port),
                "--wait-for-client",
                script_path,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

        println!("Debugpy process started with PID: {}", child.id());

        // Get stdout handle
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;

        // Get stderr handle
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

        let app_handle_clone = app_handle.clone();
        // Spawn stdout reading thread
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("Stdout: {}", line); // Debug log
                    let _ = app_handle_clone.emit("program-output", line);
                }
            }
        });

        let app_handle_clone = app_handle.clone();
        // Spawn stderr reading thread
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(line) = line {
                    println!("Stderr: {}", line); // Debug log
                    let _ = app_handle_clone.emit("program-error", line);
                }
            }
        });

        // Store the child process
        *self.process.lock().unwrap() = Some(child);

        // Emit initial status
        app_handle
            .emit("debug-status", DebugStatus::Running)
            .map_err(|e| e.to_string())?;

        // Spawn a thread to monitor the process
        // let app_handle_clone = app_handle.clone();
        // let process = self.process.lock().unwrap().as_mut().unwrap().id();
        // std::thread::spawn(move || {
        //     loop {
        //         std::thread::sleep(std::time::Duration::from_millis(100));

        //         let status = Command::new("ps")
        //             .arg("-p")
        //             .arg(process.to_string())
        //             .stdout(std::process::Stdio::null())
        //             .status();

        //         match status {
        //             Ok(exit_status) if !exit_status.success() => {
        //                 // Process has terminated
        //                 println!("Debugpy process terminated"); // Debug log
        //                 let _ = app_handle_clone.emit("debug-status", DebugStatus::Terminated);
        //                 break;
        //             }
        //             Err(_) => {
        //                 // Process not found
        //                 println!("Debugpy process not found"); // Debug log
        //                 let _ = app_handle_clone.emit("debug-status", DebugStatus::Terminated);
        //                 break;
        //             }
        //             _ => {
        //                 println!("Debugpy seems to be running");
        //             }
        //         }
        //     }
        // });

        std::thread::sleep(std::time::Duration::from_secs(2));

        // Spawn an asynchronous listener to receive messages from debugpy.
        let addr = format!("127.0.0.1:{}", debugpy_port);
        spawn(async move {
            if let Err(e) = async_listen_debugpy(&addr).await {
                eprintln!("Error in asynchronous debugpy listener: {}", e);
            }
        });

        Ok(())
    }

    pub fn terminate(&self) -> Result<(), String> {
        if let Some(mut process) = self.process.lock().unwrap().take() {
            process.kill().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
