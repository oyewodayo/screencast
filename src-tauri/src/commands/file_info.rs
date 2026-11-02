// Backs the sidebar file menu's "Info" panel (src/components/Modals/FileInfoModal.tsx): everything
// that can be said about one file, gathered from three places in one round-trip -
//
// - the filesystem: size, created/modified/accessed times, read-only/hidden attributes;
// - ffprobe (video, audio and images): container, duration, codecs, dimensions, frame rate, and the
//   container's own tags - including `creation_time` and the ISO 6709 `location` a phone writes
//   into the videos it captures;
// - EXIF (images): date taken, camera, lens, exposure and GPS position. ffprobe exposes none of
//   these for stills, hence the separate kamadak-exif read.
//
// Each source is best-effort: a file ffprobe can't open, or a photo with no EXIF block, still gets
// the filesystem section rather than an error. PDF metadata (page count, author, producer...) is
// read on the frontend through pdf.js, which is already loaded for the PDF viewer.
use serde::Serialize;
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

#[cfg(windows)]
use crate::commands::recording::hide_console_window;
use crate::commands::embedded_scan::{self, EmbeddedScan};
use crate::services::responsiveness::{blocking, output_with_timeout};
use crate::services::utility::get_ffprobe_path;

const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
// Word/line counts for text files are a whole-file read, so they stop being "instant" past this.
const TEXT_STATS_MAX_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Serialize, Clone, Copy)]
pub struct GeoPoint {
    pub lat: f64,
    pub lon: f64,
    pub altitude: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfo {
    pub codec: Option<String>,
    pub codec_long: Option<String>,
    pub profile: Option<String>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub display_aspect_ratio: Option<String>,
    pub frame_rate: Option<f64>,
    pub bit_rate: Option<u64>,
    pub pixel_format: Option<String>,
    pub color_space: Option<String>,
    pub rotation: Option<i64>,
    pub frame_count: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub codec: Option<String>,
    pub codec_long: Option<String>,
    pub sample_rate: Option<u64>,
    pub channels: Option<u64>,
    pub channel_layout: Option<String>,
    pub bit_rate: Option<u64>,
    pub language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub format_name: Option<String>,
    pub format_long_name: Option<String>,
    pub duration_secs: Option<f64>,
    pub bit_rate: Option<u64>,
    pub creation_time: Option<String>,
    pub location: Option<GeoPoint>,
    pub video: Option<VideoStreamInfo>,
    pub audio: Vec<AudioStreamInfo>,
    pub subtitle_count: usize,
    // Non-audio/video payloads: Matroska attachments (fonts, files), data tracks (GoPro GPS
    // telemetry, timecode...) and cover art - moved into FileInfo::embedded.
    #[serde(skip)]
    pub embedded: Vec<(String, String, bool)>,
    // Every other container tag (title, artist, album, encoder, make/model...) as-is, so nothing
    // a file carries is hidden just because this struct didn't anticipate it.
    pub tags: Vec<(String, String)>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExifInfo {
    pub date_taken: Option<String>,
    pub date_digitized: Option<String>,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub software: Option<String>,
    pub artist: Option<String>,
    pub copyright: Option<String>,
    pub exposure_time: Option<String>,
    pub f_number: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub focal_length_35mm: Option<String>,
    pub flash: Option<String>,
    pub white_balance: Option<String>,
    pub exposure_program: Option<String>,
    pub metering_mode: Option<String>,
    pub orientation: Option<String>,
    pub pixel_width: Option<u64>,
    pub pixel_height: Option<u64>,
    pub x_resolution: Option<String>,
    pub y_resolution: Option<String>,
    pub color_space: Option<String>,
    pub location: Option<GeoPoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStats {
    pub lines: u64,
    pub words: u64,
    pub characters: u64,
}

// Boards, docs, whiteboards and mindmaps are each a folder of files (content, thumbnail, assets,
// versions...), so their Info shows the folder as a whole.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStats {
    pub files: u64,
    pub folders: u64,
    // The newest modification anywhere inside - the folder's own mtime only changes when an entry
    // is added or removed directly in it, not when a file inside is saved.
    pub newest_modified_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub folder: String,
    pub extension: String,
    pub size_bytes: u64,
    // Milliseconds since the Unix epoch; None where the platform/filesystem doesn't record it.
    pub created_ms: Option<i64>,
    pub modified_ms: Option<i64>,
    pub accessed_ms: Option<i64>,
    pub read_only: bool,
    pub hidden: bool,
    pub media: Option<MediaInfo>,
    pub exif: Option<ExifInfo>,
    pub text: Option<TextStats>,
    pub embedded: EmbeddedScan,
    pub folder_stats: Option<FolderStats>,
}

#[tauri::command]
pub async fn get_file_info(app_handle: AppHandle, path: String) -> Result<FileInfo, String> {
    // Resolved up front (cheap) so the blocking closure doesn't need the AppHandle.
    let ffprobe = get_ffprobe_path(&app_handle).ok();
    blocking(move || collect_file_info(Path::new(&path), ffprobe.as_deref())).await?
}

// Info for an item that lives in Briefcast's own stores rather than as a plain file path the
// frontend holds: boards/docs/whiteboards/mindmaps (one folder per id) and trashed files.
#[tauri::command]
pub async fn get_library_item_info(app_handle: AppHandle, kind: String, id: String) -> Result<FileInfo, String> {
    use crate::services::{boards, docs, mindmaps, trash, whiteboards};
    let path = match kind.as_str() {
        "board" => boards::board_dir(&id)?,
        "doc" => docs::doc_dir(&id)?,
        "whiteboard" => whiteboards::whiteboard_dir(&id)?,
        "mindmap" => mindmaps::mindmap_dir(&id)?,
        "trash" => {
            // Same traversal guard the stores' own *_dir helpers apply to their ids.
            if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
                return Err("Invalid trash item".to_string());
            }
            trash::trash_dir()?.join(&id)
        }
        other => return Err(format!("Unknown item kind: {}", other)),
    };
    let ffprobe = get_ffprobe_path(&app_handle).ok();
    blocking(move || collect_file_info(&path, ffprobe.as_deref())).await?
}

fn collect_folder_info(path: &Path, meta: &fs::Metadata) -> FileInfo {
    // Bounded so a pathological folder can't stall the panel; these stores hold tens of files.
    const MAX_ENTRIES: u64 = 100_000;
    let (mut size, mut files, mut folders, mut newest) = (0u64, 0u64, 0u64, None::<SystemTime>);
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if files + folders >= MAX_ENTRIES {
                break;
            }
            let Ok(m) = entry.metadata() else { continue };
            if m.is_dir() {
                folders += 1;
                stack.push(entry.path());
            } else {
                files += 1;
                size += m.len();
                if let Ok(t) = m.modified() {
                    newest = Some(newest.map_or(t, |n| n.max(t)));
                }
            }
        }
    }
    FileInfo {
        name: path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
        path: path.to_string_lossy().into_owned(),
        folder: path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        extension: String::new(),
        size_bytes: size,
        created_ms: meta.created().ok().and_then(to_epoch_ms),
        modified_ms: meta.modified().ok().and_then(to_epoch_ms),
        accessed_ms: meta.accessed().ok().and_then(to_epoch_ms),
        read_only: meta.permissions().readonly(),
        hidden: is_hidden(path, meta),
        media: None,
        exif: None,
        text: None,
        embedded: EmbeddedScan::default(),
        folder_stats: Some(FolderStats {
            files,
            folders,
            newest_modified_ms: newest.and_then(to_epoch_ms),
        }),
    }
}

fn collect_file_info(path: &Path, ffprobe: Option<&Path>) -> Result<FileInfo, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Could not read file: {}", e))?;
    if meta.is_dir() {
        return Ok(collect_folder_info(path, &meta));
    }
    if !meta.is_file() {
        return Err("Not a file".to_string());
    }
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let is_media = matches!(
        extension.as_str(),
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "wmv" | "m4v" | "mp3" | "wav" | "aac" | "flac" | "ogg" | "m4a"
            | "jpg" | "jpeg" | "png" | "gif" | "bmp" | "tiff" | "tif" | "webp" | "heic" | "heif"
    );
    let is_exif_image = matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "png" | "tiff" | "tif" | "webp" | "heic" | "heif"
    );
    let is_text = matches!(extension.as_str(), "md" | "txt");

    let mut media = match (is_media, ffprobe) {
        (true, Some(ffprobe)) => probe_media(ffprobe, path),
        _ => None,
    };
    let exif = if is_exif_image { read_exif(path) } else { None };
    let text = if is_text && meta.len() <= TEXT_STATS_MAX_BYTES {
        text_stats(path)
    } else {
        None
    };

    let mut embedded = embedded_scan::scan(path, &extension, meta.len());
    if let Some(media) = media.as_mut() {
        for (label, detail, notable) in media.embedded.drain(..) {
            embedded.items.push(embedded_scan::EmbeddedItem { label, detail, notable });
        }
        embedded.checks.push("media streams".to_string());
    }

    Ok(FileInfo {
        name: path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
        path: path.to_string_lossy().into_owned(),
        folder: path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
        extension,
        size_bytes: meta.len(),
        created_ms: meta.created().ok().and_then(to_epoch_ms),
        modified_ms: meta.modified().ok().and_then(to_epoch_ms),
        accessed_ms: meta.accessed().ok().and_then(to_epoch_ms),
        read_only: meta.permissions().readonly(),
        hidden: is_hidden(path, &meta),
        media,
        exif,
        text,
        embedded,
        folder_stats: None,
    })
}

fn to_epoch_ms(t: SystemTime) -> Option<i64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

#[cfg(windows)]
fn is_hidden(_path: &Path, meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn is_hidden(path: &Path, _meta: &fs::Metadata) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.'))
}

// --- ffprobe ---------------------------------------------------------------------------------

fn probe_media(ffprobe: &Path, path: &Path) -> Option<MediaInfo> {
    let mut cmd = Command::new(ffprobe);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    cmd.args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path);
    let output = output_with_timeout(cmd, PROBE_TIMEOUT).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    Some(parse_probe(&json))
}

fn parse_probe(json: &serde_json::Value) -> MediaInfo {
    let format = &json["format"];
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    let str_of = |v: &serde_json::Value| v.as_str().filter(|s| !s.trim().is_empty()).map(str::to_string);
    // ffprobe reports most numbers as JSON strings ("bit_rate": "123456").
    let u64_of = |v: &serde_json::Value| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()));

    let video = streams
        .iter()
        // Cover art in an mp3/m4a is a one-frame "video" stream - not what anyone means by video.
        .find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"].as_i64() != Some(1))
        .map(|s| VideoStreamInfo {
            codec: str_of(&s["codec_name"]),
            codec_long: str_of(&s["codec_long_name"]),
            profile: str_of(&s["profile"]),
            width: s["width"].as_u64(),
            height: s["height"].as_u64(),
            display_aspect_ratio: str_of(&s["display_aspect_ratio"]).filter(|r| r != "0:1"),
            frame_rate: s["avg_frame_rate"]
                .as_str()
                .and_then(parse_ratio)
                .or_else(|| s["r_frame_rate"].as_str().and_then(parse_ratio)),
            bit_rate: u64_of(&s["bit_rate"]),
            pixel_format: str_of(&s["pix_fmt"]),
            color_space: str_of(&s["color_space"]),
            rotation: s["side_data_list"]
                .as_array()
                .and_then(|list| list.iter().find_map(|d| d["rotation"].as_i64()))
                .or_else(|| s["tags"]["rotate"].as_str().and_then(|r| r.parse().ok()))
                .filter(|r| *r != 0),
            frame_count: u64_of(&s["nb_frames"]),
        });

    let audio = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .map(|s| AudioStreamInfo {
            codec: str_of(&s["codec_name"]),
            codec_long: str_of(&s["codec_long_name"]),
            sample_rate: u64_of(&s["sample_rate"]),
            channels: s["channels"].as_u64(),
            channel_layout: str_of(&s["channel_layout"]),
            bit_rate: u64_of(&s["bit_rate"]),
            language: str_of(&s["tags"]["language"]).filter(|l| l != "und"),
        })
        .collect();

    let subtitle_count = streams.iter().filter(|s| s["codec_type"] == "subtitle").count();

    let mut embedded = Vec::new();
    for s in &streams {
        let tag = |k: &str| str_of(&s["tags"][k]).or_else(|| str_of(&s["tags"][k.to_uppercase().as_str()]));
        match s["codec_type"].as_str() {
            Some("attachment") => embedded.push((
                "Attached file".to_string(),
                [tag("filename"), tag("mimetype").map(|m| format!("({})", m))].into_iter().flatten().collect::<Vec<_>>().join(" "),
                true,
            )),
            Some("data") => {
                let codec = str_of(&s["codec_tag_string"]).or_else(|| str_of(&s["codec_name"]));
                let label = match codec.as_deref() {
                    Some("gpmd") => "GoPro telemetry track (GPS, gyro, accelerometer)",
                    Some("tmcd") => "Timecode track",
                    Some("mebx") | Some("camm") => "Camera motion / metadata track",
                    _ => "Data track",
                };
                let notable = codec.as_deref() != Some("tmcd");
                let detail = [codec, tag("handler_name").map(|h| h.trim().to_string())]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · ");
                embedded.push((label.to_string(), detail, notable));
            }
            Some("video") if s["disposition"]["attached_pic"].as_i64() == Some(1) => embedded.push((
                "Cover art".to_string(),
                match (s["width"].as_u64(), s["height"].as_u64()) {
                    (Some(w), Some(h)) => format!("{} × {} image", w, h),
                    _ => "Embedded image".to_string(),
                },
                false,
            )),
            _ => {}
        }
    }

    // Tag keys vary in case between muxers (Matroska writes "CREATION_TIME"), so match loosely.
    let mut creation_time = None;
    let mut location = None;
    let mut tags = Vec::new();
    if let Some(map) = format["tags"].as_object() {
        for (key, value) in map {
            let Some(value) = value.as_str().filter(|v| !v.trim().is_empty()) else { continue };
            let lower = key.to_lowercase();
            if lower == "creation_time" || lower == "com.apple.quicktime.creationdate" || lower == "date" {
                creation_time.get_or_insert_with(|| value.to_string());
            } else if lower.starts_with("location") || lower == "com.apple.quicktime.location.iso6709" {
                if location.is_none() {
                    location = parse_iso6709(value);
                }
            } else {
                tags.push((key.clone(), value.to_string()));
            }
        }
    }
    tags.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    let is_still_image = matches!(
        format["format_name"].as_str(),
        Some(f) if f.ends_with("_pipe") || f == "image2"
    );

    MediaInfo {
        format_name: str_of(&format["format_name"]),
        format_long_name: str_of(&format["format_long_name"]),
        // Stills report a meaningless 0.04s "duration" (one frame at 25fps) - drop it.
        duration_secs: if is_still_image {
            None
        } else {
            format["duration"].as_str().and_then(|d| d.parse().ok()).filter(|d: &f64| *d > 0.0)
        },
        bit_rate: if is_still_image { None } else { u64_of(&format["bit_rate"]) },
        creation_time,
        location,
        video,
        audio,
        subtitle_count,
        embedded,
        tags,
    }
}

fn parse_ratio(ratio: &str) -> Option<f64> {
    let (num, den) = ratio.split_once('/')?;
    let (num, den): (f64, f64) = (num.parse().ok()?, den.parse().ok()?);
    (den != 0.0 && num != 0.0).then(|| num / den)
}

// ISO 6709 as phones write it into a video's container: "+37.7749-122.4194+010.000/" -
// signed decimal degrees latitude, longitude, then an optional altitude in metres.
fn parse_iso6709(raw: &str) -> Option<GeoPoint> {
    let raw = raw.trim().trim_end_matches('/');
    let mut parts = Vec::new();
    let mut start = 0;
    for (i, c) in raw.char_indices().skip(1) {
        if c == '+' || c == '-' {
            parts.push(&raw[start..i]);
            start = i;
        }
    }
    parts.push(&raw[start..]);
    let lat: f64 = parts.first()?.parse().ok()?;
    let lon: f64 = parts.get(1)?.parse().ok()?;
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return None;
    }
    Some(GeoPoint {
        lat,
        lon,
        altitude: parts.get(2).and_then(|a| a.parse().ok()),
    })
}

// --- EXIF ------------------------------------------------------------------------------------

fn read_exif(path: &Path) -> Option<ExifInfo> {
    use exif::{In, Tag};

    let file = fs::File::open(path).ok()?;
    let exif = exif::Reader::new()
        .read_from_container(&mut BufReader::new(file))
        .ok()?;

    let field = |tag: Tag| exif.get_field(tag, In::PRIMARY);
    // display_value() renders enums as words ("fired", "auto") and rationals as "1/125" etc.
    let text = |tag: Tag| {
        field(tag).map(|f| {
            f.display_value()
                .with_unit(&exif)
                .to_string()
                .trim_matches('"')
                .trim()
                .to_string()
        })
        .filter(|s| !s.is_empty())
    };
    let uint = |tag: Tag| field(tag).and_then(|f| f.value.get_uint(0)).map(u64::from);

    let info = ExifInfo {
        date_taken: text(Tag::DateTimeOriginal).or_else(|| text(Tag::DateTime)),
        date_digitized: text(Tag::DateTimeDigitized),
        make: text(Tag::Make),
        model: text(Tag::Model),
        lens: text(Tag::LensModel).or_else(|| text(Tag::LensMake)),
        software: text(Tag::Software),
        artist: text(Tag::Artist),
        copyright: text(Tag::Copyright),
        exposure_time: text(Tag::ExposureTime),
        f_number: text(Tag::FNumber),
        iso: text(Tag::PhotographicSensitivity),
        focal_length: text(Tag::FocalLength),
        focal_length_35mm: text(Tag::FocalLengthIn35mmFilm),
        flash: text(Tag::Flash),
        white_balance: text(Tag::WhiteBalance),
        exposure_program: text(Tag::ExposureProgram),
        metering_mode: text(Tag::MeteringMode),
        orientation: text(Tag::Orientation),
        pixel_width: uint(Tag::PixelXDimension),
        pixel_height: uint(Tag::PixelYDimension),
        x_resolution: text(Tag::XResolution),
        y_resolution: text(Tag::YResolution),
        color_space: text(Tag::ColorSpace),
        location: exif_location(&exif),
    };
    Some(info)
}

fn exif_location(exif: &exif::Exif) -> Option<GeoPoint> {
    use exif::{In, Tag, Value};

    let dms = |tag: Tag| -> Option<f64> {
        match &exif.get_field(tag, In::PRIMARY)?.value {
            Value::Rational(v) if v.len() >= 3 => {
                Some(v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0)
            }
            _ => None,
        }
    };
    let reference = |tag: Tag| -> Option<String> {
        match &exif.get_field(tag, In::PRIMARY)?.value {
            Value::Ascii(v) => v.first().map(|b| String::from_utf8_lossy(b).to_uppercase()),
            _ => None,
        }
    };

    let mut lat = dms(Tag::GPSLatitude)?;
    let mut lon = dms(Tag::GPSLongitude)?;
    if reference(Tag::GPSLatitudeRef).as_deref() == Some("S") {
        lat = -lat;
    }
    if reference(Tag::GPSLongitudeRef).as_deref() == Some("W") {
        lon = -lon;
    }
    // A zeroed-out GPS block (common after "remove location" in some editors) isn't a location.
    if lat == 0.0 && lon == 0.0 {
        return None;
    }
    let altitude = match exif.get_field(Tag::GPSAltitude, In::PRIMARY).map(|f| &f.value) {
        Some(Value::Rational(v)) if !v.is_empty() => {
            let below_sea = exif
                .get_field(Tag::GPSAltitudeRef, In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
                == Some(1);
            let metres = v[0].to_f64();
            Some(if below_sea { -metres } else { metres })
        }
        _ => None,
    };
    Some(GeoPoint { lat, lon, altitude })
}

// --- text ------------------------------------------------------------------------------------

fn text_stats(path: &Path) -> Option<TextStats> {
    let mut bytes = Vec::new();
    fs::File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    Some(TextStats {
        lines: if text.is_empty() { 0 } else { text.lines().count() as u64 },
        words: text.split_whitespace().count() as u64,
        characters: text.chars().count() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_iso6709_with_and_without_altitude() {
        let p = parse_iso6709("+37.7749-122.4194+010.000/").unwrap();
        assert!((p.lat - 37.7749).abs() < 1e-9);
        assert!((p.lon + 122.4194).abs() < 1e-9);
        assert_eq!(p.altitude, Some(10.0));

        let p = parse_iso6709("-33.8688+151.2093/").unwrap();
        assert!((p.lat + 33.8688).abs() < 1e-9);
        assert!((p.lon - 151.2093).abs() < 1e-9);
        assert_eq!(p.altitude, None);

        assert!(parse_iso6709("garbage").is_none());
    }

    #[test]
    fn parses_frame_rate_ratios() {
        assert!((parse_ratio("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert_eq!(parse_ratio("0/0"), None);
    }

    #[test]
    fn probe_json_pulls_out_creation_time_and_location() {
        let json: serde_json::Value = serde_json::json!({
            "format": {
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                "duration": "12.5",
                "bit_rate": "4000000",
                "tags": {
                    "creation_time": "2024-10-08T17:10:00.000000Z",
                    "location": "+06.5244+003.3792/",
                    "encoder": "Lavf61"
                }
            },
            "streams": [
                { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080,
                  "avg_frame_rate": "30/1", "side_data_list": [{ "rotation": -90 }] },
                { "codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2 }
            ]
        });
        let info = parse_probe(&json);
        assert_eq!(info.creation_time.as_deref(), Some("2024-10-08T17:10:00.000000Z"));
        assert!((info.location.unwrap().lat - 6.5244).abs() < 1e-9);
        assert_eq!(info.duration_secs, Some(12.5));
        let video = info.video.unwrap();
        assert_eq!((video.width, video.height, video.rotation), (Some(1920), Some(1080), Some(-90)));
        assert_eq!(info.audio.len(), 1);
        assert_eq!(info.tags, vec![("encoder".to_string(), "Lavf61".to_string())]);
    }
}
