// services/wayland_portal.rs
//
// Linux Wayland screen capture via the XDG Desktop Portal (`org.freedesktop.portal.ScreenCast`)
// and PipeWire (`gst-launch-1.0 pipewiresrc ! videoconvert ! y4menc ! filesink`).
//
// Feeding a YUV4MPEG2 (`.y4m`) stream over a named FIFO into ffmpeg (`-f yuv4mpegpipe -i <fifo>`)
// preserves Briefcast's entire recording pipeline on Wayland (camera overlays, separate webcam
// sidecar, PulseAudio/PipeWire-Pulse mic + system audio mixing, VA-API/NVENC/x264 encoding,
// `-progress` diagnostics, pause/resume, and clean `q` shutdown) without needing a custom
// PipeWire-patched ffmpeg build.

#[allow(dead_code)]
pub fn is_wayland_session() -> bool {
    std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|v| v.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false)
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};

    use futures_util::StreamExt;
    use zbus::zvariant::{ObjectPath, OwnedFd, OwnedObjectPath, OwnedValue, Value};
    use zbus::{Connection, Proxy};

    static COUNTER: AtomicU64 = AtomicU64::new(1);

    pub enum PortalError {
        /// User explicitly dismissed or cancelled the native Wayland screen picker.
        Cancelled,
        /// Portal service or GStreamer PipeWire pipeline is unavailable on this machine.
        Unavailable(String),
    }

    pub struct WaylandPipeWireSession {
        fifo_path: PathBuf,
        gst_child: Child,
        /// Keeps the D-Bus connection alive so the portal keeps the PipeWire stream open.
        _conn: Connection,
        session_handle: String,
    }

    impl WaylandPipeWireSession {
        pub fn fifo_path(&self) -> &Path {
            &self.fifo_path
        }

        pub fn pid(&self) -> u32 {
            self.gst_child.id()
        }
    }

    impl Drop for WaylandPipeWireSession {
        fn drop(&mut self) {
            let _ = self.gst_child.kill();
            let _ = self.gst_child.wait();
            let _ = std::fs::remove_file(&self.fifo_path);
            let _ = &self.session_handle;
        }
    }

    fn next_token(prefix: &str) -> String {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        format!("briefcast_{}_{}_{}", prefix, std::process::id(), n)
    }

    fn request_object_path(conn: &Connection, token: &str) -> Result<String, PortalError> {
        let unique = conn
            .unique_name()
            .ok_or_else(|| PortalError::Unavailable("D-Bus connection has no unique name".into()))?;
        let sender = unique.as_str().trim_start_matches(':').replace('.', "_");
        Ok(format!(
            "/org/freedesktop/portal/desktop/request/{sender}/{token}"
        ))
    }

    async fn wait_portal_response(
        conn: &Connection,
        request_path: &str,
        call: impl std::future::Future<Output = Result<OwnedObjectPath, zbus::Error>>,
    ) -> Result<HashMap<String, OwnedValue>, PortalError> {
        let req_proxy = Proxy::new(
            conn,
            "org.freedesktop.portal.Desktop",
            request_path,
            "org.freedesktop.portal.Request",
        )
        .await
        .map_err(|e| PortalError::Unavailable(format!("Portal Request proxy failed: {e}")))?;

        let mut stream = req_proxy
            .receive_signal("Response")
            .await
            .map_err(|e| PortalError::Unavailable(format!("Portal Response signal failed: {e}")))?;

        call.await
            .map_err(|e| PortalError::Unavailable(format!("Portal call failed: {e}")))?;

        let msg = stream
            .next()
            .await
            .ok_or_else(|| PortalError::Unavailable("Portal Response stream closed".into()))?;

        let (code, results): (u32, HashMap<String, OwnedValue>) = msg
            .body()
            .deserialize()
            .map_err(|e| PortalError::Unavailable(format!("Invalid portal response body: {e}")))?;

        match code {
            0 => Ok(results),
            1 => Err(PortalError::Cancelled),
            other => Err(PortalError::Unavailable(format!(
                "ScreenCast portal returned error code {other}"
            ))),
        }
    }

    fn extract_stream_node_id(results: &HashMap<String, OwnedValue>) -> Option<u32> {
        // Portal returns `streams` as `a(ua{sv})`.
        let val = results.get("streams")?;
        let streams: Vec<(u32, HashMap<String, OwnedValue>)> =
            val.try_clone().ok()?.try_into().ok()?;
        streams.first().map(|(node_id, _)| *node_id)
    }

    fn create_fifo() -> Result<PathBuf, PortalError> {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("briefcast-pw-{}-{n}.y4m", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let c_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|e| PortalError::Unavailable(format!("Invalid FIFO path: {e}")))?;
        let rc = unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) };
        if rc != 0 {
            return Err(PortalError::Unavailable(format!(
                "Failed to create PipeWire FIFO: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(path)
    }

    /// Negotiates a PipeWire ScreenCast session via XDG Desktop Portal and starts GStreamer writing
    /// a YUV4MPEG2 stream into a local FIFO for ffmpeg to consume.
    pub async fn start_screencast(
        prefer_window: bool,
        capture_cursor: bool,
        fps: i32,
    ) -> Result<WaylandPipeWireSession, PortalError> {
        // Verify gst-launch-1.0 is available before showing the user the portal picker dialog.
        let gst_ok = Command::new("gst-launch-1.0")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !gst_ok {
            return Err(PortalError::Unavailable(
                "Wayland screen capture requires GStreamer (`gst-launch-1.0` + `gstreamer1.0-pipewire`)."
                    .into(),
            ));
        }

        let conn = Connection::session()
            .await
            .map_err(|e| PortalError::Unavailable(format!("Failed to connect to session D-Bus: {e}")))?;

        let portal = Proxy::new(
            &conn,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.ScreenCast",
        )
        .await
        .map_err(|e| PortalError::Unavailable(format!("ScreenCast portal unavailable: {e}")))?;

        // 1. CreateSession
        let req_token = next_token("create");
        let session_token = next_token("session");
        let req_path = request_object_path(&conn, &req_token)?;
        let mut create_opts: HashMap<&str, Value<'_>> = HashMap::new();
        create_opts.insert("handle_token", Value::from(req_token.as_str()));
        create_opts.insert("session_handle_token", Value::from(session_token.as_str()));

        let create_res = wait_portal_response(&conn, &req_path, async {
            portal.call("CreateSession", &(create_opts,)).await
        })
        .await?;

        let session_handle: String = create_res
            .get("session_handle")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| String::try_from(v).ok())
            .ok_or_else(|| {
                PortalError::Unavailable("ScreenCast CreateSession returned no session_handle".into())
            })?;

        let session_obj = ObjectPath::try_from(session_handle.as_str())
            .map_err(|e| PortalError::Unavailable(format!("Invalid session_handle: {e}")))?;

        // 2. SelectSources (types: 1 = Monitor, 2 = Window; cursor_mode: 1 = Hidden, 2 = Embedded)
        let req_token = next_token("select");
        let req_path = request_object_path(&conn, &req_token)?;
        let mut select_opts: HashMap<&str, Value<'_>> = HashMap::new();
        select_opts.insert("handle_token", Value::from(req_token.as_str()));
        let types: u32 = if prefer_window { 2 } else { 1 | 2 };
        select_opts.insert("types", Value::from(types));
        select_opts.insert("multiple", Value::from(false));
        let cursor_mode: u32 = if capture_cursor { 2 } else { 1 };
        select_opts.insert("cursor_mode", Value::from(cursor_mode));

        let _ = wait_portal_response(&conn, &req_path, async {
            portal.call("SelectSources", &(&session_obj, select_opts)).await
        })
        .await?;

        // 3. Start (triggers native Wayland screen/window picker)
        let req_token = next_token("start");
        let req_path = request_object_path(&conn, &req_token)?;
        let mut start_opts: HashMap<&str, Value<'_>> = HashMap::new();
        start_opts.insert("handle_token", Value::from(req_token.as_str()));

        let start_res = wait_portal_response(&conn, &req_path, async {
            portal.call("Start", &(&session_obj, "", start_opts)).await
        })
        .await?;

        let node_id = extract_stream_node_id(&start_res).ok_or_else(|| {
            PortalError::Unavailable("ScreenCast Start returned no PipeWire stream node".into())
        })?;

        // 4. OpenPipeWireRemote -> receive PipeWire Unix fd over SCM_RIGHTS
        let empty_opts: HashMap<&str, Value<'_>> = HashMap::new();
        let pw_fd: OwnedFd = portal
            .call("OpenPipeWireRemote", &(&session_obj, empty_opts))
            .await
            .map_err(|e| PortalError::Unavailable(format!("OpenPipeWireRemote failed: {e}")))?;

        // Duplicate without FD_CLOEXEC so `gst-launch-1.0` inherits the PipeWire remote fd.
        let inherited_fd = unsafe { libc::dup(pw_fd.as_raw_fd()) };
        if inherited_fd < 0 {
            return Err(PortalError::Unavailable(format!(
                "dup(PipeWire fd) failed: {}",
                std::io::Error::last_os_error()
            )));
        }

        let fifo_path = match create_fifo() {
            Ok(p) => p,
            Err(e) => {
                unsafe { libc::close(inherited_fd) };
                return Err(e);
            }
        };

        let fps = fps.clamp(1, 60);
        let mut cmd = Command::new("gst-launch-1.0");
        cmd.args([
            "-q",
            "pipewiresrc",
            &format!("fd={inherited_fd}"),
            &format!("path={node_id}"),
            "do-timestamp=true",
            "!",
            "videoconvert",
            "!",
            &format!("video/x-raw,format=I420,framerate={fps}/1"),
            "!",
            "y4menc",
            "!",
            "filesink",
            &format!("location={}", fifo_path.to_string_lossy()),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        crate::services::orphan_guard::before_spawn(&mut cmd);

        let child_res = cmd.spawn();
        // Close our copy of the dup'd fd in the parent regardless of spawn result.
        unsafe { libc::close(inherited_fd) };

        let gst_child = match child_res {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&fifo_path);
                return Err(PortalError::Unavailable(format!(
                    "Failed to spawn gst-launch-1.0 PipeWire bridge: {e}"
                )));
            }
        };

        Ok(WaylandPipeWireSession {
            fifo_path,
            gst_child,
            _conn: conn,
            session_handle,
        })
    }
}

#[cfg(target_os = "linux")]
pub use linux::*;
