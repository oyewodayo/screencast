// A real, browser-trusted HTTPS certificate for phone transfers on the local network.
//
// phone_transfer.rs serves phones over plain HTTP because no certificate authority will sign a
// bare LAN IP, and a self-signed certificate makes the phone show "your connection is not private".
// This module gets each install its own Let's Encrypt wildcard certificate from Briefcast's
// certificate service (server/lan-certs in this repo), for a name that encodes the LAN address:
//
//     https://192-168-1-5.<install id>.<zone>:<port>   ->  this PC at 192.168.1.5
//
// The key pair is generated here and the private key never leaves this machine - only a
// certificate signing request is sent. (Shipping one shared certificate's key inside the app
// would make it extractable by anyone and get it revoked.)
//
// Entirely optional: with no service configured, or none reachable, phone transfer simply stays on
// HTTP. The phone page also only switches to HTTPS after checking the name actually resolves and
// connects, because some routers block public names that resolve to private addresses
// ("DNS rebinding protection") and a phone on a hotspot with no internet can't resolve it at all.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// The certificate service's base URL. A runtime environment variable wins, so `tauri dev` can
// point at a test deployment; release builds take it from the build environment, the same way the
// telemetry keys work. Unset means the feature is off.
fn api_base() -> Option<String> {
    std::env::var("BRIEFCAST_LAN_TLS_API")
        .ok()
        .or_else(|| option_env!("BRIEFCAST_LAN_TLS_API").map(str::to_string))
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Clone, Serialize, Deserialize)]
struct Install {
    api: String,
    install_id: String,
    secret: String,
    zone: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct CertMeta {
    not_before: i64,
    not_after: i64,
}

pub struct TlsMaterial {
    pub cert_pem: String,
    pub key_pem: String,
    pub install_id: String,
    pub zone: String,
}

#[derive(Deserialize)]
struct Registered {
    install_id: String,
    secret: String,
    zone: String,
}

#[derive(Deserialize)]
struct Issued {
    certificate_pem: String,
    not_before: i64,
    not_after: i64,
}

#[derive(Deserialize)]
struct ApiError {
    error: String,
    #[serde(default)]
    retry_after: Option<u64>,
}

pub struct EnsureError {
    pub message: String,
    // Set when the service said when to come back (e.g. this week's certificate capacity is used
    // up) - retrying sooner would only be refused again.
    pub retry_after: Option<Duration>,
}

impl From<String> for EnsureError {
    fn from(message: String) -> Self {
        Self { message, retry_after: None }
    }
}

impl From<&str> for EnsureError {
    fn from(message: &str) -> Self {
        Self { message: message.to_string(), retry_after: None }
    }
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// Renew once two thirds of the lifetime has passed - the schedule Let's Encrypt recommends, and
// one that keeps working as certificate lifetimes shrink.
fn needs_renewal(meta: &CertMeta, now: i64) -> bool {
    now >= meta.not_before + (meta.not_after - meta.not_before) * 2 / 3
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("lan_tls"))
        .map_err(|e| format!("No config folder: {e}"))
}

async fn read_json<T: for<'de> Deserialize<'de>>(path: &std::path::Path) -> Option<T> {
    serde_json::from_slice(&tokio::fs::read(path).await.ok()?).ok()
}

// Write-then-rename, so a crash mid-write never leaves a truncated key or certificate behind.
async fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    tokio::fs::write(&tmp, bytes).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, path).await.map_err(|e| e.to_string())
}

async fn api_error(context: &str, response: reqwest::Response) -> EnsureError {
    let status = response.status();
    match response.json::<ApiError>().await {
        Ok(e) => EnsureError {
            message: format!("{context}: {status}: {}", e.error),
            retry_after: e.retry_after.map(Duration::from_secs),
        },
        Err(_) => EnsureError { message: format!("{context}: {status}"), retry_after: None },
    }
}

// Returns a valid certificate, fetching or renewing one first if needed. Ok(None) when the feature
// isn't configured in this build.
pub fn configured() -> bool {
    api_base().is_some()
}

pub async fn ensure(app: &AppHandle) -> Result<Option<TlsMaterial>, EnsureError> {
    let Some(api) = api_base() else { return Ok(None) };
    let dir = dir(app)?;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
    let install_path = dir.join("install.json");
    let meta_path = dir.join("meta.json");
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");

    // An install registered with a different service (a test deployment, say) is useless here.
    let mut install = read_json::<Install>(&install_path).await.filter(|i| i.api == api);

    if let (Some(i), Some(meta), Ok(cert_pem), Ok(key_pem)) = (
        &install,
        read_json::<CertMeta>(&meta_path).await,
        tokio::fs::read_to_string(&cert_path).await,
        tokio::fs::read_to_string(&key_path).await,
    ) {
        if !needs_renewal(&meta, now_secs()) {
            return Ok(Some(TlsMaterial {
                cert_pem,
                key_pem,
                install_id: i.install_id.clone(),
                zone: i.zone.clone(),
            }));
        }
    }

    let client = reqwest::Client::builder()
        // Issuance waits on Let's Encrypt validating DNS, which takes several seconds.
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let install = match install.take() {
        Some(i) => i,
        None => {
            let response = client
                .post(format!("{api}/v1/installs"))
                .send()
                .await
                .map_err(|e| format!("Couldn't reach the certificate service: {e}"))?;
            if !response.status().is_success() {
                return Err(api_error("Registering failed", response).await);
            }
            let r: Registered = response.json().await.map_err(|e| e.to_string())?;
            let i = Install { api: api.clone(), install_id: r.install_id, secret: r.secret, zone: r.zone };
            write_atomic(&install_path, &serde_json::to_vec_pretty(&i).map_err(|e| e.to_string())?).await?;
            log::info!("LAN TLS: registered as {}", i.install_id);
            i
        }
    };

    // A fresh key for every certificate, generated and kept here.
    let key = rcgen::KeyPair::generate().map_err(|e| e.to_string())?;
    let mut params = rcgen::CertificateParams::new(vec![format!("*.{}.{}", install.install_id, install.zone)])
        .map_err(|e| e.to_string())?;
    // rcgen's default subject is "CN=rcgen self signed cert", and Let's Encrypt refuses a CSR whose
    // common name isn't one of its DNS names - the SAN alone is all that's needed.
    params.distinguished_name = rcgen::DistinguishedName::new();
    let csr_pem = params
        .serialize_request(&key)
        .and_then(|csr| csr.pem())
        .map_err(|e| e.to_string())?;

    let response = client
        .post(format!("{api}/v1/certificates"))
        .bearer_auth(format!("{}.{}", install.install_id, install.secret))
        .json(&serde_json::json!({ "csr_pem": csr_pem }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach the certificate service: {e}"))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        // The service no longer knows this install - register afresh next time.
        let _ = tokio::fs::remove_file(&install_path).await;
    }
    if !response.status().is_success() {
        return Err(api_error("Getting a certificate failed", response).await);
    }
    let issued: Issued = response.json().await.map_err(|e| e.to_string())?;

    let key_pem = key.serialize_pem();
    write_atomic(&key_path, key_pem.as_bytes()).await?;
    write_atomic(&cert_path, issued.certificate_pem.as_bytes()).await?;
    let meta = CertMeta { not_before: issued.not_before, not_after: issued.not_after };
    write_atomic(&meta_path, &serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?).await?;
    log::info!("LAN TLS: got a certificate for *.{}.{}", install.install_id, install.zone);

    Ok(Some(TlsMaterial {
        cert_pem: issued.certificate_pem,
        key_pem,
        install_id: install.install_id,
        zone: install.zone,
    }))
}

// "192.168.1.5" -> "192-168-1-5.<id>.<zone>" - only for the private addresses the certificate
// service will actually resolve.
pub fn host_for(ip: std::net::Ipv4Addr, install_id: &str, zone: &str) -> Option<String> {
    if !ip.is_private() {
        return None;
    }
    let [a, b, c, d] = ip.octets();
    Some(format!("{a}-{b}-{c}-{d}.{install_id}.{zone}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renews_at_two_thirds_of_lifetime() {
        let meta = CertMeta { not_before: 0, not_after: 90 };
        assert!(!needs_renewal(&meta, 59));
        assert!(needs_renewal(&meta, 60));
        assert!(needs_renewal(&meta, 100));
    }

    #[test]
    fn hosts_only_for_private_addresses() {
        assert_eq!(
            host_for("192.168.1.5".parse().unwrap(), "k3x9q2m7a1bc", "lan.example.com").as_deref(),
            Some("192-168-1-5.k3x9q2m7a1bc.lan.example.com")
        );
        assert_eq!(host_for("8.8.8.8".parse().unwrap(), "k3x9q2m7a1bc", "lan.example.com"), None);
    }

    #[test]
    fn csr_names_only_the_wildcard() {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(vec!["*.abc.lan.example.com".to_string()]).unwrap();
        params.distinguished_name = rcgen::DistinguishedName::new();
        let pem = params.serialize_request(&key).unwrap().pem().unwrap();
        assert!(pem.starts_with("-----BEGIN CERTIFICATE REQUEST-----"));
    }
}
