mod dap_client;

use crate::dap_client::DAPClient;
use std::process::{Command, Stdio};

#[tokio::main]
async fn main() {
    println!("Starting DAP test...");

    let script_path = "../test_data/a.py";
    let debugpy_port = 5678;

    // Launch Python with debugpy.
    // let mut child = Command::new("python")
    //     .args(&[
    //         "-Xfrozen_modules=off",
    //         "-m",
    //         "debugpy",
    //         "--listen",
    //         &format!("127.0.0.1:{}", debugpy_port),
    //         "--wait-for-client",
    //         script_path,
    //     ])
    //     .stdout(Stdio::piped())
    //     .stderr(Stdio::piped())
    //     .spawn()
    //     .expect("Failed to spawn debugpy process");

    // println!("Launched Python process with PID: {}", child.id());

    // Give debugpy time to start.
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;

    // Create DAP client and connect.
    let mut client = DAPClient::new();
    client
        .connect("127.0.0.1", debugpy_port)
        .expect("Failed to connect");
    client.start_receiver();

    // Initialize.
    let init_response = client.initialize().await.expect("Failed to initialize");
    println!("Initialize response: {:?}", init_response);

    // Attach.
    let attach_response = client
        .attach("127.0.0.1", debugpy_port)
        .await
        .expect("Failed to attach");
    println!("Attach response: {:?}", attach_response);

    // Wait for the 'initialized' event.
    if let Some(initialized) = client.wait_for_event("initialized", 10.0) {
        println!("Received initialized event: {:?}", initialized);
    } else {
        println!("Timed out waiting for 'initialized' event");
    }

    // Configuration Done.
    let conf_response = client
        .configuration_done()
        .await
        .expect("Failed to send configurationDone");
    println!("ConfigurationDone response: {:?}", conf_response);

    // Wait for program to finish or 'terminated' event.
    let mut done = false;
    while !done {
        if let Some(term_event) = client.wait_for_event("terminated", 0.5) {
            println!("Received terminated event: {:?}", term_event);
            done = true;
        }
    }
}
