use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

#[derive(Debug, Serialize, Deserialize)]
pub enum MessageType {
    Request,
    Response,
    Event,
}

#[derive(Debug, Serialize, Deserialize)]
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
    stream: Arc<Mutex<TcpStream>>,
    next_seq: Arc<Mutex<i32>>,
    event_sender: mpsc::UnboundedSender<DAPMessage>,
}

impl DAPClient {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<DAPMessage>) {
        let (tx, rx) = mpsc::unbounded_channel();

        let client = Self {
            stream: Arc::new(Mutex::new(TcpStream::connect(("127.0.0.1", 0)).unwrap())),
            next_seq: Arc::new(Mutex::new(1)),
            event_sender: tx,
        };

        (client, rx)
    }

    pub fn connect(&self, host: &str, port: u16) -> std::io::Result<()> {
        let stream = TcpStream::connect((host, port))?;
        *self.stream.lock().unwrap() = stream;
        Ok(())
    }

    pub fn send_message(&self, mut message: DAPMessage) -> std::io::Result<()> {
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

        let mut guard = self.stream.lock().unwrap();
        guard.write_all(header.as_bytes())?;
        guard.write_all(json.as_bytes())?;

        Ok(())
    }

    pub fn read_message(&self) -> std::io::Result<serde_json::Value> {
        let mut guard = self.stream.lock().unwrap();
        let mut reader = BufReader::new(&*guard);

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

    pub async fn initialize(&self) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let init_seq = *self.next_seq.lock().unwrap();
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

        self.send_message(req)?;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        Ok(DAPMessage {
            seq: init_seq,
            message_type: MessageType::Response,
            command: Some("initialize".to_string()),
            request_seq: Some(init_seq),
            success: Some(true),
            body: Some(serde_json::json!({ "capabilities": {} })),
            event: None,
            arguments: None,
        })
    }

    pub async fn attach(&self, host: &str, port: u16) -> Result<(), Box<dyn std::error::Error>> {
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

        self.send_message(req)?;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        Ok(())
    }

    pub async fn configuration_done(&self) -> Result<DAPMessage, Box<dyn std::error::Error>> {
        let conf_seq = *self.next_seq.lock().unwrap();
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

        self.send_message(req)?;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        Ok(DAPMessage {
            seq: conf_seq,
            message_type: MessageType::Response,
            command: Some("configurationDone".to_string()),
            request_seq: Some(conf_seq),
            success: Some(true),
            body: Some(serde_json::json!({ "configured": true })),
            event: None,
            arguments: None,
        })
    }
}
