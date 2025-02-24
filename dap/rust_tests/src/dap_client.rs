use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize, Clone)]
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
    stream: Arc<Mutex<Option<TcpStream>>>,
    next_seq: Arc<Mutex<i32>>,
    responses: Arc<Mutex<HashMap<i32, DAPMessage>>>,
    events: Arc<Mutex<HashMap<String, Vec<DAPMessage>>>>,
    // We don’t really need to convert the std::thread::JoinHandle to a Tokio handle.
    // We'll just store it if needed.
    receiver_handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}

impl DAPClient {
    pub fn new() -> Self {
        Self {
            stream: Arc::new(Mutex::new(None)),
            next_seq: Arc::new(Mutex::new(1)),
            responses: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(Mutex::new(HashMap::new())),
            receiver_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub fn connect(&self, host: &str, port: u16) -> std::io::Result<()> {
        let stream = TcpStream::connect((host, port))?;
        *self.stream.lock().unwrap() = Some(stream);
        Ok(())
    }

    /// Sends a DAP message. Returns the assigned sequence number.
    pub fn send_message(&self, mut message: DAPMessage) -> std::io::Result<i32> {
        let seq = {
            let mut seq = self.next_seq.lock().unwrap();
            let current = *seq;
            *seq += 1;
            current
        };

        message.seq = seq;
        let json = serde_json::to_string(&message)?;
        let header = format!("Content-Length: {}\r\n\r\n", json.len());

        println!(
            "--> Sending message (seq={}):\nHeader: {}\nPayload: {}",
            seq, header, json
        );

        let guard = self.stream.lock().unwrap();
        if let Some(stream) = guard.as_ref() {
            // Write synchronously.
            let mut stream = stream;
            stream.write_all(header.as_bytes())?;
            stream.write_all(json.as_bytes())?;
            Ok(seq)
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "Not connected to debug adapter",
            ))
        }
    }

    /// Starts a background receiver thread that continuously reads messages.
    pub fn start_receiver(&self) {
        let stream = Arc::clone(&self.stream);
        let responses = Arc::clone(&self.responses);
        let events = Arc::clone(&self.events);

        let handle = thread::spawn(move || {
            loop {
                // Acquire the stream.
                let maybe_msg = {
                    let guard = stream.lock().unwrap();
                    if let Some(ref stream) = *guard {
                        let mut reader = BufReader::new(stream);
                        // Read header.
                        let mut header = String::new();
                        loop {
                            let mut line = String::new();
                            // read_line is blocking
                            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                                break;
                            }
                            header.push_str(&line);
                            if line == "\r\n" {
                                break;
                            }
                        }
                        // If no header was read, return None.
                        if header.is_empty() {
                            None
                        } else if let Some(content_length) = header
                            .lines()
                            .find(|line| line.to_lowercase().starts_with("content-length:"))
                            .and_then(|line| line[15..].trim().parse::<usize>().ok())
                        {
                            let mut body = vec![0; content_length];
                            if reader.read_exact(&mut body).is_ok() {
                                if let Ok(message_str) = String::from_utf8(body) {
                                    println!("<-- Received: {}", message_str);
                                    serde_json::from_str::<DAPMessage>(&message_str).ok()
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                };

                if let Some(msg) = maybe_msg {
                    match msg.message_type {
                        MessageType::Response => {
                            if let Some(req_seq) = msg.request_seq {
                                responses.lock().unwrap().insert(req_seq, msg);
                            }
                        }
                        MessageType::Event => {
                            if let Some(event_name) = &msg.event {
                                events
                                    .lock()
                                    .unwrap()
                                    .entry(event_name.clone())
                                    .or_insert_with(Vec::new)
                                    .push(msg);
                            }
                        }
                        _ => {}
                    }
                }
                thread::sleep(Duration::from_millis(100));
            }
        });

        *self.receiver_handle.lock().unwrap() = Some(handle);
    }

    /// Waits for an event (by its name) to appear for up to `timeout` seconds.
    pub fn wait_for_event(&self, name: &str, timeout: f64) -> Option<DAPMessage> {
        let start = std::time::Instant::now();
        while start.elapsed().as_secs_f64() < timeout {
            let mut events = self.events.lock().unwrap();
            if let Some(event_list) = events.get_mut(name) {
                if !event_list.is_empty() {
                    return Some(event_list.remove(0));
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        None
    }

    fn read_message(&self) -> std::io::Result<DAPMessage> {
        let guard = self.stream.lock().unwrap();
        if let Some(stream) = guard.as_ref() {
            let mut reader = BufReader::new(stream);

            let mut header = String::new();
            loop {
                let mut line = String::new();
                let bytes_read = reader.read_line(&mut line)?;
                if bytes_read == 0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "Connection closed while reading header",
                    ));
                }
                header.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }

            let content_length = header
                .lines()
                .find(|line| line.to_lowercase().starts_with("content-length:"))
                .and_then(|line| line[15..].trim().parse::<usize>().ok())
                .ok_or_else(|| {
                    std::io::Error::new(std::io::ErrorKind::InvalidData, "No content length found")
                })?;

            let mut body = vec![0; content_length];
            reader.read_exact(&mut body)?;

            let message = String::from_utf8(body)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

            println!("<-- Received: {}", message);

            serde_json::from_str(&message)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
        } else {
            Err(std::io::Error::new(
                std::io::ErrorKind::NotConnected,
                "Not connected to debug adapter",
            ))
        }
    }

    pub async fn initialize(&self) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("initialize".to_string()),
            request_seq: None,
            success: None,
            body: Some(serde_json::json!({
                "adapterID": "python",
                "clientID": "dap_test_client",
                "clientName": "DAP Test",
                "linesStartAt1": true,
                "columnsStartAt1": true,
                "pathFormat": "path",
                "supportsVariableType": true,
                "supportsEvaluateForHovers": true,
            })),
            event: None,
            arguments: None,
        };

        let seq = self.send_message(req)?;
        // Wait briefly
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        if let Some(response) = self.responses.lock().unwrap().remove(&seq) {
            Ok(response)
        } else {
            Ok(self.read_message()?)
        }
    }

    pub async fn attach(
        &self,
        host: &str,
        port: u16,
    ) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("attach".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(serde_json::json!({
                "host": host,
                "port": port
            })),
        };

        let seq = self.send_message(req)?;
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        if let Some(response) = self.responses.lock().unwrap().remove(&seq) {
            Ok(response)
        } else {
            Ok(self.read_message()?)
        }
    }

    pub async fn configuration_done(&self) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("configurationDone".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: None,
        };

        let seq = self.send_message(req)?;
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        if let Some(response) = self.responses.lock().unwrap().remove(&seq) {
            Ok(response)
        } else {
            Ok(self.read_message()?)
        }
    }
}
