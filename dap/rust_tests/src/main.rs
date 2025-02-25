mod dap_client;

use crate::dap_client::DAPClient;
use std::path::Path;
use std::process::{Command, Stdio};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Starting DAP test...");

    // Path to the Python script to run.
    let script_path = Path::new("../test_data/a.py")
        .canonicalize()
        .expect("Failed to get absolute path to script");
    let script_path_str = script_path.to_str().unwrap();
    let debugpy_port = 5678;

    // Launch Python with debugpy.
    let child = Command::new("python")
        .args(&[
            "-Xfrozen_modules=off",
            "-m",
            "debugpy",
            "--listen",
            &format!("127.0.0.1:{}", debugpy_port),
            "--wait-for-client",
            script_path_str,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("Failed to spawn debugpy process");

    println!("Launched Python process with PID: {}", child.id());

    // Give debugpy a moment to start.
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // Create and connect the DAP client.
    let mut client = DAPClient::new();
    client
        .connect("127.0.0.1", debugpy_port)
        .expect("Failed to connect");
    client.start_receiver();

    // Initialize.
    let init_response = client.initialize().await.expect("Failed to initialize");
    println!("Initialize response: {:?}", init_response);

    // Attach.
    client
        .attach("127.0.0.1", debugpy_port)
        .expect("Failed to send attach");

    // Wait for the 'initialized' event.
    if let Some(initialized) = client.wait_for_event("initialized", 10.0) {
        println!("Received initialized event: {:?}", initialized);
    } else {
        println!("Timed out waiting for 'initialized' event");
        return Err("No initialized event received".into());
    }

    let breakpoint_line = 25;
    let bp_response = client
        .set_breakpoints(script_path_str, &[breakpoint_line])
        .await
        .expect("Failed to set breakpoint");
    println!("Breakpoint response: {:?}", bp_response);

    // Configuration Done.
    let conf_response = client
        .configuration_done()
        .await
        .expect("Failed to send configurationDone");
    println!("ConfigurationDone response: {:?}", conf_response);

    // Wait for the 'stopped' event that indicates hitting the breakpoint.
    if let Some(stopped) = client.wait_for_event("stopped", 15.0) {
        println!("Received stopped event: {:?}", stopped);

        // Get the thread ID from the stopped event
        let thread_id = if let Some(body) = &stopped.body {
            if let Some(tid) = body.get("threadId") {
                tid.as_i64().unwrap_or(1) as i32
            } else {
                1
            }
        } else {
            1
        };

        println!("Using thread ID: {}", thread_id);

        // Get the stack trace to obtain a frame ID
        let stack_trace_response = client.stack_trace(thread_id).await?;
        println!("Stack trace response: {:?}", stack_trace_response);

        // Extract the frame ID from the response
        let frame_id = if let Some(body) = &stack_trace_response.body {
            if let Some(frames) = body.get("stackFrames") {
                if let Some(frame) = frames.as_array().and_then(|arr| arr.get(0)) {
                    frame
                        .get("id")
                        .and_then(|id| id.as_i64())
                        .map(|id| id as i32)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        println!("Using frame ID: {:?}", frame_id);

        if let Some(id) = frame_id {
            let eval_response = client.evaluate("fib_series", Some(id)).await?;
            println!("Evaluate response: {:?}", eval_response);

            // Extract the value from the response
            if let Some(body) = &eval_response.body {
                if let Some(result) = body.get("result") {
                    println!("Value of fib_series at breakpoint: {}", result);
                }
            }
        }

        // Continue execution
        let continue_response = client.continue_execution(thread_id).await?;
        println!("Continue response: {:?}", continue_response);

        // Try to process any additional stops by continuing
        loop {
            if let Some(additional_stop) = client.wait_for_event("stopped", 1.0) {
                println!("Additional stopped event: {:?}", additional_stop);

                let stop_thread_id = if let Some(body) = &additional_stop.body {
                    if let Some(tid) = body.get("threadId") {
                        tid.as_i64().unwrap_or(1) as i32
                    } else {
                        1
                    }
                } else {
                    1
                };

                let extra_continue = client.continue_execution(stop_thread_id).await?;
                println!("Extra continue response: {:?}", extra_continue);
            } else {
                break;
            }
        }
    } else {
        println!("Timed out waiting for 'stopped' event");
    }

    // Wait for the program to finish (by looking for a 'terminated' event).
    if let Some(term_evt) = client.wait_for_event("terminated", 10.0) {
        println!("Received terminated event: {:?}", term_evt);
    } else {
        println!("Timed out waiting for 'terminated' event, assuming program finished");
    }

    Ok(())
}
