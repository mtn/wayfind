use socket2::{Domain, Protocol, Socket, Type};
use std::io;
use std::net::{Ipv4Addr, SocketAddrV4};

pub fn find_available_port(start_port: u16) -> io::Result<u16> {
    let mut port = start_port;
    loop {
        // Create an IPv4 TCP socket.
        let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
        // Disable address reuse so lingering CLOSE_WAIT connections block new binds.
        socket.set_reuse_address(false)?;

        let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
        // Convert to a socket2 SockAddr.
        let sock_addr = socket2::SockAddr::from(addr);
        if socket.bind(&sock_addr).is_ok() {
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
