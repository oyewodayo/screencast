// video_edits.rs
//
// Non-destructive video edit state (trim/split/delete), persisted next to the source video as a
// JSON sidecar - never as a duplicated copy of the media itself. Mirrors pdf_annotations.rs
// exactly: same sidecar-append naming convention, same write-tmp-then-rename atomicity.
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};
use tauri::command;

fn sidecar_path_for(video_path: &Path) -> PathBuf {
    let mut name = video_path.as_os_str().to_os_string();
    name.push(OsString::from(".edits.json"));
    PathBuf::from(name)
}

#[command(async)]
pub fn save_video_edit_state(video_path: String, json: String) -> Result<(), String> {
    let _serial = crate::services::responsiveness::serial();
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

#[command(async)]
pub fn load_video_edit_state(video_path: String) -> Result<Option<String>, String> {
    let _serial = crate::services::responsiveness::serial();
    let sidecar = sidecar_path_for(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read edit state: {}", e))
}

// Chapter markers (VideoPlayer.tsx) - a separate, much smaller sidecar from the edit state above
// (a plain array of {id, time, label}, meaningful whether or not the file has ever been opened in
// the timeline editor at all) - same write-tmp-then-rename sidecar convention, just a different
// suffix so the two never collide or get confused with each other on disk.
fn chapters_sidecar_path_for(video_path: &Path) -> PathBuf {
    let mut name = video_path.as_os_str().to_os_string();
    name.push(OsString::from(".chapters.json"));
    PathBuf::from(name)
}

#[command(async)]
pub fn save_video_chapters(video_path: String, json: String) -> Result<(), String> {
    let _serial = crate::services::responsiveness::serial();
    let video = PathBuf::from(&video_path);
    if !video.exists() {
        return Err(format!("Video does not exist: {}", video_path));
    }

    let sidecar = chapters_sidecar_path_for(&video);
    let tmp_file_name = format!("{}.tmp", sidecar.file_name().unwrap().to_string_lossy());
    let tmp = sidecar.with_file_name(tmp_file_name);

    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write chapters: {}", e))?;
    fs::rename(&tmp, &sidecar).map_err(|e| format!("Failed to save chapters: {}", e))?;

    Ok(())
}

#[command(async)]
pub fn load_video_chapters(video_path: String) -> Result<Option<String>, String> {
    let _serial = crate::services::responsiveness::serial();
    let sidecar = chapters_sidecar_path_for(&PathBuf::from(&video_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read chapters: {}", e))
}

// A video project: a timeline that isn't attached to any one recording - made from images (or
// started empty) in the Video Editor. The project file itself is only a small header (frame size);
// its timeline lives in the exact same ".edits.json" sidecar a recording's edits do, so the editor
// loads, autosaves and undoes a project through the same path as any video. Lives in the library
// like any other file, so it can be renamed/moved/trashed with the usual tools.
pub const VIDEO_PROJECT_EXTENSION: &str = "briefvideo";

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProjectHeader {
    pub kind: String,
    pub version: u32,
    pub width: u32,
    pub height: u32,
}

const VIDEO_PROJECT_KIND: &str = "briefcast-video-project";

// Creates "<name>.briefvideo" in the library root (suffixing " (2)", " (3)"... on a name clash) with
// `edit_state_json` as its initial timeline, and returns the new project's path.
#[command(async)]
pub fn create_video_project(name: String, width: u32, height: u32, edit_state_json: String) -> Result<String, String> {
    let _serial = crate::services::responsiveness::serial();
    let root = crate::services::utility::briefcast_dir()?;
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create library folder: {}", e))?;
    let safe: String = name
        .trim()
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect();
    let stem = if safe.trim().is_empty() { "Untitled video".to_string() } else { safe.trim().to_string() };
    let mut path = root.join(format!("{}.{}", stem, VIDEO_PROJECT_EXTENSION));
    let mut n = 2;
    while path.exists() {
        path = root.join(format!("{} ({}).{}", stem, n, VIDEO_PROJECT_EXTENSION));
        n += 1;
    }
    // Even dimensions - yuv420p (every export's pixel format) can't encode an odd width/height.
    let header = VideoProjectHeader {
        kind: VIDEO_PROJECT_KIND.to_string(),
        version: 1,
        width: (width.clamp(16, 7680) / 2) * 2,
        height: (height.clamp(16, 7680) / 2) * 2,
    };
    let header_json = serde_json::to_string_pretty(&header).map_err(|e| e.to_string())?;
    fs::write(&path, header_json).map_err(|e| format!("Failed to create project: {}", e))?;
    if let Err(e) = fs::write(sidecar_path_for(&path), edit_state_json.as_bytes()) {
        let _ = fs::remove_file(&path);
        return Err(format!("Failed to create project: {}", e));
    }
    Ok(path.display().to_string())
}

#[command(async)]
pub fn read_video_project(project_path: String) -> Result<VideoProjectHeader, String> {
    let text = fs::read_to_string(&project_path).map_err(|e| format!("Failed to read project: {}", e))?;
    let header: VideoProjectHeader = serde_json::from_str(&text).map_err(|_| "This isn't a Briefcast video project".to_string())?;
    if header.kind != VIDEO_PROJECT_KIND || header.width < 2 || header.height < 2 {
        return Err("This isn't a Briefcast video project".to_string());
    }
    Ok(header)
}
