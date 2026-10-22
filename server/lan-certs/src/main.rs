// briefcast-lan-certs: gives every Briefcast install its own real HTTPS certificate for serving
// phones on the local network ("Transfer to phone" - src-tauri/src/services/phone_transfer.rs).
//
// The problem: a phone can only reach Briefcast at a LAN address like 192.168.1.5, and no public
// certificate authority will ever issue a certificate for a bare private IP. So Briefcast either
// serves plain HTTP or a self-signed certificate the phone warns about.
//
// The fix (the same one Plex uses for plex.direct): give each install a name under a zone this
// service is authoritative for, and encode the IP in the name itself:
//
//     192-168-1-5.k3x9q2m7a1bc.lan.example.com  ->  A 192.168.1.5
//
// Each install then holds a Let's Encrypt wildcard certificate for *.k3x9q2m7a1bc.lan.example.com,
// which covers whatever LAN address the PC happens to have today. This process is both halves:
//
//   * an authoritative DNS server for the zone (UDP + TCP) - answers the IP-encoded names, and
//     the _acme-challenge TXT records Let's Encrypt checks during issuance;
//   * a small HTTP API (behind the site's existing reverse proxy) that registers installs and
//     turns an install's certificate signing request into a signed certificate via ACME DNS-01.
//
// The private key is generated on the user's PC and never leaves it - only the CSR comes here.
// That is the whole point: one shared key (e.g. a site's wildcard certificate) bundled into the app
// would be extractable by anyone, and a certificate authority must revoke a certificate whose key
// is public.
//
// Only private (RFC 1918) addresses are ever answered, so the zone can't be used to point a
// trusted-looking HTTPS name at a public server.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hickory_proto::op::{Edns, Message, MessageType, OpCode, ResponseCode};
use hickory_proto::rr::rdata::{A, NS, SOA, TXT};
use hickory_proto::rr::{Name, RData, Record, RecordType};
use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, LetsEncrypt, NewAccount, NewOrder,
    OrderStatus, RetryPolicy,
};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};

// ---------------------------------------------------------------------------------------------
// Configuration - all from the environment, see deploy/briefcast-lan-certs.env.example.
// ---------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Config {
    // The delegated zone, e.g. "lan.example.com" (lowercase, no trailing dot).
    zone: String,
    // The host name the parent zone's NS record points at, e.g. "ns-lan.example.com".
    ns_host: String,
    // Mailbox for the SOA record, in DNS form ("hostmaster.example.com").
    soa_mailbox: String,
    dns_bind: SocketAddr,
    api_bind: SocketAddr,
    data_dir: PathBuf,
    acme_staging: bool,
    acme_contact: Option<String>,
    // FIRST certificates (new installs) allowed per rolling 7 days, across all installs. Let's
    // Encrypt allows 50 new certificates per registered domain per week, refilling one every ~3.4
    // hours; renewals of the same name are exempt, so they are not counted here. Raise this after
    // Let's Encrypt grants a rate-limit increase.
    weekly_cap: u32,
    // Read the client address from X-Forwarded-For (set when running behind nginx).
    trust_proxy: bool,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    fn from_env() -> Result<Self> {
        let zone = std::env::var("LAN_ZONE")
            .context("LAN_ZONE is required (e.g. lan.example.com)")?
            .trim()
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let ns_host = std::env::var("LAN_NS_HOST")
            .context("LAN_NS_HOST is required (the name the parent zone's NS record points at)")?
            .trim()
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let parent = zone.split_once('.').map(|(_, p)| p.to_string()).unwrap_or_else(|| zone.clone());
        Ok(Self {
            soa_mailbox: env_or("LAN_SOA_MAILBOX", &format!("hostmaster.{parent}")),
            zone,
            ns_host,
            dns_bind: env_or("LAN_DNS_BIND", "0.0.0.0:53").parse().context("LAN_DNS_BIND")?,
            api_bind: env_or("LAN_API_BIND", "127.0.0.1:8787").parse().context("LAN_API_BIND")?,
            data_dir: PathBuf::from(env_or("LAN_DATA_DIR", "/var/lib/briefcast-lan-certs")),
            acme_staging: env_or("LAN_ACME", "production") == "staging",
            acme_contact: std::env::var("LAN_ACME_CONTACT").ok().filter(|s| !s.is_empty()),
            weekly_cap: env_or("LAN_WEEKLY_CAP", "45").parse().context("LAN_WEEKLY_CAP")?,
            trust_proxy: env_or("LAN_TRUST_PROXY", "true") == "true",
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------------------------

struct AppState {
    config: Config,
    db: Mutex<rusqlite::Connection>,
    // _acme-challenge TXT values currently being validated, by full lowercase name.
    challenges: Mutex<HashMap<String, Vec<String>>>,
    // One ACME order at a time: keeps the TXT bookkeeping trivial and Let's Encrypt load polite.
    issuing: tokio::sync::Mutex<()>,
    account: tokio::sync::OnceCell<Account>,
    // Registrations per client address in the last hour.
    registrations: Mutex<HashMap<IpAddr, Vec<Instant>>>,
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn open_db(dir: &std::path::Path) -> Result<rusqlite::Connection> {
    std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
    let conn = rusqlite::Connection::open(dir.join("installs.sqlite3"))?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS installs (
             id TEXT PRIMARY KEY,
             secret_sha256 TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             created_ip TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS issuances (
             install_id TEXT NOT NULL,
             at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS issuances_at ON issuances(at);",
    )?;
    Ok(conn)
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

// Lowercase letters and digits only: install ids are DNS labels.
fn random_id(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..len).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

fn is_install_id(s: &str) -> bool {
    s.len() == 12 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

// ---------------------------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------------------------

// "192-168-1-5" -> 192.168.1.5, only for private addresses.
fn parse_dashed_private_ip(label: &str) -> Option<Ipv4Addr> {
    let parts: Vec<&str> = label.split('-').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut octets = [0u8; 4];
    for (i, part) in parts.iter().enumerate() {
        // No leading zeros: one canonical name per address.
        if part.is_empty() || (part.len() > 1 && part.starts_with('0')) {
            return None;
        }
        octets[i] = part.parse().ok()?;
    }
    let ip = Ipv4Addr::from(octets);
    ip.is_private().then_some(ip)
}

enum Answer {
    Records(Vec<Record>),
    // The name exists, but has nothing of the asked type.
    NoData,
    NxDomain,
    // Not in our zone - we are not a resolver.
    Refused,
}

const POSITIVE_TTL: u32 = 86400;
const NEGATIVE_TTL: u32 = 300;

fn soa_record(config: &Config) -> Option<Record> {
    let zone = Name::from_ascii(format!("{}.", config.zone)).ok()?;
    let soa = SOA::new(
        Name::from_ascii(format!("{}.", config.ns_host)).ok()?,
        Name::from_ascii(format!("{}.", config.soa_mailbox)).ok()?,
        // The zone's contents are computed, never edited - a fixed serial is honest.
        1,
        3600,
        600,
        604800,
        NEGATIVE_TTL,
    );
    Some(Record::from_rdata(zone, NEGATIVE_TTL, RData::SOA(soa)))
}

fn answer(state: &AppState, qname: &Name, qtype: RecordType) -> Answer {
    let config = &state.config;
    let full = qname.to_lowercase().to_ascii();
    let full = full.trim_end_matches('.');
    let relative = if full == config.zone {
        ""
    } else if let Some(rest) = full.strip_suffix(&format!(".{}", config.zone)) {
        rest
    } else {
        return Answer::Refused;
    };

    let labels: Vec<&str> = if relative.is_empty() { vec![] } else { relative.split('.').collect() };
    match labels.as_slice() {
        [] => match qtype {
            RecordType::SOA => soa_record(config).map(|r| Answer::Records(vec![r])).unwrap_or(Answer::NoData),
            RecordType::NS => match Name::from_ascii(format!("{}.", config.ns_host)) {
                Ok(ns) => Answer::Records(vec![Record::from_rdata(qname.clone(), POSITIVE_TTL, RData::NS(NS(ns)))]),
                Err(_) => Answer::NoData,
            },
            _ => Answer::NoData,
        },
        // An install's own name has no records, but exists (it has children).
        [id] if is_install_id(id) => Answer::NoData,
        ["_acme-challenge", id] if is_install_id(id) => {
            if qtype != RecordType::TXT {
                return Answer::NoData;
            }
            let values = state.challenges.lock().unwrap().get(full).cloned().unwrap_or_default();
            if values.is_empty() {
                return Answer::NoData;
            }
            Answer::Records(
                values
                    .into_iter()
                    .map(|v| Record::from_rdata(qname.clone(), 0, RData::TXT(TXT::new(vec![v]))))
                    .collect(),
            )
        }
        [ip_label, id] if is_install_id(id) => match parse_dashed_private_ip(ip_label) {
            Some(ip) if qtype == RecordType::A => {
                Answer::Records(vec![Record::from_rdata(qname.clone(), POSITIVE_TTL, RData::A(A(ip)))])
            }
            Some(_) => Answer::NoData,
            None => Answer::NxDomain,
        },
        _ => Answer::NxDomain,
    }
}

fn handle_dns(state: &AppState, packet: &[u8]) -> Option<Vec<u8>> {
    let request = Message::from_vec(packet).ok()?;
    if request.message_type() != MessageType::Query {
        return None;
    }
    let mut response = Message::new();
    response
        .set_id(request.id())
        .set_message_type(MessageType::Response)
        .set_op_code(request.op_code())
        .set_recursion_desired(request.recursion_desired())
        .set_recursion_available(false);
    if request.extensions().is_some() {
        let mut edns = Edns::new();
        edns.set_max_payload(1232);
        response.set_edns(edns);
    }

    if request.op_code() != OpCode::Query {
        response.set_response_code(ResponseCode::NotImp);
        return response.to_vec().ok();
    }
    let [query] = request.queries() else {
        response.set_response_code(ResponseCode::FormErr);
        return response.to_vec().ok();
    };
    response.add_query(query.clone());

    match answer(state, query.name(), query.query_type()) {
        Answer::Records(records) => {
            response.set_authoritative(true);
            response.add_answers(records);
        }
        Answer::NoData => {
            response.set_authoritative(true);
            if let Some(soa) = soa_record(&state.config) {
                response.add_name_server(soa);
            }
        }
        Answer::NxDomain => {
            response.set_authoritative(true).set_response_code(ResponseCode::NXDomain);
            if let Some(soa) = soa_record(&state.config) {
                response.add_name_server(soa);
            }
        }
        Answer::Refused => {
            response.set_response_code(ResponseCode::Refused);
        }
    }
    response.to_vec().ok()
}

async fn serve_dns_udp(state: Arc<AppState>) -> Result<()> {
    let socket = UdpSocket::bind(state.config.dns_bind)
        .await
        .with_context(|| format!("binding DNS (UDP) on {}", state.config.dns_bind))?;
    log::info!("DNS (UDP) listening on {}", state.config.dns_bind);
    let mut buf = vec![0u8; 4096];
    loop {
        let (len, peer) = match socket.recv_from(&mut buf).await {
            Ok(v) => v,
            Err(e) => {
                log::warn!("DNS UDP receive failed: {e}");
                continue;
            }
        };
        if let Some(reply) = handle_dns(&state, &buf[..len]) {
            let _ = socket.send_to(&reply, peer).await;
        }
    }
}

async fn serve_dns_tcp(state: Arc<AppState>) -> Result<()> {
    let listener = TcpListener::bind(state.config.dns_bind)
        .await
        .with_context(|| format!("binding DNS (TCP) on {}", state.config.dns_bind))?;
    log::info!("DNS (TCP) listening on {}", state.config.dns_bind);
    loop {
        let (mut stream, _) = match listener.accept().await {
            Ok(v) => v,
            Err(e) => {
                log::warn!("DNS TCP accept failed: {e}");
                continue;
            }
        };
        let state = state.clone();
        tokio::spawn(async move {
            // Length-prefixed messages (RFC 1035 4.2.2); give up on idle or slow clients.
            loop {
                let mut len = [0u8; 2];
                match tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut len)).await {
                    Ok(Ok(_)) => {}
                    _ => return,
                }
                let mut packet = vec![0u8; u16::from_be_bytes(len) as usize];
                match tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut packet)).await {
                    Ok(Ok(_)) => {}
                    _ => return,
                }
                let Some(reply) = handle_dns(&state, &packet) else { return };
                let mut framed = (reply.len() as u16).to_be_bytes().to_vec();
                framed.extend_from_slice(&reply);
                if stream.write_all(&framed).await.is_err() {
                    return;
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------------------------
// ACME
// ---------------------------------------------------------------------------------------------

async fn acme_account(state: &AppState) -> Result<&Account> {
    state
        .account
        .get_or_try_init(|| async {
            let path = state.config.data_dir.join(if state.config.acme_staging {
                "acme-account-staging.json"
            } else {
                "acme-account.json"
            });
            if let Ok(bytes) = tokio::fs::read(&path).await {
                let credentials: AccountCredentials = serde_json::from_slice(&bytes).context("reading ACME account")?;
                return Account::builder()?.from_credentials(credentials).await.context("restoring ACME account");
            }
            let contact: Vec<&str> = state.config.acme_contact.iter().map(|s| s.as_str()).collect();
            let directory = if state.config.acme_staging { LetsEncrypt::Staging.url() } else { LetsEncrypt::Production.url() };
            let (account, credentials) = Account::builder()?
                .create(
                    &NewAccount { contact: &contact, terms_of_service_agreed: true, only_return_existing: false },
                    directory.to_string(),
                    None,
                )
                .await
            .context("creating ACME account")?;
            tokio::fs::write(&path, serde_json::to_vec_pretty(&credentials)?).await?;
            log::info!("Created ACME account ({})", if state.config.acme_staging { "staging" } else { "production" });
            Ok(account)
        })
        .await
}

// Removes the challenge TXT records however issuance ends.
struct ChallengeGuard<'a> {
    state: &'a AppState,
    name: String,
}

impl Drop for ChallengeGuard<'_> {
    fn drop(&mut self) {
        self.state.challenges.lock().unwrap().remove(&self.name);
    }
}

async fn issue_certificate(state: &AppState, install_id: &str, csr_der: &[u8]) -> Result<String> {
    let account = acme_account(state).await?;
    let wildcard = format!("*.{install_id}.{}", state.config.zone);
    let mut order = account
        .new_order(&NewOrder::new(&[Identifier::Dns(wildcard.clone())]))
        .await
        .context("creating order")?;

    // Each challenge is marked ready as soon as its TXT value is being served. Let's Encrypt also
    // lists challenge types this service doesn't answer (some without a token) - only dns-01 is used.
    let guard = ChallengeGuard { state, name: format!("_acme-challenge.{install_id}.{}", state.config.zone) };
    let mut authorizations = order.authorizations();
    while let Some(authz) = authorizations.next().await {
        let mut authz = authz.context("fetching authorizations")?;
        match authz.status {
            AuthorizationStatus::Pending => {}
            AuthorizationStatus::Valid => continue,
            other => bail!("authorization is {other:?}"),
        }
        let mut challenge = authz.challenge(ChallengeType::Dns01).ok_or_else(|| anyhow!("no dns-01 challenge offered"))?;
        let value = challenge.key_authorization().dns_value();
        state.challenges.lock().unwrap().entry(guard.name.clone()).or_default().push(value);
        challenge.set_ready().await.context("marking challenge ready")?;
    }

    // Both waits together stay under Cloudflare's 100s limit for the request this runs inside.
    let validation = RetryPolicy::new().initial_delay(Duration::from_millis(500)).backoff(2.0).timeout(Duration::from_secs(60));
    let status = order.poll_ready(&validation).await.context("waiting for validation")?;
    if status != OrderStatus::Ready {
        bail!("order did not become ready ({status:?})");
    }
    drop(guard);

    order.finalize_csr(csr_der).await.context("finalizing order")?;
    let issuing = RetryPolicy::new().initial_delay(Duration::from_millis(500)).backoff(2.0).timeout(Duration::from_secs(30));
    order.poll_certificate(&issuing).await.context("downloading certificate")
}

// The CSR must be validly self-signed and ask for exactly this install's wildcard, nothing else.
fn check_csr(csr_pem: &str, install_id: &str, zone: &str) -> Result<Vec<u8>> {
    use x509_parser::certification_request::X509CertificationRequest;
    use x509_parser::extensions::{GeneralName, ParsedExtension};
    use x509_parser::prelude::FromDer;

    let (_, pem) = x509_parser::pem::parse_x509_pem(csr_pem.as_bytes()).map_err(|_| anyhow!("not a PEM CSR"))?;
    if pem.label != "CERTIFICATE REQUEST" {
        bail!("expected a CERTIFICATE REQUEST, got {}", pem.label);
    }
    let (_, csr) = X509CertificationRequest::from_der(&pem.contents).map_err(|_| anyhow!("malformed CSR"))?;
    csr.verify_signature().map_err(|_| anyhow!("CSR signature does not verify"))?;

    let expected = format!("*.{install_id}.{zone}");
    let mut names = Vec::new();
    for ext in csr.requested_extensions().into_iter().flatten() {
        if let ParsedExtension::SubjectAlternativeName(san) = ext {
            for name in &san.general_names {
                match name {
                    GeneralName::DNSName(dns) => names.push(dns.to_ascii_lowercase()),
                    other => bail!("unsupported subject alternative name {other:?}"),
                }
            }
        }
    }
    if names != [expected.clone()] {
        bail!("the CSR must name exactly {expected}");
    }
    Ok(pem.contents)
}

// ---------------------------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------------------------

struct ApiError {
    status: StatusCode,
    message: String,
    // Seconds until trying again is worthwhile - sent as Retry-After and in the body.
    retry_after: Option<u64>,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self { status, message: message.into(), retry_after: None }
    }

    fn retry_after(mut self, secs: u64) -> Self {
        self.retry_after = Some(secs);
        self
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(serde_json::json!({ "error": self.message, "retry_after": self.retry_after }));
        match self.retry_after {
            Some(secs) => (self.status, [("retry-after", secs.to_string())], body).into_response(),
            None => (self.status, body).into_response(),
        }
    }
}

fn client_ip(state: &AppState, peer: SocketAddr, headers: &HeaderMap) -> IpAddr {
    if state.config.trust_proxy {
        // Behind Cloudflare (a tunnel, or an orange-cloud record) CF-Connecting-IP is the one
        // Cloudflare itself sets; the first X-Forwarded-For entry is whatever the client sent.
        if let Some(ip) = ["cf-connecting-ip", "x-forwarded-for"].iter().find_map(|name| {
            headers
                .get(*name)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .and_then(|v| v.trim().parse().ok())
        }) {
            return ip;
        }
    }
    peer.ip()
}

#[derive(Serialize)]
struct Registered {
    install_id: String,
    secret: String,
    zone: String,
}

async fn register(
    State(state): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<Registered>, ApiError> {
    let ip = client_ip(&state, peer, &headers);
    {
        let mut recent = state.registrations.lock().unwrap();
        let hits = recent.entry(ip).or_default();
        hits.retain(|t| t.elapsed() < Duration::from_secs(3600));
        if hits.len() >= 5 {
            return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many registrations, try later"));
        }
        hits.push(Instant::now());
    }

    let install_id = random_id(12);
    let secret = random_id(40);
    state
        .db
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO installs (id, secret_sha256, created_at, created_ip) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![install_id, sha256_hex(&secret), now_secs(), ip.to_string()],
        )
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, format!("database: {e}")))?;
    log::info!("Registered install {install_id}");
    Ok(Json(Registered { install_id, secret, zone: state.config.zone.clone() }))
}

#[derive(Deserialize)]
struct CertificateRequest {
    csr_pem: String,
}

#[derive(Serialize)]
struct Issued {
    certificate_pem: String,
    // Unix seconds - so the app can schedule renewal without carrying an X.509 parser.
    not_before: i64,
    not_after: i64,
}

fn validity(chain_pem: &str) -> Result<(i64, i64)> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(chain_pem.as_bytes()).map_err(|_| anyhow!("issued chain is not PEM"))?;
    let cert = pem.parse_x509().map_err(|_| anyhow!("issued certificate does not parse"))?;
    Ok((cert.validity().not_before.timestamp(), cert.validity().not_after.timestamp()))
}

fn authenticate(state: &AppState, headers: &HeaderMap) -> Result<String, ApiError> {
    let unauthorized = || ApiError::new(StatusCode::UNAUTHORIZED, "unknown install");
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(unauthorized)?;
    let (id, secret) = token.split_once('.').ok_or_else(unauthorized)?;
    if !is_install_id(id) {
        return Err(unauthorized());
    }
    let stored: Option<String> = state
        .db
        .lock()
        .unwrap()
        .query_row("SELECT secret_sha256 FROM installs WHERE id = ?1", [id], |r| r.get(0))
        .ok();
    let given = sha256_hex(secret);
    match stored {
        // Comparing hashes, so timing reveals nothing about the secret itself.
        Some(hash) if hash == given => Ok(id.to_string()),
        _ => Err(unauthorized()),
    }
}

struct Usage {
    // This install's certificates in the window.
    mine: u32,
    // Whether this install has had a certificate before - renewals are exempt from the cap.
    renewal: bool,
    new_installs: u32,
    oldest_new: Option<i64>,
}

fn usage(db: &rusqlite::Connection, install_id: &str, week_ago: i64) -> Usage {
    let mine = db
        .query_row(
            "SELECT COUNT(*) FROM issuances WHERE install_id = ?1 AND at > ?2",
            rusqlite::params![install_id, week_ago],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let renewal = db
        .query_row("SELECT COUNT(*) FROM issuances WHERE install_id = ?1", [install_id], |r| r.get::<_, u32>(0))
        .unwrap_or(0)
        > 0;
    // Installs whose very first certificate falls inside the window - the only issuances
    // that count against Let's Encrypt's per-domain limit.
    let (new_installs, oldest_new) = db
        .query_row(
            "SELECT COUNT(*), MIN(first) FROM (SELECT MIN(at) AS first FROM issuances GROUP BY install_id) WHERE first > ?1",
            [week_ago],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, None));
    Usage { mine, renewal, new_installs, oldest_new }
}

async fn certificate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(body): Json<CertificateRequest>,
) -> Result<Json<Issued>, ApiError> {
    let install_id = authenticate(&state, &headers)?;
    let csr_der = check_csr(&body.csr_pem, &install_id, &state.config.zone)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;

    let _one_at_a_time = state.issuing.lock().await;
    let week_ago = now_secs() - 7 * 86400;
    let Usage { mine, renewal, new_installs, oldest_new } = usage(&state.db.lock().unwrap(), &install_id, week_ago);
    // Let's Encrypt allows 5 certificates per exact name per week, with no overrides; a healthy
    // install renews every couple of months, so several a week means something is looping.
    if mine >= 3 {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "this install already got certificates this week")
            .retry_after(86400));
    }
    if !renewal && new_installs >= state.config.weekly_cap {
        // A slot frees when the oldest first-certificate in the window ages out of it.
        let wait = oldest_new.map(|t| (t + 7 * 86400 - now_secs()).max(600)).unwrap_or(3600) as u64;
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, "certificate capacity reached for now")
            .retry_after(wait));
    }

    let started = Instant::now();
    match issue_certificate(&state, &install_id, &csr_der).await.and_then(|chain| Ok((validity(&chain)?, chain))) {
        Ok(((not_before, not_after), chain)) => {
            let _ = state.db.lock().unwrap().execute(
                "INSERT INTO issuances (install_id, at) VALUES (?1, ?2)",
                rusqlite::params![install_id, now_secs()],
            );
            log::info!("Issued certificate for {install_id} in {:.1}s", started.elapsed().as_secs_f32());
            Ok(Json(Issued { certificate_pem: chain, not_before, not_after }))
        }
        Err(e) => {
            log::warn!("Issuing for {install_id} failed: {e:#}");
            Err(ApiError::new(StatusCode::BAD_GATEWAY, format!("certificate authority: {e:#}")))
        }
    }
}

async fn health() -> &'static str {
    "ok"
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let config = Config::from_env()?;
    let db = open_db(&config.data_dir)?;
    log::info!(
        "Zone {} (NS {}), ACME {}",
        config.zone,
        config.ns_host,
        if config.acme_staging { "staging" } else { "production" }
    );

    let state = Arc::new(AppState {
        config: config.clone(),
        db: Mutex::new(db),
        challenges: Mutex::new(HashMap::new()),
        issuing: tokio::sync::Mutex::new(()),
        account: tokio::sync::OnceCell::new(),
        registrations: Mutex::new(HashMap::new()),
    });

    let api = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/installs", post(register))
        .route("/v1/certificates", post(certificate))
        .with_state(state.clone());
    let listener = TcpListener::bind(config.api_bind).await.with_context(|| format!("binding API on {}", config.api_bind))?;
    log::info!("API listening on {}", config.api_bind);

    tokio::select! {
        r = serve_dns_udp(state.clone()) => r,
        r = serve_dns_tcp(state.clone()) => r,
        r = async {
            axum::serve(listener, api.into_make_service_with_connect_info::<SocketAddr>()).await.map_err(Into::into)
        } => r,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> AppState {
        AppState {
            config: Config {
                zone: "lan.example.com".into(),
                ns_host: "ns-lan.example.com".into(),
                soa_mailbox: "hostmaster.example.com".into(),
                dns_bind: "127.0.0.1:0".parse().unwrap(),
                api_bind: "127.0.0.1:0".parse().unwrap(),
                data_dir: PathBuf::new(),
                acme_staging: true,
                acme_contact: None,
                weekly_cap: 40,
                trust_proxy: false,
            },
            db: Mutex::new(rusqlite::Connection::open_in_memory().unwrap()),
            challenges: Mutex::new(HashMap::new()),
            issuing: tokio::sync::Mutex::new(()),
            account: tokio::sync::OnceCell::new(),
            registrations: Mutex::new(HashMap::new()),
        }
    }

    fn ask(state: &AppState, name: &str, qtype: RecordType) -> Answer {
        answer(state, &Name::from_ascii(name).unwrap(), qtype)
    }

    #[test]
    fn dashed_ips() {
        assert_eq!(parse_dashed_private_ip("192-168-1-5"), Some(Ipv4Addr::new(192, 168, 1, 5)));
        assert_eq!(parse_dashed_private_ip("10-0-0-1"), Some(Ipv4Addr::new(10, 0, 0, 1)));
        assert_eq!(parse_dashed_private_ip("172-16-3-4"), Some(Ipv4Addr::new(172, 16, 3, 4)));
        // Public, malformed, or non-canonical.
        assert_eq!(parse_dashed_private_ip("8-8-8-8"), None);
        assert_eq!(parse_dashed_private_ip("172-32-0-1"), None);
        assert_eq!(parse_dashed_private_ip("192-168-01-5"), None);
        assert_eq!(parse_dashed_private_ip("192-168-1"), None);
        assert_eq!(parse_dashed_private_ip("192-168-1-256"), None);
    }

    #[test]
    fn answers() {
        let state = test_state();
        let id = "k3x9q2m7a1bc";
        match ask(&state, &format!("192-168-1-5.{id}.lan.example.com."), RecordType::A) {
            Answer::Records(r) => assert_eq!(r[0].data(), Some(&RData::A(A(Ipv4Addr::new(192, 168, 1, 5))))),
            _ => panic!("expected an A record"),
        }
        // Case-insensitive, as DNS is.
        assert!(matches!(ask(&state, &format!("192-168-1-5.{}.LAN.Example.com.", id.to_uppercase()), RecordType::A), Answer::Records(_)));
        assert!(matches!(ask(&state, &format!("192-168-1-5.{id}.lan.example.com."), RecordType::AAAA), Answer::NoData));
        assert!(matches!(ask(&state, &format!("8-8-8-8.{id}.lan.example.com."), RecordType::A), Answer::NxDomain));
        assert!(matches!(ask(&state, "192-168-1-5.short.lan.example.com.", RecordType::A), Answer::NxDomain));
        assert!(matches!(ask(&state, "www.example.com.", RecordType::A), Answer::Refused));
        assert!(matches!(ask(&state, "lan.example.com.", RecordType::NS), Answer::Records(_)));
        assert!(matches!(ask(&state, "lan.example.com.", RecordType::SOA), Answer::Records(_)));

        let challenge = format!("_acme-challenge.{id}.lan.example.com");
        assert!(matches!(ask(&state, &format!("{challenge}."), RecordType::TXT), Answer::NoData));
        state.challenges.lock().unwrap().insert(challenge.clone(), vec!["token-value".into()]);
        assert!(matches!(ask(&state, &format!("{challenge}."), RecordType::TXT), Answer::Records(r) if r.len() == 1));
    }

    #[test]
    fn dns_wire_round_trip() {
        let state = test_state();
        let mut query = Message::new();
        query.set_id(7).set_message_type(MessageType::Query).set_op_code(OpCode::Query);
        query.add_query(hickory_proto::op::Query::query(
            Name::from_ascii("10-1-2-3.k3x9q2m7a1bc.lan.example.com.").unwrap(),
            RecordType::A,
        ));
        let reply = Message::from_vec(&handle_dns(&state, &query.to_vec().unwrap()).unwrap()).unwrap();
        assert_eq!(reply.id(), 7);
        assert!(reply.authoritative());
        assert_eq!(reply.answers().len(), 1);
    }

    #[test]
    fn only_first_certificates_count_against_the_cap() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE issuances (install_id TEXT NOT NULL, at INTEGER NOT NULL);").unwrap();
        let now = 1_000_000_000;
        let week_ago = now - 7 * 86400;
        // "old" was first certified long ago and renewed inside the window; "a" and "b" are new.
        for (id, at) in [("old", week_ago - 5000), ("old", now - 10), ("a", now - 3000), ("b", now - 2000), ("b", now - 100)] {
            db.execute("INSERT INTO issuances VALUES (?1, ?2)", rusqlite::params![id, at]).unwrap();
        }
        let u = usage(&db, "old", week_ago);
        assert!(u.renewal);
        assert_eq!(u.mine, 1);
        assert_eq!(u.new_installs, 2);
        assert_eq!(u.oldest_new, Some(now - 3000));
        let fresh = usage(&db, "never-seen", week_ago);
        assert!(!fresh.renewal);
        assert_eq!(fresh.mine, 0);
    }

    #[test]
    fn install_ids() {
        assert!(is_install_id(&random_id(12)));
        assert!(!is_install_id("short"));
        assert!(!is_install_id("UPPERCASE123"));
    }
}
