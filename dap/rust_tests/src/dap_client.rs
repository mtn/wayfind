use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;
use std::fmt;
use std::io::{BufReader, ErrorKind, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq)]
pub enum MessageType {
    Request,
    Response,
    Event,
}

// Manually implement Serialize so that the variants are always lower-case.
impl Serialize for MessageType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let s = match *self {
            MessageType::Request => "request",
            MessageType::Response => "response",
            MessageType::Event => "event",
        };
        serializer.serialize_str(s)
    }
}

struct MessageTypeVisitor;

impl<'de> Visitor<'de> for MessageTypeVisitor {
    type Value = MessageType;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a string representing a message type")
    }

    fn visit_str<E>(self, value: &str) -> Result<MessageType, E>
    where
        E: de::Error,
    {
        match value {
            "request" => Ok(MessageType::Request),
            "response" => Ok(MessageType::Response),
            "event" => Ok(MessageType::Event),
            _ => Err(de::Error::unknown_variant(
                value,
                &["request", "response", "event"],
            )),
        }
    }
}

impl<'de> Deserialize<'de> for MessageType {
    fn deserialize<D>(deserializer: D) -> Result<MessageType, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_str(MessageTypeVisitor)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DAPMessage {
    pub seq: i32,
    #[serde(rename = "type")]
    pub message_type: MessageType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_seq: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Value>,
}

pub struct DAPClient {
    writer: Option<Arc<Mutex<TcpStream>>>,
    // We keep an Arc of the BufReader ensure the receiver thread is the only one that reads.
    reader: Option<Arc<Mutex<BufReader<TcpStream>>>>,
    next_seq: Arc<Mutex<i32>>,
    // Responses are added by the receiver thread after reading from the socket.
    responses: Arc<Mutex<HashMap<i32, DAPMessage>>>,
    events: Arc<Mutex<HashMap<String, Vec<DAPMessage>>>>,
    receiver_handle: Option<thread::JoinHandle<()>>,
}

impl DAPClient {
    pub fn new() -> Self {
        Self {
            writer: None,
            reader: None,
            next_seq: Arc::new(Mutex::new(1)),
            responses: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(Mutex::new(HashMap::new())),
            receiver_handle: None,
        }
    }

    pub fn connect(&mut self, host: &str, port: u16) -> std::io::Result<()> {
        let stream = TcpStream::connect((host, port))?;
        // Note: We clone the stream so that writer and reader can be used on separate handles.
        self.writer = Some(Arc::new(Mutex::new(stream.try_clone()?)));
        self.reader = Some(Arc::new(Mutex::new(BufReader::new(stream))));
        Ok(())
    }

    /// Sends a DAP message. Returns the assigned sequence number.
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

        let mut writer = self.writer.as_ref().unwrap().lock().unwrap();
        writer.write_all(header.as_bytes())?;
        writer.write_all(json.as_bytes())?;
        writer.flush()?;
        Ok(seq)
    }

    /// Starts a background receiver thread which is the only code that reads the socket.
    pub fn start_receiver(&mut self) {
        // Clone the Arcs needed by the receiver thread.
        let reader_arc = Arc::clone(self.reader.as_ref().unwrap());
        let responses_arc = Arc::clone(&self.responses);
        let events_arc = Arc::clone(&self.events);

        self.receiver_handle = Some(thread::spawn(move || {
            loop {
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
                    match serde_json::from_str::<DAPMessage>(&message_str) {
                        Ok(msg) => match msg.message_type {
                            MessageType::Response => {
                                if let Some(req_seq) = msg.request_seq {
                                    responses_arc.lock().unwrap().insert(req_seq, msg);
                                }
                            }
                            MessageType::Event => {
                                if let Some(evt) = &msg.event {
                                    events_arc
                                        .lock()
                                        .unwrap()
                                        .entry(evt.clone())
                                        .or_insert_with(Vec::new)
                                        .push(msg);
                                }
                            }
                            _ => {}
                        },
                        Err(e) => {
                            eprintln!("Error parsing message: {}", e);
                        }
                    }
                } else {
                    eprintln!("No Content-Length found in header: {}", header);
                }
                // Don't busy‐spin.
                thread::sleep(Duration::from_millis(10));
            }
        }));
    }

    /// Waits for an event (by name) until the timeout (in seconds) expires.
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

    /// Waits asynchronously for a response with the given sequence number.
    pub async fn wait_for_response(&self, seq: i32, timeout_secs: f64) -> Option<DAPMessage> {
        let start = Instant::now();
        while start.elapsed().as_secs_f64() < timeout_secs {
            if let Some(resp) = self.responses.lock().unwrap().remove(&seq) {
                return Some(resp);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        None
    }

    // Now the DAP commands use only send_message and wait_for_response.
    pub async fn initialize(&self) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
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
                "supportsEvaluateForHovers": true,
            })),
            body: None,
            event: None,
        };

        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for initialize response".into())
        }
    }

    pub fn attach(&self, host: &str, port: u16) -> std::io::Result<()> {
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
        // Send the message and do not wait for a response.
        self.send_message(req)?;
        Ok(())
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
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for configurationDone response".into())
        }
    }

    pub async fn set_breakpoints(
        &self,
        file_path: &str,
        line_numbers: &[i32],
    ) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("setBreakpoints".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(serde_json::json!({
                "source": {
                    "path": file_path,
                    "name": std::path::Path::new(file_path).file_name().unwrap().to_str().unwrap()
                },
                "breakpoints": line_numbers.iter().map(|&line| serde_json::json!({ "line": line })).collect::<Vec<_>>(),
                "sourceModified": false
            })),
        };

        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for setBreakpoints response".into())
        }
    }

    pub async fn stack_trace(
        &self,
        thread_id: i32,
    ) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("stackTrace".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(serde_json::json!({
                "threadId": thread_id,
                "startFrame": 0,
                "levels": 1
            })),
        };

        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for stackTrace response".into())
        }
    }

    pub async fn evaluate(
        &self,
        expression: &str,
        frame_id: Option<i32>,
    ) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let mut args = serde_json::json!({
            "expression": expression,
            "context": "hover"
        });

        if let Some(id) = frame_id {
            if let serde_json::Value::Object(ref mut map) = args {
                map.insert("frameId".to_string(), serde_json::json!(id));
            }
        }

        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("evaluate".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(args),
        };

        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for evaluate response".into())
        }
    }

    pub async fn continue_execution(
        &self,
        thread_id: i32,
    ) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("continue".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(serde_json::json!({
                "threadId": thread_id
            })),
        };

        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for continue response".into())
        }
    }

    pub async fn step_in(
        &self,
        thread_id: i32,
        target_id: Option<i32>,
        granularity: &str,
    ) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let mut args = serde_json::json!({
            "threadId": thread_id,
            "granularity": granularity
        });

        if let Some(id) = target_id {
            if let serde_json::Value::Object(ref mut map) = args {
                map.insert("targetId".to_string(), serde_json::json!(id));
            }
        }

        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("stepIn".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(args),
        };

        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for stepIn response".into())
        }
    }

    pub async fn next(&self, thread_id: i32) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("next".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(serde_json::json!({
                "threadId": thread_id
            })),
        };

        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for next response".into())
        }
    }

    pub async fn step_out(
        &self,
        thread_id: i32,
        granularity: &str,
    ) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let req = DAPMessage {
            seq: -1,
            message_type: MessageType::Request,
            command: Some("stepOut".to_string()),
            request_seq: None,
            success: None,
            body: None,
            event: None,
            arguments: Some(serde_json::json!({
                "threadId": thread_id,
                "granularity": granularity
            })),
        };

        let seq = self.send_message(req)?;
        if let Some(response) = self.wait_for_response(seq, 10.0).await {
            Ok(response)
        } else {
            Err("Timeout waiting for stepOut response".into())
        }
    }
}
