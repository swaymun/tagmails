//! Relay push. The daemon keeps one WebSocket to the relay, which sends a
//! notice when mail becomes claimable. While it is connected the watch loop
//! only polls as a slow fallback; without it, the loop polls as before.

use std::error::Error;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

/// How often to claim when push is unavailable.
pub const POLL_EVERY: Duration = Duration::from_secs(15);
/// How often to claim anyway while push is connected, for notices lost in transit.
pub const FALLBACK_EVERY: Duration = Duration::from_secs(600);
/// The relay answers "ping" without waking its Durable Object.
const PING_EVERY: Duration = Duration::from_secs(60);
const SILENCE_LIMIT: Duration = Duration::from_secs(150);
const MAX_BACKOFF: Duration = Duration::from_secs(300);
/// An older relay without push, or a revoked token: try again rarely.
const UNSUPPORTED_BACKOFF: Duration = Duration::from_secs(3600);

pub struct Push {
    connected: Arc<AtomicBool>,
    wake: Receiver<()>,
}

impl Push {
    pub fn start(relay: &str, token: &str) -> Push {
        let (sender, wake) = mpsc::channel();
        let connected = Arc::new(AtomicBool::new(false));
        let url = push_url(relay);
        let token = token.to_owned();
        let flag = connected.clone();
        thread::spawn(move || run(&url, &token, &flag, &sender));
        Push { connected, wake }
    }

    /// Waits for a relay notice, a connection change, or the poll interval.
    pub fn wait(&self) {
        let limit = if self.connected.load(Ordering::Relaxed) { FALLBACK_EVERY } else { POLL_EVERY };
        match self.wake.recv_timeout(limit) {
            Ok(()) => while self.wake.try_recv().is_ok() {},
            Err(RecvTimeoutError::Timeout) => {}
            // The push thread never exits; if it did, keep polling.
            Err(RecvTimeoutError::Disconnected) => thread::sleep(POLL_EVERY),
        }
    }
}

pub fn push_url(relay: &str) -> String {
    let base = relay.trim_end_matches('/');
    let base = match base.strip_prefix("https://") {
        Some(rest) => format!("wss://{rest}"),
        None => base.replacen("http://", "ws://", 1),
    };
    format!("{base}/api/device/push")
}

enum Ended {
    /// The connection was up; reconnect promptly.
    Dropped(String),
    /// Never connected.
    Failed(String),
    Unsupported,
}

fn run(url: &str, token: &str, connected: &AtomicBool, wake: &Sender<()>) {
    let mut backoff = Duration::from_secs(1);
    let mut reported = false;
    loop {
        let ended = session(url, token, connected, wake);
        if connected.swap(false, Ordering::Relaxed) {
            // Switch the watch loop back to regular polling right away.
            let _ = wake.send(());
        }
        let delay = match ended {
            Ended::Dropped(reason) => {
                eprintln!("Relay push disconnected: {reason}");
                reported = false;
                backoff = Duration::from_secs(1);
                backoff
            }
            Ended::Failed(reason) => {
                if !reported {
                    eprintln!("Relay push unavailable, polling instead: {reason}");
                    reported = true;
                }
                backoff = (backoff * 2).min(MAX_BACKOFF);
                backoff
            }
            Ended::Unsupported => UNSUPPORTED_BACKOFF,
        };
        thread::sleep(jitter(delay));
    }
}

fn session(url: &str, token: &str, connected: &AtomicBool, wake: &Sender<()>) -> Ended {
    let mut socket = match open(url, token) {
        Ok(socket) => socket,
        Err(tungstenite::Error::Http(response))
            if matches!(response.status().as_u16(), 401 | 404) =>
        {
            return Ended::Unsupported
        }
        Err(error) => return Ended::Failed(error.to_string()),
    };
    if let Err(error) = set_read_timeout(&socket, PING_EVERY) {
        return Ended::Failed(error.to_string());
    }
    println!("Relay push connected.");
    connected.store(true, Ordering::Relaxed);
    // Claim once: mail may have arrived while disconnected.
    let _ = wake.send(());
    let mut heard = Instant::now();
    let mut pinged = Instant::now();
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                heard = Instant::now();
                if text.as_str() != "pong" {
                    let _ = wake.send(());
                }
            }
            Ok(Message::Close(_)) => return Ended::Dropped("closed by relay".into()),
            Ok(_) => heard = Instant::now(),
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(error) => return Ended::Dropped(error.to_string()),
        }
        if heard.elapsed() >= SILENCE_LIMIT {
            let _ = socket.close(None);
            return Ended::Dropped("no reply from relay".into());
        }
        if pinged.elapsed() >= PING_EVERY {
            pinged = Instant::now();
            if let Err(error) = socket.send(Message::text("ping")) {
                return Ended::Dropped(error.to_string());
            }
        }
    }
}

fn open(url: &str, token: &str) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, tungstenite::Error> {
    let mut request = url.into_client_request()?;
    let value = format!("Bearer {token}")
        .parse()
        .map_err(|_| tungstenite::Error::Url(tungstenite::error::UrlError::UnableToConnect("invalid token".into())))?;
    request.headers_mut().insert("authorization", value);
    let (socket, _) = tungstenite::connect(request)?;
    Ok(socket)
}

fn set_read_timeout(
    socket: &WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    let stream = match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => stream,
        MaybeTlsStream::Rustls(stream) => stream.get_ref(),
        _ => return Err("Unexpected relay push stream".into()),
    };
    stream.set_read_timeout(Some(timeout))?;
    Ok(())
}

/// Spreads reconnects so computers do not all return at once after a relay deploy.
fn jitter(delay: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.subsec_nanos())
        .unwrap_or(0);
    delay + delay.mul_f64(f64::from(nanos % 1000) / 4000.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_url_follows_the_relay_scheme() {
        assert_eq!(
            push_url("https://relay.example.dev/"),
            "wss://relay.example.dev/api/device/push"
        );
        assert_eq!(
            push_url("http://127.0.0.1:8787"),
            "ws://127.0.0.1:8787/api/device/push"
        );
    }

    #[test]
    fn jitter_adds_at_most_a_quarter() {
        let delay = Duration::from_secs(8);
        let spread = jitter(delay);
        assert!(spread >= delay && spread <= delay + Duration::from_secs(2));
    }
}
