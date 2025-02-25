use std::net::{SocketAddr, TcpListener};

/// Find a free (available) TCP port starting at `start_port`.
pub fn find_available_port(start_port: u16) -> std::io::Result<u16> {
    let mut port = start_port;
    loop {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
        port = port.saturating_add(1);
    }
}
