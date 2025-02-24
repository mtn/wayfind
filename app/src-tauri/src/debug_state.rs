use std::process::Child;
use std::sync::Mutex;

// Import your DAPClient type from your debugger client module:
use crate::debugger::client::DAPClient;

pub struct DebugSessionState {
    // Holds the active DAPClient (None until a session is launched)
    pub client: Mutex<Option<DAPClient>>,
    // Holds the active Python process (None until a session is launched)
    pub process: Mutex<Option<Child>>,
}

impl DebugSessionState {
    pub fn new() -> Self {
        DebugSessionState {
            client: Mutex::new(None),
            process: Mutex::new(None),
        }
    }
}
