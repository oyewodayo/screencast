// Lets a phone act as a Briefcast camera with nothing installed on either side.
//
// Why this exists at all: get_connected_devices (commands/recording/win.rs) can only ever report
// DirectShow devices, and a phone is not one - it appears to Windows as an MTP storage device, if
// it appears at all. Every off-the-shelf answer (DroidCam, Iriun, Camo) is really just a virtual
// *camera driver* that fabricates a DirectShow device for the phone to feed. This module gets the
// same result without asking the user to install a driver, by inverting where the capture happens:
// the phone's own browser is the capture device.
//
// The shape of it:
//
//   phone browser  --getUserMedia-->  WebRTC  ------------------->  desktop WebView2
//        |                                                               ^
//        +-- wss://<lan-ip>:<port>/ws --> THIS MODULE (relay) --> Tauri event
//
// This server is only ever a signalling relay plus a static file host. Once the peer connection
// is established the video goes phone -> PC directly; not a single frame passes through here.
// That matters: relaying media in Rust would have meant a full WebRTC stack (webrtc-rs, depacketi-
// sation, jitter buffering), whereas the desktop WebView is already a complete Chromium that can
// simply BE the peer.
//
// Why HTTPS with a generated cert rather than a plain socket: getUserMedia is gated to secure
// contexts. `http://192.168.x.x:port` is not one and never can be (only `localhost` gets the
// exemption, and the phone is by definition not localhost), so the phone would have no camera API
// at all over plain http. A self-signed cert costs the user a one-time "not private -> proceed"
// tap and is the only way to hand a phone browser a usable camera on a LAN address.

use std::net::{IpAddr, SocketAddr, TcpListener};
use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::header,
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use axum_server::tls_rustls::RustlsConfig;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex};

// The phone-facing page, inlined at compile time so there's no runtime asset path to resolve and
// nothing extra to ship in the bundle. See the file itself for what it does.
const PHONE_PAGE: &str = include_str!("phone_camera_page.html");

// First port tried; if it's taken we walk upward. 8443 is the conventional "alternate https"
// port, which matters because some phone browsers quietly distrust https on unusual ports.
const BASE_PORT: u16 = 8443;
const PORT_ATTEMPTS: u16 = 12;

// The device name the frontend puts in FormData.video_devices to mean "the phone", and which
// commands/recording.rs strips back out before any of it reaches ffmpeg. Deliberately not a
// plausible DirectShow friendly name so it can never collide with a real camera.
pub const PHONE_DEVICE_SENTINEL: &str = "__briefcast_phone_camera__";

// What the frontend needs in order to render the pairing panel.
#[derive(Clone, Serialize)]
pub struct PhoneCameraInfo {
    pub url: String,
    pub host: String,
    pub port: u16,
    // Pre-rendered QR of `url`. Built here rather than in the frontend purely to avoid adding a
    // JS QR dependency for the one place in the app that needs one.
    pub qr_svg: String,
    // Other addresses this machine is reachable on, for when the auto-detected one is a virtual
    // adapter the phone cannot route to - see lan_addresses. Each carries its own QR so switching
    // is one click rather than a retype.
    pub alternatives: Vec<PhoneCameraAddress>,
    pub phone_connected: bool,
}

#[derive(Clone, Serialize)]
pub struct PhoneCameraAddress {
    pub url: String,
    pub host: String,
    pub qr_svg: String,
}

#[derive(Deserialize)]
struct WsQuery {
    #[serde(default)]
    role: String,
}

// Everything the running server owns. Kept behind a Mutex in PhoneCameraState below.
struct RunningServer {
    info: PhoneCameraInfo,
    shutdown: axum_server::Handle,
}

#[derive(Clone)]
struct AppCtx {
    app_handle: AppHandle,
    // Sender into whichever phone socket is currently connected. `None` whenever no phone is
    // paired. Only one phone at a time is supported by design - a second connection replaces the
    // first rather than being queued, which is what "I picked up the wrong phone" should do.
    phone_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
}

#[derive(Default)]
pub struct PhoneCameraState {
    running: Mutex<Option<RunningServer>>,
    phone_tx: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
}

// Every address the phone might plausibly be able to dial, best guess first.
//
// A single auto-detected address isn't good enough in practice. A dev machine typically has
// several IPv4 interfaces - this one has WSL (172.23.128.1) and a Hyper-V Default Switch
// (192.168.192.1) alongside the actual Wi-Fi adapter - and every one of them looks like an
// ordinary private LAN address from the outside. local_ip() follows the default route and so
// usually picks correctly, but when it doesn't the failure is silent and total: the phone simply
// cannot reach the host, with nothing on screen to suggest why. So the alternatives are collected
// too, the certificate covers all of them, and the pairing panel can offer the others.
//
// Excluded: loopback (the phone is not localhost) and link-local 169.254.x (APIPA - an adapter
// that failed to get a DHCP lease, i.e. not on a working network at all).
fn lan_addresses() -> Result<Vec<IpAddr>, String> {
    let usable = |ip: &IpAddr| match ip {
        IpAddr::V4(v4) => !v4.is_loopback() && !v4.is_link_local(),
        // IPv6 is skipped entirely: the URL would need bracket syntax, and any phone that can
        // reach an IPv6 host here can reach the IPv4 one too.
        IpAddr::V6(_) => false,
    };

    let mut addresses: Vec<IpAddr> = Vec::new();

    // The default-route interface first - right in the overwhelming majority of cases.
    if let Ok(primary) = local_ip_address::local_ip() {
        if usable(&primary) {
            addresses.push(primary);
        }
    }

    if let Ok(interfaces) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in interfaces {
            if usable(&ip) && !addresses.contains(&ip) {
                addresses.push(ip);
            }
        }
    }

    if addresses.is_empty() {
        return Err(
            "Briefcast couldn't find a network connection to share with your phone. Connect this \
             computer to Wi-Fi (or to your phone's hotspot) and try again."
                .to_string(),
        );
    }
    Ok(addresses)
}

// Finds a free port by actually binding it, rather than probing and hoping - the listener is
// dropped immediately, so there's a harmless race window, but a bind failure at serve time is
// reported to the user anyway.
fn pick_port() -> Result<u16, String> {
    for offset in 0..PORT_ATTEMPTS {
        let port = BASE_PORT + offset;
        if TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).is_ok() {
            return Ok(port);
        }
    }
    Err(format!(
        "No free port available in the range {}-{} for the phone camera server.",
        BASE_PORT,
        BASE_PORT + PORT_ATTEMPTS - 1
    ))
}

// A fresh self-signed cert covering the LAN IP, generated per server start.
//
// It is deliberately NOT cached across runs. Caching would let the phone's stored exception stick
// between sessions, but the cert is only valid for the IP baked into it, and a laptop's DHCP lease
// changes often enough that a stale cached cert would fail in a way ("your connection is not
// private", again, but now unfixable by proceeding) that is far more confusing than re-accepting.
// Generation costs single-digit milliseconds, so there's nothing to save.
fn generate_cert(ips: &[IpAddr]) -> Result<(Vec<u8>, Vec<u8>), String> {
    // Every candidate is a SAN, so switching to an alternative address in the pairing panel
    // does not produce a *second*, different certificate error on top of the expected one.
    let mut names: Vec<String> = ips.iter().map(|ip| ip.to_string()).collect();
    names.push("localhost".to_string());
    let certified = rcgen::generate_simple_self_signed(names)
        .map_err(|e| format!("Failed to generate a certificate for the phone camera server: {e}"))?;
    Ok((
        certified.cert.pem().into_bytes(),
        certified.key_pair.serialize_pem().into_bytes(),
    ))
}

fn render_qr(url: &str) -> String {
    use qrcode::{render::svg, QrCode};
    match QrCode::new(url) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(200, 200)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        // A missing QR degrades to "type the URL by hand", which the panel also shows.
        Err(_) => String::new(),
    }
}

async fn serve_page() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // The page is regenerated per build; never let a phone pin an old copy.
            (header::CACHE_CONTROL, "no-store"),
        ],
        PHONE_PAGE,
    )
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(ctx): State<AppCtx>,
) -> Response {
    ws.on_upgrade(move |socket| handle_phone_socket(socket, ctx, q.role))
}

// One connected phone. Reads signalling messages off the socket and forwards them to the desktop
// as Tauri events; writes back whatever phone_camera_send_signal pushes into the channel.
async fn handle_phone_socket(socket: WebSocket, ctx: AppCtx, role: String) {
    if role != "phone" {
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    // Kept so the cleanup below can tell "the shared slot is still mine" from "a second phone
    // replaced me". Identity, not liveness: checking is_closed() there would race the writer
    // task's abort, and a stale sender left in the slot makes phone_camera_status claim a phone
    // is connected when none is.
    let my_tx = tx.clone();
    *ctx.phone_tx.lock().await = Some(tx);

    let _ = ctx.app_handle.emit("phone-camera-state", "connected");
    log::info!("Phone camera: phone connected");

    use futures_util::{SinkExt, StreamExt};
    let (mut sink, mut stream) = socket.split();

    // Desktop -> phone. Runs until the channel closes (server shutting down) or the socket errors.
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // Phone -> desktop. Signalling payloads are relayed opaquely: this module never parses SDP or
    // ICE, it only moves strings between the two peers that actually understand them.
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                let _ = ctx.app_handle.emit("phone-camera-signal", text);
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    writer.abort();
    // Only clear the shared sender if it's still ours - a second phone connecting will have
    // replaced it, and that newer session must not be torn down by this one finishing.
    {
        let mut guard = ctx.phone_tx.lock().await;
        if guard.as_ref().map(|s| s.same_channel(&my_tx)).unwrap_or(false) {
            *guard = None;
        }
    }
    let _ = ctx.app_handle.emit("phone-camera-state", "disconnected");
    log::info!("Phone camera: phone disconnected");
}

// Starts the pairing server, or returns the already-running one's details if it's up.
//
// Idempotent on purpose: the frontend calls this every time the pairing panel opens, and
// reopening the panel must not tear down a phone that's already streaming.
#[tauri::command]
pub async fn start_phone_camera_server(
    app_handle: AppHandle,
    state: tauri::State<'_, PhoneCameraState>,
) -> Result<PhoneCameraInfo, String> {
    {
        let running = state.running.lock().await;
        if let Some(server) = running.as_ref() {
            let mut info = server.info.clone();
            info.phone_connected = state.phone_tx.lock().await.is_some();
            return Ok(info);
        }
    }

    let addresses = lan_addresses()?;
    let ip = addresses[0];
    let port = pick_port()?;
    let (cert_pem, key_pem) = generate_cert(&addresses)?;

    let tls = RustlsConfig::from_pem(cert_pem, key_pem)
        .await
        .map_err(|e| format!("Failed to configure TLS for the phone camera server: {e}"))?;

    let ctx = AppCtx {
        app_handle: app_handle.clone(),
        phone_tx: state.phone_tx.clone(),
    };

    let router = Router::new()
        .route("/", get(serve_page))
        .route("/ws", get(ws_upgrade))
        .with_state(ctx);

    let handle = axum_server::Handle::new();
    let serve_handle = handle.clone();
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    // Spawned onto Tauri's own runtime rather than a bare thread so it shares the app's reactor
    // and dies with it.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum_server::bind_rustls(addr, tls)
            .handle(serve_handle)
            .serve(router.into_make_service())
            .await
        {
            log::error!("Phone camera server stopped: {e}");
        }
    });

    let url = format!("https://{ip}:{port}/");
    let alternatives = addresses
        .iter()
        .skip(1)
        .map(|alt| {
            let alt_url = format!("https://{alt}:{port}/");
            PhoneCameraAddress {
                qr_svg: render_qr(&alt_url),
                url: alt_url,
                host: alt.to_string(),
            }
        })
        .collect();

    let info = PhoneCameraInfo {
        qr_svg: render_qr(&url),
        url,
        host: ip.to_string(),
        port,
        alternatives,
        phone_connected: false,
    };

    *state.running.lock().await = Some(RunningServer {
        info: info.clone(),
        shutdown: handle,
    });

    log::info!("Phone camera server listening on {}:{}", ip, port);
    Ok(info)
}

#[tauri::command]
pub async fn stop_phone_camera_server(
    state: tauri::State<'_, PhoneCameraState>,
) -> Result<(), String> {
    if let Some(server) = state.running.lock().await.take() {
        // Gives an in-flight phone socket a moment to close cleanly instead of resetting it.
        server
            .shutdown
            .graceful_shutdown(Some(std::time::Duration::from_millis(300)));
    }
    *state.phone_tx.lock().await = None;
    Ok(())
}

#[tauri::command]
pub async fn phone_camera_status(
    state: tauri::State<'_, PhoneCameraState>,
) -> Result<Option<PhoneCameraInfo>, String> {
    let running = state.running.lock().await;
    match running.as_ref() {
        Some(server) => {
            let mut info = server.info.clone();
            info.phone_connected = state.phone_tx.lock().await.is_some();
            Ok(Some(info))
        }
        None => Ok(None),
    }
}

// Desktop -> phone half of the signalling relay. `payload` is an already-serialised JSON string
// (an answer or an ICE candidate); this module doesn't inspect it, same as the phone -> desktop
// direction in handle_phone_socket.
#[tauri::command]
pub async fn phone_camera_send_signal(
    state: tauri::State<'_, PhoneCameraState>,
    payload: String,
) -> Result<(), String> {
    let guard = state.phone_tx.lock().await;
    match guard.as_ref() {
        Some(tx) => tx
            .send(payload)
            .map_err(|_| "The phone disconnected before the message could be sent.".to_string()),
        None => Err("No phone is currently connected.".to_string()),
    }
}
