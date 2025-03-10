use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::BufRead;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

// Global variables to help manage DAP messages
static mut NEXT_SEQ: u32 = 1;
type ResponseMap = Arc<Mutex<HashMap<u32, Value>>>;
type EventMap = Arc<Mutex<HashMap<String, Vec<Value>>>>;

/// Parse an LLDB expression evaluation result to extract the actual value.
fn parse_lldb_result(result_value: Option<&str>) -> Option<String> {
    let result_value = match result_value {
        Some(val) => val,
        None => return None,
    };

    // Try to match full LLDB output with command
    let re1 = Regex::new(r"\(lldb\).*\n\(\w+\)\s+\$\d+\s+=\s+(.+)").unwrap();
    if let Some(caps) = re1.captures(result_value) {
        return Some(caps[1].trim().to_string());
    }

    // Try to match just the result part
    let re2 = Regex::new(r"\(\w+\)\s+\$\d+\s+=\s+(.+)").unwrap();
    if let Some(caps) = re2.captures(result_value) {
        return Some(caps[1].trim().to_string());
    }

    // If no patterns match, return the original value
    Some(result_value.trim().to_string())
}

fn next_sequence() -> u32 {
    unsafe {
        let seq = NEXT_SEQ;
        NEXT_SEQ += 1;
        seq
    }
}

fn send_dap_message(stream: &mut TcpStream, message: &Value) -> std::io::Result<()> {
    let data = serde_json::to_string(message)?;
    let header = format!("Content-Length: {}\r\n\r\n", data.len());

    stream.write_all(header.as_bytes())?;
    stream.write_all(data.as_bytes())?;
    stream.flush()?;

    println!(
        "--> Sent (seq {}, cmd: {}): {}\n",
        message.get("seq").and_then(|s| s.as_u64()).unwrap_or(0),
        message
            .get("command")
            .and_then(|c| c.as_str().map(|s| s.to_string()))
            .unwrap_or_default(),
        data
    );

    Ok(())
}

fn read_dap_message(stream: &mut TcpStream) -> std::io::Result<Value> {
    // Read header byte by byte until we find \r\n\r\n
    let mut header = Vec::new();
    let mut buf = [0; 1];

    loop {
        stream.read_exact(&mut buf)?;
        header.push(buf[0]);

        if header.len() >= 4
            && header[header.len() - 4] == b'\r'
            && header[header.len() - 3] == b'\n'
            && header[header.len() - 2] == b'\r'
            && header[header.len() - 1] == b'\n'
        {
            break;
        }
    }

    // Extract Content-Length
    let header_str = String::from_utf8_lossy(&header);
    let re = Regex::new(r"Content-Length: (\d+)").unwrap();
    let length: usize = match re.captures(&header_str) {
        Some(caps) => caps[1].parse().unwrap(),
        None => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Content-Length header not found",
            ));
        }
    };

    // Read body
    let mut body = vec![0; length];
    stream.read_exact(&mut body)?;

    let message: Value = serde_json::from_slice(&body)?;
    println!(
        "<-- Received: {}\n",
        serde_json::to_string(&message).unwrap_or_default()
    );

    Ok(message)
}

fn dap_receiver(mut stream: TcpStream, responses: ResponseMap, events: EventMap) {
    loop {
        match read_dap_message(&mut stream) {
            Ok(msg) => {
                let msg_type = msg.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match msg_type {
                    "response" => {
                        if let Some(req_seq) = msg.get("request_seq").and_then(|s| s.as_u64()) {
                            let mut responses = responses.lock().unwrap();
                            responses.insert(req_seq as u32, msg);
                        }
                    }
                    "event" => {
                        // Here's the change - use clone() to avoid the borrow issue
                        if let Some(event_name) = msg.get("event").and_then(|e| e.as_str()) {
                            let mut events = events.lock().unwrap();
                            let event_list = events
                                .entry(event_name.to_string())
                                .or_insert_with(Vec::new);
                            event_list.push(msg.clone()); // Clone msg here
                            println!("Received event: {}", event_name);
                        }
                    }
                    _ => println!("Unknown message type: {:?}", msg),
                }
            }
            Err(e) => {
                println!("Receiver terminating: {}", e);
                break;
            }
        }
    }
}

fn wait_for_event(events: &EventMap, event_name: &str, timeout: Duration) -> Result<Value, String> {
    let start = Instant::now();

    while start.elapsed() < timeout {
        {
            let mut events = events.lock().unwrap();
            if let Some(event_list) = events.get_mut(event_name) {
                if !event_list.is_empty() {
                    return Ok(event_list.remove(0));
                }
            }
        }
        thread::sleep(Duration::from_millis(100));
    }

    Err(format!("Timeout waiting for event {}", event_name))
}

fn wait_for_response(
    responses: &ResponseMap,
    seq: u32,
    timeout: Duration,
) -> Result<Value, String> {
    let start = Instant::now();

    while start.elapsed() < timeout {
        {
            let mut responses = responses.lock().unwrap();
            if let Some(response) = responses.remove(&seq) {
                return Ok(response);
            }
        }
        thread::sleep(Duration::from_millis(100));
    }

    Err(format!("Timeout waiting for response to seq {}", seq))
}

struct LldbDapProcess {
    child: Child,
    output_buffer: Arc<Mutex<Vec<String>>>,
}

impl LldbDapProcess {
    fn new(lldb_dap_path: &Path, port: u16) -> std::io::Result<Self> {
        println!("Starting lldb-dap on port {}...", port);

        let child = Command::new(lldb_dap_path)
            .args(&["--port", &port.to_string()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let mut child_copy = child;
        let stdout = child_copy.stdout.take().unwrap();
        let stderr = child_copy.stderr.take().unwrap();

        let output_buffer = Arc::new(Mutex::new(Vec::new()));
        let output_buffer_clone = Arc::clone(&output_buffer);

        thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let mut line = String::new();

            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim_end().to_string();
                        println!("LLDB-DAP: {}", trimmed);
                        output_buffer_clone.lock().unwrap().push(trimmed);
                    }
                    Err(e) => {
                        println!("Error reading stdout: {}", e);
                        break;
                    }
                }
            }
        });

        let output_buffer_clone = Arc::clone(&output_buffer);
        thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stderr);
            let mut line = String::new();

            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim_end().to_string();
                        println!("LLDB-DAP ERR: {}", trimmed);
                        output_buffer_clone.lock().unwrap().push(trimmed);
                    }
                    Err(e) => {
                        println!("Error reading stderr: {}", e);
                        break;
                    }
                }
            }
        });

        Ok(LldbDapProcess {
            child: child_copy,
            output_buffer,
        })
    }

    fn terminate(&mut self) -> std::io::Result<()> {
        self.child.kill()?;
        self.child.wait()?;
        Ok(())
    }

    fn print_output(&self) {
        println!("\n----- Captured LLDB-DAP Output -----");
        let buffer = self.output_buffer.lock().unwrap();
        for line in buffer.iter() {
            println!("{}", line);
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Find the lldb-dap binary
    let lldb_dap_path =
        PathBuf::from("/Applications/Xcode.app/Contents/Developer/usr/bin/lldb-dap");
    if !lldb_dap_path.exists() {
        println!("Error: LLDB-DAP not found at {:?}", lldb_dap_path);
        return Err("LLDB-DAP not found".into());
    }

    // Find the workspace root
    let current_dir = std::env::current_dir()?;
    let workspace_root = current_dir.parent().unwrap().parent().unwrap();

    // Path to the test program
    let test_program_src = workspace_root
        .join("dap")
        .join("test_data")
        .join("rust_program");

    // Build the test program
    println!("Building test program...");
    let status = Command::new("cargo")
        .args(&["build"])
        .current_dir(&test_program_src)
        .status()?;

    if !status.success() {
        return Err("Error building test program".into());
    }

    // Path to the binary
    let mut target_program = workspace_root
        .join("target")
        .join("debug")
        .join("rust_program");
    if cfg!(windows) {
        target_program = target_program.with_extension("exe");
    }

    if !target_program.exists() {
        return Err(format!("Error: Compiled binary not found at {:?}", target_program).into());
    }

    println!("Using binary: {:?}", target_program);

    // Start lldb-dap on a specific port
    let lldb_port = 9123;
    let mut lldb_proc = LldbDapProcess::new(&lldb_dap_path, lldb_port)?;

    // Give lldb-dap time to start
    thread::sleep(Duration::from_secs(1));

    // Connect to lldb-dap
    let stream = match TcpStream::connect(("127.0.0.1", lldb_port)) {
        Ok(stream) => {
            println!("Connected to lldb-dap.");
            stream
        }
        Err(e) => {
            println!("Failed to connect to lldb-dap: {}", e);
            lldb_proc.terminate()?;
            return Err(e.into());
        }
    };

    // Initialize shared data structures
    let responses: ResponseMap = Arc::new(Mutex::new(HashMap::new()));
    let events: EventMap = Arc::new(Mutex::new(HashMap::new()));

    // Start DAP message receiver thread
    let responses_clone = Arc::clone(&responses);
    let events_clone = Arc::clone(&events);
    let receiver_stream = stream.try_clone()?;
    let _recv_thread = thread::spawn(move || {
        dap_receiver(receiver_stream, responses_clone, events_clone);
    });

    let mut stream = stream;
    let timeout = Duration::from_secs(10);

    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        // Step 1: Send initialize request
        let init_seq = next_sequence();
        let init_req = json!({
            "seq": init_seq,
            "type": "request",
            "command": "initialize",
            "arguments": {
                "clientID": "wayfind-test",
                "clientName": "Wayfind LLDB Test",
                "adapterID": "lldb",
                "pathFormat": "path",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "supportsVariableType": true,
                "supportsRunInTerminalRequest": false
            }
        });

        send_dap_message(&mut stream, &init_req)?;
        let init_resp =
            wait_for_response(&responses, init_seq, timeout).map_err(|e| e.to_string())?;
        println!(
            "Initialize response: {}",
            serde_json::to_string_pretty(&init_resp)?
        );

        // Step 2: Send launch request
        let launch_seq = next_sequence();
        let launch_req = json!({
            "seq": launch_seq,
            "type": "request",
            "command": "launch",
            "arguments": {
                "program": target_program.to_str().unwrap(),
                "args": [],
                "cwd": target_program.parent().unwrap().to_str().unwrap(),
                "stopOnEntry": true
            }
        });

        send_dap_message(&mut stream, &launch_req)?;
        thread::sleep(Duration::from_millis(200)); // Give the server a moment

        // Step 3: Wait for initialized event
        println!("Waiting for initialized event...");
        let initialized_event =
            wait_for_event(&events, "initialized", timeout).map_err(|e| e.to_string())?;
        println!(
            "Initialized event received: {}",
            serde_json::to_string_pretty(&initialized_event)?
        );
        println!("Initialization complete");

        // Step 4: Set breakpoints
        let bp_seq = next_sequence();
        let bp_req = json!({
            "seq": bp_seq,
            "type": "request",
            "command": "setBreakpoints",
            "arguments": {
                "source": {
                    "path": test_program_src.join("src").join("main.rs").to_str().unwrap()
                },
                "breakpoints": [
                    {"line": 18}  // Line with calculate_sum call
                ],
                "sourceModified": false
            }
        });

        send_dap_message(&mut stream, &bp_req)?;
        let bp_resp = wait_for_response(&responses, bp_seq, timeout).map_err(|e| e.to_string())?;
        println!(
            "Breakpoints response: {}",
            serde_json::to_string_pretty(&bp_resp)?
        );

        // Step 5: Configuration done
        let config_seq = next_sequence();
        let config_req = json!({
            "seq": config_seq,
            "type": "request",
            "command": "configurationDone"
        });

        send_dap_message(&mut stream, &config_req)?;
        let config_resp =
            wait_for_response(&responses, config_seq, timeout).map_err(|e| e.to_string())?;
        println!(
            "ConfigurationDone response: {}",
            serde_json::to_string_pretty(&config_resp)?
        );

        // Step 6: Wait for stopped event (due to stopOnEntry)
        println!("Waiting for stopped event (due to stopOnEntry)...");
        let stopped_event =
            wait_for_event(&events, "stopped", timeout).map_err(|e| e.to_string())?;
        println!(
            "Stopped event: {}",
            serde_json::to_string_pretty(&stopped_event)?
        );

        let thread_id = stopped_event
            .get("body")
            .and_then(|b| b.get("threadId"))
            .and_then(|t| t.as_u64())
            .unwrap_or(1) as u64;

        // Step 7: Continue to hit the breakpoint
        let continue_seq = next_sequence();
        let continue_req = json!({
            "seq": continue_seq,
            "type": "request",
            "command": "continue",
            "arguments": {
                "threadId": thread_id
            }
        });

        send_dap_message(&mut stream, &continue_req)?;
        let continue_resp =
            wait_for_response(&responses, continue_seq, timeout).map_err(|e| e.to_string())?;
        println!(
            "Continue response: {}",
            serde_json::to_string_pretty(&continue_resp)?
        );

        // Step 8: Wait for the breakpoint hit (another stopped event)
        println!("Waiting for breakpoint hit...");
        let breakpoint_hit_event =
            wait_for_event(&events, "stopped", timeout).map_err(|e| e.to_string())?;
        println!(
            "Breakpoint hit event: {}",
            serde_json::to_string_pretty(&breakpoint_hit_event)?
        );

        let thread_id = breakpoint_hit_event
            .get("body")
            .and_then(|b| b.get("threadId"))
            .and_then(|t| t.as_u64())
            .unwrap_or(thread_id);

        // Step 9: Get stack trace to get the frame ID
        let stack_seq = next_sequence();
        let stack_req = json!({
            "seq": stack_seq,
            "type": "request",
            "command": "stackTrace",
            "arguments": {
                "threadId": thread_id,
                "startFrame": 0,
                "levels": 1
            }
        });

        send_dap_message(&mut stream, &stack_req)?;
        let stack_resp =
            wait_for_response(&responses, stack_seq, timeout).map_err(|e| e.to_string())?;
        println!(
            "Stack trace response: {}",
            serde_json::to_string_pretty(&stack_resp)?
        );

        let frame_id = stack_resp
            .get("body")
            .and_then(|b| b.get("stackFrames"))
            .and_then(|f| f.as_array())
            .and_then(|frames| frames.first())
            .and_then(|frame| frame.get("id"))
            .and_then(|id| id.as_u64());

        println!("Using frameId: {:?}", frame_id);

        let frame_id = match frame_id {
            Some(id) => id,
            None => return Err("No frame ID available".into()),
        };

        // Step 10: Evaluate an expression
        let eval_seq = next_sequence();
        let eval_req = json!({
            "seq": eval_seq,
            "type": "request",
            "command": "evaluate",
            "arguments": {
                "expression": "expr -- a + b",
                "context": "repl",
                "frameId": frame_id
            }
        });

        send_dap_message(&mut stream, &eval_req)?;
        let eval_resp =
            wait_for_response(&responses, eval_seq, timeout).map_err(|e| e.to_string())?;
        println!(
            "Evaluate response: {}",
            serde_json::to_string_pretty(&eval_resp)?
        );

        let result_value = eval_resp
            .get("body")
            .and_then(|b| b.get("result"))
            .and_then(|r| r.as_str());

        println!(
            "Value of 'a + b' at breakpoint: {}",
            parse_lldb_result(result_value).unwrap_or_else(|| "unknown".to_string())
        );

        // Step 11: Continue to completion
        let continue_seq = next_sequence();
        let continue_req = json!({
            "seq": continue_seq,
            "type": "request",
            "command": "continue",
            "arguments": {
                "threadId": thread_id
            }
        });

        send_dap_message(&mut stream, &continue_req)?;
        let continue_resp =
            wait_for_response(&responses, continue_seq, timeout).map_err(|e| e.to_string())?;
        println!(
            "Final continue response: {}",
            serde_json::to_string_pretty(&continue_resp)?
        );

        // Handle any additional stops
        loop {
            match wait_for_event(&events, "stopped", Duration::from_secs(1)) {
                Ok(extra_stop) => {
                    println!(
                        "Extra stopped event received: {}",
                        serde_json::to_string_pretty(&extra_stop)?
                    );

                    let extra_thread_id = extra_stop
                        .get("body")
                        .and_then(|b| b.get("threadId"))
                        .and_then(|t| t.as_u64())
                        .unwrap_or(thread_id);

                    let cont_seq = next_sequence();
                    let cont_req = json!({
                        "seq": cont_seq,
                        "type": "request",
                        "command": "continue",
                        "arguments": {
                            "threadId": extra_thread_id
                        }
                    });

                    send_dap_message(&mut stream, &cont_req)?;
                    let extra_cont = wait_for_response(&responses, cont_seq, timeout)
                        .map_err(|e| e.to_string())?;
                    println!(
                        "Extra continue response: {}",
                        serde_json::to_string_pretty(&extra_cont)?
                    );
                }
                Err(_) => {
                    println!("No more stopped events received");
                    break;
                }
            }
        }

        // Wait for termination
        println!("Waiting for termination...");
        match wait_for_event(&events, "terminated", Duration::from_secs(5)) {
            Ok(terminated_event) => {
                println!(
                    "Terminated event: {}",
                    serde_json::to_string_pretty(&terminated_event)?
                );
            }
            Err(_) => {
                println!("No termination event received (may be normal for some adapters)");
            }
        }

        // Disconnect
        let disconnect_seq = next_sequence();
        let disconnect_req = json!({
            "seq": disconnect_seq,
            "type": "request",
            "command": "disconnect",
            "arguments": {
                "terminateDebuggee": true
            }
        });

        send_dap_message(&mut stream, &disconnect_req)?;
        let disconnect_resp =
            wait_for_response(&responses, disconnect_seq, timeout).map_err(|e| e.to_string())?;
        println!(
            "Disconnect response: {}",
            serde_json::to_string_pretty(&disconnect_resp)?
        );

        Ok(())
    })();

    // Cleanup
    drop(stream);
    lldb_proc.print_output();
    lldb_proc.terminate()?;

    if let Err(e) = result {
        println!("Error during test: {}", e);
        return Err(e);
    }

    println!("Test completed");
    Ok(())
}
