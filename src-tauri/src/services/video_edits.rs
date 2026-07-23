// video_edits.rs
//
// Non-destructive video edit state (trim/split/delete), persisted next to the source video as a
// JSON sidecar - never as a duplicated copy of the media itself. Mirrors pdf_annotations.rs
// exactly: same sidecar-append naming convention, same write-tmp-then-rename atomicity.
use std::{ffi::OsString, fs, path::{Path, PathBuf}};
use tauri::command;

fn sidecar_path_for(video_path: &Path) -> PathBuf {
    let mut name = video_path.as_os_str().to_os_string();
    name.push(OsString::from(".edits.json"));
    PathBuf::from(name)
}

#[command]
pub fn save_video_edit_state(video_path: String, json: String) -> Result<(), String> {
    let video = PathBuf::from(&video_path);
    if !video.exists() {
        return Err(format!("Video does not exist: {}", video_path));
    }

    let sidecar = sidecar_path_for(&video);
    let tmp_file_name = format!("{}.tmp", sidecar.file_name().unwrap().to_string_lossy());
    let tmp = sidecar.with_file_name(tmp_file_name);

    // Write-then-rename so a crash mid-write can't leave a truncated/corrupt sidecar behind.
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write edit state: {}", e))?;
    fs::rename(&tmp, &sidecar).map_err(|e| format!("Failed to save edit state: {}", e))?;

    Ok(())
}

#[command]
pub fn load_video_edit_state(video_path: String) -> Result<Option<String>, String> {
    let sidecar = sidecar_path_for(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read edit state: {}", e))
}
