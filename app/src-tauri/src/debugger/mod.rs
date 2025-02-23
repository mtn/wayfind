use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;

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

    pub fn launch_python(
        &self,
        app_handle: tauri::AppHandle,
        script_path: &str,
    ) -> Result<(), String> {
        let mut child = Command::new("python")
            .args(&[
                "-u", // Unbuffered output
                script_path,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

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
        let app_handle_clone = app_handle.clone();
        let process = self.process.lock().unwrap().as_mut().unwrap().id();
        std::thread::spawn(move || {
            let mut status = Command::new("ps")
                .arg("-p")
                .arg(process.to_string())
                .stdout(std::process::Stdio::null())
                .status();

            while status.is_ok() {
                std::thread::sleep(std::time::Duration::from_millis(100));
                status = Command::new("ps")
                    .arg("-p")
                    .arg(process.to_string())
                    .stdout(std::process::Stdio::null())
                    .status();
            }

            let _ = app_handle_clone.emit("debug-status", DebugStatus::Terminated);
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
