// commands/stage_render.rs
//
// Frames of a Stage scene (src/utils/stage) on their way into an export. The editor renders each
// frame on the GPU at the export's size and POSTs the raw RGBA to a loopback-only endpoint here
// (frame_server below), falling back to the IPC body: WebView2 hands IPC request bodies over at about
// 7 MB/s - over a second for one 1080p frame, measured - while a fetch to 127.0.0.1 goes through the
// browser's own network stack. Each frame is written as a QOI image (lossless; a fast PNG measured
// ~550 ms a 1080p frame in a dev build) on a worker thread. Only frames that differ from the one
// before are sent at all - a scene mostly at rest costs little. stage_render_finish numbers the
// stored frames in order (u000000.qoi, u000001.qoi...) and says which scene frame each
// one starts at; the export reads them as an image sequence whose timebase is one frame and re-times
// them to exactly those frames (stage_layer_chain, conversion.rs) - every timestamp a whole number of
// frames, nothing rounded, and each unique frame decoded once, held by the overlay until the next.
// (An ffconcat list with per-image durations was measured landing frames one early or late: its
// timestamps are microseconds, which 1/60 s isn't.)
//
// The GPU hands over premultiplied pixels; they're written straight (un-premultiplied, rounded), the
// way QOI and ffmpeg's overlay mean alpha - measured at the 4:2:0 delivery floor once composited, where
// overlay's own alpha=premultiplied was several times off at soft edges (it blends premultiplied RGB
// after converting it to YUV, whose offsets don't scale with alpha). GL reads rows bottom first -
// flipped in the same pass, off the browser's thread.
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

struct Session {
    dir: PathBuf,
    width: u32,
    height: u32,
    fps: f64,
    // Frame numbers stored so far (in any order - frames encode in parallel).
    frames: Vec<u32>,
}

fn sessions() -> &'static Mutex<HashMap<u64, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u64, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageRenderSession {
    id: u64,
    dir: String,
    // Where to POST frames (http://127.0.0.1:{port}/frame/{id}/{index}?t={token}); None = IPC only.
    port: Option<u16>,
    token: Option<String>,
}

// ---- The loopback frame endpoint ---------------------------------------------------------------
// Bound to 127.0.0.1 only, started on the first scene export, and every request must carry this
// run's token (128 random bits from the OS, via RandomState's keys) and name an open session.
struct FrameServer {
    port: u16,
    token: String,
}

fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let part = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(std::process::id() as u64);
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

async fn frame_server() -> Option<&'static FrameServer> {
    static SERVER: tokio::sync::OnceCell<Option<FrameServer>> = tokio::sync::OnceCell::const_new();
    SERVER
        .get_or_init(|| async {
            use axum::{extract::DefaultBodyLimit, routing::post, Router};
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.ok()?;
            let port = listener.local_addr().ok()?.port();
            let token = random_token();
            let expected = token.clone();
            let app = Router::new()
                .route(
                    "/frame/:id/:index",
                    post(move |path: axum::extract::Path<(u64, u32)>, query: axum::extract::Query<FrameQuery>, body: axum::body::Bytes| receive_frame(expected.clone(), path, query, body)).options(|| async { cors(axum::http::StatusCode::NO_CONTENT, String::new()) }),
                )
                .layer(DefaultBodyLimit::max(8192 * 8192 * 4 + 1024));
            tauri::async_runtime::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            Some(FrameServer { port, token })
        })
        .await
        .as_ref()
}

fn cors(status: axum::http::StatusCode, body: String) -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        status,
        [
            ("access-control-allow-origin", "*"),
            ("access-control-allow-methods", "POST, OPTIONS"),
            ("access-control-allow-headers", "content-type"),
            ("access-control-allow-private-network", "true"),
        ],
        body,
    )
        .into_response()
}

#[derive(serde::Deserialize)]
struct FrameQuery {
    t: String,
    // Raw pixels: 1 when rows come bottom first. f=qoi: the body is the finished QOI file.
    #[serde(default)]
    b: u8,
    #[serde(default)]
    f: String,
}

async fn receive_frame(
    token: String,
    axum::extract::Path((id, index)): axum::extract::Path<(u64, u32)>,
    axum::extract::Query(q): axum::extract::Query<FrameQuery>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    use axum::http::StatusCode;
    if q.t != token {
        return cors(StatusCode::FORBIDDEN, "Not this app's frame.".to_string());
    }
    let bottom_up = q.b == 1;
    let encoded = q.f == "qoi";
    match tauri::async_runtime::spawn_blocking(move || if encoded { write_encoded_frame(id, index, &body) } else { write_frame(id, index, &body, bottom_up) }).await {
        Ok(Ok(())) => cors(StatusCode::NO_CONTENT, String::new()),
        Ok(Err(e)) => cors(StatusCode::BAD_REQUEST, e),
        Err(e) => cors(StatusCode::INTERNAL_SERVER_ERROR, format!("Couldn't write a scene frame: {e}")),
    }
}

// A finished render: the stored frames as an image sequence, and the scene frame each one starts at.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StageRenderFrames {
    pub pattern: String,
    pub frames: Vec<u32>,
}

pub(crate) fn open_session(width: u32, height: u32, fps: f64) -> Result<StageRenderSession, String> {
    if width == 0 || height == 0 || width > 8192 || height > 8192 || !(fps.is_finite() && fps > 0.0 && fps <= 240.0) {
        return Err("That frame size or rate can't be rendered.".to_string());
    }
    let id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("briefcast_stage_{}_{}", std::process::id(), id));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't make a folder for the scene's frames: {e}"))?;
    let dir_str = dir.to_string_lossy().to_string();
    sessions().lock().map_err(|_| "Scene render state is unavailable.".to_string())?.insert(id, Session { dir, width, height, fps, frames: Vec::new() });
    Ok(StageRenderSession { id, dir: dir_str, port: None, token: None })
}

fn frame_path(dir: &std::path::Path, index: u32) -> PathBuf {
    dir.join(format!("f{index:06}.qoi"))
}

// Writes frame `index` already encoded as QOI by the editor (stageQoi.ts) - checked to be a QOI file
// of the session's size, then stored as it is.
pub(crate) fn write_encoded_frame(id: u64, index: u32, qoi: &[u8]) -> Result<(), String> {
    let (dir, width, height) = {
        let map = sessions().lock().map_err(|_| "Scene render state is unavailable.".to_string())?;
        let s = map.get(&id).ok_or("That scene render has already finished.")?;
        (s.dir.clone(), s.width, s.height)
    };
    let dims = |at: usize| qoi.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    if qoi.len() < 22 || &qoi[..4] != b"qoif" || dims(4) != Some(width) || dims(8) != Some(height) || qoi[qoi.len() - 8..] != [0, 0, 0, 0, 0, 0, 0, 1] {
        return Err(format!("A scene frame arrived that isn't a {width}x{height} QOI image."));
    }
    std::fs::write(frame_path(&dir, index), qoi).map_err(|e| format!("Couldn't write a scene frame: {e}"))?;
    sessions().lock().map_err(|_| "Scene render state is unavailable.".to_string())?.get_mut(&id).ok_or("That scene render has already finished.")?.frames.push(index);
    Ok(())
}

// Writes frame `index` from `rgba` (width*height*4 bytes; rows bottom first when `bottom_up`).
pub(crate) fn write_frame(id: u64, index: u32, rgba: &[u8], bottom_up: bool) -> Result<(), String> {
    let (dir, width, height) = {
        let map = sessions().lock().map_err(|_| "Scene render state is unavailable.".to_string())?;
        let s = map.get(&id).ok_or("That scene render has already finished.")?;
        (s.dir.clone(), s.width, s.height)
    };
    let row = width as usize * 4;
    if rgba.len() != row * height as usize {
        return Err(format!("A scene frame arrived the wrong size ({} bytes for {width}x{height}).", rgba.len()));
    }
    // Straight alpha, top row first, as QOI - one pass in the optimised pixel crate. (A fast PNG
    // measured ~550 ms a 1080p frame in a dev build; this is a few milliseconds.)
    let mut qoi = Vec::new();
    pixel_convert::qoi_from_premultiplied(rgba, width as usize, height as usize, bottom_up, &mut qoi);
    std::fs::write(frame_path(&dir, index), &qoi).map_err(|e| format!("Couldn't write a scene frame: {e}"))?;
    sessions().lock().map_err(|_| "Scene render state is unavailable.".to_string())?.get_mut(&id).ok_or("That scene render has already finished.")?.frames.push(index);
    Ok(())
}

// The session's stored frames renumbered in order (frames arrive in any order, several encoding at
// once) as u000000.qoi, u000001.qoi..., and the scene frame each starts at. `total` frames in all:
// none may start past the end.
pub(crate) fn finish_session(id: u64, total: u32) -> Result<StageRenderFrames, String> {
    let s = sessions().lock().map_err(|_| "Scene render state is unavailable.".to_string())?.remove(&id).ok_or("That scene render has already finished.")?;
    let mut frames = s.frames.clone();
    frames.sort_unstable();
    frames.dedup();
    if frames.first() != Some(&0) {
        return Err("The scene's first frame never arrived.".to_string());
    }
    if frames.last().is_some_and(|&f| f >= total.max(1)) {
        return Err("A scene frame arrived past the scene's end.".to_string());
    }
    for (n, &f) in frames.iter().enumerate() {
        std::fs::rename(frame_path(&s.dir, f), s.dir.join(format!("u{n:06}.qoi"))).map_err(|e| format!("Couldn't order the scene's frames: {e}"))?;
    }
    Ok(StageRenderFrames { pattern: s.dir.join("u%06d.qoi").to_string_lossy().to_string(), frames })
}

pub(crate) fn discard_session(id: u64) {
    if let Some(s) = sessions().lock().ok().and_then(|mut m| m.remove(&id)) {
        let _ = std::fs::remove_dir_all(&s.dir);
    }
}

#[tauri::command]
pub async fn stage_render_open(width: u32, height: u32, fps: f64) -> Result<StageRenderSession, String> {
    let mut session = open_session(width, height, fps)?;
    if let Some(server) = frame_server().await {
        session.port = Some(server.port);
        session.token = Some(server.token.clone());
    }
    Ok(session)
}

// One frame - the raw RGBA request body; session id, frame number and row order in headers.
#[tauri::command]
pub async fn stage_render_frame(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.clone(),
        tauri::ipc::InvokeBody::Json(_) => return Err("A scene frame arrived as JSON rather than raw bytes.".to_string()),
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(|v| v.to_string());
    let id: u64 = header("x-stage-id").and_then(|v| v.parse().ok()).ok_or("Which scene render this frame is for wasn't said.")?;
    let index: u32 = header("x-frame-index").and_then(|v| v.parse().ok()).ok_or("Which frame this is wasn't said.")?;
    let bottom_up = header("x-bottom-up").as_deref() == Some("1");
    let encoded = header("x-format").as_deref() == Some("qoi");
    tauri::async_runtime::spawn_blocking(move || if encoded { write_encoded_frame(id, index, &bytes) } else { write_frame(id, index, &bytes, bottom_up) })
        .await
        .map_err(|e| format!("Couldn't write a scene frame: {e}"))?
}

#[tauri::command]
pub async fn stage_render_finish(id: u64, total_frames: u32) -> Result<StageRenderFrames, String> {
    tauri::async_runtime::spawn_blocking(move || finish_session(id, total_frames))
        .await
        .map_err(|e| format!("Couldn't finish the scene's frames: {e}"))?
}

#[tauri::command]
pub async fn stage_render_discard(id: u64) -> Result<(), String> {
    discard_session(id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    // A test frame: a gradient with soft premultiplied alpha, and a marker telling frames apart.
    fn frame(w: u32, h: u32, marker: u8) -> Vec<u8> {
        let mut v = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let i = ((y * w + x) * 4) as usize;
                let a = ((x * 255) / w.max(1)) as u8;
                v[i] = ((y * 255 / h.max(1)) as u32 * a as u32 / 255) as u8;
                v[i + 1] = (marker as u32 * a as u32 / 255) as u8;
                v[i + 2] = (128u32 * a as u32 / 255) as u8;
                v[i + 3] = a;
            }
        }
        v
    }

    // Where a frame's write time goes (cargo test write_cost -- --ignored --nocapture).
    #[test]
    #[ignore]
    fn write_cost() {
        let (w, h) = (1920usize, 1080usize);
        let mut src = vec![0u8; w * h * 4];
        for (i, px) in src.chunks_exact_mut(4).enumerate() {
            let (x, y) = (i % w, i / w);
            let on = (x / 40 + y / 40) % 7 == 0;
            px.copy_from_slice(if on { &[17, 17, 17, 255] } else { &[232, 232, 230, 255] });
        }
        let mut out = vec![0u8; src.len()];
        let t = std::time::Instant::now();
        pixel_convert::unpremultiply_flip(&src, w, h, true, &mut out);
        let unpre = t.elapsed();
        let t = std::time::Instant::now();
        let mut qoi = Vec::new();
        pixel_convert::qoi_from_premultiplied(&src, w, h, true, &mut qoi);
        let enc = t.elapsed();
        eprintln!("unpremultiply {unpre:?} qoi (fused) {enc:?} ({} KB)", qoi.len() / 1024);
    }

    #[test]
    fn takes_an_encoded_frame_of_the_right_size_and_refuses_anything_else() {
        let s = open_session(4, 2, 30.0).unwrap();
        let mut q = Vec::new();
        pixel_convert::qoi_from_premultiplied(&frame(4, 2, 1), 4, 2, false, &mut q);
        write_encoded_frame(s.id, 0, &q).unwrap();
        let mut wrong = Vec::new();
        pixel_convert::qoi_from_premultiplied(&frame(2, 4, 1), 2, 4, false, &mut wrong);
        assert!(write_encoded_frame(s.id, 1, &wrong).is_err());
        assert!(write_encoded_frame(s.id, 1, b"not an image at all, honestly").is_err());
        assert_eq!(finish_session(s.id, 1).unwrap().frames, vec![0]);
        let _ = std::fs::remove_dir_all(s.dir);
    }

    #[test]
    fn unpremultiplies_to_the_nearest_straight_value() {
        let mut out = [0u8; 16];
        pixel_convert::unpremultiply_flip(&[64, 32, 16, 128, 10, 20, 30, 255, 9, 9, 9, 0, 1, 0, 0, 2], 4, 1, false, &mut out);
        assert_eq!(out, [128, 64, 32, 128, 10, 20, 30, 255, 0, 0, 0, 0, 128, 0, 0, 2]);
    }

    #[test]
    fn finishing_numbers_the_stored_frames_in_scene_order() {
        let s = open_session(4, 2, 30.0).unwrap();
        // Out of order, as parallel encodes finish.
        for i in [4u32, 0, 3] {
            write_frame(s.id, i, &frame(4, 2, i as u8), false).unwrap();
        }
        let done = finish_session(s.id, 10).unwrap();
        assert_eq!(done.frames, vec![0, 3, 4]);
        let dir = PathBuf::from(&s.dir);
        assert!(dir.join("u000000.qoi").exists() && dir.join("u000002.qoi").exists() && !dir.join("f000003.qoi").exists());
        let _ = std::fs::remove_dir_all(s.dir);
    }

    #[test]
    fn refuses_a_wrong_sized_frame_and_a_missing_first_frame() {
        let s = open_session(4, 2, 30.0).unwrap();
        assert!(write_frame(s.id, 0, &[0u8; 12], false).is_err());
        write_frame(s.id, 2, &frame(4, 2, 1), false).unwrap();
        assert!(finish_session(s.id, 5).is_err());
        let late = open_session(4, 2, 30.0).unwrap();
        write_frame(late.id, 0, &frame(4, 2, 1), false).unwrap();
        write_frame(late.id, 7, &frame(4, 2, 1), false).unwrap();
        assert!(finish_session(late.id, 5).is_err());
        let _ = std::fs::remove_dir_all(late.dir);
        assert!(open_session(0, 2, 30.0).is_err());
        assert!(open_session(4, 2, f64::NAN).is_err());
        let _ = std::fs::remove_dir_all(s.dir);
    }

    fn flip(f: &[u8], w: u32, h: u32) -> Vec<u8> {
        let row = (w * 4) as usize;
        let mut out = vec![0u8; f.len()];
        for y in 0..h as usize {
            out[y * row..(y + 1) * row].copy_from_slice(&f[(h as usize - 1 - y) * row..(h as usize - y) * row]);
        }
        out
    }

    fn straight(f: &[u8]) -> Vec<u8> {
        let mut out = vec![0u8; f.len()];
        pixel_convert::unpremultiply_flip(f, f.len() / 4, 1, false, &mut out);
        out
    }

    // Every stored frame decodes back byte for byte - straight alpha, bottom-up rows flipped.
    #[test]
    #[ignore]
    fn stored_frames_decode_exactly() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        let (w, h) = (64u32, 36u32);
        let s = open_session(w, h, 30.0).unwrap();
        write_frame(s.id, 0, &frame(w, h, 10), false).unwrap();
        write_frame(s.id, 5, &flip(&frame(w, h, 50), w, h), true).unwrap();
        let done = finish_session(s.id, 9).unwrap();
        let out = Command::new(&ffmpeg).args(["-v", "error", "-framerate", "30", "-start_number", "0", "-i", &done.pattern, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let frames: Vec<&[u8]> = out.stdout.chunks_exact((w * h * 4) as usize).collect();
        assert!(frames.len() >= 2);
        assert_eq!(frames[0], straight(&frame(w, h, 10)).as_slice());
        assert_eq!(frames[1], straight(&frame(w, h, 50)).as_slice());
        let _ = std::fs::remove_dir_all(s.dir);
    }

    // Composited the way the export does it (stage_layer_chain over a stream at the scene's rate),
    // each output frame shows the scene frame it should - none early, none late.
    #[test]
    #[ignore]
    fn frames_land_on_their_output_frames() {
        let Ok(dir) = std::env::var("FFMPEG_DIR") else { return };
        let ffmpeg = PathBuf::from(&dir).join(if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" });
        for fps in [30.0, 60.0, 30000.0 / 1001.0, 24.0, 50.0] {
            let (w, h) = (32u32, 18u32);
            // Opaque frames, so the composite is the frame itself; the marker is the green channel.
            let opaque = |m: u8| (0..w * h).flat_map(|_| [0u8, m, 0, 255]).collect::<Vec<u8>>();
            let s = open_session(w, h, fps).unwrap();
            let changes = [(0u32, 10u8), (5, 50), (6, 60), (40, 140)];
            for (i, m) in changes {
                write_frame(s.id, i, &opaque(m), false).unwrap();
            }
            let total = 45u32;
            let done = finish_session(s.id, total).unwrap();
            let layer = crate::commands::conversion::StageLayerSpec { pattern: done.pattern.clone(), frames: done.frames.clone(), start_time: 1.0, end_time: 1.0 + total as f64 / fps, fps };
            // The scene starts at 1.0s on a black stream at the same rate - frame k of the scene is
            // output frame round(1.0*fps)+k.
            let graph = format!(
                "color=c=black:s={w}x{h}:r={fps}:d={d:.4},format=yuv444p[b];{}",
                crate::commands::conversion::stage_layer_chain_for_test(&layer, 0, "b", "stg", "o"),
                d = 1.0 + total as f64 / fps + 0.5
            );
            let rate = format!("{fps}");
            let out = Command::new(&ffmpeg)
                .args(["-v", "error", "-framerate", &rate, "-start_number", "0", "-i", &done.pattern, "-filter_complex", graph.trim_end_matches(';'), "-map", "[o]", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
                .output()
                .unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
            let frames: Vec<&[u8]> = out.stdout.chunks_exact((w * h * 3) as usize).collect();
            let first = (1.0 * fps as f64).round() as usize;
            for k in 0..total as usize {
                let want = changes.iter().rev().find(|(i, _)| *i as usize <= k).unwrap().1;
                let got = frames[first + k][1];
                // Through a YUV base the marker comes back within a few levels (50 -> 48, 60 -> 57);
                // neighbouring markers are 10+ apart, so this tells frames apart unambiguously.
                assert!((got as i32 - want as i32).abs() <= 4, "fps {fps}: scene frame {k} showed marker {got}, wanted {want}");
            }
            // Before the scene, nothing of it.
            assert!(frames[first - 1][1] < 2, "fps {fps}: the scene showed a frame early");
            let _ = std::fs::remove_dir_all(s.dir);
        }
    }
}
