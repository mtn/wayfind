use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

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
    reader: Option<Arc<Mutex<BufReader<TcpStream>>>>,
    next_seq: Arc<Mutex<i32>>,
    responses: Arc<Mutex<HashMap<i32, DAPMessage>>>,
    events: Arc<Mutex<HashMap<String, Vec<DAPMessage>>>>,
    receiver_handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}

impl DAPClient {
    pub fn new() -> Self {
        Self {
            writer: None,
            reader: None,
            next_seq: Arc::new(Mutex::new(1)),
            responses: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(Mutex::new(HashMap::new())),
            receiver_handle: Arc::new(Mutex::new(None)),
        }
    }

    pub fn connect(&mut self, host: &str, port: u16) -> std::io::Result<()> {
        let stream = TcpStream::connect((host, port))?;
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

    /// Starts a background receiver thread that continuously reads messages.
    pub fn start_receiver(&self) {
        let reader_arc = Arc::clone(self.reader.as_ref().unwrap());
        let responses_arc = Arc::clone(&self.responses);
        let events_arc = Arc::clone(&self.events);

        let handle = thread::spawn(move || {
            loop {
                let maybe_msg = {
                    let mut reader = reader_arc.lock().unwrap();
                    let mut header = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            break;
                        }
                        header.push_str(&line);
                        if line == "\r\n" {
                            break;
                        }
                    }
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
                };

                if let Some(msg) = maybe_msg {
                    match msg.message_type {
                        MessageType::Response => {
                            if let Some(req_seq) = msg.request_seq {
                                responses_arc.lock().unwrap().insert(req_seq, msg);
                            }
                        }
                        MessageType::Event => {
                            if let Some(event_name) = &msg.event {
                                events_arc
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
        let mut reader = self.reader.as_ref().unwrap().lock().unwrap();
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
    }

    // Updated initialize: using "arguments" instead of "body".
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
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;

        if let Some(response) = self.responses.lock().unwrap().remove(&seq) {
            Ok(response)
        } else {
            Ok(self.read_message()?)
        }
    }

    // The attach and configuration_done methods can remain unchanged.
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
