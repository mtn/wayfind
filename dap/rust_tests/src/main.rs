mod dap_client;

use crate::dap_client::DAPClient;
use std::path::Path;
use std::process::{Command, Stdio};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("Starting DAP test...");

    // Step 1: Launch target script with debugpy
    let debugpy_port = 5678;
    let script_path = Path::new("../test_data/a.py")
        .canonicalize()
        .expect("Failed to get absolute path to script");
    let script_path_str = script_path.to_str().unwrap();

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
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

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
    if let Some(initialized) = client.wait_for_event("initialized", 10.0) {
        println!("Initialization complete");
    } else {
        println!("Timed out waiting for 'initialized' event");
        return Err("No initialized event received".into());
    }

    // Step 5: Send setBreakpoints at line 24 (matching Python example)
    let breakpoint_line = 24;
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

        // Step 8: Request stack trace to get frame ID
        let st_response = client.stack_trace(thread_id).await?;
        println!("StackTrace response: {:?}", st_response);

        // Extract line number and verify it matches the breakpoint line
        let line_num = st_response
            .body
            .as_ref()
            .and_then(|b| b.get("stackFrames"))
            .and_then(|f| f.as_array())
            .and_then(|a| a.get(0))
            .and_then(|f| f.get("line"))
            .and_then(|l| l.as_i64())
            .unwrap_or(0) as i32;

        assert_eq!(line_num, breakpoint_line, "Stopped at unexpected line");

        // Step 9: Send step_in request
        let in_response = client.step_in(thread_id, None, "statement").await?;
        println!("Step in response: {:?}", in_response);

        // Step 10: Get stack trace again to verify line number
        let st_response2 = client.stack_trace(thread_id).await?;
        let line_num2 = st_response2
            .body
            .as_ref()
            .and_then(|b| b.get("stackFrames"))
            .and_then(|f| f.as_array())
            .and_then(|a| a.get(0))
            .and_then(|f| f.get("line"))
            .and_then(|l| l.as_i64())
            .unwrap_or(0) as i32;

        println!("Stopped on line {}", line_num2);
        assert_eq!(line_num2, 6, "Step in didn't land on expected line 6");

        // Step 11: Continue execution
        let continue_response = client.continue_execution(thread_id).await?;
        println!("Continue response: {:?}", continue_response);
    } else {
        println!("Timed out waiting for 'stopped' event");
        return Err("No stopped event received".into());
    }

    // Step 12: Wait for the 'terminated' event
    if let Some(term_evt) = client.wait_for_event("terminated", 10.0) {
        println!("Received terminated event: {:?}", term_evt);
    } else {
        println!("Timed out waiting for 'terminated' event");
        return Err("No terminated event received".into());
    }

    println!("Test completed successfully!");
    Ok(())
}
