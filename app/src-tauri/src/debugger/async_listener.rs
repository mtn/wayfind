use std::error::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::net::TcpStream;

/// Connects to a TCP address and continuously reads DAP messages.
/// It expects messages to be framed with a “Content-Length: …\r\n\r\n” header.
pub async fn async_listen_debugpy(addr: &str) -> Result<(), Box<dyn Error>> {
    // Connect asynchronously to the debugpy socket.
    println!("Connecting to {}", addr);
    let stream = TcpStream::connect(addr).await?;
    let mut reader = BufReader::new(stream);

    loop {
        // Read header lines until an empty line (i.e. "\r\n") is encountered.
        let mut header = String::new();
        loop {
            let mut line = String::new();
            let bytes_read = reader.read_line(&mut line).await?;
            if bytes_read == 0 {
                // End of stream.
                return Ok(());
            }
            if line.trim().is_empty() {
                break;
            }
            header.push_str(&line);
        }

        // Extract Content-Length. (Case‐insensitive match.)
        let content_length = header.lines().find_map(|l| {
            if l.to_lowercase().starts_with("content-length:") {
                l["content-length:".len()..].trim().parse::<usize>().ok()
            } else {
                None
            }
        });

        let content_length = match content_length {
            Some(len) => len,
            None => {
                eprintln!("No content length found in header:\n{}", header);
                continue;
            }
        };

        // Read exactly content_length bytes for the JSON message.
        let mut body_buf = vec![0u8; content_length];
        reader.read_exact(&mut body_buf).await?;

        let msg_str = std::str::from_utf8(&body_buf)?;
        println!("(Async listener) Received message: {}", msg_str);
    }
}
