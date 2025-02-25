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
        // Clone the app_handle so it can be moved into the thread.
        let app_handle = self.app_handle.clone();

        self.receiver_handle = Some(thread::spawn(move || loop {
            // Read header until we encounter "\r\n\r\n".
            let header = {
                let mut reader = reader_arc.lock().unwrap();
                let mut header_bytes = Vec::new();
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

            // Extract the content length from the header.
            let content_length = header
                .lines()
                .find(|line| line.to_lowercase().starts_with("content-length:"))
                .and_then(|line| line[15..].trim().parse::<usize>().ok());

            if let Some(len) = content_length {
                // Read the JSON body.
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
                    // If the message is an event and its name is "terminated",
                    // immediately emit the terminated status via the app_handle.
                    if msg.message_type == MessageType::Event {
                        if let Some(ref evt) = msg.event {
                            if evt == "terminated" {
                                println!("Processing 'terminated' event. terminated set to true");
                                let _ = app_handle.emit(
                                    "debug-status",
                                    serde_json::json!({"status": "Terminated"}),
                                );
                            }
                        }
                    }

                    // For responses, store them keyed by their request_seq.
                    match msg.message_type {
                        MessageType::Response => {
                            if let Some(req_seq) = msg.request_seq {
                                responses_arc.lock().unwrap().insert(req_seq, msg.clone());
                            }
                        }
                        // For events, store them keyed by the event name.
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
                    // Optionally send the message out through the channel.
                    let _ = event_sender.send(msg);
                } else {
                    eprintln!("Error parsing message: {}", message_str);
                }
            } else {
                eprintln!("No Content-Length found in header: {}", header);
            }
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
}
