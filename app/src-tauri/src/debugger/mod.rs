use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
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
        println!("Launching Python script: {}", script_path);

        let mut child = Command::new("python")
            .args(&[
                "-u", // Unbuffered output
                script_path,
            ])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;

        println!("Python process started"); // Debug log

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
        let app_handle_clone = app_handle.clone();
        let process = self.process.lock().unwrap().as_mut().unwrap().id();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(100));

                let status = Command::new("ps")
                    .arg("-p")
                    .arg(process.to_string())
                    .stdout(std::process::Stdio::null())
                    .status();

                match status {
                    Ok(exit_status) if !exit_status.success() => {
                        // Process has terminated
                        println!("Python process terminated"); // Debug log
                        let _ = app_handle_clone.emit("debug-status", DebugStatus::Terminated);
                        break;
                    }
                    Err(_) => {
                        // Process not found
                        println!("Python process not found"); // Debug log
                        let _ = app_handle_clone.emit("debug-status", DebugStatus::Terminated);
                        break;
                    }
                    _ => {} // Process still running
                }
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
