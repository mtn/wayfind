use parking_lot::RwLock;
use std::process::Child;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::Mutex;

// Import your updated DAPClient from your debugger client module.
use crate::debugger::client::DAPClient;

#[derive(Debug, Clone, PartialEq)]
pub enum DebuggerState {
    NotStarted,
    Configuring,
    Running,
    Paused { reason: String, thread_id: i64 },
    Terminated,
}

pub struct DebugSessionState {
    pub client: Mutex<Option<DAPClient>>,
    pub process: Mutex<Option<Child>>,
    // Wrap in Arc
    pub status_seq: Arc<AtomicU64>,
    pub state: RwLock<DebuggerState>,
}

impl DebugSessionState {
    pub fn new() -> Self {
        DebugSessionState {
            client: Mutex::new(None),
            process: Mutex::new(None),
            // Initialize as Arc
            status_seq: Arc::new(AtomicU64::new(0)),
            state: RwLock::new(DebuggerState::NotStarted),
        }
    }

    pub fn handle_dap_event(&self, msg: &crate::debugger::client::DAPMessage) {
        let mut guard = self.state.write();
        if msg.message_type == crate::debugger::client::MessageType::Event {
            if let Some(ref event_name) = msg.event {
                match event_name.as_str() {
                    "initialized" => {
                        *guard = DebuggerState::Configuring;
                    }
                    "continued" => {
                        *guard = DebuggerState::Running;
                    }
                    "stopped" => {
                        if let Some(body) = &msg.body {
                            let reason = body
                                .get("reason")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown")
                                .to_string();
                            let thread_id =
                                body.get("threadId").and_then(|v| v.as_i64()).unwrap_or(1);
                            *guard = DebuggerState::Paused { reason, thread_id };
                        }
                    }
                    "terminated" => {
                        *guard = DebuggerState::Terminated;
                    }
                    _ => {}
                }
            }
        }
    }

    pub fn handle_configuration_done(&self) {
        let mut guard = self.state.write();
        *guard = DebuggerState::Running;
    }
}
