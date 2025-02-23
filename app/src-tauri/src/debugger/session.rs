use super::client::DAPClient;
use rand::Rng;
use std::collections::HashMap;
use std::sync::Mutex;

pub struct DebugSession {
    pub token: String,
    pub client: DAPClient,
    pub python_process: std::process::Child,
    pub configuration_done_sent: bool,
}

pub struct SessionManager {
    sessions: Mutex<HashMap<String, DebugSession>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn create_session(&self, client: DAPClient, process: std::process::Child) -> String {
        let token = self.generate_token();
        let session = DebugSession {
            token: token.clone(),
            client,
            python_process: process,
            configuration_done_sent: false,
        };

        self.sessions.lock().unwrap().insert(token.clone(), session);
        token
    }

    fn generate_token(&self) -> String {
        let mut rng = rand::thread_rng();
        let token: String = (0..16).map(|_| format!("{:x}", rng.gen::<u8>())).collect();
        token
    }

    pub fn get_session(&self, token: &str) -> Option<&DebugSession> {
        self.sessions.lock().unwrap().get(token)
    }

    pub fn remove_session(&self, token: &str) {
        if let Some(mut session) = self.sessions.lock().unwrap().remove(token) {
            let _ = session.python_process.kill();
        }
    }
}
