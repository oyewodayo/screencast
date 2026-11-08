// services/recording_setup.rs
//
// "Record with my current setup", answered in Rust from the settings file - no window, no React
// state. This is what lets the global shortcut, the tray and the phone remote start a recording
// while Briefcast is in the tray with its WebView destroyed, and it is the one place the start
// request is assembled, so the record button and the shortcut cannot drift apart.
//
// The request is built as JSON and deserialized into `FormData`, so it goes through exactly the
// serde schema and field defaults the frontend's own request does - there is no second definition
// of the request to keep in step.
//
// Every rule here mirrors one the frontend applied before this existed (BottomDocker's device and
// format fallbacks, Dashboard's settings merge); each says where it came from.

use crate::services::phone_camera::PHONE_DEVICE_SENTINEL;
use crate::services::settings_store::{get_bool, get_str, get_str_list, get_u32};
use serde_json::{json, Map, Value};

/// Record types a start request can carry ("c" - screenshot - is not a recording).
pub const RECORD_TYPES: [&str; 6] = ["sva", "sa", "s", "va", "v", "a"];
const DEFAULT_RECORD_TYPE: &str = "sva";

// Same lists as BottomDocker.tsx's VIDEO_EXTS / AUDIO_EXTS, first entry = fallback.
const VIDEO_EXTS: [&str; 5] = ["mp4", "mkv", "mov", "webm", "avi"];
const AUDIO_EXTS: [&str; 4] = ["mp3", "wav", "aac", "wma"];

/// What is plugged in right now, from the recording module's device cache.
#[derive(Debug, Default, Clone)]
pub struct ConnectedDevices {
    pub audio: Vec<String>,
    pub video: Vec<String>,
}

fn record_type(settings: &Map<String, Value>, record_type_override: Option<&str>) -> Result<String, String> {
    if let Some(rt) = record_type_override {
        return if RECORD_TYPES.contains(&rt) {
            Ok(rt.to_owned())
        } else {
            Err(format!("Unknown recording setup \"{}\".", rt))
        };
    }
    let saved = get_str(settings, "defaultRecordType", DEFAULT_RECORD_TYPE);
    Ok(if RECORD_TYPES.contains(&saved) { saved } else { DEFAULT_RECORD_TYPE }.to_owned())
}

/// The saved format when it suits the record type, otherwise that kind's first format - the rule
/// BottomDocker applies when the record type changes.
fn file_ext(settings: &Map<String, Value>, record_type: &str) -> String {
    let allowed: &[&str] = if record_type == "a" { &AUDIO_EXTS } else { &VIDEO_EXTS };
    let saved = get_str(settings, "defaultFileExt", allowed[0]).to_ascii_lowercase();
    if allowed.contains(&saved.as_str()) { saved } else { allowed[0].to_owned() }
}

/// The saved mic if it is plugged in, else the first one (BottomDocker's loadDevices).
fn audio_device(settings: &Map<String, Value>, connected: &ConnectedDevices) -> String {
    let saved = get_str(settings, "defaultAudioDevice", "");
    if !saved.is_empty() && connected.audio.iter().any(|d| d == saved) {
        return saved.to_owned();
    }
    connected.audio.first().cloned().unwrap_or_default()
}

/// The saved cameras that are plugged in, else the first camera. The phone is kept when it was
/// chosen: it is never in the connected list (it is not a capture device - see phone_camera.rs),
/// and whoever starts the recording is responsible for having a window that can capture it.
fn video_devices(settings: &Map<String, Value>, connected: &ConnectedDevices) -> Vec<String> {
    let saved = get_str_list(settings, "defaultVideoDevices");
    let mut chosen: Vec<String> = saved.iter().filter(|d| connected.video.contains(d)).cloned().collect();
    if chosen.is_empty() {
        chosen.extend(connected.video.first().cloned());
    }
    if saved.iter().any(|d| d == PHONE_DEVICE_SENTINEL) {
        chosen.push(PHONE_DEVICE_SENTINEL.to_owned());
    }
    chosen
}

/// `<prefix>_<date>`, the shape of the bottom bar's default file name. Collisions are resolved
/// where the file is created (resolve_recording_output_path), not here.
fn file_name(settings: &Map<String, Value>, today: chrono::NaiveDate) -> String {
    let prefix = get_str(settings, "defaultFileNamePrefix", "Recording");
    let prefix = if prefix.trim().is_empty() { "Recording" } else { prefix };
    format!("{}_{}", prefix, today.format("%Y_%m_%d"))
}

/// Webcam background for a bubble baked into the screen recording (cameraEffect.ts's
/// cameraEffectSpec). A separately recorded webcam gets it in the editor instead, at full quality.
fn camera_effect(settings: &Map<String, Value>, record_type: &str, separate_webcam: bool) -> Value {
    if record_type != "sva" || separate_webcam {
        return Value::Null;
    }
    let Some(pref) = settings.get("cameraBackground").and_then(Value::as_object) else {
        return Value::Null;
    };
    let kind = pref.get("kind").and_then(Value::as_str).unwrap_or("off");
    let image_path = pref.get("imagePath").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null);
    if kind == "off" || (kind == "image" && image_path.is_null()) {
        return Value::Null;
    }
    json!({
        "kind": kind,
        "amount": pref.get("amount").and_then(Value::as_f64).unwrap_or(0.6),
        "color": pref.get("color").cloned().unwrap_or(Value::Null),
        "imagePath": image_path,
    })
}

/// The start request for "my current setup", as the JSON `start_recording` takes. Pure: settings,
/// connected devices and the date in, request out.
pub fn build_start_request(
    settings: &Map<String, Value>,
    record_type_override: Option<&str>,
    connected: &ConnectedDevices,
    today: chrono::NaiveDate,
) -> Result<Value, String> {
    let record_type = record_type(settings, record_type_override)?;
    let separate_webcam = get_bool(settings, "separateWebcamCapture", false);
    Ok(json!({
        "file_name": file_name(settings, today),
        "file_ext": file_ext(settings, &record_type),
        "audio_device": audio_device(settings, connected),
        "video_devices": video_devices(settings, connected),
        // The shortcut and tray record the whole screen; picking a window or region needs the
        // Screen Options picker, which needs a window.
        "screen_size": "fullscreen",
        "window_title": "",
        "overlay_shape": get_str(settings, "cameraOverlayShape", "rounded"),
        "overlay_position": get_str(settings, "cameraOverlayPosition", "bottom_right"),
        "overlay_size": get_str(settings, "cameraOverlaySize", "small"),
        "overlay_border": get_str(settings, "cameraBorder", "none"),
        "overlay_border_color": get_str(settings, "cameraBorderColor", "#ffffff"),
        "include_system_audio": get_bool(settings, "defaultIncludeSystemAudio", false),
        "separate_webcam_capture": separate_webcam,
        "track_clicks": get_bool(settings, "trackClicks", false),
        "track_pointer": get_bool(settings, "editablePointer", false),
        "track_keys": get_bool(settings, "recordShortcuts", false),
        "capture_cursor": get_bool(settings, "captureCursor", true),
        "window_title_bar": get_bool(settings, "windowTitleBar", false),
        "mute_notifications": get_bool(settings, "muteNotificationsWhileRecording", true),
        "enhance_audio": get_bool(settings, "autoEnhanceAudio", true),
        "resolution_width": get_u32(settings, "defaultResolutionWidth"),
        "framerate": get_u32(settings, "defaultFramerate"),
        "camera_effect": camera_effect(settings, &record_type, separate_webcam),
        "record_type": record_type,
    }))
}

/// The start request for the current setup, from the live settings and device cache. Blocking
/// (the device probe) - call it off the async runtime.
pub fn current_setup_request(app: &tauri::AppHandle, record_type_override: Option<&str>) -> Result<Value, String> {
    let settings = crate::services::settings_store::current(app);
    let connected = crate::commands::recording::connected_devices_now(app);
    build_start_request(&settings, record_type_override, &connected, chrono::Local::now().date_naive())
}

/// The frontend's view of the same request: the record shortcut and the tray menu start from this,
/// so a start from the UI and one from Rust are built by the same code.
#[tauri::command]
pub async fn get_current_setup_request(
    app: tauri::AppHandle,
    record_type_override: Option<String>,
) -> Result<Value, String> {
    crate::services::responsiveness::blocking(move || current_setup_request(&app, record_type_override.as_deref())).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::recording::FormData;

    fn settings(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn devices() -> ConnectedDevices {
        ConnectedDevices {
            audio: vec!["Mic A".into(), "Mic B".into()],
            video: vec!["Cam 1".into(), "Cam 2".into()],
        }
    }

    fn day() -> chrono::NaiveDate {
        chrono::NaiveDate::from_ymd_opt(2026, 11, 7).unwrap()
    }

    fn build(s: Value, rt: Option<&str>) -> Value {
        build_start_request(&settings(s), rt, &devices(), day()).unwrap()
    }

    #[test]
    fn empty_settings_give_the_documented_defaults() {
        let r = build(json!({}), None);
        assert_eq!(r["record_type"], "sva");
        assert_eq!(r["file_ext"], "mp4");
        assert_eq!(r["file_name"], "Recording_2026_11_07");
        assert_eq!(r["audio_device"], "Mic A");
        assert_eq!(r["video_devices"], json!(["Cam 1"]));
        assert_eq!(r["capture_cursor"], true);
        assert_eq!(r["enhance_audio"], true);
        assert_eq!(r["resolution_width"], Value::Null);
        assert_eq!(r["camera_effect"], Value::Null);
    }

    #[test]
    fn the_request_deserializes_into_form_data() {
        // The whole point of building JSON: it must be exactly what start_recording accepts.
        let r = build(json!({ "defaultResolutionWidth": 1280, "defaultFramerate": 30 }), Some("sa"));
        serde_json::from_value::<FormData>(r).expect("start request must match FormData");
    }

    #[test]
    fn override_wins_and_bad_overrides_are_refused() {
        assert_eq!(build(json!({ "defaultRecordType": "sva" }), Some("a"))["record_type"], "a");
        assert!(build_start_request(&settings(json!({})), Some("c"), &devices(), day()).is_err());
        assert_eq!(build(json!({ "defaultRecordType": "zz" }), None)["record_type"], "sva");
    }

    #[test]
    fn format_follows_the_record_kind() {
        assert_eq!(build(json!({ "defaultFileExt": "MKV" }), Some("sva"))["file_ext"], "mkv");
        // A video format saved as default never reaches an audio-only recording, and vice versa.
        assert_eq!(build(json!({ "defaultFileExt": "mkv" }), Some("a"))["file_ext"], "mp3");
        assert_eq!(build(json!({ "defaultFileExt": "wav" }), Some("sa"))["file_ext"], "mp4");
    }

    #[test]
    fn saved_devices_are_used_only_while_plugged_in() {
        let r = build(json!({ "defaultAudioDevice": "Mic B", "defaultVideoDevices": ["Cam 2", "Gone"] }), None);
        assert_eq!(r["audio_device"], "Mic B");
        assert_eq!(r["video_devices"], json!(["Cam 2"]));

        let r = build(json!({ "defaultAudioDevice": "Unplugged", "defaultVideoDevices": ["Gone"] }), None);
        assert_eq!(r["audio_device"], "Mic A");
        assert_eq!(r["video_devices"], json!(["Cam 1"]));
    }

    #[test]
    fn no_devices_at_all_gives_empty_choices_not_a_panic() {
        let r = build_start_request(&settings(json!({})), None, &ConnectedDevices::default(), day()).unwrap();
        assert_eq!(r["audio_device"], "");
        assert_eq!(r["video_devices"], json!([]));
    }

    #[test]
    fn a_chosen_phone_camera_is_kept() {
        let r = build(json!({ "defaultVideoDevices": ["Cam 2", PHONE_DEVICE_SENTINEL] }), None);
        assert_eq!(r["video_devices"], json!(["Cam 2", PHONE_DEVICE_SENTINEL]));
    }

    #[test]
    fn camera_background_only_for_a_baked_in_bubble() {
        let bg = json!({ "kind": "blur", "amount": 0.4, "color": "#000000", "imagePath": null });
        assert_eq!(build(json!({ "cameraBackground": bg }), Some("sva"))["camera_effect"]["kind"], "blur");
        assert_eq!(build(json!({ "cameraBackground": bg }), Some("sa"))["camera_effect"], Value::Null);
        assert_eq!(
            build(json!({ "cameraBackground": bg, "separateWebcamCapture": true }), Some("sva"))["camera_effect"],
            Value::Null
        );
        let no_image = json!({ "kind": "image", "amount": 0.4, "imagePath": null });
        assert_eq!(build(json!({ "cameraBackground": no_image }), Some("sva"))["camera_effect"], Value::Null);
    }

    #[test]
    fn blank_prefix_falls_back() {
        assert_eq!(build(json!({ "defaultFileNamePrefix": "  " }), None)["file_name"], "Recording_2026_11_07");
        assert_eq!(build(json!({ "defaultFileNamePrefix": "Demo" }), None)["file_name"], "Demo_2026_11_07");
    }
}
