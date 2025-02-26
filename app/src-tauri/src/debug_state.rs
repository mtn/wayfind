use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

// Import your updated DAPClient from your debugger client module.
use crate::debugger::client::DAPClient;

pub struct DebugSessionState {
    pub client: Mutex<Option<DAPClient>>,
    pub process: Mutex<Option<Child>>,
    // Wrap in Arc
    pub status_seq: Arc<AtomicU64>,
}

impl DebugSessionState {
    pub fn new() -> Self {
        DebugSessionState {
            client: Mutex::new(None),
            process: Mutex::new(None),
            // Initialize as Arc
            status_seq: Arc::new(AtomicU64::new(0)),
        }
    }

    // Get the next sequence number for status updates
    pub fn next_status_seq(&self) -> u64 {
        self.status_seq.fetch_add(1, Ordering::SeqCst)
    }
}
