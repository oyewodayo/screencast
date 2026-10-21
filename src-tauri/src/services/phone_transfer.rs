// "Transfer to phone": sends files from Briefcast straight to a phone on the same network, with
// nothing installed on the phone and no cable, cloud upload or account in between.
//
// The shape of it is the same inversion phone_camera.rs uses - the phone's own browser is the
// client, and Briefcast is the web server it talks to:
//
//   desktop UI --phone_transfer_send--> THIS MODULE --ws offer--> phone page
//                                            ^                        |
//                                            +---- GET /f/<offer> ----+  (the file itself)
//
// The bytes go over one plain HTTP response straight off the disk, so a transfer runs at whatever
// the Wi-Fi link can carry - nothing is re-encoded, buffered whole in memory or relayed anywhere.
//
// How it differs from the phone camera, on purpose:
//
// - Encrypted from the first byte when it can be. With a trusted certificate (lan_tls.rs) the QR
//   points straight at https://192-168-1-5.<install>.<zone>, so the page itself - not just the
//   files - arrives over TLS and can't be tampered with on the way. Plain HTTP still exists for
//   networks where that name can't work, but only behind a separate, clearly labelled
//   "unencrypted" choice on the desktop: never as a silent fallback.
// - Pairing is deliberate. The pairing key in the QR works once and expires after a few minutes,
//   and a new phone isn't trusted until someone approves it on the computer, with a matching code
//   shown on both screens - so a photo of the QR taken across a meeting room is useless.
// - There's a record. Pairings, removals and every finished transfer go to a local history file.
// - Phones are remembered. Pairing mints a device id + token the phone keeps in localStorage and
//   Briefcast keeps in phone_transfer_devices.json, so the next transfer is "pick the phone" rather
//   than "scan again". The server also starts at launch whenever a phone has been paired, so a
//   phone that still has the page open reconnects on its own.
// - Both directions. The phone page's "Send to computer" streams files up to /u, and they land in
//   the library's "From phone" folder - byte for byte, the same as the other direction.
// - Several phones at once, and offline delivery: sending to a phone whose page isn't open right
//   now queues the file, and it's offered the moment the page reconnects (mobile browsers drop the
//   socket whenever the tab is backgrounded or the screen locks, so this is the common case).

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum_server::tls_rustls::RustlsConfig;
use axum::{
    body::{Body, Bytes},
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Extension, Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use super::lan_tls;
use super::phone_camera::{key_matches, lan_addresses, pairing_key, render_qr};

const PHONE_PAGE: &str = include_str!("phone_transfer_page.html");

// A fixed port (walked upward only if taken) rather than a random one: the phone page's
// localStorage - where its device token lives - is scoped to the origin, port included, so a port
// that changed every launch would make every phone forget it was ever paired.
const BASE_PORT: u16 = 47321;
const PORT_ATTEMPTS: u16 = 12;
// The HTTPS twin of the same server, fixed for the same reason.
const TLS_BASE_PORT: u16 = 47341;

// Big enough that a fast 5GHz link isn't bottlenecked on per-chunk overhead, small enough that
// progress still moves smoothly on a slow one.
const CHUNK: usize = 1 << 20;

// The phone page pings every 10s. A phone that locks its screen usually vanishes without a TCP
// close, so without this it would be listed as connected indefinitely.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

// Sent down a session's channel to make its writer close the socket - used when the same phone
// connects again (a second tab, a reload) and when the desktop forgets the phone.
const CLOSE_SENTINEL: &str = "\u{0}close";

// Where files sent from a phone land, inside the Briefcast folder - so the file watcher puts them
// straight into the sidebar like any other library file.
pub(crate) const INBOX_FOLDER: &str = "From phone";

// How long a QR code's pairing key works, and how long a new phone waits for someone to approve it.
const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(2 * 60);

// Which listener a request came in on - routes are shared, so the handlers are told.
#[derive(Clone, Copy)]
struct Secure(bool);

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    token: String,
    name: String,
    platform: String,
    last_seen: u64,
}

// The desktop's view of a paired phone - Device minus the token.
#[derive(Clone, Serialize)]
pub struct PhoneDevice {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub online: bool,
    // Whether its current connection is HTTPS. Meaningless while offline.
    pub secure: bool,
    pub last_seen: u64,
}

// One address this machine can be reached on, as both the encrypted QR (when this install has a
// certificate) and the plain-HTTP one the desktop only reveals on request.
#[derive(Clone, Serialize)]
pub struct PhoneTransferAddress {
    pub host: String,
    pub secure_url: Option<String>,
    pub secure_qr: Option<String>,
    pub plain_url: String,
    pub plain_qr: String,
}

#[derive(Clone, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Encryption {
    Ready,
    // Fetching this install's certificate.
    Pending,
    Unavailable { reason: String },
}

#[derive(Clone, Serialize)]
pub struct PhoneTransferInfo {
    // Best guess first - see lan_addresses in phone_camera.rs for why there can be several, and
    // why the first is sometimes a virtual adapter the phone can't route to.
    pub addresses: Vec<PhoneTransferAddress>,
    pub devices: Vec<PhoneDevice>,
    pub encryption: Encryption,
    // When the QR codes above stop working; the dialog fetches fresh ones then.
    pub expires_in_secs: u64,
}

// A phone that scanned a QR code and is waiting for someone at the computer to let it in.
#[derive(Clone, Serialize)]
pub struct PairRequest {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub code: String,
    pub secure: bool,
}

// One line of the local transfer history.
#[derive(Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub at: u64,
    // "sent" | "received" | "receive_failed" | "paired" | "pair_denied" | "removed"
    pub kind: String,
    pub device: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
    pub secure: bool,
    #[serde(default)]
    pub detail: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferState {
    // The phone isn't connected; the offer goes out when it is.
    Queued,
    // The phone has the offer and is about to (or can) download it.
    Offered,
    Sending,
    Done,
    // The download stopped partway - the phone can tap Save again to retry.
    Interrupted,
}

#[derive(Clone, Serialize)]
pub struct TransferStatus {
    pub offer_id: String,
    pub device_id: String,
    pub name: String,
    pub size: u64,
    pub sent: u64,
    pub state: TransferState,
}

struct Offer {
    seq: u64,
    device_id: String,
    path: PathBuf,
    name: String,
    size: u64,
    sent: u64,
    state: TransferState,
    // Whether this offer has ever reached the phone's page. The page downloads fresh offers
    // automatically; ones it has already seen are only listed again (after a reload, say).
    delivered: bool,
}

impl Offer {
    fn status(&self, offer_id: &str) -> TransferStatus {
        TransferStatus {
            offer_id: offer_id.to_string(),
            device_id: self.device_id.clone(),
            name: self.name.clone(),
            size: self.size,
            sent: self.sent,
            state: self.state,
        }
    }
}

// The HTTPS listener, once lan_tls has a certificate for this install.
#[derive(Clone)]
struct TlsListener {
    port: u16,
    install_id: String,
    zone: String,
}

struct Session {
    id: u64,
    tx: mpsc::UnboundedSender<String>,
    secure: bool,
}

struct PairingKey {
    key: String,
    issued: Instant,
    used: bool,
}

impl PairingKey {
    fn usable(&self) -> bool {
        !self.used && self.issued.elapsed() < PAIRING_TTL
    }
}

// Everything the server tasks and the commands share. Plain std mutexes: every critical section is
// a few map operations, and none is ever held across an await.
#[derive(Default)]
struct Hub {
    devices: Mutex<Vec<Device>>,
    sessions: Mutex<HashMap<String, Session>>,
    offers: Mutex<HashMap<String, Offer>>,
    key: Mutex<Option<PairingKey>>,
    // New phones waiting for approval, by request id.
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    store: Mutex<Option<PathBuf>>,
    history: Mutex<Option<PathBuf>>,
    tls: Mutex<Option<TlsListener>>,
    encryption: Mutex<Option<Encryption>>,
    seq: AtomicU64,
}

#[derive(Default)]
pub struct PhoneTransferState {
    hub: Arc<Hub>,
    // The plain-HTTP port, once the server is up.
    server: tokio::sync::Mutex<Option<u16>>,
}

#[derive(Clone)]
struct Ctx {
    hub: Arc<Hub>,
    app: AppHandle,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// 128 bits for anything that grants access (device tokens); 64 is plenty for ids.
fn token() -> String {
    format!("{}{}", pairing_key(), pairing_key())
}

fn computer_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| "Briefcast".to_string())
}

// Coarse on purpose: modern Android Chrome reports "Android 10; K" in place of the real model, and
// the model hint API needs a secure context this page doesn't have. The phone can rename itself.
fn platform_from_ua(ua: &str) -> &'static str {
    if ua.contains("iPhone") {
        "iphone"
    } else if ua.contains("iPad") || (ua.contains("Macintosh") && ua.contains("Mobile")) {
        "ipad"
    } else if ua.contains("Android") {
        "android"
    } else {
        "other"
    }
}

fn default_name(platform: &str) -> &'static str {
    match platform {
        "iphone" => "iPhone",
        "ipad" => "iPad",
        "android" => "Android phone",
        _ => "Phone",
    }
}

fn clean_name(name: &str) -> String {
    name.trim().chars().filter(|c| !c.is_control()).take(40).collect()
}

impl Hub {
    fn device_list(&self) -> Vec<PhoneDevice> {
        let sessions = self.sessions.lock().unwrap();
        let mut list: Vec<PhoneDevice> = self
            .devices
            .lock()
            .unwrap()
            .iter()
            .map(|d| PhoneDevice {
                id: d.id.clone(),
                name: d.name.clone(),
                platform: d.platform.clone(),
                online: sessions.contains_key(&d.id),
                secure: sessions.get(&d.id).map(|s| s.secure).unwrap_or(false),
                last_seen: d.last_seen,
            })
            .collect();
        list.sort_by(|a, b| b.online.cmp(&a.online).then(b.last_seen.cmp(&a.last_seen)));
        list
    }

    fn send_to(&self, device_id: &str, msg: String) -> bool {
        match self.sessions.lock().unwrap().get(device_id) {
            Some(session) => session.tx.send(msg).is_ok(),
            None => false,
        }
    }

    fn offer_message(offer_id: &str, offer: &Offer, fresh: bool) -> String {
        json!({
            "type": "offer",
            "id": offer_id,
            "name": offer.name,
            "size": offer.size,
            "mime": mime_for(&offer.name),
            "state": offer.state,
            "fresh": fresh,
        })
        .to_string()
    }

    // Returns true when this call is what finished the transfer.
    fn set_state(&self, app: &AppHandle, offer_id: &str, sent: u64, state: TransferState) -> bool {
        let (status, finished) = {
            let mut offers = self.offers.lock().unwrap();
            let Some(offer) = offers.get_mut(offer_id) else { return false };
            // A finished transfer stays finished: the phone opening the file again afterwards, or
            // a byte-range probe some browsers make, must not drag it back to "sending".
            if offer.state == TransferState::Done {
                return false;
            }
            offer.sent = sent;
            offer.state = state;
            (offer.status(offer_id), state == TransferState::Done)
        };
        if matches!(state, TransferState::Done | TransferState::Interrupted) {
            let msg = json!({ "type": "status", "id": offer_id, "state": state }).to_string();
            self.send_to(&status.device_id, msg);
        }
        let _ = app.emit("phone-transfer-progress", status);
        finished
    }

    fn device_name(&self, device_id: &str) -> String {
        self.devices
            .lock()
            .unwrap()
            .iter()
            .find(|d| d.id == device_id)
            .map(|d| d.name.clone())
            .unwrap_or_else(|| "Phone".to_string())
    }

    // The current pairing key, minting a fresh one if it has been used or has expired.
    fn current_key(&self) -> (String, Duration) {
        let mut key = self.key.lock().unwrap();
        if !key.as_ref().map(PairingKey::usable).unwrap_or(false) {
            *key = Some(PairingKey { key: pairing_key(), issued: Instant::now(), used: false });
        }
        let k = key.as_ref().unwrap();
        (k.key.clone(), PAIRING_TTL.saturating_sub(k.issued.elapsed()))
    }

    // Spends the pairing key: true only for the first use of a current, unexpired key.
    fn take_key(&self, given: &str) -> bool {
        let mut key = self.key.lock().unwrap();
        match key.as_mut() {
            Some(k) if !given.is_empty() && k.usable() && key_matches(given, &k.key) => {
                k.used = true;
                true
            }
            _ => false,
        }
    }

    fn encryption(&self) -> Encryption {
        self.encryption.lock().unwrap().clone().unwrap_or_else(|| {
            if lan_tls::configured() {
                Encryption::Pending
            } else {
                Encryption::Unavailable { reason: "This copy of Briefcast isn't set up for encrypted transfers.".into() }
            }
        })
    }

    async fn persist(&self) {
        let Some(path) = self.store.lock().unwrap().clone() else { return };
        let body = match serde_json::to_vec_pretty(&*self.devices.lock().unwrap()) {
            Ok(body) => body,
            Err(_) => return,
        };
        if let Some(dir) = path.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        if let Err(e) = tokio::fs::write(&path, body).await {
            log::warn!("Phone transfer: couldn't save paired phones: {e}");
        }
    }
}

fn emit_devices(ctx: &Ctx) {
    let _ = ctx.app.emit("phone-transfer-devices", ctx.hub.device_list());
}

// Appends to phone_transfer_history.jsonl and tells the desktop. Fire-and-forget: a history write
// failing must never fail the transfer it describes.
fn record(hub: &Arc<Hub>, app: &AppHandle, entry: HistoryEntry) {
    let _ = app.emit("phone-transfer-history", entry.clone());
    let Some(path) = hub.history.lock().unwrap().clone() else { return };
    tauri::async_runtime::spawn(async move {
        let Ok(mut line) = serde_json::to_string(&entry) else { return };
        line.push('\n');
        let file = tokio::fs::OpenOptions::new().create(true).append(true).open(&path).await;
        if let Ok(mut file) = file {
            let _ = file.write_all(line.as_bytes()).await;
        }
    });
}

// For transfers that don't go through this server (usb_phone.rs) but belong in the same record.
// A USB cable is a direct physical link, so those count as secure.
pub(crate) fn record_local(app: &AppHandle, kind: &str, device: &str, name: &str, size: u64) {
    let state = app.state::<PhoneTransferState>();
    let hub = state.hub.clone();
    if hub.history.lock().unwrap().is_none() {
        *hub.history.lock().unwrap() = store_path(app).map(|p| p.with_file_name("phone_transfer_history.jsonl"));
    }
    let mut entry = history_entry(kind, device.to_string(), true);
    entry.name = Some(name.to_string());
    entry.size = Some(size);
    entry.detail = Some("USB cable".to_string());
    record(&hub, app, entry);
}

fn history_entry(kind: &str, device: String, secure: bool) -> HistoryEntry {
    HistoryEntry { at: now_ms(), kind: kind.to_string(), device, name: None, size: None, secure, detail: None }
}

// Something on the pairing panel changed (a key was spent, encryption became ready): the dialog
// fetches fresh info.
fn emit_info_changed(app: &AppHandle) {
    let _ = app.emit("phone-transfer-info-changed", ());
}

fn build_info(hub: &Hub, port: u16) -> Result<PhoneTransferInfo, String> {
    let (key, expires_in) = hub.current_key();
    let tls = hub.tls.lock().unwrap().clone();
    let addresses = lan_addresses()?
        .into_iter()
        .map(|ip| {
            let plain_url = format!("http://{ip}:{port}/#k={key}");
            let secure_url = match (&tls, ip) {
                (Some(tls), std::net::IpAddr::V4(v4)) => lan_tls::host_for(v4, &tls.install_id, &tls.zone)
                    .map(|host| format!("https://{host}:{}/#k={key}", tls.port)),
                _ => None,
            };
            PhoneTransferAddress {
                host: ip.to_string(),
                secure_qr: secure_url.as_deref().map(render_qr),
                secure_url,
                plain_qr: render_qr(&plain_url),
                plain_url,
            }
        })
        .collect();
    Ok(PhoneTransferInfo {
        addresses,
        devices: hub.device_list(),
        encryption: hub.encryption(),
        expires_in_secs: expires_in.as_secs(),
    })
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("phone_transfer_devices.json"))
}

fn mime_for(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "m4a" | "aac" => "audio/mp4",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

// RFC 6266: an ASCII fallback for old clients plus the exact UTF-8 name for everyone else.
fn content_disposition(name: &str, inline: bool) -> String {
    let fallback: String = name
        .chars()
        .map(|c| if c.is_ascii() && !c.is_ascii_control() && c != '"' && c != '\\' { c } else { '_' })
        .collect();
    format!(
        "{}; filename=\"{}\"; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        fallback,
        urlencoding::encode(name)
    )
}

// Parses a single-range `Range` header into an inclusive (start, end). Ok(None) means "no usable
// range, send the whole file"; Err means the range can't be satisfied (416). Multi-range requests
// are answered with the whole file, which the spec allows and no download manager relies on.
fn parse_range(header: Option<&str>, size: u64) -> Result<Option<(u64, u64)>, ()> {
    let Some(spec) = header.and_then(|h| h.trim().strip_prefix("bytes=")) else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None);
    }
    let (start, end) = spec.split_once('-').ok_or(())?;
    let (start, end) = (start.trim(), end.trim());
    if size == 0 {
        return Err(());
    }
    let range = if start.is_empty() {
        let suffix: u64 = end.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start: u64 = start.parse().map_err(|_| ())?;
        let end: u64 = if end.is_empty() { size - 1 } else { end.parse::<u64>().map_err(|_| ())?.min(size - 1) };
        if start > end || start >= size {
            return Err(());
        }
        (start, end)
    };
    Ok(Some(range))
}

async fn serve_page() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        PHONE_PAGE,
    )
}

// Lets the page tell "Briefcast refused me" (reachable, but my token is no good) from "Briefcast
// isn't running" (unreachable) after a socket closes before it was welcomed - a WebSocket close
// carries no HTTP status to tell them apart.
//
// Also how the HTTP page checks the HTTPS name really works from the phone before moving there -
// a cross-origin fetch, hence the CORS header.
async fn ping() -> impl IntoResponse {
    (
        [(header::CACHE_CONTROL, "no-store"), (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")],
        "ok",
    )
}

// Where the HTTP page should try HTTPS: the trusted name for whichever address the phone itself
// used to reach us (the Host header), since that's the one known to be routable from the phone.
async fn tls_target(headers: HeaderMap, State(ctx): State<Ctx>) -> Response {
    let Some(tls) = ctx.hub.tls.lock().unwrap().clone() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ip = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.rsplit_once(':').map(|(ip, _)| ip).or(Some(h)))
        .and_then(|ip| ip.parse::<std::net::Ipv4Addr>().ok());
    match ip.and_then(|ip| lan_tls::host_for(ip, &tls.install_id, &tls.zone)) {
        Some(host) => (
            [(header::CACHE_CONTROL, "no-store")],
            axum::Json(json!({ "https": format!("https://{host}:{}", tls.port) })),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

// Keeps this install's certificate current and serves the same routes over HTTPS with it. Checks
// twice a day; a failure (offline, service down) is shown on the pairing panel and retried later.
// Starts with the server itself - the QR code needs the certificate before the first phone pairs.
async fn run_tls(ctx: Ctx, router: Router) {
    if !lan_tls::configured() {
        return;
    }
    let set = |encryption: Encryption| {
        let changed = {
            let mut current = ctx.hub.encryption.lock().unwrap();
            let changed = current.as_ref() != Some(&encryption);
            *current = Some(encryption);
            changed
        };
        if changed {
            emit_info_changed(&ctx.app);
        }
    };
    let mut config: Option<RustlsConfig> = None;
    loop {
        let wait = match lan_tls::ensure(&ctx.app).await {
            Ok(None) => return,
            Ok(Some(material)) => {
                let (cert, key) = (material.cert_pem.into_bytes(), material.key_pem.into_bytes());
                match &config {
                    Some(existing) => {
                        if let Err(e) = existing.reload_from_pem(cert, key).await {
                            log::warn!("Phone transfer: couldn't load the renewed certificate: {e}");
                        }
                    }
                    None => match start_tls_listener(router.clone(), cert, key).await {
                        Ok((started, port)) => {
                            config = Some(started);
                            *ctx.hub.tls.lock().unwrap() = Some(TlsListener {
                                port,
                                install_id: material.install_id.clone(),
                                zone: material.zone.clone(),
                            });
                            set(Encryption::Ready);
                            log::info!("Phone transfer: HTTPS on port {port}");
                        }
                        Err(e) => {
                            log::warn!("Phone transfer: HTTPS listener failed: {e}");
                            set(Encryption::Unavailable { reason: format!("Couldn't start the encrypted connection: {e}") });
                        }
                    },
                }
                Duration::from_secs(12 * 3600)
            }
            Err(e) => {
                log::warn!("Phone transfer: no LAN certificate yet: {}", e.message);
                // A certificate already being served stays valid until it expires - only report a
                // problem while there's no encrypted listener at all.
                if config.is_none() {
                    set(Encryption::Unavailable { reason: e.message.clone() });
                }
                // Never hammer the service, never wait more than a day.
                e.retry_after
                    .unwrap_or(Duration::from_secs(3600))
                    .clamp(Duration::from_secs(600), Duration::from_secs(86400))
            }
        };
        tokio::time::sleep(wait).await;
    }
}

async fn start_tls_listener(router: Router, cert: Vec<u8>, key: Vec<u8>) -> Result<(RustlsConfig, u16), String> {
    let config = RustlsConfig::from_pem(cert, key).await.map_err(|e| e.to_string())?;
    let (listener, port) = (TLS_BASE_PORT..TLS_BASE_PORT + PORT_ATTEMPTS)
        .find_map(|port| std::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).ok().map(|l| (l, port)))
        .ok_or("no free port for HTTPS")?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let server = axum_server::from_tcp_rustls(listener, config.clone());
    let router = router.layer(Extension(Secure(true)));
    tauri::async_runtime::spawn(async move {
        if let Err(e) = server.serve(router.into_make_service()).await {
            log::error!("Phone transfer HTTPS server stopped: {e}");
        }
    });
    Ok((config, port))
}

#[derive(Deserialize)]
struct WsQuery {
    #[serde(default)]
    d: String,
    #[serde(default)]
    t: String,
    #[serde(default)]
    k: String,
    #[serde(default)]
    n: String,
}

enum Auth {
    Known(String),
    New,
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    headers: HeaderMap,
    Extension(Secure(secure)): Extension<Secure>,
    State(ctx): State<Ctx>,
) -> Response {
    // A known device's own token wins over the pairing key, so rescanning a QR with a phone that's
    // already paired doesn't create a duplicate entry for it.
    let known = {
        let devices = ctx.hub.devices.lock().unwrap();
        devices
            .iter()
            .find(|d| !q.d.is_empty() && d.id == q.d && key_matches(&q.t, &d.token))
            .map(|d| d.id.clone())
    };
    let auth = match known {
        Some(id) => Auth::Known(id),
        // Spent here, on first use - a second phone scanning the same code gets nowhere.
        None if ctx.hub.take_key(&q.k) => {
            emit_info_changed(&ctx.app);
            Auth::New
        }
        None => {
            log::warn!("Phone transfer: refused a connection without a valid pairing key or token");
            return StatusCode::FORBIDDEN.into_response();
        }
    };
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    ws.on_upgrade(move |socket| handle_socket(socket, ctx, auth, ua, q.n, secure))
}

type PhoneStream = futures_util::stream::SplitStream<WebSocket>;

// A phone that scanned a valid QR: show it a code, ask the desktop, wait. Nothing is trusted -
// no device record, no token - until someone at the computer says yes.
async fn approve_new_phone(
    ctx: &Ctx,
    tx: &mpsc::UnboundedSender<String>,
    stream: &mut PhoneStream,
    ua: &str,
    name_hint: &str,
    secure: bool,
) -> Option<Device> {
    use futures_util::StreamExt;
    let platform = platform_from_ua(ua);
    let hint = clean_name(name_hint);
    let name = if hint.is_empty() { default_name(platform).to_string() } else { hint };
    let request = PairRequest {
        id: pairing_key(),
        name: name.clone(),
        platform: platform.to_string(),
        code: format!("{:04}", u64::from_str_radix(&pairing_key(), 16).unwrap_or(0) % 10_000),
        secure,
    };

    let (decide, mut decision) = oneshot::channel::<bool>();
    ctx.hub.pending.lock().unwrap().insert(request.id.clone(), decide);
    let _ = tx.send(json!({ "type": "confirm", "code": request.code }).to_string());
    let _ = ctx.app.emit("phone-transfer-pair-request", request.clone());

    let deadline = tokio::time::sleep(APPROVAL_TIMEOUT);
    tokio::pin!(deadline);
    let approved = loop {
        tokio::select! {
            answer = &mut decision => break answer.unwrap_or(false),
            _ = &mut deadline => break false,
            // The phone giving up (page closed) withdraws the request.
            msg = stream.next() => match msg {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break false,
                Some(Ok(_)) => continue,
            },
        }
    };
    ctx.hub.pending.lock().unwrap().remove(&request.id);
    let _ = ctx.app.emit("phone-transfer-pair-resolved", request.id.clone());

    if !approved {
        record(&ctx.hub, &ctx.app, history_entry("pair_denied", name, secure));
        let _ = tx.send(json!({ "type": "denied" }).to_string());
        return None;
    }
    let device = Device {
        id: pairing_key(),
        token: token(),
        name,
        platform: platform.to_string(),
        last_seen: now_ms(),
    };
    ctx.hub.devices.lock().unwrap().push(device.clone());
    ctx.hub.persist().await;
    record(&ctx.hub, &ctx.app, history_entry("paired", device.name.clone(), secure));
    log::info!("Phone transfer: paired a new {}", device.platform);
    Some(device)
}

async fn handle_socket(socket: WebSocket, ctx: Ctx, auth: Auth, ua: String, name_hint: String, secure: bool) {
    use futures_util::{SinkExt, StreamExt};
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if text == CLOSE_SENTINEL {
                let _ = sink.send(Message::Close(None)).await;
                break;
            }
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    let device = match auth {
        Auth::Known(id) => {
            let found = {
                let mut devices = ctx.hub.devices.lock().unwrap();
                devices.iter_mut().find(|d| d.id == id).map(|d| {
                    d.last_seen = now_ms();
                    d.clone()
                })
            };
            match found {
                Some(d) => d,
                // Forgotten between the upgrade and now.
                None => {
                    writer.abort();
                    return;
                }
            }
        }
        Auth::New => match approve_new_phone(&ctx, &tx, &mut stream, &ua, &name_hint, secure).await {
            Some(device) => device,
            None => {
                // The writer delivers the "denied" message, then closes the socket.
                let _ = tx.send(CLOSE_SENTINEL.to_string());
                return;
            }
        },
    };

    let session_id = ctx.hub.seq.fetch_add(1, Ordering::Relaxed);
    let _ = tx.send(
        json!({
            "type": "welcome",
            "device": { "id": device.id, "token": device.token, "name": device.name },
            "host": computer_name(),
            "secure": secure,
        })
        .to_string(),
    );

    // Everything already sent to this phone in this run, oldest first: queued offers go out now,
    // and a reloaded page gets its list back.
    let pending: Vec<(String, bool)> = {
        let mut offers = ctx.hub.offers.lock().unwrap();
        let mut mine: Vec<(&String, &mut Offer)> =
            offers.iter_mut().filter(|(_, o)| o.device_id == device.id).collect();
        mine.sort_by_key(|(_, o)| o.seq);
        mine.into_iter()
            .map(|(id, offer)| {
                let fresh = !offer.delivered;
                offer.delivered = true;
                if offer.state == TransferState::Queued {
                    offer.state = TransferState::Offered;
                }
                let _ = tx.send(Hub::offer_message(id, offer, fresh));
                (id.clone(), fresh)
            })
            .collect()
    };

    // One live session per phone. A second tab (or a reload racing the old socket's close)
    // replaces the first, which is told why so it doesn't sit there reconnecting.
    if let Some(old) = ctx
        .hub
        .sessions
        .lock()
        .unwrap()
        .insert(device.id.clone(), Session { id: session_id, tx: tx.clone(), secure })
    {
        let _ = old.tx.send(json!({ "type": "replaced" }).to_string());
        let _ = old.tx.send(CLOSE_SENTINEL.to_string());
    }

    for (offer_id, fresh) in pending {
        if fresh {
            let status = ctx.hub.offers.lock().unwrap().get(&offer_id).map(|o| o.status(&offer_id));
            if let Some(status) = status {
                let _ = ctx.app.emit("phone-transfer-progress", status);
            }
        }
    }
    emit_devices(&ctx);
    if let Ok(public) = serde_json::to_value(PhoneDevice {
        id: device.id.clone(),
        name: device.name.clone(),
        platform: device.platform.clone(),
        online: true,
        secure,
        last_seen: device.last_seen,
    }) {
        let _ = ctx.app.emit("phone-transfer-connected", public);
    }

    loop {
        let msg = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(msg))) => msg,
            _ => break,
        };
        let text = match msg {
            Message::Text(text) => text,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        match value.get("type").and_then(|t| t.as_str()) {
            Some("ping") => {
                let _ = tx.send(json!({ "type": "pong" }).to_string());
            }
            Some("rename") => {
                let name = clean_name(value.get("name").and_then(|n| n.as_str()).unwrap_or(""));
                if name.is_empty() {
                    continue;
                }
                if let Some(d) = ctx.hub.devices.lock().unwrap().iter_mut().find(|d| d.id == device.id) {
                    d.name = name.clone();
                }
                ctx.hub.persist().await;
                let _ = tx.send(json!({ "type": "renamed", "name": name }).to_string());
                emit_devices(&ctx);
            }
            _ => {}
        }
    }

    writer.abort();
    let still_mine = {
        let mut sessions = ctx.hub.sessions.lock().unwrap();
        if sessions.get(&device.id).map(|s| s.id == session_id).unwrap_or(false) {
            sessions.remove(&device.id);
            true
        } else {
            false
        }
    };
    if still_mine {
        if let Some(d) = ctx.hub.devices.lock().unwrap().iter_mut().find(|d| d.id == device.id) {
            d.last_seen = now_ms();
        }
        ctx.hub.persist().await;
        emit_devices(&ctx);
    }
}

#[derive(Deserialize)]
struct FileQuery {
    #[serde(default)]
    d: String,
    #[serde(default)]
    t: String,
    #[serde(default)]
    inline: Option<String>,
}

// Counts bytes as the body is pulled and reports them to the desktop. Lives inside the body
// stream, so it's dropped when the response is - a phone cancelling mid-download shows up here as
// a drop before the requested range was finished.
struct Progress {
    ctx: Ctx,
    secure: bool,
    offer_id: String,
    total: u64,
    pos: u64,
    end: u64,
    last_emit: Instant,
    finished: bool,
}

impl Progress {
    fn advance(&mut self, n: u64) {
        self.pos += n;
        if self.pos >= self.total {
            self.finished = true;
            if self.ctx.hub.set_state(&self.ctx.app, &self.offer_id, self.total, TransferState::Done) {
                record_sent(&self.ctx, &self.offer_id, self.secure);
            }
        } else if self.pos >= self.end {
            self.finished = true;
        } else if self.last_emit.elapsed() >= PROGRESS_INTERVAL {
            self.last_emit = Instant::now();
            self.ctx.hub.set_state(&self.ctx.app, &self.offer_id, self.pos, TransferState::Sending);
        }
    }
}

fn record_sent(ctx: &Ctx, offer_id: &str, secure: bool) {
    let offer = ctx.hub.offers.lock().unwrap().get(offer_id).map(|o| (o.device_id.clone(), o.name.clone(), o.size));
    if let Some((device_id, name, size)) = offer {
        let mut entry = history_entry("sent", ctx.hub.device_name(&device_id), secure);
        entry.name = Some(name);
        entry.size = Some(size);
        record(&ctx.hub, &ctx.app, entry);
    }
}

impl Drop for Progress {
    fn drop(&mut self) {
        if !self.finished {
            self.ctx.hub.set_state(&self.ctx.app, &self.offer_id, self.pos, TransferState::Interrupted);
        }
    }
}

async fn serve_file(
    Path(offer_id): Path<String>,
    Query(q): Query<FileQuery>,
    headers: HeaderMap,
    Extension(Secure(secure)): Extension<Secure>,
    State(ctx): State<Ctx>,
) -> Response {
    let authorised = {
        let devices = ctx.hub.devices.lock().unwrap();
        devices.iter().any(|d| d.id == q.d && key_matches(&q.t, &d.token))
    };
    let offer = {
        let offers = ctx.hub.offers.lock().unwrap();
        offers
            .get(&offer_id)
            .filter(|o| authorised && o.device_id == q.d)
            .map(|o| (o.path.clone(), o.name.clone()))
    };
    let Some((path, name)) = offer else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let mut file = match tokio::fs::File::open(&path).await {
        Ok(f) => f,
        Err(_) => return (StatusCode::GONE, "This file is no longer on the computer.").into_response(),
    };
    let size = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => return StatusCode::GONE.into_response(),
    };

    let range = match parse_range(headers.get(header::RANGE).and_then(|v| v.to_str().ok()), size) {
        Ok(r) => r,
        Err(()) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{size}"))
                .body(Body::empty())
                .unwrap_or_else(|_| StatusCode::RANGE_NOT_SATISFIABLE.into_response());
        }
    };
    let (start, end_inclusive) = range.unwrap_or((0, size.saturating_sub(1)));
    let length = if size == 0 { 0 } else { end_inclusive - start + 1 };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    let inline = q.inline.is_some();
    // Previews (the phone page's thumbnails, "Open") aren't the transfer - don't let them move the
    // desktop's progress bar or mark anything done.
    let progress = (!inline).then(|| Progress {
        ctx: ctx.clone(),
        secure,
        offer_id: offer_id.clone(),
        total: size,
        pos: start,
        end: start + length,
        last_emit: Instant::now(),
        finished: size == 0,
    });
    if size == 0 && !inline && ctx.hub.set_state(&ctx.app, &offer_id, 0, TransferState::Done) {
        record_sent(&ctx, &offer_id, secure);
    }

    let stream = futures_util::stream::unfold((file, length, progress), |(mut file, remaining, mut progress)| async move {
        if remaining == 0 {
            return None;
        }
        let mut buf = vec![0u8; (remaining as usize).min(CHUNK)];
        match file.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                if let Some(p) = progress.as_mut() {
                    p.advance(n as u64);
                }
                Some((Ok::<Bytes, std::io::Error>(Bytes::from(buf)), (file, remaining - n as u64, progress)))
            }
            Err(e) => Some((Err(e), (file, 0, progress))),
        }
    });

    let mut response = Response::new(Body::from_stream(stream));
    let h = response.headers_mut();
    if let Ok(v) = HeaderValue::from_str(mime_for(&name)) {
        h.insert(header::CONTENT_TYPE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&content_disposition(&name, inline)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if range.is_some() {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end_inclusive}/{size}")) {
            response.headers_mut().insert(header::CONTENT_RANGE, v);
        }
    }
    response
}

// Phone -> computer. What the desktop hears about each file the phone sends.
#[derive(Clone, Serialize)]
pub struct IncomingStatus {
    pub id: String,
    pub device_id: String,
    pub device_name: String,
    pub name: String,
    pub size: u64,
    pub received: u64,
    // "receiving" | "done" | "failed"
    pub state: &'static str,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct UploadQuery {
    #[serde(default)]
    d: String,
    #[serde(default)]
    t: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    size: u64,
}

// A phone's idea of a file name, made safe to create on Windows: no directories, no characters
// NTFS rejects, no reserved device names, nothing hidden or ending in a dot or space.
pub(crate) fn safe_file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"|?*".contains(c) { '_' } else { c })
        .collect();
    name = name.trim().trim_end_matches(['.', ' ']).to_string();
    if name.is_empty() || name.starts_with('.') {
        name = format!("phone-file{}", name);
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        name = format!("_{name}");
    }
    // Keep the extension when trimming an absurdly long name.
    if name.chars().count() > 150 {
        let (stem, ext) = match name.rfind('.') {
            Some(i) if name.len() - i <= 10 => (name[..i].to_string(), name[i..].to_string()),
            _ => (name.clone(), String::new()),
        };
        name = format!("{}{}", stem.chars().take(150 - ext.chars().count()).collect::<String>(), ext);
    }
    name
}

// "clip.mp4" -> "clip (2).mp4" -> "clip (3).mp4" ... - never overwrites what's already there.
async fn unique_path(dir: &std::path::Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if tokio::fs::metadata(&first).await.is_err() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 2u32;
    loop {
        let candidate = dir.join(format!("{stem} ({n}){ext}"));
        if tokio::fs::metadata(&candidate).await.is_err() {
            return candidate;
        }
        n += 1;
    }
}

fn upload_failed(mut status: IncomingStatus, ctx: &Ctx, secure: bool, msg: String) -> Response {
    log::warn!("Phone transfer: receiving {} failed: {msg}", status.name);
    let mut entry = history_entry("receive_failed", status.device_name.clone(), secure);
    entry.name = Some(status.name.clone());
    entry.size = Some(status.received);
    entry.detail = Some(msg.clone());
    record(&ctx.hub, &ctx.app, entry);
    status.state = "failed";
    status.error = Some(msg.clone());
    let _ = ctx.app.emit("phone-transfer-incoming", status);
    (StatusCode::INTERNAL_SERVER_ERROR, msg).into_response()
}

async fn receive_upload(
    Query(q): Query<UploadQuery>,
    Extension(Secure(secure)): Extension<Secure>,
    State(ctx): State<Ctx>,
    body: Body,
) -> Response {
    let device = {
        let devices = ctx.hub.devices.lock().unwrap();
        devices
            .iter()
            .find(|d| !q.d.is_empty() && d.id == q.d && key_matches(&q.t, &d.token))
            .map(|d| (d.id.clone(), d.name.clone()))
    };
    let Some((device_id, device_name)) = device else {
        return StatusCode::FORBIDDEN.into_response();
    };

    let name = safe_file_name(&q.name);
    let mut status = IncomingStatus {
        id: pairing_key(),
        device_id,
        device_name,
        name: name.clone(),
        size: q.size,
        received: 0,
        state: "receiving",
        path: None,
        error: None,
    };

    let dir = match tauri::async_runtime::spawn_blocking(super::utility::briefcast_dir).await {
        Ok(Ok(root)) => root.join(INBOX_FOLDER),
        _ => return upload_failed(status, &ctx, secure, "Briefcast's library folder couldn't be found.".into()),
    };
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        return upload_failed(status, &ctx, secure, format!("Couldn't create the \"{INBOX_FOLDER}\" folder: {e}"));
    }

    // Written under a dot-name the library doesn't list, and only renamed into place once the
    // last byte is safely on disk - a half-received video never shows up as a broken file.
    let part = dir.join(format!(".{}.part", status.id));
    let mut file = match tokio::fs::File::create(&part).await {
        Ok(f) => f,
        Err(e) => return upload_failed(status, &ctx, secure, format!("Couldn't write to the library folder: {e}")),
    };
    let _ = ctx.app.emit("phone-transfer-incoming", status.clone());

    use futures_util::StreamExt;
    let mut stream = body.into_data_stream();
    let mut last_emit = Instant::now();
    let mut error = None;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => {
                error = Some("The phone stopped sending before the file finished.".to_string());
                break;
            }
        };
        if let Err(e) = file.write_all(&chunk).await {
            error = Some(format!("Couldn't save the file (is the disk full?): {e}"));
            break;
        }
        status.received += chunk.len() as u64;
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            let _ = ctx.app.emit("phone-transfer-incoming", status.clone());
        }
    }
    if error.is_none() {
        if let Err(e) = file.flush().await {
            error = Some(format!("Couldn't save the file: {e}"));
        }
    }
    if error.is_none() && q.size > 0 && status.received != q.size {
        error = Some("The phone stopped sending before the file finished.".to_string());
    }
    drop(file);
    if let Some(msg) = error {
        let _ = tokio::fs::remove_file(&part).await;
        return upload_failed(status, &ctx, secure, msg);
    }

    let target = unique_path(&dir, &name).await;
    if let Err(e) = tokio::fs::rename(&part, &target).await {
        let _ = tokio::fs::remove_file(&part).await;
        return upload_failed(status, &ctx, secure, format!("Couldn't save the file: {e}"));
    }
    let saved_name = target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
    status.state = "done";
    status.size = status.received;
    status.name = saved_name.clone();
    status.path = Some(target.to_string_lossy().to_string());
    let mut entry = history_entry("received", status.device_name.clone(), secure);
    entry.name = Some(saved_name.clone());
    entry.size = Some(status.received);
    record(&ctx.hub, &ctx.app, entry);
    let _ = ctx.app.emit("phone-transfer-incoming", status);
    (
        [(header::CONTENT_TYPE, "application/json")],
        json!({ "name": saved_name }).to_string(),
    )
        .into_response()
}

async fn ensure_server(app: &AppHandle, state: &PhoneTransferState) -> Result<PhoneTransferInfo, String> {
    let mut server = state.server.lock().await;
    if let Some(port) = *server {
        return build_info(&state.hub, port);
    }

    let hub = state.hub.clone();
    let store = store_path(app);
    *hub.history.lock().unwrap() = store.as_ref().map(|p| p.with_file_name("phone_transfer_history.jsonl"));
    if let Some(path) = &store {
        if let Ok(bytes) = tokio::fs::read(path).await {
            if let Ok(devices) = serde_json::from_slice::<Vec<Device>>(&bytes) {
                *hub.devices.lock().unwrap() = devices;
            }
        }
    }
    *hub.store.lock().unwrap() = store;

    // Fails early, with a useful message, on a machine with no usable network at all.
    lan_addresses()?;
    let mut bound = None;
    for port in BASE_PORT..BASE_PORT + PORT_ATTEMPTS {
        if let Ok(listener) = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).await {
            bound = Some((listener, port));
            break;
        }
    }
    let (listener, port) = bound.ok_or_else(|| {
        format!(
            "No free port available in the range {}-{} for phone transfers.",
            BASE_PORT,
            BASE_PORT + PORT_ATTEMPTS - 1
        )
    })?;

    let ctx = Ctx { hub: hub.clone(), app: app.clone() };
    let router = Router::new()
        .route("/", get(serve_page))
        .route("/ping", get(ping))
        .route("/tls", get(tls_target))
        .route("/ws", get(ws_upgrade))
        .route("/f/:id", get(serve_file))
        // The body is streamed straight to disk, never buffered, so there's nothing for axum's 2MB
        // default limit to protect - and a phone video is routinely gigabytes.
        .route("/u", post(receive_upload).layer(DefaultBodyLimit::disable()))
        .with_state(ctx);

    tauri::async_runtime::spawn(run_tls(Ctx { hub: hub.clone(), app: app.clone() }, router.clone()));
    let plain = router.layer(Extension(Secure(false)));
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, plain.into_make_service()).await {
            log::error!("Phone transfer server stopped: {e}");
        }
    });

    *server = Some(port);
    log::info!("Phone transfer server listening on port {port}");
    build_info(&hub, port)
}

// Called once at launch. Only starts the server if a phone has been paired before - a user who
// never uses this feature never gets a listening port (or the firewall prompt that comes with it).
pub fn autostart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let Some(path) = store_path(&app) else { return };
        let paired = match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice::<Vec<Device>>(&bytes).map(|d| !d.is_empty()).unwrap_or(false),
            Err(_) => false,
        };
        if !paired {
            return;
        }
        let state = app.state::<PhoneTransferState>();
        if let Err(e) = ensure_server(&app, &state).await {
            log::warn!("Phone transfer: couldn't start at launch: {e}");
        }
    });
}

// Starts the server, or returns the running one's details. Idempotent - the Transfer dialog calls
// it every time it opens.
#[tauri::command]
pub async fn start_phone_transfer_server(
    app_handle: AppHandle,
    state: tauri::State<'_, PhoneTransferState>,
) -> Result<PhoneTransferInfo, String> {
    ensure_server(&app_handle, &state).await
}

#[derive(Deserialize)]
pub struct TransferFile {
    pub path: String,
    pub name: String,
}

#[tauri::command]
pub async fn phone_transfer_send(
    app_handle: AppHandle,
    state: tauri::State<'_, PhoneTransferState>,
    device_id: String,
    files: Vec<TransferFile>,
) -> Result<Vec<TransferStatus>, String> {
    ensure_server(&app_handle, &state).await?;
    let hub = &state.hub;
    if !hub.devices.lock().unwrap().iter().any(|d| d.id == device_id) {
        return Err("That phone is no longer paired with Briefcast.".to_string());
    }

    let mut prepared = Vec::with_capacity(files.len());
    for f in files {
        let meta = tokio::fs::metadata(&f.path)
            .await
            .map_err(|_| format!("\"{}\" couldn't be found on this computer.", f.name))?;
        if !meta.is_file() {
            return Err(format!("\"{}\" is a folder - pick the files inside it instead.", f.name));
        }
        prepared.push((f, meta.len()));
    }

    let mut statuses = Vec::with_capacity(prepared.len());
    for (f, size) in prepared {
        let offer_id = pairing_key();
        let offer = Offer {
            seq: hub.seq.fetch_add(1, Ordering::Relaxed),
            device_id: device_id.clone(),
            path: PathBuf::from(&f.path),
            name: f.name,
            size,
            sent: 0,
            state: TransferState::Offered,
            delivered: true,
        };
        let msg = Hub::offer_message(&offer_id, &offer, true);
        let mut status = offer.status(&offer_id);
        // Stored before it's sent, so a phone fast enough to request the file the instant the
        // offer lands can never find it missing.
        hub.offers.lock().unwrap().insert(offer_id.clone(), offer);
        if !hub.send_to(&device_id, msg) {
            if let Some(stored) = hub.offers.lock().unwrap().get_mut(&offer_id) {
                stored.state = TransferState::Queued;
                stored.delivered = false;
            }
            status.state = TransferState::Queued;
        }
        statuses.push(status);
    }
    Ok(statuses)
}

// The desktop's answer to a pair request (see approve_new_phone).
#[tauri::command]
pub async fn phone_transfer_answer_pair(
    state: tauri::State<'_, PhoneTransferState>,
    request_id: String,
    approve: bool,
) -> Result<(), String> {
    match state.hub.pending.lock().unwrap().remove(&request_id) {
        Some(decide) => {
            let _ = decide.send(approve);
            Ok(())
        }
        None => Err("That request has expired - scan the code again.".to_string()),
    }
}

// Newest first, at most `limit` entries.
#[tauri::command]
pub async fn phone_transfer_history(
    state: tauri::State<'_, PhoneTransferState>,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    let Some(path) = state.hub.history.lock().unwrap().clone() else { return Ok(Vec::new()) };
    let text = match tokio::fs::read_to_string(&path).await {
        Ok(t) => t,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(text
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str(line).ok())
        .take(limit.unwrap_or(200))
        .collect())
}

#[tauri::command]
pub async fn phone_transfer_devices(state: tauri::State<'_, PhoneTransferState>) -> Result<Vec<PhoneDevice>, String> {
    Ok(state.hub.device_list())
}

// Unpairs a phone: its token stops working, its page is told to forget it, and anything still
// queued for it is dropped.
#[tauri::command]
pub async fn phone_transfer_forget(
    app_handle: AppHandle,
    state: tauri::State<'_, PhoneTransferState>,
    device_id: String,
) -> Result<(), String> {
    let hub = state.hub.clone();
    let name = hub.device_name(&device_id);
    hub.devices.lock().unwrap().retain(|d| d.id != device_id);
    hub.offers.lock().unwrap().retain(|_, o| o.device_id != device_id);
    if let Some(session) = hub.sessions.lock().unwrap().remove(&device_id) {
        let _ = session.tx.send(json!({ "type": "forget" }).to_string());
        let _ = session.tx.send(CLOSE_SENTINEL.to_string());
    }
    hub.persist().await;
    record(&hub, &app_handle, history_entry("removed", name, false));
    emit_devices(&Ctx { hub, app: app_handle });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(Some("bytes=0-"), 100), Ok(Some((0, 99))));
        assert_eq!(parse_range(Some("bytes=10-19"), 100), Ok(Some((10, 19))));
        assert_eq!(parse_range(Some("bytes=90-500"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(Some("bytes=0-1,5-9"), 100), Ok(None));
        assert_eq!(parse_range(Some("bytes=100-"), 100), Err(()));
        assert_eq!(parse_range(Some("bytes=20-10"), 100), Err(()));
        assert_eq!(parse_range(Some("bytes=0-"), 0), Err(()));
    }

    #[test]
    fn disposition_keeps_unicode_names_exact() {
        let v = content_disposition("Clip – \"final\".mp4", false);
        assert!(v.starts_with("attachment; filename=\"Clip _ _final_.mp4\""));
        assert!(v.contains("filename*=UTF-8''Clip%20%E2%80%93%20%22final%22.mp4"));
    }

    #[test]
    fn phone_file_names_are_made_safe() {
        assert_eq!(safe_file_name("IMG_0001.HEIC"), "IMG_0001.HEIC");
        assert_eq!(safe_file_name("../../evil.exe"), "evil.exe");
        assert_eq!(safe_file_name("C:\\x\\a:b?.mp4"), "a_b_.mp4");
        assert_eq!(safe_file_name("con.txt"), "_con.txt");
        assert_eq!(safe_file_name("COM1"), "_COM1");
        assert_eq!(safe_file_name("..."), "phone-file");
        assert_eq!(safe_file_name(".hidden"), "phone-file.hidden");
        assert_eq!(safe_file_name("clip. "), "clip");
        let long = format!("{}.mp4", "a".repeat(300));
        let safe = safe_file_name(&long);
        assert_eq!(safe.chars().count(), 150);
        assert!(safe.ends_with(".mp4"));
    }

    #[test]
    fn pairing_keys_are_single_use() {
        let hub = Hub::default();
        let (key, ttl) = hub.current_key();
        assert!(ttl > Duration::from_secs(290));
        assert!(!hub.take_key(""));
        assert!(!hub.take_key("not-the-key"));
        assert!(hub.take_key(&key));
        // Spent: the same code can't pair a second phone, and a fresh one replaces it.
        assert!(!hub.take_key(&key));
        let (next, _) = hub.current_key();
        assert_ne!(next, key);
        assert!(hub.take_key(&next));
    }

    #[test]
    fn pairing_keys_expire() {
        let hub = Hub::default();
        // Instant can't go back before boot; skip on a machine up for under five minutes.
        let Some(issued) = Instant::now().checked_sub(PAIRING_TTL + Duration::from_secs(1)) else { return };
        *hub.key.lock().unwrap() = Some(PairingKey { key: "abc".into(), issued, used: false });
        assert!(!hub.take_key("abc"));
    }

    #[test]
    fn platform_detection() {
        assert_eq!(platform_from_ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "iphone");
        assert_eq!(platform_from_ua("Mozilla/5.0 (Linux; Android 10; K) Chrome/120 Mobile"), "android");
    }
}
