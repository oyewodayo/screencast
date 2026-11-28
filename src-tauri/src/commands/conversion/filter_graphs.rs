// FFmpeg filter-graph builders and specs for overlays, blur masks, color grading, blend modes, PiP, transitions, and Screen Style.
use super::*;

// A blurred region burned into the output video for its own [start_time,end_time) window - unlike
// OverlayImage, there's no *picture* content to pre-render: this only ever reads pixels that are
// already decoded into the filter graph's own current_label node (see export_trimmed_video's blur
// pass, built via ffmpeg's own split+crop+boxblur[+alphamerge]+overlay). `x`/`y`/`width`/`height`
// are already resolved to real output-video pixels by the frontend, same as OverlayImage's own
// x/y - for a plain rectangle these are the region itself; for anything mask-shaped they're the
// mask's own bounding box (see mask_data_base64's own doc comment).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayBlur {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub intensity: f64, // 0..1
    // A black/white mask PNG (frontend: renderBlurMaskToPng, only rendered when blurNeedsMask(o)
    // is true - ellipse, rounded corners, or rotated) - None for a plain axis-aligned rectangle,
    // which needs no mask at all since ffmpeg's own `crop` already produces exactly that shape.
    // When present, written to a temp file the same way OverlayImage's own data_base64 already is
    // (see write_temp_overlay_png) and applied via `alphamerge` instead of a bare crop+boxblur+overlay.
    pub mask_data_base64: Option<String>,
    pub start_time: f64,
    pub end_time: f64,
    // The preview's CSS blur radius (a Gaussian's standard deviation) in output pixels -
    // gaussian_blur_chain reproduces it. None: the older boxblur radius from `intensity`.
    #[serde(default)]
    pub sigma: Option<f64>,
    // Keyframed (e.g. motion-tracked) position: x/y are the region's top-left in output pixels at
    // absolute output seconds; scale/opacity are ignored (the region keeps its size).
    #[serde(default)]
    pub keyframes: Option<Vec<OverlayKeyframe>>,
}

// An adjustment layer (adjustmentLayers.ts): grades and/or blurs everything beneath it in the
// stack for its window - "under" sits on the video itself (below blur regions and every overlay),
// "over" above every overlay and PiP (captions stay on top). The preview is a backdrop-filter of
// the same CSS functions in the same order, so this composes exactly what the browser draws.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjustmentLayerSpec {
    pub start_time: f64,
    pub end_time: f64,
    pub placement: String,
    // CSS colour filter functions in order ("brightness", "contrast", "saturate", "hue-rotate"
    // (degrees), "sepia", "grayscale"), applied after the blur as the backdrop-filter list is.
    #[serde(default)]
    pub color_ops: Vec<CssOpSpec>,
    // Gaussian standard deviation in output pixels (CSS blur()); 0/None = none.
    #[serde(default)]
    pub blur_sigma: Option<f64>,
    // The "vignette" look's strength (vignetteBackground) drawn over the adjusted picture.
    #[serde(default)]
    pub vignette: Option<f64>,
    // 0..1, how much of the adjustment shows (the preview element's opacity).
    #[serde(default = "one")]
    pub opacity: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    // Where the effect applies: a grey mask PNG (renderAdjustmentMask) whose top-left sits at
    // (mask_x, mask_y) in output pixels - the effect is confined to that box and weighted by the
    // mask. None: the whole frame.
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    #[serde(default)]
    pub mask_x: i64,
    #[serde(default)]
    pub mask_y: i64,
    // The region moving (a spotlight following someone - adjustmentLayers.ts): the mask PNG is then
    // the region alone (not inverted), and these place its top-left over time (output pixels,
    // absolute output seconds); `mask_invert` turns it into "everything but the region".
    #[serde(default)]
    pub mask_keyframes: Option<Vec<OverlayKeyframe>>,
    #[serde(default)]
    pub mask_invert: bool,
    // A solid colour instead of the adjusted picture ("#rrggbb") - what masks the main video: show
    // only a region of it, the rest filled.
    #[serde(default)]
    pub fill: Option<String>,
}

pub(super) fn one() -> f64 {
    1.0
}

#[derive(Debug, Deserialize, Clone)]
pub struct CssOpSpec {
    pub op: String,
    pub value: f64,
}

// A chapter of the exported video - embedded in the MP4 (embed_chapters) and written to its
// `.chapters.json` sidecar so the player shows it. `time` is output seconds.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChapterSpec {
    pub time: f64,
    pub label: String,
}

// A background music/voiceover track to mix into the output's own audio - unlike OverlayImage,
// there's no client-side rendering step for this at all: the frontend never touches the source
// audio, it just names it (source_path) and passes the same trim/volume/fade parameters the
// AudioOverlay/AudioOverlayPopover editing UI already tracks (see videoEditTypes.ts's AudioOverlay
// and VideoTimelineDocker.tsx). trim_start/start_time/end_time are already resolved by the
// frontend (start_time/end_time are output-timeline seconds, same space `segments` occupies;
// trim_start is seconds into this track's own source file) - this command only builds the ffmpeg
// filter chain from them, same "just compositing, no richer shape known here" split OverlayImage
// already draws.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayAudio {
    pub source_path: String,
    pub start_time: f64,
    pub end_time: f64,
    pub trim_start: f64,
    pub volume: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    // "linear" (a fade set in the panel) or "equalPower" (a crossfade or a cut's edge fade, sin/cos
    // so overlapping pieces hold their level through it - audioJoins.ts).
    #[serde(default)]
    pub fade_in_curve: Option<String>,
    #[serde(default)]
    pub fade_out_curve: Option<String>,
    // Music ducking: lowered to `level` while someone speaks - see duck_volume_filter.
    #[serde(default)]
    pub duck: Option<DuckEnvelope>,
    // The mixer channel's EQ/compressor/balance (audio_fx.rs), after the volume and fades.
    #[serde(default)]
    pub fx: Option<AudioFxSpec>,
    // Volume automation: [seconds from this track's start, dB] points (audioAutomation.ts) - see
    // automation_volume_filter.
    #[serde(default)]
    pub gain: Option<Vec<[f64; 2]>>,
}

// afade's curve for an OverlayAudio fade: qsin (a quarter sine - its fade-out is the cosine, so a
// crossfade holds its power) for "equalPower", tri (straight) otherwise.
pub(super) fn fade_curve(curve: Option<&str>) -> &'static str {
    if curve == Some("equalPower") { "qsin" } else { "tri" }
}

// The mix's master bus (masterBus.ts): a trim, then a lookahead limiter - see master_audio_filters.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MasterBusSpec {
    #[serde(default)]
    pub trim_db: Option<f64>,
    #[serde(default)]
    pub limiter: Option<MasterLimiterSpec>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MasterLimiterSpec {
    pub ceiling_db: f64,
    pub release_ms: f64,
}

// The master bus as filters on the finished mix. The limiter runs at 4x the sample rate so it
// catches the peaks between samples too (true peak), with the preview's 5 ms lookahead
// (master-bus-processor.js) as its attack; latency=1 keeps the sound in sync with the picture.
pub(super) fn master_audio_filters(master: Option<&MasterBusSpec>) -> Vec<String> {
    let Some(m) = master else { return Vec::new() };
    let mut filters = Vec::new();
    let trim = m.trim_db.filter(|t| t.is_finite()).unwrap_or(0.0).clamp(-24.0, 24.0);
    if trim.abs() > 0.001 {
        filters.push(format!("volume={trim:.3}dB"));
    }
    if let Some(lim) = &m.limiter {
        filters.push(format!(
            "aresample=192000,alimiter=limit={:.5}:attack=5:release={:.1}:level=false:latency=1,aresample=48000",
            master_ceiling(lim),
            lim.release_ms.clamp(1.0, 2000.0)
        ));
    }
    filters
}

// The limiter's ceiling as a linear level, inside alimiter's range.
pub(super) fn master_ceiling(lim: &MasterLimiterSpec) -> f64 {
    10f64.powf(lim.ceiling_db.clamp(-24.0, 0.0) / 20.0).clamp(0.0625, 1.0)
}

// A `volume` filter for one track's automation, in its own local time (its chain starts at 0 =
// its start_time): the dB line runs straight between points and holds flat beyond the ends -
// written as the first level plus each segment's share of its change, so the expression stays flat
// however many points there are. Evaluated per frame, and the frames are cut to 256 samples first
// (~5 ms) so a ramp moves smoothly rather than in audible steps. None when it would change nothing.
pub(super) fn automation_volume_filter(points: &[[f64; 2]]) -> Option<String> {
    let pts: Vec<[f64; 2]> = points.iter().copied().filter(|[t, db]| t.is_finite() && db.is_finite()).collect();
    if pts.is_empty() || pts.iter().all(|[_, db]| db.abs() < 0.01) {
        return None;
    }
    let mut expr = format!("{:.3}", pts[0][1]);
    for w in pts.windows(2) {
        let ([t0, d0], [t1, d1]) = (w[0], w[1]);
        if (d1 - d0).abs() < 1e-6 {
            continue;
        }
        let span = (t1 - t0).max(1e-3);
        expr.push_str(&format!("+({:.3})*clip((t{})/{:.4},0,1)", d1 - d0, minus_term(t0), span));
    }
    Some(format!("asetnsamples=n=256:p=0,volume='pow(10,({expr})/20)':eval=frame"))
}

// Where to lower a music track under speech, worked out by the frontend (src/utils/musicDucking.ts,
// which applies the very same curve to the live preview): `ranges` are output-timeline seconds of
// speech; the gain eases down `attack` s before each one starts (the export can look ahead, so the
// music is already down when the first word lands) and back up over `release` s after it ends.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuckEnvelope {
    pub level: f64,
    pub attack: f64,
    pub release: f64,
    pub ranges: Vec<[f64; 2]>,
}

// "-x" for a non-negative x, "+|x|" otherwise - ffmpeg's expression parser doesn't need it, but a
// "t--1.2" in a filter graph is easy to misread when debugging one.
pub(super) fn minus_term(x: f64) -> String {
    if x >= 0.0 { format!("-{:.3}", x) } else { format!("+{:.3}", -x) }
}

// A `volume` filter (evaluated per audio frame) for one overlay's ducking, in the overlay's own
// local time (its chain is atrim'd and asetpts'd to start at 0 = its start_time). Per speech range,
// a trapezoid rising over `attack` and falling over `release`; summed and capped at 1, since the
// frontend merges ranges whose ramps would otherwise meet. None when there's nothing to duck.
pub(super) fn duck_volume_filter(duck: &DuckEnvelope, start_time: f64, duration: f64) -> Option<String> {
    let level = duck.level.clamp(0.0, 1.0);
    let (attack, release) = (duck.attack.max(0.01), duck.release.max(0.01));
    if level >= 0.999 {
        return None;
    }
    let terms: Vec<String> = duck
        .ranges
        .iter()
        .map(|[s, e]| (s - start_time, e - start_time))
        .filter(|(s, e)| s.is_finite() && e.is_finite() && e > s && e + release > 0.0 && s - attack < duration)
        .map(|(s, e)| format!("clip((t{})/{:.3},0,1)*clip(({:.3}-t)/{:.3},0,1)", minus_term(s - attack), attack, e + release, release))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(format!("volume='1-{:.3}*min(1,{})':eval=frame", 1.0 - level, terms.join("+")))
}

// A picture-in-picture video layer - e.g. a webcam recorded separately from the screen (see
// FormData.separate_webcam_capture, recording.rs) and composited back on top of the primary clip
// track here instead of being permanently baked in. Unlike OverlayImage, there's real per-frame
// video content to read (not a single pre-rendered PNG), so this gets its own `-i` input (the
// FULL source file - trim_start/start_time/end_time below scope which window of it is actually
// used, the same trim-then-composite shape `segments` itself uses) rather than joining the image/
// blur temp-file pipeline. `x`/`y`/`width`/`height` are already resolved to real output-video
// pixels by the frontend, same as OverlayImage's own x/y.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipOverlay {
    pub source_path: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
    pub shape: String, // "circle" | "rounded" | "rectangle" - sanitized via sanitize_pip_shape
    pub corner_radius: Option<f64>, // fraction of `height`, "rounded" only
    // Source-frame region to keep (fractions of the pip source's own width/height, same basis as
    // PipOverlay.crop, videoEditTypes.ts) - applied before the cover-fit scale below. `default` so
    // an older frontend that never sends it still deserializes.
    #[serde(default)]
    pub crop: Option<PipCrop>,
    pub trim_start: f64,
    pub start_time: f64,
    pub end_time: f64,
    // 0.0 when the frontend's own "play this clip's own audio" toggle is off (see
    // PipOverlay.muted, videoEditTypes.ts) - collapsed to a single number the same way
    // effective_video_volume already folds audio_muted into the primary track's own volume,
    // rather than carrying a separate bool here too.
    pub volume: f64,
    // CSS mix-blend-mode, as OverlayImage.blend_mode.
    #[serde(default)]
    pub blend_mode: Option<String>,
    // Its sound's EQ/compressor/balance (audio_fx.rs), as OverlayAudio.fx.
    #[serde(default)]
    pub fx: Option<AudioFxSpec>,
    // 0..1 (None = 1), and linear alpha ramps at its ends in seconds (already capped at half its
    // length by the frontend - videoTracks.ts exportFades).
    #[serde(default)]
    pub opacity: Option<f64>,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    // Green/blue-screen keying (chroma_key_filters); None = none.
    #[serde(default)]
    pub chroma_key: Option<ChromaKeySpec>,
    // A grey PNG the size of the box (white = shown): the layer's shape and its mask, feathered,
    // rendered by the frontend (layerMask.ts) - the very picture the preview masks with. Multiplied
    // into the layer's alpha. None: the shape alone, drawn here (geq).
    #[serde(default)]
    pub mask_data_base64: Option<String>,
    // Filled in by export_trimmed_video, not sent: how the preview decoded the source's colours
    // (probe_browser_color), and the ffmpeg input holding the mask PNG.
    #[serde(skip)]
    pub source_color: Option<(&'static str, &'static str)>,
    #[serde(skip)]
    pub mask_input: Option<usize>,
    // The person cut out of the source (background_removal.rs): a VP9+alpha WebM shown in place of
    // the source's picture. Its sound still comes from the source.
    #[serde(default)]
    pub cutout_path: Option<String>,
    // What shows behind a cut-out person, inside the layer (none = see-through).
    #[serde(default)]
    pub cutout_background: Option<CutoutBackgroundSpec>,
    // Filled in by export_trimmed_video: the inputs holding its picture and, when that's the
    // cut-out, its sound - and its background's (the source again, or the picture).
    #[serde(skip)]
    pub video_input: usize,
    #[serde(skip)]
    pub audio_input: Option<usize>,
    #[serde(skip)]
    pub background_input: Option<usize>,
    // A mask that moves and resizes (a reveal - layerMask.ts): its own picture (the shape, feathered,
    // with room for the feather around it) placed at each moment's box inside the layer.
    #[serde(default)]
    pub mask_motion: Option<MaskMotionSpec>,
    #[serde(skip)]
    pub mask_motion_input: Option<usize>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MaskMotionSpec {
    pub image_base64: String,
    // The picture's top-left and size in the layer's box (pixels), at absolute output seconds.
    pub keyframes: Vec<MaskKeyframeSpec>,
    #[serde(default)]
    pub invert: bool,
}

#[derive(Debug, Deserialize, Clone)]
pub struct MaskKeyframeSpec {
    pub time: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub easing: String,
}

// The moving mask as a grey stream the layer's size ([out]): the mask's picture scaled and placed
// per frame on black (inverted when asked). Its input is the picture looped at `fps` (the overlay
// rate) from the layer's start, so the frame number gives the time for the per-frame size.
pub(super) fn moving_mask_chain(pip: &PipOverlay, motion: &MaskMotionSpec, input: usize, tag: &str, out: &str, fps: f64) -> String {
    // The keyframes as OverlayKeyframes (x, y, and the size riding in scale/opacity), for keyframe_expr.
    let kfs: Vec<OverlayKeyframe> = motion
        .keyframes
        .iter()
        .map(|k| OverlayKeyframe { time: k.time, x: k.x, y: k.y, scale: k.w.max(2.0), opacity: k.h.max(2.0), easing: k.easing.clone() })
        .collect();
    let (w, h, st) = (pip.width, pip.height, pip.start_time);
    let frame_time = format!("({st:.4}+n/{fps})");
    let (mw, mh) = (keyframe_expr(&kfs, &frame_time, |k| k.scale), keyframe_expr(&kfs, &frame_time, |k| k.opacity));
    let (kx, ky) = (keyframe_expr(&kfs, "t", |k| k.x), keyframe_expr(&kfs, "t", |k| k.y));
    // Smaller than 2 px the picture can't be scaled down any further - a closed reveal would show as
    // a faint dot or line. The preview draws nothing there, so neither does this.
    let raw: Vec<OverlayKeyframe> = motion
        .keyframes
        .iter()
        .map(|k| OverlayKeyframe { time: k.time, x: 0.0, y: 0.0, scale: k.w, opacity: k.h, easing: k.easing.clone() })
        .collect();
    let (tw, th) = (keyframe_expr(&raw, "t", |k| k.scale), keyframe_expr(&raw, "t", |k| k.opacity));
    let shown = format!("gte({tw},2)*gte({th},2)");
    let negate = if motion.invert { ",negate" } else { "" };
    let d = (pip.end_time - pip.start_time).max(0.01) + 0.1;
    format!(
        "color=c=black:s={w}x{h}:r={fps}:d={d:.3},setpts=PTS+{st:.4}/TB,format=yuv420p[{tag}mc];\
         [{input}:v]format=yuv420p,setpts=PTS-STARTPTS+{st:.4}/TB,scale=w='max(2,trunc({mw}/2)*2)':h='max(2,trunc({mh}/2)*2)':eval=frame[{tag}mp];\
         [{tag}mc][{tag}mp]overlay=x='{kx}':y='{ky}':eof_action=repeat:enable='{shown}',format=gray{negate}[{out}];"
    )
}

// Behind a cut-out (cutoutBackground.ts): "color" - a solid colour; "image" - a picture, already
// fitted to the layer's box by the frontend (the very drawing the preview shows); "blur" - the
// source itself (its `source_crop` part) blurred by `blur_sigma` output pixels, drawn
// `blur_margin` px larger on each side before the blur so its edges stay full (the preview draws
// it the same way).
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CutoutBackgroundSpec {
    pub kind: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub image_base64: Option<String>,
    #[serde(default)]
    pub blur_sigma: Option<f64>,
    #[serde(default)]
    pub blur_margin: Option<i64>,
    #[serde(default)]
    pub source_crop: Option<PipCrop>,
}

// The filters putting `bg` behind the cut-out [cut] (both the layer's size), writing [out] - empty
// when the background can't be drawn (it then stays see-through). `fps`: the overlay rate.
pub(super) fn cutout_background_chain(pip: &PipOverlay, bg: &CutoutBackgroundSpec, cut: &str, tag: &str, out: &str, fps: f64) -> String {
    let (w, h, st) = (pip.width, pip.height, pip.start_time);
    let dur = (pip.end_time - pip.start_time).max(0.01) + 0.1;
    let base = match bg.kind.as_str() {
        "color" => {
            let hex = bg.color.as_deref().map(|c| c.trim().trim_start_matches('#')).and_then(|c| u32::from_str_radix(c, 16).ok()).unwrap_or(0) & 0xff_ffff;
            format!("color=c=0x{hex:06x}:s={w}x{h}:r={fps}:d={dur:.3},setpts=PTS+{st:.4}/TB,format=yuv420p[{tag}bg];")
        }
        "image" => match pip.background_input {
            Some(input) => format!(
                "color=c=black:s={w}x{h}:r={fps}:d={dur:.3},setpts=PTS+{st:.4}/TB,format=yuv420p[{tag}bb];\
                 [{input}:v]scale={w}:{h},setpts=PTS-STARTPTS+{st:.4}/TB[{tag}bi];[{tag}bb][{tag}bi]overlay=eof_action=repeat:format=auto,format=yuv420p[{tag}bg];"
            ),
            None => return String::new(),
        },
        "blur" => match pip.background_input {
            Some(input) => {
                let sigma = bg.blur_sigma.filter(|s| s.is_finite()).unwrap_or(0.0).max(0.0);
                let m = bg.blur_margin.unwrap_or(0).clamp(0, 4096);
                let (bw, bh) = (w + 2 * m, h + 2 * m);
                let blur = gaussian_blur_chain(sigma, bw, bh, None);
                let blur = if blur.is_empty() { String::new() } else { format!("{blur},") };
                format!(
                    "[{input}:v]trim=start={ts:.3}:end={te:.3},setpts=PTS-STARTPTS+{st:.4}/TB,{crop}scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},format=yuv420p,{blur}crop={w}:{h}:{m}:{m}[{tag}bg];",
                    ts = pip.trim_start,
                    te = pip.trim_start + dur,
                    crop = pip_crop_fragment(bg.source_crop),
                )
            }
            None => return String::new(),
        },
        _ => return String::new(),
    };
    format!("{base}[{tag}bg][{cut}]overlay=shortest=1:format=auto,format=yuv420p[{out}];")
}

// A key colour ("#rrggbb"), how close to it counts as screen and how soft the edge is (ffmpeg
// chromakey's similarity/blend), and how much screen-coloured spill to take out of the subject.
#[derive(Debug, Deserialize, Clone)]
pub struct ChromaKeySpec {
    pub color: String,
    pub similarity: f64,
    pub blend: f64,
    #[serde(default)]
    pub spill: f64,
}

#[derive(Debug, Deserialize, Clone, Copy)]
pub struct PipCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// `crop=` fragment (with trailing comma) for a pip's source-frame crop, or "" when there's nothing
// to crop - an unset, non-finite, or effectively full-frame crop is skipped entirely rather than
// emitted as a no-op filter. Clamped the same way ClipCropOverlay clamps it on the frontend
// (MIN_FRACTION 0.05), so a hand-edited sidecar can't ask ffmpeg for a zero-area crop.
pub(super) fn pip_crop_fragment(crop: Option<PipCrop>) -> String {
    let Some(c) = crop else { return String::new() };
    if ![c.x, c.y, c.width, c.height].iter().all(|v| v.is_finite()) {
        return String::new();
    }
    let w = c.width.clamp(0.05, 1.0);
    let h = c.height.clamp(0.05, 1.0);
    let x = c.x.clamp(0.0, 1.0 - w);
    let y = c.y.clamp(0.0, 1.0 - h);
    if w > 0.999 && h > 0.999 {
        return String::new();
    }
    format!(
        "crop=w=iw*{w:.6}:h=ih*{h:.6}:x=iw*{x:.6}:y=ih*{y:.6},",
        w = w, h = h, x = x, y = y
    )
}

pub(super) const ALLOWED_PIP_SHAPES: &[&str] = &["circle", "rounded", "rectangle"];

pub(super) fn sanitize_pip_shape(shape: &str) -> &str {
    ALLOWED_PIP_SHAPES
        .iter()
        .find(|&&s| s == shape)
        .copied()
        .unwrap_or("rectangle")
}

// How the webview decodes a source's colours to RGB, as scale's in_color_matrix/in_range values: its
// own tags when it has them; untagged, BT.709 from 720 rows up and BT.601 below, limited range -
// measured on WebView2's decoder (an untagged 1280x718 frame decodes as 601, 64x720 as 709).
// ffmpeg on its own would assume BT.601 for all of them.
pub(crate) fn browser_color_for(color_space: &str, color_range: &str, height: i64) -> (&'static str, &'static str) {
    let matrix = match color_space {
        "bt709" => "bt709",
        "smpte170m" | "bt470bg" => "bt601",
        "bt2020nc" | "bt2020c" => "bt2020",
        "smpte240m" => "smpte240m",
        "fcc" => "fcc",
        _ if height >= 720 => "bt709",
        _ => "bt601",
    };
    let range = if matches!(color_range, "pc" | "jpeg") { "pc" } else { "tv" };
    (matrix, range)
}

pub(super) fn probe_browser_color(ffprobe_path: &PathBuf, source_path: &str) -> (&'static str, &'static str) {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args(["-v", "quiet", "-select_streams", "v:0", "-show_entries", "stream=height,color_space,color_range", "-of", "json", source_path]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let stream = cmd
        .output()
        .ok()
        .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
        .and_then(|v| v["streams"].get(0).cloned())
        .unwrap_or_default();
    browser_color_for(stream["color_space"].as_str().unwrap_or(""), stream["color_range"].as_str().unwrap_or(""), stream["height"].as_i64().unwrap_or(0))
}

// The YUV matrix a player will decode an untagged export of `frame_height` rows with - what a keyed
// layer's colours are converted back to (the same 720-row rule as browser_color_for).
pub(super) fn output_matrix(frame_height: i64) -> &'static str {
    if frame_height >= 720 { "bt709" } else { "bt601" }
}

// Green/blue-screen keying - the filter fragment (no trailing comma) taking a source frame to
// straight-alpha rgba. The preview's shader (ChromaKeyCanvas.tsx) runs the same maths, checked
// against these filters in chromaKey.test.ts:
//   1. to RGB the way the webview decodes it (`source`: matrix, range), then full-range BT.601 YUV
//      4:4:4 - the space chromakey measures chroma in (it's chroma only, so shadows key too);
//   2. chromakey: alpha from the 3x3 neighbourhood's distance to the key colour's (U,V);
//   3. back to RGB, then despill: the screen channel pulled toward the average of the other two.
pub(super) fn chroma_key_filters(k: &ChromaKeySpec, (matrix, range): (&str, &str)) -> String {
    let hex = u32::from_str_radix(k.color.trim().trim_start_matches('#'), 16).unwrap_or(0x00b140) & 0xff_ffff;
    let finite = |v: f64, d: f64| if v.is_finite() { v } else { d };
    let similarity = finite(k.similarity, 0.12).clamp(0.01, 1.0);
    let blend = finite(k.blend, 0.08).clamp(0.0, 1.0);
    let spill = finite(k.spill, 0.0).clamp(0.0, 1.0);
    let mut f = format!(
        "scale=in_color_matrix={matrix}:in_range={range},format=gbrp,scale=out_color_matrix=bt601:out_range=pc,format=yuv444p,\
         chromakey=color=0x{hex:06x}:similarity={similarity}:blend={blend},scale=in_color_matrix=bt601:in_range=pc,format=rgba"
    );
    if spill > 0.0 {
        // Blue screen when the key leans blue, as spillType (chromaKey.ts) decides.
        let (g, b) = ((hex >> 8) & 0xff, hex & 0xff);
        let (kind, green, blue) = if b > g { ("blue", 0.0, -spill) } else { ("green", -spill, 0.0) };
        f.push_str(&format!(",despill=type={kind}:mix=0.5:expand=0:red=0:green={green}:blue={blue}:brightness=0:alpha=0"));
    }
    f
}

// One PiP overlay's filter-graph fragment: trims this overlay's own [trim_start, trim_start+
// duration) window out of its (already `-i`'d, full-length) source, scales it to fill exactly
// `width`x`height` - `force_original_aspect_ratio=increase` then `crop` is the standard ffmpeg
// "cover" recipe, matching the live preview's own CSS `object-fit: cover` exactly rather than
// stretching or letterboxing - then masks it into shape and composites it onto `current_label`.
// Circle/rounded reuse the same geq-based geometric-mask technique recording.rs's own
// build_camera_overlay_filter_complex already uses for the baked-in overlay this feature is the
// editable alternative to (kept as a separate copy here rather than a shared function - the two
// commands build genuinely different surrounding graphs, and geq expressions are short enough that
// sharing would cost more in indirection than it'd save).
pub(super) fn pip_overlay_chain(
    pip: &PipOverlay,
    input_index: usize,
    stage_index: usize,
    current_label: &str,
    out_label: &str,
    // The final frame's size - needed to blend (blend_composite); None composites normally.
    frame: Option<(i64, i64)>,
    // The overlay rate its masks and backgrounds run at.
    fps: f64,
) -> String {
    let duration = (pip.end_time - pip.start_time).max(0.01);
    let trim_end = pip.trim_start + duration;
    // Re-timed to start at the PiP's own start_time on the output timeline - starting it at 0 made
    // the overlay below (which takes the latest frame at or before each output moment) show the
    // wrong part of the source, or freeze on its last frame, whenever a PiP didn't start at 0:00.
    // A keyed layer is keyed at the source's own size (as the preview's shader keys the decoded
    // frame), scaled with its alpha premultiplied (as the browser scales it - no screen-coloured
    // fringe), and converted back to YUV with the matrix the export will be watched with.
    // A cut-out (background_removal.rs) already carries its alpha - tagged BT.709, as it was written.
    let alpha_source = if pip.cutout_path.is_some() {
        Some("scale=in_color_matrix=bt709:in_range=tv,format=rgba".to_string())
    } else {
        pip.chroma_key.as_ref().map(|k| chroma_key_filters(k, pip.source_color.unwrap_or(("bt601", "tv"))))
    };
    let (key, cover_scale, to_yuv) = match alpha_source {
        Some(to_rgba) => (
            format!("{to_rgba},"),
            format!("premultiply=inplace=1,scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},unpremultiply=inplace=1", w = pip.width, h = pip.height),
            format!(",scale=out_color_matrix={}:out_range=tv,format=yuva420p", output_matrix(frame.map_or(0, |(_, h)| h))),
        ),
        None => (String::new(), format!("scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}", w = pip.width, h = pip.height), String::new()),
    };
    let cover = format!(
        "trim=start={ts:.3}:end={te:.3},setpts=PTS-STARTPTS+{st:.4}/TB,{src_crop}{key}{cover_scale}{to_yuv}",
        ts = pip.trim_start, te = trim_end, st = pip.start_time, src_crop = pip_crop_fragment(pip.crop)
    );
    let shape = sanitize_pip_shape(&pip.shape);
    let video_label = format!("pip{}v", stage_index);

    let mut chain = String::new();
    // With a mask PNG (shape and mask together, from the frontend) or a key, the picture's own
    // alpha is kept and the mask multiplied into it; otherwise the shape is drawn here.
    let composited_label = if pip.mask_input.is_some() || pip.mask_motion_input.is_some() || pip.chroma_key.is_some() || pip.cutout_path.is_some() {
        chain.push_str(&format!("[{input_index}:v]{cover}[{video_label}];"));
        // A cut-out's background goes in behind the person first; shape and mask then cut both.
        let video_label = match (pip.cutout_path.as_ref(), pip.cutout_background.as_ref()) {
            (Some(_), Some(bg)) => {
                let out = format!("pip{stage_index}bgo");
                let bg_chain = cutout_background_chain(pip, bg, &video_label, &format!("pip{stage_index}"), &out, fps);
                if bg_chain.is_empty() {
                    video_label
                } else {
                    chain.push_str(&bg_chain);
                    out
                }
            }
            _ => video_label,
        };
        let t = format!("pip{stage_index}k");
        // The mask to multiply in: the static shape/mask picture, the moving mask, or both.
        let still = pip.mask_input.map(|mask| {
            chain.push_str(&format!("[{mask}:v]format=gray,scale={w}:{h},setpts=PTS-STARTPTS+{st:.4}/TB[{t}m];", w = pip.width, h = pip.height, st = pip.start_time));
            format!("{t}m")
        });
        let moving = match (pip.mask_motion.as_ref(), pip.mask_motion_input) {
            (Some(motion), Some(input)) => {
                chain.push_str(&moving_mask_chain(pip, motion, input, &t, &format!("{t}mv"), fps));
                Some(format!("{t}mv"))
            }
            _ => None,
        };
        let mask = match (still, moving) {
            (Some(a), Some(b)) => {
                chain.push_str(&format!("[{a}][{b}]blend=all_mode=multiply[{t}mb];"));
                Some(format!("{t}mb"))
            }
            (a, b) => a.or(b),
        };
        match mask {
            Some(mask) => {
                chain.push_str(&format!(
                    "[{video_label}]format=yuva420p,split=2[{t}c][{t}a0];[{t}a0]alphaextract[{t}a];[{t}a][{mask}]blend=all_mode=multiply[{t}ma];[{t}c][{t}ma]alphamerge[{t}out];"
                ));
                format!("{t}out")
            }
            None => video_label,
        }
    } else {
        match shape {
        "rectangle" => {
            chain.push_str(&format!("[{}:v]{}[{}];", input_index, cover, video_label));
            video_label
        }
        _ => {
            let mask_expr = if shape == "rounded" {
                let r = ((pip.corner_radius.unwrap_or(0.08).max(0.0).min(0.5)) * pip.height as f64)
                    .round() as i64;
                // Distance past the nearest corner circle's centre on each axis (0 anywhere along
                // the straight edges/interior) - opaque iff that point lies within radius r, i.e.
                // real quarter-circle corners matching the preview's CSS border-radius.
                format!(
                    "if(lte(pow(max(max({r}-X,X-(W-1-{r})),0),2)+pow(max(max({r}-Y,Y-(H-1-{r})),0),2),{r}*{r}),255,0)",
                    r = r.max(1)
                )
            } else {
                // Ellipse inscribed in the box (a true circle when the box is square) - matches the
                // preview's `ellipse(50% 50%)` clip-path, so a non-square box never gets cut into
                // the circle-wider-than-its-box shape a plain W/2 radius produced.
                "if(gt((X-W/2)^2/((W/2)^2)+(Y-H/2)^2/((H/2)^2),1),0,255)".to_string()
            };
            let alpha_label = format!("pip{}a", stage_index);
            let masked_label = format!("pip{}m", stage_index);
            // Reads the raw `-i`'d input twice (once per branch below) rather than an explicit
            // `split` - ffmpeg fans out a raw demuxed/decoded input stream reference on its own,
            // the same "{input}...{input}..." idiom overlay_stage_filter (recording.rs) already
            // relies on for exactly this shape-masking technique.
            chain.push_str(&format!(
                "[{idx}:v]{cover},geq=lum_expr='{mask_expr}',format=yuva420p[{alpha}];",
                idx = input_index,
                cover = cover,
                mask_expr = mask_expr,
                alpha = alpha_label
            ));
            chain.push_str(&format!(
                "[{idx}:v]{cover}[{video}];",
                idx = input_index,
                cover = cover,
                video = video_label
            ));
            chain.push_str(&format!(
                "[{video}][{alpha}]alphamerge[{masked}];",
                video = video_label,
                alpha = alpha_label,
                masked = masked_label
            ));
            masked_label
        }
        }
    };

    let composited_label = pip_alpha_stage(pip, stage_index, composited_label, &mut chain);

    if let (Some(mode), Some(frame)) = (pip.blend_mode.as_deref().and_then(blend_mode_ffmpeg), frame) {
        let layer = BlendLayer { label: &composited_label, x: pip.x.to_string(), y: pip.y.to_string(), width: pip.width, height: pip.height, moving: false, fps: PIP_BLEND_FPS };
        chain.push_str(&blend_composite(current_label, &layer, frame, mode, pip.start_time, pip.end_time, &format!("pipb{stage_index}"), out_label));
        return chain;
    }
    chain.push_str(&format!(
        "[{current}][{composited}]overlay=x={x}:y={y}:enable='between(t,{start:.3},{end:.3})'[{out}];",
        current = current_label, composited = composited_label, x = pip.x, y = pip.y, start = pip.start_time, end = pip.end_time, out = out_label
    ));
    chain
}

// A layer's opacity and fade in/out: its alpha scaled, the fades as linear ramps over its own
// (re-timed) frames - the same curve layerOpacityAt (videoTracks.ts) draws in the preview. Returns
// the label to composite (`label` itself when there's nothing to do).
pub(super) fn pip_alpha_stage(pip: &PipOverlay, stage_index: usize, label: String, chain: &mut String) -> String {
    let opacity = pip.opacity.unwrap_or(1.0);
    let opacity = if opacity.is_finite() { opacity.clamp(0.0, 1.0) } else { 1.0 };
    let half = ((pip.end_time - pip.start_time) / 2.0).max(0.0);
    let fade_in = if pip.fade_in.is_finite() { pip.fade_in.clamp(0.0, half) } else { 0.0 };
    let fade_out = if pip.fade_out.is_finite() { pip.fade_out.clamp(0.0, half) } else { 0.0 };
    if opacity >= 0.999 && fade_in < 0.001 && fade_out < 0.001 {
        return label;
    }
    // On the alpha plane alone - format=yuva420p only adds one (opaque) to a layer without, and
    // leaves its colours as they are.
    let mut filters = vec!["format=yuva420p".to_string()];
    if opacity < 0.999 {
        filters.push(format!("lut=a='val*{opacity:.4}'"));
    }
    if fade_in >= 0.001 {
        filters.push(format!("fade=t=in:st={:.4}:d={fade_in:.4}:alpha=1", pip.start_time));
    }
    if fade_out >= 0.001 {
        filters.push(format!("fade=t=out:st={:.4}:d={fade_out:.4}:alpha=1", pip.end_time - fade_out));
    }
    let out = format!("pip{stage_index}o");
    chain.push_str(&format!("[{label}]{}[{out}];", filters.join(",")));
    out
}

// ---- Blend modes -------------------------------------------------------------------------------
//
// An overlay with a CSS mix-blend-mode (the preview sets it on the overlay's element, over the
// video) is composited the way the W3C compositing spec defines: the blend function B(backdrop,
// source) per RGB channel, then mixed over the backdrop by the layer's alpha -
// result = backdrop + alpha * (B - backdrop). The blend runs in planar RGB (gbrp), where every
// mode below was measured against the spec's formula on all 65,536 8-bit pairs: within 2 levels
// (most exact). Soft light (31 dB off) and dodge/burn (wrong at the extremes) aren't offered.
// The backdrop is blend's TOP input - overlay/hard-light are only the spec's with it that way round.
pub(super) fn blend_mode_ffmpeg(mode: &str) -> Option<&'static str> {
    match mode {
        "multiply" => Some("multiply"),
        "screen" => Some("screen"),
        "overlay" => Some("overlay"),
        "hard-light" => Some("hardlight"),
        "darken" => Some("darken"),
        "lighten" => Some("lighten"),
        "difference" => Some("difference"),
        "exclusion" => Some("exclusion"),
        // CSS plus-lighter: min(1, alpha*source + backdrop) - an add of the premultiplied layer.
        "plus-lighter" => Some("addition"),
        _ => None,
    }
}

// A PiP's own frames are sampled onto its blend canvas at up to this rate (a source faster than
// the canvas would otherwise lose frames there).
pub(super) const PIP_BLEND_FPS: f64 = 60.0;

// The layer blend_composite blends: an rgba stream of width x height, at (x, y) of the frame
// (ffmpeg expressions in `t`, overlay_w/overlay_h and W/H when `moving`), timed in absolute
// output seconds.
pub(super) struct BlendLayer<'a> {
    pub(super) label: &'a str,
    pub(super) x: String,
    pub(super) y: String,
    pub(super) width: i64,
    pub(super) height: i64,
    // Position changes over time: the blend then covers the whole frame instead of the layer's box.
    pub(super) moving: bool,
    // Rate the layer is drawn onto its canvas at.
    pub(super) fps: f64,
}

// Composites `layer` onto [current] with blend `mode` over [start, end], writing [out]. Only the
// layer's own box is touched (for a still one; the frame for a moving one) - the rest passes
// through untouched, never round-tripped through RGB.
#[allow(clippy::too_many_arguments)]
pub(super) fn blend_composite(current: &str, layer: &BlendLayer, (fw, fh): (i64, i64), mode: &str, start: f64, end: f64, tag: &str, out: &str) -> String {
    // The box, clamped to the frame and widened to even edges: 4:2:0 chroma can only be cropped on
    // even pixels, so an odd edge would shift the backdrop half a chroma sample against the layer.
    let (rx, ry, rw, rh) = if layer.moving {
        (0, 0, fw, fh)
    } else {
        let (x, y) = (layer.x.parse::<i64>().unwrap_or(0), layer.y.parse::<i64>().unwrap_or(0));
        let x0 = x.clamp(0, fw) & !1;
        let y0 = y.clamp(0, fh) & !1;
        let x1 = ((x + layer.width).clamp(0, fw) + 1) & !1;
        let y1 = ((y + layer.height).clamp(0, fh) + 1) & !1;
        (x0, y0, (x1.min(fw) - x0).max(2), (y1.min(fh) - y0).max(2))
    };
    let (lx, ly) = if layer.moving {
        (layer.x.clone(), layer.y.clone())
    } else {
        ((layer.x.parse::<i64>().unwrap_or(0) - rx).to_string(), (layer.y.parse::<i64>().unwrap_or(0) - ry).to_string())
    };
    let dur = (end - start).max(0.01);
    let add = mode == "addition";
    // The layer's straight colour (premultiplied for an add) and its alpha - an add's result is
    // already final wherever the layer covers anything, so its mask is just "covered or not".
    let colour = if add { "format=gbrap,premultiply=inplace=1,format=gbrp" } else { "format=gbrp" };
    let alpha = if add { "alphaextract,lut=c0='if(gt(val,0),255,0)'" } else { "alphaextract" };
    format!(
        "color=c=black@0:s={rw}x{rh}:r={fps:.3}:d={d:.3},format=rgba,setpts=PTS+{start:.4}/TB[{tag}cv];\
         [{tag}cv][{layer}]overlay=x='{lx}':y='{ly}':format=auto:eof_action=pass[{tag}ly];\
         [{tag}ly]split=2[{tag}lc0][{tag}la0];[{tag}lc0]{colour}[{tag}lc];[{tag}la0]{alpha}[{tag}la];\
         [{current}]split=2[{tag}bg][{tag}bd0];\
         [{tag}bd0]trim=start={start:.4}:end={end:.4},crop={rw}:{rh}:{rx}:{ry},format=gbrp[{tag}bd];\
         [{tag}bd][{tag}lc]blend=all_mode={mode}:shortest=1,format=gbrap[{tag}bl];\
         [{tag}bl][{tag}la]alphamerge[{tag}bm];\
         [{tag}bg][{tag}bm]overlay=x={rx}:y={ry}:eof_action=pass:format=auto[{out}];",
        fps = layer.fps,
        d = dur + 0.1,
        layer = layer.label,
    )
}

// ---- Gaussian blur -----------------------------------------------------------------------------
//
// CSS blur(sigma) - what the preview's backdrop-filter draws - as three box blurs whose widths are
// chosen (Kovesi's method) so their combined variance is sigma^2: within 1% of sigma and a few % of
// the Gaussian's shape, and O(1) per pixel at any radius. ffmpeg's gblur was measured first: its
// IIR approximation was 7-77% off the Gaussian depending on `steps`. Chroma is half-resolution in
// 4:2:0, so its planes get sigma/2 - a blur of Y, Cb and Cr is then exactly a blur of RGB.
pub(super) fn box_widths_for_sigma(sigma: f64, passes: usize) -> Vec<i64> {
    let n = passes as f64;
    let ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut wl = ideal.floor() as i64;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wu = wl + 2;
    // How many passes use the narrower box: whichever split lands the combined sigma closest
    // (Kovesi's closed form rounds, which can miss by a few % at small sigmas).
    let sigma_with = |m: usize| (((m as f64) * (wl * wl - 1) as f64 + ((passes - m) as f64) * (wu * wu - 1) as f64) / 12.0).sqrt();
    let m = (0..=passes).min_by(|a, b| (sigma_with(*a) - sigma).abs().total_cmp(&(sigma_with(*b) - sigma).abs())).unwrap_or(passes);
    (0..passes).map(|i| if i < m { wl } else { wu }).collect()
}

// The filter fragment (no leading/trailing comma, "" when there's nothing to blur) blurring a
// `w`x`h` yuv420p stream by `sigma` px. Radii are clamped to what boxblur allows on that size.
pub(super) fn gaussian_blur_chain(sigma: f64, w: i64, h: i64, enable: Option<&str>) -> String {
    if !(sigma > 0.25) {
        return String::new();
    }
    let luma = box_widths_for_sigma(sigma, 3);
    let chroma = box_widths_for_sigma(sigma / 2.0, 3);
    let max_luma = (w.min(h) / 2 - 1).max(0);
    let max_chroma = (((w + 1) / 2).min((h + 1) / 2) / 2 - 1).max(0);
    let enable = enable.map(|e| format!(":enable='{e}'")).unwrap_or_default();
    luma.iter()
        .zip(&chroma)
        .map(|(wl, wc)| (((wl - 1) / 2).min(max_luma), ((wc - 1) / 2).min(max_chroma)))
        .filter(|(rl, rc)| *rl > 0 || *rc > 0)
        .map(|(rl, rc)| format!("boxblur=luma_radius={rl}:luma_power=1:chroma_radius={rc}:chroma_power=1{enable}"))
        .collect::<Vec<_>>()
        .join(",")
}

// One blur region onto [current], writing [out]: its patch of the picture cut out for its own
// window, blurred, shaped by its mask (when it has one) and laid back where it came from.
pub(super) fn blur_region_chain(bv: &OverlayBlur, i: usize, mask_input: Option<usize>, current: &str, out_label: &str) -> String {
    let mut graph = String::new();
    let src_label = format!("bb{}src", i);
    let bg_label = format!("bb{}bg", i);
    // The blurred copy only exists for the region's own window (trim), so nothing is
    // cropped or blurred for the rest of the video.
    graph.push_str(&format!(
        "[{}]split=2[{}][{}];",
        current, bg_label, src_label
    ));
    // Where the region is: fixed, or keyframed (a motion track) - on even pixels either
    // way (4:2:0 chroma crops on even pixels), kept inside the frame, and the same
    // expression for the crop and the overlay so the blurred patch lands where it was cut.
    let (x_expr, y_expr) = match bv.keyframes.as_ref().filter(|k| !k.is_empty()) {
        Some(kfs) => (keyframe_expr(kfs, "t", |k| k.x), keyframe_expr(kfs, "t", |k| k.y)),
        None => (bv.x.to_string(), bv.y.to_string()),
    };
    let crop_x = format!("clip(2*floor(({x_expr})/2),0,iw-ow)");
    let crop_y = format!("clip(2*floor(({y_expr})/2),0,ih-oh)");
    let place_x = format!("clip(2*floor(({x_expr})/2),0,main_w-overlay_w)");
    let place_y = format!("clip(2*floor(({y_expr})/2),0,main_h-overlay_h)");
    // The preview's Gaussian (CSS blur(sigma)); an older frontend sends only intensity,
    // which keeps the boxblur it always had.
    let blur = match bv.sigma {
        Some(sigma) => gaussian_blur_chain(sigma, bv.width, bv.height, None),
        None => {
            let radius = ((bv.intensity.max(0.0).min(1.0)) * (bv.height as f64) * 0.08).round().clamp(1.0, 60.0) as i64;
            format!("boxblur=luma_radius={radius}:luma_power=1:chroma_radius={radius}:chroma_power=1")
        }
    };
    let blur = if blur.is_empty() { "null".to_string() } else { blur };
    let cut = format!(
        "[{src_label}]trim=start={:.4}:end={:.4},crop=w={}:h={}:x='{crop_x}':y='{crop_y}',{blur}",
        bv.start_time, bv.end_time, bv.width, bv.height
    );

    // A plain axis-aligned rectangle needs nothing past the crop+blur - crop already
    // produces exactly that shape. Anything mask-shaped merges the mask PNG's luma in as
    // the blurred patch's alpha (`alphamerge`), so only the shape stays blurred and the
    // rest of the crop shows the original pixels once `overlay` blends by alpha below.
    let composited_label = match mask_input {
        None => {
            let blurred_label = format!("bb{}blur", i);
            graph.push_str(&format!("{cut}[{blurred_label}];"));
            blurred_label
        }
        Some(mask_input) => {
            let cropped_label = format!("bb{}crop", i);
            let mask_gray_label = format!("bb{}maskgray", i);
            let masked_label = format!("bb{}masked", i);
            graph.push_str(&format!("{cut},format=rgba[{cropped_label}];"));
            graph.push_str(&format!(
                "[{}:v]format=gray,setpts=PTS-STARTPTS+{:.4}/TB[{}];",
                mask_input, bv.start_time, mask_gray_label
            ));
            graph.push_str(&format!(
                "[{}][{}]alphamerge[{}];",
                cropped_label, mask_gray_label, masked_label
            ));
            masked_label
        }
    };

    graph.push_str(&format!(
        "[{bg_label}][{composited_label}]overlay=x='{place_x}':y='{place_y}':eof_action=pass[{out_label}];"
    ));
    graph
}

// ---- Adjustment layers -------------------------------------------------------------------------

pub(super) fn css_op_from_spec(spec: &CssOpSpec) -> Option<CssColorOp> {
    let v = spec.value;
    if !v.is_finite() {
        return None;
    }
    Some(match spec.op.as_str() {
        "brightness" => CssColorOp::Brightness(v),
        "contrast" => CssColorOp::Contrast(v),
        "saturate" => CssColorOp::Saturate(v),
        "hue-rotate" => CssColorOp::HueRotate(v),
        "sepia" => CssColorOp::Sepia(v),
        "grayscale" => CssColorOp::Grayscale(v),
        _ => return None,
    })
}

// One adjustment layer onto [current], writing [out]. The adjusted copy is cut to the layer's
// window and box (trim + crop) so nothing outside either is ever processed, then laid back over
// the untouched picture - weighted by its mask, opacity and fades.
#[allow(clippy::too_many_arguments)]
pub(super) fn adjustment_layer_chain(layer: &AdjustmentLayerSpec, mask_input: Option<(usize, i64, i64)>, (fw, fh): (i64, i64), current: &str, tag: &str, out: &str, fps: f64) -> String {
    // The frontend renders the mask on even edges inside the frame (4:2:0 chroma can only be
    // cropped on even pixels); kept that way here whatever arrives, the mask scaled to match.
    let moving = mask_input.is_some() && layer.mask_keyframes.as_ref().is_some_and(|k| !k.is_empty());
    let (rx, ry, rw, rh) = match mask_input {
        // A moving region works on the whole frame, its mask placed afresh every frame.
        Some(_) if moving => (0, 0, fw, fh),
        Some((_, mw, mh)) => {
            let x0 = layer.mask_x.clamp(0, (fw - 2).max(0)) & !1;
            let y0 = layer.mask_y.clamp(0, (fh - 2).max(0)) & !1;
            (x0, y0, (mw.min(fw - x0) & !1).max(2), (mh.min(fh - y0) & !1).max(2))
        }
        None => (0, 0, fw, fh),
    };
    let (start, end) = (layer.start_time, layer.end_time.max(layer.start_time + 0.01));
    let mut fx: Vec<String> = vec![format!("trim=start={start:.4}:end={end:.4}")];
    if mask_input.is_some() && !moving {
        fx.push(format!("crop={rw}:{rh}:{rx}:{ry}"));
    }
    let blur = gaussian_blur_chain(layer.blur_sigma.unwrap_or(0.0), rw, rh, None);
    if !blur.is_empty() {
        fx.push(blur);
    }
    let ops: Vec<CssColorOp> = layer.color_ops.iter().filter_map(css_op_from_spec).collect();
    fx.push("format=rgba".into());
    if !ops.is_empty() {
        let (m, o) = compose_css_color_ops(&ops);
        fx.push(format!(
            "colorchannelmixer=rr={:.6}:rg={:.6}:rb={:.6}:ra={:.6}:gr={:.6}:gg={:.6}:gb={:.6}:ga={:.6}:br={:.6}:bg={:.6}:bb={:.6}:ba={:.6}:aa=1",
            m[0][0], m[0][1], m[0][2], o[0], m[1][0], m[1][1], m[1][2], o[1], m[2][0], m[2][1], m[2][2], o[2]
        ));
    }
    if let Some(hex) = layer.fill.as_deref().map(|c| c.trim().trim_start_matches('#')).and_then(|c| u32::from_str_radix(c, 16).ok()) {
        // Every pixel the colour: no input weights, the colour as the offset (on the alpha column).
        let (r, g, b) = (((hex >> 16) & 255) as f64 / 255.0, ((hex >> 8) & 255) as f64 / 255.0, (hex & 255) as f64 / 255.0);
        fx.push(format!("colorchannelmixer=rr=0:rg=0:rb=0:ra={r:.6}:gr=0:gg=0:gb=0:ga={g:.6}:br=0:bg=0:bb=0:ba={b:.6}:aa=1"));
    }
    let mut graph = format!("[{current}]split=2[{tag}bg][{tag}src];[{tag}src]{}[{tag}a0];", fx.join(","));
    let mut cur = format!("{tag}a0");
    if let Some(v) = layer.vignette.filter(|v| *v > 0.001) {
        // Drawn over the adjusted picture, as the preview's gradient sits on top of its backdrop.
        graph.push_str(&vignette_layer(v, rw, rh, 30.0, &cur, &format!("{tag}a1"), tag));
        graph.push_str(&format!("[{tag}a1]format=rgba[{tag}a2];"));
        cur = format!("{tag}a2");
    }
    if let Some((input, _, _)) = mask_input {
        if moving {
            // The region's mask pasted onto black where the keyframes put it, every frame (the
            // keyframe expressions blur regions use), inverted for a spotlight.
            let kfs = layer.mask_keyframes.as_deref().unwrap_or(&[]);
            let (kx, ky) = (keyframe_expr(kfs, "t", |k| k.x), keyframe_expr(kfs, "t", |k| k.y));
            let negate = if layer.mask_invert { ",negate" } else { "" };
            graph.push_str(&format!(
                "color=c=black:s={fw}x{fh}:r={fps}:d={d:.3},setpts=PTS+{start:.4}/TB,format=yuv420p[{tag}mc];\
                 [{input}:v]format=yuv420p,setpts=PTS-STARTPTS+{start:.4}/TB[{tag}mp];\
                 [{tag}mc][{tag}mp]overlay=x='{kx}':y='{ky}':eof_action=repeat,format=gray{negate}[{tag}mk];[{cur}][{tag}mk]alphamerge[{tag}a3];",
                d = end - start + 0.1
            ));
        } else {
            graph.push_str(&format!(
                "[{input}:v]format=gray,scale={rw}:{rh},setpts=PTS-STARTPTS+{start:.4}/TB[{tag}mk];[{cur}][{tag}mk]alphamerge[{tag}a3];"
            ));
        }
        cur = format!("{tag}a3");
    }
    let mut alpha_ops: Vec<String> = Vec::new();
    let opacity = layer.opacity.clamp(0.0, 1.0);
    if opacity < 0.999 {
        alpha_ops.push(format!("colorchannelmixer=aa={opacity:.4}"));
    }
    let span = end - start;
    let fade_in = layer.fade_in.clamp(0.0, span / 2.0);
    let fade_out = layer.fade_out.clamp(0.0, span / 2.0);
    if fade_in > 0.01 {
        alpha_ops.push(format!("fade=in:st={start:.4}:d={fade_in:.4}:alpha=1"));
    }
    if fade_out > 0.01 {
        alpha_ops.push(format!("fade=out:st={:.4}:d={fade_out:.4}:alpha=1", end - fade_out));
    }
    if !alpha_ops.is_empty() {
        graph.push_str(&format!("[{cur}]{}[{tag}a4];", alpha_ops.join(",")));
        cur = format!("{tag}a4");
    }
    graph.push_str(&format!("[{tag}bg][{cur}]overlay=x={rx}:y={ry}:eof_action=pass:format=auto[{out}];"));
    graph
}

// Per-segment color grade fragment, chained directly onto that segment's own trim step (before
// concat). Formulas are deliberately simple/approximate (not colorimetrically "correct") - a
// quick preset gallery, not a grading tool - and are meant to visually match their CSS-preview
// counterpart (cssFilterForColorPreset, src/utils/videoColorFilters.ts); if one is retuned, retune
// the other so preview and export don't silently drift apart. Empty string (no-op) for
// "none"/unrecognized so callers can unconditionally append the result without an extra branch.
//
// Exactly the preview's look: each preset is the same list of CSS filter functions the preview
// applies (cssFilterForColorPreset), and every one of them is defined by the Filter Effects spec as
// a fixed colour matrix (contrast as an affine scale about 0.5). The list composes into ONE affine
// map, applied in a single colorchannelmixer pass - the offset rides on the alpha column (alpha is
// 255 in rgba, so ra/ga/ba are a per-channel offset). Nothing here is tuned "to look similar": it
// is the same arithmetic the browser does. "vignette" isn't a colour map - see vignette_layer.
pub(super) fn color_filter_chain(cf: &ClipColorFilter) -> String {
    let t = cf.intensity.clamp(0.0, 1.0);
    let ops: Vec<CssColorOp> = match cf.preset.as_str() {
        "vibrant" => vec![CssColorOp::Saturate(1.0 + 0.6 * t), CssColorOp::Contrast(1.0 + 0.15 * t)],
        "cinematic" => vec![
            CssColorOp::Contrast(1.0 + 0.2 * t),
            CssColorOp::Saturate(1.0 - 0.15 * t),
            CssColorOp::Sepia(0.08 * t),
            CssColorOp::HueRotate(-5.0),
        ],
        "bw" => vec![CssColorOp::Grayscale(t)],
        "warm" => vec![CssColorOp::Sepia(0.35 * t), CssColorOp::Saturate(1.0 + 0.1 * t)],
        "cool" => vec![CssColorOp::HueRotate(10.0 * t), CssColorOp::Saturate(1.0 + 0.05 * t)],
        _ => return String::new(),
    };
    let (m, o) = compose_css_color_ops(&ops);
    format!(
        ",format=rgba,colorchannelmixer=rr={:.6}:rg={:.6}:rb={:.6}:ra={:.6}:gr={:.6}:gg={:.6}:gb={:.6}:ga={:.6}:br={:.6}:bg={:.6}:bb={:.6}:ba={:.6}:aa=1,format=yuv420p",
        m[0][0], m[0][1], m[0][2], o[0], m[1][0], m[1][1], m[1][2], o[1], m[2][0], m[2][1], m[2][2], o[2]
    )
}

// One CSS filter function on colour (Filter Effects Module, "filter functions" - their SVG
// feColorMatrix equivalents).
#[derive(Clone, Copy, Debug)]
pub(crate) enum CssColorOp {
    Brightness(f64),
    Grayscale(f64),
    Sepia(f64),
    Saturate(f64),
    HueRotate(f64), // degrees
    Contrast(f64),
}

impl CssColorOp {
    // (matrix, offset) on 0..1 RGB.
    pub(super) fn affine(self) -> ([[f64; 3]; 3], [f64; 3]) {
        match self {
            CssColorOp::Brightness(b) => {
                let b = b.max(0.0);
                ([[b, 0.0, 0.0], [0.0, b, 0.0], [0.0, 0.0, b]], [0.0; 3])
            }
            CssColorOp::Grayscale(a) => {
                let s = 1.0 - a.clamp(0.0, 1.0);
                ([[0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s], [0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s], [0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s]], [0.0; 3])
            }
            CssColorOp::Sepia(a) => {
                let s = 1.0 - a.clamp(0.0, 1.0);
                ([[0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s], [0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s], [0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s]], [0.0; 3])
            }
            CssColorOp::Saturate(s) => {
                let s = s.max(0.0);
                ([[0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s], [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s], [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s]], [0.0; 3])
            }
            CssColorOp::HueRotate(deg) => {
                let (s, c) = deg.to_radians().sin_cos();
                (
                    [
                        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
                        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
                        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
                    ],
                    [0.0; 3],
                )
            }
            CssColorOp::Contrast(c) => {
                let c = c.max(0.0);
                ([[c, 0.0, 0.0], [0.0, c, 0.0], [0.0, 0.0, c]], [0.5 - 0.5 * c; 3])
            }
        }
    }
}

// The filter list applied left to right, as one affine map: x -> M x + o.
pub(crate) fn compose_css_color_ops(ops: &[CssColorOp]) -> ([[f64; 3]; 3], [f64; 3]) {
    let mut m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut o = [0.0; 3];
    for op in ops {
        let (a, b) = op.affine();
        let mut nm = [[0.0; 3]; 3];
        let mut no = [0.0; 3];
        for r in 0..3 {
            for c in 0..3 {
                nm[r][c] = (0..3).map(|k| a[r][k] * m[k][c]).sum();
            }
            no[r] = (0..3).map(|k| a[r][k] * o[k]).sum::<f64>() + b[r];
        }
        m = nm;
        o = no;
    }
    (m, o)
}

// Where a segment's video chain should end, and what follows it: a vignette preset puts its layer
// between the chain and `label` (vignette_layer, over the clip's finished frame as the preview
// draws it); anything else ends straight at `label`.
//
// A clip effect (Clip.fx) goes first, over the clip's picture, with the vignette over it - the order
// the preview's ClipFxLayer draws them in.
pub(super) fn segment_vignette(seg: &KeepSegment, w: Option<i64>, h: Option<i64>, label: &str, i: usize) -> (String, String) {
    let (vig_in, vig_graph) = match (&seg.color_filter, w, h) {
        (Some(cf), Some(w), Some(h)) if cf.preset == "vignette" => {
            let pre = format!("{label}nv");
            (pre.clone(), vignette_layer(cf.intensity, w, h, 30.0, &pre, label, i))
        }
        _ => (label.to_string(), String::new()),
    };
    if let (Some(fx), Some(w), Some(h)) = (&seg.fx, w, h) {
        let pre = format!("{label}fx");
        // Its own length plus room for a transition's tail.
        if let Some(fx_graph) = clip_fx_graph(fx, &pre, &vig_in, (w, h), segment_output_duration(seg) + 2.0, i) {
            return (pre, format!("{fx_graph}{vig_graph}"));
        }
    }
    (vig_in, vig_graph)
}

// The "vignette" preset: the preview's radial-gradient(ellipse at center, transparent s0%,
// rgba(0,0,0,0.6t) 100%) laid over the clip's finished frame (vignetteBackground,
// videoColorFilters.ts) - drawn once, small, scaled up (a smooth gradient loses nothing) and looped
// as a static layer, so it costs one overlay per frame. A graph fragment taking [in] to [out].
pub(super) fn vignette_layer(intensity: f64, w: i64, h: i64, fps: f64, input: &str, out: &str, i: impl std::fmt::Display) -> String {
    let t = intensity.clamp(0.0, 1.0);
    let s0 = (40.0 - 15.0 * t) / 100.0;
    // Distance from the centre on the ellipse through the corners (CSS's default farthest-corner).
    let r = "(hypot(X/W-0.5,Y/H-0.5)*1.414214)";
    let alpha = format!("255*{:.4}*clip(({r}-{s0:.4})/{:.4},0,1)", 0.6 * t, (1.0 - s0).max(1e-3));
    let (lw, lh) = ((w / 4).max(2), (h / 4).max(2));
    format!(
        "color=black:s={lw}x{lh}:d=1:r={fps:.3},format=yuva420p,geq=lum=16:cb=128:cr=128:a='{alpha}',scale={w}:{h}:flags=bilinear,loop=loop=-1:size=1[vig{i}];\
         [{input}][vig{i}]overlay=shortest=1:format=auto[{out}];"
    )
}

// Per-segment Ken Burns fragment - a time-varying `crop` (using ffmpeg's own `t`/`iw`/`ih`/`ow`/
// `oh` expression variables - the same "expression string, not a filter option" idiom the
// enable='between(t,...)' chains elsewhere in this file already rely on), then a fixed `scale=`
// back to the export's own output resolution. The trailing scale is required, not cosmetic:
// concat needs every segment at matching resolution, and a shrinking crop window alone would
// leave this segment's frames smaller than its neighbors'. Chosen over ffmpeg's `zoompan` filter
// deliberately - zoompan's own output-size handling is more version-sensitive across ffmpeg
// builds than crop's plain expression support, and this only needs to spike-test cleanly once.
//
// The window - a zoom and centre (fractions of the frame) over time - is kenBurnsWindow's
// (videoColorFilters.ts) arithmetic exactly, preset for preset. It's drawn with `perspective`
// mapping the window's corners to the frame: per-frame and sub-pixel, so a slow push or a shake
// glides instead of stepping a whole pixel at a time. (crop can't do it: its width/height are
// evaluated once at setup - every zoom used to export frozen at one size.) perspective only knows
// the frame number, so the stream is first held to a constant `fps` (the source's own rate):
// seconds = n / fps, exactly, even for a variable-frame-rate phone video.
pub(super) fn ken_burns_chain(kb: &ClipKenBurns, duration: f64, out_w: i64, out_h: i64, fps: f64) -> String {
    let a = kb.intensity.unwrap_or(0.5).clamp(0.0, 1.0);
    let d = duration.max(0.01);
    let fps = if fps.is_finite() && fps > 0.0 { fps } else { 30.0 };
    let (s0, s1) = match kb.span {
        Some([x, y]) => (x.clamp(0.0, 1.0), y.clamp(0.0, 1.0)),
        None => (0.0, 1.0),
    };
    // p: 0..1 along the whole move; t: seconds along it (a split-off piece continues its clock).
    // perspective's `in` counts frames from 1.
    let p = format!("({s0:.6}+{:.6}*min((in-1)/{fps:.4}/{d:.4},1))", s1 - s0);
    let t = format!("({p}*{:.6})", d / (s1 - s0).max(1e-3));
    let tx = kb.target_x.unwrap_or(0.5).clamp(0.0, 1.0);
    let ty = kb.target_y.unwrap_or(0.5).clamp(0.0, 1.0);
    let tau = std::f64::consts::TAU;
    let wobble = |f: f64, ph: f64| {
        format!(
            "(0.5*sin({:.6}*{t}+{ph})+0.3*sin({:.6}*{t}+{:.4})+0.2*sin({:.6}*{t}+{:.4}))",
            tau * 1.1 * f,
            tau * 2.3 * f,
            1.3 + ph,
            tau * 4.7 * f,
            2.1 + ph
        )
    };
    // (zoom, centre x, centre y) as expressions.
    let (z, cx, cy): (String, String, String) = match kb.preset.as_str() {
        "zoom-in" => (format!("(1+{:.4}*{p})", 0.3 * a), tx.to_string(), ty.to_string()),
        "zoom-out" => (format!("({:.4}-{:.4}*{p})", 1.0 + 0.3 * a, 0.3 * a), tx.to_string(), ty.to_string()),
        "pan-left" | "pan-right" | "pan-up" | "pan-down" => {
            let z = 1.0 + 0.15 * a;
            let dir = if matches!(kb.preset.as_str(), "pan-right" | "pan-down") { p.clone() } else { format!("(1-{p})") };
            let along = format!("({:.6}*{dir}+{:.6})", 1.0 - 1.0 / z, 1.0 / (2.0 * z));
            if kb.preset.starts_with("pan-l") || kb.preset.starts_with("pan-r") {
                (format!("{z:.4}"), along, "0.5".into())
            } else {
                (format!("{z:.4}"), "0.5".into(), along)
            }
        }
        "push" => (format!("(1+{:.4}*{p}*{p}*(3-2*{p}))", 0.3 * a), tx.to_string(), ty.to_string()),
        "punch-in" => {
            let c = format!("(clip({t}/0.35,0,1)-1)");
            (format!("(1+{:.4}*(1+2.70158*pow({c},3)+1.70158*pow({c},2)))", 0.4 * a), tx.to_string(), ty.to_string())
        }
        "bounce-in" => {
            let c = format!("clip({t}/1.2,0,1)");
            (format!("(1+{:.4}*(1-exp(-6*{c})*cos({:.6}*{c})))", 0.3 * a, 3.0 * tau), tx.to_string(), ty.to_string())
        }
        "drift" => {
            let z = 1.0 + 0.2 * a;
            let along = format!("({:.6}+{:.6}*{p})", 1.0 / (2.0 * z), 1.0 - 1.0 / z);
            (format!("{z:.4}"), along.clone(), along)
        }
        "sway" => {
            let z = 1.0 + 0.12 * a;
            (format!("{z:.4}"), format!("(0.5+{:.6}*sin({:.6}*{t}))", 0.48 * (1.0 - 1.0 / z), tau / 2.5), "0.5".into())
        }
        "float" => {
            let z = 1.0 + 0.14 * a;
            let r = 0.45 * (1.0 - 1.0 / z);
            (format!("{z:.4}"), format!("(0.5+{r:.6}*cos({:.6}*{t}))", tau / 4.0), format!("(0.5+{r:.6}*sin({:.6}*{t}))", tau / 4.0))
        }
        "breathe" => (format!("(1+{:.4}*(0.5-0.5*cos({:.6}*{t})))", 0.12 * a, tau / 3.0), tx.to_string(), ty.to_string()),
        "pulse" => (format!("(1+{:.4}*pow(0.5+0.5*cos({:.6}*{t}),6))", 0.1 * a, tau / 0.5), tx.to_string(), ty.to_string()),
        "shake" | "vibrate" => {
            let fast = kb.preset == "vibrate";
            let z = 1.0 + if fast { 0.02 + 0.04 * a } else { 0.03 + 0.07 * a };
            let m = 0.45 * (1.0 - 1.0 / z);
            let f = if fast { KB_VIBRATE_RATE } else { 1.0 };
            (format!("{z:.4}"), format!("(0.5+{m:.6}*{})", wobble(f, 0.0)), format!("(0.5+{m:.6}*{})", wobble(f, 4.1)))
        }
        _ => return String::new(),
    };
    // The window kept fully on the frame, then its corners (source pixels) sent to the frame's.
    // Floored at 1: zoom-out lands on 1.15-0.15*1 = 0.9999999999999999 once a transition tail runs
    // it to its end, and a half-width past 0.5 makes clip() below NaN - perspective then fails the
    // whole export with a bare "Invalid argument".
    let half = format!("(0.5/max({z},1))");
    let cx = format!("clip({cx},{half},1-{half})");
    let cy = format!("clip({cy},{half},1-{half})");
    let (l, r) = (format!("(({cx})-{half})*W"), format!("(({cx})+{half})*W"));
    let (top, bot) = (format!("(({cy})-{half})*H"), format!("(({cy})+{half})*H"));
    format!(
        ",fps={fps:.4},perspective=x0='{l}':y0='{top}':x1='{r}':y1='{top}':x2='{l}':y2='{bot}':x3='{r}':y3='{bot}':interpolation=cubic:sense=source:eval=frame,scale={out_w}:{out_h}"
    )
}

// How much faster "vibrate"'s wobble runs than "shake"'s - KB_VIBRATE_RATE in videoColorFilters.ts.
pub(super) const KB_VIBRATE_RATE: f64 = 5.0;

// Per-segment crop fragment - a static (non-time-varying) version of ken_burns_chain's own crop
// idiom, generalized to independent width/height: crop a free-form window out of the frame.
// Deliberately does NOT scale back to the export's own output resolution itself - unlike
// ken_burns_chain, whose own trailing `scale` is the only one that will ever run for that segment.
// segment_effect_chain below appends `scale=out_w:out_h` itself, but only when Ken Burns isn't ALSO
// set on the same segment: when it is, its own crop+scale runs immediately after this one and
// already ends in that exact scale, so adding a second one here would resample the frame twice for
// the same final pixels - wasted encode time and a marginally softer image from the extra
// resampling pass. Ken Burns' own crop math is proportional (iw/ih-relative) regardless of what
// this crop left iw/ih at, so skipping the scale here doesn't change what it produces. width/height
// are clamped away from 0 to avoid a degenerate near-zero-area crop, and x/y are clamped so the
// window can never crop past its own edge. The STRETCH (no force_original_aspect_ratio) that
// whichever trailing scale ends up running still applies - deliberate, see ClipCrop's own doc
// comment for why (letterboxing/padding was the alternative, not chosen).
pub(super) fn crop_chain(c: &ClipCrop) -> String {
    let width = c.width.max(0.05).min(1.0);
    let height = c.height.max(0.05).min(1.0);
    let x = c.x.max(0.0).min(1.0 - width);
    let y = c.y.max(0.0).min(1.0 - height);
    format!(",crop=w='iw*{width:.4}':h='ih*{height:.4}':x='iw*{x:.4}':y='ih*{y:.4}'")
}

// One extra filter-string fragment for a segment's color grade + crop + Ken Burns, ready to
// append right after that segment's own `setpts=PTS-STARTPTS` in its trim step - the single call
// site both the single-segment and multi-segment branches below share, so the two branches can't
// drift apart on how a segment's effects get spliced in. Crop is applied before Ken Burns (not
// after) so Ken Burns' own zoom/pan animates within the already-cropped window, matching the live
// preview's own composition order (VideoPlayer.tsx). Whichever of crop/Ken Burns runs LAST is what
// actually rescales back to out_w:out_h - concat needs every segment at matching dimensions
// regardless of which effects it has, so at least one of them always has to; see crop_chain's own
// doc comment for why that's never both.
// This segment's own playback-speed multiplier, clamped defensively to the same 0.25..16 range the
// clip-effects UI itself offers (SpeedPopover's MIN_SPEED/MAX_SPEED) - a value outside that
// couldn't have come from that slider, but clamping here (rather than trusting it) means a stale/
// hand-edited sidecar can't push the setpts/atempo math into something degenerate.
pub(super) fn segment_speed(seg: &KeepSegment) -> f64 {
    seg.speed.unwrap_or(1.0).max(0.25).min(16.0)
}

// This segment's own noise-reduction strength (0..1, clamped defensively same as segment_speed's
// own comment explains) mapped to just afftdn's `nr` parameter half of noise_reduction_afftdn_params
// - kept as its own function since it's the half segment_needs_filter_graph and the existing test
// suite already key off of (an (nr, nf) tuple would make ".is_some()" checks awkward for no
// benefit). See noise_reduction_afftdn_params for the actual mapping and why `nf` matters just as
// much as `nr` does.
pub(super) fn segment_noise_reduction_db(seg: &KeepSegment) -> Option<f64> {
    segment_noise_reduction_params(seg).map(|(nr, _nf)| nr)
}

pub(super) fn segment_noise_reduction_params(seg: &KeepSegment) -> Option<(f64, f64)> {
    noise_reduction_afftdn_params(seg.noise_reduction)
}

// The actual 0..1 -> afftdn (nr, nf) mapping, pulled out standalone (raw strength, not a
// KeepSegment) so extract_clip_audio - which has no KeepSegment of its own - can share it too.
//
// nr (0.01..97dB, "how much to reduce") is the obvious half and was the only one this used to set,
// clamped to a gentler 4..40 subrange since anything past ~40dB starts eating into the wanted
// signal along with the noise for typical screen-recording mic input.
//
// nf (-80..-20dB, "how loud something has to be to NOT count as noise") turned out to matter just
// as much: afftdn's own default (-50dB) assumes real noise sits far below the wanted signal, which
// holds for light tape hiss but not for the kind of background noise a screen recording's mic
// actually picks up (fans, room tone, distant machinery) - that can sit only 15-25dB below speech,
// well above -50dB, so afftdn quietly left it almost untouched regardless of how high `nr` was
// pushed. Verified against synthetic noise+tone fixtures: nr alone (default nf=-50) measured
// <0.1dB of RMS reduction even at nr=40, while pairing it with nf up to afftdn's own most
// aggressive allowed value (-20) measured several dB - see this repo's run-briefcast skill session
// notes for the numbers. None/0 strength returns None (no filter at all) rather than
// "afftdn=nr=4:nf=-50" - keeps a clip that's never touched this feature byte-for-byte identical to
// before it existed, and skips an unnecessary filter stage in the common case.
pub(super) fn noise_reduction_afftdn_params(strength: Option<f64>) -> Option<(f64, f64)> {
    let strength = strength.unwrap_or(0.0).max(0.0).min(1.0);
    if strength <= 0.0 {
        None
    } else {
        let nr = 4.0 + strength * 36.0; // 4..40dB
        let nf = -50.0 + strength * 30.0; // -50..-20dB
        Some((nr, nf))
    }
}

// Whether this segment needs export_trimmed_video's full filter-graph path rather than its fast
// `-ss`/`-to` passthrough - true for any per-segment effect that path has nowhere to apply. Pulled
// out of export_trimmed_video itself (rather than an inline closure) so this decision is unit-
// testable without spawning ffmpeg - see this file's own test module. noise_reduction belongs here
// exactly like speed/crop/etc: omitting it once meant a single-segment timeline with ONLY noise
// reduction turned on silently took the effect-free fast path and never got afftdn applied at all.
// The full audio-cleanup chain for one clip, in the same order the live preview's Web Audio graph
// runs it (VideoPlayer.tsx): low-cut -> hum notches -> denoise -> gate. Empty when nothing is on,
// so an untouched clip's filter graph stays byte-for-byte what it was before this existed.
// `rnnoise_model` is the already filtergraph-escaped path of the bundled arnndn model (see
// escape_filter_path); "remove" mode falls back to afftdn if it's missing rather than failing the
// whole export.
//
// `sample_secs` is set when the caller has prepended a noise sample of that length to the stream
// (see audio_branch / cleanup_noise_sample): afftdn learns its profile from exactly that prefix via
// asendcmd, and the prefix is trimmed off again right after the denoiser.
pub(super) const ARNNDN_NAN_GUARD: &str = "aeval=if(isnan(val(0))\\,0\\,val(0)):c=same";

pub(super) fn audio_cleanup_filters(strength: Option<f64>, cleanup: Option<&AudioCleanup>, rnnoise_model: Option<&str>) -> Vec<String> {
    audio_cleanup_filters_with_sample(strength, cleanup, rnnoise_model, None)
}

pub(super) fn audio_cleanup_filters_with_sample(
    strength: Option<f64>,
    cleanup: Option<&AudioCleanup>,
    rnnoise_model: Option<&str>,
    sample_secs: Option<f64>,
) -> Vec<String> {
    let mut filters = Vec::new();
    let cleanup = cleanup.cloned().unwrap_or_default();
    if cleanup.low_cut.unwrap_or(false) {
        filters.push("highpass=f=80".to_string());
    }
    if let Some(hz) = cleanup.hum.filter(|hz| *hz == 50 || *hz == 60) {
        // Fundamental plus the next two harmonics - mains hum is rarely a pure sine. Narrow (Q=8)
        // so voice energy right next to each notch survives.
        for harmonic in 1..=3 {
            filters.push(format!("bandreject=f={}:t=q:w=8", hz * harmonic));
        }
    }
    let wants_remove = cleanup.mode.as_deref() == Some("remove");
    match (wants_remove, rnnoise_model) {
        (true, Some(model)) => {
            let strength = strength.unwrap_or(0.0).max(0.0).min(1.0);
            if strength > 0.0 {
                // mix: 1 = fully denoised, lower blends the original back in (sample-aligned).
                filters.push(format!("arnndn=m='{}':mix={:.2}", model, strength));
                // arnndn's last frame comes out as NaN (any ffmpeg build tried, any input), and the
                // stages after it - speechnorm above all - never return once one reaches them: a
                // "Remove" clean-up or "Make it sound pro" sat at a fixed percentage forever on
                // clips of every length. Zeroing the NaN costs nothing audible (it's the final
                // 10 ms) and lets the chain finish.
                filters.push(ARNNDN_NAN_GUARD.to_string());
            }
        }
        _ => {
            if let Some((nr, nf)) = noise_reduction_afftdn_params(strength) {
                match sample_secs {
                    Some(secs) => {
                        // With a real noise profile the floor needn't be pushed as far: measured
                        // on a noisy field recording, nf=-20 cost ~6dB of speech while -28 cost
                        // ~2.5dB for nearly the same noise removal.
                        let s = strength.unwrap_or(0.0).max(0.0).min(1.0);
                        let nf = -44.0 + 16.0 * s;
                        filters.push(format!(
                            "asendcmd=c='0.000 afftdn sample_noise start;{:.3} afftdn sample_noise stop'",
                            (secs - 0.001).max(0.0)
                        ));
                        filters.push(format!("afftdn=nr={:.2}:nf={:.1}", nr, nf));
                        filters.push(format!("atrim=start={:.6}", secs));
                        filters.push("asetpts=PTS-STARTPTS".to_string());
                    }
                    None => filters.push(format!("afftdn=nr={:.2}:nf={:.1}", nr, nf)),
                }
            }
        }
    }
    if cleanup.gate.unwrap_or(false) {
        // Gentle downward expander rather than a hard gate: ~-24dB of reduction (range) below the
        // threshold, slow release so word tails aren't chopped.
        filters.push("agate=threshold=0.015:ratio=3:attack=5:release=250:range=0.06".to_string());
    }
    if cleanup.level.unwrap_or(false) {
        // speechnorm evens out speaker-to-speaker level (bounded expansion so pauses aren't pumped
        // up into noise), then loudnorm lands the result on -16 LUFS with -1.5dBTP headroom. loudnorm
        // runs internally at 192kHz, hence the resample back.
        filters.push("speechnorm=e=4:r=0.0001:l=1".to_string());
        filters.push("loudnorm=I=-16:TP=-1.5:LRA=11".to_string());
        filters.push("aresample=48000".to_string());
    }
    filters
}

// The noise sample range to prepend, when one applies: only for the afftdn path ("reduce" mode,
// or "remove" falling back without a model), only with the denoiser actually on, and clamped to
// a sane length. None means "no prefix" - callers then use the plain single-branch graph.
pub(super) fn cleanup_noise_sample(strength: Option<f64>, cleanup: Option<&AudioCleanup>, rnnoise_model: Option<&str>) -> Option<(f64, f64)> {
    let cleanup = cleanup?;
    if strength.unwrap_or(0.0) <= 0.0 {
        return None;
    }
    if cleanup.mode.as_deref() == Some("remove") && rnnoise_model.is_some() {
        return None;
    }
    let sample = cleanup.noise_sample?;
    let start = sample.start.max(0.0);
    let end = sample.end.min(start + MAX_NOISE_SAMPLE_SECS);
    if !(start.is_finite() && end.is_finite()) || end - start < 0.1 {
        return None;
    }
    // Rounded to the same 3 decimals atrim gets, so the trim-off after afftdn removes exactly the
    // prefix that was prepended.
    let r = |x: f64| (x * 1000.0).round() / 1000.0;
    Some((r(start), r(end)))
}

// One clip's audio branch from `input_label` (e.g. "[2:a]") to `[out_label]`: trim to
// [start,end), speed, then the cleanup chain. With a noise sample, the input is split, the sample
// range is cut out and concatenated IN FRONT of the clip so afftdn can learn from it, and the
// cleanup chain's own atrim (audio_cleanup_filters_with_sample) drops it again - the profile then
// applies to the whole clip from its first sample, unlike learning mid-stream.
pub(super) fn audio_branch(
    input_label: &str,
    start: f64,
    end: f64,
    speed: f64,
    filters: &[String],
    noise_sample: Option<(f64, f64)>,
    out_label: &str,
) -> String {
    let chain: String = filters.iter().map(|f| format!(",{}", f)).collect();
    match noise_sample {
        None => format!(
            "{input}atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS,{tempo}{chain}[{out}];",
            input = input_label, tempo = atempo_chain(speed), out = out_label
        ),
        Some((ss, se)) => format!(
            "{input}asplit=2[{out}_m][{out}_s];\
             [{out}_s]atrim=start={ss:.3}:end={se:.3},asetpts=PTS-STARTPTS[{out}_n];\
             [{out}_m]atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS,{tempo}[{out}_t];\
             [{out}_n][{out}_t]concat=n=2:v=0:a=1{chain}[{out}];",
            input = input_label, tempo = atempo_chain(speed), out = out_label
        ),
    }
}

// (filters, noise sample) for one segment - the pair audio_trim_chain needs.
pub(super) fn segment_cleanup(seg: &KeepSegment, rnnoise_model: Option<&str>) -> (Vec<String>, Option<(f64, f64)>) {
    let sample = cleanup_noise_sample(seg.noise_reduction, seg.audio_cleanup.as_ref(), rnnoise_model);
    let filters = audio_cleanup_filters_with_sample(
        seg.noise_reduction,
        seg.audio_cleanup.as_ref(),
        rnnoise_model,
        sample.map(|(s, e)| e - s),
    );
    (filters, sample)
}

pub(super) fn segment_audio_cleanup_filters(seg: &KeepSegment, rnnoise_model: Option<&str>) -> Vec<String> {
    audio_cleanup_filters(seg.noise_reduction, seg.audio_cleanup.as_ref(), rnnoise_model)
}

// A path as a filter option value inside single quotes: forward slashes, and the drive colon
// escaped for the option parser (the quotes protect it at the filtergraph level) - checked against
// the bundled ffmpeg with `arnndn=m='C\:/.../bd.rnnn'`. Quotes are dropped since they can't be
// escaped inside a quoted value.
pub(super) fn escape_filter_path(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/").replace(':', "\\:").replace('\'', "")
}

pub(super) fn lowercase_extension(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default()
}

// Still images a timeline clip can be built from (the editor's image clips - see Clip's own doc
// comment, videoEditTypes.ts). Mirrors IMAGE_CLIP_EXTENSIONS there. EXIF orientation needs no
// handling of its own: ffmpeg auto-rotates image inputs by it, in -vf and -filter_complex alike.
pub(crate) fn is_still_image_path(path: &str) -> bool {
    matches!(
        lowercase_extension(path).as_str(),
        "png" | "jpg" | "jpeg" | "bmp" | "tif" | "tiff" | "webp" | "gif" | "heic" | "heif"
    )
}

// HEIC/HEIF stills (iPhone's default) - the bundled ffmpeg's HEIF tile-grid decoding is unreliable
// (see get_heic_preview), so these never reach ffmpeg directly: still_image_source swaps in the
// same cached, correctly decoded PNG the image viewer already shows.
pub(super) fn is_heic_path(path: &str) -> bool {
    matches!(lowercase_extension(path).as_str(), "heic" | "heif")
}

// The file ffmpeg should actually read for an image clip - the image itself, or for HEIC/HEIF its
// decoded PNG (generated once, then a cache hit).
pub(super) async fn still_image_source(app_handle: &AppHandle, window: &Window, state: &ConversionState, path: &str) -> Result<String, String> {
    if !is_heic_path(path) {
        return Ok(path.to_string());
    }
    heic_preview(app_handle.clone(), window.clone(), state, path.to_string()).await
}

// Frame rate every image segment is looped at (`-loop 1 -framerate`) - there's no source rate to
// inherit from a still, and 30 matches probe_frame_rate's own fallback.
pub(super) const IMAGE_SEGMENT_FPS: f64 = 30.0;

// Fits a segment's frames into the shared out_w:out_h output frame (letterboxed, never stretched)
// before any of its own effects run - needed whenever segments can differ in size, since concat/
// xfade both reject inputs of different dimensions. Image clips always need it (a photo is almost
// never exactly the output size); same-size video segments pass through scale untouched. The
// preview's own image proxy (get_image_clip_proxy) applies this exact scale+pad, which is what
// keeps crop/Ken Burns/overlay positions on an image clip identical between preview and export.
pub(super) fn frame_fit_chain(out_w: i64, out_h: i64, is_image: bool) -> String {
    format!(
        ",scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1{fmt}",
        w = out_w,
        h = out_h,
        fmt = if is_image { ",format=yuv420p" } else { "" }
    )
}

// frame_fit_chain over a blurred, zoomed, slightly darkened copy of the picture instead of black
// bars - the canvas's "Blur" background, the look of OutputFrame's "fit-blur" (reframe_chain),
// blurred at a quarter of the size (the same softness for a sixteenth of the work). It branches, so
// `tag` keeps one segment's labels apart from another's.
pub(super) fn frame_fit_blur_chain(out_w: i64, out_h: i64, is_image: bool, tag: &str) -> String {
    let (bw, bh) = (((out_w / 4) / 2 * 2).max(2), ((out_h / 4) / 2 * 2).max(2));
    format!(
        ",split=2[{tag}b][{tag}f];         [{tag}b]scale={bw}:{bh}:force_original_aspect_ratio=increase,crop={bw}:{bh},boxblur=luma_radius=10:luma_power=2,eq=brightness=-0.06,scale={w}:{h},setsar=1[{tag}bg];         [{tag}f]scale={w}:{h}:force_original_aspect_ratio=decrease,setsar=1[{tag}fg];         [{tag}bg][{tag}fg]overlay=(W-w)/2:(H-h)/2,setsar=1{fmt}",
        w = out_w,
        h = out_h,
        fmt = if is_image { ",format=yuv420p" } else { "" }
    )
}

pub(super) fn segment_needs_filter_graph(seg: &KeepSegment) -> bool {
    is_still_image_path(&seg.source_path) || seg.lut_cube.is_some() || seg.stabilize.is_some() || seg.color_filter
        .as_ref()
        .map_or(false, |cf| cf.preset != "none")
        || seg.ken_burns.is_some()
        || seg.transition_in.is_some()
        || seg.crop.is_some()
        || seg.flip_horizontal.unwrap_or(false)
        || (segment_speed(seg) - 1.0).abs() > 0.001
        || seg.speed_steps.as_ref().map_or(false, |s| !s.is_empty())
        || segment_noise_reduction_db(seg).is_some()
        || !segment_audio_cleanup_filters(seg, None).is_empty()
        || seg.muted.unwrap_or(false)
        || has_pointer_layers(seg)
        || seg.fx.as_ref().is_some_and(|fx| fx.intensity > 0.0)
}

// Decomposes an arbitrary speed factor into a chain of ffmpeg `atempo` filters, each within the
// single-instance range libavfilter enforces (0.5..2.0) - `atempo=4.0` alone is rejected outright
// at that value, so a larger speed-up/slow-down needs several chained instances instead (e.g. 4x
// is two atempo=2.0 stages back to back). segment_speed's own 0.25..4 clamp never actually needs
// more than two stages, but this loop isn't hardcoded to that in case that range ever widens.
pub(super) fn atempo_chain(speed: f64) -> String {
    let mut remaining = speed.max(0.05);
    let mut stages: Vec<f64> = Vec::new();
    while remaining > 2.0 {
        stages.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        stages.push(0.5);
        remaining /= 0.5;
    }
    stages.push(remaining);
    stages
        .iter()
        .map(|s| format!("atempo={:.4}", s))
        .collect::<Vec<_>>()
        .join(",")
}

// `pointer`: the clip's editor-drawn pointer (pointer_fragment), laid on after the clip's look and
// before any change of geometry - the preview draws the pointer over the graded picture, at the
// source position, moved and zoomed along with crop / Ken Burns / mirror. Fitting and mirroring then
// follow the colour stages instead of preceding them (per-pixel colour maps don't care), only for
// such a clip; every other clip keeps its exact chain.
pub(super) fn segment_effect_chain(seg: &KeepSegment, out_w: Option<i64>, out_h: Option<i64>, fit_frame: bool, lut_path: Option<&str>, stab_path: Option<&str>, pointer: Option<&str>) -> String {
    let mut extra = String::new();
    // Stabilization first, on the clip's own frames exactly as pass 1 analysed them.
    if let (Some(path), Some(stab)) = (stab_path, &seg.stabilize) {
        extra.push_str(&stabilize_chain(path, stab.strength));
    }
    let fit_and_flip = |extra: &mut String| {
        if let (true, Some(w), Some(h)) = (fit_frame, out_w, out_h) {
            match seg.fit_blur {
                Some(i) => extra.push_str(&frame_fit_blur_chain(w, h, is_still_image_path(&seg.source_path), &format!("fb{i}"))),
                None => extra.push_str(&frame_fit_chain(w, h, is_still_image_path(&seg.source_path))),
            }
        }
        if seg.flip_horizontal.unwrap_or(false) {
            extra.push_str(",hflip");
        }
    };
    if pointer.is_none() && !seg.prefitted {
        fit_and_flip(&mut extra);
    }
    // The grade, then the colour preset - the preview's order: GradeCanvas draws the graded frame
    // and the preset's CSS filter applies on top of it (colour maps don't commute, so the order is
    // part of matching it).
    if let Some(path) = lut_path {
        extra.push_str(&format!(",lut3d=file='{}':interp=trilinear", path));
    }
    if let Some(cf) = &seg.color_filter {
        if cf.preset == "vignette" && (out_w.is_none() || out_h.is_none()) {
            // No frame size to draw the exact layer at (segment_vignette) - ffmpeg's own falloff.
            extra.push_str(&format!(",vignette=angle=PI/{:.3}", (6.0 - 4.0 * cf.intensity.clamp(0.0, 1.0)).max(2.2)));
        } else if cf.preset != "none" {
            extra.push_str(&color_filter_chain(cf));
        }
    }
    if let Some(fragment) = pointer {
        extra.push_str(fragment);
        fit_and_flip(&mut extra);
    }
    if let (Some(crop), Some(w), Some(h)) = (&seg.crop, out_w, out_h) {
        extra.push_str(&crop_chain(crop));
        if seg.ken_burns.is_none() {
            extra.push_str(&format!(",scale={w}:{h}"));
        }
    }
    if let (Some(kb), Some(w), Some(h)) = (&seg.ken_burns, out_w, out_h) {
        // Over the clip's SOURCE duration: this chain runs before the segment's speed change
        // (segment_video_chain), so `t` here is source time - the same progress the preview uses
        // (source-time fraction, VideoPlayer.tsx), and the same for a speed ramp as for a constant
        // speed.
        extra.push_str(&ken_burns_chain(kb, seg.end - seg.start, w, h, seg.source_fps.unwrap_or(30.0)));
    }
    // A crop rescaled back to the frame stretches its pixels unless its shape was the frame's -
    // square them again, or concat refuses to join this clip to the next (SAR mismatch).
    if seg.crop.is_some() && out_w.is_some() && out_h.is_some() {
        extra.push_str(",setsar=1");
    }
    extra
}

// A still's picture as a stream: the photo decoded ONCE (a plain single-frame input), fitted into
// the frame once when `seg.prefitted` (its fit + mirror, which segment_effect_chain then leaves out),
// and that one frame repeated at IMAGE_SEGMENT_FPS for `seconds` - [img{i}], which the segment's
// chain reads in place of [{i}:v]. `-loop 1` on the input instead decoded and rescaled the full-size
// photo for every single output frame: a 12 MP phone photo is ~50 ms to decode and as much again to
// scale (and its blurred backdrop more), thirty times a second of the clip. Frame timestamps are
// exactly the looped input's (n / fps), so Ken Burns and every trim land on the same frames.
pub(super) fn still_image_input_chain(i: usize, seg: &KeepSegment, out_w: Option<i64>, out_h: Option<i64>, seconds: f64) -> String {
    let frames = (seconds * IMAGE_SEGMENT_FPS).ceil().max(1.0) as i64;
    let mut fit = String::new();
    if seg.prefitted {
        if let (Some(w), Some(h)) = (out_w, out_h) {
            match seg.fit_blur {
                Some(k) => fit.push_str(&frame_fit_blur_chain(w, h, true, &format!("fb{k}"))),
                None => fit.push_str(&frame_fit_chain(w, h, true)),
            }
        }
        if seg.flip_horizontal.unwrap_or(false) {
            fit.push_str(",hflip");
        }
    }
    format!(
        "[{i}:v]null{fit},loop=loop={}:size=1:start=0,setpts=N/({fps:.3}*TB)[img{i}];",
        frames - 1,
        fps = IMAGE_SEGMENT_FPS
    )
}

// Where a segment's picture comes from in the graph: its input, or a still's repeated frame.
pub(super) fn segment_input_label(i: usize, seg: &KeepSegment) -> String {
    if is_still_image_path(&seg.source_path) { format!("[img{i}]") } else { format!("[{i}:v]") }
}

// One left-to-right fold step joining segment `i` ([v{i}]/[a{i}]) onto everything folded so far
// ([cur_v]/[cur_a], `accumulated` seconds long). Returns the filter text and the new labels.
//
// A transition plays over the START of the incoming clip, from the outgoing clip still PLAYING
// past its out-point - its tail handle ([old{i}], transition_tail), drawn over the incoming clip's
// first `d` seconds exactly the way the live preview draws it (renderTransitionFrame,
// transitionFrame.ts, over TransitionPreviewLayer). The incoming clip simply follows the outgoing
// one, so a transition never eats into either clip and the output is exactly the sum of the
// clips' own lengths - the same timeline the editor shows, which is what keeps text/image overlays
// and captions (all timed on that timeline) in sync. Audio simply cuts (concat): the tail is
// picture only, so no cut-away sound returns and no clip's sound gets shortened.
//
// `frame` is the output size every segment has been fitted to; without one (it couldn't be
// determined) only size-independent drawing is possible, so every transition becomes a crossfade.
#[allow(clippy::too_many_arguments)]
pub(super) fn transition_fold_step(
    cur_v: &str,
    cur_a: &str,
    i: usize,
    accumulated: f64,
    seg_dur: f64,
    fps: f64,
    frame: Option<(i64, i64)>,
    transition: Option<(&str, f64)>,
    look: Option<&TransitionLook>,
) -> (String, String, String) {
    let next_v = format!("fold{}v", i);
    let next_a = format!("fold{}a", i);
    let step = match transition {
        Some((name, duration)) => {
            // At most 90% of the incoming clip - it plays entirely over that clip's own start.
            let d = duration.min(seg_dur * 0.9).max(0.05);
            let _ = accumulated;
            let default_look = TransitionLook::default();
            let look = look.unwrap_or(&default_look);
            let name = if frame.is_some() { name } else { "fade" };
            let body = transition_window_graph(name, i, d, fps, frame.unwrap_or((2, 2)), look);
            // The incoming clip's first `d` seconds ([head{i}]) get the transition drawn over
            // them; the rest ([rest{i}]) follows untouched. The join is pinned back to the
            // timeline's frame rate: setpts leaves [rest{i}]'s unknown, and an unknown rate reaches
            // the encoder as its 25fps default - silently dropping frames from 30/60fps footage.
            format!(
                "[v{i}]split[vh{i}][vr{i}];[vh{i}]trim=end={d:.6}[head{i}];[vr{i}]trim=start={d:.6},setpts=PTS-STARTPTS,fps={fps:.3}[rest{i}];\
                 {body}\
                 [{cur_v}][tr{i}][rest{i}]concat=n=3:v=1:a=0,fps={fps:.3},settb=AVTB[{next_v}];[{cur_a}][a{i}]concat=n=2:v=0:a=1[{next_a}];"
            )
        }
        None => format!("[{cur_v}][{cur_a}][v{i}][a{i}]concat=n=2:v=1:a=1[{next_v}][{next_a}];"),
    };
    (step, next_v, next_a)
}

// The video's intro and outro: a transition in from black over its first seconds and out to black
// over its last (videoEditTypes.ts's EdgeTransitions). They belong to the video, not to a clip, so
// they stay at its edges whatever the clip order - and a single clip can have them.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EdgeTransitions {
    #[serde(default)]
    pub intro: Option<ClipTransitionIn>,
    #[serde(default)]
    pub outro: Option<ClipTransitionIn>,
}

// Label suffixes for the edge transitions' windows, apart from every segment index (the fold's
// windows use the incoming segment's index, transition_window_graph suffixes everything with it).
pub(super) const EDGE_INTRO_TAG: usize = 1_000_000;
pub(super) const EDGE_OUTRO_TAG: usize = 1_000_001;

// Each edge's window in seconds, from a video `total` seconds long: unset or non-positive is none.
// Alone, an edge takes at most 90% of the video (a clip transition's clamp); with both, 45% each,
// so they never overlap. Mirrored by edgeTransitionWindows (videoEditTypes.ts) for the preview.
pub(super) fn edge_windows(edges: &EdgeTransitions, total: f64) -> (Option<f64>, Option<f64>) {
    let want = |t: &Option<ClipTransitionIn>| t.as_ref().map(|t| t.duration).filter(|d| d.is_finite() && *d > 0.0);
    let (intro, outro) = (want(&edges.intro), want(&edges.outro));
    let share = if intro.is_some() && outro.is_some() { 0.45 } else { 0.9 };
    let fit = |d: f64| d.min(total * share).max(0.05);
    (intro.map(fit), outro.map(fit))
}

// Draws the intro and outro onto `[src]` - the whole assembled video, `total` output seconds, at
// `fps` and fitted to w x h - into `[out]`. Black is the other picture: the intro is a transition
// FROM black into the video's first `d` seconds, the outro one FROM its last `d` seconds into black.
// Both go through transition_window_graph exactly as a cut between clips does, so every transition
// and look works at the edges too, and the video's length never changes. Picture only - the sound
// plays as it is, as at a cut.
pub(super) fn edge_transition_graph(src: &str, out: &str, edges: &EdgeTransitions, total: f64, fps: f64, (w, h): (i64, i64)) -> String {
    let (intro_d, outro_d) = edge_windows(edges, total);
    let black = |label: String, d: f64| format!("color=c=black:s={w}x{h}:r={fps:.3}:d={d:.6},format=yuv420p,settb=AVTB,setsar=1[{label}];");
    let window = |tr: &ClipTransitionIn, k: usize, d: f64| {
        let look = tr.look.clone().unwrap_or_default();
        transition_window_graph(sanitize_transition_name(&tr.transition_type), k, d, fps, (w, h), &look)
    };
    // The joins keep their last frame (eof_action=pass): a drawn transition's frames can end
    // without a duration, which `fps` would otherwise round away - a frame short at the very end.
    let mut g = format!("[{src}]fps={fps:.3},settb=AVTB,format=yuv420p,setsar=1[edg];");
    let mut cur = "edg";
    if let (Some(d), Some(tr)) = (intro_d, edges.intro.as_ref()) {
        let k = EDGE_INTRO_TAG;
        g.push_str(&format!(
            "[{cur}]split[eh{k}][er{k}];[eh{k}]trim=end={d:.6}[head{k}];[er{k}]trim=start={d:.6},setpts=PTS-STARTPTS[rest{k}];{}{}\
             [tr{k}][rest{k}]concat=n=2:v=1:a=0,fps={fps:.3}:eof_action=pass,settb=AVTB[edgein];",
            black(format!("old{k}"), d),
            window(tr, k, d)
        ));
        cur = "edgein";
    }
    if let (Some(d), Some(tr)) = (outro_d, edges.outro.as_ref()) {
        let k = EDGE_OUTRO_TAG;
        let start = (total - d).max(0.0);
        // The outgoing picture is padded with its last frame, so it's a full `d` long even if the
        // assembled video comes up a frame short of `total`.
        g.push_str(&format!(
            "[{cur}]split[eb{k}][et{k}];[eb{k}]trim=end={start:.6}[body{k}];\
             [et{k}]trim=start={start:.6},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={d:.3},trim=end={d:.6}[old{k}];{}{}\
             [body{k}][tr{k}]concat=n=2:v=1:a=0,fps={fps:.3}:eof_action=pass,settb=AVTB[edgeout];",
            black(format!("head{k}"), d),
            window(tr, k, d)
        ));
        cur = "edgeout";
    }
    g.push_str(&format!("[{cur}]null[{out}];"));
    g
}

// BT.601 limited-range Y, Cb, Cr of an 8-bit RGB colour.
pub(crate) fn rgb_to_yuv((r, g, b): (f64, f64, f64)) -> (i64, i64, i64) {
    let (r, g, b) = (r / 255.0, g / 255.0, b / 255.0);
    let y = 16.0 + 65.481 * r + 128.553 * g + 24.966 * b;
    let u = 128.0 - 37.797 * r - 74.203 * g + 112.0 * b;
    let v = 128.0 + 112.0 * r - 93.786 * g - 18.214 * b;
    (y.round() as i64, u.round() as i64, v.round() as i64)
}

// A per-frame command series for `target` (a named filter instance, "gblur@w3"): `param` set to
// value(p) at every frame of the window, p = transition progress 0..1. How a filter whose options
// aren't expressions (a blur radius, a pixel block size) follows the transition exactly.
pub(crate) fn sendcmd_series(target: &str, params: &[&str], d: f64, fps: f64, value: impl Fn(f64) -> f64) -> String {
    let frames = (d * fps).ceil().max(1.0) as usize;
    // Only where the value changes.
    let mut cmds: Vec<String> = Vec::new();
    let mut last = String::new();
    for k in 0..=frames {
        let t = k as f64 / fps;
        let v = format!("{:.3}", value((t / d).min(1.0)));
        if v != last {
            let set: Vec<String> = params.iter().map(|p| format!("{target} {p} {v}")).collect();
            cmds.push(format!("{t:.4} {}", set.join(",")));
            last = v;
        }
    }
    format!("sendcmd=c='{}'", cmds.join(";"))
}

// Draws one transition over the incoming clip's first `d` seconds: [old{i}] (the outgoing clip's
// tail, timed from 0) over [head{i}], into [tr{i}]. Every case mirrors renderTransitionFrame
// (transitionFrame.ts) step for step - the same layers in the same order (outgoing picture, black
// dip, glow, drawn layers), the same curves - so the export is the preview.
//
// Everything that moves is per FRAME (overlay x/y and enable, perspective corners, sendcmd'd blur
// and pixel size) over native filters. Per-pixel maths (geq) only ever runs on small frames scaled
// up afterwards - masks and glows are smooth or soft-edged, so nothing is lost - since full-size
// per-pixel expressions cost about a second per 1080p frame (measured against the bundled ffmpeg).
// Glows composite with `blend=screen` in RGB: a colour layer premultiplied by its opacity, screened
// on, is exactly CSS's mix-blend-mode:screen at that opacity.
pub(super) fn transition_window_graph(name: &str, i: usize, d: f64, fps: f64, (w, h): (i64, i64), look: &TransitionLook) -> String {
    let k = look.intensity.unwrap_or(1.0).clamp(0.1, 1.5);
    // Progress in an overlay's/eq's `t`, and in geq's `T`.
    let pt = format!("min(t/{d:.4},1)");
    let pg = format!("min(T/{d:.4},1)");
    let fade_out = format!("format=yuva420p,fade=t=out:st=0:d={d:.4}:alpha=1");
    let half = d / 2.0;
    // A uniform layer (8x8, scaled up): yuva with this luma and per-frame alpha (0..1 in `pg`).
    let flat = |src: &str, out: &str, luma: i64, alpha: &str| {
        format!("[{src}]scale=8:8,format=yuva420p,geq=lum={luma}:cb=128:cr=128:a='255*({alpha})',scale={w}:{h}[{out}];")
    };
    // A screen-blended RGB glow (premultiplied 0..255 per channel), computed on a small frame.
    let screen = |src: &str, base: &str, out: &str, div: i64, r: &str, g: &str, b: &str| {
        let (lw, lh) = ((w / div).max(2), (h / div).max(2));
        format!(
            "[{src}]scale={lw}:{lh},format=gbrp,geq=r='{r}':g='{g}':b='{b}',scale={w}:{h}[gl{i}];\
             [{base}]format=gbrp[bg{i}];[bg{i}][gl{i}]blend=all_mode=screen:shortest=1,format=yuv420p[{out}];"
        )
    };
    // A soft mask (luma = opacity of the outgoing picture), computed at half size.
    let mask = |src: &str, out: &str, lum: &str| {
        let (lw, lh) = ((w / 2).max(2), (h / 2).max(2));
        format!("[{src}]scale={lw}:{lh},format=gray,geq=lum='{lum}',scale={w}:{h}:flags=bilinear[{out}];")
    };
    let masked = |lum: &str| {
        format!(
            "[old{i}]split[ma{i}][mm{i}];{m}[ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];",
            m = mask(&format!("mm{i}"), &format!("mk{i}"), lum)
        )
    };
    let tint = look.color.as_deref().and_then(parse_hex_color);
    // Wipe / circle / clock wipe edge softness (transitionFrame.ts).
    let soft = look_num(look.softness, 0.0, 0.0, 1.0);
    match name {
        "dissolve" => {
            // Grain by grain: a fixed noise field (160 / size cells across) and every cell whose
            // value the progress has passed shows the new clip. The same hash as the preview's.
            let s = "(sin(X*12.9898+Y*78.233)*43758.5453)";
            let cols = (160.0 / look_num(look.size, 1.0, 0.3, 3.0)).round() as i64;
            format!(
                "[old{i}]split[ma{i}][mm{i}];[mm{i}]scale={cols}:-1,format=gray,geq=lum='255*gte({s}-floor({s}),{pg})',scale={w}:{h}:flags=bilinear[mk{i}];\
                 [ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];"
            )
        }
        "fadeblack" | "fadewhite" if name == "fadeblack" || (tint.map_or(true, |c| c == (255.0, 255.0, 255.0)) && look.intensity.is_none()) => {
            // Out to black/white over the first half, then from it over the second.
            let luma = if name == "fadeblack" { 16 } else { 235 };
            format!(
                "[old{i}]split[oa{i}][ob{i}];[head{i}][oa{i}]overlay=eof_action=pass:enable='lt(t,{half:.4})'[x{i}];{dip}[x{i}][dip{i}]overlay=eof_action=pass[tr{i}];",
                dip = flat(&format!("ob{i}"), &format!("dip{i}"), luma, &format!("if(lt({pg},0.5),2*{pg},2-2*{pg})"))
            )
        }
        "fadewhite" => {
            // A crossfade washed in the flash colour at its peak - screened on, or laid over for black.
            let (r, g, b) = tint.unwrap_or((255.0, 255.0, 255.0));
            let o = format!("min(1,{k:.3}*sin(PI*{pg}))");
            let lead = format!("[old{i}]split[oa{i}][ob{i}];[oa{i}]{fade_out}[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass[x{i}];");
            if (r, g, b) == (0.0, 0.0, 0.0) {
                format!("{lead}{}[x{i}][dip{i}]overlay=eof_action=pass[tr{i}];", flat(&format!("ob{i}"), &format!("dip{i}"), 16, &o))
            } else {
                format!("{lead}{}", screen(&format!("ob{i}"), &format!("x{i}"), &format!("tr{i}"), 8, &format!("{r}*{o}"), &format!("{g}*{o}"), &format!("{b}*{o}")))
            }
        }
        "lightleak" => {
            // A crossfade under a coloured burn whose hot spot travels across: CSS's
            // radial-gradient(ellipse 0.83*size, white-hot -> colour@0.95 at 35% -> clear) over a
            // flat colour@0.5, interpolated premultiplied as CSS does, screened at min(1, 1.15k sin).
            let (r, g, b) = tint.unwrap_or((255.0, 122.0, 46.0));
            let size = look.size.unwrap_or(1.0).clamp(0.3, 2.5);
            let (sx, sy) = match look.direction.as_deref() {
                Some("left") => (format!("(1.2-1.4*{pg})"), "0.35".to_string()),
                Some("down") => ("0.4".to_string(), format!("(-0.2+1.4*{pg})")),
                Some("up") => ("0.4".to_string(), format!("(1.2-1.4*{pg})")),
                Some("diagonal") => (format!("(-0.2+1.4*{pg})"), format!("(-0.2+1.4*{pg})")),
                Some("center") => ("0.5".to_string(), "0.5".to_string()),
                _ => (format!("(-0.2+1.4*{pg})"), "0.35".to_string()),
            };
            let rad = 0.83 * size;
            let dist = format!("hypot((X/W-{sx})/{rad:.4},(Y/H-{sy})/{rad:.4})");
            let t1 = format!("clip({dist}/0.35,0,1)");
            let t2 = format!("clip(({dist}-0.35)/0.65,0,1)");
            let alpha = format!("if(lt({dist},0.35),1-0.05*{t1},0.95*(1-{t2}))");
            let o = format!("min(1,{:.3}*sin(PI*{pg}))", 1.15 * k);
            let channel = |hot: f64, c: f64| {
                format!("{o}*(if(lt({dist},0.35),{hot}*(1-{t1})+{c1:.3}*{t1},{c1:.3}*(1-{t2}))+{half_c:.3}*(1-{alpha}))", c1 = c * 0.95, half_c = c * 0.5)
            };
            format!(
                "[old{i}]split[oa{i}][ob{i}];[oa{i}]{fade_out}[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass[x{i}];{}",
                screen(&format!("ob{i}"), &format!("x{i}"), &format!("tr{i}"), 16, &channel(255.0, r), &channel(252.0, g), &channel(240.0, b))
            )
        }
        "whip" => {
            // A sideways smear through a white flash: blur sin(pi p)*3% of the width, sliding 30%.
            // gblur takes its vertical sigma from `sigma` only once, at init - a series has to drive
            // sigmaV too, or the blur stays one-dimensional.
            let blur = sendcmd_series(&format!("gblur@w{i}"), &["sigma", "sigmaV"], d, fps, |p| (std::f64::consts::PI * p).sin() * 0.03 * w as f64);
            format!(
                "[old{i}]split[oa{i}][ob{i}];[oa{i}]format=yuva420p,{blur},gblur@w{i}=sigma=0:sigmaV=0,fade=t=out:st=0:d={d:.4}:alpha=1[oc{i}];\
                 [head{i}][oc{i}]overlay=x='-0.3*main_w*{pt}':y=0:eof_action=pass[x{i}];{flash}[x{i}][fl{i}]overlay=eof_action=pass[tr{i}];",
                flash = flat(&format!("ob{i}"), &format!("fl{i}"), 235, &format!("min(1,{:.3}*pow(sin(PI*{pg}),2))", 0.8 * k))
            )
        }
        "zoomblur" | "zoomin" => {
            // The old picture zooms at the camera about the centre - zoom blur also smears (blur
            // before the zoom, as CSS applies `filter` before `transform`) through a white flash.
            let frames = (d * fps.max(1.0)).max(1.0);
            // perspective's `in` counts frames from 1.
            let p = format!("min((in-1)/{frames:.3},1)");
            let z = if name == "zoomblur" { format!("(1+1.6*pow({p},2))") } else { format!("(1+{p})") };
            let persp = format!(
                "perspective=x0='W/2-W/2/{z}':y0='H/2-H/2/{z}':x1='W/2+W/2/{z}':y1='H/2-H/2/{z}':x2='W/2-W/2/{z}':y2='H/2+H/2/{z}':x3='W/2+W/2/{z}':y3='H/2+H/2/{z}':sense=source:eval=frame"
            );
            if name == "zoomin" {
                return format!("[old{i}]{persp},{fade_out}[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass[tr{i}];");
            }
            let blur = sendcmd_series(&format!("gblur@z{i}"), &["sigma", "sigmaV"], d, fps, |p| p * 0.012 * w as f64 * k);
            format!(
                "[old{i}]split[oa{i}][ob{i}];[oa{i}]format=yuva420p,{blur},gblur@z{i}=sigma=0:sigmaV=0,{persp},fade=t=out:st=0:d={d:.4}:alpha=1[oc{i}];\
                 [head{i}][oc{i}]overlay=eof_action=pass[x{i}];{flash}[x{i}][fl{i}]overlay=eof_action=pass[tr{i}];",
                flash = flat(&format!("ob{i}"), &format!("fl{i}"), 235, &format!("min(1,{:.3}*pow(sin(PI*{pg}),2))", 0.35 * k))
            )
        }
        "horzopen" => {
            // The new clip opens out of a line through the middle (or doors, vertical): the old
            // picture's opacity is CSS's linear-gradient(#000 a, clear a+soft, clear b-soft, #000 b),
            // stop positions clamped to be increasing as CSS does.
            let axis = if look.orientation.as_deref() == Some("vertical") { "X/W" } else { "Y/H" };
            let band = format!("({pg}*0.54)");
            let (s1, s2) = (format!("(0.5-{band})"), format!("(0.54-{band})"));
            let s3 = format!("max({s2},0.46+{band})");
            let s4 = format!("max({s3},0.5+{band})");
            let v = axis;
            let lum = format!(
                "255*if(lte({v},{s1}),1,if(lt({v},{s2}),1-({v}-{s1})/0.04,if(lt({v},{s3}),0,if(lt({v},{s4}),({v}-{s3})/max({s4}-{s3},1e-6),1))))"
            );
            masked(&lum)
        }
        "circleopen" if soft > 0.0 => {
            // CSS's radial-gradient(transparent r - S/2, #000 r + S/2), S = 15% of the diagonal at
            // full softness, the radius travelling far enough for the band to clear the corners.
            let s = format!("({:.4}*hypot(W,H))", 0.15 * soft);
            masked(&format!("255*clip((hypot(X-W/2,Y-H/2)-({pg}*(hypot(W,H)/2+{s})-{s}))/{s},0,1)"))
        }
        "circleopen" => masked(&format!("255*gt(hypot(X-W/2,Y-H/2),{pg}*hypot(W,H)/2)")),
        "radial" => {
            // A sweep from 12 o'clock (CSS conic-gradient from 0deg) - clockwise, or anticlockwise
            // as its mirror - its edge up to 60 degrees soft.
            let a = "if(lt(atan2(X-W/2,H/2-Y),0),atan2(X-W/2,H/2-Y)+2*PI,atan2(X-W/2,H/2-Y))";
            let a = if look.direction.as_deref() == Some("left") { format!("(2*PI-{a})") } else { a.to_string() };
            let band = 60.0 * soft * std::f64::consts::PI / 180.0;
            if band > 0.0 {
                masked(&format!("255*clip(({a}-{pg}*{:.5}+{band:.5})/{band:.5},0,1)", 2.0 * std::f64::consts::PI + band))
            } else {
                masked(&format!("255*gte({a},{pg}*2*PI)"))
            }
        }
        "wipeleft" | "wiperight" if soft > 0.0 => {
            // A soft edge S wide (30% of the width at full softness): a sprite [white | ramp |
            // black] (reversed for wiperight), 2W + S wide, slid across so the ramp clears the
            // frame at both ends - the preview's linear-gradient mask.
            let sw = (0.3 * soft * w as f64 / 2.0).round().max(1.0) as i64 * 2;
            let left = name == "wipeleft";
            let ramp = if left { format!("1-clip((X-{w})/{sw},0,1)") } else { format!("clip((X-{w})/{sw},0,1)") };
            let x = if left { format!("-{}*{pt}", w + sw) } else { format!("{}*{pt}-{}", w + sw, w + sw) };
            format!(
                "[old{i}]split=3[ma{i}][mc{i}][ms{i}];\
                 [ms{i}]trim=end_frame=1,format=gray,scale={sprite}:2,geq=lum='255*({ramp})',scale={sprite}:{h},format=yuv420p,tpad=stop_mode=clone:stop_duration={d:.4}[sp{i}];\
                 [mc{i}]lutyuv=y=0:u=128:v=128[cv{i}];[cv{i}][sp{i}]overlay=x='{x}':y=0[mk{i}];\
                 [ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];",
                sprite = 2 * w + sw
            )
        }
        "wipeleft" | "wiperight" => {
            // A hard edge, exact to the pixel: a half-white sprite two frames wide slid across.
            let (pad_x, x) = if name == "wipeleft" { ("0", format!("-main_w*{pt}")) } else { ("iw", format!("main_w*{pt}-main_w")) };
            format!(
                "[old{i}]split=3[ma{i}][mc{i}][ms{i}];\
                 [ms{i}]trim=end_frame=1,lutyuv=y=255:u=128:v=128,pad=iw*2:ih:{pad_x}:0:black,tpad=stop_mode=clone:stop_duration={d:.4}[sp{i}];\
                 [mc{i}]lutyuv=y=0:u=128:v=128[cv{i}];[cv{i}][sp{i}]overlay=x='{x}':y=0[mk{i}];\
                 [ma{i}]format=yuva420p[mb{i}];[mb{i}][mk{i}]alphamerge[mo{i}];[head{i}][mo{i}]overlay=eof_action=pass[tr{i}];"
            )
        }
        "slideleft" | "slideright" => {
            let sign = if name == "slideleft" { "-" } else { "" };
            format!("[head{i}][old{i}]overlay=x='{sign}main_w*{pt}':y=0:eof_action=pass[tr{i}];")
        }
        "pixelize" => {
            // Coarsens toward the midpoint (blocks up to 1/24 of the width, times size), then the
            // new clip.
            let max_block = (w as f64 / 24.0 * look_num(look.size, 1.0, 0.3, 3.0)).max(2.0);
            let px = sendcmd_series(&format!("pixelize@p{i}"), &["w", "h"], d, fps, |p| (1.0 + (max_block - 1.0) * (2.0 * p).min(1.0)).round());
            format!("[old{i}]{px},pixelize@p{i}=w=1:h=1[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass:enable='lt(t,{half:.4})'[tr{i}];")
        }
        "colorsweep" => drawn_transition(name, i, d, look),
        n if is_canvas_transition(n) => canvas_transition(n, i, d, fps, (w, h), look),
        _ => format!("[old{i}]{fade_out}[oc{i}];[head{i}][oc{i}]overlay=eof_action=pass[tr{i}];"),
    }
}

#[cfg(test)]
pub(crate) fn transition_window_graph_for_tests(name: &str, i: usize, d: f64, fps: f64, frame: (i64, i64)) -> String {
    transition_window_graph(name, i, d, fps, frame, &TransitionLook::default())
}

// The colour sweep, drawn from a sprite slid per frame: [old{i}] (the outgoing clip's tail, `d`
// seconds, timed from 0) over [head{i}], into [tr{i}].
pub(super) fn drawn_transition(name: &str, i: usize, d: f64, look: &TransitionLook) -> String {
    // Transition progress 0..1 from an overlay's `t` (seconds since the window began).
    let q = format!("min(t/{d:.3},1)");
    match name {
        // A colour panel slides across - one frame plus a lighter band at each end long, so its
        // leading edge has covered the old picture by the midpoint (when the old picture goes) and
        // its trailing edge uncovers the new clip after. Eased in and out (smoothstep).
        "colorsweep" => {
            const ACCENT: f64 = 0.08;
            let (r, g, b) = look.color.as_deref().and_then(parse_hex_color).unwrap_or((255.0, 176.0, 32.0));
            let (y, u, v) = rgb_to_yuv((r, g, b));
            let lift = |c: f64| (c + (255.0 - c) * 0.55).round() as u8;
            let accent = format!("0x{:02x}{:02x}{:02x}", lift(r), lift(g), lift(b));
            let lead = format!("({:.3}*{q}*{q}*(3-2*{q}))", 2.0 + 2.0 * ACCENT);
            let vertical = !matches!(look.direction.as_deref(), Some("left") | Some("right"));
            let pad = if vertical {
                format!("pad=iw:ih*{span}:0:ih*{ACCENT}:color={accent}", span = 1.0 + 2.0 * ACCENT)
            } else {
                format!("pad=iw*{span}:ih:iw*{ACCENT}:0:color={accent}", span = 1.0 + 2.0 * ACCENT)
            };
            let (x, y_pos) = match look.direction.as_deref() {
                Some("down") => ("0".to_string(), format!("main_h*{lead}-overlay_h")),
                Some("right") => (format!("main_w*{lead}-overlay_w"), "0".to_string()),
                Some("left") => (format!("main_w*(1-{lead})"), "0".to_string()),
                _ => ("0".to_string(), format!("main_h*(1-{lead})")),
            };
            format!(
                "[old{i}]split[oldf{i}][panel{i}];\
                 [panel{i}]trim=end_frame=1,lutyuv=y={y}:u={u}:v={v},{pad},tpad=stop_mode=clone:stop_duration={d:.3}[sweep{i}];\
                 [head{i}][oldf{i}]overlay=eof_action=pass:enable='lt(t,{half:.3})'[under{i}];\
                 [under{i}][sweep{i}]overlay=x='{x}':y='{y_pos}':eof_action=pass[tr{i}];",
                half = d / 2.0,
            )
        }
        _ => String::new(),
    }
}

// Frame rate of a source file's first video stream, as a plain f64 (e.g. 30.0, 59.94) - only ever
// needed for the crossfade fold below, which requires every input at a matching constant frame
// rate before chaining more than one `xfade` in sequence (spike-tested: without this, ffmpeg
// rejects the second xfade in a chain with "needs to be a constant frame rate"). Defaults to 30.0
// on any probe failure (missing ffprobe, unparseable output, a 0/0 rate) rather than erroring the
// whole export over a cosmetic transition detail.
// Allowlist of ffmpeg `xfade` transition names this app exposes (mirrors TransitionType,
// videoEditTypes.ts, exactly - one flat vocabulary, no separate friendly-name mapping table).
// `transition_type` is interpolated directly into the filter_complex string below (see the
// has_transitions fold), so this is a real security boundary, not just UI validation - an
// unrecognized value (a hand-edited sidecar, a future frontend/backend version mismatch) falls
// back to "fade" rather than ever reaching the format! call unchecked.
pub(super) const ALLOWED_TRANSITIONS: &[&str] = &[
    "fade",
    "fadeblack",
    "wipeleft",
    "wiperight",
    "slideleft",
    "slideright",
    "circleopen",
    "zoomin",
    "pixelize",
    "radial",
    "dissolve",
    "fadewhite",
    "horzopen",
    // Not ffmpeg names - xfade plus a glow pass (see transition_fold_step).
    "lightleak",
    "whip",
    // Drawn over the outgoing picture (transition_window_graph).
    "zoomblur",
    "colorsweep",
    // Both pictures move (services/transition_graphs.rs).
    "pagecurl",
    "blocks",
    "mosaic",
    "split",
    "slider",
    "strips",
    "beam",
    "iris",
    "spin",
    "glitch",
    "slice",
    "push",
    "cube",
    "flip",
    "tiles",
];

pub(super) fn sanitize_transition_name(name: &str) -> &str {
    ALLOWED_TRANSITIONS
        .iter()
        .find(|&&t| t == name)
        .copied()
        .unwrap_or("fade")
}

// Every OverlayAnimation that burns in as a whole-overlay animation (title reveals are rendered
// into their own frames instead). Same security-boundary reasoning as ALLOWED_TRANSITIONS: this
// string is interpolated directly into the filter_complex below.
pub(super) const ALLOWED_OVERLAY_ANIMATIONS: &[&str] = &[
    "none",
    "fade",
    "slide-left",
    "slide-right",
    "slide-up",
    "slide-down",
    "pop",
    "flip",
    "zoom",
    "drop",
];

pub(super) fn sanitize_overlay_animation(name: &str) -> &str {
    ALLOWED_OVERLAY_ANIMATIONS
        .iter()
        .find(|&&a| a == name)
        .copied()
        .unwrap_or("none")
}

// Matches the live preview's own slide timing exactly (overlayAnimationStyle, VideoOverlayLayer.tsx)
// so a slide overlay looks the same in the exported file as it did on screen: `ramp` is how long the
// entry/exit glide takes (clamped to half the overlay's own duration so a very short overlay still
// finishes entering before it starts leaving), and `progress` is 0 right at either edge of
// [start_time,end_time), ramping to 1 once "fully arrived" - `remaining = 1-progress` is then how far
// from settled the overlay still is, which is what actually drives how far it's offset from its
// resting (ov.x, ov.y) position. ffmpeg's `clip(x,min,max)` and `min(a,b)` eval functions reproduce
// the same clamp/min the preview's own plain JS math uses.
pub(super) const OVERLAY_ANIMATION_RAMP_SEC: f64 = 0.4;
pub(super) const OVERLAY_SLIDE_DISTANCE_FRACTION: f64 = 0.12;

pub(super) fn overlay_animation_ramp(start_time: f64, end_time: f64) -> f64 {
    OVERLAY_ANIMATION_RAMP_SEC.min((end_time - start_time) / 2.0).max(0.001)
}

// The preview's `progress` (0 at either edge of the overlay's window, 1 once fully arrived) in
// time variable `tv`.
pub(super) fn overlay_arrival_expr(start_time: f64, end_time: f64, tv: &str) -> String {
    let ramp = overlay_animation_ramp(start_time, end_time);
    format!("clip(min(({tv}-{start_time:.3})/{ramp:.4},({end_time:.3}-{tv})/{ramp:.4}),0,1)")
}

pub(super) fn overlay_slide_remaining_expr(start_time: f64, end_time: f64) -> String {
    format!("(1-{})", overlay_arrival_expr(start_time, end_time, "t"))
}

// "pop": the overlay's scale over time in `tv` - the preview's ease-out-back overshoot
// (easeOutBack, VideoOverlayLayer.tsx) of the same arrival progress: from nothing, past full size,
// settling at 1; symmetric on the way out.
pub(super) fn overlay_pop_scale_expr(start_time: f64, end_time: f64, tv: &str) -> String {
    let p = overlay_arrival_expr(start_time, end_time, tv);
    format!("if(gte({p},1),1,max(0.01,1+2.70158*pow({p}-1,3)+1.70158*pow({p}-1,2)))")
}

// "flip": its horizontal squash - one and a half coin turns, |cos((1-p)^3 3pi)| (overlayAnimation.ts).
pub(super) fn overlay_flip_sx_expr(start_time: f64, end_time: f64, tv: &str) -> String {
    let p = overlay_arrival_expr(start_time, end_time, tv);
    format!("if(gte({p},1),1,max(0.02,abs(cos(pow(1-{p},3)*3*PI))))")
}

// "zoom": rushing in from 2.5x.
pub(super) fn overlay_zoom_scale_expr(start_time: f64, end_time: f64, tv: &str) -> String {
    let p = overlay_arrival_expr(start_time, end_time, tv);
    format!("(1+1.5*pow(1-{p},3))")
}

// The overlay's own scale animation over time in `tv` (pop / flip / zoom), if it has one.
pub(super) fn overlay_anim_scale_expr(animation: &str, start_time: f64, end_time: f64, tv: &str) -> Option<String> {
    match animation {
        "pop" | "flip" => Some(overlay_pop_scale_expr(start_time, end_time, tv)),
        "zoom" => Some(overlay_zoom_scale_expr(start_time, end_time, tv)),
        _ => None,
    }
}

// "drop": how far above its resting spot it is - easeOutBounce of the arrival, from 0.3 frames up.
pub(super) fn overlay_drop_offset_expr(start_time: f64, end_time: f64) -> String {
    let p = overlay_arrival_expr(start_time, end_time, "t");
    let (n1, d1) = (7.5625, 2.75);
    let bounce = format!(
        "if(lt({p},{a:.6}),{n1}*pow({p},2),if(lt({p},{b:.6}),{n1}*pow({p}-{c:.6},2)+0.75,if(lt({p},{d:.6}),{n1}*pow({p}-{e:.6},2)+0.9375,{n1}*pow({p}-{f:.6},2)+0.984375)))",
        a = 1.0 / d1,
        b = 2.0 / d1,
        c = 1.5 / d1,
        d = 2.5 / d1,
        e = 2.25 / d1,
        f = 2.625 / d1
    );
    format!("-(1-({bounce}))*main_h*0.3")
}

// The overlay filter's own x/y, as ffmpeg expression strings - a plain integer for "none"/"fade"
// (unchanged from before slide support existed), or a `main_w`/`main_h`-relative expression that
// glides in from the corresponding off-screen edge and back out for "slide-*", built with the exact
// same distance-from-resting-position idiom overlayAnimationStyle's own `remaining * distance` uses
// (VideoOverlayLayer.tsx) - `main_w`/`main_h` are the overlay filter's own built-in variables for the
// base video's pixel dimensions, evaluated per-frame, so no separate output-resolution lookup is
// needed here the way ken_burns_chain needs one.
pub(super) fn overlay_position_expr(ov: &OverlayImage, animation: &str) -> (String, String) {
    match animation {
        "slide-left" => (
            format!(
                "({x})-(main_w*{frac})*{remaining}",
                x = ov.x,
                frac = OVERLAY_SLIDE_DISTANCE_FRACTION,
                remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)
            ),
            ov.y.to_string(),
        ),
        "slide-right" => (
            format!(
                "({x})+(main_w*{frac})*{remaining}",
                x = ov.x,
                frac = OVERLAY_SLIDE_DISTANCE_FRACTION,
                remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)
            ),
            ov.y.to_string(),
        ),
        "slide-up" => (
            ov.x.to_string(),
            format!(
                "({y})-(main_h*{frac})*{remaining}",
                y = ov.y,
                frac = OVERLAY_SLIDE_DISTANCE_FRACTION,
                remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)
            ),
        ),
        "slide-down" => (
            ov.x.to_string(),
            format!(
                "({y})+(main_h*{frac})*{remaining}",
                y = ov.y,
                frac = OVERLAY_SLIDE_DISTANCE_FRACTION,
                remaining = overlay_slide_remaining_expr(ov.start_time, ov.end_time)
            ),
        ),
        "drop" => (ov.x.to_string(), format!("({})+({})", ov.y, overlay_drop_offset_expr(ov.start_time, ov.end_time))),
        _ => (ov.x.to_string(), ov.y.to_string()),
    }
}

// Just a slide's offset from the resting position ("0" for anything else) - added to a keyframed
// position, where the resting spot itself moves.
pub(super) fn overlay_slide_offset_expr(ov: &OverlayImage, animation: &str) -> (String, String) {
    let r = overlay_slide_remaining_expr(ov.start_time, ov.end_time);
    let f = OVERLAY_SLIDE_DISTANCE_FRACTION;
    match animation {
        "slide-left" => (format!("-(main_w*{f})*{r}"), "0".into()),
        "slide-right" => (format!("(main_w*{f})*{r}"), "0".into()),
        "slide-up" => ("0".into(), format!("-(main_h*{f})*{r}")),
        "slide-down" => ("0".into(), format!("(main_h*{f})*{r}")),
        "drop" => ("0".into(), overlay_drop_offset_expr(ov.start_time, ov.end_time)),
        _ => ("0".into(), "0".into()),
    }
}

pub(crate) fn probe_frame_rate(ffprobe_path: &PathBuf, source_path: &str) -> f64 {
    const FALLBACK_FPS: f64 = 30.0;
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=r_frame_rate",
        "-of",
        "csv=p=0",
        source_path,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return FALLBACK_FPS,
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    let parsed = match text.split_once('/') {
        Some((num, den)) => match (num.parse::<f64>(), den.parse::<f64>()) {
            (Ok(n), Ok(d)) if d > 0.0 => Some(n / d),
            _ => None,
        },
        None => text.parse::<f64>().ok(),
    };
    match parsed {
        Some(fps) if fps.is_finite() && fps > 0.0 => fps,
        _ => FALLBACK_FPS,
    }
}

// Whether `source_path` has at least one audio stream - screen recordings captured with no
// microphone/system audio are a real, common case (see the crop bug this was written for: cropping
// such a recording routes it into the filter-graph export path below, whose `[i:a]atrim=...`
// branches used to be unconditional and made ffmpeg reject the whole graph with "Stream specifier
// ':a' ... matches no streams" the moment a segment's source had no audio track at all). Defaults
// to true on any probe failure so an unreadable/unusual file keeps the previous "always assume
// audio" behavior rather than silently dropping a real track.
// Channel count of `source_path`'s first audio stream; None when it has none or the probe fails.
pub(super) fn probe_audio_channels(ffprobe_path: &PathBuf, source_path: &str) -> Option<u32> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args(["-v", "quiet", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", source_path]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

pub(crate) fn probe_has_audio(ffprobe_path: &PathBuf, source_path: &str) -> bool {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-select_streams",
        "a",
        "-show_entries",
        "stream=index",
        "-of",
        "csv=p=0",
        source_path,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => return true,
    };
    !String::from_utf8_lossy(&output.stdout).trim().is_empty()
}

// Native pixel size of `source_path`'s first video stream - the frontend normally already knows
// this (videoPixelSize, read off the same hidden capture <video> used for thumbnails) and passes it
// through as video_width/video_height, but that can still be None if Save is clicked before that
// metadata has loaded (a just-added clip, or an unusual codec). segment_effect_chain needs a
// concrete out_w/out_h to build the crop/Ken Burns filters at all, so without this fallback probe a
// segment with either effect set would take the (already forced, since has_clip_effects) filter-
// graph export path but have that one effect silently skipped - an uncropped/unpanned file, no
// error, no indication anything was dropped.
// Export quality presets - (libx264 preset, CRF) pairs. "standard" is the exact pair every export
// used unconditionally before this existed, so a caller that doesn't pass `quality` at all (or
// passes an unrecognized value) gets today's already-proven behavior, not a silent change.
// "high"'s slower preset spends more encode time finding smaller/cleaner bitrate allocations for
// the same visual quality; "small"'s faster preset trades some of that quality back for a shorter
// export - both directions users of a screen-recording tool routinely want (a quick draft to share
// immediately vs. a final archival-quality copy).
// ---- Input seeking ------------------------------------------------------------------------------
//
// Every `-i` that only needs part of a long file jumps straight to it: an input-level `-ss` seeks
// the demuxer to the keyframe before that point and decodes only from there, where a bare `trim=`
// in the filter graph decoded (and threw away) everything from the very start of the file first -
// a cut at minute 50 of a recording decoded 50 minutes, once per segment taken from that file.
// Measured on a 10-minute 1080p source, three 20s cuts: 92.5s of decoding down to 6.6s.
//
// It's frame-exact and changes nothing in the picture: the seek lands SEEK_PREROLL_SECS early and
// the graph's own trim/atrim still make the cut, with every source time shifted by the seek (the
// input's timestamps start at 0 where the seek landed). Only times read from the INPUT shift -
// a segment's range, its speed-ramp steps and its audio noise sample.
pub(super) const SEEK_PREROLL_SECS: f64 = 1.0;

// Where a segment's input can start reading: just before its own range or its noise sample
// (which can sit anywhere in the file, even before the clip), whichever is earlier. 0 for stills
// (looped, nothing to seek) and when it's near the file's start anyway.
pub(super) fn segment_input_seek(seg: &KeepSegment) -> f64 {
    if is_still_image_path(&seg.source_path) {
        return 0.0;
    }
    let sample_start = seg.audio_cleanup.as_ref().and_then(|c| c.noise_sample).map(|s| s.start).unwrap_or(f64::INFINITY);
    let seek = seg.start.min(sample_start) - SEEK_PREROLL_SECS;
    if seek.is_finite() && seek > 0.0 { seek } else { 0.0 }
}

// Re-times a segment for an input that starts `by` seconds into its file.
pub(super) fn shift_segment_times(seg: &mut KeepSegment, by: f64) {
    if by == 0.0 {
        return;
    }
    seg.start -= by;
    seg.end -= by;
    if let Some(steps) = seg.speed_steps.as_mut() {
        for step in steps {
            step.source_start -= by;
            step.source_end -= by;
        }
    }
    if let Some(sample) = seg.audio_cleanup.as_mut().and_then(|c| c.noise_sample.as_mut()) {
        sample.start -= by;
        sample.end -= by;
    }
}

// An input reading `path` from `seek` seconds in (plain when 0).
pub(super) fn seeking_input(path: String, seek: f64) -> InputSpec {
    if seek > 0.0 {
        InputSpec { path, pre_args: vec!["-ss".into(), format!("{seek:.6}")] }
    } else {
        InputSpec::plain(path)
    }
}

// The seek for an overlay track used from `trim_start` seconds into its file.
pub(super) fn trim_input_seek(trim_start: f64) -> f64 {
    let seek = trim_start - SEEK_PREROLL_SECS;
    if seek.is_finite() && seek > 0.0 { seek } else { 0.0 }
}

pub(super) fn resolve_export_quality(quality: Option<&str>) -> (&'static str, &'static str) {
    match quality.unwrap_or("standard") {
        "high" | "youtube" => ("slow", "18"),
        "small" => ("veryfast", "28"),
        _ => ("medium", "23"),
    }
}

// Platform presets on top of the quality tiers (the Save button's quality picker):
// - "youtube": the "high" tier's picture (hardware encoders included, at their "high" point) at
//   the source's own resolution and frame rate, with higher-bitrate audio - YouTube re-compresses
//   every upload, so the cleaner the file it starts from, the better the result looks.
// - "social": what WhatsApp Status / Instagram / Facebook accept without complaint - fitted into
//   1920x1080 (1080x1920 portrait), at most 30 fps, H.264 High@4.0 with a capped bitrate. Measured
//   failure this exists for: a 3840x2160 60 fps High@5.2 export that phones played fine but
//   WhatsApp Status refused as "format not supported". Always software x264, the only encoder
//   whose -profile/-level/-maxrate flags behave the same everywhere.
pub(super) fn export_hw_tier(quality: Option<&str>) -> Option<&'static str> {
    match quality.unwrap_or("standard") {
        "social" => None,
        "high" | "youtube" => Some("high"),
        "small" => Some("small"),
        _ => Some("standard"),
    }
}

pub(super) fn export_audio_bitrate(quality: Option<&str>) -> &'static str {
    if quality == Some("youtube") { "320k" } else { "128k" }
}

// Extra x264 flags a preset needs beyond preset/CRF.
pub(super) fn export_extra_video_args(quality: Option<&str>) -> Vec<String> {
    match quality {
        Some("social") => ["-profile:v", "high", "-level:v", "4.0", "-maxrate", "6M", "-bufsize", "12M"].iter().map(|s| s.to_string()).collect(),
        _ => Vec::new(),
    }
}

// The last video stage of every editor export. Always: standard (limited "tv") range 4:2:0 -
// a full-range yuvj420p source (screen captures can come out that way) otherwise passed straight
// through into the export, which many players/uploaders (WhatsApp, some TVs, YouTube's ingest)
// either reject or show washed out / with crushed blacks. nv12 is listed too as the same picture
// in the layout hardware encoders take (QSV only accepts nv12). For "social", also the size/rate
// limits described on export_hw_tier.
pub(super) fn export_delivery_filter(quality: Option<&str>, source_fps: f64) -> String {
    let mut stages: Vec<String> = Vec::new();
    if quality == Some("social") {
        stages.push(
            "scale=w='if(gte(iw,ih),min(iw,1920),min(iw,1080))':h='if(gte(iw,ih),min(ih,1080),min(ih,1920))':force_original_aspect_ratio=decrease:force_divisible_by=2".to_string(),
        );
        if source_fps > 30.5 {
            stages.push("fps=30".to_string());
        }
    }
    stages.push("scale=out_range=tv".to_string());
    stages.push("format=yuv420p|nv12".to_string());
    stages.join(",")
}

pub(crate) fn probe_video_dimensions(ffprobe_path: &PathBuf, source_path: &str) -> Option<(i64, i64)> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height:stream_side_data=rotation:stream_tags=rotate",
        "-of",
        "json",
        source_path,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd.output().ok()?;
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let video = probe["streams"].get(0)?;
    let (w, h) = (video["width"].as_i64()?, video["height"].as_i64()?);
    if w <= 0 || h <= 0 {
        return None;
    }
    // The size the frames DECODE at: ffmpeg turns a rotated phone video upright as it decodes.
    let rotation = video["side_data_list"]
        .as_array()
        .and_then(|list| list.iter().find_map(|d| d["rotation"].as_f64()))
        .or_else(|| video["tags"]["rotate"].as_str().and_then(|r| r.parse::<f64>().ok()))
        .unwrap_or(0.0);
    Some(if (rotation.abs() as i64) % 180 == 90 { (h, w) } else { (w, h) })
}

// One segment's audio branch of the filter graph, trimmed to [start,end) and labeled `out_label` -
// a real `atrim` off the segment's own input when it has audio, otherwise a synthesized silent
// track of the same duration (`anullsrc`, a filter *source*, needs no `-i` input of its own) so
// concat/xfade/acrossfade downstream always have a real audio stream to work with regardless of
// whether the source did.
pub(super) fn audio_trim_chain(
    has_audio: bool,
    input_index: usize,
    start: f64,
    end: f64,
    speed: f64,
    cleanup: &(Vec<String>, Option<(f64, f64)>),
    out_label: &str,
) -> String {
    if has_audio {
        // atempo_chain (not a bare "atempo={speed}") since ffmpeg rejects a single atempo instance
        // outside 0.5..2.0 - see its own doc comment. A speed of 1 still resolves to exactly
        // "atempo=1.0000", functionally a no-op, so this needs no separate branch for that case.
        // afftdn runs AFTER atempo - it's a per-frame spectral filter, order relative to tempo
        // doesn't change its own output, so there's no reason to special-case which comes first.
        audio_branch(&format!("[{}:a]", input_index), start, end, speed, &cleanup.0, cleanup.1, out_label)
    } else {
        // Divided by speed to match the video stream's own now-speed-adjusted duration (see the
        // trim/setpts call sites above) - concat/xfade both require the audio and video branches of
        // the same segment to agree on how long it lasts.
        format!(
            "anullsrc=channel_layout=stereo:sample_rate=44100:duration={dur:.3}[{out}];",
            dur = ((end - start) / speed).max(0.01),
            out = out_label
        )
    }
}

// Decodes one overlay's PNG payload and writes it to a fresh temp file - ffmpeg needs a real path
// for `-i`, not a data URL. `data_base64` may carry a "data:image/png;base64," prefix (what
// canvas.toDataURL() produces) or be the bare payload; splitting on the last comma handles both
// without the caller needing to know which.
// An overlay image's pixel size, read from its PNG header (the first frame's, for a sequence).
pub(super) fn overlay_layer_size(ov: &OverlayImage) -> Option<(i64, i64)> {
    let data = match &ov.frames {
        Some(frames) => frames.unique.first()?,
        None => &ov.data_base64,
    };
    let payload = data.rsplit(',').next().unwrap_or(data);
    // The IHDR's width/height sit at bytes 16..24 - 32 base64 characters decode them.
    let head = BASE64.decode(payload.get(..32)?).ok()?;
    if head.len() < 24 || &head[1..4] != b"PNG" {
        return None;
    }
    let w = u32::from_be_bytes(head[16..20].try_into().ok()?) as i64;
    let h = u32::from_be_bytes(head[20..24].try_into().ok()?) as i64;
    (w > 0 && h > 0).then_some((w, h))
}

pub(super) fn write_temp_overlay_png(data_base64: &str, index: usize) -> Result<PathBuf, String> {
    let payload = data_base64.rsplit(',').next().unwrap_or(data_base64);
    let bytes = BASE64
        .decode(payload)
        .map_err(|e| format!("Failed to decode overlay image: {}", e))?;
    let path = std::env::temp_dir().join(format!(
        "briefcast_overlay_{}_{}.png",
        std::process::id(),
        index
    ));
    std::fs::write(&path, &bytes)
        .map_err(|e| format!("Failed to write overlay temp file: {}", e))?;
    Ok(path)
}

// Writes an animated overlay's frames as a numbered PNG sequence ffmpeg's image2 demuxer can read
// (`..._f%06d.png`). Each distinct frame is written once and every repeat is a hard link to it
// (a copy where linking isn't possible), so a long looping element costs little disk or time.
// Every file created is pushed onto `created` - including on failure - for the caller's cleanup.
// Returns the sequence's printf-style pattern.
pub(super) fn write_temp_overlay_sequence(frames: &OverlayFrames, index: usize, created: &mut Vec<PathBuf>) -> Result<String, String> {
    if frames.unique.is_empty() || frames.sequence.is_empty() {
        return Err("Animated overlay has no frames".to_string());
    }
    let prefix = format!("briefcast_ovseq_{}_{}", std::process::id(), index);
    let dir = std::env::temp_dir();
    let mut unique_paths: Vec<PathBuf> = Vec::with_capacity(frames.unique.len());
    for (j, data) in frames.unique.iter().enumerate() {
        let payload = data.rsplit(',').next().unwrap_or(data);
        let bytes = BASE64
            .decode(payload)
            .map_err(|e| format!("Failed to decode overlay frame: {}", e))?;
        let path = dir.join(format!("{}_u{}.png", prefix, j));
        std::fs::write(&path, &bytes).map_err(|e| format!("Failed to write overlay frame: {}", e))?;
        created.push(path.clone());
        unique_paths.push(path);
    }
    for (k, &u) in frames.sequence.iter().enumerate() {
        let src = unique_paths
            .get(u as usize)
            .ok_or_else(|| "Animated overlay frame index out of range".to_string())?;
        let path = dir.join(format!("{}_f{:06}.png", prefix, k));
        let _ = std::fs::remove_file(&path);
        if std::fs::hard_link(src, &path).is_err() {
            std::fs::copy(src, &path).map_err(|e| format!("Failed to write overlay frame: {}", e))?;
        }
        created.push(path);
    }
    Ok(dir.join(format!("{}_f%06d.png", prefix)).to_string_lossy().to_string())
}

// ---- Sprite tracks and the screen frame (the Screen Style panel) ---------------------------------
//
// A sprite track (spriteTrack.ts) is a layer made of a few small pictures shown one after another
// at changing places - an editor-drawn pointer at its sub-pixel phases, a click ripple's frames,
// keyboard-shortcut chips. The editor paints each distinct picture once, with the code its preview
// paints with; here they become an ffconcat list (each picture held until the next run - nothing is
// rendered per frame) overlaid at a position that is a step function of time. Runs change on
// boundaries the editor puts between frames, so a frame never lands where the picture and its
// position could disagree.

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpriteTrack {
    // PNG data URLs, each exactly width x height.
    pub sprites: Vec<String>,
    pub width: i64,
    pub height: i64,
    // (from seconds, sprite index or -1 for nothing, x, y) - sorted; each holds until the next.
    pub runs: Vec<(f64, i64, i64, i64)>,
    // Where the last run ends.
    pub end: f64,
}

// The frame around the video (screenStyle.ts): the backdrop at the final frame's size with a
// transparent rounded hole, and where the edited picture is scaled into - the hole's box.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenStyleSpec {
    pub backdrop_base64: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

// A sprite's bytes as an 8-bit RGBA PNG of exactly w x h - what the canvas usually hands over
// already; anything else (an opaque canvas saved as RGB, a size off by one) is redrawn so every
// picture in the concat list has one size and format (a change mid-stream reconfigures the graph).
pub(super) fn normalized_sprite_png(data_base64: &str, w: u32, h: u32) -> Result<Vec<u8>, String> {
    let payload = data_base64.rsplit(',').next().unwrap_or(data_base64);
    let bytes = BASE64.decode(payload).map_err(|e| format!("Failed to decode a sprite: {}", e))?;
    let ihdr_ok = bytes.len() > 26
        && &bytes[1..4] == b"PNG"
        && u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]) == w
        && u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]) == h
        && bytes[24] == 8
        && bytes[25] == 6;
    if ihdr_ok {
        return Ok(bytes);
    }
    let decoded = image::load_from_memory(&bytes).map_err(|e| format!("Failed to read a sprite: {}", e))?.to_rgba8();
    let mut canvas = image::RgbaImage::new(w, h);
    image::imageops::overlay(&mut canvas, &decoded, 0, 0);
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to write a sprite: {}", e))?;
    Ok(out)
}

// The track's pictures in `dir` and an ffconcat list showing them run by run, timed from `shift`
// (run times minus `shift`, anything before 0 dropped). Returns the list's path.
pub(super) fn write_sprite_track(track: &SpriteTrack, dir: &Path, shift: f64) -> Result<PathBuf, String> {
    let (w, h) = (track.width.clamp(2, 8192) as u32, track.height.clamp(2, 8192) as u32);
    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create a sprite folder: {}", e))?;
    for (i, data) in track.sprites.iter().enumerate() {
        std::fs::write(dir.join(format!("s{i}.png")), normalized_sprite_png(data, w, h)?).map_err(|e| format!("Failed to write a sprite: {}", e))?;
    }
    let mut blank = Vec::new();
    image::DynamicImage::ImageRgba8(image::RgbaImage::new(w, h))
        .write_to(&mut std::io::Cursor::new(&mut blank), image::ImageFormat::Png)
        .map_err(|e| format!("Failed to write a sprite: {}", e))?;
    std::fs::write(dir.join("blank.png"), blank).map_err(|e| format!("Failed to write a sprite: {}", e))?;

    let name = |sprite: i64| -> String {
        if sprite >= 0 && (sprite as usize) < track.sprites.len() {
            format!("s{sprite}.png")
        } else {
            "blank.png".to_string()
        }
    };
    // Boundaries rounded once, so the durations add up to exactly them (no drift over a long list).
    let at = |t: f64| ((t - shift).max(0.0) * 1e6).round() / 1e6;
    let mut list = String::from("ffconcat version 1.0\n");
    let mut cursor = 0.0;
    // Each picture opened at a microsecond frame rate: the list's timestamps take the first file's
    // timebase, and the image demuxer's default (1/25 s) rounded every run onto a 40 ms grid -
    // measured: a sprite meant for one 60 fps frame showed on the next.
    fn push(file: &str, until: f64, list: &mut String, cursor: &mut f64) {
        let d = until - *cursor;
        if d > 0.0 {
            list.push_str(&format!("file '{file}'\noption framerate 1000000\nduration {d:.6}\n"));
            *cursor = until;
        }
    }
    for (k, run) in track.runs.iter().enumerate() {
        let from = at(run.0);
        let until = at(track.runs.get(k + 1).map(|r| r.0).unwrap_or(track.end));
        if from > cursor {
            push("blank.png", from, &mut list, &mut cursor);
        }
        push(&name(run.1), until, &mut list, &mut cursor);
    }
    // Then nothing. The demuxer ignores a list's last duration, so the blank is listed twice.
    list.push_str("file 'blank.png'\noption framerate 1000000\nduration 1\nfile 'blank.png'\noption framerate 1000000\n");
    let path = dir.join("track.ffconcat");
    std::fs::write(&path, list).map_err(|e| format!("Failed to write a sprite list: {}", e))?;
    Ok(path)
}

// The ffmpeg input reading a sprite track's list.
pub(super) fn sprite_track_input(list: &Path) -> InputSpec {
    InputSpec { path: list.to_string_lossy().to_string(), pre_args: vec!["-f".into(), "concat".into(), "-safe".into(), "0".into()] }
}

// A value that holds from each point's time to the next, as an expression in `tvar` - a balanced
// tree of comparisons (a long pointer path has thousands of steps).
pub(super) fn step_expr(points: &[(f64, i64)], tvar: &str) -> String {
    fn build(points: &[(f64, i64)], lo: usize, hi: usize, tvar: &str) -> String {
        if lo == hi {
            return points[lo].1.to_string();
        }
        let mid = (lo + hi + 1) / 2;
        format!("if(lt({tvar},{:.6}),{},{})", points[mid].0, build(points, lo, mid - 1, tvar), build(points, mid, hi, tvar))
    }
    if points.is_empty() {
        return "0".into();
    }
    build(points, 0, points.len() - 1, tvar)
}

// One axis of a track's position over time (run times minus `shift`), changes only.
pub(super) fn sprite_track_axis(track: &SpriteTrack, shift: f64, value: impl Fn(&(f64, i64, i64, i64)) -> i64) -> String {
    let mut points: Vec<(f64, i64)> = Vec::new();
    for run in &track.runs {
        let v = value(run);
        if points.last().map_or(true, |p| p.1 != v) {
            points.push((run.0 - shift, v));
        }
    }
    step_expr(&points, "t")
}

// [main] with the sprite track read from input `input` laid over it, into [out].
pub(super) fn sprite_track_overlay(track: &SpriteTrack, input: usize, shift: f64, main: &str, tag: &str, out: &str) -> String {
    let x = sprite_track_axis(track, shift, |r| r.2);
    let y = sprite_track_axis(track, shift, |r| r.3);
    format!("[{input}:v]format=rgba[{tag}s];[{main}][{tag}s]overlay=x='{x}':y='{y}':eof_action=pass[{out}];")
}

// A segment's pointer layers as a fragment spliced into its chain (segment_effect_chain): the chain
// so far is named, each layer (read from `inputs`, timed from `shift` - the segment's first frame)
// laid over it in turn, and the chain carries on from the result.
pub(super) fn pointer_fragment(i: usize, layers: &[SpriteTrack], inputs: &[usize], shift: f64) -> String {
    let mut fragment = format!("[ptr{i}m];");
    let mut current = format!("ptr{i}m");
    for (k, (layer, input)) in layers.iter().zip(inputs).enumerate() {
        let out = format!("ptr{i}l{k}");
        fragment.push_str(&sprite_track_overlay(layer, *input, shift, &current, &format!("ptr{i}s{k}"), &out));
        current = out;
    }
    fragment.push_str(&format!("[{current}]null"));
    fragment
}

// The video scaled into the frame's hole, the backdrop (single frame, repeated) over it.
pub(super) fn screen_style_chain(input: &str, backdrop_input: usize, ss: &ScreenStyleSpec, (w, h): (i64, i64), out: &str) -> String {
    let cw = (ss.width.clamp(2, w) / 2) * 2;
    let ch = (ss.height.clamp(2, h) / 2) * 2;
    let cx = (ss.x.clamp(0, w - cw) / 2) * 2;
    let cy = (ss.y.clamp(0, h - ch) / 2) * 2;
    format!(
        "[{input}]scale={cw}:{ch},setsar=1,pad={w}:{h}:{cx}:{cy}:color=black[{out}c];[{backdrop_input}:v]format=rgba[{out}b];[{out}c][{out}b]overlay=0:0[{out}];"
    )
}

// When the first frame at or after `at` (seconds of the file's own timeline) is shown - what a
// segment trimmed from `at` counts its time from. Packets only, so it's quick.
pub(super) fn probe_first_frame_at(ffprobe_path: &PathBuf, path: &str, at: f64) -> Option<f64> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-read_intervals",
        &format!("{:.3}%{:.3}", (at - 3.0).max(0.0), at + 1.0),
        "-show_entries",
        "packet=pts_time:format=start_time",
        "-of",
        "json",
        path,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let out = cmd.output().ok()?;
    let probe: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let start = probe["format"]["start_time"].as_str().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
    probe["packets"]
        .as_array()?
        .iter()
        .filter_map(|p| p["pts_time"].as_str()?.parse::<f64>().ok())
        .map(|t| t - start)
        .filter(|t| *t >= at - 1e-6)
        .fold(None, |best: Option<f64>, t| Some(best.map_or(t, |b| b.min(t))))
}

// ---- Smart render (plain cuts) ------------------------------------------------------------------
//
// See services/smart_render.rs for the idea. This runs it: every piece of every clip (copied GOPs,
// re-encoded edges) and the audio as independent ffmpeg jobs at once, joins the pieces into an
// avc3 MP4, then checks the result - the exact frame count and a clean decode across every join -
// before trusting it. Ok(None) means "not this time" (not eligible, or the result didn't check
// out) and the caller renders normally; nothing a user sees ever depends on smart render working.

// The re-encoded edges are a second of video or two around each cut: encode them at a quality
// well above any export tier, so they sit invisibly between the untouched copied stretches.
pub(super) const SMART_EDGE_CRF: &str = "16";

pub(super) struct SmartJob {
    pub(super) args: Vec<String>,
}

// Runs `jobs` as concurrent ffmpeg processes (at most `parallel` at once), reporting progress as
// each finishes. Stops everything on the first failure or when the user cancels.
pub(super) fn run_smart_jobs(
    ffmpeg: &std::path::Path,
    jobs: Vec<SmartJob>,
    parallel: usize,
    cancelled: &std::sync::atomic::AtomicBool,
    mut on_done: impl FnMut(usize, usize),
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let total = jobs.len();
    let mut queue = jobs.into_iter();
    let mut running: Vec<std::process::Child> = Vec::new();
    let mut done = 0;
    let kill_all = |running: &mut Vec<std::process::Child>| {
        for child in running.iter_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    };
    loop {
        while running.len() < parallel.max(1) {
            let Some(job) = queue.next() else { break };
            let mut cmd = Command::new(ffmpeg);
            #[cfg(windows)]
            hide_console_window(&mut cmd);
            cmd.args(&job.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
            running.push(cmd.spawn().map_err(|e| format!("Failed to start ffmpeg: {}", e))?);
        }
        if running.is_empty() {
            return Ok(());
        }
        if cancelled.load(Ordering::SeqCst) {
            kill_all(&mut running);
            return Err("Export cancelled".to_string());
        }
        let mut i = 0;
        while i < running.len() {
            match running[i].try_wait() {
                Ok(Some(status)) => {
                    let mut child = running.swap_remove(i);
                    if !status.success() {
                        let mut err = String::new();
                        if let Some(mut stderr) = child.stderr.take() {
                            let _ = std::io::Read::read_to_string(&mut stderr, &mut err);
                        }
                        kill_all(&mut running);
                        return Err(format!("A smart render piece failed: {}", err.trim()));
                    }
                    done += 1;
                    on_done(done, total);
                }
                Ok(None) => i += 1,
                Err(e) => {
                    kill_all(&mut running);
                    return Err(format!("Lost track of an ffmpeg job: {}", e));
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

// What one smart render runs: a job per piece (each to its own .ts in `work`), the audio job,
// the concat list joining the pieces in order, where the joins fall (output seconds), the total
// length and the exact frame count to verify against.
pub(super) struct SmartBuild {
    pub(super) jobs: Vec<SmartJob>,
    pub(super) list: String,
    pub(super) joins: Vec<f64>,
    pub(super) seconds: f64,
    pub(super) expected_frames: usize,
    pub(super) audio_out: PathBuf,
}

pub(super) fn smart_render_jobs(
    segments: &[KeepSegment],
    plans: &[Vec<crate::services::smart_render::Piece>],
    video: &crate::services::smart_render::SourceVideo,
    has_audio: &[bool],
    volume: f64,
    work: &std::path::Path,
) -> Result<SmartBuild, String> {
    use crate::services::smart_render::Piece;
    let fps = video.fps();
    let rate = format!("{}/{}", video.fps_num, video.fps_den);
    let expected_frames: usize = plans.iter().flatten().map(Piece::frames).sum();
    let eps = 0.25 / fps;
    let mut jobs = Vec::new();
    let mut list = String::new();
    let mut joins = Vec::new();
    let mut at = 0.0;
    for (seg, plan) in segments.iter().zip(plans) {
        for piece in plan {
            let out = work.join(format!("p{:05}.ts", jobs.len()));
            let out_str = path_to_str(&out)?.to_string();
            let args: Vec<String> = match piece {
                Piece::Copy { start, frames, .. } => vec![
                    "-v".into(), "error".into(), "-ss".into(), format!("{start:.6}"), "-i".into(), seg.source_path.clone(),
                    "-map".into(), "0:v:0".into(), "-frames:v".into(), frames.to_string(), "-c:v".into(), "copy".into(),
                    "-bsf:v".into(), "h264_mp4toannexb".into(), "-an".into(), "-sn".into(), "-dn".into(),
                    "-f".into(), "mpegts".into(), "-muxdelay".into(), "0".into(), "-muxpreload".into(), "0".into(), "-y".into(), out_str.clone(),
                ],
                Piece::Encode { start, end, frames } => {
                    let seek = (start - 1.0).max(0.0);
                    vec![
                        "-v".into(), "error".into(), "-ss".into(), format!("{seek:.6}"), "-i".into(), seg.source_path.clone(),
                        "-map".into(), "0:v:0".into(),
                        "-vf".into(), format!("trim=start={:.6}:end={:.6},setpts=PTS-STARTPTS,fps={rate}", start - seek - eps, end - seek - eps),
                        "-frames:v".into(), frames.to_string(), "-an".into(), "-sn".into(), "-dn".into(),
                        "-c:v".into(), "libx264".into(), "-preset".into(), "medium".into(), "-crf".into(), SMART_EDGE_CRF.into(), "-pix_fmt".into(), "yuv420p".into(),
                        "-f".into(), "mpegts".into(), "-muxdelay".into(), "0".into(), "-muxpreload".into(), "0".into(), "-y".into(), out_str.clone(),
                    ]
                }
            };
            jobs.push(SmartJob { args });
            let secs = piece.frames() as f64 / fps;
            list.push_str(&format!("file '{}'\nduration {secs:.6}\n", out_str.replace('\'', "'\\''")));
            at += secs;
            joins.push(at);
        }
    }
    joins.pop(); // the end of the last piece isn't a join

    // The audio: every clip's sound, trimmed exactly, joined, at the track volume (seeking inputs).
    let audio_out = work.join("audio.m4a");
    {
        let mut args: Vec<String> = vec!["-v".into(), "error".into()];
        let mut graph = String::new();
        let mut joined = String::new();
        for (i, (seg, plan)) in segments.iter().zip(plans).enumerate() {
            let seek = segment_input_seek(seg);
            // Exactly as long as the clip's video (whole frames), so sound and picture stay locked
            // across any number of cuts instead of drifting by a fraction of a frame at each.
            let seconds = plan.iter().map(Piece::frames).sum::<usize>() as f64 / fps;
            args.extend(["-ss".into(), format!("{seek:.6}"), "-i".into(), seg.source_path.clone()]);
            graph.push_str(&audio_trim_chain(has_audio[i], i, seg.start - seek, seg.start - seek + seconds, 1.0, &(Vec::new(), None), &format!("a{i}")));
            joined.push_str(&format!("[a{i}]"));
        }
        graph.push_str(&format!("{joined}concat=n={}:v=0:a=1,volume={volume:.3}[outa]", segments.len()));
        args.extend(["-filter_complex".into(), graph, "-map".into(), "[outa]".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "128k".into(), "-y".into(), path_to_str(&audio_out)?.to_string()]);
        jobs.push(SmartJob { args });
    }
    Ok(SmartBuild { jobs, list, joins, seconds: at, expected_frames, audio_out })
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn smart_render_export(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    segments: &[KeepSegment],
    has_audio: &[bool],
    volume: f64,
    progress_key: &str,
    output: PathBuf,
) -> Result<Option<String>, String> {
    use crate::services::smart_render::{plan_clip, probe_packets, probe_source, Piece, SourceVideo};
    let ext = output.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    // MP4 only: avc3 (parameter sets in-stream) is an MP4 sample entry; a .mov keeps one set.
    if !matches!(ext.as_str(), "mp4" | "m4v") || segments.is_empty() {
        return Ok(None);
    }
    let ffmpeg = get_ffmpeg_path(app_handle)?;
    let ffprobe = get_ffprobe_path(app_handle)?;

    // Every clip's source must be copyable, and all of them alike (one stream can't change size
    // or rate mid-file). Then each clip's split, from its source's packet index.
    let owned: Vec<(String, f64, f64)> = segments.iter().map(|s| (s.source_path.clone(), s.start, s.end)).collect();
    let probe = ffprobe.clone();
    let planned = blocking(move || -> Option<(SourceVideo, Vec<Vec<Piece>>)> {
        let mut video: Option<SourceVideo> = None;
        let mut sources: HashMap<String, SourceVideo> = HashMap::new();
        let mut plans = Vec::with_capacity(owned.len());
        for (path, start, end) in &owned {
            let v = match sources.get(path) {
                Some(v) => v.clone(),
                None => {
                    let v = probe_source(&probe, path)?;
                    sources.insert(path.clone(), v.clone());
                    v
                }
            };
            if !v.copyable() || video.as_ref().is_some_and(|first| (first.width, first.height, first.fps_num, first.fps_den) != (v.width, v.height, v.fps_num, v.fps_den)) {
                return None;
            }
            let packets = probe_packets(&probe, path, (start - 1.0).max(0.0), end + 1.0)?;
            let plan = plan_clip(&packets, *start, *end, v.fps());
            if plan.is_empty() {
                return None;
            }
            plans.push(plan);
            video.get_or_insert(v);
        }
        Some((video?, plans))
    })
    .await?;
    let Some((video, plans)) = planned else { return Ok(None) };
    // Worth it only when something is actually copied.
    if !plans.iter().flatten().any(|p| matches!(p, Piece::Copy { .. })) {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let work = std::env::temp_dir().join(format!("briefcast_smart_{}_{stamp}", std::process::id()));
    std::fs::create_dir_all(&work).map_err(|e| format!("Failed to create a work folder: {}", e))?;
    let _cleanup = TempDir(work.clone());
    let SmartBuild { jobs, list, joins, seconds: at, expected_frames, audio_out } = smart_render_jobs(segments, &plans, &video, has_audio, volume, &work)?;

    // Run them all, a few at once.
    let parallel = std::thread::available_parallelism().map(|n| n.get() / 2).unwrap_or(2).clamp(1, 4);
    let cancelled = state.cancelled.clone();
    let progress_window = window.clone();
    let key = progress_key.to_string();
    let output_name = output.to_string_lossy().to_string();
    let ffmpeg_jobs = ffmpeg.clone();
    cancelled.store(false, std::sync::atomic::Ordering::SeqCst);
    let ran = blocking(move || {
        run_smart_jobs(&ffmpeg_jobs, jobs, parallel, &cancelled, |done, total| {
            let progress = done as f64 / total as f64 * 90.0;
            let _ = progress_window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: key.clone(),
                    output_path: output_name.clone(),
                    progress,
                    status: ConversionStatus::Processing,
                    message: format!("Converting... {:.1}%", progress),
                },
            );
        })
    })
    .await?;
    if let Err(e) = ran {
        if state.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(e);
        }
        log::warn!("Smart render fell back to a full render: {}", e);
        return Ok(None);
    }

    // Join: the pieces in order (each with its own parameter sets - avc3), with the audio.
    let list_path = work.join("pieces.txt");
    std::fs::write(&list_path, list).map_err(|e| format!("Failed to write the piece list: {}", e))?;
    let inputs = [
        InputSpec { path: path_to_str(&list_path)?.to_string(), pre_args: vec!["-f".into(), "concat".into(), "-safe".into(), "0".into()] },
        InputSpec::plain(path_to_str(&audio_out)?.to_string()),
    ];
    let mux_args = ["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-tag:v", "avc3", "-movflags", "+faststart"];
    let written = match run_conversion_timed(app_handle, window, state, &inputs, progress_key, output, &mux_args, Some(at)).await {
        Ok(path) => path,
        Err(e) if state.cancelled.load(std::sync::atomic::Ordering::SeqCst) => return Err(e),
        Err(e) => {
            log::warn!("Smart render's join failed, falling back to a full render: {}", e);
            return Ok(None);
        }
    };

    // Check it: exactly the frames planned, and every join decodes cleanly.
    let check_path = written.clone();
    let ok = blocking(move || {
        let mut cmd = Command::new(&ffprobe);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", &check_path]);
        let count = cmd.output().ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<usize>().ok());
        if count != Some(expected_frames) {
            log::warn!("Smart render produced {:?} frames, expected {}", count, expected_frames);
            return false;
        }
        joins.iter().all(|&j| {
            let mut cmd = Command::new(&ffmpeg);
            #[cfg(windows)]
            hide_console_window(&mut cmd);
            cmd.args(["-v", "error", "-ss", &format!("{:.6}", (j - 1.0).max(0.0)), "-i", &check_path, "-t", "2", "-map", "0:v:0", "-f", "null", "-"]);
            match cmd.output() {
                Ok(o) => o.status.success() && String::from_utf8_lossy(&o.stderr).trim().is_empty(),
                Err(_) => false,
            }
        })
    })
    .await?;
    if !ok {
        log::warn!("Smart render's result didn't verify - falling back to a full render");
        let _ = std::fs::remove_file(&written);
        return Ok(None);
    }
    Ok(Some(written))
}

