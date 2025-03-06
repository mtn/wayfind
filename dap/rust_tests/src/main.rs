mod dap_client;

use crate::dap_client::DAPClient;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Starting DAP test...");

    // Step 1: Launch target script with debugpy
    let debugpy_port = 5678;
    let script_path = Path::new("../test_data/python/a.py")
        .canonicalize()
        .expect("Failed to get absolute path to script");
    let script_path_str = script_path.to_str().unwrap();

    // Start capturing output from the target script
    let child = Command::new("python")
        .args(&[
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

    // Give debugpy a moment to start up
    tokio::time::sleep(Duration::from_secs(1)).await;

    // Step 2: Connect to debugpy
    let mut client = DAPClient::new();
    client
        .connect("127.0.0.1", debugpy_port)
        .expect("Failed to connect");
    client.start_receiver();
    println!("Connected to debugpy.");

    // Step 3: Send initialize request
    let init_response = client.initialize().await.expect("Failed to initialize");
    println!("Received initialize response: {:?}", init_response);

    // Step 4: Send attach request
    client
        .attach("127.0.0.1", debugpy_port)
        .expect("Failed to send attach");

    // Wait for the 'initialized' event
    if let Some(_) = client.wait_for_event("initialized", 10.0) {
        println!("Initialization complete");
    } else {
        println!("Timed out waiting for 'initialized' event");
        return Err("No initialized event received".into());
    }

    let breakpoint_line = 25;
    let bp_response = client
        .set_breakpoints(script_path_str, &[breakpoint_line])
        .await
        .expect("Failed to set breakpoint");
    println!("Breakpoints response: {:?}", bp_response);

    if bp_response.success != Some(true) {
        println!("Error setting breakpoints");
        return Err("Failed to set breakpoints".into());
    }

    // Step 6: Send configurationDone
    let conf_response = client
        .configuration_done()
        .await
        .expect("Failed to send configurationDone");
    println!("ConfigurationDone response: {:?}", conf_response);

    // Step 7: Wait for the 'stopped' event (hitting breakpoint)
    println!("Waiting for the target to hit the breakpoint (stopped event)...");
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

        // Request a stack trace to get the correct frame id
        let st_response = client.stack_trace(thread_id).await?;
        println!("StackTrace response: {:?}", st_response);

        // Extract frame ID
        let frame_id = st_response
            .body
            .as_ref()
            .and_then(|b| b.get("stackFrames"))
            .and_then(|frames| frames.as_array())
            .and_then(|frames| frames.get(0))
            .and_then(|frame| frame.get("id"))
            .and_then(|id| id.as_i64())
            .map(|id| id as i32);
        println!("Using frameId: {:?}", frame_id);

        let eval_response = client.evaluate("fib_series", frame_id).await?;
        println!("Evaluate response: {:?}", eval_response);

        // Extract and print the result value
        let result_value = eval_response
            .body
            .as_ref()
            .and_then(|b| b.get("result"))
            .map(|v| v.to_string());
        println!("Value of fib_series at breakpoint: {:?}", result_value);

        // Step 9: Continue execution
        let continue_response = client.continue_execution(thread_id).await?;
        println!("Continue response: {:?}", continue_response);

        // Loop to send continue requests if more stopped events are received
        while let Some(extra_stopped) = client.wait_for_event("stopped", 1.0) {
            println!("Extra stopped event received; sending another continue.");

            let extra_thread_id = if let Some(body) = &extra_stopped.body {
                if let Some(tid) = body.get("threadId") {
                    tid.as_i64().unwrap_or(1) as i32
                } else {
                    thread_id
                }
            } else {
                thread_id
            };

            let extra_continue = client.continue_execution(extra_thread_id).await?;
            println!("Extra continue response: {:?}", extra_continue);
        }
    } else {
        println!("Timed out waiting for 'stopped' event");
        return Err("No stopped event received".into());
    }

    // Wait for termination or timeout
    if let Some(term_evt) = client.wait_for_event("terminated", 10.0) {
        println!("Received terminated event: {:?}", term_evt);
    } else {
        println!(
            "Note: No terminated event received within timeout; this is expected in some configurations"
        );
    }

    println!("Test completed successfully!");
    Ok(())
}
