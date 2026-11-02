// Phones plugged in with a USB cable: send any file to an Android phone, and bring files back -
// the camera roll, the documents a phone collects (PDFs, papers, data, slides from Downloads,
// WhatsApp, Telegram...), or anything else via a folder browser - with no network at all.
//
// Why a cable matters even with Wi-Fi transfer (phone_transfer.rs): it's the fastest link there is
// for multi-gigabyte recordings, it works on locked-down networks that keep devices from seeing
// each other, and nothing ever leaves the cable.
//
// Windows exposes phones through Windows Portable Devices (WPD) - the same COM API Explorer uses for
// "This PC > Pixel 8". Android speaks MTP, so files can be written to it; an iPhone speaks PTP and
// Apple only lets a computer *read* its camera roll, so iPhone is import-only here (the Wi-Fi
// transfer covers the other direction).
//
// Threading: WPD objects are apartment-bound COM objects, so one dedicated worker thread owns all of
// them and runs jobs one at a time; when idle it polls for phones every couple of seconds. Commands
// only post jobs and listen for events, so nothing here can block the UI or the async runtime.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, PartialEq)]
pub struct UsbPhone {
    pub id: String,
    pub name: String,
    // "android" | "iphone" | "other"
    pub kind: String,
    // "ready" | "locked" - locked covers both an Android screen lock (storage hidden until unlocked)
    // and an iPhone that hasn't been told to trust this computer yet.
    pub state: String,
    // Android over MTP can be written to; iPhone can't.
    pub can_receive: bool,
    pub free_bytes: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct MediaItem {
    pub object_id: String,
    pub name: String,
    pub size: u64,
    // "image" | "video" | "document" | "other" - see file_kind.
    pub kind: String,
    // Unix milliseconds, 0 if the phone doesn't say.
    pub modified: i64,
    pub unique_id: String,
    pub imported: bool,
}

#[derive(Clone, Serialize)]
struct MediaBatch {
    device_id: String,
    // Which scan these results belong to - the page drops batches from any scan but its latest.
    scan_id: String,
    // "media" | "documents"
    mode: String,
    items: Vec<MediaItem>,
    done: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct UsbTransfer {
    pub id: String,
    // "to_phone" | "from_phone"
    pub direction: String,
    pub device_name: String,
    pub file_index: usize,
    pub file_count: usize,
    pub name: String,
    pub done_bytes: u64,
    pub total_bytes: u64,
    // "running" | "done" | "failed" | "cancelled"
    pub state: String,
    pub error: Option<String>,
    // Where imported files landed, once done.
    pub paths: Vec<String>,
}

#[derive(Deserialize)]
pub struct SendFile {
    pub path: String,
    pub name: String,
}

#[derive(Clone, Deserialize)]
pub struct ImportItem {
    pub object_id: String,
    pub name: String,
    pub size: u64,
    pub modified: i64,
    pub unique_id: String,
}

// One entry of the folder browser.
#[derive(Clone, Serialize)]
pub struct BrowseEntry {
    pub object_id: String,
    pub name: String,
    pub is_folder: bool,
    pub size: u64,
    pub modified: i64,
    pub kind: String,
    pub unique_id: String,
    pub imported: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum ScanMode {
    Media,
    Documents,
}

enum Job {
    Scan { device: String, mode: ScanMode, scan_id: String },
    Browse { device: String, folder: Option<String>, reply: tokio::sync::oneshot::Sender<Result<Vec<BrowseEntry>, String>> },
    // `generate`: when the phone has no preview to give (always for videos - Android only hands out
    // photo previews - and for some phones' photos), make one from the file (see make_preview).
    Thumbnail { device: String, object: String, generate: Option<GenThumb>, reply: tokio::sync::oneshot::Sender<Option<Vec<u8>>> },
    Send { device: String, files: Vec<SendFile>, transfer: String, cancel: Arc<AtomicBool> },
    Import { device: String, items: Vec<ImportItem>, transfer: String, cancel: Arc<AtomicBool> },
}

// A preview Briefcast makes itself, from the file's own bytes, and caches at `cache`.
struct GenThumb {
    name: String,
    size: u64,
    video: bool,
    cache: PathBuf,
}

static WORKER: OnceLock<std::sync::mpsc::Sender<Job>> = OnceLock::new();
static PHONES: Mutex<Vec<UsbPhone>> = Mutex::new(Vec::new());
static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn post(job: Job) -> Result<(), String> {
    WORKER
        .get()
        .ok_or_else(|| "USB transfer isn't available on this system.".to_string())?
        .send(job)
        .map_err(|_| "The USB worker stopped.".to_string())
}

fn new_id() -> String {
    super::phone_camera::pairing_key()
}

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "dng", "avif"];
const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "3gp", "mkv", "webm"];
// What a researcher's phone collects besides photos: papers and office files, LaTeX and
// references, notebooks and code, data formats (ROOT, HDF5, FITS, NetCDF, MATLAB, NumPy, Parquet),
// and the archives they arrive in.
const DOCUMENT_EXTS: &[&str] = &[
    "pdf", "doc", "docx", "odt", "rtf", "txt", "md", "epub", "djvu", "ps", "eps", "xps",
    "ppt", "pptx", "odp", "key", "xls", "xlsx", "ods", "csv", "tsv", "numbers", "pages",
    "tex", "bib", "cls", "sty", "ipynb", "py", "r", "m", "jl", "c", "cc", "cpp", "h", "hpp", "f90", "java", "js", "ts", "sh",
    "json", "xml", "yaml", "yml", "toml", "log", "dat", "root", "h5", "hdf5", "nc", "fits", "fit", "mat", "npy", "npz",
    "parquet", "feather", "sqlite", "db", "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "svg",
];

// What kind of file this is, by extension - drives scanning, icons and where it lands on a phone.
fn file_kind(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if IMAGE_EXTS.contains(&ext.as_str()) {
        "image"
    } else if VIDEO_EXTS.contains(&ext.as_str()) {
        "video"
    } else if DOCUMENT_EXTS.contains(&ext.as_str()) {
        "document"
    } else {
        "other"
    }
}

// Where phones keep documents, relative to a storage root. Messaging apps are where most papers
// and slides on a phone actually arrive; Android 11+ moved WhatsApp's folder under Android/media.
const DOCUMENT_ROOTS: &[&[&str]] = &[
    &["Download"],
    &["Documents"],
    &["Android", "media", "com.whatsapp", "WhatsApp", "Media", "WhatsApp Documents"],
    &["WhatsApp", "Media", "WhatsApp Documents"],
    &["Android", "media", "org.telegram.messenger", "Telegram", "Telegram Documents"],
    &["Telegram", "Telegram Documents"],
];

// Phones that don't report a date usually still name camera files by it: "20251113_202954.jpg",
// "IMG_20240101_093000.jpg", "VID_20240101_093000.mp4", "Screenshot_20240101-093000.png".
fn date_from_name(name: &str) -> Option<i64> {
    let digits: Vec<(usize, char)> = name.char_indices().collect();
    for start in 0..digits.len() {
        let rest: String = digits[start..].iter().map(|(_, c)| *c).take(15).collect();
        let b = rest.as_bytes();
        if b.len() < 15 || !b[..8].iter().all(u8::is_ascii_digit) || !(b[8] == b'_' || b[8] == b'-') || !b[9..15].iter().all(u8::is_ascii_digit) {
            continue;
        }
        let num = |r: std::ops::Range<usize>| rest[r].parse::<i64>().ok();
        let (y, mo, d, h, mi, se) = (num(0..4)?, num(4..6)?, num(6..8)?, num(9..11)?, num(11..13)?, num(13..15)?);
        if !(1990..=2100).contains(&y) || !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
            continue;
        }
        // Days from civil (Howard Hinnant's algorithm), as UTC - the phone's local time is unknown.
        let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
        let era = yy.div_euclid(400);
        let yoe = yy - era * 400;
        let doy = (153 * mm + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146097 + doe - 719468;
        return Some(((days * 86400) + h * 3600 + mi * 60 + se) * 1000);
    }
    None
}

// Where a file goes on an Android phone, so it shows up where people look for it: videos in the
// gallery's Movies, pictures in Pictures, anything else in Downloads - always in a Briefcast folder.
fn android_folder(name: &str) -> [&'static str; 2] {
    match file_kind(name) {
        "video" => ["Movies", "Briefcast"],
        "image" => ["Pictures", "Briefcast"],
        "document" => ["Documents", "Briefcast"],
        _ => ["Download", "Briefcast"],
    }
}

// OLE automation date (days since 1899-12-30) -> Unix milliseconds.
fn ole_date_to_unix_ms(days: f64) -> i64 {
    ((days - 25569.0) * 86_400_000.0).round() as i64
}

// --------------------------------------------------------------------------------------------
// Commands - available on every platform; only Windows has a worker behind them.
// --------------------------------------------------------------------------------------------

pub fn start(app: &AppHandle) {
    #[cfg(windows)]
    imp::start_worker(app.clone());
    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
pub async fn usb_phones() -> Result<Vec<UsbPhone>, String> {
    Ok(PHONES.lock().unwrap().clone())
}

// Lists the phone's camera roll ("media") or the documents it has collected ("documents");
// results arrive as "usb-phone-media" batches.
#[tauri::command]
pub async fn usb_phone_scan(device_id: String, mode: Option<String>, scan_id: String) -> Result<(), String> {
    let mode = if mode.as_deref() == Some("documents") { ScanMode::Documents } else { ScanMode::Media };
    post(Job::Scan { device: device_id, mode, scan_id })
}

// One folder of the phone, for browsing to anything the two scans don't cover. No folder means the
// storage roots.
#[tauri::command]
pub async fn usb_phone_browse(device_id: String, folder: Option<String>) -> Result<Vec<BrowseEntry>, String> {
    let (reply, rx) = tokio::sync::oneshot::channel();
    post(Job::Browse { device: device_id, folder, reply })?;
    rx.await.map_err(|_| "The USB worker stopped.".to_string())?
}

// Where a generated preview is kept, by the phone's own id for the file - so each file is only
// ever processed once, however many times the phone is plugged in.
fn generated_thumb_path(app: &AppHandle, unique_id: &str) -> Option<PathBuf> {
    use sha2::Digest;
    use tauri::Manager;
    let hash: String = sha2::Sha256::digest(unique_id.as_bytes()).iter().take(12).map(|b| format!("{b:02x}")).collect();
    app.path().app_cache_dir().ok().map(|d| d.join("usb_thumbs").join(format!("{hash}.jpg")))
}

// A small JPEG preview as a data URL. Photos: the phone's own thumbnail. Videos: a frame taken
// from the video itself, made once and cached.
#[tauri::command]
pub async fn usb_phone_thumbnail(
    app: AppHandle,
    device_id: String,
    object_id: String,
    kind: Option<String>,
    name: Option<String>,
    size: Option<u64>,
    unique_id: Option<String>,
) -> Result<Option<String>, String> {
    use base64::Engine;
    let to_url = |bytes: Vec<u8>| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
    let generate = match (kind.as_deref(), unique_id) {
        (Some(k @ ("video" | "image")), Some(uid)) => match generated_thumb_path(&app, &uid) {
            Some(cache) => {
                if let Ok(bytes) = tokio::fs::read(&cache).await {
                    return Ok(Some(to_url(bytes)));
                }
                Some(GenThumb { name: name.unwrap_or_default(), size: size.unwrap_or(0), video: k == "video", cache })
            }
            None => None,
        },
        _ => None,
    };
    let (reply, rx) = tokio::sync::oneshot::channel();
    post(Job::Thumbnail { device: device_id, object: object_id, generate, reply })?;
    Ok(rx.await.ok().flatten().map(to_url))
}

#[tauri::command]
pub async fn usb_phone_send(device_id: String, files: Vec<SendFile>) -> Result<String, String> {
    let transfer = new_id();
    let cancel = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap().insert(transfer.clone(), cancel.clone());
    post(Job::Send { device: device_id, files, transfer: transfer.clone(), cancel })?;
    Ok(transfer)
}

#[tauri::command]
pub async fn usb_phone_import(device_id: String, items: Vec<ImportItem>) -> Result<String, String> {
    let transfer = new_id();
    let cancel = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap().insert(transfer.clone(), cancel.clone());
    post(Job::Import { device: device_id, items, transfer: transfer.clone(), cancel })?;
    Ok(transfer)
}

#[tauri::command]
pub async fn usb_transfer_cancel(transfer_id: String) -> Result<(), String> {
    if let Some(flag) = cancels().lock().unwrap().get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// Which camera-roll items have been imported before, per phone - so the grid can mark them and
// "Select new" picks only what's actually new. Kept by the phone's own unique ids, which survive
// renames and reconnects.
#[derive(Default, Serialize, Deserialize)]
struct ImportedLog(HashMap<String, HashSet<String>>);

fn imported_log_path(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_config_dir().ok().map(|d| d.join("usb_imported.json"))
}

fn load_imported(app: &AppHandle) -> ImportedLog {
    imported_log_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_imported(app: &AppHandle, log: &ImportedLog) {
    if let (Some(path), Ok(body)) = (imported_log_path(app), serde_json::to_vec(log)) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, body);
    }
}

// "clip.mp4" -> "clip (2).mp4" ... against a set of names already taken.
fn unique_name(name: &str, taken: &HashSet<String>) -> String {
    if !taken.contains(&name.to_lowercase()) {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|candidate| !taken.contains(&candidate.to_lowercase()))
        .unwrap_or_else(|| name.to_string())
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::io::Write as _;
    use std::time::{Duration, Instant};

    use windows::core::{GUID, PCWSTR, PROPVARIANT, PWSTR};
    use windows::Win32::Devices::PortableDevices::*;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, IStream, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
        STGC_DEFAULT, STGM_READ,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    const POLL_EVERY: Duration = Duration::from_secs(2);
    const PROGRESS_EVERY: Duration = Duration::from_millis(150);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    // Takes ownership of a CoTaskMem-allocated string.
    unsafe fn take_pwstr(p: PWSTR) -> String {
        if p.is_null() {
            return String::new();
        }
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }

    pub(super) struct Device {
        pub(super) name: String,
        pub(super) kind: String,
        pub(super) serial: String,
        // Held only to keep the session open for `content` and `props`; closed when dropped.
        _session: IPortableDevice,
        pub(super) content: IPortableDeviceContent,
        pub(super) props: IPortableDeviceProperties,
    }

    struct Worker {
        app: AppHandle,
        manager: IPortableDeviceManager,
        open: HashMap<String, Device>,
        rx: std::sync::mpsc::Receiver<Job>,
        // Jobs that arrived during a long scan and wait their turn (thumbnails don't - see scan).
        deferred: std::collections::VecDeque<Job>,
    }

    pub fn start_worker(app: AppHandle) {
        let (tx, rx) = std::sync::mpsc::channel::<Job>();
        if WORKER.set(tx).is_err() {
            return;
        }
        std::thread::Builder::new()
            .name("usb-phone".into())
            .spawn(move || unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                let manager: IPortableDeviceManager = match CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER) {
                    Ok(m) => m,
                    Err(e) => {
                        log::warn!("USB phones: Windows Portable Devices unavailable: {e}");
                        return;
                    }
                };
                let mut worker = Worker { app, manager, open: HashMap::new(), rx, deferred: Default::default() };
                let mut last_poll = Instant::now() - POLL_EVERY;
                loop {
                    if let Some(job) = worker.deferred.pop_front() {
                        worker.run(job);
                    } else {
                        let wait = POLL_EVERY.saturating_sub(last_poll.elapsed());
                        match worker.rx.recv_timeout(wait) {
                            Ok(job) => worker.run(job),
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                    if last_poll.elapsed() >= POLL_EVERY {
                        worker.poll();
                        last_poll = Instant::now();
                    }
                }
            })
            .ok();
    }

    impl Worker {
        // ------------------------------------------------------------------ discovery

        unsafe fn device_ids(&self) -> Vec<String> {
            device_ids(&self.manager)
        }

        unsafe fn open_device(&self, id: &str) -> windows::core::Result<Device> {
            open_device(&self.manager, id)
        }
    }

    pub(super) unsafe fn open_device(manager: &IPortableDeviceManager, id: &str) -> windows::core::Result<Device> {
        {
            let client: IPortableDeviceValues = CoCreateInstance(&PortableDeviceValues, None, CLSCTX_INPROC_SERVER)?;
            let app_name = wide("Briefcast");
            client.SetStringValue(&WPD_CLIENT_NAME, PCWSTR(app_name.as_ptr()))?;
            client.SetUnsignedIntegerValue(&WPD_CLIENT_MAJOR_VERSION, 1)?;
            client.SetUnsignedIntegerValue(&WPD_CLIENT_MINOR_VERSION, 0)?;
            client.SetUnsignedIntegerValue(&WPD_CLIENT_REVISION, 0)?;
            // The free-threaded variant: safe to use from this worker whatever its apartment.
            let device: IPortableDevice = CoCreateInstance(&PortableDeviceFTM, None, CLSCTX_INPROC_SERVER)?;
            let wid = wide(id);
            device.Open(PCWSTR(wid.as_ptr()), &client)?;
            let content = device.Content()?;
            let props = content.Properties()?;
            let values = get_values(
                &props,
                "DEVICE",
                &[WPD_DEVICE_MANUFACTURER, WPD_DEVICE_SERIAL_NUMBER, WPD_DEVICE_PROTOCOL],
            );
            let manufacturer = values.as_ref().and_then(|v| str_value(v, &WPD_DEVICE_MANUFACTURER)).unwrap_or_default();
            let serial = values.as_ref().and_then(|v| str_value(v, &WPD_DEVICE_SERIAL_NUMBER)).unwrap_or_default();
            let protocol = values.as_ref().and_then(|v| str_value(v, &WPD_DEVICE_PROTOCOL)).unwrap_or_default();
            // USB drives and memory cards show up in WPD too, as "MSC" - those aren't phones.
            if protocol.to_ascii_uppercase().starts_with("MSC") {
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_NOTIMPL));
            }
            let kind = if manufacturer.to_ascii_lowercase().contains("apple") {
                "iphone"
            } else if protocol.to_ascii_uppercase().starts_with("MTP") {
                "android"
            } else {
                "other"
            };
            let name = friendly_name(manager, id);
            Ok(Device {
                name: if name.is_empty() { manufacturer } else { name },
                kind: kind.to_string(),
                serial: if serial.is_empty() { id.to_string() } else { serial },
                _session: device,
                content,
                props,
            })
        }
    }

    impl Worker {

        fn poll(&mut self) {
            unsafe {
                let ids = self.device_ids();
                self.open.retain(|id, _| ids.contains(id));
                let mut phones = Vec::new();
                for id in ids {
                    if !self.open.contains_key(&id) {
                        match self.open_device(&id) {
                            Ok(dev) => {
                                self.open.insert(id.clone(), dev);
                            }
                            Err(_) => continue,
                        }
                    }
                    let Some(dev) = self.open.get(&id) else { continue };
                    let storages = storages(dev);
                    // A locked Android phone, or an iPhone not yet trusted, lists no storage.
                    let state = if storages.is_empty() { "locked" } else { "ready" };
                    phones.push(UsbPhone {
                        id: id.clone(),
                        name: dev.name.clone(),
                        kind: dev.kind.clone(),
                        state: state.to_string(),
                        can_receive: dev.kind == "android",
                        free_bytes: storages.first().and_then(|s| s.1),
                    });
                }
                let changed = {
                    let mut current = PHONES.lock().unwrap();
                    let changed = *current != phones;
                    *current = phones.clone();
                    changed
                };
                if changed {
                    let _ = self.app.emit("usb-phones", phones);
                }
            }
        }

        fn device(&mut self, id: &str) -> Result<&Device, String> {
            if !self.open.contains_key(id) {
                let dev = unsafe { self.open_device(id) }.map_err(|_| "The phone was disconnected.".to_string())?;
                self.open.insert(id.to_string(), dev);
            }
            Ok(self.open.get(id).unwrap())
        }

        fn run(&mut self, job: Job) {
            match job {
                Job::Scan { device, mode, scan_id } => self.scan(&device, mode, &scan_id),
                Job::Browse { device, folder, reply } => {
                    let _ = reply.send(self.browse(&device, folder.as_deref()));
                }
                Job::Thumbnail { device, object, generate, reply } => match (self.app.clone(), self.device(&device)) {
                    (app, Ok(dev)) => unsafe { answer_thumbnail(&app, dev, &object, generate, reply) },
                    (_, Err(_)) => {
                        let _ = reply.send(None);
                    }
                },
                Job::Send { device, files, transfer, cancel } => {
                    self.send(&device, files, &transfer, &cancel);
                    cancels().lock().unwrap().remove(&transfer);
                }
                Job::Import { device, items, transfer, cancel } => {
                    self.import(&device, items, &transfer, &cancel);
                    cancels().lock().unwrap().remove(&transfer);
                }
            }
        }

        // ------------------------------------------------------------------ camera roll

        fn scan(&mut self, device_id: &str, mode: ScanMode, scan_id: &str) {
            let app = self.app.clone();
            let mode_name = if mode == ScanMode::Documents { "documents" } else { "media" };
            let emit = |items: Vec<MediaItem>, done: bool, error: Option<String>| {
                let batch = MediaBatch {
                    device_id: device_id.to_string(),
                    scan_id: scan_id.to_string(),
                    mode: mode_name.to_string(),
                    items,
                    done,
                    error,
                };
                let _ = app.emit("usb-phone-media", batch);
            };
            let imported_log = load_imported(&self.app);
            if let Err(e) = self.device(device_id) {
                return emit(Vec::new(), true, Some(e));
            }
            // Direct field borrows from here on, so `rx`/`deferred` stay usable alongside `dev`.
            let dev = self.open.get(device_id).unwrap();
            let rx = &self.rx;
            let deferred = &mut self.deferred;
            let storages = unsafe { storages(dev) };
            if storages.is_empty() {
                return emit(Vec::new(), true, Some("Unlock the phone to see its files.".into()));
            }
            if mode == ScanMode::Documents && dev.kind == "iphone" {
                return emit(
                    Vec::new(),
                    true,
                    Some("iPhones only share photos and videos over USB. For documents, open Briefcast on the iPhone over Wi-Fi and tap Send to computer.".into()),
                );
            }
            let imported = imported_log.0.get(&dev.serial).cloned().unwrap_or_default();
            // Scanning a big phone takes a while (one USB round trip per file). Thumbnails for the
            // tiles already on screen are answered in between, rather than after the whole scan -
            // and a newer scan of the same thing (the window reopened, Refresh) replaces this one
            // instead of queueing behind it.
            let mut superseded = false;
            let mut service = || {
                while let Ok(job) = rx.try_recv() {
                    match job {
                        Job::Scan { ref device, mode: newer, .. } if device == device_id && newer == mode => {
                            superseded = true;
                            deferred.push_front(job);
                        }
                        Job::Thumbnail { device, object, generate, reply } if device == device_id => {
                            unsafe { answer_thumbnail(&app, dev, &object, generate, reply) };
                        }
                        Job::Browse { device, folder, reply } if device == device_id => {
                            let _ = reply.send(unsafe { browse_in(dev, folder.as_deref(), &imported) });
                        }
                        other => deferred.push_back(other),
                    }
                }
                !superseded
            };
            let accept = |kind: &str| match mode {
                ScanMode::Media => kind == "image" || kind == "video",
                ScanMode::Documents => kind == "document",
            };
            let mut batch = Vec::new();
            unsafe {
                for (storage, _) in storages {
                    let roots: Vec<String> = match mode {
                        // The camera first: it's what people are almost always after.
                        ScanMode::Media => ["DCIM", "Pictures", "Movies"]
                            .iter()
                            .filter_map(|name| find_path(dev, &storage, &[name]))
                            .collect(),
                        ScanMode::Documents => DOCUMENT_ROOTS.iter().filter_map(|path| find_path(dev, &storage, path)).collect(),
                    };
                    let mut seen = HashSet::new();
                    for root in roots {
                        if !walk(dev, &root, 0, &imported, &accept, &mut seen, &mut batch, &mut |items| emit(items, false, None), &mut service) {
                            // Replaced by a newer scan, which reports for itself.
                            return;
                        }
                    }
                }
            }
            emit(batch, true, None);
        }

        fn browse(&mut self, device_id: &str, folder: Option<&str>) -> Result<Vec<BrowseEntry>, String> {
            let imported_log = load_imported(&self.app);
            let dev = self.device(device_id)?;
            let imported = imported_log.0.get(&dev.serial).cloned().unwrap_or_default();
            unsafe { browse_in(dev, folder, &imported) }
        }

        // ------------------------------------------------------------------ to phone

        fn send(&mut self, device_id: &str, files: Vec<SendFile>, transfer: &str, cancel: &AtomicBool) {
            let app = self.app.clone();
            let total: u64 = files.iter().filter_map(|f| std::fs::metadata(&f.path).ok()).map(|m| m.len()).sum();
            let mut status = UsbTransfer {
                id: transfer.to_string(),
                direction: "to_phone".into(),
                device_name: String::new(),
                file_index: 0,
                file_count: files.len(),
                name: String::new(),
                done_bytes: 0,
                total_bytes: total,
                state: "running".into(),
                error: None,
                paths: Vec::new(),
            };
            let result = (|| -> Result<(), String> {
                let dev = self.device(device_id)?;
                status.device_name = dev.name.clone();
                if dev.kind != "android" {
                    return Err("This phone doesn't accept files over USB - use Transfer to phone over Wi-Fi instead.".into());
                }
                let storages = unsafe { storages(dev) };
                let (storage, free) = storages.first().cloned().ok_or("Unlock the phone, then try again.")?;
                if let Some(free) = free {
                    if free < total {
                        return Err(format!(
                            "Not enough space on the phone ({} free, {} needed).",
                            human_bytes(free),
                            human_bytes(total)
                        ));
                    }
                }
                for (i, file) in files.iter().enumerate() {
                    status.file_index = i;
                    status.name = file.name.clone();
                    let _ = app.emit("usb-transfer", status.clone());
                    let folder = unsafe { ensure_path(dev, &storage, &android_folder(&file.name)) }
                        .map_err(|e| format!("Couldn't create a folder on the phone: {e}"))?;
                    let taken: HashSet<String> = unsafe { children(&dev.content, &folder) }
                        .iter()
                        .filter_map(|c| unsafe { object_name(&dev.props, c) })
                        .map(|n| n.to_lowercase())
                        .collect();
                    let name = unique_name(&file.name, &taken);
                    let before = status.done_bytes;
                    let mut last = Instant::now();
                    unsafe {
                        write_file(dev, &folder, &file.path, &name, cancel, &mut |written| {
                            status.done_bytes = before + written;
                            if last.elapsed() >= PROGRESS_EVERY {
                                last = Instant::now();
                                let _ = app.emit("usb-transfer", status.clone());
                            }
                        })?;
                    }
                    let size = status.done_bytes - before;
                    super::super::phone_transfer::record_local(&app, "sent", &status.device_name, &name, size);
                }
                Ok(())
            })();
            finish(&app, status, result, cancel);
        }

        // ------------------------------------------------------------------ from phone

        fn import(&mut self, device_id: &str, items: Vec<ImportItem>, transfer: &str, cancel: &AtomicBool) {
            let app = self.app.clone();
            let mut status = UsbTransfer {
                id: transfer.to_string(),
                direction: "from_phone".into(),
                device_name: String::new(),
                file_index: 0,
                file_count: items.len(),
                name: String::new(),
                done_bytes: 0,
                total_bytes: items.iter().map(|i| i.size).sum(),
                state: "running".into(),
                error: None,
                paths: Vec::new(),
            };
            let result = (|| -> Result<(), String> {
                let dir = super::super::utility::briefcast_dir()?.join(super::super::phone_transfer::INBOX_FOLDER);
                std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the From phone folder: {e}"))?;
                let dev = self.device(device_id)?;
                status.device_name = dev.name.clone();
                let serial = dev.serial.clone();
                let mut log = load_imported(&app);
                for (i, item) in items.iter().enumerate() {
                    status.file_index = i;
                    status.name = item.name.clone();
                    let _ = app.emit("usb-transfer", status.clone());
                    let taken: HashSet<String> = std::fs::read_dir(&dir)
                        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_lowercase()).collect())
                        .unwrap_or_default();
                    let name = unique_name(&super::super::phone_transfer::safe_file_name(&item.name), &taken);
                    let target = dir.join(&name);
                    let before = status.done_bytes;
                    let mut last = Instant::now();
                    unsafe {
                        read_file(dev, &item.object_id, &target, cancel, &mut |read| {
                            status.done_bytes = before + read;
                            if last.elapsed() >= PROGRESS_EVERY {
                                last = Instant::now();
                                let _ = app.emit("usb-transfer", status.clone());
                            }
                        })?;
                    }
                    // Keep the date the photo was taken, so the library sorts it where it belongs.
                    if item.modified > 0 {
                        if let Ok(f) = std::fs::File::options().write(true).open(&target) {
                            let when = std::time::UNIX_EPOCH + Duration::from_millis(item.modified as u64);
                            let _ = f.set_modified(when);
                        }
                    }
                    status.paths.push(target.to_string_lossy().to_string());
                    log.0.entry(serial.clone()).or_default().insert(item.unique_id.clone());
                    save_imported(&app, &log);
                    super::super::phone_transfer::record_local(&app, "received", &status.device_name, &name, status.done_bytes - before);
                }
                Ok(())
            })();
            finish(&app, status, result, cancel);
        }
    }

    fn finish(app: &AppHandle, mut status: UsbTransfer, result: Result<(), String>, cancel: &AtomicBool) {
        match result {
            Ok(()) => status.state = "done".into(),
            Err(_) if cancel.load(Ordering::Relaxed) => status.state = "cancelled".into(),
            Err(e) => {
                log::warn!("USB transfer failed: {e}");
                status.state = "failed".into();
                status.error = Some(e);
            }
        }
        let _ = app.emit("usb-transfer", status);
    }

    fn human_bytes(n: u64) -> String {
        let gb = n as f64 / 1_073_741_824.0;
        if gb >= 1.0 {
            format!("{gb:.1} GB")
        } else {
            format!("{:.0} MB", n as f64 / 1_048_576.0)
        }
    }

    // ---------------------------------------------------------------------- WPD helpers

    pub(super) unsafe fn device_ids(manager: &IPortableDeviceManager) -> Vec<String> {
        let _ = manager.RefreshDeviceList();
        let mut count = 0u32;
        if manager.GetDevices(std::ptr::null_mut(), &mut count).is_err() || count == 0 {
            return Vec::new();
        }
        let mut ids = vec![PWSTR::null(); count as usize];
        if manager.GetDevices(ids.as_mut_ptr(), &mut count).is_err() {
            return Vec::new();
        }
        ids.into_iter().take(count as usize).map(|p| take_pwstr(p)).collect()
    }

    pub(super) unsafe fn friendly_name(manager: &IPortableDeviceManager, id: &str) -> String {
        let wid = wide(id);
        let mut len = 0u32;
        let _ = manager.GetDeviceFriendlyName(PCWSTR(wid.as_ptr()), PWSTR::null(), &mut len);
        if len == 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize];
        if manager.GetDeviceFriendlyName(PCWSTR(wid.as_ptr()), PWSTR(buf.as_mut_ptr()), &mut len).is_err() {
            return String::new();
        }
        String::from_utf16_lossy(&buf).trim_end_matches('\0').to_string()
    }

    // Storage roots ("Internal shared storage", "Internal Storage", an SD card).
    pub(super) unsafe fn storages(dev: &Device) -> Vec<(String, Option<u64>)> {
        children(&dev.content, "DEVICE")
            .into_iter()
            .filter_map(|id| {
                let v = get_values(&dev.props, &id, &[WPD_FUNCTIONAL_OBJECT_CATEGORY, WPD_STORAGE_FREE_SPACE_IN_BYTES])?;
                let category = v.GetGuidValue(&WPD_FUNCTIONAL_OBJECT_CATEGORY).ok()?;
                (category == WPD_FUNCTIONAL_CATEGORY_STORAGE)
                    .then(|| (id, v.GetUnsignedLargeIntegerValue(&WPD_STORAGE_FREE_SPACE_IN_BYTES).ok()))
            })
            .collect()
    }

    pub(super) unsafe fn children(content: &IPortableDeviceContent, parent: &str) -> Vec<String> {
        let wparent = wide(parent);
        let Ok(objects) = content.EnumObjects(0, PCWSTR(wparent.as_ptr()), None) else { return Vec::new() };
        let mut out = Vec::new();
        loop {
            let mut batch = [PWSTR::null(); 64];
            let mut fetched = 0u32;
            let hr = objects.Next(&mut batch, &mut fetched);
            for p in batch.iter().take(fetched as usize) {
                out.push(take_pwstr(*p));
            }
            if hr.is_err() || fetched == 0 {
                break;
            }
        }
        out
    }

    unsafe fn get_values(props: &IPortableDeviceProperties, object: &str, keys: &[PROPERTYKEY]) -> Option<IPortableDeviceValues> {
        let collection: IPortableDeviceKeyCollection =
            CoCreateInstance(&PortableDeviceKeyCollection, None, CLSCTX_INPROC_SERVER).ok()?;
        for key in keys {
            collection.Add(key).ok()?;
        }
        let wobject = wide(object);
        props.GetValues(PCWSTR(wobject.as_ptr()), &collection).ok()
    }

    unsafe fn str_value(values: &IPortableDeviceValues, key: &PROPERTYKEY) -> Option<String> {
        values.GetStringValue(key).ok().map(|p| take_pwstr(p)).filter(|s| !s.is_empty())
    }

    // The name a person would recognise: the original file name, falling back to the object name.
    pub(super) unsafe fn object_name(props: &IPortableDeviceProperties, object: &str) -> Option<String> {
        let v = get_values(props, object, &[WPD_OBJECT_ORIGINAL_FILE_NAME, WPD_OBJECT_NAME])?;
        str_value(&v, &WPD_OBJECT_ORIGINAL_FILE_NAME).or_else(|| str_value(&v, &WPD_OBJECT_NAME))
    }

    // One folder's listing (or the storage roots). A free function so a scan in progress can answer
    // browse requests in between files - see Worker::scan.
    pub(super) unsafe fn browse_in(dev: &Device, folder: Option<&str>, imported: &HashSet<String>) -> Result<Vec<BrowseEntry>, String> {
        let Some(folder) = folder else {
            let roots = storages(dev);
            if roots.is_empty() {
                return Err("Unlock the phone to see its files.".into());
            }
            return Ok(roots
                .into_iter()
                .map(|(id, _)| BrowseEntry {
                    name: object_name(&dev.props, &id).unwrap_or_else(|| "Storage".into()),
                    object_id: id.clone(),
                    is_folder: true,
                    size: 0,
                    modified: 0,
                    kind: "folder".into(),
                    unique_id: id,
                    imported: false,
                })
                .collect());
        };
        let mut entries: Vec<BrowseEntry> = children(&dev.content, folder)
            .into_iter()
            .filter_map(|child| {
                let info = object_info(dev, &child)?;
                // Hidden folders and files (thumbnail caches, trash) aren't what anyone is browsing for.
                if info.name.starts_with('.') {
                    return None;
                }
                Some(BrowseEntry {
                    imported: imported.contains(&info.unique_id),
                    kind: if info.is_folder { "folder".into() } else { file_kind(&info.name).into() },
                    object_id: child,
                    name: info.name,
                    is_folder: info.is_folder,
                    size: info.size,
                    modified: info.modified,
                    unique_id: info.unique_id,
                })
            })
            .collect();
        entries.sort_by(|a, b| b.is_folder.cmp(&a.is_folder).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(entries)
    }

    // A date the phone reports, whichever of the forms WPD hands back.
    unsafe fn variant_ms(pv: &PROPVARIANT) -> Option<i64> {
        let inner = &pv.as_raw().Anonymous.Anonymous;
        let ms = match inner.vt as u16 {
            // VT_DATE
            7 => ole_date_to_unix_ms(inner.Anonymous.date),
            // VT_FILETIME: 100ns ticks since 1601
            64 => {
                let ft = inner.Anonymous.filetime;
                let ticks = ((ft.dwHighDateTime as i64) << 32) | ft.dwLowDateTime as i64;
                ticks / 10_000 - 11_644_473_600_000
            }
            // VT_LPWSTR / VT_BSTR: MTP's own "YYYYMMDDThhmmss"
            31 | 8 => date_from_name(&pv.to_string().replace('T', "_"))?,
            _ => return None,
        };
        // 1990 or later - anything earlier is an unset clock, not a real date.
        (ms > 631_152_000_000).then_some(ms)
    }

    pub(super) struct ObjectInfo {
        pub(super) name: String,
        pub(super) is_folder: bool,
        pub(super) size: u64,
        pub(super) modified: i64,
        pub(super) unique_id: String,
    }

    pub(super) unsafe fn object_info(dev: &Device, object: &str) -> Option<ObjectInfo> {
        let v = get_values(
            &dev.props,
            object,
            &[
                WPD_OBJECT_CONTENT_TYPE,
                WPD_OBJECT_ORIGINAL_FILE_NAME,
                WPD_OBJECT_NAME,
                WPD_OBJECT_SIZE,
                WPD_OBJECT_DATE_MODIFIED,
                WPD_OBJECT_DATE_CREATED,
                WPD_OBJECT_PERSISTENT_UNIQUE_ID,
            ],
        )?;
        let name = str_value(&v, &WPD_OBJECT_ORIGINAL_FILE_NAME).or_else(|| str_value(&v, &WPD_OBJECT_NAME)).unwrap_or_default();
        let content_type = v.GetGuidValue(&WPD_OBJECT_CONTENT_TYPE).unwrap_or(GUID::zeroed());
        let is_folder = content_type == WPD_CONTENT_TYPE_FOLDER || content_type == WPD_CONTENT_TYPE_FUNCTIONAL_OBJECT;
        let date = |key: &PROPERTYKEY| v.GetValue(key).ok().and_then(|pv| variant_ms(&pv));
        let modified = date(&WPD_OBJECT_DATE_CREATED)
            .or_else(|| date(&WPD_OBJECT_DATE_MODIFIED))
            .or_else(|| date_from_name(&name))
            .unwrap_or(0);
        Some(ObjectInfo {
            unique_id: str_value(&v, &WPD_OBJECT_PERSISTENT_UNIQUE_ID).unwrap_or_else(|| object.to_string()),
            size: if is_folder { 0 } else { v.GetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE).unwrap_or(0) },
            name,
            is_folder,
            modified,
        })
    }

    // storage/a/b/c by name (case-insensitive), if every step exists.
    pub(super) unsafe fn find_path(dev: &Device, storage: &str, path: &[&str]) -> Option<String> {
        let mut parent = storage.to_string();
        for segment in path {
            parent = children(&dev.content, &parent)
                .into_iter()
                .find(|c| object_name(&dev.props, c).map(|n| n.eq_ignore_ascii_case(segment)).unwrap_or(false))?;
        }
        Some(parent)
    }

    // Depth-first under a root, handing matches over in batches so the grid fills as the (slow,
    // one USB round trip per object) enumeration goes. `service` runs between objects - see scan;
    // when it returns false the walk stops, and so does this function (returning false).
    #[allow(clippy::too_many_arguments)]
    pub(super) unsafe fn walk(
        dev: &Device,
        folder: &str,
        depth: u32,
        imported: &HashSet<String>,
        accept: &dyn Fn(&str) -> bool,
        seen: &mut HashSet<String>,
        batch: &mut Vec<MediaItem>,
        flush: &mut dyn FnMut(Vec<MediaItem>),
        service: &mut dyn FnMut() -> bool,
    ) -> bool {
        // Overlapping roots (Download contains Download/Telegram, say) must not list files twice.
        if depth > 5 || !seen.insert(folder.to_string()) {
            return true;
        }
        for child in children(&dev.content, folder) {
            if !service() {
                return false;
            }
            let Some(info) = object_info(dev, &child) else { continue };
            if info.is_folder {
                // Thumbnail caches and trash ("..thumbnails", ".trashed-...") aren't the user's files.
                if !info.name.starts_with('.') && !walk(dev, &child, depth + 1, imported, accept, seen, batch, flush, service) {
                    return false;
                }
                continue;
            }
            let kind = file_kind(&info.name);
            if !accept(kind) || !seen.insert(child.clone()) {
                continue;
            }
            batch.push(MediaItem {
                object_id: child,
                imported: imported.contains(&info.unique_id),
                name: info.name,
                size: info.size,
                kind: kind.to_string(),
                modified: info.modified,
                unique_id: info.unique_id,
            });
            if batch.len() >= 40 {
                flush(std::mem::take(batch));
            }
        }
        true
    }

    unsafe fn answer_thumbnail(
        app: &AppHandle,
        dev: &Device,
        object: &str,
        generate: Option<GenThumb>,
        reply: tokio::sync::oneshot::Sender<Option<Vec<u8>>>,
    ) {
        let Some(g) = generate else {
            let _ = reply.send(thumbnail(dev, object));
            return;
        };
        // Photos: the phone's own preview when it has one - nothing to make or cache.
        if !g.video {
            if let Some(bytes) = thumbnail(dev, object) {
                let _ = reply.send(Some(bytes));
                return;
            }
        }
        // Otherwise the preview is made from the file itself. Its bytes have to come over the
        // cable on this thread; ffmpeg doesn't, so it runs off it and the next job isn't kept waiting.
        let Some(source) = fetch_preview_source(dev, object, &g) else {
            let _ = reply.send(None);
            return;
        };
        let app = app.clone();
        std::thread::spawn(move || {
            let result = super::super::utility::get_ffmpeg_path(&app).ok().and_then(|ffmpeg| make_preview(&ffmpeg, &g, source));
            let _ = reply.send(result);
        });
    }

    // What make_preview decodes: either the whole file, or - for a big video - its start and its
    // index, each at its true offset in a file of the full size.
    pub(super) enum PreviewSource {
        Whole(Vec<u8>),
        Ends { head: Vec<u8>, tail: Vec<u8>, size: u64 },
    }

    const WHOLE_VIDEO_UP_TO: u64 = 40 * 1024 * 1024;
    const WHOLE_IMAGE_UP_TO: u64 = 25 * 1024 * 1024;
    const HEAD_BYTES: u64 = 8 * 1024 * 1024;

    fn has_moov(bytes: &[u8]) -> bool {
        bytes.windows(4).any(|w| w == b"moov")
    }

    // Gets just enough of the file to decode a frame. Small files come over whole (a few hundred
    // milliseconds). A big video comes over as its first 8MB plus, when the index ("moov" - where
    // phones and screen recorders put it: at the end) isn't in there, the last 4-16MB, read with a
    // ranged read. Phones that can't do ranged reads just keep the icon.
    pub(super) unsafe fn fetch_preview_source(dev: &Device, object: &str, g: &GenThumb) -> Option<PreviewSource> {
        if !g.video {
            return (g.size > 0 && g.size <= WHOLE_IMAGE_UP_TO)
                .then(|| read_range(dev, object, 0, g.size))
                .flatten()
                .map(PreviewSource::Whole);
        }
        if g.size > 0 && g.size <= WHOLE_VIDEO_UP_TO {
            return read_range(dev, object, 0, g.size).map(PreviewSource::Whole);
        }
        let head = read_range(dev, object, 0, HEAD_BYTES)?;
        if has_moov(&head) || g.size == 0 {
            return Some(PreviewSource::Whole(head));
        }
        // Not every phone can read from the middle of a file (MTP's partial reads are optional - an
        // Infinix NOTE 50 Pro, for one, refuses). Learn that once per phone instead of paying for it
        // on every big video.
        if NO_RANGED_READS.lock().unwrap().iter().any(|s| s == &dev.serial) {
            return None;
        }
        for tail_len in [4 * 1024 * 1024u64, 16 * 1024 * 1024] {
            let tail_len = tail_len.min(g.size.saturating_sub(HEAD_BYTES));
            let Some(tail) = read_range(dev, object, g.size - tail_len, tail_len) else {
                NO_RANGED_READS.lock().unwrap().push(dev.serial.clone());
                return None;
            };
            if has_moov(&tail) {
                return Some(PreviewSource::Ends { head, tail, size: g.size });
            }
        }
        None
    }

    static NO_RANGED_READS: Mutex<Vec<String>> = Mutex::new(Vec::new());

    pub(super) unsafe fn read_range(dev: &Device, object: &str, start: u64, len: u64) -> Option<Vec<u8>> {
        let resources = dev.content.Transfer().ok()?;
        let wobject = wide(object);
        let mut optimal = 0u32;
        let mut stream: Option<IStream> = None;
        resources
            .GetStream(PCWSTR(wobject.as_ptr()), &WPD_RESOURCE_DEFAULT, STGM_READ.0, &mut optimal, &mut stream)
            .ok()?;
        let stream = stream?;
        if start > 0 {
            stream.Seek(start as i64, windows::Win32::System::Com::STREAM_SEEK_SET, None).ok()?;
        }
        let mut out = Vec::with_capacity(len.min(64 * 1024 * 1024) as usize);
        let mut buf = vec![0u8; (optimal as usize).clamp(256 * 1024, 4 * 1024 * 1024)];
        while (out.len() as u64) < len {
            let want = (len - out.len() as u64).min(buf.len() as u64) as u32;
            let mut read = 0u32;
            let hr = stream.Read(buf.as_mut_ptr() as *mut _, want, Some(&mut read));
            if hr.is_err() || read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..read as usize]);
        }
        (!out.is_empty()).then_some(out)
    }

    // Writes the source to a temporary file and has ffmpeg make a 320px JPEG of it, cached at
    // g.cache. Videos use ffmpeg's thumbnail filter, which skips black or blurry opening frames.
    pub(super) fn make_preview(ffmpeg: &std::path::Path, g: &GenThumb, source: PreviewSource) -> Option<Vec<u8>> {
        let dir = g.cache.parent()?;
        std::fs::create_dir_all(dir).ok()?;
        let ext = g.name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_else(|| "bin".into());
        let input = g.cache.with_extension(format!("src.{ext}"));
        let written = match source {
            PreviewSource::Whole(bytes) => std::fs::write(&input, bytes).is_ok(),
            PreviewSource::Ends { head, tail, size } => write_sparse(&input, &head, &tail, size).is_ok(),
        };
        if !written {
            let _ = std::fs::remove_file(&input);
            return None;
        }
        let filter = if g.video { "thumbnail=12,scale=320:-2" } else { "scale=320:-2" };
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.args(["-v", "error", "-i"])
            .arg(&input)
            .args(["-vf", filter, "-frames:v", "1", "-q:v", "5", "-y"])
            .arg(&g.cache)
            .stdin(std::process::Stdio::null());
        crate::commands::recording::hide_console_window(&mut cmd);
        let ok = super::super::responsiveness::output_with_timeout(cmd, Duration::from_secs(15))
            .map(|o| o.status.success())
            .unwrap_or(false);
        let _ = std::fs::remove_file(&input);
        if !ok {
            let _ = std::fs::remove_file(&g.cache);
            return None;
        }
        std::fs::read(&g.cache).ok()
    }

    // A file of the video's full size holding only its start and its end, each where it belongs.
    // Marked sparse, so the gap in between is never written - a 2GB recording costs ~12MB of disk,
    // not 2GB of zeros.
    fn write_sparse(path: &std::path::Path, head: &[u8], tail: &[u8], size: u64) -> std::io::Result<()> {
        use std::io::{Seek, SeekFrom, Write};
        use std::os::windows::io::AsRawHandle;
        let mut file = std::fs::File::create(path)?;
        unsafe {
            let handle = windows::Win32::Foundation::HANDLE(file.as_raw_handle() as isize);
            let mut returned = 0u32;
            // Best effort: without it the file is still correct, just slower to write.
            let _ = windows::Win32::System::IO::DeviceIoControl(
                handle,
                windows::Win32::System::Ioctl::FSCTL_SET_SPARSE,
                None,
                0,
                None,
                0,
                Some(&mut returned),
                None,
            );
        }
        file.write_all(head)?;
        file.set_len(size)?;
        file.seek(SeekFrom::Start(size - tail.len() as u64))?;
        file.write_all(tail)?;
        Ok(())
    }

    pub(super) unsafe fn thumbnail(dev: &Device, object: &str) -> Option<Vec<u8>> {
        let resources = dev.content.Transfer().ok()?;
        let wobject = wide(object);
        let mut optimal = 0u32;
        let mut stream: Option<IStream> = None;
        resources
            .GetStream(PCWSTR(wobject.as_ptr()), &WPD_RESOURCE_THUMBNAIL, STGM_READ.0, &mut optimal, &mut stream)
            .ok()?;
        let stream = stream?;
        let mut out = Vec::new();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let mut read = 0u32;
            let hr = stream.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read));
            if hr.is_err() || read == 0 {
                break;
            }
            out.extend_from_slice(&buf[..read as usize]);
            // A "thumbnail" larger than this isn't one - don't pull a full photo over just to preview it.
            if out.len() > 2 * 1024 * 1024 {
                return None;
            }
        }
        (!out.is_empty()).then_some(out)
    }

    // Finds or creates storage/<a>/<b>, returning the last folder's object id.
    unsafe fn ensure_path(dev: &Device, storage: &str, path: &[&str]) -> Result<String, String> {
        let mut parent = storage.to_string();
        for segment in path {
            let existing = children(&dev.content, &parent).into_iter().find(|c| {
                object_name(&dev.props, c).map(|n| n.eq_ignore_ascii_case(segment)).unwrap_or(false)
            });
            parent = match existing {
                Some(id) => id,
                None => {
                    let values: IPortableDeviceValues =
                        CoCreateInstance(&PortableDeviceValues, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
                    let wparent = wide(&parent);
                    let wname = wide(segment);
                    values.SetStringValue(&WPD_OBJECT_PARENT_ID, PCWSTR(wparent.as_ptr())).map_err(|e| e.to_string())?;
                    values.SetStringValue(&WPD_OBJECT_NAME, PCWSTR(wname.as_ptr())).map_err(|e| e.to_string())?;
                    values.SetStringValue(&WPD_OBJECT_ORIGINAL_FILE_NAME, PCWSTR(wname.as_ptr())).map_err(|e| e.to_string())?;
                    values.SetGuidValue(&WPD_OBJECT_CONTENT_TYPE, &WPD_CONTENT_TYPE_FOLDER).map_err(|e| e.to_string())?;
                    let mut created = PWSTR::null();
                    dev.content.CreateObjectWithPropertiesOnly(&values, &mut created).map_err(|e| e.to_string())?;
                    take_pwstr(created)
                }
            };
        }
        Ok(parent)
    }

    unsafe fn write_file(
        dev: &Device,
        folder: &str,
        path: &str,
        name: &str,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), String> {
        use std::io::Read;
        let mut file = std::fs::File::open(path).map_err(|e| format!("Couldn't open {name}: {e}"))?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let values: IPortableDeviceValues =
            CoCreateInstance(&PortableDeviceValues, None, CLSCTX_INPROC_SERVER).map_err(|e| e.to_string())?;
        let wparent = wide(folder);
        let wname = wide(name);
        let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name);
        let wstem = wide(stem);
        let content_type = match file_kind(name) {
            "video" => WPD_CONTENT_TYPE_VIDEO,
            "image" => WPD_CONTENT_TYPE_IMAGE,
            _ => WPD_CONTENT_TYPE_GENERIC_FILE,
        };
        values.SetStringValue(&WPD_OBJECT_PARENT_ID, PCWSTR(wparent.as_ptr())).map_err(|e| e.to_string())?;
        values.SetStringValue(&WPD_OBJECT_ORIGINAL_FILE_NAME, PCWSTR(wname.as_ptr())).map_err(|e| e.to_string())?;
        values.SetStringValue(&WPD_OBJECT_NAME, PCWSTR(wstem.as_ptr())).map_err(|e| e.to_string())?;
        values.SetUnsignedLargeIntegerValue(&WPD_OBJECT_SIZE, size).map_err(|e| e.to_string())?;
        values.SetGuidValue(&WPD_OBJECT_CONTENT_TYPE, &content_type).map_err(|e| e.to_string())?;
        values.SetGuidValue(&WPD_OBJECT_FORMAT, &WPD_OBJECT_FORMAT_UNSPECIFIED).map_err(|e| e.to_string())?;

        let mut stream: Option<IStream> = None;
        let mut optimal = 0u32;
        dev.content
            .CreateObjectWithPropertiesAndData(&values, &mut stream, &mut optimal, std::ptr::null_mut())
            .map_err(|e| format!("The phone refused the file: {e}"))?;
        let stream = stream.ok_or("The phone didn't open the file for writing.")?;
        let mut buf = vec![0u8; (optimal as usize).clamp(256 * 1024, 4 * 1024 * 1024)];
        let mut written_total = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                // Dropping the stream without Commit discards the partial object.
                return Err("cancelled".into());
            }
            let n = file.read(&mut buf).map_err(|e| format!("Couldn't read {name}: {e}"))?;
            if n == 0 {
                break;
            }
            let mut offset = 0;
            while offset < n {
                let mut written = 0u32;
                stream
                    .Write(buf[offset..n].as_ptr() as *const _, (n - offset) as u32, Some(&mut written))
                    .ok()
                    .map_err(|e| format!("Writing to the phone failed (was it unplugged?): {e}"))?;
                if written == 0 {
                    return Err("Writing to the phone failed.".into());
                }
                offset += written as usize;
            }
            written_total += n as u64;
            progress(written_total);
        }
        stream.Commit(STGC_DEFAULT).map_err(|e| format!("The phone didn't keep the file: {e}"))?;
        Ok(())
    }

    pub(super) unsafe fn read_file(
        dev: &Device,
        object: &str,
        target: &std::path::Path,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<(), String> {
        let resources = dev.content.Transfer().map_err(|e| e.to_string())?;
        let wobject = wide(object);
        let mut optimal = 0u32;
        let mut stream: Option<IStream> = None;
        resources
            .GetStream(PCWSTR(wobject.as_ptr()), &WPD_RESOURCE_DEFAULT, STGM_READ.0, &mut optimal, &mut stream)
            .map_err(|e| format!("The phone wouldn't give up the file: {e}"))?;
        let stream = stream.ok_or("The phone didn't open the file.")?;
        // Same rule as Wi-Fi uploads: a half-copied file never appears in the library.
        let part = target.with_file_name(format!(
            ".{}.part",
            target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
        ));
        let result = (|| -> Result<(), String> {
            let mut out = std::fs::File::create(&part).map_err(|e| format!("Couldn't write to the library: {e}"))?;
            let mut buf = vec![0u8; (optimal as usize).clamp(256 * 1024, 4 * 1024 * 1024)];
            let mut total = 0u64;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".into());
                }
                let mut read = 0u32;
                let hr = stream.Read(buf.as_mut_ptr() as *mut _, buf.len() as u32, Some(&mut read));
                if hr.is_err() {
                    return Err(format!("Reading from the phone failed (was it unplugged?): {}", windows::core::Error::from(hr)));
                }
                if read == 0 {
                    break;
                }
                out.write_all(&buf[..read as usize]).map_err(|e| format!("Couldn't save the file (is the disk full?): {e}"))?;
                total += read as u64;
                progress(total);
            }
            out.flush().map_err(|e| e.to_string())?;
            drop(out);
            std::fs::rename(&part, target).map_err(|e| format!("Couldn't save the file: {e}"))
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&part);
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_android_destinations() {
        assert_eq!(android_folder("clip.MP4"), ["Movies", "Briefcast"]);
        assert_eq!(android_folder("shot.heic"), ["Pictures", "Briefcast"]);
        assert_eq!(android_folder("paper.pdf"), ["Documents", "Briefcast"]);
        assert_eq!(android_folder("events.root"), ["Documents", "Briefcast"]);
        assert_eq!(android_folder("installer.apk"), ["Download", "Briefcast"]);
    }

    #[test]
    fn kinds() {
        assert_eq!(file_kind("Thesis.PDF"), "document");
        assert_eq!(file_kind("run_2024.root"), "document");
        assert_eq!(file_kind("analysis.ipynb"), "document");
        assert_eq!(file_kind("IMG_1.HEIC"), "image");
        assert_eq!(file_kind("noext"), "other");
    }

    #[test]
    fn dates_from_names() {
        // 2025-11-13T20:29:54Z
        assert_eq!(date_from_name("20251113_202954.jpg"), Some(1_763_065_794_000));
        assert_eq!(date_from_name("IMG_20251113_202954.jpg"), Some(1_763_065_794_000));
        assert_eq!(date_from_name("Screenshot_20251113-202954.png"), Some(1_763_065_794_000));
        assert_eq!(date_from_name("file_00000000f86c6246.png"), None);
        assert_eq!(date_from_name("GridArt_20260202_201619697.jpg"), Some(1_770_063_379_000));
    }

    #[test]
    fn unique_names() {
        let taken: HashSet<String> = ["clip.mp4", "clip (2).mp4"].iter().map(|s| s.to_string()).collect();
        assert_eq!(unique_name("Clip.mp4", &taken), "Clip (3).mp4");
        assert_eq!(unique_name("new.mp4", &taken), "new.mp4");
    }

    // Talks to the real Windows Portable Devices service: proves the COM plumbing (manager, string
    // ownership) works on this machine. Lists whatever is plugged in, which may be nothing.
    #[cfg(windows)]
    #[test]
    fn wpd_enumerates_devices() {
        use windows::Win32::Devices::PortableDevices::{IPortableDeviceManager, PortableDeviceManager};
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let manager: IPortableDeviceManager = CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER).unwrap();
            for id in imp::device_ids(&manager) {
                println!("WPD device: {} ({id})", imp::friendly_name(&manager, &id));
            }
        }
    }

    // Read-only run against whatever phone is plugged in (skips if none): open it, list storage,
    // scan the camera roll, fetch a thumbnail, and copy the smallest item out to
    // BRIEFCAST_USB_TEST_OUT (then delete the copy). Nothing is written to the phone.
    #[cfg(windows)]
    #[test]
    fn live_phone_read_only() {
        use windows::Win32::Devices::PortableDevices::{IPortableDeviceManager, PortableDeviceManager};
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let manager: IPortableDeviceManager = CoCreateInstance(&PortableDeviceManager, None, CLSCTX_INPROC_SERVER).unwrap();
            let Some(dev) = imp::device_ids(&manager).into_iter().find_map(|id| imp::open_device(&manager, &id).ok()) else {
                println!("no phone plugged in - skipped");
                return;
            };
            println!("opened: {} kind={} serial={}", dev.name, dev.kind, dev.serial);
            let storages = imp::storages(&dev);
            println!("storages: {:?}", storages);
            if storages.is_empty() {
                println!("phone is locked / not in File transfer mode - nothing more to check");
                return;
            }
            let roots = imp::browse_in(&dev, None, &HashSet::new()).unwrap();
            println!("browse roots: {:?}", roots.iter().map(|r| &r.name).collect::<Vec<_>>());
            let top = imp::browse_in(&dev, Some(&roots[0].object_id), &HashSet::new()).unwrap();
            println!(
                "browse {}: {} folders, {} files",
                roots[0].name,
                top.iter().filter(|e| e.is_folder).count(),
                top.iter().filter(|e| !e.is_folder).count()
            );
            let started = std::time::Instant::now();
            let mut items = Vec::new();
            for (storage, _) in &storages {
                for top in imp::children(&dev.content, storage) {
                    let name = imp::object_name(&dev.props, &top).unwrap_or_default();
                    if ["dcim", "pictures", "movies"].contains(&name.to_ascii_lowercase().as_str()) {
                        let mut batch = Vec::new();
                        let accept = |k: &str| k == "image" || k == "video";
                        imp::walk(&dev, &top, 0, &HashSet::new(), &accept, &mut HashSet::new(), &mut batch, &mut |b| items.extend(b), &mut || true);
                        items.extend(batch);
                    }
                }
            }
            println!("scanned {} items in {:.1}s", items.len(), started.elapsed().as_secs_f32());
            let dated = items.iter().filter(|i| i.modified > 0).count();
            println!("  {} of them have a date", dated);
            let mut docs = Vec::new();
            for (storage, _) in &storages {
                for path in DOCUMENT_ROOTS {
                    if let Some(root) = imp::find_path(&dev, storage, path) {
                        let mut batch = Vec::new();
                        let accept = |k: &str| k == "document";
                        imp::walk(&dev, &root, 0, &HashSet::new(), &accept, &mut HashSet::new(), &mut batch, &mut |b| docs.extend(b), &mut || true);
                        docs.extend(batch);
                        println!("  document root {:?} found", path);
                    }
                }
            }
            println!("documents: {}", docs.len());
            for d in docs.iter().take(5) {
                println!("  doc {} {} bytes modified={}", d.name, d.size, d.modified);
            }
            for it in items.iter().take(3) {
                println!("  {} {} {} bytes modified={} uid={}", it.kind, it.name, it.size, it.modified, it.unique_id);
            }
            if let Some(img) = items.iter().find(|i| i.kind == "image") {
                let t = std::time::Instant::now();
                let thumb = imp::thumbnail(&dev, &img.object_id);
                println!("thumbnail for {}: {:?} bytes in {}ms", img.name, thumb.map(|b| b.len()), t.elapsed().as_millis());
            }
            // Previews made the way the app does: bytes over the cable (ranged reads for big videos),
            // a frame from ffmpeg. Small and big videos, and a photo forced down the same path.
            let ffmpeg = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/ffmpeg/ffmpeg.exe");
            let out = std::env::var("BRIEFCAST_USB_TEST_OUT").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
            let mut videos: Vec<&MediaItem> = items.iter().filter(|i| i.kind == "video").collect();
            videos.sort_by_key(|v| v.size);
            let photo = items.iter().find(|i| i.kind == "image");
            let picks = [videos.first().copied(), videos.get(videos.len() / 2).copied(), videos.last().copied(), photo];
            for item in picks.into_iter().flatten() {
                let g = GenThumb { name: item.name.clone(), size: item.size, video: item.kind == "video", cache: out.join(format!("thumb-test-{}.jpg", item.object_id)) };
                let t = std::time::Instant::now();
                let source = imp::fetch_preview_source(&dev, &item.object_id, &g);
                let kind = match &source { Some(imp::PreviewSource::Whole(b)) => format!("whole {}B", b.len()), Some(imp::PreviewSource::Ends { head, tail, .. }) => format!("ends {}+{}B", head.len(), tail.len()), None => "none".into() };
                let read_ms = t.elapsed().as_millis();
                let jpeg = source.and_then(|s| imp::make_preview(&ffmpeg, &g, s));
                println!("preview {} {} ({} bytes): {} read {}ms, total {}ms -> {:?}", item.kind, item.name, item.size, kind, read_ms, t.elapsed().as_millis(), jpeg.as_ref().map(|j| (j.len(), j[..2] == [0xFF, 0xD8])));
                let _ = std::fs::remove_file(&g.cache);
            }
            if let Some(small) = items.iter().filter(|i| i.size > 0).min_by_key(|i| i.size) {
                let out = std::env::var("BRIEFCAST_USB_TEST_OUT").map(PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
                let target = out.join(format!("usb-test-{}", super::super::phone_transfer::safe_file_name(&small.name)));
                let cancel = AtomicBool::new(false);
                let t = std::time::Instant::now();
                imp::read_file(&dev, &small.object_id, &target, &cancel, &mut |_| {}).unwrap();
                let copied = std::fs::metadata(&target).unwrap().len();
                println!("copied {} ({} bytes, phone says {}) in {}ms", small.name, copied, small.size, t.elapsed().as_millis());
                assert_eq!(copied, small.size);
                std::fs::remove_file(&target).unwrap();
            }
        }
    }

    #[test]
    fn ole_dates() {
        // 2024-01-01T00:00:00Z
        assert_eq!(ole_date_to_unix_ms(45292.0), 1_704_067_200_000);
    }
}
