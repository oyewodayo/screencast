// transfer.rs — Serves the standalone Briefcast Transfer Pro PWA (https://transfer.briefcast.app)
// and hosts the lightweight WebRTC Phone-to-Phone signaling broker (/p2p/ws) on the exact same
// VPS process and Cloudflare Tunnel already running briefcast-lan-certs.
//
// Privacy guarantee: ZERO file bytes ever pass through this server. The WebSocket only exchanges
// tiny JSON presence lists and WebRTC SDP/ICE handshakes between phones sharing the same public
// Wi-Fi IP or an explicit 6-digit room code; actual transfers stream directly phone-to-phone
// over DTLS-encrypted WebRTC DataChannels.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Path, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde_json::json;
use tokio::sync::mpsc;

const PAGE: &str = include_str!(concat!(env!("OUT_DIR"), "/pwa/phone_transfer_page.html"));
const MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/pwa/phone_transfer_manifest.json"));
const SW: &str = include_str!(concat!(env!("OUT_DIR"), "/pwa/phone_transfer_sw.js"));
const STUDIO: &str = include_str!(concat!(env!("OUT_DIR"), "/pwa/phone_transfer_studio.js"));
const P2P: &str = include_str!(concat!(env!("OUT_DIR"), "/pwa/phone_transfer_p2p.js"));
const ICON_192: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pwa/icons/icon-192.png"));
const ICON_512: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pwa/icons/icon-512.png"));
const ICON_MASKABLE: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pwa/icons/maskable-512.png"));
const LOGO: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/pwa/icons/logo-96.png"));

const MAX_SIGNAL_BYTES: usize = 65_536;
const IDLE_TIMEOUT: Duration = Duration::from_secs(50);

struct Peer {
    id: String,
    name: String,
    platform: String,
    ip_bucket: String,
    room: Option<String>,
    tx: mpsc::UnboundedSender<String>,
}

struct P2pHub {
    trust_proxy: bool,
    peers: Mutex<HashMap<String, Peer>>,
}

impl P2pHub {
    fn new(trust_proxy: bool) -> Self {
        Self { trust_proxy, peers: Mutex::new(HashMap::new()) }
    }

    fn visible_for(peers: &HashMap<String, Peer>, me: &Peer) -> Vec<serde_json::Value> {
        peers
            .values()
            .filter(|other| other.id != me.id && Self::can_see(me, other))
            .map(|other| {
                let shared_room = me.room.as_ref().filter(|r| other.room.as_ref() == Some(*r)).cloned();
                json!({
                    "id": other.id,
                    "name": other.name,
                    "platform": other.platform,
                    "room": shared_room,
                })
            })
            .collect()
    }

    fn can_see(a: &Peer, b: &Peer) -> bool {
        if let (Some(ra), Some(rb)) = (&a.room, &b.room) {
            if ra == rb {
                return true;
            }
        }
        !a.ip_bucket.is_empty() && a.ip_bucket == b.ip_bucket
    }

    fn broadcast_related(&self, ip_bucket: &str, room_a: Option<&str>, room_b: Option<&str>) {
        let peers = self.peers.lock().unwrap();
        for peer in peers.values() {
            let related = (!ip_bucket.is_empty() && peer.ip_bucket == ip_bucket)
                || room_a.is_some() && peer.room.as_deref() == room_a
                || room_b.is_some() && peer.room.as_deref() == room_b;
            if related {
                let visible = Self::visible_for(&peers, peer);
                let _ = peer.tx.send(json!({ "type": "peers", "peers": visible }).to_string());
            }
        }
    }
}

pub fn router(trust_proxy: bool) -> Router {
    let hub = Arc::new(P2pHub::new(trust_proxy));
    Router::new()
        .route("/", get(serve_page))
        .route("/ping", get(ping))
        .route("/health", get(ping))
        .route("/manifest.webmanifest", get(manifest))
        .route("/sw.js", get(service_worker))
        .route("/studio.js", get(studio))
        .route("/p2p.js", get(p2p_script))
        .route("/icons/:name", get(icon))
        .route("/share", post(share_fallback))
        .route("/p2p/ws", get(p2p_ws_upgrade))
        .with_state(hub)
}

fn static_asset(content_type: &'static str, body: &'static [u8]) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

async fn serve_page() -> Response {
    static_asset("text/html; charset=utf-8", PAGE.as_bytes())
}

async fn ping() -> impl IntoResponse {
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        "ok",
    )
}

async fn manifest() -> Response {
    static_asset("application/manifest+json", MANIFEST.as_bytes())
}

async fn service_worker() -> Response {
    static_asset("text/javascript; charset=utf-8", SW.as_bytes())
}

async fn studio() -> Response {
    static_asset("text/javascript; charset=utf-8", STUDIO.as_bytes())
}

async fn p2p_script() -> Response {
    static_asset("text/javascript; charset=utf-8", P2P.as_bytes())
}

async fn icon(Path(name): Path<String>) -> Response {
    match name.as_str() {
        "icon-192.png" => static_asset("image/png", ICON_192),
        "icon-512.png" => static_asset("image/png", ICON_512),
        "maskable-512.png" => static_asset("image/png", ICON_MASKABLE),
        "logo-96.png" => static_asset("image/png", LOGO),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn share_fallback() -> Response {
    (StatusCode::SEE_OTHER, [(header::LOCATION, "/?share=unavailable")]).into_response()
}

fn extract_ip_bucket(trust_proxy: bool, headers: &HeaderMap, peer: SocketAddr) -> String {
    if trust_proxy {
        if let Some(ip) = headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<IpAddr>().ok())
        {
            return ip.to_string();
        }
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .and_then(|s| s.trim().parse::<IpAddr>().ok())
        {
            return ip.to_string();
        }
    }
    peer.ip().to_string()
}

fn clean_label(raw: &str, fallback: &str) -> String {
    let s: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect::<String>()
        .trim()
        .to_string();
    if s.is_empty() { fallback.to_string() } else { s }
}

fn gen_peer_id() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 8] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn gen_room_code() -> String {
    let mut rng = rand::thread_rng();
    format!("{:06}", rng.gen_range(100_000..=999_999u32))
}

async fn p2p_ws_upgrade(
    ws: WebSocketUpgrade,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(hub): State<Arc<P2pHub>>,
) -> Response {
    let ip_bucket = extract_ip_bucket(hub.trust_proxy, &headers, addr);
    ws.on_upgrade(move |socket| p2p_session(socket, hub, ip_bucket))
}

async fn p2p_session(socket: WebSocket, hub: Arc<P2pHub>, ip_bucket: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let peer_id = gen_peer_id();

    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    let initial_peers = {
        let mut peers = hub.peers.lock().unwrap();
        let me = Peer {
            id: peer_id.clone(),
            name: "Phone".into(),
            platform: "Device".into(),
            ip_bucket: ip_bucket.clone(),
            room: None,
            tx: tx.clone(),
        };
        let visible = P2pHub::visible_for(&peers, &me);
        peers.insert(peer_id.clone(), me);
        visible
    };
    let _ = tx.send(json!({ "type": "welcome", "id": peer_id, "peers": initial_peers }).to_string());
    hub.broadcast_related(&ip_bucket, None, None);

    loop {
        let msg = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        if text.len() > MAX_SIGNAL_BYTES {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("ping") => {
                let _ = tx.send(json!({ "type": "pong" }).to_string());
            }
            Some("hello") => {
                let name = clean_label(v.get("name").and_then(|s| s.as_str()).unwrap_or(""), "Phone");
                let platform = clean_label(v.get("platform").and_then(|s| s.as_str()).unwrap_or(""), "Device");
                let room = {
                    let mut peers = hub.peers.lock().unwrap();
                    if let Some(p) = peers.get_mut(&peer_id) {
                        p.name = name;
                        p.platform = platform;
                        p.room.clone()
                    } else {
                        None
                    }
                };
                hub.broadcast_related(&ip_bucket, room.as_deref(), None);
            }
            Some("room.create") => {
                let code = gen_room_code();
                let old_room = {
                    let mut peers = hub.peers.lock().unwrap();
                    if let Some(p) = peers.get_mut(&peer_id) {
                        let prev = p.room.replace(code.clone());
                        prev
                    } else {
                        None
                    }
                };
                let _ = tx.send(json!({ "type": "room.created", "code": code }).to_string());
                hub.broadcast_related(&ip_bucket, old_room.as_deref(), Some(&code));
            }
            Some("room.join") => {
                let code: String = v
                    .get("code")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .chars()
                    .filter(|c| c.is_ascii_digit())
                    .take(6)
                    .collect();
                if code.len() != 6 {
                    let _ = tx.send(json!({ "type": "room.error", "error": "Enter a 6-digit code" }).to_string());
                    continue;
                }
                let old_room = {
                    let mut peers = hub.peers.lock().unwrap();
                    if let Some(p) = peers.get_mut(&peer_id) {
                        p.room.replace(code.clone())
                    } else {
                        None
                    }
                };
                let _ = tx.send(json!({ "type": "room.joined", "code": code }).to_string());
                hub.broadcast_related(&ip_bucket, old_room.as_deref(), Some(&code));
            }
            Some("room.leave") => {
                let old_room = {
                    let mut peers = hub.peers.lock().unwrap();
                    peers.get_mut(&peer_id).and_then(|p| p.room.take())
                };
                hub.broadcast_related(&ip_bucket, old_room.as_deref(), None);
            }
            Some("signal") => {
                let Some(to) = v.get("to").and_then(|s| s.as_str()) else { continue };
                let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);
                let peers = hub.peers.lock().unwrap();
                let (Some(src), Some(dst)) = (peers.get(&peer_id), peers.get(to)) else { continue };
                // Only relay signals between peers that are allowed to see each other (same Wi-Fi IP or same room).
                if !P2pHub::can_see(src, dst) {
                    continue;
                }
                let _ = dst.tx.send(
                    json!({
                        "type": "signal",
                        "from": src.id,
                        "fromName": src.name,
                        "fromPlatform": src.platform,
                        "data": data,
                    })
                    .to_string(),
                );
            }
            _ => {}
        }
    }

    writer.abort();
    let old_room = {
        let mut peers = hub.peers.lock().unwrap();
        peers.remove(&peer_id).and_then(|p| p.room)
    };
    hub.broadcast_related(&ip_bucket, old_room.as_deref(), None);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_peer(id: &str, ip: &str, room: Option<&str>) -> Peer {
        let (tx, _rx) = mpsc::unbounded_channel();
        Peer {
            id: id.into(),
            name: id.into(),
            platform: "Android".into(),
            ip_bucket: ip.into(),
            room: room.map(str::to_string),
            tx,
        }
    }

    #[test]
    fn visibility_enforces_same_ip_or_same_room() {
        let a = dummy_peer("a", "203.0.113.10", None);
        let b = dummy_peer("b", "203.0.113.10", None);
        let c = dummy_peer("c", "198.51.100.7", None);
        let d = dummy_peer("d", "198.51.100.7", Some("482910"));
        let e = dummy_peer("e", "203.0.113.99", Some("482910"));

        assert!(P2pHub::can_see(&a, &b));
        assert!(!P2pHub::can_see(&a, &c));
        assert!(!P2pHub::can_see(&a, &d));
        assert!(P2pHub::can_see(&d, &e));
    }

    #[test]
    fn room_codes_are_six_digits() {
        for _ in 0..20 {
            let code = gen_room_code();
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_digit()));
        }
    }
}
