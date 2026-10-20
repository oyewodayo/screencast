// services/smart_render.rs
//
// Smart render for plain cuts: an export that only cuts (no effects, overlays, transitions,
// captions or reframing) doesn't need to re-encode the video at all where it keeps whole GOPs of
// the source. Each clip becomes up to three pieces:
//
//     [start .. first keyframe)   re-encoded (a partial GOP can't be copied - its frames depend on
//                                 a keyframe the cut leaves out)
//     [first keyframe .. last keyframe before the end)   STREAM-COPIED: the source's own packets,
//                                 bit-identical, at disk speed
//     [last keyframe .. end)      re-encoded
//
// so trimming an hour-long recording costs a few seconds of encoding around each cut instead of an
// hour of it, and everything kept is untouched - no generation loss at all.
//
// The pieces are joined as an `avc3` MP4: H.264 with its parameter sets (SPS/PPS) carried in the
// stream, so the copied source GOPs and the re-encoded edges can each keep their own (an `avc1`
// file can only declare one set up front - the usual way naive smart cutters produce files some
// players choke on). Verified bit-identical for the copied frames and decoding cleanly across the
// joins in ffmpeg and in the WebView2/Media Foundation player.
//
// This module is the pure part - what's eligible and where each clip splits. Running it is
// smart_render_export (commands/conversion.rs), which verifies the result and falls back to a
// normal export on any doubt.
use std::path::Path;
use std::process::{Command, Stdio};

/// What the cut planner needs to know about a source's video stream.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceVideo {
    pub codec: String,
    pub pix_fmt: String,
    pub width: i64,
    pub height: i64,
    /// Frame rate as a fraction (r_frame_rate).
    pub fps_num: i64,
    pub fps_den: i64,
    /// r_frame_rate == avg_frame_rate: every frame lasts exactly 1/fps.
    pub constant_rate: bool,
}

impl SourceVideo {
    pub fn fps(&self) -> f64 {
        self.fps_num as f64 / self.fps_den.max(1) as f64
    }

    /// Whether a clip from this source can be smart-rendered at all: H.264 (copied GOPs join as
    /// avc3), plain 8-bit 4:2:0 (what the re-encoded edges are), constant frame rate (pieces are
    /// timed by frame count).
    pub fn copyable(&self) -> bool {
        self.codec == "h264" && self.pix_fmt == "yuv420p" && self.constant_rate && self.width > 0 && self.height > 0 && self.fps_num > 0
    }
}

fn parse_rate(r: &str) -> Option<(i64, i64)> {
    let (n, d) = r.split_once('/')?;
    let (n, d) = (n.trim().parse::<i64>().ok()?, d.trim().parse::<i64>().ok()?);
    (n > 0 && d > 0).then_some((n, d))
}

fn hide(cmd: &mut Command) {
    #[cfg(windows)]
    crate::commands::recording::hide_console_window(cmd);
    let _ = cmd;
}

pub fn probe_source(ffprobe: &Path, path: &str) -> Option<SourceVideo> {
    let mut cmd = Command::new(ffprobe);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate",
        "-of",
        "json",
        path,
    ])
    .stdin(Stdio::null())
    .stderr(Stdio::null());
    hide(&mut cmd);
    let out = cmd.output().ok()?;
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let s = json["streams"].get(0)?;
    let (fps_num, fps_den) = parse_rate(s["r_frame_rate"].as_str()?)?;
    let avg = s["avg_frame_rate"].as_str().and_then(parse_rate);
    Some(SourceVideo {
        codec: s["codec_name"].as_str()?.to_string(),
        pix_fmt: s["pix_fmt"].as_str().unwrap_or("").to_string(),
        width: s["width"].as_i64()?,
        height: s["height"].as_i64()?,
        fps_num,
        fps_den,
        // Within a part per thousand: a 29.97 file reports 30000/1001 for both, but an mp4's
        // average can be off in the last digit from its duration rounding.
        constant_rate: avg.is_some_and(|(n, d)| ((n as f64 / d as f64) / (fps_num as f64 / fps_den as f64) - 1.0).abs() < 1e-3),
    })
}

/// One video packet: presentation time (seconds) and whether it's a keyframe (sync sample).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Packet {
    pub pts: f64,
    pub key: bool,
}

/// The source's video packets from `from` to `to` seconds - read from the container's index
/// (ffprobe `-show_packets`), no decoding. Sorted by presentation time.
pub fn probe_packets(ffprobe: &Path, path: &str, from: f64, to: f64) -> Option<Vec<Packet>> {
    let mut cmd = Command::new(ffprobe);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-read_intervals",
        &format!("{:.6}%{:.6}", from.max(0.0), to),
        "-show_entries",
        "packet=pts_time,flags",
        "-of",
        "csv=p=0",
        path,
    ])
    .stdin(Stdio::null())
    .stderr(Stdio::null());
    hide(&mut cmd);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let mut packets: Vec<Packet> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let (pts, flags) = line.trim().split_once(',')?;
            Some(Packet { pts: pts.parse().ok()?, key: flags.starts_with('K') })
        })
        .collect();
    packets.sort_by(|a, b| a.pts.partial_cmp(&b.pts).unwrap_or(std::cmp::Ordering::Equal));
    Some(packets)
}

/// A piece of one clip in the smart-rendered output.
#[derive(Clone, Debug, PartialEq)]
pub enum Piece {
    /// Re-encode the frames with presentation times in [start, end): exactly `frames` of them.
    Encode { start: f64, end: f64, frames: usize },
    /// Stream-copy `frames` packets from the keyframe at `start` (whole GOPs, up to the keyframe
    /// at `end`).
    Copy { start: f64, end: f64, frames: usize },
}

impl Piece {
    pub fn frames(&self) -> usize {
        match self {
            Piece::Encode { frames, .. } | Piece::Copy { frames, .. } => *frames,
        }
    }
}

/// Where the clip [start, end) splits, given its source's packets around it (at least from the
/// keyframe before `start` to past `end`). Times within a quarter frame of a frame's own time
/// count as that frame (cut points come from a UI and float maths). A clip that holds no whole GOP
/// is one Encode piece.
pub fn plan_clip(packets: &[Packet], start: f64, end: f64, fps: f64) -> Vec<Piece> {
    let eps = 0.25 / fps.max(1.0);
    let in_range = |a: f64, b: f64| packets.iter().filter(|p| p.pts >= a - eps && p.pts < b - eps).count();
    let total = in_range(start, end);
    if total == 0 {
        return Vec::new();
    }
    let keys: Vec<f64> = packets.iter().filter(|p| p.key && p.pts >= start - eps && p.pts <= end + eps).map(|p| p.pts).collect();
    let (Some(&k1), Some(&k2)) = (keys.first(), keys.last()) else {
        return vec![Piece::Encode { start, end, frames: total }];
    };
    // The copied stretch ends at the last keyframe (k2) - the clip's own end when that IS a
    // keyframe, so nothing's left for a tail to encode.
    let copy_end = k2;
    if copy_end - k1 <= eps {
        return vec![Piece::Encode { start, end, frames: total }];
    }
    let mut pieces = Vec::new();
    let head = in_range(start, k1);
    if head > 0 {
        pieces.push(Piece::Encode { start, end: k1, frames: head });
    }
    pieces.push(Piece::Copy { start: k1, end: copy_end, frames: in_range(k1, copy_end) });
    let tail = in_range(copy_end, end);
    if tail > 0 {
        pieces.push(Piece::Encode { start: copy_end, end, frames: tail });
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    // A 30fps stream with a keyframe every `gop` frames, from 0 to `secs`.
    fn stream(secs: f64, gop: usize) -> Vec<Packet> {
        (0..(secs * 30.0) as usize).map(|n| Packet { pts: n as f64 / 30.0, key: n % gop == 0 }).collect()
    }

    #[test]
    fn a_clip_copies_its_whole_gops_and_encodes_the_edges() {
        let p = stream(30.0, 60); // keyframes every 2s
        let pieces = plan_clip(&p, 3.5, 11.25, 30.0);
        assert_eq!(
            pieces,
            vec![
                Piece::Encode { start: 3.5, end: 4.0, frames: 15 },
                Piece::Copy { start: 4.0, end: 10.0, frames: 180 },
                Piece::Encode { start: 10.0, end: 11.25, frames: 38 },
            ]
        );
        // Every frame of the clip, exactly once.
        assert_eq!(pieces.iter().map(Piece::frames).sum::<usize>(), ((11.25 - 3.5) * 30.0_f64).ceil() as usize);
    }

    #[test]
    fn cuts_on_keyframes_need_no_encoding() {
        let p = stream(30.0, 60);
        assert_eq!(plan_clip(&p, 4.0, 10.0, 30.0), vec![Piece::Copy { start: 4.0, end: 10.0, frames: 180 }]);
        // A hair off (float maths from the UI) still counts as on the keyframe.
        assert_eq!(plan_clip(&p, 4.0 + 1e-4, 10.0 - 1e-4, 30.0), vec![Piece::Copy { start: 4.0, end: 10.0, frames: 180 }]);
    }

    #[test]
    fn a_clip_without_a_whole_gop_is_encoded() {
        let p = stream(30.0, 60);
        assert_eq!(plan_clip(&p, 4.5, 5.5, 30.0), vec![Piece::Encode { start: 4.5, end: 5.5, frames: 30 }]);
        // Contains a keyframe but no full GOP after it before the end.
        let pieces = plan_clip(&p, 3.0, 5.0, 30.0);
        assert_eq!(pieces, vec![Piece::Encode { start: 3.0, end: 5.0, frames: 60 }]);
        assert!(plan_clip(&p, 40.0, 41.0, 30.0).is_empty());
    }

    #[test]
    fn only_plain_constant_rate_h264_is_copyable() {
        let v = SourceVideo { codec: "h264".into(), pix_fmt: "yuv420p".into(), width: 1920, height: 1080, fps_num: 30, fps_den: 1, constant_rate: true };
        assert!(v.copyable());
        assert!(!SourceVideo { constant_rate: false, ..v.clone() }.copyable());
        assert!(!SourceVideo { codec: "hevc".into(), ..v.clone() }.copyable());
        assert!(!SourceVideo { pix_fmt: "yuv420p10le".into(), ..v.clone() }.copyable());
        assert_eq!(parse_rate("30000/1001"), Some((30000, 1001)));
        assert_eq!(parse_rate("0/0"), None);
    }
}
