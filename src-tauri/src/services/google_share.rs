// services/google_share.rs
//
// Sharing a finished video straight from Briefcast (SharePanel.tsx): upload it to YouTube with its
// title, description (chapters included), tags, privacy and captions, or put it on the user's own
// Google Drive behind an "anyone with the link" share link. Both run on the user's own Google
// account - nothing passes through a Briefcast server.
//
// Sign-in is OAuth 2.0 for installed apps: the consent page opens in the user's browser and
// redirects back to a one-shot listener on 127.0.0.1 (a random port), with PKCE so the code is
// useless to anyone else who sees it. The refresh token is kept, encrypted for this Windows user
// (DPAPI), so later uploads need no sign-in; access tokens live in memory only.
//
// Uploads use Google's resumable protocol: the file goes up in 8 MiB chunks, and a dropped
// connection resumes from what the server confirms it has, rather than starting over. Progress
// arrives as `share-upload-progress`; cancel_share_upload stops one.
//
// The OAuth client (a "Desktop app" client of a Google Cloud project with the YouTube Data API v3
// and Drive API enabled) is a build-time setting like the telemetry keys: BRIEFCAST_GOOGLE_CLIENT_ID
// and BRIEFCAST_GOOGLE_CLIENT_SECRET (an installed app's client secret isn't confidential - Google
// says so - it only identifies the app). The same names are read from the environment at run time
// too, so a dev build can use a test project.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, Window};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64URL, Engine as _};
use sha2::{Digest, Sha256};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
// Google refuses a single request that mixes YouTube and Drive scopes ("cannot be requested
// together"), so each service is its own sign-in with its own refresh token, asked for when it is
// first used.
//   youtube: youtube.upload uploads videos; youtube.force-ssl adds captions (captions.insert needs it).
//   drive:   drive.file - only files Briefcast itself creates on Drive; nothing else there is visible.
const YOUTUBE: &str = "youtube";
const DRIVE: &str = "drive";

fn scopes_for(service: &str) -> Result<&'static str, String> {
    match service {
        YOUTUBE => Ok("openid email profile https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl"),
        DRIVE => Ok("openid email profile https://www.googleapis.com/auth/drive.file"),
        other => Err(format!("Unknown Google service: {other}")),
    }
}
// Resumable chunks must be multiples of 256 KiB.
const CHUNK: usize = 32 * 256 * 1024;
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct GoogleShareState {
    // Per service: (access token, valid until) - refreshed from the stored refresh token when it runs out.
    access: Mutex<HashMap<String, (String, Instant)>>,
    uploads: Mutex<HashMap<String, Arc<AtomicBool>>>,
    sign_in_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

fn client_credentials() -> Option<(String, String)> {
    let id = std::env::var("BRIEFCAST_GOOGLE_CLIENT_ID").ok().or_else(|| option_env!("BRIEFCAST_GOOGLE_CLIENT_ID").map(String::from))?;
    let secret = std::env::var("BRIEFCAST_GOOGLE_CLIENT_SECRET").ok().or_else(|| option_env!("BRIEFCAST_GOOGLE_CLIENT_SECRET").map(String::from)).unwrap_or_default();
    (!id.trim().is_empty()).then(|| (id.trim().to_string(), secret.trim().to_string()))
}

fn http() -> reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("Briefcast/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
    .clone()
}

// ---- The stored account -------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleAccount {
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct StoredAccount {
    // service ("youtube" | "drive") -> refresh token for that service's scopes.
    #[serde(default)]
    refresh_tokens: HashMap<String, String>,
    account: GoogleAccount,
}

fn account_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| format!("No app data folder: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create the app data folder: {e}"))?;
    Ok(dir.join("google_account.bin"))
}

fn load_account(app: &AppHandle) -> Option<StoredAccount> {
    let bytes = std::fs::read(account_path(app).ok()?).ok()?;
    serde_json::from_slice(&unprotect(&bytes)?).ok()
}

fn save_account(app: &AppHandle, account: &StoredAccount) -> Result<(), String> {
    let json = serde_json::to_vec(account).map_err(|e| e.to_string())?;
    let path = account_path(app)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, protect(&json)?).map_err(|e| format!("Couldn't save the sign-in: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Couldn't save the sign-in: {e}"))
}

// The refresh token is encrypted for the signed-in Windows user (DPAPI) - another account on the
// machine, or a copy of the file elsewhere, can't use it.
#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, windows::core::w!("Briefcast Google sign-in"), None, None, None, 0, &mut output).map_err(|e| format!("Couldn't encrypt the sign-in: {e}"))?;
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData as _));
        Ok(out)
    }
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut output).ok()?;
        let out = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData as _));
        Some(out)
    }
}

// Elsewhere the file sits in the per-user app data folder, readable by its owner only.
#[cfg(not(windows))]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

#[cfg(not(windows))]
fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    Some(data.to_vec())
}

// ---- Tokens ---------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs.iter().map(|(k, v)| format!("{}={}", k, urlencoding::encode(v))).collect::<Vec<_>>().join("&")
}

async fn post_token(body: String) -> Result<TokenResponse, String> {
    let resp = http()
        .post(TOKEN_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Google: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(google_error("Google sign-in", status.as_u16(), &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("Unexpected answer from Google: {e}"))
}

// A usable access token: the cached one, or a fresh one from the stored refresh token.
async fn access_token(app: &AppHandle, state: &GoogleShareState, service: &str) -> Result<String, String> {
    if let Some((token, until)) = state.access.lock().unwrap_or_else(|e| e.into_inner()).get(service).cloned() {
        if Instant::now() + Duration::from_secs(60) < until {
            return Ok(token);
        }
    }
    let (id, secret) = client_credentials().ok_or("Google sign-in isn't set up in this build")?;
    let stored = load_account(app).ok_or("Sign in to your Google account first")?;
    let refresh = stored.refresh_tokens.get(service).ok_or("Allow Briefcast to use your Google account for this first")?;
    let token = post_token(form(&[("client_id", &id), ("client_secret", &secret), ("refresh_token", refresh), ("grant_type", "refresh_token")])).await.map_err(|e| {
        if e.contains("invalid_grant") {
            "Your Google sign-in has expired or was revoked - sign in again".to_string()
        } else {
            e
        }
    })?;
    let until = Instant::now() + Duration::from_secs(token.expires_in.unwrap_or(3600));
    state.access.lock().unwrap_or_else(|e| e.into_inner()).insert(service.to_string(), (token.access_token.clone(), until));
    Ok(token.access_token)
}

// A readable message from a Google API error body ({"error": {"message", "errors": [{reason}]}}
// or OAuth's {"error", "error_description"}).
fn google_error(what: &str, status: u16, body: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let reason = v["error"]["errors"][0]["reason"].as_str().unwrap_or("");
    let message = v["error"]["message"].as_str().or(v["error_description"].as_str()).or(v["error"].as_str()).unwrap_or("").to_string();
    let hint = match reason {
        "quotaExceeded" | "uploadLimitExceeded" => " - YouTube's upload limit for today has been reached; try again tomorrow",
        "youtubeSignupRequired" => " - this Google account has no YouTube channel yet; create one on youtube.com first",
        "forbidden" | "insufficientPermissions" => " - sign in again and allow every permission Briefcast asks for",
        _ => "",
    };
    format!("{what} failed ({status}){}{}{hint}", if message.is_empty() { "" } else { ": " }, message)
}

// ---- Sign in ------------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct GoogleStatus {
    configured: bool,
    account: Option<GoogleAccount>,
    // The services ("youtube", "drive") the user has allowed so far.
    services: Vec<String>,
}

#[tauri::command]
pub async fn google_account_status(app: AppHandle) -> GoogleStatus {
    let stored = load_account(&app);
    let services = stored.as_ref().map(|s| s.refresh_tokens.keys().cloned().collect()).unwrap_or_default();
    GoogleStatus { configured: client_credentials().is_some(), account: stored.map(|a| a.account), services }
}

#[tauri::command]
pub async fn google_cancel_sign_in(state: State<'_, GoogleShareState>) -> Result<(), String> {
    if let Some(flag) = state.sign_in_cancel.lock().unwrap_or_else(|e| e.into_inner()).take() {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn google_sign_in(app: AppHandle, state: State<'_, GoogleShareState>, service: String) -> Result<GoogleStatus, String> {
    let scopes = scopes_for(&service)?;
    let (id, secret) = client_credentials().ok_or("Google sign-in isn't set up in this build")?;
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| format!("Couldn't start the sign-in: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_token(48);
    let challenge = B64URL.encode(Sha256::digest(verifier.as_bytes()));
    let csrf = random_token(24);
    let url = format!(
        "{AUTH_URL}?{}",
        form(&[
            ("client_id", &id),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("scope", scopes),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &csrf),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ])
    );
    let cancel = Arc::new(AtomicBool::new(false));
    *state.sign_in_cancel.lock().unwrap_or_else(|e| e.into_inner()) = Some(cancel.clone());
    crate::services::share::open_share_url(url)?;
    let code = crate::services::responsiveness::blocking(move || wait_for_redirect(listener, &csrf, &cancel)).await??;
    let token = post_token(form(&[
        ("client_id", &id),
        ("client_secret", &secret),
        ("code", &code),
        ("code_verifier", &verifier),
        ("redirect_uri", &redirect),
        ("grant_type", "authorization_code"),
    ]))
    .await?;
    let refresh = token.refresh_token.clone().ok_or("Google didn't grant lasting access - try signing in again")?;
    let info: serde_json::Value = http()
        .get(USERINFO_URL)
        .bearer_auth(&token.access_token)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Google: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Unexpected answer from Google: {e}"))?;
    let account = GoogleAccount {
        email: info["email"].as_str().unwrap_or("your Google account").to_string(),
        name: info["name"].as_str().map(String::from),
        picture: info["picture"].as_str().map(String::from),
    };
    // A second service keeps the first one's token - unless it was granted by a different Google
    // account, whose token then no longer belongs with this one.
    let mut refresh_tokens = match load_account(&app) {
        Some(prev) if prev.account.email == account.email => prev.refresh_tokens,
        _ => {
            state.access.lock().unwrap_or_else(|e| e.into_inner()).clear();
            HashMap::new()
        }
    };
    refresh_tokens.insert(service.clone(), refresh);
    let services = refresh_tokens.keys().cloned().collect();
    save_account(&app, &StoredAccount { refresh_tokens, account: account.clone() })?;
    let until = Instant::now() + Duration::from_secs(token.expires_in.unwrap_or(3600));
    state.access.lock().unwrap_or_else(|e| e.into_inner()).insert(service, (token.access_token, until));
    Ok(GoogleStatus { configured: true, account: Some(account), services })
}

#[tauri::command]
pub async fn google_sign_out(app: AppHandle, state: State<'_, GoogleShareState>) -> Result<(), String> {
    state.access.lock().unwrap_or_else(|e| e.into_inner()).clear();
    if let Some(stored) = load_account(&app) {
        // Revoked at Google too, so the access really ends - best effort.
        for token in stored.refresh_tokens.values() {
            let _ = http()
                .post(REVOKE_URL)
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .body(form(&[("token", token)]))
                .send()
                .await;
        }
    }
    if let Ok(path) = account_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

// URL-safe random text from the OS's cryptographic RNG - the PKCE verifier and the CSRF state.
fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    fill_random(&mut buf);
    B64URL.encode(buf)
}

#[cfg(windows)]
fn fill_random(buf: &mut [u8]) {
    // RtlGenRandom (SystemFunction036) - the CSPRNG behind rand_s; no extra crate needed.
    #[link(name = "advapi32")]
    extern "system" {
        #[link_name = "SystemFunction036"]
        fn rtl_gen_random(buffer: *mut u8, length: u32) -> u8;
    }
    unsafe {
        rtl_gen_random(buf.as_mut_ptr(), buf.len() as u32);
    }
}

#[cfg(not(windows))]
fn fill_random(buf: &mut [u8]) {
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(buf);
    }
}

// Serves exactly one request on the loopback listener - Google's redirect - and returns its code.
fn wait_for_redirect(listener: TcpListener, csrf: &str, cancel: &AtomicBool) -> Result<String, String> {
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + SIGN_IN_TIMEOUT;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err("Sign-in cancelled".into());
        }
        if Instant::now() > deadline {
            return Err("Sign-in timed out - try again".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(conn) => conn,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let target = request.split_whitespace().nth(1).unwrap_or("/");
        let query: HashMap<String, String> = target
            .split_once('?')
            .map(|(_, q)| q)
            .unwrap_or("")
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .map(|(k, v)| (k.to_string(), urlencoding::decode(&v.replace('+', " ")).map(|c| c.into_owned()).unwrap_or_default()))
            .collect();
        // Browsers also ask for /favicon.ico - answer and keep waiting for the real redirect.
        if !query.contains_key("code") && !query.contains_key("error") {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            continue;
        }
        let ok = query.get("state").map(|s| s == csrf).unwrap_or(false) && query.contains_key("code");
        let page = if ok {
            "<h2>You're signed in.</h2><p>You can close this tab and go back to Briefcast.</p>"
        } else {
            "<h2>Sign-in didn't complete.</h2><p>Go back to Briefcast and try again.</p>"
        };
        let html = format!("<!doctype html><meta charset=utf-8><title>Briefcast</title><body style=\"font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;text-align:center;color:#222\">{page}</body>");
        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).as_bytes());
        if let Some(error) = query.get("error") {
            return Err(if error == "access_denied" { "Sign-in was declined".into() } else { format!("Google sign-in failed: {error}") });
        }
        if !ok {
            return Err("Sign-in failed a security check - try again".into());
        }
        return Ok(query["code"].clone());
    }
}

// ---- Resumable upload -------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadProgress {
    job_id: String,
    sent: u64,
    total: u64,
    stage: &'static str,
}

#[tauri::command]
pub async fn cancel_share_upload(state: State<'_, GoogleShareState>, job_id: String) -> Result<(), String> {
    if let Some(flag) = state.uploads.lock().unwrap_or_else(|e| e.into_inner()).get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

struct UploadJob<'a> {
    app: &'a AppHandle,
    window: &'a Window,
    state: &'a GoogleShareState,
    // Which service's token the upload runs under (YOUTUBE or DRIVE).
    service: &'static str,
    job_id: String,
    cancel: Arc<AtomicBool>,
}

impl UploadJob<'_> {
    fn progress(&self, sent: u64, total: u64, stage: &'static str) {
        let _ = self.window.emit("share-upload-progress", UploadProgress { job_id: self.job_id.clone(), sent, total, stage });
    }

    // Starts a resumable session at `init_url` with `metadata`, then sends the file to it -
    // resuming from whatever Google confirms it has after a dropped connection. Returns the final
    // response's JSON.
    async fn upload(&self, init_url: &str, metadata: &serde_json::Value, path: &PathBuf, mime: &str) -> Result<serde_json::Value, String> {
        let total = std::fs::metadata(path).map_err(|e| format!("Can't read the video: {e}"))?.len();
        let token = access_token(self.app, self.state, self.service).await?;
        let resp = http()
            .post(init_url)
            .bearer_auth(&token)
            .header(reqwest::header::CONTENT_TYPE, "application/json; charset=UTF-8")
            .header("X-Upload-Content-Length", total.to_string())
            .header("X-Upload-Content-Type", mime)
            .body(metadata.to_string())
            .send()
            .await
            .map_err(|e| format!("Couldn't reach Google: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            return Err(google_error("Starting the upload", status, &resp.text().await.unwrap_or_default()));
        }
        let session = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or("Google didn't start an upload session")?.to_string();
        let mut file = std::fs::File::open(path).map_err(|e| format!("Can't read the video: {e}"))?;
        let mut offset: u64 = 0;
        let mut failures = 0u32;
        self.progress(0, total, "uploading");
        loop {
            if self.cancel.load(Ordering::SeqCst) {
                // Tell Google to drop the partial upload; ignore the answer.
                let _ = http().delete(&session).bearer_auth(&access_token(self.app, self.state, self.service).await.unwrap_or_default()).send().await;
                return Err("Upload cancelled".into());
            }
            let len = ((total - offset) as usize).min(CHUNK);
            let mut chunk = vec![0u8; len];
            file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
            file.read_exact(&mut chunk).map_err(|e| format!("Can't read the video: {e}"))?;
            let range = if total == 0 { "bytes */0".to_string() } else { format!("bytes {}-{}/{}", offset, offset + len as u64 - 1, total) };
            let token = access_token(self.app, self.state, self.service).await?;
            let sent = http().put(&session).bearer_auth(&token).header(reqwest::header::CONTENT_RANGE, range).body(chunk).timeout(Duration::from_secs(300)).send().await;
            match sent {
                Ok(resp) if resp.status().is_success() => {
                    self.progress(total, total, "processing");
                    return resp.json().await.map_err(|e| format!("Unexpected answer from Google: {e}"));
                }
                // 308 Resume Incomplete: carry on from what it has.
                Ok(resp) if resp.status().as_u16() == 308 => {
                    offset = confirmed_offset(&resp);
                    failures = 0;
                    self.progress(offset, total, "uploading");
                }
                Ok(resp) if resp.status().is_server_error() || resp.status().as_u16() == 429 => {
                    failures += 1;
                    if failures > 8 {
                        let status = resp.status().as_u16();
                        return Err(google_error("Upload", status, &resp.text().await.unwrap_or_default()));
                    }
                    offset = self.resume_offset(&session, total).await.unwrap_or(offset);
                }
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    return Err(google_error("Upload", status, &resp.text().await.unwrap_or_default()));
                }
                // The connection dropped mid-chunk: ask where it got to, after a backoff.
                Err(e) => {
                    failures += 1;
                    if failures > 8 {
                        return Err(format!("The upload kept failing: {e}"));
                    }
                    let wait = Duration::from_secs((1u64 << failures.min(5)).min(30));
                    let _ = crate::services::responsiveness::blocking(move || std::thread::sleep(wait)).await;
                    match self.resume_offset(&session, total).await {
                        Some(o) => offset = o,
                        None => continue,
                    }
                }
            }
            if offset >= total && total > 0 {
                // Everything's there but no final answer yet - ask for it.
                match self.resume_offset(&session, total).await {
                    Some(o) if o >= total => {}
                    Some(o) => offset = o,
                    None => {}
                }
            }
        }
    }

    // Where an interrupted upload stands: PUT with "bytes */total".
    async fn resume_offset(&self, session: &str, total: u64) -> Option<u64> {
        let token = access_token(self.app, self.state, self.service).await.ok()?;
        let resp = http().put(session).bearer_auth(&token).header(reqwest::header::CONTENT_RANGE, format!("bytes */{total}")).header(reqwest::header::CONTENT_LENGTH, "0").send().await.ok()?;
        match resp.status().as_u16() {
            308 => Some(confirmed_offset(&resp)),
            200 | 201 => Some(total),
            _ => None,
        }
    }
}

// The byte after the last one Google confirmed ("Range: bytes=0-N"), 0 when it has none yet.
fn confirmed_offset(resp: &reqwest::Response) -> u64 {
    resp.headers()
        .get(reqwest::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|r| r.rsplit('-').next())
        .and_then(|n| n.trim().parse::<u64>().ok())
        .map(|last| last + 1)
        .unwrap_or(0)
}

fn mime_for(path: &PathBuf) -> &'static str {
    match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).as_deref() {
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        _ => "video/mp4",
    }
}

fn register_upload(state: &GoogleShareState, job_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    state.uploads.lock().unwrap_or_else(|e| e.into_inner()).insert(job_id.to_string(), flag.clone());
    flag
}

fn unregister_upload(state: &GoogleShareState, job_id: &str) {
    state.uploads.lock().unwrap_or_else(|e| e.into_inner()).remove(job_id);
}

// ---- YouTube ------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeUploadRequest {
    pub job_id: String,
    pub path: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub category_id: String,
    // "private" | "unlisted" | "public"
    pub privacy: String,
    pub made_for_kids: bool,
    // An .srt to attach as the video's captions, and its language (BCP-47, e.g. "en").
    pub captions_srt: Option<String>,
    pub captions_language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YouTubeUploadResult {
    video_id: String,
    url: String,
    studio_url: String,
    // What YouTube actually set - an app that hasn't passed YouTube's API audit can only upload
    // private videos, whatever was asked for.
    privacy: String,
    captions_error: Option<String>,
}

// YouTube's own limits: a title of at most 100 characters without angle brackets, a description
// of at most 5,000 bytes, tags of at most 500 characters in all.
fn clean_title(title: &str) -> String {
    let t: String = title.replace(['<', '>'], "").trim().chars().take(100).collect();
    if t.is_empty() { "Untitled video".into() } else { t }
}

fn clean_description(description: &str) -> String {
    let d = description.replace(['<', '>'], "");
    let mut out = String::new();
    for c in d.chars() {
        if out.len() + c.len_utf8() > 5000 {
            break;
        }
        out.push(c);
    }
    out
}

fn clean_tags(tags: &[String]) -> Vec<String> {
    let mut used = 0;
    tags.iter()
        .map(|t| t.replace(['<', '>', ','], "").trim().to_string())
        .filter(|t| !t.is_empty())
        .take_while(|t| {
            // A tag with a space counts its surrounding quotes.
            used += t.chars().count() + if t.contains(' ') { 2 } else { 0 } + 1;
            used <= 500
        })
        .collect()
}

#[tauri::command]
pub async fn youtube_upload(app: AppHandle, window: Window, state: State<'_, GoogleShareState>, request: YouTubeUploadRequest) -> Result<YouTubeUploadResult, String> {
    let r = request;
    let path = PathBuf::from(&r.path);
    if !path.is_file() {
        return Err("The video file isn't there any more".into());
    }
    let privacy = match r.privacy.as_str() {
        "public" | "unlisted" => r.privacy.clone(),
        _ => "private".to_string(),
    };
    let mut snippet = serde_json::json!({
        "title": clean_title(&r.title),
        "description": clean_description(&r.description),
        "tags": clean_tags(&r.tags),
        "categoryId": if r.category_id.chars().all(|c| c.is_ascii_digit()) && !r.category_id.is_empty() { r.category_id.clone() } else { "22".into() },
    });
    if let Some(lang) = r.captions_language.as_deref().filter(|l| valid_language(l)) {
        snippet["defaultLanguage"] = lang.into();
        snippet["defaultAudioLanguage"] = lang.into();
    }
    let metadata = serde_json::json!({ "snippet": snippet, "status": { "privacyStatus": privacy, "selfDeclaredMadeForKids": r.made_for_kids, "embeddable": true } });
    let cancel = register_upload(&state, &r.job_id);
    let job = UploadJob { app: &app, window: &window, state: &state, service: YOUTUBE, job_id: r.job_id.clone(), cancel };
    let result = job.upload("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", &metadata, &path, mime_for(&path)).await;
    let video = match result {
        Ok(v) => v,
        Err(e) => {
            unregister_upload(&state, &r.job_id);
            return Err(e);
        }
    };
    let video_id = video["id"].as_str().ok_or("YouTube didn't say where the video went")?.to_string();
    let actual_privacy = video["status"]["privacyStatus"].as_str().unwrap_or(&privacy).to_string();
    // Captions: the timeline's own lines, as the video's subtitle track.
    let mut captions_error = None;
    if let Some(srt) = r.captions_srt.as_deref().filter(|s| !s.trim().is_empty()) {
        job.progress(1, 1, "captions");
        let lang = r.captions_language.as_deref().filter(|l| valid_language(l)).unwrap_or("en");
        if let Err(e) = upload_captions(&app, &state, &video_id, lang, srt).await {
            captions_error = Some(e);
        }
    }
    unregister_upload(&state, &r.job_id);
    Ok(YouTubeUploadResult {
        url: format!("https://youtu.be/{video_id}"),
        studio_url: format!("https://studio.youtube.com/video/{video_id}/edit"),
        video_id,
        privacy: actual_privacy,
        captions_error,
    })
}

// A BCP-47 style code YouTube accepts ("en", "pt-BR"). The caption language setting can also be
// "auto" (let Whisper detect it), which isn't a language - sending it as the video's defaultLanguage
// makes YouTube refuse the whole upload with a 400, so it falls through to the callers' defaults.
fn valid_language(lang: &str) -> bool {
    let mut parts = lang.split('-');
    let primary = parts.next().unwrap_or("");
    lang.len() <= 12
        && (2..=3).contains(&primary.len())
        && primary.chars().all(|c| c.is_ascii_alphabetic())
        && parts.all(|p| !p.is_empty() && p.len() <= 8 && p.chars().all(|c| c.is_ascii_alphanumeric()))
}

// captions.insert as a multipart/related upload: the caption's metadata, then the .srt itself.
async fn upload_captions(app: &AppHandle, state: &GoogleShareState, video_id: &str, language: &str, srt: &str) -> Result<(), String> {
    let token = access_token(app, state, YOUTUBE).await?;
    let boundary = format!("briefcast-{}", random_token(12));
    let meta = serde_json::json!({ "snippet": { "videoId": video_id, "language": language, "name": "", "isDraft": false } });
    let body = format!(
        "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n{srt}\r\n--{boundary}--\r\n"
    );
    let resp = http()
        .post("https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet")
        .bearer_auth(&token)
        .header(reqwest::header::CONTENT_TYPE, format!("multipart/related; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach YouTube: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status().as_u16();
        Err(google_error("Adding the captions", status, &resp.text().await.unwrap_or_default()))
    }
}

// ---- Share link (Google Drive) ------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveShareRequest {
    pub job_id: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveShareResult {
    file_id: String,
    link: String,
}

#[tauri::command]
pub async fn drive_share_link(app: AppHandle, window: Window, state: State<'_, GoogleShareState>, request: DriveShareRequest) -> Result<DriveShareResult, String> {
    let r = request;
    let path = PathBuf::from(&r.path);
    if !path.is_file() {
        return Err("The video file isn't there any more".into());
    }
    let name: String = r.name.replace(['/', '\\'], "-").trim().chars().take(200).collect();
    let metadata = serde_json::json!({ "name": if name.is_empty() { "Video".to_string() } else { name }, "mimeType": mime_for(&path) });
    let cancel = register_upload(&state, &r.job_id);
    let job = UploadJob { app: &app, window: &window, state: &state, service: DRIVE, job_id: r.job_id.clone(), cancel };
    let result = job.upload("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id", &metadata, &path, mime_for(&path)).await;
    unregister_upload(&state, &r.job_id);
    let file = result?;
    let file_id = file["id"].as_str().ok_or("Drive didn't say where the file went")?.to_string();
    let token = access_token(&app, &state, DRIVE).await?;
    // Anyone with the link can watch; only the owner can change or delete it.
    let resp = http()
        .post(format!("https://www.googleapis.com/drive/v3/files/{file_id}/permissions"))
        .bearer_auth(&token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "role": "reader", "type": "anyone" }).to_string())
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Google Drive: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        return Err(google_error("Turning on link sharing", status, &resp.text().await.unwrap_or_default()));
    }
    let info: serde_json::Value = http()
        .get(format!("https://www.googleapis.com/drive/v3/files/{file_id}?fields=webViewLink"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Google Drive: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Unexpected answer from Google Drive: {e}"))?;
    let link = info["webViewLink"].as_str().map(String::from).unwrap_or_else(|| format!("https://drive.google.com/file/d/{file_id}/view"));
    Ok(DriveShareResult { file_id, link })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_limits_are_kept() {
        assert_eq!(clean_title("  <b>Hi</b>  "), "bHi/b");
        assert_eq!(clean_title(""), "Untitled video");
        assert_eq!(clean_title(&"x".repeat(150)).chars().count(), 100);
        assert!(clean_description(&"é".repeat(4000)).len() <= 5000);
        let tags: Vec<String> = (0..200).map(|i| format!("tag number {i}")).collect();
        let kept = clean_tags(&tags);
        assert!(kept.iter().map(|t| t.len() + 3).sum::<usize>() <= 500 && !kept.is_empty());
    }

    #[test]
    fn redirect_codes_are_parsed_and_checked() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cancel = AtomicBool::new(false);
        let client = std::thread::spawn(move || {
            let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(b"GET /?state=abc&code=4%2F0Ab-x_y&scope=email HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        });
        let code = wait_for_redirect(listener, "abc", &cancel).unwrap();
        assert_eq!(code, "4/0Ab-x_y");
        assert!(client.join().unwrap().contains("signed in"));
    }

    #[test]
    fn only_real_language_codes_are_sent_to_youtube() {
        for ok in ["en", "fr", "pt-BR", "zh-Hans", "yue"] {
            assert!(valid_language(ok), "{ok}");
        }
        // "auto" is the caption setting for "detect it", and the old check let it through.
        for bad in ["", "auto", "AUTO", "e", "en-", "en--US", "english", "en_US", "en US"] {
            assert!(!valid_language(bad), "{bad}");
        }
    }

    #[test]
    fn random_tokens_differ() {
        let (a, b) = (random_token(32), random_token(32));
        assert_ne!(a, b);
        assert!(a.len() >= 42);
    }
}
