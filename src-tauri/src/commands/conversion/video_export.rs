// Video timeline export, filter graphs, frame stills, and reversed/stabilized clip previews.
use super::*;

// A per-segment Ken Burns zoom/pan - see ken_burns_chain. `intensity` is optional (None means
// "moderate", matching ClipKenBurns.intensity's own undefined-means-0.5 convention in
// videoEditTypes.ts) since the frontend only sends it once a user has actually touched the
// slider away from its default.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipKenBurns {
    pub preset: String,
    pub intensity: Option<f64>,
    // Where "zoom-in"/"zoom-out" center their crop window - fraction of the source frame, None
    // means the frame's own center (0.5, 0.5). Ignored by "pan-left"/"pan-right". See
    // ClipKenBurns's own doc comment (videoEditTypes.ts) for why this exists (centering an
    // auto-zoom punch-in on a recorded click position instead of the frame's middle).
    pub target_x: Option<f64>,
    pub target_y: Option<f64>,
    // The part of the move (0..1) this clip plays - a piece split out of a Ken Burns clip
    // continues the move (kenBurnsWindow, videoColorFilters.ts). None = all of it.
    pub span: Option<[f64; 2]>,
}

// A free-form crop window into this segment's own frame - see crop_chain. NOT locked to the
// source frame's own aspect ratio (independent width/height), matching ClipCrop's own doc comment
// in videoEditTypes.ts: since the cropped region's own aspect generally won't match the export's
// fixed output resolution, crop_chain's trailing `scale=out_w:out_h` stretches it to fill rather
// than letterboxing/padding.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

// A crossfade transition INTO this segment from whichever segment immediately precedes it -
// see the has_transitions fold in export_trimmed_video. Meaningless on segments[0] (nothing
// precedes it) - never read for that index.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipTransitionIn {
    #[serde(rename = "type")]
    pub transition_type: String, // "crossfade" - only variant in v1
    pub duration: f64, // seconds
    // How a light leak / flash / bar open looks (TransitionLook, videoEditTypes.ts). Every field
    // is parsed/clamped before reaching the filter graph (transition_window_graph).
    #[serde(default)]
    pub look: Option<TransitionLook>,
}

#[derive(Debug, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransitionLook {
    pub color: Option<String>,
    pub intensity: Option<f64>,
    pub direction: Option<String>,
    pub size: Option<f64>,
    pub orientation: Option<String>,
    // Iris: the shape the new clip opens out of. Only ever matched against known names.
    pub shape: Option<String>,
    // Page curl: the corner/edge it lifts from and its motion curve (both matched against known
    // names), and how much of the picture shows through the back of the page (clamped 0..1).
    pub peel_from: Option<String>,
    pub easing: Option<String>,
    pub see_through: Option<f64>,
    // Wipe / circle / clock wipe edge softness, clamped 0..1.
    pub softness: Option<f64>,
}

// A numeric look field clamped to [lo, hi], or `default` when unset or not a finite number.
pub(crate) fn look_num(v: Option<f64>, default: f64, lo: f64, hi: f64) -> f64 {
    v.filter(|x| x.is_finite()).unwrap_or(default).clamp(lo, hi)
}

// "#rrggbb" -> (r, g, b); anything else -> None.
pub(crate) fn parse_hex_color(color: &str) -> Option<(f64, f64, f64)> {
    let hex = color.trim().strip_prefix('#')?;
    if hex.len() != 6 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let ch = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok().map(f64::from);
    Some((ch(0)?, ch(2)?, ch(4)?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepSegment {
    pub source_path: String,
    pub start: f64,
    pub end: f64,
    pub color_filter: Option<ClipColorFilter>,
    pub ken_burns: Option<ClipKenBurns>,
    pub transition_in: Option<ClipTransitionIn>,
    pub crop: Option<ClipCrop>,
    // Horizontal mirror, applied first (before crop/Ken Burns) so crop/pan coordinates always
    // describe the already-mirrored frame the same way the live preview's own CSS transform order
    // does (VideoPlayer.tsx). None/false means the pre-existing unmirrored look.
    pub flip_horizontal: Option<bool>,
    // Playback-rate multiplier for just this segment - None/1 means unchanged. See Clip.speed's
    // own doc comment (videoEditTypes.ts) for the full "this changes the segment's own OUTPUT
    // duration" story; segment_speed() below is what actually clamps/defaults this.
    pub speed: Option<f64>,
    // Background-noise reduction strength, 0..1 - None/0 means off. VideoPlayer.tsx runs a
    // perceptually-similar (not bit-identical) live preview of this via a Web Audio worklet;
    // segment_noise_reduction_params() below is what actually clamps/maps this value onto afftdn's
    // own `nr`/`nf` parameter pair for the real export-time filter.
    pub noise_reduction: Option<f64>,
    // How noise_reduction is applied plus the extra cleanup stages around it - see AudioCleanup.
    pub audio_cleanup: Option<AudioCleanup>,
    // The clip's color grade baked to .cube text by the frontend (colorGrade.ts) - the exact table
    // its WebGL preview draws with, applied here with lut3d so the export matches it.
    pub lut_cube: Option<String>,
    // Camera-shake removal (vidstab, two passes) - see stabilization_transforms.
    pub stabilize: Option<StabilizeSettings>,
    // A speed ramp: the clip's range as consecutive constant-speed steps (clipTiming.ts - the same
    // steps the preview plays). Rendered as ONE segment - a single piecewise setpts for the picture
    // and per-step atempo for the sound - so the ramp's length is exact (joining the steps as
    // separate segments rounded every join to a whole frame: 0.17s drift over 16 steps). When set,
    // `speed` is ignored.
    pub speed_steps: Option<Vec<SpeedStep>>,
    // The clip's own sound is silenced (Clip.muted) - e.g. the quick cuts of a highlight intro,
    // which play over music. Rendered as silence of the segment's exact length.
    #[serde(default)]
    pub muted: Option<bool>,
    // An effect over the clip's whole picture (services/clip_fx.rs) - after its look, before the
    // vignette preset's layer.
    #[serde(default)]
    pub fx: Option<ClipFx>,
    // The editor-drawn pointer of an "Editable pointer" recording (pointerTrack.ts): its ripples and
    // cursor as sprite tracks timed in the source's own seconds, laid onto the clip's picture before
    // its crop and zoom (so they zoom with it) - see segment_effect_chain.
    #[serde(default)]
    pub pointer_layers: Option<Vec<SpriteTrack>>,
    // The source's own frame rate - what Ken Burns clocks itself by (ken_burns_chain). Filled in by
    // export_trimmed_video before the graph is built; never sent by the frontend.
    #[serde(skip)]
    pub source_fps: Option<f64>,
    // Fitted into the frame over a blurred copy of itself rather than black bars (a canvas's "Blur"
    // background - canvasFormats.ts), with this number keeping its filter labels apart from other
    // segments'. Filled in by export_trimmed_video; never sent by the frontend.
    #[serde(skip)]
    pub fit_blur: Option<usize>,
    // A still already fitted (and mirrored) into the frame before it's repeated into a stream
    // (still_image_input_chain), so its effect chain starts after that. Filled in by
    // export_trimmed_video; never sent by the frontend.
    #[serde(skip)]
    pub prefitted: bool,
}

pub(super) fn has_pointer_layers(seg: &KeepSegment) -> bool {
    seg.pointer_layers.as_ref().is_some_and(|l| !l.is_empty())
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedStep {
    pub source_start: f64,
    pub source_end: f64,
    pub speed: f64,
}

pub(super) fn clamp_speed(speed: f64) -> f64 {
    speed.max(0.25).min(16.0)
}

// The segment's steps relative to its own start: (from, to, speed) in source seconds. A plain
// segment is one step.
pub(super) fn segment_steps(seg: &KeepSegment) -> Vec<(f64, f64, f64)> {
    match &seg.speed_steps {
        Some(steps) if !steps.is_empty() => steps
            .iter()
            .map(|st| ((st.source_start - seg.start).max(0.0), (st.source_end - seg.start).min(seg.end - seg.start), clamp_speed(st.speed)))
            .filter(|(a, b, _)| b > a)
            .collect(),
        _ => vec![(0.0, seg.end - seg.start, segment_speed(seg))],
    }
}

// How long the segment plays for in the OUTPUT - what every transition offset and silent-audio
// length is measured in.
pub(super) fn segment_output_duration(seg: &KeepSegment) -> f64 {
    segment_steps(seg).iter().map(|(a, b, sp)| (b - a) / sp).sum::<f64>().max(0.0)
}

// The picture's speed change, applied after the clip's effects (so Ken Burns and friends run on
// the clip's own source time, exactly as the preview computes them): one setpts - a plain divide
// for constant speed, a continuous piecewise map for a ramp.
pub(super) fn segment_speed_filter(seg: &KeepSegment) -> String {
    let steps = segment_steps(seg);
    if steps.len() <= 1 {
        let speed = steps.first().map(|s| s.2).unwrap_or(1.0);
        return format!("setpts=PTS/{:.4}", speed);
    }
    let mut out_before = Vec::with_capacity(steps.len());
    let mut acc = 0.0;
    for (a, b, sp) in &steps {
        out_before.push(acc);
        acc += (b - a) / sp;
    }
    let last = steps.len() - 1;
    let mut expr = format!("({:.6}+(T-{:.6})/{:.6})", out_before[last], steps[last].0, steps[last].2);
    for i in (0..last).rev() {
        expr = format!(
            "if(lt(T,{:.6}),({:.6}+(T-{:.6})/{:.6}),{})",
            steps[i + 1].0, out_before[i], steps[i].0, steps[i].2, expr
        );
    }
    format!("setpts='({})/TB'", expr)
}

// The video branch of one segment: trim to its range, effects, then its speed.
pub(super) fn segment_video_chain(input: &str, seg: &KeepSegment, extra: &str) -> String {
    segment_video_chain_with_tail(input, seg, extra, 0.0)
}

// The same, reading `tail` source seconds past the segment's end - the tail handle a transition
// out of it plays (transition_tail). Effects are unchanged by it: Ken Burns holds its end state
// past the clip's own length, and the speed map's last step simply continues.
pub(super) fn segment_video_chain_with_tail(input: &str, seg: &KeepSegment, extra: &str, tail: f64) -> String {
    format!(
        "{input}trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS{extra},{}",
        seg.start,
        seg.end + tail.max(0.0),
        segment_speed_filter(seg)
    )
}

// How long the transition INTO `seg` plays, in output seconds - at most 90% of `seg`, the same
// clamp transition_fold_step applies. None when it has none.
pub(super) fn transition_window(seg: &KeepSegment) -> Option<f64> {
    seg.transition_in
        .as_ref()
        .filter(|tr| tr.duration > 0.0)
        .map(|tr| tr.duration.min(segment_output_duration(seg) * 0.9).max(0.05))
}

// Source seconds to read past a segment's end so it can keep PLAYING through the next clip's
// transition (window `d` output seconds) instead of freezing - at the speed it ends on, plus a
// little slack. Zero for a stabilized clip: its camera-path analysis covers only its own frames
// (stabilization_transforms), so it holds its last frame instead (as the preview does,
// TransitionPreviewLayer's hasMovingTail). A still's tail is the same picture either way.
pub(super) fn tail_source_seconds(seg: &KeepSegment, d: f64) -> f64 {
    if seg.stabilize.is_some() {
        return 0.0;
    }
    let end_speed = segment_steps(seg).last().map(|s| s.2).unwrap_or(1.0);
    d * end_speed + 0.1
}

// Splits a segment's (tail-extended) picture `[src]` into the segment itself `[main]`, exactly
// `dur` output seconds, and its tail `[tail]`: the next `d` seconds, timed from 0 - the outgoing
// side of the transition into the next clip. Padded with the segment's last frame first, so the
// tail is always a full `d` long even when the source file ends at (or soon after) the cut.
pub(super) fn transition_tail(src: &str, main: &str, tail: &str, dur: f64, d: f64, fps: f64) -> String {
    format!(
        "[{src}]tpad=stop_mode=clone:stop_duration={d:.3},split[{src}m][{src}t];\
         [{src}m]trim=end={dur:.6}[{main}];\
         [{src}t]trim=start={dur:.6},setpts=PTS-STARTPTS,fps={fps:.3},settb=AVTB,trim=end={d:.3}[{tail}];"
    )
}

pub(super) const RAMP_AUDIO_LOOKAHEAD: f64 = 0.25;

// The audio branch of one segment. A ramp gets its cleanup on the source timeline first (where a
// noise sample's times mean what they say), then each step's tempo, joined sample-accurately.
pub(super) fn segment_audio_chain(
    has_audio: bool,
    input_index: usize,
    seg: &KeepSegment,
    cleanup: &(Vec<String>, Option<(f64, f64)>),
    out_label: &str,
) -> String {
    let steps = segment_steps(seg);
    let has_audio = has_audio && !seg.muted.unwrap_or(false);
    if steps.len() <= 1 || !has_audio {
        if !has_audio {
            return format!(
                "anullsrc=channel_layout=stereo:sample_rate=44100:duration={:.3}[{}];",
                segment_output_duration(seg).max(0.01),
                out_label
            );
        }
        return audio_trim_chain(true, input_index, seg.start, seg.end, steps[0].2, cleanup, out_label);
    }
    let clean = format!("{}_src", out_label);
    let mut graph = audio_branch(&format!("[{}:a]", input_index), seg.start, seg.end, 1.0, &cleanup.0, cleanup.1, &clean);
    let split: String = (0..steps.len()).map(|i| format!("[{}_p{}]", out_label, i)).collect();
    graph.push_str(&format!("[{clean}]asplit={}{split};", steps.len()));
    let mut joined = String::new();
    // Each atempo drops its last partial window (~17ms) when its input ends - 0.27s lost over 16
    // steps. So each step reads a little past its end (silence past the clip's own end) and is then
    // trimmed to exactly its output length.
    for (i, (a, b, sp)) in steps.iter().enumerate() {
        graph.push_str(&format!(
            "[{out}_p{i}]atrim=start={a:.6}:end={lookahead:.6},asetpts=PTS-STARTPTS,apad=pad_dur={RAMP_AUDIO_LOOKAHEAD},{tempo},atrim=end={len:.6}[{out}_q{i}];",
            out = out_label,
            lookahead = b + RAMP_AUDIO_LOOKAHEAD,
            tempo = atempo_chain(*sp),
            len = (b - a) / sp
        ));
        joined.push_str(&format!("[{}_q{}]", out_label, i));
    }
    graph.push_str(&format!("{joined}concat=n={}:v=0:a=1[{out_label}];", steps.len()));
    graph
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StabilizeSettings {
    // 0..1 - how much camera movement is smoothed away (more = steadier, but crops in further).
    pub strength: f64,
}

// vidstabtransform's smoothing window (frames each side) for a 0..1 strength: 0.5 -> 25 frames,
// close to tripod-like steadiness for handheld footage without looking floaty.
pub(super) fn stabilize_smoothing(strength: f64) -> u32 {
    (5.0 + strength.clamp(0.0, 1.0) * 40.0).round() as u32
}

// Pass 1 of stabilization: vidstabdetect over exactly the frames this clip uses (the same
// trim+setpts the export applies, so frame numbers line up with pass 2), cached per source file +
// range so it runs once however often the clip is exported or previewed.
pub(super) async fn stabilization_transforms(app_handle: &AppHandle, source_path: &str, start: f64, end: f64) -> Result<PathBuf, String> {
    let input = PathBuf::from(source_path);
    let cache_path = preview_cache_path(&input, "stabilize_v1", &format!("{:.3}_{:.3}.trf", start, end))?;
    if cache_path.exists() {
        return Ok(cache_path);
    }
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create stabilization cache: {}", e))?;
    }
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let partial = cache_path.with_extension("partial.trf");
    let filter = format!(
        "trim=start={:.3}:end={:.3},setpts=PTS-STARTPTS,vidstabdetect=shakiness=6:accuracy=12:result='{}'",
        start,
        end,
        escape_filter_path(&partial)
    );
    let source = source_path.to_string();
    let partial_for_task = partial.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-y", "-i", &source, "-an", "-vf", &filter, "-f", "null", "-"]);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::piped());
        let result = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() || !partial_for_task.exists() {
            let _ = std::fs::remove_file(&partial_for_task);
            let stderr = String::from_utf8_lossy(&result.stderr);
            let reason = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("unknown error").to_string();
            return Err(format!("Couldn't analyse the clip for stabilization: {}", reason));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Stabilization task panicked: {e}"))??;
    std::fs::rename(&partial, &cache_path).map_err(|e| format!("Failed to keep stabilization data: {}", e))?;
    Ok(cache_path)
}

// A name for a file the editor derives from a clip, unique to its source, range and kind - so asking
// again for the same thing finds the file already made instead of rendering it twice.
pub(crate) fn derived_media_path(source_path: &str, kind: &str, key: &str, ext: &str) -> Result<PathBuf, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    source_path.hash(&mut hasher);
    key.hash(&mut hasher);
    let stem = std::path::Path::new(source_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".to_string());
    Ok(crate::services::utility::derived_media_dir()?.join(format!("{} {} {:08x}.{}", stem, kind, hasher.finish() as u32, ext)))
}



// Freeze frame: the frame at `time` (source seconds) as a full-resolution PNG, which the editor
// then uses as an ordinary image clip. Returns the PNG's path.
#[tauri::command]
pub async fn extract_frame_still(app_handle: AppHandle, source_path: String, time: f64) -> Result<String, String> {
    let out = derived_media_path(&source_path, "frame", &format!("{:.3}", time), "png")?;
    if out.exists() {
        return path_to_str(&out).map(|s| s.to_string());
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let partial = out.with_extension("partial.png");
    let args: Vec<String> = vec![
        "-ss".into(), format!("{:.3}", time.max(0.0)), "-i".into(), source_path.clone(),
        "-frames:v".into(), "1".into(), "-update".into(), "1".into(), path_to_str(&partial)?.to_string(),
    ];
    let task_partial = partial.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_ffmpeg_quiet(&ffmpeg_path, &args).and_then(|_| {
            if task_partial.exists() { Ok(()) } else { Err("no frame at that time".to_string()) }
        })
    })
    .await
    .map_err(|e| format!("Freeze frame task panicked: {e}"))?
    .map_err(|e| format!("Couldn't grab that frame: {}", e))?;
    std::fs::rename(&partial, &out).map_err(|e| format!("Failed to save the frame: {}", e))?;
    path_to_str(&out).map(|s| s.to_string())
}

// Where a "Merge clips" render goes (the timeline's clip menu): a new file in the editor's media
// folder next to reversed clips and frozen frames, named after the first clip's source. Each merge
// is its own file - unlike those, there's no fixed range to find an earlier render by.
#[tauri::command(async)]
pub fn merged_clip_output_path(source_path: String) -> Result<String, String> {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let out = derived_media_path(&source_path, "merged", &nonce.to_string(), "mp4")?;
    path_to_str(&out).map(|s| s.to_string())
}

// Deletes what a cancelled merge left behind (ffmpeg killed mid-write). Only ever a merge render in
// the editor's own media folder - anything else is refused, so this can't be pointed at user files.
#[tauri::command(async)]
pub fn discard_merged_clip(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let dir = crate::services::utility::derived_media_dir()?;
    let in_media_dir = target.parent().map(|p| p == dir.as_path()).unwrap_or(false);
    let is_merge = target.file_name().map(|n| n.to_string_lossy().contains(" merged ")).unwrap_or(false);
    if !in_media_dir || !is_merge {
        return Err("Not a merge render".to_string());
    }
    match std::fs::remove_file(&target) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Couldn't remove the cancelled merge: {}", e)),
    }
}

// How much of a clip is reversed at a time. ffmpeg's `reverse` holds every frame of its input in
// memory, so reversing a long clip in one go can take gigabytes; reversing it in short pieces and
// joining them last-to-first gives the identical result in bounded memory.
pub(super) const REVERSE_CHUNK_SECS: f64 = 5.0;

// Reverse: the clip's [start,end) range played backwards, picture and sound, as a new file the
// clip then points at (its original range is remembered so it can be un-reversed). Returns the
// file's path.
#[tauri::command]
pub async fn render_reversed_clip(app_handle: AppHandle, source_path: String, start: f64, end: f64) -> Result<String, String> {
    if end - start <= 0.05 {
        return Err("The clip is too short to reverse".to_string());
    }
    // v2 in the key: the first version lost frames (see `fps` below), so its files aren't reused.
    let out = derived_media_path(&source_path, "reversed", &format!("v3 {:.3}-{:.3}", start, end), "mp4")?;
    if out.exists() {
        return path_to_str(&out).map(|s| s.to_string());
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let has_audio = {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let path = source_path.clone();
        tauri::async_runtime::spawn_blocking(move || probe_has_audio(&ffprobe_path, &path)).await.unwrap_or(false)
    };
    // `reverse` drops the stream's frame rate, and ffmpeg then falls back to 25fps and silently
    // discards frames from a 30/60fps source - so every piece is re-timed at the source's own rate
    // (measured on a 30fps clip: 442 frames in, 372 out, before this).
    let fps = {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let path = source_path.clone();
        tauri::async_runtime::spawn_blocking(move || probe_frame_rate(&ffprobe_path, &path)).await.unwrap_or(30.0)
    };
    let work = std::env::temp_dir().join(format!("briefcast_reverse_{}_{:x}", std::process::id(), (start * 1000.0) as u64));
    std::fs::create_dir_all(&work).map_err(|e| format!("Failed to create a work folder: {}", e))?;
    let _cleanup = TempDir(work.clone());
    let source = source_path.clone();
    let out_for_task = out.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Pieces cut by FRAME number (not time), so they tile the range exactly - cutting by time let
        // each boundary round to an extra frame. Rendered reversed, listed last piece first; audio
        // is cut at the same frame boundaries' times.
        let mut list = String::new();
        let first_frame = (start * fps).round() as i64;
        let last_frame = ((end * fps).round() as i64).max(first_frame + 1);
        let chunk = ((REVERSE_CHUNK_SECS * fps).round() as i64).max(1);
        let mut pieces: Vec<(i64, i64)> = Vec::new();
        let mut f = first_frame;
        while f < last_frame {
            let next = (f + chunk).min(last_frame);
            pieces.push((f, next));
            f = next;
        }
        for (i, (fa, fb)) in pieces.iter().enumerate().rev() {
            let piece = work.join(format!("piece_{:04}.mp4", i));
            let (a, b) = (*fa as f64 / fps, *fb as f64 / fps);
            let mut args: Vec<String> = vec!["-i".into(), source.clone(), "-filter_complex".into()];
            let video = format!("[0:v]trim=start_frame={fa}:end_frame={fb},setpts=PTS-STARTPTS,reverse,setpts=N/({fps:.3}*TB)[v]");
            if has_audio {
                args.push(format!("{video};[0:a]atrim=start={a:.4}:end={b:.4},asetpts=PTS-STARTPTS,areverse[a]"));
                args.extend(["-map".into(), "[v]".into(), "-map".into(), "[a]".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
            } else {
                args.push(video);
                args.extend(["-map".into(), "[v]".into()]);
            }
            args.extend(["-r".into(), format!("{:.3}", fps), "-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "18".into(), "-pix_fmt".into(), "yuv420p".into()]);
            args.push(path_to_str(&piece)?.to_string());
            run_ffmpeg_quiet(&ffmpeg_path, &args).map_err(|e| format!("Couldn't reverse the clip: {}", e))?;
            list.push_str(&format!("file '{}'\n", path_to_str(&piece)?.replace('\\', "/").replace('\'', "'\\''")));
        }
        let list_path = work.join("pieces.txt");
        std::fs::write(&list_path, list).map_err(|e| format!("Failed to write the piece list: {}", e))?;
        let partial = out_for_task.with_extension("partial.mp4");
        let args: Vec<String> = vec![
            "-f".into(), "concat".into(), "-safe".into(), "0".into(), "-i".into(), path_to_str(&list_path)?.to_string(),
            "-c".into(), "copy".into(), "-movflags".into(), "+faststart".into(), path_to_str(&partial)?.to_string(),
        ];
        run_ffmpeg_quiet(&ffmpeg_path, &args).map_err(|e| format!("Couldn't join the reversed clip: {}", e))?;
        std::fs::rename(&partial, &out_for_task).map_err(|e| format!("Failed to save the reversed clip: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Reverse task panicked: {e}"))??;
    path_to_str(&out).map(|s| s.to_string())
}

// A work folder removed when dropped, whatever happens in between.
pub(super) struct TempDir(pub(super) PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// Pass 2, as a filter-chain fragment for segment_effect_chain. `optzoom=1` crops in just enough to
// hide the moving edges; the light unsharp makes up for the resampling softness.
pub(super) fn stabilize_chain(trf_path: &str, strength: f64) -> String {
    format!(
        ",vidstabtransform=input='{}':smoothing={}:optzoom=1:interpol=bicubic,unsharp=5:5:0.6:3:3:0.3",
        trf_path,
        stabilize_smoothing(strength)
    )
}

// A stabilized render of one clip's range (no other effects), for "Preview stabilized" in the clip
// viewer - stabilization needs the whole clip analysed first, so it can't preview live in the
// player. Cached per source + range + strength; 720p ultrafast, so it's quick to make.
#[tauri::command]
pub async fn stabilized_clip_preview(app_handle: AppHandle, source_path: String, start: f64, end: f64, strength: f64) -> Result<String, String> {
    let input = PathBuf::from(&source_path);
    let cache_path = preview_cache_path(&input, "stabilize_v1", &format!("{:.3}_{:.3}_{:.2}.mp4", start, end, strength))?;
    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    let trf = stabilization_transforms(&app_handle, &source_path, start, end).await?;
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let video = format!(
        "[0:v]trim=start={s:.3}:end={e:.3},setpts=PTS-STARTPTS{stab},scale=-2:'min(720,ih)'[v]",
        s = start,
        e = end,
        stab = stabilize_chain(&escape_filter_path(&trf), strength)
    );
    let has_audio = {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let path = source_path.clone();
        tauri::async_runtime::spawn_blocking(move || probe_has_audio(&ffprobe_path, &path))
            .await
            .unwrap_or(false)
    };
    let mut args: Vec<String> = vec!["-i".into(), source_path.clone(), "-filter_complex".into()];
    if has_audio {
        args.push(format!("{video};[0:a]atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS[a]"));
        args.extend(["-map".into(), "[v]".into(), "-map".into(), "[a]".into(), "-c:a".into(), "aac".into()]);
    } else {
        args.push(video);
        args.extend(["-map".into(), "[v]".into()]);
    }
    args.extend([
        "-c:v".into(), "libx264".into(), "-preset".into(), "ultrafast".into(), "-crf".into(), "23".into(),
        "-pix_fmt".into(), "yuv420p".into(), "-movflags".into(), "+faststart".into(),
    ]);
    encode_preview_proxy(ffmpeg_path, args, cache_path).await
}

// A platform format for the export (Shorts/Reels 9:16, square, 4:5...) and how the picture is
// fitted into it. Applied to the assembled video before overlays and captions, which are then
// drawn at this size - so captions sit properly in a vertical frame instead of being cropped off.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFrame {
    pub width: i64,
    pub height: i64,
    // "fit-blur" (whole picture over a blurred, zoomed copy of itself), "fit" (black bars), or
    // "fill" (cropped to fill).
    pub mode: String,
    // Fill only: where the crop window sits, 0..1 across the spare width/height (0.5 = centred).
    pub anchor_x: Option<f64>,
    pub anchor_y: Option<f64>,
    // Fill only, auto-reframe: the crop window's centre over the output timeline as knots
    // (seconds, x, y - fractions of the frame), eased between (reframeTrack.ts). Replaces the anchor.
    pub track: Option<Vec<[f64; 3]>>,
}

// A value through `knots` (time, value) over `tvar`: held before the first and after the last,
// smoothstep-eased between each pair, constant where a pair is equal (a hold). Built as a balanced
// tree of if()s - depth log2(n), so an hour of camera moves stays cheap per frame.
pub(super) fn eased_knots_expr(knots: &[(f64, f64)], tvar: &str) -> String {
    fn segment(a: (f64, f64), b: (f64, f64), tvar: &str) -> String {
        if (b.1 - a.1).abs() < 1e-6 {
            return format!("{:.5}", a.1);
        }
        let p = format!("clip(({tvar}-{:.4})/{:.4},0,1)", a.0, (b.0 - a.0).max(1e-3));
        format!("({:.5}+({:.5})*{p}*{p}*(3-2*{p}))", a.1, b.1 - a.1)
    }
    fn build(knots: &[(f64, f64)], lo: usize, hi: usize, tvar: &str) -> String {
        if lo == hi {
            return segment(knots[lo], knots[lo + 1], tvar);
        }
        let mid = (lo + hi) / 2;
        format!("if(lt({tvar},{:.4}),{},{})", knots[mid + 1].0, build(knots, lo, mid, tvar), build(knots, mid + 1, hi, tvar))
    }
    match knots.len() {
        0 => "0.5".into(),
        1 => format!("{:.5}", knots[0].1),
        n => build(knots, 0, n - 2, tvar),
    }
}

pub(super) fn reframe_chain(input: &str, output: &str, frame: &OutputFrame) -> String {
    let w = (frame.width.max(16) / 2) * 2;
    let h = (frame.height.max(16) / 2) * 2;
    match frame.mode.as_str() {
        "fill" if frame.track.as_ref().map_or(false, |t| !t.is_empty()) => {
            let track = frame.track.as_ref().unwrap();
            let mut sorted: Vec<[f64; 3]> = track.iter().filter(|k| k.iter().all(|v| v.is_finite())).cloned().collect();
            sorted.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal));
            let x = eased_knots_expr(&sorted.iter().map(|k| (k[0], k[1].clamp(0.0, 1.0))).collect::<Vec<_>>(), "t");
            let y = eased_knots_expr(&sorted.iter().map(|k| (k[0], k[2].clamp(0.0, 1.0))).collect::<Vec<_>>(), "t");
            // The window centred on the track, kept inside the frame.
            format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=increase,crop=w={w}:h={h}:x='clip(({x})*iw-ow/2,0,iw-ow)':y='clip(({y})*ih-oh/2,0,ih-oh)',setsar=1[{output}];")
        }
        "fill" => {
            let ax = frame.anchor_x.unwrap_or(0.5).clamp(0.0, 1.0);
            let ay = frame.anchor_y.unwrap_or(0.5).clamp(0.0, 1.0);
            if (ax - 0.5).abs() < 1e-6 && (ay - 0.5).abs() < 1e-6 {
                format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},setsar=1[{output}];")
            } else {
                format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}:(iw-ow)*{ax:.4}:(ih-oh)*{ay:.4},setsar=1[{output}];")
            }
        }
        "fit" => format!("[{input}]scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[{output}];"),
        _ => format!(
            "[{input}]split=2[rf_bg_in][rf_fg_in];\
             [rf_bg_in]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=luma_radius=40:luma_power=2,eq=brightness=-0.06[rf_bg];\
             [rf_fg_in]scale={w}:{h}:force_original_aspect_ratio=decrease[rf_fg];\
             [rf_bg][rf_fg]overlay=(W-w)/2:(H-h)/2,setsar=1[{output}];"
        ),
    }
}

// Files an export writes for ffmpeg to read (graded clips' LUTs), deleted when the export is done
// however it ends - success, failure or an early error return.
pub(super) struct TempFiles(pub(super) Vec<PathBuf>);
impl Drop for TempFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            let _ = std::fs::remove_file(path);
        }
    }
}

// Mirrors AudioCleanup (videoEditTypes.ts). None/default fields keep the original behaviour:
// spectral afftdn denoise only, no extra stages.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioCleanup {
    // "reduce" (afftdn) or "remove" (arnndn voice isolation). Anything else means "reduce".
    pub mode: Option<String>,
    pub low_cut: Option<bool>,
    // Mains frequency to notch out, 50 or 60 (anything else is ignored).
    pub hum: Option<u32>,
    pub gate: Option<bool>,
    // Loudness levelling (speechnorm + loudnorm) - evens out quiet and loud speakers.
    pub level: Option<bool>,
    // A noise-only stretch of the clip's own source file (source seconds) for "reduce" mode to
    // learn its profile from, instead of afftdn's built-in estimate - see audio_branch.
    pub noise_sample: Option<NoiseSample>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct NoiseSample {
    pub start: f64,
    pub end: f64,
}

// Longest noise sample afftdn is asked to learn from - a profile settles within a second or two,
// so anything longer is wasted decode time.
pub(super) const MAX_NOISE_SAMPLE_SECS: f64 = 10.0;

// One text or image overlay, already fully rendered client-side to a transparent PNG matching
// what the live preview shows (font/stroke/background/corner-radius for text; rotation/corner-
// radius/border/shadow for images - see videoOverlayRender.ts) - this command only knows about a
// flat image plus where/when to composite it, never about TextOverlay/ImageOverlay's own richer
// shape. `x`/`y` are already resolved to real output-video pixels by the frontend (it knows the
// loaded video's native width/height from the same hidden <video> element the timeline's filmstrip
// capture already uses), so no resolution lookup is needed on this side at all. `start_time`/
// `end_time` are seconds on the *output* (post-trim/concat) timeline, same space `segments` above
// occupies once trimmed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayImage {
    pub data_base64: String,
    pub x: i64,
    pub y: i64,
    pub start_time: f64,
    pub end_time: f64,
    // Mirrors OverlayAnimation (videoEditTypes.ts): "pop" scales per frame (overlay_pop_scale_expr),
    // slide-* moves via overlay_position_expr, fade fades the alpha. Sanitized against
    // ALLOWED_OVERLAY_ANIMATIONS the same way transition_type already is (sanitize_transition_name)
    // - interpolated directly into the filter_complex string, so this is a real security boundary.
    pub animation: String,
    // Keyframed motion (keyframes.ts): position/scale/opacity over time, replacing `animation`'s
    // slide when present. Already in output-video pixels and absolute output seconds.
    #[serde(default)]
    pub keyframes: Option<Vec<OverlayKeyframe>>,
    // An animated overlay (a shape/element - videoAssets.ts) as a PNG frame sequence instead of
    // one still: frame k shows at start_time + k/its fps. Frames repeat a lot (a looping
    // pulse, a held shape), so only the distinct images travel - `sequence[k]` indexes `unique`.
    // `data_base64` is unused when this is set.
    #[serde(default)]
    pub frames: Option<OverlayFrames>,
    // A CSS mix-blend-mode name ("multiply", "screen"...) - the preview's look - composited by
    // blend_composite. None/"normal" (or anything not in blend_mode_ffmpeg) is a plain overlay.
    #[serde(default)]
    pub blend_mode: Option<String>,
    // Composited over the screen frame (wallpaper and padding) rather than onto the picture inside
    // it, so it can sit on the padding - x/y are then on the whole frame. Only with a screen style.
    #[serde(default)]
    pub on_frame: bool,
}

// A Stage scene rendered for this export (stage_render.rs): its stored frames as an image sequence
// (straight-alpha PNGs, u000000.png...), the scene frame each one starts at, where the scene sits on
// the output timeline, and the rate it was rendered at. Composited above the video and its tracks
// and beneath pictures and text.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageLayerSpec {
    pub pattern: String,
    pub frames: Vec<u32>,
    pub start_time: f64,
    pub end_time: f64,
    pub fps: f64,
}

// The scene frame stored image N starts at, as an expression in N: a balanced tree of comparisons
// (as keyframe_expr builds), so a few thousand stored frames stay a shallow expression.
pub(super) fn frame_index_expr(frames: &[u32]) -> String {
    fn tree(frames: &[u32], lo: usize, hi: usize) -> String {
        if hi - lo == 1 {
            return frames[lo].to_string();
        }
        let mid = (lo + hi) / 2;
        format!("if(lt(N,{mid}),{},{})", tree(frames, lo, mid), tree(frames, mid, hi))
    }
    if frames.is_empty() { "0".to_string() } else { tree(frames, 0, frames.len()) }
}

// The filters putting a Stage layer (input `input`, rendered at the output frame's size) over
// [current], writing [out]. The image sequence is read with a timebase of one frame, so each stored
// image is re-timed to the scene frame it starts at plus the scene's start, in frames - rounded UP to
// a whole frame (setpts would otherwise truncate a start that isn't frame-aligned, as 29.97 fps
// starts rarely are, and show it a frame early), less a hair so a whole number stays itself. The
// last stored image holds (eof_action=repeat) until the scene's end, where `enable` lets go of it.
pub(super) fn stage_layer_chain(layer: &StageLayerSpec, input: usize, current: &str, tag: &str, out: &str) -> String {
    format!(
        "[{input}:v]format=rgba,setpts='ceil({idx}+{start:.9}-0.000001)'[{tag}];\
         [{current}][{tag}]overlay=x=0:y=0:eof_action=repeat:enable='between(t,{s:.4},{e:.4})'[{out}];",
        idx = frame_index_expr(&layer.frames),
        start = layer.start_time * layer.fps,
        s = layer.start_time,
        e = layer.end_time,
    )
}

#[cfg(test)]
pub(crate) fn stage_layer_chain_for_test(layer: &StageLayerSpec, input: usize, current: &str, tag: &str, out: &str) -> String {
    stage_layer_chain(layer, input, current, tag, out)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayFrames {
    pub unique: Vec<String>,
    pub sequence: Vec<u32>,
    // The rate the frames were drawn at (get_export_frame_rate) - None is DEFAULT_OVERLAY_FPS, what
    // every sequence was drawn at before the rate followed the video.
    #[serde(default)]
    pub fps: Option<f64>,
}

impl OverlayFrames {
    pub(super) fn rate(&self) -> f64 {
        self.fps.filter(|f| f.is_finite() && *f >= 1.0).map_or(DEFAULT_OVERLAY_FPS, |f| f.min(MAX_OVERLAY_FPS))
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayKeyframe {
    pub time: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub opacity: f64,
    // How the motion eases from this keyframe to the next: "linear", "ease", "ease-in",
    // "ease-out" or "hold" (stays put, then jumps). Matches easeKeyframe (keyframes.ts).
    pub easing: String,
}

// Overlay inputs (PNG stills, frame sequences, masks) run at the video's own rate - a 60fps
// recording's titles, stickers and keyframed scale/opacity move at 60, not every other frame. The
// rate also maps frames to seconds for a keyframed scale (which, in this ffmpeg, can only follow
// time through the frame number `n`). Capped at MAX_OVERLAY_FPS: a 120fps source would double every
// animated overlay's frames for motion few screens show.
pub(super) const DEFAULT_OVERLAY_FPS: f64 = 30.0;
pub(super) const MAX_OVERLAY_FPS: f64 = 60.0;

pub(crate) fn overlay_rate(video_fps: f64) -> f64 {
    if video_fps.is_finite() && video_fps >= 1.0 {
        video_fps.min(MAX_OVERLAY_FPS)
    } else {
        DEFAULT_OVERLAY_FPS
    }
}

// The rate an export of these sources runs at: the first video's (an image has no rate of its own -
// ffprobe reports image2's arbitrary 25), else IMAGE_SEGMENT_FPS for an all-image timeline. The
// transitions path pins every segment to it; overlays animate at overlay_rate of it.
pub(super) fn export_video_fps<'a>(ffprobe_path: &PathBuf, source_paths: impl IntoIterator<Item = &'a str>) -> f64 {
    match source_paths.into_iter().find(|p| !is_still_image_path(p)) {
        Some(path) => probe_frame_rate(ffprobe_path, path),
        None => IMAGE_SEGMENT_FPS,
    }
}

// The rate the editor draws animated overlays at for an export of these sources - the same rate
// export_trimmed_video reads them at, so a frame sequence lines up with the video frame for frame.
#[tauri::command]
pub async fn get_export_frame_rate(app_handle: AppHandle, source_paths: Vec<String>) -> Result<f64, String> {
    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    blocking(move || overlay_rate(export_video_fps(&ffprobe_path, source_paths.iter().map(String::as_str)))).await
}

pub(super) fn easing_expr(easing: &str, p: &str) -> String {
    match easing {
        "ease" => format!("({p})*({p})*(3-2*({p}))"),
        "ease-in" => format!("({p})*({p})"),
        "ease-out" => format!("(1-(1-({p}))*(1-({p})))"),
        "hold" => "0".to_string(),
        _ => p.to_string(),
    }
}

// easing_expr's curves, evaluated here.
pub(super) fn ease_value(easing: &str, p: f64) -> f64 {
    let p = p.clamp(0.0, 1.0);
    match easing {
        "ease" => p * p * (3.0 - 2.0 * p),
        "ease-in" => p * p,
        "ease-out" => 1.0 - (1.0 - p) * (1.0 - p),
        "hold" => 0.0,
        _ => p,
    }
}

// keyframe_expr's curve evaluated at time `t` - held before the first keyframe and after the last.
pub(super) fn keyframe_value(kfs: &[OverlayKeyframe], t: f64, value: impl Fn(&OverlayKeyframe) -> f64) -> f64 {
    let mut sorted: Vec<&OverlayKeyframe> = kfs.iter().collect();
    sorted.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    let (first, last) = (sorted[0], sorted[sorted.len() - 1]);
    if t <= first.time {
        return value(first);
    }
    for pair in sorted.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if t < b.time {
            let p = (t - a.time) / (b.time - a.time).max(1e-3);
            return value(a) + (value(b) - value(a)) * ease_value(&a.easing, p);
        }
    }
    value(last)
}

// A keyframed overlay's opacity as per-frame alpha commands for `target` (a named
// colorchannelmixer): its value at every frame where it changes - from the overlay's start through
// its last keyframe - and nothing after, where it holds. `fps`: the overlay's frame rate.
pub(super) fn opacity_commands(kfs: &[OverlayKeyframe], target: &str, start: f64, end: f64, fps: f64) -> String {
    let opacity = |t: f64| keyframe_value(kfs, t, |k| k.opacity.clamp(0.0, 1.0));
    let last_change = kfs.iter().map(|k| k.time).fold(start, f64::max).min(end);
    let frames = ((last_change - start) * fps).ceil().max(0.0) as usize;
    // Only where the 8-bit alpha actually changes - a hold costs no commands.
    let mut cmds: Vec<String> = Vec::new();
    let mut last = String::new();
    for n in 0..=frames {
        let t = start + n as f64 / fps;
        let v = format!("{:.4}", (opacity(t) * 255.0).round() / 255.0);
        if v != last {
            cmds.push(format!("{t:.4} {target} aa {v}"));
            last = v;
        }
    }
    format!("sendcmd=c='{}'", cmds.join(";"))
}

// One keyframed value over time as an ffmpeg expression in `tvar`: held at the first keyframe's
// value before it, eased between each pair, held at the last after it - the same piecewise curve
// keyframeStateAt (keyframes.ts) draws in the preview.
//
// Piece i is the eased segment from keyframe i to i+1 (the last piece holds the last value), and
// the pieces are chosen by a balanced tree of time comparisons rather than a chain: a motion
// track bakes hundreds of keyframes, and a chain of hundreds of nested if()s is as deep as it is
// long for ffmpeg's recursive expression parser and costs every frame a walk down all of it.
pub(super) fn keyframe_expr(kfs: &[OverlayKeyframe], tvar: &str, value: impl Fn(&OverlayKeyframe) -> f64) -> String {
    let mut sorted: Vec<&OverlayKeyframe> = kfs.iter().collect();
    sorted.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    let n = sorted.len();
    let piece = |i: usize| -> String {
        if i + 1 >= n {
            return format!("{:.4}", value(sorted[n - 1]));
        }
        let (a, b) = (sorted[i], sorted[i + 1]);
        let p = format!("clip(({tvar}-{:.4})/{:.4},0,1)", a.time, (b.time - a.time).max(1e-3));
        format!("({:.4}+({:.4})*{})", value(a), value(b) - value(a), easing_expr(&a.easing, &p))
    };
    // Pieces lo..=hi; piece i covers [time of keyframe i, time of keyframe i+1).
    fn build(lo: usize, hi: usize, tvar: &str, sorted: &[&OverlayKeyframe], piece: &dyn Fn(usize) -> String) -> String {
        if lo == hi {
            return piece(lo);
        }
        let mid = (lo + hi) / 2;
        format!("if(lt({tvar},{:.4}),{},{})", sorted[mid + 1].time, build(lo, mid, tvar, sorted, piece), build(mid + 1, hi, tvar, sorted, piece))
    }
    build(0, n - 1, tvar, &sorted, &piece)
}


// Renders the edited (trimmed/split/reordered) video described by `segments` - an ordered list
// of the *kept* time ranges, each independently naming which source file it comes from, produced
// by VideoTimelineDocker's trim handles, split+delete tool, and drag-to-reorder/drag-in - to a
// brand-new file next to `output_base_path`, with any text/image overlays composited on top.
// Every source segments reference is opened read-only and never touched: unlike
// convert_to_mp4/convert_video/convert_audio above, there is no `preserve_original` parameter
// here at all, because there is no "false" branch to have.
//
// `output_base_path` only names/locates the DEFAULT output location (still used for the progress
// event's own progress_key regardless) - it's the file the timeline was opened on, which is not
// necessarily the source of any particular segment once clips have been dragged in from elsewhere
// (see DockerFile/DockerFile.path in VideoTimelineDocker.tsx). `output_path`, when set, overrides
// where the actual file gets written - see its own doc comment below.
//
// A single kept segment with no overlays (plain trim, no cuts, no drag-ins, nothing composited)
// uses fast, low-artifact `-ss`/`-to` range extraction on that one input and no filter graph at
// all. Anything else - multiple segments, multiple distinct source files, and/or any overlays -
// needs an actual filter graph: trim+concat can't be expressed as simple `-ss`/`-to` since ffmpeg
// only accepts one input range per input stream (each segment gets its own `-i` so segments can
// come from entirely different files), and compositing an overlay is a filter graph operation by
// definition.
#[tauri::command]
pub async fn export_trimmed_video(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    output_base_path: String,
    segments: Vec<KeepSegment>,
    overlays: Vec<OverlayImage>,
    blur_overlays: Vec<OverlayBlur>,
    audio_overlays: Vec<OverlayAudio>,
    // Always sent by the frontend (possibly empty), unlike video_width/quality/output_path below -
    // no #[serde(default)] here since a bare fn parameter can't carry one the way a struct field can.
    pip_overlays: Vec<PipOverlay>,
    audio_muted: bool,
    audio_volume: f64,
    // The primary file's native pixel resolution, already resolved by the frontend (same value
    // used for text/image overlay burn-in) - reused here as the Ken Burns crop's own trailing
    // `scale=` target rather than a fresh ffprobe lookup. None (e.g. an audio-only export path)
    // just means Ken Burns is silently skipped per-segment, same "skip gracefully" convention
    // exportEdited already uses for overlay rendering when videoPixelSize itself is null.
    video_width: Option<i64>,
    video_height: Option<i64>,
    // "standard" (unrecognized/omitted falls back to this too - see resolve_export_quality),
    // "high", or "small" - the encode speed/CRF trade-off the Save button's quality picker offers.
    quality: Option<String>,
    // Overrides the default "<output_base_path's name> (edited).<ext>" location - set when the
    // user picks a destination via the Save button's "Choose locationâ€¦" option. Still runs through
    // unique_output_path (run_conversion) the same as the default location does, so a second export
    // to the exact same custom path doesn't clobber the first.
    output_path: Option<String>,
    // A complete ASS subtitle script (the editor's Captions tool - buildCaptionsAss, captions.ts),
    // already timed to the OUTPUT timeline and laid out at the video's own pixel size. Burned in
    // with libass as the very last video stage, above every overlay. None/omitted = no captions.
    captions_ass: Option<String>,
    // A platform format to export in (see OutputFrame); None keeps the timeline's own frame.
    output_frame: Option<OutputFrame>,
    // The edit has a canvas of its own (canvasFormats.ts): video_width x video_height isn't the
    // source's size, so every segment is fitted into it - as a project's frame does.
    fit_to_frame: Option<bool>,
    // What fills the canvas around a clip that doesn't fill it: "blur" (a blurred copy of the clip)
    // or black (None / anything else).
    frame_background: Option<String>,
    // Loudness target in LUFS (e.g. -14 for YouTube/Spotify, -16 for podcasts); None = as mixed.
    loudness_lufs: Option<f64>,
    // Adjustment layers (see AdjustmentLayerSpec), in stacking order; None = none.
    adjustment_layers: Option<Vec<AdjustmentLayerSpec>>,
    // Chapters embedded in the file and written to its .chapters.json sidecar; None = none.
    chapters: Option<Vec<ChapterSpec>>,
    // The video's own sound's mixer channel - EQ/compressor/balance after the track volume
    // (audio_fx.rs); None = none.
    video_audio_fx: Option<AudioFxSpec>,
    // The mix's master bus - trim and limiter on everything (MasterBusSpec); None = none.
    master: Option<MasterBusSpec>,
    // The frame around the video (Screen Style - screenStyle.ts): wallpaper, padding, corners and
    // shadow at the final frame's size. None = the video fills the frame as always.
    screen_style: Option<ScreenStyleSpec>,
    // Keyboard-shortcut chips (keystrokes.ts) as a sprite track on the output timeline, over every
    // overlay and under the captions. None = none.
    keystrokes: Option<SpriteTrack>,
    // Stage scenes rendered for this export (StageLayerSpec); None = none.
    stage_layers: Option<Vec<StageLayerSpec>>,
    // The video's intro / outro (EdgeTransitions); None = neither.
    edge_transitions: Option<EdgeTransitions>,
    // Set by the background export queue (exportQueue.ts): the run gets its own cancel state
    // (cancel_export_job), progress events keyed "export-job:<id>", a live preview frame
    // (export-job-preview events) and below-normal CPU priority so editing stays smooth meanwhile.
    job_id: Option<String>,
    export_jobs: State<'_, ExportJobs>,
) -> Result<String, String> {
    if segments.is_empty() {
        return Err("No segments to export".to_string());
    }
    // A queued job runs on its own ConversionState, registered for cancel_export_job until it ends.
    let job = job_id.as_ref().map(|id| ExportJobGuard::register(&export_jobs, id));
    let state: &ConversionState = match &job {
        Some(guard) => &guard.state,
        None => &state,
    };
    let progress_key: String = match &job_id {
        Some(id) => format!("export-job:{id}"),
        None => output_base_path.clone(),
    };
    let preview_frame = job_id.as_ref().map(|id| std::env::temp_dir().join(format!("briefcast_export_preview_{}_{}.jpg", std::process::id(), sanitize_job_id(id))));
    let adjustment_layers = adjustment_layers.unwrap_or_default();
    let chapters = chapters.unwrap_or_default();
    let video_fx_filters = video_audio_fx.as_ref().map(audio_fx_filters).unwrap_or_default();
    let master_filters = master_audio_filters(master.as_ref());
    // A loudness target is reached under the master limiter's ceiling, never over it.
    let loudness_ceiling = master.as_ref().and_then(|m| m.limiter.as_ref()).map(master_ceiling);
    // HEIC/HEIF image clips render from their decoded PNG (see still_image_source) - swapped in
    // before anything below reads a segment's path, so every later step just sees a plain image.
    let mut segments = segments;
    for seg in segments.iter_mut() {
        if is_heic_path(&seg.source_path) {
            seg.source_path = still_image_source(&app_handle, &window, &state, &seg.source_path).await?;
        }
    }
    let (quality_preset, quality_crf) = resolve_export_quality(quality.as_deref());
    // The video's rate (export_video_fps): transitions pin every segment to it, and overlays animate
    // at overlay_rate of it - the rate the editor drew their frame sequences at (get_export_frame_rate).
    let video_fps = {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let paths: Vec<String> = segments.iter().map(|s| s.source_path.clone()).collect();
        blocking(move || export_video_fps(&ffprobe_path, paths.iter().map(String::as_str))).await?
    };
    let overlay_fps = overlay_rate(video_fps);

    // The primary video's OWN audio level (distinct from any audio overlay's own volume/muted,
    // which are separate mixed-in tracks) - 0.0 when muted, otherwise whatever the editor's track
    // volume slider was set to.
    let effective_video_volume = if audio_muted {
        0.0
    } else {
        audio_volume.max(0.0)
    };

    let output = match output_path {
        Some(p) => PathBuf::from(p),
        None => export_output_path(&output_base_path)?,
    };
    // An image segment is a single still, repeated in the graph into a constant-rate stream long
    // enough to cover its own [start,end) window plus any transition tail out of it
    // (still_image_input_chain) - trim= then cuts it exactly like a video segment.
    let mut inputs: Vec<InputSpec> = segments
        .iter()
        .enumerate()
        .map(|(i, s)| {
            // A still is read as its single frame and repeated in the graph (still_image_input_chain).
            let _ = i;
            InputSpec::plain(s.source_path.clone())
        })
        .collect();

    // Written to temp files up front (ffmpeg needs real file paths, not data URLs) and cleaned up
    // unconditionally once the export attempt finishes below, success or failure.
    let total_duration: f64 = segments.iter().map(segment_output_duration).sum();
    let mut temp_overlay_paths: Vec<PathBuf> = Vec::new();
    for (i, ov) in overlays.iter().enumerate() {
        // An animated overlay reads its own frame sequence at the rate it was drawn at - it starts
        // at timestamp 0 and is shifted to start_time in the filter graph (see the overlay loop).
        if let Some(frames) = &ov.frames {
            match write_temp_overlay_sequence(frames, i, &mut temp_overlay_paths) {
                Ok(pattern) => inputs.push(InputSpec {
                    path: pattern,
                    pre_args: vec![
                        "-framerate".into(),
                        format!("{}", frames.rate()),
                        "-start_number".into(),
                        "0".into(),
                    ],
                }),
                Err(e) => {
                    for temp_path in &temp_overlay_paths {
                        let _ = std::fs::remove_file(temp_path);
                    }
                    return Err(e);
                }
            }
            continue;
        }
        // Deliberately not `?` here - that would return before the cleanup loop further down ever
        // runs, permanently leaking every overlay PNG already written earlier in this same loop
        // (e.g. overlay 0 succeeds, overlay 1 fails to decode - overlay 0's temp file would
        // otherwise sit in the temp dir forever, since its deterministic name never gets reused).
        let path = match write_temp_overlay_png(&ov.data_base64, i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        // -loop 1 turns the single PNG into a stream that lasts only as long as the overlay is on
        // screen; the graph shifts it to start at start_time (like a frame sequence). Looping it
        // for the whole output instead decoded the PNG at the overlay rate for the entire video, per
        // overlay - most of that only to be hidden by the overlay's enable window.
        inputs.push(InputSpec {
            path: path.to_string_lossy().to_string(),
            pre_args: vec![
                "-loop".into(),
                "1".into(),
                "-framerate".into(),
                format!("{}", overlay_fps),
                "-t".into(),
                format!("{:.3}", (ov.end_time - ov.start_time).clamp(0.01, total_duration.max(0.01)) + 0.1),
            ],
        });
    }

    // Blur masks (ellipse/rounded/rotated - see OverlayBlur.mask_data_base64's own doc comment)
    // get the same "-loop 1 -t total_duration" treatment as the image overlay PNGs above,
    // appended right after them - blur_mask_input_index remembers which ffmpeg input index (if
    // any) each blur_overlays[i] ended up with, so the filter-graph loop below doesn't need to
    // redo this bookkeeping. Filename indices start at overlays.len() (not 0) so they can never
    // collide with an image overlay PNG's own deterministic filename above.
    let mut blur_mask_input_index: Vec<Option<usize>> = Vec::with_capacity(blur_overlays.len());
    for (i, bv) in blur_overlays.iter().enumerate() {
        match &bv.mask_data_base64 {
            Some(data) => {
                let path = match write_temp_overlay_png(data, overlays.len() + i) {
                    Ok(path) => path,
                    Err(e) => {
                        for temp_path in &temp_overlay_paths {
                            let _ = std::fs::remove_file(temp_path);
                        }
                        return Err(e);
                    }
                };
                temp_overlay_paths.push(path.clone());
                let input_index = inputs.len();
                // Only for the region's own window (shifted into place in the graph) - see the
                // overlay PNGs above.
                inputs.push(InputSpec {
                    path: path.to_string_lossy().to_string(),
                    pre_args: vec![
                        "-loop".into(),
                        "1".into(),
                        "-framerate".into(),
                        format!("{}", overlay_fps),
                        "-t".into(),
                        format!("{:.3}", (bv.end_time - bv.start_time).clamp(0.01, total_duration.max(0.01)) + 0.1),
                    ],
                });
                blur_mask_input_index.push(Some(input_index));
            }
            None => blur_mask_input_index.push(None),
        }
    }
    let blur_mask_count = blur_mask_input_index
        .iter()
        .filter(|idx| idx.is_some())
        .count();

    // Audio overlays need no temp file and no -loop/-t pre_args at all, unlike the PNGs above -
    // there's no client-side rendering step for audio (see OverlayAudio's own doc comment), so
    // this just opens each track's original source file directly, atrim-ing into it in the filter
    // graph below rather than pre-shaping the input stream itself.
    // Each seeks to just before the part it plays (see segment_input_seek), its trim re-timed to match.
    let mut audio_overlays = audio_overlays;
    for audio_ov in audio_overlays.iter_mut() {
        let seek = trim_input_seek(audio_ov.trim_start);
        audio_ov.trim_start -= seek;
        inputs.push(seeking_input(audio_ov.source_path.clone(), seek));
    }

    // PiP sources come last (after audio overlays) so audio_input_base's own formula further down
    // - segments.len() + overlays.len() + blur_mask_count - doesn't need to change to account for
    // them. Each gets the FULL source file as its own `-i` (no -loop/-t pre_args, unlike the image/
    // blur PNGs above) since pip_overlay_chain's own `trim=` does the windowing instead.
    let mut pip_overlays = pip_overlays;
    for pip in pip_overlays.iter_mut() {
        // A cut-out that's gone from disk (derived media cleared) - the original picture instead.
        if pip.cutout_path.as_deref().is_some_and(|p| !Path::new(p).exists()) {
            log::warn!("Cut-out missing, exporting the original picture: {:?}", pip.cutout_path);
            pip.cutout_path = None;
        }
        let seek = trim_input_seek(pip.trim_start);
        pip.trim_start -= seek;
        pip.video_input = inputs.len();
        match pip.cutout_path.clone() {
            // A cut-out's alpha only survives libvpx's own VP9 decoder (ffmpeg's native one drops
            // it). Its sound comes from the source, read from the same moment.
            Some(cutout) => {
                let mut input = seeking_input(cutout, seek);
                input.pre_args.splice(0..0, ["-c:v".to_string(), "libvpx-vp9".to_string()]);
                inputs.push(input);
                if pip.volume > 0.001 {
                    pip.audio_input = Some(inputs.len());
                    inputs.push(seeking_input(pip.source_path.clone(), seek));
                }
                if pip.cutout_background.as_ref().is_some_and(|b| b.kind == "blur") {
                    pip.background_input = Some(inputs.len());
                    inputs.push(seeking_input(pip.source_path.clone(), seek));
                }
            }
            None => inputs.push(seeking_input(pip.source_path.clone(), seek)),
        }
    }

    // Stage scenes: each its stored frames as an image sequence, one frame per timebase tick.
    let stage_layers = stage_layers.unwrap_or_default();
    let stage_inputs: Vec<usize> = stage_layers
        .iter()
        .map(|layer| {
            inputs.push(InputSpec { path: layer.pattern.clone(), pre_args: vec!["-framerate".into(), format!("{}", layer.fps), "-start_number".into(), "0".into()] });
            inputs.len() - 1
        })
        .collect();

    // Adjustment layers' region masks, after everything else (no index arithmetic above changes):
    // (input index, mask width, mask height) per layer that has one.
    let mut adjustment_masks: Vec<Option<(usize, i64, i64)>> = Vec::with_capacity(adjustment_layers.len());
    for (i, layer) in adjustment_layers.iter().enumerate() {
        let Some(data) = &layer.mask_data_base64 else {
            adjustment_masks.push(None);
            continue;
        };
        let path = match write_temp_overlay_png(data, 10_000 + i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        let (mw, mh) = image::image_dimensions(&path).map(|(w, h)| (w as i64, h as i64)).unwrap_or((0, 0));
        if mw < 2 || mh < 2 {
            adjustment_masks.push(None);
            continue;
        }
        adjustment_masks.push(Some((inputs.len(), mw, mh)));
        inputs.push(InputSpec {
            path: path.to_string_lossy().to_string(),
            pre_args: vec![
                "-loop".into(),
                "1".into(),
                "-framerate".into(),
                format!("{}", overlay_fps),
                "-t".into(),
                format!("{:.3}", (layer.end_time - layer.start_time).clamp(0.01, total_duration.max(0.01)) + 0.1),
            ],
        });
    }

    // Video-track layers' mask PNGs - a single frame each (re-timed to the layer's start in the
    // graph): a looped still would make the alpha multiply emit a frame on the mask's own clock too.
    for (i, pip) in pip_overlays.iter_mut().enumerate() {
        let Some(data) = pip.mask_data_base64.take() else { continue };
        let path = match write_temp_overlay_png(&data, 20_000 + i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        pip.mask_input = Some(inputs.len());
        inputs.push(InputSpec::plain(path.to_string_lossy().to_string()));
    }
    // Moving masks' pictures, looped at the overlay rate for the layer's length (the per-frame size
    // follows the frame number - moving_mask_chain).
    for (i, pip) in pip_overlays.iter_mut().enumerate() {
        let Some(data) = pip.mask_motion.as_ref().map(|m| m.image_base64.clone()) else { continue };
        let path = match write_temp_overlay_png(&data, 40_000 + i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        pip.mask_motion_input = Some(inputs.len());
        inputs.push(InputSpec {
            path: path.to_string_lossy().to_string(),
            pre_args: vec!["-loop".into(), "1".into(), "-framerate".into(), format!("{}", overlay_fps), "-t".into(), format!("{:.3}", (pip.end_time - pip.start_time).max(0.01) + 0.1)],
        });
    }
    // Cut-out backgrounds that are pictures - single frames too, like the masks.
    for (i, pip) in pip_overlays.iter_mut().enumerate() {
        let Some(bg) = pip.cutout_background.as_mut().filter(|b| b.kind == "image") else { continue };
        let Some(data) = bg.image_base64.take() else { continue };
        let path = match write_temp_overlay_png(&data, 30_000 + i) {
            Ok(path) => path,
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        };
        temp_overlay_paths.push(path.clone());
        pip.background_input = Some(inputs.len());
        inputs.push(InputSpec::plain(path.to_string_lossy().to_string()));
    }
    // Keyed layers are converted to RGB the way the webview decoded them (probe_browser_color).
    for pip in pip_overlays.iter_mut().filter(|p| p.chroma_key.is_some()) {
        let (ffprobe_path, source_path) = (get_ffprobe_path(&app_handle)?, pip.source_path.clone());
        pip.source_color = Some(blocking(move || probe_browser_color(&ffprobe_path, &source_path)).await?);
    }

    // Written next to the overlay PNGs (and cleaned up by the same loop once the export finishes).
    let captions_ass_path: Option<PathBuf> = match captions_ass.as_deref().filter(|a| !a.trim().is_empty()) {
        Some(ass) => {
            let path = std::env::temp_dir().join(format!("briefcast_captions_{}.ass", std::process::id()));
            if let Err(e) = std::fs::write(&path, ass) {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(format!("Failed to write captions file: {}", e));
            }
            temp_overlay_paths.push(path.clone());
            Some(path)
        }
        None => None,
    };

    // Stage scenes are drawn over the picture like any overlay - none of the copy-the-source fast paths.
    let has_video_overlays = !overlays.is_empty() || !stage_layers.is_empty();
    let has_blur_overlays = !blur_overlays.is_empty();
    let has_audio_overlays = !audio_overlays.is_empty();
    let has_pip_overlays = !pip_overlays.is_empty();
    // Any clip-level effect also needs the full filter graph - the fast -ss/-to path below has no
    // filter graph at all, so a color grade/Ken Burns/transition would have nowhere to be applied.
    // Graded clips' LUTs, written where ffmpeg can read them (lut3d needs a file) and deleted again
    // when this function returns, by TempFiles' Drop.
    let mut lut_files = TempFiles(Vec::new());
    let mut lut_paths: Vec<Option<String>> = Vec::with_capacity(segments.len());
    for (i, seg) in segments.iter().enumerate() {
        match &seg.lut_cube {
            Some(cube) => {
                let path = std::env::temp_dir().join(format!("briefcast_grade_{}_{}.cube", std::process::id(), i));
                std::fs::write(&path, cube).map_err(|e| format!("Failed to write a clip's color grade: {}", e))?;
                lut_paths.push(Some(escape_filter_path(&path)));
                lut_files.0.push(path);
            }
            None => lut_paths.push(None),
        }
    }
    // Stabilized clips' pass-1 analysis (cached after the first time), escaped for the filter.
    let mut stab_paths: Vec<Option<String>> = Vec::with_capacity(segments.len());
    for seg in &segments {
        stab_paths.push(match &seg.stabilize {
            Some(_) if !is_still_image_path(&seg.source_path) => {
                Some(escape_filter_path(&stabilization_transforms(&app_handle, &seg.source_path, seg.start, seg.end).await?))
            }
            _ => None,
        });
    }
    let has_clip_effects = segments.iter().any(segment_needs_filter_graph);
    // Any segment beyond the first requesting a transition - gates the pairwise xfade/acrossfade
    // fold below instead of the plain all-at-once `concat=n=N` the multi-segment branch has always
    // used, so a timeline with no transitions set takes the exact same, already-proven path it did
    // before this feature existed.
    let has_transitions = segments.iter().skip(1).any(|s| s.transition_in.is_some());
    // An intro or outro: drawn on the assembled video (edge_transition_graph), so it needs the
    // filter graph and an output frame, like a transition between clips.
    let edge_transitions = edge_transitions.filter(|e| edge_windows(e, 1.0) != (None, None));
    let has_edge_transitions = edge_transitions.is_some();

    // Plain cuts (nothing drawn, nothing re-timed or re-coloured) keep the source's own video
    // wherever whole GOPs survive - smart_render_export. "small" asks for recompression and
    // "social" for a smaller size/rate, so both still re-encode. Anything smart render can't do (or can't verify) falls through to the
    // normal render below.
    let has_adjustments = !adjustment_layers.is_empty();
    let fit_to_frame = fit_to_frame.unwrap_or(false);
    let plain_cuts = !fit_to_frame
        && !has_video_overlays
        && !has_blur_overlays
        && !has_audio_overlays
        && !has_pip_overlays
        && !has_adjustments
        && !has_clip_effects
        && !has_transitions
        && !has_edge_transitions
        && video_fx_filters.is_empty()
        && master_filters.is_empty()
        && captions_ass_path.is_none()
        && output_frame.is_none()
        && screen_style.is_none()
        && keystrokes.is_none()
        && quality.as_deref() != Some("small")
        && quality.as_deref() != Some("social");
    if plain_cuts {
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        let mut has_audio = Vec::with_capacity(segments.len());
        for seg in &segments {
            let (probe, path) = (ffprobe_path.clone(), seg.source_path.clone());
            has_audio.push(blocking(move || probe_has_audio(&probe, &path)).await?);
        }
        let smart = smart_render_export(&app_handle, &window, state, &segments, &has_audio, effective_video_volume, &progress_key, output.clone()).await;
        match smart {
            Ok(Some(path)) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return finish_export(&app_handle, path, loudness_lufs, loudness_ceiling, &chapters).await;
            }
            Ok(None) => {}
            Err(e) => {
                for temp_path in &temp_overlay_paths {
                    let _ = std::fs::remove_file(temp_path);
                }
                return Err(e);
            }
        }
    }

    // A queued export's live preview frame output (RunExtras), filled in by whichever path runs.
    let mut preview_args: Vec<String> = Vec::new();
    // Sprite tracks' pictures and lists (the drawn pointer, shortcut chips), removed when the export
    // ends however it ends.
    let sprite_root = TempDir(std::env::temp_dir().join(format!(
        "briefcast_sprites_{}_{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    )));
    let owned_args: Vec<String> = if segments.len() == 1
        && !has_video_overlays
        && !has_blur_overlays
        && !has_audio_overlays
        && !has_pip_overlays
        && !has_adjustments
        && !has_clip_effects
        && !has_edge_transitions
        && captions_ass_path.is_none()
        && output_frame.is_none()
        && !fit_to_frame
        && loudness_lufs.is_none()
        && screen_style.is_none()
        && keystrokes.is_none()
    {
        // Still the fast path even with a track volume/mute adjustment - that's a plain `-af`, no
        // filter graph needed just for it.
        let seg = &segments[0];
        // Seeks on the INPUT (keyframe, then frame-exact): as output options -ss/-to decoded the
        // whole file up to the cut first.
        if seg.start > 0.0 {
            inputs[0].pre_args = vec!["-ss".into(), format!("{:.6}", seg.start)];
        }
        if let Some(path) = &preview_frame {
            // Its own length too, or the preview output alone would read on to the file's end.
            preview_args = ["-map", "0:v:0", "-t"].iter().map(|s| s.to_string()).chain([format!("{:.6}", (seg.end - seg.start).max(0.0)), "-vf".into(), PREVIEW_FRAME_FILTER.into()]).chain(preview_output_args(path)).collect();
        }
        let mut args = vec![
            "-t".into(),
            format!("{:.6}", (seg.end - seg.start).max(0.0)),
            "-vf".into(),
            export_delivery_filter(quality.as_deref(), video_fps),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            export_audio_bitrate(quality.as_deref()).into(),
            "-movflags".into(),
            "+faststart".into(),
        ];
        let mut af: Vec<String> = Vec::new();
        if (effective_video_volume - 1.0).abs() > 0.001 {
            af.push(format!("volume={:.3}", effective_video_volume));
        }
        af.extend(video_fx_filters.iter().cloned());
        af.extend(master_filters.iter().cloned());
        if !af.is_empty() {
            args.push("-af".into());
            args.push(af.join(","));
        }
        args
    } else {
        // Each segment's input seeks to just before what it uses, and its times are re-based on
        // where that input now starts (segment_input_seek). After the stabilization analysis above,
        // which reads the file itself at absolute times.
        let ffmpeg_for_decode = get_ffmpeg_path(&app_handle)?;
        let ffprobe_for_decode = get_ffprobe_path(&app_handle)?;

        // The screen frame, the drawn pointer and the shortcut chips (the Screen Style panel) - their
        // inputs come after every other kind, so no index arithmetic above changes. Each clip's
        // pointer is timed from the clip's first frame (what its trimmed picture calls t=0), found
        // before the segments are re-timed for input seeking below.
        let fail = |e: String, temp: &[PathBuf]| {
            for path in temp {
                let _ = std::fs::remove_file(path);
            }
            e
        };
        let mut pointer_fragments: Vec<Option<String>> = vec![None; segments.len()];
        for (i, seg) in segments.iter().enumerate() {
            let Some(layers) = seg.pointer_layers.as_ref().filter(|l| !l.is_empty()) else { continue };
            let (ffprobe, path, at) = (ffprobe_for_decode.clone(), seg.source_path.clone(), seg.start);
            let first = blocking(move || probe_first_frame_at(&ffprobe, &path, at)).await?.unwrap_or(seg.start);
            let mut indices = Vec::with_capacity(layers.len());
            for (k, layer) in layers.iter().enumerate() {
                let list = write_sprite_track(layer, &sprite_root.0.join(format!("seg{i}_{k}")), first).map_err(|e| fail(e, &temp_overlay_paths))?;
                indices.push(inputs.len());
                inputs.push(sprite_track_input(&list));
            }
            pointer_fragments[i] = Some(pointer_fragment(i, layers, &indices, first));
        }
        let screen_style_input = match &screen_style {
            Some(ss) => {
                let path = write_temp_overlay_png(&ss.backdrop_base64, 50_000).map_err(|e| fail(e, &temp_overlay_paths))?;
                temp_overlay_paths.push(path.clone());
                inputs.push(InputSpec::plain(path.to_string_lossy().to_string()));
                Some(inputs.len() - 1)
            }
            None => None,
        };
        let keystroke_input = match &keystrokes {
            Some(track) => {
                let list = write_sprite_track(track, &sprite_root.0.join("keys"), 0.0).map_err(|e| fail(e, &temp_overlay_paths))?;
                inputs.push(sprite_track_input(&list));
                Some(inputs.len() - 1)
            }
            None => None,
        };

        let mut decode_choice: HashMap<String, bool> = HashMap::new();
        // Source seconds each file is read for - only a long read of a heavy source is worth racing.
        let mut seconds_from: HashMap<String, f64> = HashMap::new();
        for seg in &segments {
            *seconds_from.entry(seg.source_path.clone()).or_default() += seg.end - seg.start;
        }
        for (i, seg) in segments.iter_mut().enumerate() {
            // GPU decoding for heavy (1440p+) sources where it measurably wins on this machine -
            // see services/hw_decoder.rs.
            let worth_racing = seconds_from.get(&seg.source_path).copied().unwrap_or(0.0) >= crate::services::hw_decoder::MIN_SECONDS_TO_PROBE;
            if !is_still_image_path(&seg.source_path) && worth_racing {
                let hw = match decode_choice.get(&seg.source_path) {
                    Some(&hw) => hw,
                    None => {
                        let (ffmpeg, ffprobe, path, at) = (ffmpeg_for_decode.clone(), ffprobe_for_decode.clone(), seg.source_path.clone(), seg.start);
                        let hw = blocking(move || {
                            crate::services::smart_render::probe_source(&ffprobe, &path)
                                .is_some_and(|v| crate::services::hw_decoder::should_hw_decode(&ffmpeg, &path, &v.codec, v.width, v.height, at))
                        })
                        .await?;
                        decode_choice.insert(seg.source_path.clone(), hw);
                        hw
                    }
                };
                if hw {
                    inputs[i].pre_args.extend(["-hwaccel".into(), "auto".into()]);
                }
            }
            let seek = segment_input_seek(seg);
            if seek > 0.0 {
                inputs[i].pre_args.extend(["-ss".into(), format!("{seek:.6}")]);
                shift_segment_times(seg, seek);
            }
        }
        let mut filter = String::new();
        // Probed once up front (not per-branch) since all three shapes below - single segment,
        // plain concat, transition fold - need it: see audio_trim_chain's own doc comment for why.
        let ffprobe_path = get_ffprobe_path(&app_handle)?;
        // Only needed for "remove" mode clips; missing just falls back to afftdn per clip.
        let rnnoise_model = crate::services::utility::get_rnnoise_model_path(&app_handle)
            .ok()
            .filter(|p| p.exists())
            .map(|p| escape_filter_path(&p));

        // One audio probe per UNIQUE source file, not one per segment - a timeline built by
        // splitting a single recording into several clips would otherwise spawn a redundant
        // ffprobe process per clip asking the exact same file the exact same question. Each probe
        // (and the dimensions probe just below) runs on the async runtime's blocking thread pool
        // via spawn_blocking rather than blocking whatever thread is running this command with a
        // synchronous Command::output() call - same reasoning as child.wait() further up. Spawned
        // before anything awaits, so they all actually run concurrently rather than one after
        // another.
        let unique_source_paths: Vec<String> = {
            let mut seen = std::collections::HashSet::new();
            segments
                .iter()
                .map(|s| s.source_path.clone())
                .filter(|p| seen.insert(p.clone()))
                .collect()
        };
        let audio_probe_handles: Vec<_> = unique_source_paths
            .iter()
            .filter(|path| !is_still_image_path(path))
            .map(|path| {
                let ffprobe_path = ffprobe_path.clone();
                let path = path.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    (path.clone(), probe_has_audio(&ffprobe_path, &path))
                })
            })
            .collect();
        // Falls back to a real probe only when the frontend didn't already resolve this AND some
        // segment actually needs it (crop/Ken Burns) - see probe_video_dimensions' own doc comment.
        let dimensions_probe_handle =
            if (video_width.is_none() || video_height.is_none()) && (has_clip_effects || has_transitions || has_edge_transitions) {
                let ffprobe_path = ffprobe_path.clone();
                // A real video's size beats a photo's as the output frame - photos come in any
                // size/orientation, and an odd dimension would also break yuv420p encoding.
                let first_source = segments
                    .iter()
                    .find(|s| !is_still_image_path(&s.source_path))
                    .unwrap_or(&segments[0])
                    .source_path
                    .clone();
                Some(tauri::async_runtime::spawn_blocking(move || {
                    probe_video_dimensions(&ffprobe_path, &first_source)
                        .map(|(w, h)| ((w / 2 * 2).max(2), (h / 2 * 2).max(2)))
                }))
            } else {
                None
            };

        let mut has_audio_by_path: HashMap<String, bool> = HashMap::new();
        for handle in audio_probe_handles {
            // A probe task can only fail here by panicking (probe_has_audio itself never returns
            // Err) - falls back to the same "assume audio" default probe_has_audio's own I/O
            // failure branch already uses.
            if let Ok((path, has_audio)) = handle.await {
                has_audio_by_path.insert(path, has_audio);
            }
        }
        let segment_has_audio: Vec<bool> = segments
            .iter()
            .map(|s| !is_still_image_path(&s.source_path) && *has_audio_by_path.get(&s.source_path).unwrap_or(&true))
            .collect();

        let (video_width, video_height): (Option<i64>, Option<i64>) = match dimensions_probe_handle
        {
            Some(handle) => match handle.await.ok().flatten() {
                Some((w, h)) => (Some(w), Some(h)),
                None => (video_width, video_height),
            },
            None => (video_width, video_height),
        };
        let has_image_segments = segments.iter().any(|s| is_still_image_path(&s.source_path));
        // Image segments can't be concatenated without a concrete output frame to fit them into,
        // so a timeline with images always has one - 1080p only if nothing else could say.
        let (video_width, video_height) = match (video_width, video_height) {
            (Some(w), Some(h)) => (Some(w), Some(h)),
            _ if has_image_segments => (Some(1920), Some(1080)),
            other => other,
        };
        // Ken Burns clocks itself by its source's own frame rate (ken_burns_chain) - one probe per
        // file that has one; a still is looped at IMAGE_SEGMENT_FPS.
        let mut kb_rates: HashMap<String, f64> = HashMap::new();
        for seg in segments.iter_mut().filter(|s| s.ken_burns.is_some()) {
            let rate = if is_still_image_path(&seg.source_path) {
                IMAGE_SEGMENT_FPS
            } else if let Some(rate) = kb_rates.get(&seg.source_path) {
                *rate
            } else {
                let (ffprobe_path, source_path) = (ffprobe_path.clone(), seg.source_path.clone());
                let rate = blocking(move || probe_frame_rate(&ffprobe_path, &source_path)).await?;
                kb_rates.insert(seg.source_path.clone(), rate);
                rate
            };
            seg.source_fps = Some(rate);
        }
        // Every segment gets fitted to the output frame once sources can differ in size - an
        // image anywhere, or clips from more than one file. A single-file timeline keeps its
        // exact pre-existing filter graph.
        // Transitions are drawn at the output size (transition_window_graph), so with any, every
        // segment is fitted to it too - exactly that size, frame for frame (a no-op scale for a
        // source already that size).
        let fit_frame = has_image_segments
            || unique_source_paths.len() > 1
            || ((has_transitions || has_edge_transitions || fit_to_frame) && video_width.is_some() && video_height.is_some());
        // With an intro/outro, the clips assemble into [prebase] and edge_transition_graph draws
        // them on it into [base].
        let base_label = if has_edge_transitions { "prebase" } else { "base" };
        // A canvas with the "Blur" background: every clip over a blurred copy of itself.
        if fit_to_frame && frame_background.as_deref() == Some("blur") {
            for (i, seg) in segments.iter_mut().enumerate() {
                seg.fit_blur = Some(i);
            }
        }
        // Stills: decoded once, fitted once, repeated (still_image_input_chain) - fitted before the
        // repeat unless an editor-drawn pointer has to go on under the fit.
        for (i, seg) in segments.iter_mut().enumerate() {
            seg.prefitted = is_still_image_path(&seg.source_path) && fit_frame && pointer_fragments[i].is_none();
        }
        for (i, seg) in segments.iter().enumerate() {
            if is_still_image_path(&seg.source_path) {
                let tail = segments.get(i + 1).and_then(transition_window).map(|d| tail_source_seconds(seg, d)).unwrap_or(0.0);
                filter.push_str(&still_image_input_chain(i, seg, video_width, video_height, seg.end + tail + 0.5));
            }
        }

        // Base video (trim, or trim+concat) always lands in a [base] node so the overlay chain
        // below has one consistent label to start from regardless of how many segments there were.
        if segments.len() == 1 {
            let seg = &segments[0];
            let extra = segment_effect_chain(seg, video_width, video_height, fit_frame, lut_paths[0].as_deref(), stab_paths[0].as_deref(), pointer_fragments[0].as_deref());
            let (end, vignette) = segment_vignette(seg, video_width, video_height, base_label, 0);
            filter.push_str(&format!("{}[{end}];{vignette}", segment_video_chain(&segment_input_label(0, seg), seg, &extra)));
            filter.push_str(&segment_audio_chain(
                segment_has_audio[0],
                0,
                seg,
                &segment_cleanup(seg, rnnoise_model.as_deref()),
                "outa",
            ));
        } else if !has_transitions {
            // Same segment-major trim+concat pattern as before this function grew overlay support
            // - concat's inputs must interleave [v0][a0][v1][a1]..., not group all video labels
            // before all audio ones, or ffmpeg rejects the whole filtergraph ("Media type
            // mismatch"). Untouched from before clip effects existed except for `extra` - a
            // timeline with no transitions takes this exact path regardless of color/Ken Burns.
            let mut concat_inputs = String::new();
            for (i, seg) in segments.iter().enumerate() {
                let extra = segment_effect_chain(seg, video_width, video_height, fit_frame, lut_paths[i].as_deref(), stab_paths[i].as_deref(), pointer_fragments[i].as_deref());
                let (end, vignette) = segment_vignette(seg, video_width, video_height, &format!("v{i}"), i);
                filter.push_str(&format!("{}[{end}];{vignette}", segment_video_chain(&segment_input_label(i, seg), seg, &extra)));
                filter.push_str(&segment_audio_chain(
                    segment_has_audio[i],
                    i,
                    seg,
                    &segment_cleanup(seg, rnnoise_model.as_deref()),
                    &format!("a{}", i),
                ));
                concat_inputs.push_str(&format!("[v{0}][a{0}]", i));
            }
            filter.push_str(&format!(
                "{}concat=n={}:v=1:a=1[{base_label}][outa];",
                concat_inputs,
                segments.len()
            ));
        } else {
            // At least one segment (beyond the first) has a crossfade transition - fold pairwise
            // left-to-right instead of one all-at-once concat, so each transitioned boundary can
            // use `xfade`/`acrossfade` in place of a plain 2-way concat at that one boundary only.
            //
            // xfade needs every input at a matching CONSTANT frame rate before it'll chain more
            // than one in sequence (spike-tested against this app's own bundled ffmpeg: omitting
            // this makes the *second* xfade in a chain fail with "needs to be a constant frame
            // rate, current rate of 1/0 is invalid", even though the first one alone works fine) -
            // so every segment gets an explicit `fps=` up front, using the first segment's own
            // source file's frame rate as the shared target (screen recordings from this app are
            // effectively always one consistent rate throughout a session either way) - video_fps.
            let target_fps = video_fps;

            // `settb=AVTB` too: xfade also demands both inputs share one timebase, but a plain
            // 2-way `concat` fold step (a boundary with no transition) outputs AVTB (1/1000000)
            // while an untouched segment is still at 1/fps - so an xfade following any concat
            // failed with "First input link main timebase ... do not match" (reproduced against
            // the bundled ffmpeg). Pinning every segment to AVTB makes all fold steps agree.
            for (i, seg) in segments.iter().enumerate() {
                let extra = segment_effect_chain(seg, video_width, video_height, fit_frame, lut_paths[i].as_deref(), stab_paths[i].as_deref(), pointer_fragments[i].as_deref());
                // A transition into the next clip plays this one's tail handle (transition_tail):
                // read past the cut, then split the tail off as [old{i+1}].
                match segments.get(i + 1).and_then(transition_window) {
                    Some(d) => {
                        let (end, vignette) = segment_vignette(seg, video_width, video_height, &format!("full{i}"), i);
                        filter.push_str(&format!(
                            "{},fps={:.3},settb=AVTB[{end}];{vignette}",
                            segment_video_chain_with_tail(&segment_input_label(i, seg), seg, &extra, tail_source_seconds(seg, d)),
                            target_fps
                        ));
                        filter.push_str(&transition_tail(
                            &format!("full{i}"),
                            &format!("v{i}"),
                            &format!("old{}", i + 1),
                            segment_output_duration(seg),
                            d,
                            target_fps,
                        ));
                    }
                    None => {
                        let (end, vignette) = segment_vignette(seg, video_width, video_height, &format!("v{i}"), i);
                        filter.push_str(&format!(
                            "{},fps={:.3},settb=AVTB[{end}];{vignette}",
                            segment_video_chain(&segment_input_label(i, seg), seg, &extra),
                            target_fps
                        ));
                    }
                }
                filter.push_str(&segment_audio_chain(
                    segment_has_audio[i],
                    i,
                    seg,
                    &segment_cleanup(seg, rnnoise_model.as_deref()),
                    &format!("a{}", i),
                ));
            }

            // Folds left-to-right: `accumulated` tracks the CURRENT duration of whatever
            // [cur_v]/[cur_a] point at right now, since xfade's own `offset` is relative to its
            // first input's timeline (not the original segment's own duration) once more than one
            // fold has already happened. Divided by speed - xfade/acrossfade operate on the
            // already-setpts'd (OUTPUT-time) streams built above, so every duration/offset here
            // needs to be in that same OUTPUT-time space, not raw source seconds.
            let mut cur_v = "v0".to_string();
            let mut cur_a = "a0".to_string();
            let mut accumulated = segment_output_duration(&segments[0]);
            for i in 1..segments.len() {
                let seg = &segments[i];
                let seg_dur = segment_output_duration(seg);
                let transition = seg
                    .transition_in
                    .as_ref()
                    .filter(|tr| tr.duration > 0.0)
                    .map(|tr| (sanitize_transition_name(&tr.transition_type), tr.duration));
                let look = seg.transition_in.as_ref().and_then(|tr| tr.look.as_ref());
                let (step, next_v, next_a) = transition_fold_step(&cur_v, &cur_a, i, accumulated, seg_dur, target_fps, video_width.zip(video_height), transition, look);
                filter.push_str(&step);
                accumulated += seg_dur;
                cur_v = next_v;
                cur_a = next_a;
            }
            filter.push_str(&format!("[{cur_v}]copy[{base_label}];[{cur_a}]acopy[outa];"));
        }
        if let Some(edges) = &edge_transitions {
            let total: f64 = segments.iter().map(segment_output_duration).sum();
            match video_width.zip(video_height) {
                Some(frame) => filter.push_str(&edge_transition_graph("prebase", "base", edges, total, video_fps, frame)),
                // No frame size to draw at (it couldn't be determined) - left out, as a transition
                // between clips falls back to what it can draw without one.
                None => filter.push_str("[prebase]null[base];"),
            }
        }

        // Blur regions are chained onto [base] first, ahead of the text/image overlay loop below,
        // so blur always sits *underneath* text/image in the composite (matching the live preview,
        // where VideoOverlayLayer paints its blur boxes before its image/text ones - see that
        // file's own render-order comment). Each blur reads straight off whatever node it's
        // chained from (no separate `-i` input for the video itself - see OverlayBlur's own doc
        // comment): `split` duplicates that node, `crop` isolates the region on one copy, `boxblur`
        // blurs just that crop, and `overlay` composites the (possibly masked) blurred crop back
        // onto the *other*, unblurred copy at the same x/y - the standard ffmpeg technique for
        // "blur only part of a frame" (blurring the whole frame and overlaying a crop of the
        // ORIGINAL on top would do it backwards).
        let mut current_label = "base".to_string();
        // Platform format: the assembled video fitted into it first, so every overlay below (and
        // the captions, laid out by the frontend at this same size) lands on the final frame.
        if let Some(frame) = &output_frame {
            filter.push_str(&reframe_chain(&current_label, "framed", frame));
            current_label = "framed".to_string();
        }
        // Adjustment layers placed "under" grade/blur the video itself - before blur regions and
        // every overlay, as the preview mounts them beneath VideoOverlayLayer.
        let adjust_frame = video_width.zip(video_height).map(|(w, h)| match &output_frame {
            Some(frame) => (frame.width, frame.height),
            None => (w, h),
        });
        let adjust_pass = |filter: &mut String, current_label: &mut String, over: bool| {
            let Some(frame) = adjust_frame else { return };
            for (i, layer) in adjustment_layers.iter().enumerate() {
                if (layer.placement == "over") != over {
                    continue;
                }
                let out = format!("adj{i}out");
                filter.push_str(&adjustment_layer_chain(layer, adjustment_masks[i], frame, current_label, &format!("adj{i}"), &out, overlay_fps));
                *current_label = out;
            }
        };
        adjust_pass(&mut filter, &mut current_label, false);
        // Video tracks (PiP and B-roll layers) next, straight on the video: beneath blur regions,
        // pictures, text and captions - as the preview mounts PipOverlayLayer before
        // VideoOverlayLayer (Dashboard.tsx). They arrive bottom track first (videoTracks.ts
        // stackOrder), so each composites over the ones before it.
        for (i, pip) in pip_overlays.iter().enumerate() {
            let out_label = format!("pip{}out", i);
            filter.push_str(&pip_overlay_chain(pip, pip.video_input, i, &current_label, &out_label, adjust_frame, overlay_fps));
            current_label = out_label;
        }
        // Stage scenes over the video and its tracks, beneath blur regions, pictures and text - the
        // preview mounts StageLayer right there too (Dashboard.tsx).
        for (i, layer) in stage_layers.iter().enumerate() {
            let out_label = format!("stg{i}out");
            filter.push_str(&stage_layer_chain(layer, stage_inputs[i], &current_label, &format!("stg{i}"), &out_label));
            current_label = out_label;
        }
        for (i, bv) in blur_overlays.iter().enumerate() {
            let out_label = format!("bb{}out", i);
            filter.push_str(&blur_region_chain(bv, i, blur_mask_input_index[i], &current_label, &out_label));
            current_label = out_label;
        }

        // Chains each overlay onto whatever the blur pass above left [current_label] pointing at
        // (still "base" if there were no blur regions) in turn, the last one landing on [outv]. A
        // still PNG is "faded" via ffmpeg's own fade filter for animation:"fade" - alpha=1 fades the
        // alpha channel itself rather than to black, which is exactly what a transparent-background
        // overlay needs - or, for animation:"slide-*", composited at a time-varying x/y instead (see
        // overlay_position_expr) - before being composited via `overlay` gated to that overlay's own
        // [start,end) window on the output timeline either way.
        let overlay_input_base = segments.len();
        // Pictures and text over the picture (`on_frame` false), or - after the screen frame goes
        // around it - over the frame itself (`on_frame` true). One stacking order either way.
        let frame_overlays = screen_style.is_some();
        let composite_overlays = |filter: &mut String, current_label: &mut String, on_frame: bool| {
            for (i, ov) in overlays.iter().enumerate() {
                if (ov.on_frame && frame_overlays) != on_frame {
                    continue;
                }
                let mut source_label = format!("{}:v", overlay_input_base + i);
                // The rate this overlay's input runs at - its frame sequence's own, else the rate a
                // still is looped at (see the inputs above).
                let input_fps = ov.frames.as_ref().map_or(overlay_fps, OverlayFrames::rate);
                // Every overlay input (a frame sequence, or a still looped for its own window) starts
                // at timestamp 0 - shifted to start at the overlay's own start_time, so everything
                // below (fade st=, the opacity commands, the enable window) reads absolute output times.
                {
                    let shifted = format!("ovseq{}", i);
                    filter.push_str(&format!(
                        "[{}]format=rgba,setpts=PTS-STARTPTS+{:.4}/TB[{}];",
                        source_label, ov.start_time, shifted
                    ));
                    source_label = shifted;
                }
                let animation = sanitize_overlay_animation(&ov.animation);
                let composited_label = if animation == "fade" || animation == "zoom" {
                    // The preview's ramp: 0.4s, or half the overlay's length if that's shorter.
                    let ramp = overlay_animation_ramp(ov.start_time, ov.end_time);
                    let faded_label = format!("ovfade{}", i);
                    let fade_out_start = (ov.end_time - ramp).max(ov.start_time);
                    filter.push_str(&format!(
                        "[{}]fade=in:st={:.3}:d={ramp:.4}:alpha=1,fade=out:st={:.3}:d={ramp:.4}:alpha=1[{}];",
                        source_label, ov.start_time, fade_out_start, faded_label
                    ));
                    faded_label
                } else {
                    source_label
                };
                let (mut x_expr, mut y_expr) = overlay_position_expr(ov, animation);
                let mut composited_label = composited_label;
                let kfs = ov.keyframes.as_ref().filter(|k| !k.is_empty());
                let flips = animation == "flip";
                let kf_scales = kfs.is_some_and(|kfs| kfs.iter().any(|k| (k.scale - 1.0).abs() > 1e-3));
                // The overlay's scale over time in `tv`: its keyframed scale times pop's overshoot -
                // the preview multiplies the two the same way (the box's scale() transform inside the
                // keyframe layer's). None when it never scales.
                let scale_at = |tv: &str| -> Option<String> {
                    let kf = kfs.filter(|_| kf_scales).map(|kfs| keyframe_expr(kfs, tv, |k| k.scale.max(0.01)));
                    let pop = overlay_anim_scale_expr(animation, ov.start_time, ov.end_time, tv);
                    match (kf, pop) {
                        (Some(a), Some(b)) => Some(format!("({a})*({b})")),
                        (a, b) => a.or(b),
                    }
                };
                // Scale per frame - `n` counts this input's frames, which start at start_time.
                let frame_time = format!("({:.4}+n/{})", ov.start_time, input_fps);
                // A flip squashes the width on top (overlay_flip_sx_expr).
                let squash_at = |tv: &str| flips.then(|| overlay_flip_sx_expr(ov.start_time, ov.end_time, tv));
                if let Some(s) = scale_at(&frame_time) {
                    let sx = squash_at(&frame_time).map(|q| format!("({s})*({q})")).unwrap_or_else(|| s.clone());
                    let scaled = format!("ovkfs{}", i);
                    filter.push_str(&format!(
                        "[{composited_label}]scale=w='max(2,trunc(iw*({sx})/2)*2)':h='max(2,trunc(ih*({s})/2)*2)':eval=frame[{scaled}];"
                    ));
                    composited_label = scaled;
                }
                if let Some(kfs) = kfs {
                    // Keyframed opacity: one alpha factor per frame (opacity_commands), applied by
                    // colorchannelmixer - a multiply per pixel, where the per-pixel expression it
                    // replaces (geq) cost ~1µs a pixel.
                    if kfs.iter().any(|k| (k.opacity - 1.0).abs() > 1e-3) {
                        let faded = format!("ovkfa{}", i);
                        filter.push_str(&format!(
                            "[{composited_label}]format=rgba,{},colorchannelmixer@ka{i}=aa=1[{faded}];",
                            opacity_commands(kfs, &format!("colorchannelmixer@ka{i}"), ov.start_time, ov.end_time, input_fps)
                        ));
                        composited_label = faded;
                    }
                    // A slide still plays on top of keyframed motion, as in the preview: its offset
                    // from the resting spot is added to the keyframed position.
                    let (slide_x, slide_y) = overlay_slide_offset_expr(ov, animation);
                    x_expr = format!("({})+({slide_x})", keyframe_expr(kfs, "t", |k| k.x));
                    y_expr = format!("({})+({slide_y})", keyframe_expr(kfs, "t", |k| k.y));
                }
                if let Some(s) = scale_at("t") {
                    // Scaled about the box's centre, as the preview does.
                    let sx = squash_at("t").map(|q| format!("({s})*({q})")).unwrap_or_else(|| s.clone());
                    x_expr = format!("({x_expr})+overlay_w*(1/({sx})-1)/2");
                    y_expr = format!("({y_expr})+overlay_h*(1/({s})-1)/2");
                }
                // Never "outv" itself - later stages (PiP, adjustment layers, captions) read from here;
                // the final rename below names whatever ran last.
                let next_label = format!("ov{}", i);
                // A blend mode composites through blend_composite instead: over the overlay's own box
                // when it stays put, the whole frame when anything moves it.
                if let (Some(mode), Some(frame), Some((w, h))) = (ov.blend_mode.as_deref().and_then(blend_mode_ffmpeg), adjust_frame, overlay_layer_size(ov)) {
                    let moving = kfs.is_some() || animation.starts_with("slide") || animation == "drop" || scale_at("t").is_some();
                    let layer = BlendLayer { label: &composited_label, x: x_expr.clone(), y: y_expr.clone(), width: w, height: h, moving, fps: input_fps };
                    filter.push_str(&blend_composite(&current_label, &layer, frame, mode, ov.start_time, ov.end_time, &format!("ovb{i}"), &next_label));
                    *current_label = next_label;
                    continue;
                }
                filter.push_str(&format!(
                    "[{}][{}]overlay=x='{}':y='{}':enable='between(t,{:.3},{:.3})'[{}];",
                    current_label,
                    composited_label,
                    x_expr,
                    y_expr,
                    ov.start_time,
                    ov.end_time,
                    next_label
                ));
                *current_label = next_label;
            }
        };
        composite_overlays(&mut filter, &mut current_label, false);

        // Adjustment layers placed "over" act on everything composited so far (captions excepted).
        adjust_pass(&mut filter, &mut current_label, true);

        // The screen frame (wallpaper, padding, corners, shadow) goes around the whole edited
        // picture - clips, layers and blurs shrink into it together. Pictures and text, the
        // shortcut chips and captions then sit on the frame itself, as in the preview, so a title
        // can be placed on the padding.
        if let (Some(ss), Some(input), Some(frame)) = (&screen_style, screen_style_input, adjust_frame) {
            filter.push_str(&screen_style_chain(&current_label, input, ss, frame, "styled"));
            current_label = "styled".to_string();
        }
        composite_overlays(&mut filter, &mut current_label, true);

        // Shortcut chips over everything but the captions, as the preview stacks them.
        if let (Some(track), Some(input)) = (&keystrokes, keystroke_input) {
            filter.push_str(&sprite_track_overlay(track, input, 0.0, &current_label, "keys", "keysout"));
            current_label = "keysout".to_string();
        }

        // Whatever [current_label] is pointing at (the plain trim/concat [base], or the last blur/
        // image/text/pip stage that actually ran) needs to end up named [outv] for the -map below -
        // covers every combination of "any blur regions" x "any text/image overlays" x "any PiP
        // layers" with one check, rather than the single `!has_video_overlays` special case this
        // used to be before blur/pip support existed (back when [base] was the only possible
        // "nothing chained" label).
        // Captions last, so they sit above every image/text/blur/PiP layer.
        if let Some(ass_path) = &captions_ass_path {
            filter.push_str(&format!(
                "[{}]ass=filename='{}'[capv];",
                current_label,
                escape_filter_path(ass_path)
            ));
            current_label = "capv".to_string();
        }

        // Standard-range 4:2:0 (and a preset's size/rate limits) on the finished picture - see
        // export_delivery_filter.
        filter.push_str(&format!("[{current_label}]{}[delivered];", export_delivery_filter(quality.as_deref(), video_fps)));
        current_label = "delivered".to_string();

        if let Some(path) = &preview_frame {
            // The queue's live preview: a small copy of the finished picture, a couple of frames
            // per second of output, split off the very last stage.
            filter.push_str(&format!("[{current_label}]split=2[outv][prevtap];[prevtap]{PREVIEW_FRAME_FILTER}[prevv];"));
            preview_args = ["-map", "[prevv]"].iter().map(|s| s.to_string()).chain(preview_output_args(path)).collect();
        } else if current_label != "outv" {
            filter.push_str(&format!("[{}]copy[outv];", current_label));
        }

        // Applies the track-level mute/volume to [outa] (the original video's own trimmed/
        // concatenated audio, built above) before anything else reads it - both the no-overlays
        // map below and the amix mixing block further down consume whichever label this produces.
        // Skipped entirely (base_audio_label just stays "outa") when the volume is untouched, so a
        // video nobody's adjusted this for doesn't grow an extra no-op filter node.
        let mut base_audio_label = if (effective_video_volume - 1.0).abs() > 0.001 {
            filter.push_str(&format!(
                "[outa]volume={:.3}[outa_vol];",
                effective_video_volume
            ));
            "outa_vol"
        } else {
            "outa"
        };
        // The video sound's mixer channel, after its volume - as the preview's effects sit after
        // the element's own volume.
        if !video_fx_filters.is_empty() {
            filter.push_str(&format!("[{base_audio_label}]{}[outa_fx];", video_fx_filters.join(",")));
            base_audio_label = "outa_fx";
        }

        // Which pip overlays actually contribute audio - the frontend already collapses its own
        // "play this clip's own audio" toggle into volume=0 when off (see PipOverlay.muted,
        // videoEditTypes.ts), so a plain volume>0 check covers that; probe_has_audio additionally
        // guards against a pip source with NO audio stream at all (e.g. the webcam sidecar
        // FormData.separate_webcam_capture itself produces, which is video-only by design - see
        // win.rs) - without this, a stray `[idx:a]` on a video-only input would reject the whole
        // filtergraph with "Stream specifier ':a' ... matches no streams", the same failure mode
        // probe_has_audio already exists to prevent for segments.
        let pip_audio_probes: Vec<_> = pip_overlays
            .iter()
            .map(|p| {
                let audible = p.volume > 0.001;
                let ffprobe_path = ffprobe_path.clone();
                let source_path = p.source_path.clone();
                // Spawned (not just created) here, so every probe runs concurrently. The channel
                // count is what tells a mono source apart (mono_to_stereo_filter).
                tauri::async_runtime::spawn_blocking(move || {
                    if audible && probe_has_audio(&ffprobe_path, &source_path) {
                        Some(probe_audio_channels(&ffprobe_path, &source_path))
                    } else {
                        None
                    }
                })
            })
            .collect();
        let mut pip_audio_input_index: Vec<Option<usize>> = Vec::with_capacity(pip_overlays.len());
        let mut pip_audio_channels: Vec<Option<u32>> = Vec::with_capacity(pip_overlays.len());
        for (i, probe) in pip_audio_probes.into_iter().enumerate() {
            let probed = probe
                .await
                .map_err(|e| format!("Background task failed: {}", e))?;
            pip_audio_input_index.push(probed.map(|_| pip_overlays[i].audio_input.unwrap_or(pip_overlays[i].video_input)));
            pip_audio_channels.push(probed.flatten());
        }
        // Audio overlays' channel counts, for the same mono up-mix.
        let overlay_channel_probes: Vec<_> = audio_overlays
            .iter()
            .map(|o| {
                let (ffprobe_path, source_path) = (ffprobe_path.clone(), o.source_path.clone());
                tauri::async_runtime::spawn_blocking(move || probe_audio_channels(&ffprobe_path, &source_path))
            })
            .collect();
        let mut overlay_channels: Vec<Option<u32>> = Vec::with_capacity(audio_overlays.len());
        for probe in overlay_channel_probes {
            overlay_channels.push(probe.await.map_err(|e| format!("Background task failed: {}", e))?);
        }
        let has_pip_audio = pip_audio_input_index.iter().any(|idx| idx.is_some());

        // Mixes each audio overlay (and any audible pip layer) into base_audio_label - amix's
        // `normalize=0` is the detail that matters here: amix auto-attenuates every input by
        // 1/inputs by default, which would quietly turn the original video's own audio down just
        // because background music was added. normalize=0 keeps each track at whatever level its
        // own `volume=` filter below already set (the track volume above for the original track,
        // whatever the user picked for each overlay) - "30% volume" means 30%, not 30% further
        // divided by however many tracks happen to be mixed in.
        let audio_label = if has_audio_overlays || has_pip_audio {
            // Inputs so far, in push order: segments, then image overlay PNGs, then blur mask PNGs
            // (see blur_mask_input_index above) - audio overlay sources were appended right after
            // all of those, so this has to account for all three groups, not just the first two.
            let audio_input_base = segments.len() + overlays.len() + blur_mask_count;
            let mut mix_inputs = format!("[{}]", base_audio_label);
            for (i, audio_ov) in audio_overlays.iter().enumerate() {
                let input_index = audio_input_base + i;
                let trim_end = audio_ov.trim_start + (audio_ov.end_time - audio_ov.start_time);
                let upmix = mono_to_stereo_filter(overlay_channels[i]).map(|f| format!("{f},")).unwrap_or_default();
                let mut chain = format!(
                    "[{}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,{}volume={:.3}",
                    input_index, audio_ov.trim_start, trim_end, upmix, audio_ov.volume
                );
                if let Some(duck) = audio_ov.duck.as_ref().and_then(|d| duck_volume_filter(d, audio_ov.start_time, audio_ov.end_time - audio_ov.start_time)) {
                    chain.push(',');
                    chain.push_str(&duck);
                }
                if let Some(auto) = audio_ov.gain.as_deref().and_then(automation_volume_filter) {
                    chain.push(',');
                    chain.push_str(&auto);
                }
                if audio_ov.fade_in > 0.0 {
                    chain.push_str(&format!(",afade=t=in:st=0:d={:.4}:curve={}", audio_ov.fade_in, fade_curve(audio_ov.fade_in_curve.as_deref())));
                }
                if audio_ov.fade_out > 0.0 {
                    let track_duration = audio_ov.end_time - audio_ov.start_time;
                    let fade_out_start = (track_duration - audio_ov.fade_out).max(0.0);
                    chain.push_str(&format!(
                        ",afade=t=out:st={:.4}:d={:.4}:curve={}",
                        fade_out_start,
                        audio_ov.fade_out,
                        fade_curve(audio_ov.fade_out_curve.as_deref())
                    ));
                }
                for f in audio_ov.fx.as_ref().map(audio_fx_filters).unwrap_or_default() {
                    chain.push(',');
                    chain.push_str(&f);
                }
                let delay_ms = (audio_ov.start_time * 1000.0).round().max(0.0);
                let track_label = format!("aov{}", i);
                filter.push_str(&format!(
                    "{},adelay={:.0}:all=1[{}];",
                    chain, delay_ms, track_label
                ));
                mix_inputs.push_str(&format!("[{}]", track_label));
            }
            // Same atrim+volume+adelay shape as the audio-overlay loop above, minus fade in/out
            // (pip has no fade controls of its own) - skips any pip pip_audio_input_index marked
            // None (muted, or a source with no audio stream at all).
            let mut pip_audio_count = 0;
            for (i, pip) in pip_overlays.iter().enumerate() {
                let Some(input_index) = pip_audio_input_index[i] else {
                    continue;
                };
                let trim_end = pip.trim_start + (pip.end_time - pip.start_time);
                let delay_ms = (pip.start_time * 1000.0).round().max(0.0);
                let track_label = format!("pipa{}", i);
                let upmix = mono_to_stereo_filter(pip_audio_channels[i]).map(|f| format!("{f},")).unwrap_or_default();
                let fx: String = pip.fx.as_ref().map(audio_fx_filters).unwrap_or_default().iter().map(|f| format!(",{f}")).collect();
                filter.push_str(&format!(
                    "[{idx}:a]atrim=start={ts:.3}:end={te:.3},asetpts=PTS-STARTPTS,{upmix}volume={vol:.3}{fx},adelay={delay:.0}:all=1[{label}];",
                    idx = input_index, ts = pip.trim_start, te = trim_end, vol = pip.volume, delay = delay_ms, label = track_label
                ));
                mix_inputs.push_str(&format!("[{}]", track_label));
                pip_audio_count += 1;
            }
            filter.push_str(&format!(
                "{}amix=inputs={}:duration=first:dropout_transition=0:normalize=0[outa_mixed];",
                mix_inputs,
                audio_overlays.len() + pip_audio_count + 1
            ));
            "outa_mixed".to_string()
        } else {
            base_audio_label.to_string()
        };
        // The master bus on the whole mix. (A loudness target is applied after the render - see
        // normalize_loudness.)
        let audio_label = if master_filters.is_empty() {
            audio_label
        } else {
            filter.push_str(&format!("[{audio_label}]{}[outa_master];", master_filters.join(",")));
            "outa_master".to_string()
        };

        // Trailing `;` is harmless to ffmpeg either way, but trimmed for consistency with how the
        // original concat-only filter string here was always built without one.
        let filter = filter.trim_end_matches(';').to_string();
        // A long graph (many clips, transitions' per-frame commands, keyframed overlays) goes to
        // ffmpeg as a script file: Windows caps a whole command line at 32,767 characters.
        let (graph_flag, graph_arg) = if filter.len() > 8000 {
            let script = std::env::temp_dir().join(format!("briefcast_graph_{}.txt", std::process::id()));
            std::fs::write(&script, &filter).map_err(|e| format!("Failed to write the export's filter graph: {}", e))?;
            temp_overlay_paths.push(script.clone());
            // `-/option file` reads the option's value from a file (ffmpeg 7+); the old
            // -filter_complex_script spelling was removed in ffmpeg 8.
            ("-/filter_complex", script.to_string_lossy().to_string())
        } else {
            ("-filter_complex", filter)
        };

        vec![
            graph_flag.into(),
            graph_arg,
            "-map".into(),
            "[outv]".into(),
            "-map".into(),
            format!("[{}]", audio_label),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            export_audio_bitrate(quality.as_deref()).into(),
            "-movflags".into(),
            "+faststart".into(),
        ]
    };

    // The video encoder: this machine's proven hardware encoder at the tier's calibrated quality
    // (HwEncoding::export_args - same picture as x264, many times faster), else software x264.
    // A hardware encode that fails for any reason other than the user cancelling is re-run in
    // software, so a flaky driver costs time, never the export.
    let mut software: Vec<String> = ["-c:v", "libx264", "-preset", quality_preset, "-crf", quality_crf].iter().map(|s| s.to_string()).collect();
    software.extend(export_extra_video_args(quality.as_deref()));
    // None for a preset that has to stay on x264 (export_hw_tier).
    let tier = export_hw_tier(quality.as_deref());
    let ffmpeg_for_probe = get_ffmpeg_path(&app_handle)?;
    let hardware = match tier {
        Some(tier) => blocking(move || crate::services::hw_encoder::detect(&ffmpeg_for_probe)).await?.and_then(|hw| hw.export_args(tier)),
        None => None,
    };
    let encoders: Vec<Vec<String>> = hardware.into_iter().chain(std::iter::once(software)).collect();
    let output_seconds: f64 = segments.iter().map(segment_output_duration).sum();

    let extras = RunExtras {
        preview: job_id.as_ref().zip(preview_frame.clone()).filter(|_| !preview_args.is_empty()).map(|(id, path)| (id.clone(), path)),
        preview_args,
        low_priority: job_id.is_some(),
    };
    let mut result = Err("No encoder to run".to_string());
    for (attempt, video_encoder) in encoders.iter().enumerate() {
        let codec_args: Vec<&str> = owned_args.iter().chain(video_encoder.iter()).map(|s| s.as_str()).collect();
        result = run_conversion_with(&app_handle, &window, state, &inputs, &progress_key, output.clone(), &codec_args, Some(output_seconds), &extras).await;
        let cancelled = state.cancelled.load(std::sync::atomic::Ordering::SeqCst);
        if result.is_ok() || cancelled || attempt + 1 == encoders.len() {
            break;
        }
        log::warn!("Hardware export encode failed, re-running in software: {:?}", result.as_ref().err());
    }
    if let Err(e) = &result {
        // The whole command, for working out why ffmpeg refused it - its own message names only the
        // stream that gave up, not the filter that caused it.
        let input_list: Vec<String> = inputs.iter().map(|i| format!("{} {}", i.pre_args.join(" "), i.path)).collect();
        log::warn!("Export failed: {e}\n  inputs: {:?}\n  args: {}", input_list, owned_args.join(" "));
    }

    for temp_path in &temp_overlay_paths {
        let _ = std::fs::remove_file(temp_path);
    }
    // A Stage scene's frames live in a folder of their own.
    for layer in &stage_layers {
        if let Some(dir) = Path::new(&layer.pattern).parent().filter(|d| d.file_name().is_some_and(|n| n.to_string_lossy().starts_with("briefcast_stage_"))) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    finish_export(&app_handle, result?, loudness_lufs, loudness_ceiling, &chapters).await
}

// ffmpeg arguments writing the live preview frame (RunExtras) after whatever selects its stream.
pub(super) const PREVIEW_FRAME_FILTER: &str = "fps=2,scale=-2:240:flags=bilinear";
pub(super) fn preview_output_args(path: &Path) -> Vec<String> {
    ["-an", "-sn", "-f", "image2", "-update", "1", "-atomic_writing", "1", "-q:v", "5"]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(path.to_string_lossy().to_string()))
        .collect()
}

// What every finished export still gets: its loudness target, then its chapters.
// `ceiling`: the master limiter's, when it has one - the loudness pass then limits there instead.
pub(super) async fn finish_export(app_handle: &AppHandle, path: String, loudness_lufs: Option<f64>, ceiling: Option<f64>, chapters: &[ChapterSpec]) -> Result<String, String> {
    if let Some(target) = loudness_lufs {
        normalize_loudness(app_handle, &path, target, ceiling).await?;
    }
    if !chapters.is_empty() {
        embed_chapters(app_handle, &path, chapters).await?;
    }
    Ok(path)
}

// Chapters into the file itself (MP4/MOV chapter atoms - VLC, QuickTime, most players list them)
// by a stream-copy remux, and into its .chapters.json sidecar so Briefcast's own player shows them.
pub(super) async fn embed_chapters(app_handle: &AppHandle, path: &str, chapters: &[ChapterSpec]) -> Result<(), String> {
    let mut sorted: Vec<ChapterSpec> = chapters.iter().filter(|c| c.time.is_finite() && c.time >= 0.0).cloned().collect();
    sorted.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    if sorted.is_empty() {
        return Ok(());
    }
    let ffmpeg = get_ffmpeg_path(app_handle)?;
    let ffprobe = get_ffprobe_path(app_handle)?;
    let target = PathBuf::from(path);
    let duration = {
        let (probe, p) = (ffprobe.clone(), target.clone());
        blocking(move || probe_duration_secs(&probe, &p)).await?.unwrap_or(0.0)
    };
    // ffmetadata: each chapter runs to the next one (the last to the end); its title escaped.
    let escape = |s: &str| s.replace('\\', "\\\\").replace('=', "\\=").replace(';', "\\;").replace('#', "\\#").replace('\n', " ");
    let mut meta = String::from(";FFMETADATA1\n");
    for (i, c) in sorted.iter().enumerate() {
        let end = sorted.get(i + 1).map(|n| n.time).unwrap_or(duration.max(c.time + 0.001));
        meta.push_str(&format!("[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\ntitle={}\n", (c.time * 1000.0).round() as i64, (end * 1000.0).round() as i64, escape(&c.label)));
    }
    let meta_path = std::env::temp_dir().join(format!("briefcast_chapters_{}.txt", std::process::id()));
    std::fs::write(&meta_path, meta).map_err(|e| format!("Couldn't write the chapters: {}", e))?;
    let ext = target.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_else(|| "mp4".into());
    let remuxed = target.with_extension(format!("chapters.{ext}"));
    let args: Vec<String> = vec![
        "-v".into(), "error".into(), "-y".into(), "-i".into(), path.to_string(), "-i".into(), meta_path.to_string_lossy().to_string(),
        "-map".into(), "0".into(), "-map_metadata".into(), "0".into(), "-map_chapters".into(), "1".into(), "-c".into(), "copy".into(),
        "-movflags".into(), "+faststart".into(), remuxed.to_string_lossy().to_string(),
    ];
    let ran = blocking(move || run_ffmpeg_quiet(&ffmpeg, &args)).await?;
    let _ = std::fs::remove_file(&meta_path);
    match ran {
        Ok(()) => std::fs::rename(&remuxed, &target).map_err(|e| format!("Couldn't add the chapters: {}", e))?,
        Err(e) => {
            // The video itself is fine - only its chapters are missing.
            let _ = std::fs::remove_file(&remuxed);
            log::warn!("Embedding chapters failed: {e}");
        }
    }
    let sidecar: Vec<serde_json::Value> = sorted
        .iter()
        .map(|c| serde_json::json!({ "id": format!("ch-{}", (c.time * 1000.0).round() as i64), "time": c.time, "label": c.label }))
        .collect();
    crate::services::video_edits::save_video_chapters(path.to_string(), serde_json::to_string(&sidecar).unwrap_or_default())
}

// Integrated loudness (LUFS) of a file's audio, measured with ffmpeg's EBU R128 scanner.
pub(super) fn measure_loudness(ffmpeg_path: &PathBuf, path: &str) -> Result<f64, String> {
    let mut cmd = Command::new(ffmpeg_path);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.args(["-hide_banner", "-nostats", "-i", path, "-vn", "-af", "ebur128=framelog=quiet", "-f", "null", "-"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
    let log = String::from_utf8_lossy(&out.stderr);
    // The summary's "I: -17.4 LUFS" line (the last one - the per-frame log is off).
    log.lines()
        .filter_map(|l| l.trim().strip_prefix("I:"))
        .filter_map(|v| v.trim().trim_end_matches("LUFS").trim().parse::<f64>().ok())
        .last()
        .ok_or_else(|| "Couldn't measure the export's loudness".to_string())
}

// Loudness target: the finished export's audio is re-rendered with the gain that lands it on
// `target` LUFS (EBU R128 integrated); the picture is copied untouched.
//
// - The chain (loudness_chain) is the gain, then a lookahead peak limiter holding peaks near
//   -2 dBFS (room for AAC's overshoot). A short release shaves the peaks inside each syllable rather
//   than ducking whole words: on dense speech (every syllable within a few dB of the loudest) a
//   40ms release took back 11 of 15 dB of gain on the way to -14 LUFS, 8ms takes back ~5. No
//   compressor: the loudness then rises smoothly and monotonically with the gain, which is what
//   makes the search exact.
// - The gain is searched with measure-only passes (decode -> chain -> R128 scanner, nothing
//   written): secant steps, safeguarded by bisection once the target is bracketed. Limited,
//   high-crest audio bends the curve well below 1:1, which is what the secant follows.
// - Then the audio alone is encoded once and checked (AAC moves the result by a few hundredths),
//   with one correction if needed, and muxed back next to the copied video.
pub(super) const LOUDNESS_TOLERANCE_LU: f64 = 0.1;
pub(super) const LOUDNESS_MAX_SEARCH_PASSES: usize = 10;
pub(super) const LOUDNESS_MAX_GAIN_DB: f64 = 30.0;

pub(super) fn loudness_chain(gain: f64, limit: f64) -> String {
    // latency=1: the 2ms lookahead is compensated, so the sound stays in sync with the picture.
    format!("volume={gain:.3}dB,alimiter=limit={limit:.5}:attack=2:release=8:level=false:latency=1")
}

// The loudness pass's own peak limit (-2 dBFS, room for AAC's overshoot), or a master ceiling below it.
pub(super) const LOUDNESS_LIMIT: f64 = 0.79;
pub(super) fn loudness_limit(ceiling: Option<f64>) -> f64 {
    ceiling.map_or(LOUDNESS_LIMIT, |c| c.min(LOUDNESS_LIMIT))
}

// Integrated loudness of `path`'s audio after `chain`, without writing anything.
pub(super) fn measure_loudness_through(ffmpeg_path: &PathBuf, path: &str, chain: &str) -> Result<f64, String> {
    let mut cmd = Command::new(ffmpeg_path);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let af = format!("{chain},ebur128=framelog=quiet");
    cmd.args(["-hide_banner", "-nostats", "-i", path, "-vn", "-af", &af, "-f", "null", "-"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
    let log = String::from_utf8_lossy(&out.stderr);
    log.lines()
        .filter_map(|l| l.trim().strip_prefix("I:"))
        .filter_map(|v| v.trim().trim_end_matches("LUFS").trim().parse::<f64>().ok())
        .last()
        .ok_or_else(|| "Couldn't measure the export's loudness".to_string())
}

// The gain search on a monotone gain -> loudness curve `f`: secant steps from `first_gain`, kept
// inside the bracket once the target is crossed (bisecting when a step would leave it). Returns the
// gain whose result was closest, and that result.
pub(super) fn search_loudness_gain(target: f64, first_gain: f64, mut f: impl FnMut(f64) -> Result<f64, String>) -> Result<(f64, f64), String> {
    let clamp_gain = |g: f64| g.clamp(-LOUDNESS_MAX_GAIN_DB, LOUDNESS_MAX_GAIN_DB);
    let mut gain = clamp_gain(first_gain);
    let mut best: Option<(f64, f64)> = None; // (gain, result)
    let mut previous: Option<(f64, f64)> = None;
    let mut below: Option<f64> = None; // a gain known to land under the target
    let mut above: Option<f64> = None; // ... and over it
    for _ in 0..LOUDNESS_MAX_SEARCH_PASSES {
        let result = f(gain)?;
        if best.map_or(true, |(_, r)| (target - result).abs() < (target - r).abs()) {
            best = Some((gain, result));
        }
        if (target - result).abs() <= LOUDNESS_TOLERANCE_LU {
            break;
        }
        if result < target {
            below = Some(below.map_or(gain, |b: f64| b.max(gain)));
        } else {
            above = Some(above.map_or(gain, |a: f64| a.min(gain)));
        }
        let slope = match previous {
            Some((g0, r0)) if (gain - g0).abs() > 1e-6 && (result - r0).abs() > 1e-3 => ((result - r0) / (gain - g0)).clamp(0.02, 1.5),
            _ => 1.0,
        };
        previous = Some((gain, result));
        let mut next = clamp_gain(gain + (target - result) / slope);
        if let (Some(lo), Some(hi)) = (below, above) {
            if !(next > lo.min(hi) && next < lo.max(hi)) {
                next = (lo + hi) / 2.0;
            }
        }
        if (next - gain).abs() < 1e-3 {
            break; // pinned at the gain limit, or the curve has flattened out (limiter wall)
        }
        gain = next;
    }
    best.ok_or_else(|| "Couldn't measure the export's loudness".to_string())
}

pub(super) async fn normalize_loudness(app_handle: &AppHandle, path: &str, target: f64, ceiling: Option<f64>) -> Result<(), String> {
    let limit = loudness_limit(ceiling);
    let ffmpeg_path = get_ffmpeg_path(app_handle)?;
    let target = target.clamp(-30.0, -5.0);
    let file = path.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let measured = measure_loudness(&ffmpeg_path, &file)?;
        if !measured.is_finite() || measured < -70.0 || (target - measured).abs() < LOUDNESS_TOLERANCE_LU {
            return Ok(()); // silent, or already on target
        }
        let (mut gain, searched) =
            search_loudness_gain(target, target - measured, |g| measure_loudness_through(&ffmpeg_path, &file, &loudness_chain(g, limit)))?;

        let source = PathBuf::from(&file);
        let temps = TempFiles(vec![source.with_extension("loudness.m4a"), source.with_extension("loudness.mp4")]);
        let (audio, muxed) = (&temps.0[0], &temps.0[1]);
        let encode = |g: f64| -> Result<f64, String> {
            let args: Vec<String> = vec![
                "-i".into(), file.clone(), "-vn".into(), "-af".into(), loudness_chain(g, limit),
                "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), path_to_str(audio)?.to_string(),
            ];
            run_ffmpeg_quiet(&ffmpeg_path, &args).map_err(|e| format!("Couldn't adjust the export's loudness: {}", e))?;
            measure_loudness(&ffmpeg_path, path_to_str(audio)?)
        };
        let mut result = encode(gain)?;
        // AAC shifts it by a few hundredths at most; one correction if that crossed the tolerance.
        if (target - result).abs() > LOUDNESS_TOLERANCE_LU && (target - searched).abs() <= LOUDNESS_TOLERANCE_LU {
            gain += target - result;
            result = encode(gain)?;
        }
        let args: Vec<String> = vec![
            "-i".into(), file.clone(), "-i".into(), path_to_str(audio)?.to_string(),
            "-map".into(), "0".into(), "-map".into(), "-0:a".into(), "-map".into(), "1:a".into(),
            "-c".into(), "copy".into(), "-movflags".into(), "+faststart".into(), path_to_str(muxed)?.to_string(),
        ];
        run_ffmpeg_quiet(&ffmpeg_path, &args).map_err(|e| format!("Couldn't save the loudness-adjusted export: {}", e))?;
        std::fs::rename(muxed, &source).map_err(|e| format!("Failed to save the loudness-adjusted export: {}", e))?;
        log::info!("[export] loudness {:.2} LUFS -> {:.2} (target {:.1}, gain {:+.2} dB)", measured, result, target, gain);
        Ok(())
    })
    .await
    .map_err(|e| format!("Loudness task panicked: {e}"))?
}

