// FFmpeg codec selection, camera-overlay filter graphs, stderr error parsing, and subprocess helpers.
use super::*;

// ffmpeg's stderr always leads with its multi-hundred-character build banner (version, compile
// flags, bundled library list) before it ever gets to the actual failure, so dumping the whole
// thing as the error - as every take_screenshot used to - buries the one line anyone can act on
// under noise the UI can't even fully display. The real reason is reliably among the last few
// non-empty lines.
// The lines of a failed run's stderr that say what went wrong. Just taking the last few lines isn't
// enough: a run that fails late ends with the encoders' closing statistics ("[libx264 @ ...] ref B
// L0: ...", "kb/s:", "Qavg: ...") and the actual error is further up - so the message used to read
// as a wall of numbers ending in "Conversion failed!". Lines that report a problem are picked out
// instead (the last few, oldest first); the plain tail is only the fallback when none do.
pub(crate) fn extract_ffmpeg_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .flat_map(|l| l.split('\r'))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return "ffmpeg exited with an error and produced no output".to_string();
    }
    const PROBLEM: &[&str] = &[
        "error", "invalid", "failed", "no such", "not found", "cannot", "can't", "unable", "too many",
        "out of memory", "does not", "doesn't", "unsupported", "not supported", "mismatch", "denied",
        "corrupt", "unknown", "impossible", "could not", "couldn't",
    ];
    let problems: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|l| {
            let lower = l.to_ascii_lowercase();
            // ffmpeg's own sign-off says nothing the lines before it don't.
            !lower.starts_with("conversion failed") && PROBLEM.iter().any(|p| lower.contains(p))
        })
        .collect();
    if !problems.is_empty() {
        let mut unique: Vec<&str> = Vec::new();
        for l in problems.iter().rev() {
            if !unique.contains(l) {
                unique.push(l);
            }
            if unique.len() == 4 {
                break;
            }
        }
        unique.reverse();
        return unique.join(" | ");
    }
    let tail_len = lines.len().min(5);
    lines[lines.len() - tail_len..].join(" | ")
}

// Shared by every platform backend (win/macos/linux) - the swap is pure argument-vector
// surgery with nothing OS-specific in it, and hw_encoder handles which encoders are even worth
// probing per platform.
//
// Swaps codec_args_for_ext's software video-encode segment (`-c:v libx264 -preset ultrafast
// [-crf N]`) for a detected hardware encoder's own, when one actually works on this machine (see
// services/hw_encoder.rs) - CPU usage on a long/high-res recording is the single biggest
// encoding-side complaint this app's software-only libx264 path has (see
// RECORDING_UPGRADE_NOTES.md). Only for the h264-targeting containers that path already covers
// (mp4/mkv/avi/mov); webm's target codec is VP8, which has no equivalent widely-available
// hardware path, so it's left on software regardless. Finds the software segment by locating
// "-pix_fmt" (which immediately follows it in every one of those four branches) rather than
// hardcoding each branch's exact offset, so this stays correct if codec_args_for_ext's own args
// ever get reordered.
pub(crate) fn codec_args_for_ext_hw(ext: &str, ffmpeg_path: &std::path::Path) -> Vec<String> {
    let Some(encoder) = crate::services::hw_encoder::detect(ffmpeg_path) else {
        return codec_args_for_ext(ext);
    };
    let mut video = vec!["-c:v".to_string(), encoder.name().to_string()];
    video.extend(encoder.quality_args());
    codec_args_with_video_encoder(ext, &video, encoder.keep_pix_fmt())
        .unwrap_or_else(|| codec_args_for_ext(ext))
}

// codec_args_for_ext's container/audio args with its software video-encoder segment (`-c:v ...`
// up to `-pix_fmt`) replaced by `video` - None for a container that segment doesn't exist in
// (webm, whose VP8 has no hardware path). `keep_pix_fmt` is false for encoders fed GPU-resident
// frames: -pix_fmt names a system-memory format, and asking for one would make ffmpeg try to
// convert frames it can't reach.
pub(crate) fn codec_args_with_video_encoder(
    ext: &str,
    video: &[String],
    keep_pix_fmt: bool,
) -> Option<Vec<String>> {
    if !matches!(ext.to_lowercase().as_str(), "mp4" | "mkv" | "avi" | "mov") {
        return None;
    }
    let args = codec_args_for_ext(ext);
    let cv_idx = args.iter().position(|a| a == "-c:v")?;
    let pix_fmt_idx = args.iter().position(|a| a == "-pix_fmt")?;
    if pix_fmt_idx <= cv_idx {
        return None;
    }

    let mut patched = args[..cv_idx].to_vec();
    patched.extend(video.iter().cloned());
    let rest = if keep_pix_fmt { pix_fmt_idx } else { pix_fmt_idx + 2 };
    patched.extend(args[rest..].iter().cloned());
    Some(patched)
}

// Caps the encoded/composited frame width for every desktop-capture recording mode - screen
// capture otherwise grabs at the monitor's exact native pixel resolution (see win.rs's
// desktop_crop_args) with no downscale at all, so a 4K/5K display produces files whose frames a
// software (or marginal-hardware) <video> decode path can struggle to keep up with in real time,
// which is what actually caused "playback lags/skips" - not a bug the browser reports as an
// error, so the existing get_playable_preview recovery path (conversion.rs) never even sees it.
// 1920 (1080p) is the safe, universally hardware-decodable ceiling every WebView2/Chromium build
// handles smoothly, and is still sharp for typical screencast content even downscaled from 4K.
// Only ever downscales (ffmpeg's scale filter leaves a source already <= this width untouched).
pub(crate) const MAX_RECORDING_WIDTH: i32 = 1920;

// Floor for FormData.resolution_width - below this a "downscale" would start looking more like a
// thumbnail than a screen recording, regardless of what a caller sends. No explicit ceiling: a
// user-requested "native" capture intentionally sends something far above any real display's own
// width (see FormData.resolution_width's own doc comment) - clamping that down would silently
// defeat the one thing that option is for.
pub(super) const MIN_RESOLUTION_WIDTH: i32 = 640;

// Resolves FormData.resolution_width to a real scale-filter target, clamping a too-small explicit
// request rather than trusting it outright, and falling back to the previous hardcoded
// MAX_RECORDING_WIDTH when the caller didn't ask for anything in particular (every pre-existing
// caller, and every macOS/Linux one - see codec_args_for_ext_hw's own doc comment on why hardware-
// specific changes in this session stay Windows-only).
pub(crate) fn resolved_max_width(form_data: &FormData) -> i32 {
    form_data
        .resolution_width
        .map(|w| w.max(MIN_RESOLUTION_WIDTH))
        .unwrap_or(MAX_RECORDING_WIDTH)
}

// Capture framerate on the macOS and Linux backends: the user's setting, clamped to 1-60 like the
// Windows one, else the mode's own default.
#[allow(dead_code)] // the Windows backend resolves its framerate inside ScreenSource instead
pub(crate) fn resolved_framerate(form_data: &FormData, default_fps: i32) -> i32 {
    form_data.framerate.unwrap_or(default_fps).clamp(1, 60)
}

// `-vf` value that scales a screen capture down to the resolved max width, keeping its aspect
// ratio and never enlarging. Width is forced even (and height follows with -2): H.264 in yuv420p
// cannot encode an odd dimension, and a desktop or window can be any size.
#[allow(dead_code)] // the Windows backend scales inside its own filter graph
pub(crate) fn desktop_scale_filter(form_data: &FormData) -> String {
    format!("scale='trunc(min({},iw)/2)*2':-2", resolved_max_width(form_data))
}

// libx264 defaults to a ~250-frame GOP when -g is unset, which at these recording framerates
// (30-60fps) is 4-8+ seconds between keyframes - fine for straight-through decode, but expensive
// to seek/scrub through (every seek has to decode forward from the nearest preceding keyframe).
// 60 keeps that to at most 2s (30fps) or 1s (60fps) without meaningfully hurting compression.
pub(super) const KEYFRAME_INTERVAL: &str = "60";

// The resolution a camera is captured at (dshow/avfoundation/v4l2 `-video_size`). Every named
// bubble size captures at 640x480 - a mode practically every webcam supports - and the bubble is
// scaled from that: the old "small" captured at 320x240, which looked soft even small, and asking
// a camera for a size it doesn't offer fails the whole recording. A literal "WxH" passes through.
pub fn map_overlay_size(size: &str) -> String {
    match size {
        "xs" | "small" | "medium" | "large" | "xl" => "640x480".to_string(),
        _ => size.to_string(),
    }
}

// The ffmpeg input that opens one camera by the name the device list gave it (dshow on Windows, v4l2 on
// Linux, avfoundation on a Mac) - for the live camera effects, which read the camera themselves.
pub(crate) fn camera_input_args(app_handle: &AppHandle, device: &str, size: &str) -> Result<Vec<String>, String> {
    let size = map_overlay_size(size);
    #[cfg(target_os = "windows")]
    {
        let _ = app_handle;
        Ok(vec!["-f".to_string(), "dshow".to_string(), "-video_size".to_string(), size, "-i".to_string(), format!("video={device}")])
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app_handle;
        linux::camera_input_args(device, &size)
    }
    #[cfg(target_os = "macos")]
    {
        macos::camera_input_args(app_handle, device, &size)
    }
}

// How a camera bubble looks, as chosen in the Screen Options modal. Sizes, margins and border
// thickness are all fractions of the recorded frame's width, so a bubble looks the same at 1080p
// and at 4K - and so the modal's preview (CameraOverlayPreview.tsx, which mirrors every number
// here) can draw it exactly.
pub(crate) struct OverlayStyle<'a> {
    pub shape: &'a str,
    pub position: &'a str,
    pub size: &'a str,
    // "none" | "thin" | "medium" | "thick".
    pub border: &'a str,
    // "#rrggbb".
    pub border_color: &'a str,
}

pub(super) fn even(v: f64) -> i32 {
    ((v.round() as i32) / 2 * 2).max(2)
}

// Bubble width as a share of the frame's.
pub(super) fn bubble_fraction(size: &str) -> f64 {
    match size {
        "xs" => 0.10,
        "medium" => 0.18,
        "large" => 0.24,
        "xl" => 0.30,
        _ => 0.14, // "small" and anything unrecognised
    }
}

// The camera picture inside one bubble (border excluded): square for circle/rounded, 4:3 for the
// plain rectangle.
pub(super) fn overlay_pixel_dimensions(shape: &str, size: &str, frame_width: i32) -> (i32, i32) {
    let side = even(frame_width as f64 * bubble_fraction(size));
    match shape {
        "circle" | "rounded" => (side, side),
        _ => (side, even(side as f64 * 3.0 / 4.0)),
    }
}

pub(super) fn border_px(border: &str, frame_width: i32) -> i32 {
    let w = frame_width as f64;
    match border {
        "thin" => even((w * 0.003).max(2.0)),
        "medium" => even((w * 0.006).max(4.0)),
        "thick" => even((w * 0.011).max(6.0)),
        _ => 0,
    }
}

// "#rrggbb" for ffmpeg's color source; anything malformed falls back to white.
pub(super) fn ffmpeg_color(hex: &str) -> String {
    let h = hex.trim().trim_start_matches('#');
    if h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()) {
        format!("0x{}", h)
    } else {
        "white".to_string()
    }
}

// geq: 255 inside a rounded rectangle inset `o` px into the frame with corner radius `r`, else 0.
pub(super) fn rounded_mask(o: i32, r: i32) -> String {
    format!(
        "if(lte(pow(max(max({o}+{r}-X,X-(W-1-{o}-{r})),0),2)+pow(max(max({o}+{r}-Y,Y-(H-1-{o}-{r})),0),2),{r}*{r}),255,0)",
        o = o,
        r = r
    )
}

// geq: 255 inside a centred circle inset `o` px into the frame, else 0.
pub(super) fn circle_mask(o: i32) -> String {
    format!("if(lte((X-W/2+0.5)^2+(Y-H/2+0.5)^2,(W/2-{o})^2),255,0)", o = o)
}

// Where bubble `index` of `count` goes, for bubbles `bubble_w` wide (border included). Bubbles
// stack outward from the anchor corner; margin and gap scale with the frame like everything else.
pub(super) fn overlay_position_expr(anchor: &str, index: usize, count: usize, bubble_w: i32, frame_width: i32) -> String {
    let margin = even(frame_width as f64 * 0.025);
    let gap = even(frame_width as f64 * 0.012);
    let step = index as i32 * (bubble_w + gap);

    // (horizontal, vertical) - the 3x3 grid the modal offers.
    let (x_base, y_base) = match anchor {
        "top_left" => ("left", "top"),
        "top_center" => ("center", "top"),
        "top_right" => ("right", "top"),
        "center_left" => ("left", "middle"),
        "center" => ("center", "middle"),
        "center_right" => ("right", "middle"),
        "bottom_left" => ("left", "bottom"),
        "bottom_center" => ("center", "bottom"),
        // "bottom_right" and any unrecognized anchor.
        _ => ("right", "bottom"),
    };
    let x_expr = match x_base {
        "left" => format!("{}+{}", margin, step),
        "center" => {
            let total = count as i32 * bubble_w + (count.saturating_sub(1)) as i32 * gap;
            format!("(W-{})/2+{}", total, step)
        }
        _ => format!("W-w-{}-{}", margin, step),
    };
    let y_expr = match y_base {
        "top" => format!("{}", margin),
        "middle" => "(H-h)/2".to_string(),
        _ => format!("H-h-{}", margin),
    };
    format!("overlay=x={}:y={}", x_expr, y_expr)
}

// One camera's bubble, composited onto `prev_label` into `out_label`.
//
// Everything that defines the bubble's shape and border is drawn ONCE and looped: masks and the
// border ring are static images, merged with each camera frame. Computing them per frame (geq)
// measured ~1.8 CPU cores on its own; looped, the whole composite costs ~0.3. The camera is
// center-cropped to the bubble's aspect rather than squeezed into it.
#[allow(clippy::too_many_arguments)]
pub(super) fn overlay_stage_filter(
    style: &OverlayStyle,
    n: usize,
    input_label: &str,
    prev_label: &str,
    out_label: &str,
    position_expr: &str,
    pic: (i32, i32),
    border: i32,
) -> String {
    let (w, h) = pic;
    let (bw, bh) = (w + 2 * border, h + 2 * border);
    let color = ffmpeg_color(style.border_color);
    let radius = (w / 8).max(4);
    let shaped = style.shape == "circle" || style.shape == "rounded";
    // The camera, cropped to the bubble's aspect and scaled into it.
    let crop = if shaped {
        "crop='min(iw,ih)':'min(iw,ih)'"
    } else {
        "crop='min(iw,ih*4/3)':'min(ih,iw*3/4)'"
    };
    let mut picture = format!(
        "{input}{crop},scale={w}:{h},setsar=1,format=yuva420p",
        input = input_label,
        crop = crop,
        w = w,
        h = h
    );
    let mut stages = Vec::new();
    let mut cam = format!("cam{}", n);

    if border > 0 {
        // The picture sits inside a border-coloured frame. For shaped bubbles a looped ring
        // (border colour between the outer and inner shape) covers the frame's square corners
        // inside the outer shape, so the border follows the curve.
        picture.push_str(&format!(",pad={bw}:{bh}:{b}:{b}:color={c}", bw = bw, bh = bh, b = border, c = color));
        stages.push(format!("{}[{}]", picture, cam));
        let ring = match style.shape {
            "circle" => Some((circle_mask(0), circle_mask(border))),
            "rounded" => Some((rounded_mask(0, radius + border), rounded_mask(border, radius))),
            _ => None,
        };
        if let Some((outer, inner)) = ring {
            stages.push(format!(
                "color=c={c}:s={bw}x{bh}:r=1:d=1,format=yuva420p[ringc{n}]; \
                 color=black:s={bw}x{bh}:r=1:d=1,format=gray,geq=lum='if(gt({outer},0)*eq({inner},0),255,0)'[ringm{n}]; \
                 [ringc{n}][ringm{n}]alphamerge,loop=-1:1:0[ring{n}]; \
                 [{cam}][ring{n}]overlay=0:0:eof_action=repeat[camr{n}]",
                c = color,
                bw = bw,
                bh = bh,
                outer = outer,
                inner = inner,
                n = n,
                cam = cam
            ));
            cam = format!("camr{}", n);
        }
    } else {
        stages.push(format!("{}[{}]", picture, cam));
    }

    // The outer shape, cut out of the (bordered) picture.
    let outer = match style.shape {
        "circle" => Some(circle_mask(0)),
        "rounded" => Some(rounded_mask(0, radius + border)),
        _ => None,
    };
    let bubble = match outer {
        Some(mask) => {
            stages.push(format!(
                "color=black:s={bw}x{bh}:r=1:d=1,format=gray,geq=lum='{mask}',loop=-1:1:0[mask{n}]; \
                 [{cam}][mask{n}]alphamerge[bubble{n}]",
                bw = bw,
                bh = bh,
                mask = mask,
                n = n,
                cam = cam
            ));
            format!("[bubble{}]", n)
        }
        None => format!("[{}]", cam),
    };
    stages.push(format!("{}{}{}[{}]", prev_label, bubble, position_expr, out_label));
    stages.join("; ")
}

// Builds the full filter_complex chaining one overlay stage per camera onto the screen ([0:v],
// or `screen` - see build_camera_overlay_filter_complex_from), then a final downscale stage
// capping the composite at `max_width`, left unlabeled so ffmpeg maps it automatically.
//
// `crop` (w, h, x, y) is Some only for macOS's own window-capture path: avfoundation has no
// per-window capture mode at all, so a specific window has to be cropped out of a full-display
// capture instead - see window_capture::macos::get_window_rect_by_title.
#[cfg_attr(target_os = "windows", allow(dead_code))] // Windows uses the _from form below
pub fn build_camera_overlay_filter_complex(
    shape: &str,
    position: &str,
    size: &str,
    border: &str,
    border_color: &str,
    camera_count: usize,
    max_width: i32,
    crop: Option<(i32, i32, i32, i32)>,
) -> String {
    let style = OverlayStyle { shape, position, size, border, border_color };
    build_camera_overlay_filter_complex_from(
        &style,
        camera_count,
        max_width,
        max_width.min(MAX_RECORDING_WIDTH),
        crop.map(|(w, h, x, y)| format!("[0:v]crop={}:{}:{}:{}", w, h, x, y)).as_deref(),
        1,
    )
}

// Same graph, with `screen` - a filter chain producing the screen picture - in place of the raw
// [0:v] input, and the cameras starting at input `first_camera`. `frame_width` is the width of
// the picture the bubbles are composited onto, which every bubble dimension scales with.
pub(crate) fn build_camera_overlay_filter_complex_from(
    style: &OverlayStyle,
    camera_count: usize,
    max_width: i32,
    frame_width: i32,
    screen: Option<&str>,
    first_camera: usize,
) -> String {
    let pic = overlay_pixel_dimensions(style.shape, style.size, frame_width);
    let border = border_px(style.border, frame_width);
    let bubble_w = pic.0 + 2 * border;
    let mut stages: Vec<String> = Vec::with_capacity(camera_count + 2);
    let mut prev_label = "[0:v]".to_string();

    if let Some(chain) = screen {
        stages.push(format!("{}[src]", chain));
        prev_label = "[src]".to_string();
    }

    for index in 0..camera_count {
        let input_label = format!("[{}:v]", index + first_camera);
        let position_expr = overlay_position_expr(style.position, index, camera_count, bubble_w, frame_width);
        let out_label = format!("comp{}", index + 1);
        stages.push(overlay_stage_filter(style, index, &input_label, &prev_label, &out_label, &position_expr, pic, border));
        prev_label = format!("[{}]", out_label);
    }

    // Only append the final downscale when the screen stage hasn't already capped width to <= max_width
    // (on Windows, ScreenSource::stage already scales via vpp_qsv or scale before compositing).
    if screen.is_none() || frame_width > max_width {
        stages.push(format!("{}scale='min({},iw)':-2", prev_label, max_width));
    } else if let Some(last) = stages.last_mut() {
        // Leave the final composite unlabeled so ffmpeg maps it automatically.
        let suffix = format!("[comp{}]", camera_count);
        if last.ends_with(&suffix) {
            last.truncate(last.len() - suffix.len());
        }
    }
    stages.join("; ")
}

// Output codec flags per container extension. win.rs's sva mode predates this and keeps its own
// inline copy (see the "leave Windows as-is" note on that module), but recording_with_output_v
// uses this - it used to hardcode "-c:v mpeg4" for every extension, which is flatly invalid for
// "webm" (can't hold an mpeg4 stream) and, worse, produced mp4/mov files with no moov atom (and
// so completely unopenable - the reported "blank black screen") whenever stop_recording's
// graceful shutdown didn't finish in time and had to force-kill ffmpeg, since plain mp4/mov only
// ever write the moov atom once at the very end.
pub(crate) fn codec_args_for_ext(ext: &str) -> Vec<String> {
    match ext.to_lowercase().as_str() {
        "mp4" => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart+frag_keyframe+empty_moov".into(),
        ],
        "mkv" => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "aac".into(),
            // Without this, ffmpeg's native aac encoder defaults to 128k - noticeably more
            // compressed than the 192k every other lossy-audio branch here already uses. Same
            // fix as the "mp4"/"mov"/"webm"/fallback branches, just closing this one gap.
            "-b:a".into(),
            "192k".into(),
            // Same live-capture interleaving stall the "avi" branch above documents - measured
            // 5.7 fps written into mkv against 59.5 into mp4 for the same capture.
            "-max_interleave_delta".into(),
            "0".into(),
        ],
        "avi" => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "pcm_s16le".into(), // Better audio codec for AVI
            // AVI interleaves audio and video strictly, and with a *live* capture whose audio
            // arrives in bursts the muxer ends up holding video back waiting for audio to catch
            // up. Measured on a 4K desktop capture with a microphone: 4.7 fps written, against
            // 59.5 fps for the same capture into mp4. Relaxing the interleave constraint recovers
            // most of it (10.4 fps) - the muxer writes each packet when it has it instead of
            // stalling for its counterpart.
            //
            // It does not close the gap entirely: AVI caps out around 11-12 fps here even with no
            // audio at all, where mp4 sustains 60. AVI is simply a poor container for a live
            // high-resolution capture, which is why mp4 is the default (see defaultFileExt in
            // src/utils/appSettings.ts) - this only makes the explicit choice less punishing.
            "-max_interleave_delta".into(),
            "0".into(),
        ],
        "mov" => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart+frag_keyframe+empty_moov".into(),
        ],
        "webm" => vec![
            // gdigrab/avfoundation/x11grab all capture the screen with an alpha channel
            // (BGRA/ARGB) even though a desktop capture never has meaningful transparency.
            // libvpx's VP8 encoder happens to support alpha (as yuva420p), and ffmpeg's default
            // format auto-negotiation prefers that alpha-preserving path when the source has
            // one - but that path fails to even initialize in this build ("Error while opening
            // encoder... Nothing was written into output file", reproduced 100% of the time
            // against this app's own bundled ffmpeg on a real 4K capture). Forcing plain
            // yuv420p (dropping the pointless alpha channel) avoids that path entirely and the
            // encoder opens fine - this was the actual root cause of ".webm recordings don't
            // play", not a browser/WebView2 codec-support issue: the files were never valid to
            // begin with.
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:v".into(),
            "libvpx".into(), // libvpx (not libvpx-vp9) for wider compatibility
            "-b:v".into(),
            "2M".into(),
            "-c:a".into(),
            "libvorbis".into(), // libvorbis (not libopus), same reasoning
            // Without this, libvorbis defaults to its ~112k quality-3 preset - same gap as the
            // unset aac bitrate above, just for the vorbis encoder.
            "-b:a".into(),
            "192k".into(),
            // realtime+cpu-used 5, not good+cpu-used 0 (libvpx's slowest, offline-quality
            // preset) - this is live screen capture, not a file conversion, and needs an encoder
            // that can actually keep up with the incoming framerate. See win.rs's identical fix
            // for the full reasoning (an encoder that can't keep up backs up, and gets force-
            // killed with a large unflushed backlog when the recording stops, corrupting the
            // WebM/Matroska container).
            "-quality".into(),
            "realtime".into(),
            "-cpu-used".into(),
            "5".into(),
        ],
        _ => vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "23".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-g".into(),
            KEYFRAME_INTERVAL.into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-movflags".into(),
            "+faststart+frag_keyframe+empty_moov".into(),
        ],
    }
}

// Codec/bitrate flags for the audio-only record type's file extensions (mp3/wav/aac/wma - see
// BottomDocker.tsx's file-extension options when record_type is "a"). Same reasoning as
// codec_args_for_ext: recording_with_output_a used to set none of this at all, leaving it to
// ffmpeg's per-container default - which for mp3 measured out to the same 128k default this file
// keeps hitting elsewhere.
pub(crate) fn audio_codec_args_for_ext(ext: &str) -> Vec<String> {
    match ext.to_lowercase().as_str() {
        "mp3" => vec![
            "-c:a".into(),
            "libmp3lame".into(),
            "-b:a".into(),
            "192k".into(),
        ],
        "wav" => vec!["-c:a".into(), "pcm_s16le".into()], // uncompressed - no bitrate to set
        "wma" => vec!["-c:a".into(), "wmav2".into(), "-b:a".into(), "192k".into()],
        // "aac" and any unrecognized extension
        _ => vec!["-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()],
    }
}


// Hides the console window a spawned child would otherwise flash open on Windows (a no-op
// everywhere else, since spawning a child process never pops up a console on macOS/Linux in the
// first place). Split out from silent_command below so callers that actually want to read
// stdout/stderr (take_screenshot's error reporting needs ffmpeg's real stderr, not /dev/null)
// aren't forced to accept silent_command's opinion of nulling both.
#[cfg(target_os = "windows")]
pub(crate) fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x08000000);
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn hide_console_window(_cmd: &mut Command) {}

// Runs ffmpeg with a hidden console window on Windows, stdin piped (every recording mode needs
// this open for the graceful 'q'-to-stop in stop_recording), stdout/stderr discarded — the right
// default for the long-running recording modes below, none of which read their own output.
pub fn silent_command<P: AsRef<OsStr>>(program: P) -> Command {
    let mut cmd = Command::new(program);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    hide_console_window(&mut cmd);

    cmd
}

// Lip sync for a recording that takes picture and sound (or two sources of either) from separate
// live devices - every macOS/Linux mode with a mic, system audio or a camera beside the screen.
//
// By default ffmpeg rebases EACH input to zero at its own first packet, so where a device's stream
// lands depends on how long that device took to open - on Windows, before its own fix
// (services/audio_capture.rs), that measured 0.3s to 3.3s of drift between voice and picture. But
// these devices already stamp their packets on one shared clock: avfoundation (screen, cameras,
// mics, virtual loopback devices) with the Mac's host clock; x11grab and PulseAudio with the wall
// clock - and v4l2 cameras too once told to (`-ts abs`, converting their monotonic stamps). Keeping
// those stamps (`-copyts`) and shifting the whole recording so its earliest packet is zero
// (`-start_at_zero`) puts every device at the moment its samples were actually captured, whatever
// order they opened in. A single input needs nothing - it's already one clock.
pub(crate) fn sync_live_inputs(args: Vec<String>) -> Vec<String> {
    let inputs = args.iter().filter(|a| *a == "-i").count();
    if inputs < 2 || args.iter().any(|a| a == "-copyts") {
        return args;
    }
    let mut out: Vec<String> = vec!["-copyts".into(), "-start_at_zero".into()];
    let mut demuxer: Option<String> = None;
    for arg in args {
        if arg == "-i" && demuxer.as_deref() == Some("v4l2") {
            out.extend(["-ts".into(), "abs".into()]);
        }
        if arg == "-i" {
            demuxer = None;
        }
        let set_demuxer = out.last().is_some_and(|prev| prev == "-f");
        if set_demuxer {
            demuxer = Some(arg.clone());
        }
        out.push(arg);
    }
    out
}

