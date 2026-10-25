// The video editor's free music & sound-effects library (src/components/docker/MusicLibraryPanel.tsx).
//
// A catalog.json, hosted next to the audio it lists (a CDN bucket in release, the repo's
// music-library/dist in debug - built by scripts/music-library/build-catalog.mjs), describes every
// track: title/artist/mood, its length, a coarse waveform, the "best part" to start from, and its
// licence. Asset URLs in it may be relative to the catalog itself, so one built folder works from a
// local path and from the bucket unchanged.
//
// Everything network-facing goes through here rather than fetch() in the webview: the app's CSP
// keeps the webview off the network, and doing it in Rust also means every file is size- and
// SHA-256-checked before the editor ever sees it, previews and songs keep working offline once
// fetched, and the catalog itself survives being offline (the last good copy is kept on disk).
//
// Downloaded files are named by track id + content hash, so a track that's later replaced in the
// catalog lands in a new file - projects that used the old one keep pointing at audio that still
// exists, and nothing is ever overwritten under an open editor.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, Window};

// Where release builds read the catalog. Overridable at compile time (BRIEFCAST_MUSIC_CATALOG_URL,
// same pattern as the telemetry keys) and at run time (BRIEFCAST_MUSIC_CATALOG, a URL or a local
// path - handy for testing a new catalog against an installed build).
const RELEASE_CATALOG_URL: &str = "https://media.withbriefs.com/briefcast/music/v1/catalog.json";
const SUPPORTED_CATALOG_VERSION: u32 = 1;
// A cached catalog younger than this is used as-is; older, it's revalidated (cheaply - ETag).
const CATALOG_MAX_AGE_SECS: u64 = 6 * 3600;
const CATALOG_MAX_BYTES: usize = 8 << 20;
const ASSET_MAX_BYTES: u64 = 80 << 20;
const MAX_PEAKS: usize = 512;
const AUDIO_EXTENSIONS: [&str; 7] = ["m4a", "mp3", "aac", "ogg", "opus", "wav", "flac"];

fn catalog_source() -> String {
    if let Ok(v) = std::env::var("BRIEFCAST_MUSIC_CATALOG") {
        if !v.trim().is_empty() {
            return v.trim().to_string();
        }
    }
    // Dev builds use the repo's own built catalog when there is one (`npm run music:demo`).
    #[cfg(debug_assertions)]
    {
        let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("music-library").join("dist").join("catalog.json");
        if local.is_file() {
            return local.to_string_lossy().into_owned();
        }
    }
    option_env!("BRIEFCAST_MUSIC_CATALOG_URL").unwrap_or(RELEASE_CATALOG_URL).to_string()
}

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // No overall timeout - a song on a slow connection can legitimately take a while - but a
            // stalled one gives up instead of hanging the Add button forever.
            .read_timeout(Duration::from_secs(30))
            .user_agent(concat!("Briefcast/", env!("CARGO_PKG_VERSION"), " (music library)"))
            .build()
            .unwrap_or_default()
    })
    .clone()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicAsset {
    pub url: String,
    pub size: u64,
    pub sha256: String,
    // For a preview clip: where in the song it starts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicLicense {
    // SPDX-style id: "CC0-1.0", "CC-BY-4.0", ...
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    // The credit line CC-BY asks for, ready to paste.
    #[serde(default)]
    pub attribution: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    // "music" or "sfx".
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub moods: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    // 1 (calm, sits under speech) .. 5 (driving).
    #[serde(default)]
    pub energy: Option<u8>,
    pub duration: f64,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub beats: Option<Vec<f64>>,
    // Seconds into the song where its best part starts.
    #[serde(default)]
    pub highlight_start: Option<f64>,
    // Whole-song peak levels, 0..100 each, for drawing without decoding anything.
    #[serde(default)]
    pub peaks: Vec<u8>,
    pub file: MusicAsset,
    // A short clip from highlight_start, for instant previews.
    #[serde(default)]
    pub preview: Option<MusicAsset>,
    pub license: MusicLicense,
}

fn default_kind() -> String {
    "music".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicCatalog {
    pub version: u32,
    #[serde(default)]
    pub updated_at: Option<String>,
    pub tracks: Vec<MusicTrack>,
}

// What's kept on disk (and in memory): the catalog as last fetched, already validated and with every
// URL resolved to an absolute one.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedCatalog {
    source: String,
    #[serde(default)]
    etag: Option<String>,
    fetched_at: u64,
    catalog: MusicCatalog,
}

static CATALOG: Mutex<Option<CachedCatalog>> = Mutex::new(None);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogResponse {
    pub catalog: MusicCatalog,
    pub fetched_at: u64,
    // True when this is the saved copy because the library couldn't be reached.
    pub offline: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MusicDownloadProgress {
    track_id: String,
    variant: String,
    downloaded: u64,
    total: u64,
}

enum Source {
    Http(reqwest::Url),
    Local(PathBuf),
}

fn parse_source(source: &str) -> Result<Source, String> {
    if source.starts_with("https://") || source.starts_with("http://") {
        let url = reqwest::Url::parse(source).map_err(|e| format!("Bad music catalog URL {}: {}", source, e))?;
        if url.scheme() == "http" && !cfg!(debug_assertions) {
            return Err("The music catalog must be served over https.".into());
        }
        return Ok(Source::Http(url));
    }
    let path = source.strip_prefix("file:///").or_else(|| source.strip_prefix("file://")).unwrap_or(source);
    Ok(Source::Local(PathBuf::from(path)))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn music_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_local_data_dir()
        .map(|d| d.join("music"))
        .map_err(|e| format!("Failed to resolve app data folder: {}", e))
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// Ids end up in file names, so they're held to a plain, short alphabet.
fn is_valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

// Non-commercial or no-derivatives licences can't be offered: we don't know yet how Briefcast will be
// sold, and a soundtrack cut to a video is a derivative. Belt and braces - the catalog build script
// refuses them too.
fn is_allowed_license(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    !n.is_empty() && !n.contains("-NC") && !n.contains("-ND") && !n.contains("NONCOMMERCIAL")
}

fn resolve_url(base: &Source, url: &str) -> Option<String> {
    let url = url.trim();
    if url.is_empty() {
        return None;
    }
    if url.starts_with("https://") || (url.starts_with("http://") && cfg!(debug_assertions)) {
        return Some(url.to_string());
    }
    if url.contains("://") {
        return None;
    }
    match base {
        Source::Http(base) => base.join(url).ok().filter(|u| u.scheme() == "https" || cfg!(debug_assertions)).map(|u| u.to_string()),
        Source::Local(path) => Some(path.parent()?.join(url).to_string_lossy().into_owned()),
    }
}

fn sanitize_asset(base: &Source, asset: &MusicAsset) -> Option<MusicAsset> {
    if asset.size == 0 || asset.size > ASSET_MAX_BYTES || !is_sha256(&asset.sha256) {
        return None;
    }
    Some(MusicAsset { url: resolve_url(base, &asset.url)?, size: asset.size, sha256: asset.sha256.to_ascii_lowercase(), start: asset.start.filter(|s| s.is_finite() && *s >= 0.0) })
}

// Drops anything malformed rather than failing the whole catalog - one bad entry shouldn't take the
// library down - and resolves every URL against the catalog's own location.
fn sanitize_catalog(base: &Source, mut catalog: MusicCatalog) -> Result<MusicCatalog, String> {
    if catalog.version > SUPPORTED_CATALOG_VERSION {
        return Err("The music library needs a newer version of Briefcast. Update the app to see it.".into());
    }
    let mut seen = std::collections::HashSet::new();
    catalog.tracks = std::mem::take(&mut catalog.tracks)
        .into_iter()
        .filter_map(|mut t| {
            if !is_valid_id(&t.id) || !seen.insert(t.id.clone()) {
                return None;
            }
            if t.title.trim().is_empty() || !t.duration.is_finite() || t.duration <= 0.0 || t.duration > 3600.0 {
                return None;
            }
            if t.kind != "music" && t.kind != "sfx" {
                return None;
            }
            if !is_allowed_license(&t.license.name) {
                return None;
            }
            t.file = sanitize_asset(base, &t.file)?;
            t.preview = t.preview.as_ref().and_then(|p| sanitize_asset(base, p));
            t.peaks.truncate(MAX_PEAKS);
            t.energy = t.energy.map(|e| e.clamp(1, 5));
            t.highlight_start = t.highlight_start.filter(|h| h.is_finite() && *h >= 0.0 && *h < t.duration);
            t.bpm = t.bpm.filter(|b| b.is_finite() && *b > 20.0 && *b < 400.0);
            t.beats = t.beats.map(|b| b.into_iter().filter(|x| x.is_finite() && *x >= 0.0 && *x <= t.duration).collect::<Vec<_>>()).filter(|b| !b.is_empty());
            Some(t)
        })
        .collect();
    Ok(catalog)
}

fn friendly_http_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "The music library didn't answer in time. Check your connection and try again.".into()
    } else if e.is_connect() {
        "Couldn't reach the music library. Check your internet connection.".into()
    } else if let Some(status) = e.status() {
        format!("The music library isn't available right now (HTTP {}).", status.as_u16())
    } else {
        format!("Couldn't reach the music library: {}", e)
    }
}

enum Fetched {
    NotModified,
    Fresh { catalog: MusicCatalog, etag: Option<String> },
}

async fn fetch_catalog(source: &str, etag: Option<&str>) -> Result<Fetched, String> {
    let base = parse_source(source)?;
    let (bytes, new_etag) = match &base {
        Source::Http(url) => {
            let mut request = client().get(url.clone()).timeout(Duration::from_secs(20));
            if let Some(etag) = etag {
                request = request.header(reqwest::header::IF_NONE_MATCH, etag);
            }
            let response = request.send().await.map_err(friendly_http_error)?;
            if response.status() == reqwest::StatusCode::NOT_MODIFIED {
                return Ok(Fetched::NotModified);
            }
            let response = response.error_for_status().map_err(friendly_http_error)?;
            let new_etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
            let bytes = response.bytes().await.map_err(friendly_http_error)?;
            (bytes.to_vec(), new_etag)
        }
        Source::Local(path) => {
            let bytes = std::fs::read(path).map_err(|e| {
                if cfg!(debug_assertions) {
                    format!("No local music catalog at {} ({}). Run `npm run music:demo` to build one.", path.display(), e)
                } else {
                    format!("Couldn't read the music catalog at {}: {}", path.display(), e)
                }
            })?;
            (bytes, None)
        }
    };
    if bytes.len() > CATALOG_MAX_BYTES {
        return Err("The music catalog is unexpectedly large - refusing to load it.".into());
    }
    let catalog: MusicCatalog = serde_json::from_slice(&bytes).map_err(|e| format!("The music catalog is malformed: {}", e))?;
    Ok(Fetched::Fresh { catalog: sanitize_catalog(&base, catalog)?, etag: new_etag })
}

fn cache_file(dir: &Path) -> PathBuf {
    dir.join("catalog.json")
}

fn read_cached(dir: &Path, source: &str) -> Option<CachedCatalog> {
    if let Some(c) = CATALOG.lock().ok()?.as_ref().filter(|c| c.source == source) {
        return Some(c.clone());
    }
    let text = std::fs::read_to_string(cache_file(dir)).ok()?;
    let cached: CachedCatalog = serde_json::from_str(&text).ok()?;
    (cached.source == source).then_some(cached)
}

fn store_cached(dir: &Path, cached: &CachedCatalog) {
    if let Ok(mut slot) = CATALOG.lock() {
        *slot = Some(cached.clone());
    }
    // Written beside and renamed over, so a crash mid-write never leaves a half catalog behind.
    let _ = std::fs::create_dir_all(dir);
    let tmp = dir.join("catalog.json.tmp");
    if let Ok(json) = serde_json::to_vec(cached) {
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(&tmp, cache_file(dir));
        }
    }
}

async fn load_catalog(app_handle: &AppHandle, refresh: bool) -> Result<CatalogResponse, String> {
    let source = catalog_source();
    let dir = music_dir(app_handle)?;
    let cached = read_cached(&dir, &source);
    let is_local = matches!(parse_source(&source)?, Source::Local(_));
    if let Some(c) = &cached {
        if !refresh && !is_local && now_secs().saturating_sub(c.fetched_at) < CATALOG_MAX_AGE_SECS {
            return Ok(CatalogResponse { catalog: c.catalog.clone(), fetched_at: c.fetched_at, offline: false, error: None });
        }
    }
    match fetch_catalog(&source, cached.as_ref().and_then(|c| c.etag.as_deref())).await {
        Ok(Fetched::NotModified) => {
            let mut c = cached.ok_or("The music library answered 'not modified' with no saved copy")?;
            c.fetched_at = now_secs();
            store_cached(&dir, &c);
            Ok(CatalogResponse { catalog: c.catalog, fetched_at: c.fetched_at, offline: false, error: None })
        }
        Ok(Fetched::Fresh { catalog, etag }) => {
            let c = CachedCatalog { source, etag, fetched_at: now_secs(), catalog };
            store_cached(&dir, &c);
            Ok(CatalogResponse { catalog: c.catalog, fetched_at: c.fetched_at, offline: false, error: None })
        }
        Err(e) => match cached {
            Some(c) => Ok(CatalogResponse { catalog: c.catalog, fetched_at: c.fetched_at, offline: true, error: Some(e) }),
            None => Err(e),
        },
    }
}

// The library's catalog - the saved copy when it's fresh, otherwise revalidated; the saved copy
// (flagged `offline`) when the library can't be reached. `refresh` skips the freshness check.
#[tauri::command]
pub async fn get_music_catalog(app_handle: AppHandle, refresh: Option<bool>) -> Result<CatalogResponse, String> {
    load_catalog(&app_handle, refresh.unwrap_or(false)).await
}

async fn find_track(app_handle: &AppHandle, track_id: &str) -> Result<MusicTrack, String> {
    let source = catalog_source();
    let dir = music_dir(app_handle)?;
    let catalog = match read_cached(&dir, &source) {
        Some(c) => c.catalog,
        None => load_catalog(app_handle, false).await?.catalog,
    };
    catalog.tracks.into_iter().find(|t| t.id == track_id).ok_or_else(|| "That track is no longer in the music library.".to_string())
}

fn asset_extension(url: &str) -> &'static str {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    AUDIO_EXTENSIONS.iter().copied().find(|e| *e == ext).unwrap_or("m4a")
}

fn asset_dest(dir: &Path, folder: &str, track_id: &str, asset: &MusicAsset) -> PathBuf {
    dir.join(folder).join(format!("{}-{}.{}", track_id, &asset.sha256[..16], asset_extension(&asset.url)))
}

fn is_present(path: &Path, size: u64) -> bool {
    std::fs::metadata(path).map(|m| m.is_file() && m.len() == size).unwrap_or(false)
}

// Fetches one asset into `dest`: streamed to a uniquely-named .part beside it (two concurrent
// requests for the same file can't trip over each other), checked against the catalog's size and
// SHA-256, then renamed into place. Anything that doesn't match is deleted, never used.
async fn fetch_asset(asset: &MusicAsset, dest: &Path, on_progress: &(dyn Fn(u64) + Send + Sync)) -> Result<(), String> {
    let parent = dest.parent().ok_or("Bad download path")?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create the music folder: {}", e))?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let part = parent.join(format!("{}.{}.part", dest.file_name().and_then(|n| n.to_str()).unwrap_or("track"), nonce));

    let result: Result<(), String> = async {
        let mut hasher = Sha256::new();
        let mut written = 0u64;
        let mut file = std::fs::File::create(&part).map_err(|e| format!("Failed to save the track: {}", e))?;
        if asset.url.starts_with("https://") || asset.url.starts_with("http://") {
            let mut response = client().get(&asset.url).send().await.and_then(|r| r.error_for_status()).map_err(friendly_http_error)?;
            let mut last_report = Instant::now();
            while let Some(chunk) = response.chunk().await.map_err(friendly_http_error)? {
                written += chunk.len() as u64;
                if written > asset.size {
                    return Err("The downloaded track is larger than the library says - discarded.".into());
                }
                hasher.update(&chunk);
                file.write_all(&chunk).map_err(|e| format!("Failed to save the track: {}", e))?;
                if last_report.elapsed() >= Duration::from_millis(100) {
                    on_progress(written);
                    last_report = Instant::now();
                }
            }
        } else {
            let bytes = std::fs::read(&asset.url).map_err(|e| format!("Couldn't read {}: {}", asset.url, e))?;
            written = bytes.len() as u64;
            hasher.update(&bytes);
            file.write_all(&bytes).map_err(|e| format!("Failed to save the track: {}", e))?;
        }
        file.flush().map_err(|e| format!("Failed to save the track: {}", e))?;
        drop(file);
        let digest: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();
        if written != asset.size || digest != asset.sha256 {
            return Err("The downloaded track didn't match the library's checksum - discarded. Try again.".into());
        }
        std::fs::rename(&part, dest).map_err(|e| format!("Failed to save the track: {}", e))?;
        on_progress(written);
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

async fn ensure_track_file(app_handle: &AppHandle, window: &Window, track: &MusicTrack, variant: &str) -> Result<PathBuf, String> {
    let dir = music_dir(app_handle)?;
    let (asset, folder) = match (variant, &track.preview) {
        ("preview", Some(preview)) => (preview, "previews"),
        ("preview", None) | ("full", _) => (&track.file, "tracks"),
        _ => return Err(format!("Unknown track variant '{}'", variant)),
    };
    let dest = asset_dest(&dir, folder, &track.id, asset);
    if is_present(&dest, asset.size) {
        return Ok(dest);
    }
    let (track_id, variant_name, total) = (track.id.clone(), variant.to_string(), asset.size);
    let emitter = window.clone();
    let progress = move |downloaded: u64| {
        let _ = emitter.emit("music-download-progress", MusicDownloadProgress { track_id: track_id.clone(), variant: variant_name.clone(), downloaded, total });
    };
    fetch_asset(asset, &dest, &progress).await?;
    Ok(dest)
}

// A local, verified copy of a track - "preview" (the short clip, falling back to the song when the
// catalog has none) or "full" (the song itself, what goes on the timeline). Emits
// "music-download-progress" {trackId, variant, downloaded, total} while fetching.
#[tauri::command]
pub async fn get_music_track_file(app_handle: AppHandle, window: Window, track_id: String, variant: String) -> Result<String, String> {
    let track = find_track(&app_handle, &track_id).await?;
    let path = ensure_track_file(&app_handle, &window, &track, &variant).await?;
    Ok(path.to_string_lossy().into_owned())
}

// For a project whose library song has gone missing from disk (cleared app data, a project opened
// on another machine): fetches it again and returns where it now is; None when `expected_path` is
// still there.
#[tauri::command]
pub async fn restore_music_track(app_handle: AppHandle, window: Window, track_id: String, expected_path: String) -> Result<Option<String>, String> {
    if Path::new(&expected_path).is_file() {
        return Ok(None);
    }
    let track = find_track(&app_handle, &track_id).await?;
    let path = ensure_track_file(&app_handle, &window, &track, "full").await?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

// Briefcast's own synthesized sound effects (builtinSfx.ts): the stored WAV for `name`, written from
// `wav_base64` the first time. Called without the bytes, it just says whether one is already there
// (None when not), so a sound is only made once. Names are a plain, short alphabet - they become
// file names under the library's own folder, nowhere else.
#[tauri::command]
pub async fn store_builtin_sound(app_handle: AppHandle, name: String, wav_base64: Option<String>) -> Result<Option<String>, String> {
    if name.is_empty() || name.len() > 64 || !name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err("Invalid sound name".into());
    }
    let dir = music_dir(&app_handle)?.join("builtin");
    let path = dir.join(format!("{name}.wav"));
    if path.is_file() {
        return Ok(Some(path.to_string_lossy().into_owned()));
    }
    let Some(encoded) = wav_base64 else { return Ok(None) };
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).map_err(|e| format!("Bad sound data: {e}"))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Not a WAV file".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {}", dir.display(), e))?;
    // Written beside it first, then moved into place - never a half-written sound under the name.
    let tmp = dir.join(format!("{name}.wav.part"));
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Couldn't save the sound: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Couldn't save the sound: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

// Saves a library track to a place the user picked (the panel's Download - a save dialog chooses
// `dest_path`), fetching it first if it isn't on disk yet. Returns the path written.
#[tauri::command]
pub async fn save_music_track(app_handle: AppHandle, window: Window, track_id: String, dest_path: String) -> Result<String, String> {
    let dest = PathBuf::from(&dest_path);
    if dest.as_os_str().is_empty() || dest.is_dir() {
        return Err("Choose a file name to save the track as.".into());
    }
    let track = find_track(&app_handle, &track_id).await?;
    let src = ensure_track_file(&app_handle, &window, &track, "full").await?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create {}: {}", parent.display(), e))?;
    }
    std::fs::copy(&src, &dest).map_err(|e| format!("Couldn't save the track: {}", e))?;
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(url: &str) -> MusicAsset {
        MusicAsset { url: url.into(), size: 10, sha256: "a".repeat(64), start: None }
    }

    fn track(id: &str, license: &str) -> MusicTrack {
        MusicTrack {
            id: id.into(),
            title: "Song".into(),
            artist: "Someone".into(),
            kind: "music".into(),
            genre: None,
            moods: vec![],
            tags: vec![],
            energy: Some(9),
            duration: 60.0,
            bpm: None,
            beats: None,
            highlight_start: Some(75.0),
            peaks: vec![1; 1000],
            file: asset("tracks/song.m4a"),
            preview: Some(MusicAsset { sha256: "nope".into(), ..asset("previews/song.m4a") }),
            license: MusicLicense { name: license.into(), url: None, attribution: None, source_url: None },
        }
    }

    #[test]
    fn resolves_relative_urls_against_the_catalog() {
        let base = parse_source("https://cdn.example.com/music/v1/catalog.json").unwrap();
        assert_eq!(resolve_url(&base, "tracks/a.m4a").as_deref(), Some("https://cdn.example.com/music/v1/tracks/a.m4a"));
        assert_eq!(resolve_url(&base, "https://other.example.com/a.mp3").as_deref(), Some("https://other.example.com/a.mp3"));
        assert_eq!(resolve_url(&base, "ftp://x/a.mp3"), None);
        let local = parse_source("C:/lib/dist/catalog.json").unwrap();
        assert_eq!(resolve_url(&local, "tracks/a.m4a").map(PathBuf::from), Some(PathBuf::from("C:/lib/dist").join("tracks/a.m4a")));
    }

    #[test]
    fn sanitize_drops_bad_entries_and_clamps_fields() {
        let base = parse_source("https://cdn.example.com/catalog.json").unwrap();
        let catalog = MusicCatalog {
            version: 1,
            updated_at: None,
            tracks: vec![track("ok-1", "CC0-1.0"), track("ok-1", "CC0-1.0"), track("Bad Id", "CC0-1.0"), track("nc", "CC-BY-NC-4.0"), track("nd", "CC-BY-ND-4.0")],
        };
        let out = sanitize_catalog(&base, catalog).unwrap();
        assert_eq!(out.tracks.len(), 1);
        let t = &out.tracks[0];
        assert_eq!(t.file.url, "https://cdn.example.com/tracks/song.m4a");
        assert!(t.preview.is_none(), "a preview with a bad checksum is dropped, not the track");
        assert_eq!(t.peaks.len(), MAX_PEAKS);
        assert_eq!(t.energy, Some(5));
        assert_eq!(t.highlight_start, None, "a highlight past the end is ignored");
    }

    #[test]
    fn refuses_catalogs_from_the_future() {
        let base = parse_source("https://cdn.example.com/catalog.json").unwrap();
        assert!(sanitize_catalog(&base, MusicCatalog { version: 99, updated_at: None, tracks: vec![] }).is_err());
    }

    #[test]
    fn content_addressed_file_names() {
        let a = MusicAsset { url: "https://x/t/song.MP3?v=2".into(), size: 1, sha256: "0123456789abcdef".repeat(4), start: None };
        assert_eq!(asset_dest(Path::new("m"), "tracks", "song", &a), Path::new("m").join("tracks").join("song-0123456789abcdef.mp3"));
        assert_eq!(asset_extension("https://x/t/noext"), "m4a");
    }
}
