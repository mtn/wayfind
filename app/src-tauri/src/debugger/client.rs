use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufReader, ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tauri::Emitter;
use tokio::sync::mpsc;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")] // This tells serde to use lowercase strings.
pub enum MessageType {
    Request,
    Response,
    Event,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DAPMessage {
    pub seq: i32,
    #[serde(rename = "type")]
    pub message_type: MessageType,
    pub command: Option<String>,
    pub request_seq: Option<i32>,
    pub success: Option<bool>,
    pub body: Option<serde_json::Value>,
    pub event: Option<String>,
    pub arguments: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BreakpointInput {
    pub line: u32,
}

pub struct DAPClient {
    // The writer is used to send messages.
    writer: Option<Arc<Mutex<TcpStream>>>,
    // The reader (wrapped in a BufReader) is used in our receiver loop.
    reader: Option<Arc<Mutex<BufReader<TcpStream>>>>,
    // next_seq generates unique sequence numbers for requests.
    next_seq: Arc<Mutex<i32>>,
    // responses: when we receive a Response message, we store it here by its request_seq.
    responses: Arc<Mutex<HashMap<i32, DAPMessage>>>,
    // events: when we receive an Event (e.g. "initialized", "terminated"), we store them here.
    events: Arc<Mutex<HashMap<String, Vec<DAPMessage>>>>,
    // receiver_handle: the join handle for the receiver thread.
    receiver_handle: Option<thread::JoinHandle<()>>,
    // event_sender: an optional channel sender that you can use if you want to propagate messages externally.
    event_sender: mpsc::UnboundedSender<DAPMessage>,
    // app_handle: the Tauri AppHandle used to emit IPC events.
    pub app_handle: AppHandle,
}

impl DAPClient {
    // Create a new client along with an mpsc receiver for external subscribers.
    // This version requires an AppHandle to be provided.
    pub fn new(app_handle: AppHandle) -> (Self, mpsc::UnboundedReceiver<DAPMessage>) {
        let (tx, rx) = mpsc::unbounded_channel();

        let client = Self {
            writer: None,
            reader: None,
            next_seq: Arc::new(Mutex::new(1)),
            responses: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(Mutex::new(HashMap::new())),
            receiver_handle: None,
            event_sender: tx,
            app_handle,
        };

        (client, rx)
    }

    // Connect: clone the stream so that one instance is used for writing and one for reading.
    pub fn connect(&mut self, host: &str, port: u16) -> std::io::Result<()> {
        let stream = TcpStream::connect((host, port))?;
        self.writer = Some(Arc::new(Mutex::new(stream.try_clone()?)));
        self.reader = Some(Arc::new(Mutex::new(BufReader::new(stream))));
        Ok(())
    }

    // send_message: assigns a sequence number, serializes the message along with a header, and writes it to the stream.
    // Returns the assigned sequence number.
    pub fn send_message(&self, mut message: DAPMessage) -> std::io::Result<i32> {
        let seq = {
            let mut seq_lock = self.next_seq.lock().unwrap();
            let current = *seq_lock;
            *seq_lock += 1;
            current
        };

        message.seq = seq;
        let json = serde_json::to_string(&message)?;
        let header = format!("Content-Length: {}\r\n\r\n", json.len());

        println!(
            "--> Sending message (seq={}):\nHeader: {}\nPayload: {}",
            seq, header, json
        );

        if let Some(ref writer) = self.writer {
            let mut guard = writer.lock().unwrap();
            guard.write_all(header.as_bytes())?;
            guard.write_all(json.as_bytes())?;
            guard.flush()?;
        } else {
            panic!("Stream is not connected");
        }

        Ok(seq)
    }

    // start_receiver: spawns a dedicated thread to continuously read incoming messages.
    pub fn start_receiver(&mut self) {
        let reader_arc = Arc::clone(self.reader.as_ref().expect("Reader not set"));
        let responses_arc = Arc::clone(&self.responses);
        let events_arc = Arc::clone(&self.events);
        let event_sender = self.event_sender.clone();
        let writer_arc = Arc::clone(self.writer.as_ref().expect("Writer not set"));
        let next_seq_arc = Arc::clone(&self.next_seq);
        // Clone the app_handle so it can be moved into the thread.
        let app_handle = self.app_handle.clone();

        self.receiver_handle = Some(thread::spawn(move || loop {
            // Read header until we find the "\r\n\r\n" sequence.
            let header = {
                let mut reader = reader_arc.lock().unwrap();
                let mut header_bytes = Vec::new();
                // Read one byte at a time until the header terminator is found.
                loop {
                    let mut buf = [0u8; 1];
                    match reader.read_exact(&mut buf) {
                        Ok(()) => {
                            header_bytes.push(buf[0]);
                            if header_bytes.ends_with(b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(ref e) if e.kind() == ErrorKind::UnexpectedEof => {
                            // Connection closed.
                            return;
                        }
                        Err(e) => {
                            eprintln!("Error reading header: {}", e);
                            return;
                        }
                    }
                }
                String::from_utf8_lossy(&header_bytes).to_string()
            };

            // Parse Content-Length from header.
            let content_length = header
                .lines()
                .find(|line| line.to_lowercase().starts_with("content-length:"))
                .and_then(|line| line[15..].trim().parse::<usize>().ok());

            if let Some(len) = content_length {
                // Now, read the body.
                let mut body_bytes = vec![0; len];
                {
                    let mut reader = reader_arc.lock().unwrap();
                    if let Err(e) = reader.read_exact(&mut body_bytes) {
                        eprintln!("Error reading body: {}", e);
                        return;
                    }
                }
                let message_str = match String::from_utf8(body_bytes) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("Invalid UTF-8 body: {}", e);
                        continue;
                    }
                };

                println!("<-- Received: {}", message_str);

                if let Ok(msg) = serde_json::from_str::<DAPMessage>(&message_str) {
                    // Handle events that require special processing
                    if msg.message_type == MessageType::Event {
                        if let Some(ref evt) = msg.event {
                            if evt == "terminated" {
                                println!("Processing 'terminated' event");
                                let _ = app_handle.emit(
                                    "debug-status",
                                    serde_json::json!({"status": "Terminated"}),
                                );
                            } else if evt == "stopped" {
                                // Handle the stopped event - extract file and line information
                                if let Some(ref body) = msg.body {
                                    println!("Processing 'stopped' event: {:?}", body);

                                    // First emit the stopped status
                                    let _ = app_handle.emit(
                                        "debug-status",
                                        serde_json::json!({"status": "Paused"}),
                                    );

                                    // Get the thread ID from the stopped event
                                    if let Some(thread_id) =
                                        body.get("threadId").and_then(|v| v.as_i64())
                                    {
                                        // Get the next sequence number for our request
                                        let seq = {
                                            let mut seq_lock = next_seq_arc.lock().unwrap();
                                            let current = *seq_lock;
                                            *seq_lock += 1;
                                            current
                                        };

                                        // Create a stack trace request
                                        let stack_req = DAPMessage {
                                            seq,
                                            message_type: MessageType::Request,
                                            command: Some("stackTrace".to_string()),
                                            request_seq: None,
                                            success: None,
                                            arguments: Some(serde_json::json!({
                                                "threadId": thread_id,
                                                "startFrame": 0,
                                                "levels": 1
                                            })),
                                            body: None,
                                            event: None,
                                        };

                                        // Send the stack trace request
                                        let json = serde_json::to_string(&stack_req).unwrap();
                                        let header =
                                            format!("Content-Length: {}\r\n\r\n", json.len());

                                        {
                                            let mut writer = writer_arc.lock().unwrap();
                                            let _ = writer.write_all(header.as_bytes());
                                            let _ = writer.write_all(json.as_bytes());
                                            let _ = writer.flush();
                                        }

                                        // Now wait for the response (with timeout)
                                        let start = Instant::now();
                                        let timeout_secs = 1.0; // 1 second timeout

                                        while start.elapsed().as_secs_f64() < timeout_secs {
                                            // Check if we got a response to our stack trace request
                                            let mut stack_response = None;
                                            {
                                                let mut responses = responses_arc.lock().unwrap();
                                                stack_response = responses.remove(&seq);
                                            }

                                            if let Some(stack_resp) = stack_response {
                                                if let Some(stack_body) = stack_resp.body {
                                                    if let Some(frames) = stack_body
                                                        .get("stackFrames")
                                                        .and_then(|sf| sf.as_array())
                                                    {
                                                        if let Some(frame) = frames.first() {
                                                            // Extract source file and line
                                                            let source = frame.get("source");
                                                            let line = frame
                                                                .get("line")
                                                                .and_then(|l| l.as_i64());

                                                            if let (Some(source), Some(line)) =
                                                                (source, line)
                                                            {
                                                                let file_path = source
                                                                    .get("path")
                                                                    .and_then(|p| p.as_str());

                                                                if let Some(file_path) = file_path {
                                                                    // Emit the debug location event with file and line info
                                                                    let _ = app_handle.emit(
                                                                        "debug-location",
                                                                        serde_json::json!({
                                                                            "file": file_path,
                                                                            "line": line
                                                                        }),
                                                                    );
                                                                    println!("Emitted debug-location event: file={}, line={}",
                                                                        file_path, line);
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                                break;
                                            }
                                            thread::sleep(Duration::from_millis(50));
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Handle responses and events as before
                    match msg.message_type {
                        MessageType::Response => {
                            if let Some(req_seq) = msg.request_seq {
                                responses_arc.lock().unwrap().insert(req_seq, msg.clone());
                            }
                        }
                        MessageType::Event => {
                            if let Some(ref evt) = msg.event {
                                events_arc
                                    .lock()
                                    .unwrap()
                                    .entry(evt.clone())
                                    .or_insert_with(Vec::new)
                                    .push(msg.clone());
                            }
                        }
                        _ => {}
                    }

                    // Send the message to any external subscribers
                    let _ = event_sender.send(msg);
                } else {
                    eprintln!("Error parsing message: {}", message_str);
                }
            } else {
                eprintln!("No Content-Length found in header: {}", header);
            }

            // Don't busy‐spin.
            thread::sleep(Duration::from_millis(10));
        }));
    }

    // wait_for_response: polls the internal responses HashMap until the response with the given sequence is available,
    // or the timeout expires.
    pub async fn wait_for_response(&self, seq: i32, timeout_secs: f64) -> Option<DAPMessage> {
        let start = Instant::now();
        while start.elapsed().as_secs_f64() < timeout_secs {
            if let Some(resp) = self.responses.lock().unwrap().remove(&seq) {
                return Some(resp);
            }
            thread::sleep(Duration::from_millis(50));
        }
        None
    }

    // wait_for_event: polls for an event by its name until it arrives or the timeout expires.
    #[allow(dead_code)]
    pub fn wait_for_event(&self, name: &str, timeout_secs: f64) -> Option<DAPMessage> {
        let start = Instant::now();
        while start.elapsed().as_secs_f64() < timeout_secs {
            if let Some(mut events) = self.events.lock().ok() {
                if let Some(list) = events.get_mut(name) {
                    if !list.is_empty() {
                        return Some(list.remove(0));
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        None
    }

    // initialize: sends an "initialize" request and then waits for its response.
    pub async fn initialize(&self) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let seq = self.send_message(DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("initialize".to_string()),
            request_seq: None,
            success: None,
            arguments: Some(serde_json::json!({
                "adapterID": "python",
                "clientID": "dap_test_client",
                "clientName": "DAP Test",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsVariableType": true,
                "supportsEvaluateForHovers": true
            })),
            body: None,
            event: None,
        })?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for initialize response".into())
        }
    }

    // attach: sends an "attach" request.
    pub async fn attach(&self, host: &str, port: u16) -> Result<(), Box<dyn std::error::Error>> {
        self.send_message(DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("attach".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(serde_json::json!({
                "host": host,
                "port": port,
            })),
        })?;
        // Give the target a moment to process attach.
        tokio::time::sleep(Duration::from_millis(700)).await;
        Ok(())
    }

    // configuration_done: sends a "configurationDone" request and waits for its response.
    pub async fn configuration_done(&self) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let seq = self.send_message(DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("configurationDone".to_string()),
            request_seq: None,
            success: None,
            arguments: Some(serde_json::json!({})),
            body: None,
            event: None,
        })?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for configurationDone response".into())
        }
    }

    // set_breakpoints: sends a "setBreakpoints" request and waits for its response.
    pub async fn set_breakpoints(
        &self,
        file_path: String,
        breakpoints: Vec<BreakpointInput>,
    ) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("setBreakpoints".to_string()),
            request_seq: None,
            success: None,
            arguments: Some(serde_json::json!({
                "source": {
                    "path": file_path,
                    "name": file_path.split('/').last().unwrap_or("unknown")
                },
                "breakpoints": breakpoints,
                "sourceModified": false
            })),
            body: None,
            event: None,
        };
        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for setBreakpoints response".into())
        }
    }
}
