use std::net::TcpListener;

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

pub fn parse_lldb_result(result: &str) -> String {
    use regex::Regex;

    // Try several patterns to extract the actual value from LLDB output

    // Pattern 1: Full LLDB output with command
    let re1 = Regex::new(r"\(lldb\).*\n\(\w+\)\s+\$\d+\s+=\s+(.+)").unwrap();
    if let Some(caps) = re1.captures(result) {
        return caps[1].trim().to_string();
    }

    // Pattern 2: Just the result part
    let re2 = Regex::new(r"\(\w+\)\s+\$\d+\s+=\s+(.+)").unwrap();
    if let Some(caps) = re2.captures(result) {
        return caps[1].trim().to_string();
    }

    // If no patterns match, return the original result
    result.trim().to_string()
}
