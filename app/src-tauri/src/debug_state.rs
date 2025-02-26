use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::Mutex;

// Import your updated DAPClient from your debugger client module.
use crate::debugger::client::DAPClient;

pub struct DebugSessionState {
    // Holds the active DAPClient (None until a session is launched).
    pub client: Mutex<Option<DAPClient>>,
    // Holds the active Python process (None until a session is launched).
    pub process: Mutex<Option<Child>>,
    // Sequence counter for status updates to handle race conditions
    pub status_seq: AtomicU64,
}

impl DebugSessionState {
    pub fn new() -> Self {
        DebugSessionState {
            client: Mutex::new(None),
            process: Mutex::new(None),
            status_seq: AtomicU64::new(0),
        }
    }

    // Get the next sequence number for status updates
    pub fn next_status_seq(&self) -> u64 {
        self.status_seq.fetch_add(1, Ordering::SeqCst)
    }
}
