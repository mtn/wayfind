pub mod client;
pub mod util;

use self::util::find_available_port;
use serde::Serialize;
use std::io::BufRead;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Emitter;

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

        // Capture stdout and emit events.
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

        let app_handle_clone = app_handle.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stdout);
            for line in reader.lines().flatten() {
                println!("Stdout: {}", line);
                let _ = app_handle_clone.emit("program-output", line);
            }
        });

        let app_handle_clone = app_handle.clone();
        std::thread::spawn(move || {
            let reader = std::io::BufReader::new(stderr);
            for line in reader.lines().flatten() {
                println!("Stderr: {}", line);
                let _ = app_handle_clone.emit("program-error", line);
            }
        });

        // Store the child process.
        *self.process.lock().unwrap() = Some(child);

        // Emit initial status.
        app_handle
            .emit("debug-status", DebugStatus::Running)
            .map_err(|e| e.to_string())?;
        println!("Debug status emitted");

        // Wait briefly to give debugpy time to start.
        std::thread::sleep(std::time::Duration::from_secs(2));

        Ok(())
    }

    pub fn terminate(&self) -> Result<(), String> {
        if let Some(mut process) = self.process.lock().unwrap().take() {
            process.kill().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
