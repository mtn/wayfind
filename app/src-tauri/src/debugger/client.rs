use serde::{Deserialize, Serialize};
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
            stream: Arc::new(Mutex::new(TcpStream::connect("127.0.0.1:0").unwrap())), // placeholder
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

        let mut stream = self.stream.lock().unwrap();
        stream.write_all(header.as_bytes())?;
        stream.write_all(json.as_bytes())?;

        Ok(())
    }
}
