//utility.rs
use std::{collections::HashMap, env, fs, path::{Path, PathBuf}, process::Command};
use tauri::{command, AppHandle};

pub fn path_to_str(path: &Path) -> Result<&str, String> {
    path.to_str().ok_or_else(|| format!("Path is not valid UTF-8: {:?}", path))
}

// Lets the frontend adapt the UI to real backend capability gaps - e.g. hiding the Window
// capture option on macOS, where window enumeration/capture genuinely isn't implemented yet (see
// window_capture::macos's module comment), rather than offering it and erroring when clicked.
// std::env::consts::OS is a compile-time constant ("windows" | "macos" | "linux"), so this is
// exactly as reliable as the #[cfg(target_os = ...)] switches the rest of the backend uses.
#[command]
pub fn get_platform() -> &'static str {
    std::env::consts::OS
}

// Centralized FFmpeg path resolution with cross-platform support
pub fn get_ffmpeg_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(windows)]
    let binary_name = "ffmpeg.exe";

    #[cfg(not(windows))]
    let binary_name = "ffmpeg";

    let resource_path = format!("binaries/ffmpeg/{}", binary_name);

    app_handle
        .path_resolver()
        .resolve_resource(&resource_path)
        .ok_or_else(|| format!("Failed to resolve ffmpeg at {}", resource_path))
}

// Centralized ffprobe path resolution, mirroring get_ffmpeg_path
pub fn get_ffprobe_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(windows)]
    let binary_name = "ffprobe.exe";

    #[cfg(not(windows))]
    let binary_name = "ffprobe";

    let resource_path = format!("binaries/ffmpeg/{}", binary_name);

    app_handle
        .path_resolver()
        .resolve_resource(&resource_path)
        .ok_or_else(|| format!("Failed to resolve ffprobe at {}", resource_path))
}


#[derive(Debug, serde::Serialize)]
pub struct FileEntry {
    name: String,
    path: String,
}

// Windows/Linux both conventionally keep recordings under ~/Videos; macOS uses ~/Movies instead.
// The one place this app's "where do Briefcast's files live" convention is decided — shared by
// list_briefcast_files below, trash.rs, and commands/recording.rs. Previously each of the first
// two had their own copy of this, and utility.rs's specifically only ever checked USERPROFILE
// (Windows' home-dir env var), meaning file listing silently returned nothing at all on
// macOS/Linux regardless of anything else already being cross-platform there.
pub fn briefcast_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let home = env::var("USERPROFILE");
    #[cfg(not(target_os = "windows"))]
    let home = env::var("HOME");

    let mut path = PathBuf::from(home.map_err(|_| "Failed to get user's home directory".to_string())?);

    #[cfg(target_os = "macos")]
    path.push("Movies");
    #[cfg(not(target_os = "macos"))]
    path.push("Videos");

    path.push("Briefcast");
    Ok(path)
}

#[command]
pub fn list_briefcast_files()->HashMap<String, Vec<FileEntry>>{
    let mut result = HashMap::new();

    if let Ok(folder_path) = briefcast_dir() {
        if folder_path.exists() && folder_path.is_dir(){
            scan_directory(&folder_path, &folder_path, &mut result);
        }
    }
    println!("Folder: {:?}", &result);
    result
}

// Relative path from the Briefcast root, always "/"-joined regardless of OS — "" denotes the
// root itself. This is also exactly the shape create_folder/move_file expect for their folder
// arguments, so the frontend can pass a key from this map straight back to those commands
// without reconstructing an OS path first.
fn relative_key(root: &Path, dir: &Path) -> String {
    dir.strip_prefix(root)
        .map(|rel| rel.iter().map(|c| c.to_string_lossy().to_string()).collect::<Vec<_>>().join("/"))
        .unwrap_or_default()
}

fn scan_directory(root: &Path, dir: &Path, result: &mut HashMap<String, Vec<FileEntry>>){
    let Ok(entries) = fs::read_dir(dir) else { return };
    let key = relative_key(root, dir);

    let mut files = Vec::new();
    let mut subdirs = Vec::new();

    for entry in entries.flatten(){
        let entry_path = entry.path();

        if entry_path.is_file(){
            if let Some(ext) = entry_path.extension().and_then(|e| e.to_str()){
                let ext = ext.to_lowercase();

                if is_media_file(&ext){
                    if let Some(file_name) = entry_path.file_name(){
                        files.push(FileEntry{
                            name: file_name.to_string_lossy().to_string(),
                            path: entry_path.display().to_string(),
                        });
                    }
                }
            }
        }
         else if entry_path.is_dir() {
            // Trashed files live here (see services/trash.rs) and must never surface in the
            // normal file list — that's the whole point of trash being "hidden" rather than
            // just another folder.
            if entry_path.file_name().and_then(|n| n.to_str()) == Some(".trash") {
                continue;
            }
            subdirs.push(entry_path);
         }
    }

    files.sort_by(|a, b| b.name.cmp(&a.name));
    // Every real directory gets an entry, even an empty one — unlike the old basename-keyed
    // version (which only recorded a folder if it had media files, and collapsed distinct
    // folders sharing a basename into one), a freshly created or currently-empty folder still
    // needs to show up so it's visible and usable as a move/drop target right away.
    result.insert(key, files);

    for subdir in subdirs {
        scan_directory(root, &subdir, result);
    }
}

// Shared by create_folder/move_file: resolves a "/"-joined path relative to the Briefcast root
// (as produced by relative_key above) back into a real filesystem path, rejecting anything that
// isn't a plain, single-level-at-a-time descendant of root (no "..", no absolute components) —
// these relative paths are normally backend-generated, but both commands are reachable directly
// from the frontend, so this is the one place that boundary gets enforced regardless of caller.
fn resolve_relative(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Ok(root.to_path_buf());
    }
    let mut path = root.to_path_buf();
    for component in relative.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err("Invalid folder path".to_string());
        }
        path.push(component);
    }
    Ok(path)
}

fn validate_folder_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        return Err("Invalid folder name".to_string());
    }
    Ok(trimmed)
}

// `parent_path` is "" for the Briefcast root or a relative_key-shaped path (e.g. "Workshops") for
// a subfolder — same convention list_briefcast_files' map is keyed by. Returns the new folder's
// own relative_key, ready to hand straight back for a subsequent create_folder/move_file call.
#[command]
pub fn create_folder(parent_path: String, name: String) -> Result<String, String> {
    let name = validate_folder_name(&name)?;
    let root = briefcast_dir()?;
    let parent = resolve_relative(&root, &parent_path)?;

    if !parent.is_dir() {
        return Err("Parent folder does not exist".to_string());
    }

    let new_dir = parent.join(name);
    if new_dir.exists() {
        return Err("A folder with that name already exists".to_string());
    }
    fs::create_dir_all(&new_dir).map_err(|e| format!("Failed to create folder: {}", e))?;

    Ok(if parent_path.is_empty() { name.to_string() } else { format!("{}/{}", parent_path, name) })
}

// Deletes a folder, but only if it's genuinely empty (no files, no subfolders — checked via a
// real fs::read_dir, not just "no media files of some category", so a folder holding an
// unsupported file type or a nested empty subfolder still refuses to delete rather than
// silently discarding something). The Briefcast root itself can never be deleted this way.
#[command]
pub fn delete_folder(folder_path: String) -> Result<(), String> {
    if folder_path.is_empty() {
        return Err("Cannot delete the Briefcast root folder".to_string());
    }
    let root = briefcast_dir()?;
    let dir = resolve_relative(&root, &folder_path)?;
    if !dir.is_dir() {
        return Err("Folder does not exist".to_string());
    }

    let mut entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read folder: {}", e))?;
    if entries.next().is_some() {
        return Err("Folder is not empty".to_string());
    }

    fs::remove_dir(&dir).map_err(|e| format!("Failed to delete folder: {}", e))
}

// Moves a file (given its current absolute path, as stored on FileEntry) into another folder
// identified by relative_key-shaped path ("" = Briefcast root). Same-folder moves are a no-op
// success rather than an error, so the frontend doesn't need to special-case "dropped it back
// where it came from".
#[command]
pub fn move_file(source_path: String, dest_folder_path: String) -> Result<String, String> {
    let root = briefcast_dir()?;
    let dest_dir = resolve_relative(&root, &dest_folder_path)?;
    if !dest_dir.is_dir() {
        return Err("Destination folder does not exist".to_string());
    }

    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("File does not exist".to_string());
    }

    let file_name = source.file_name().ok_or("Invalid source file name")?;
    let dest_path = dest_dir.join(file_name);

    if dest_path == source {
        return path_to_str(&source).map(|s| s.to_string());
    }
    if dest_path.exists() {
        return Err("A file with that name already exists in that folder".to_string());
    }

    fs::rename(&source, &dest_path).map_err(|e| format!("Failed to move file: {}", e))?;
    path_to_str(&dest_path).map(|s| s.to_string())
}

// Copies an external file (e.g. dragged in from the OS file explorer) into a Briefcast folder,
// identified by relative_key-shaped path ("" = root) — same validation as move_file, but copies
// rather than renames since the source lives outside briefcast_dir() and must be left in place.
// Rejects extensions list_briefcast_files wouldn't display anyway (is_media_file), so a dropped
// file never silently vanishes from the sidebar after a successful copy.
#[command]
pub fn import_file(source_path: String, dest_folder_path: String) -> Result<String, String> {
    let root = briefcast_dir()?;
    let dest_dir = resolve_relative(&root, &dest_folder_path)?;
    if !dest_dir.is_dir() {
        return Err("Destination folder does not exist".to_string());
    }

    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err("File does not exist".to_string());
    }

    let ext_ok = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| is_media_file(&e.to_lowercase()))
        .unwrap_or(false);
    if !ext_ok {
        return Err("Unsupported file type".to_string());
    }

    let file_name = source.file_name().ok_or("Invalid source file name")?;
    let dest_path = dest_dir.join(file_name);
    if dest_path.exists() {
        return Err("A file with that name already exists in that folder".to_string());
    }

    fs::copy(&source, &dest_path).map_err(|e| format!("Failed to import file: {}", e))?;
    path_to_str(&dest_path).map(|s| s.to_string())
}

fn is_media_file(ext: &str)->bool{
    matches!(
        ext,
        "jpg" | "jpeg" | "png" | "gif"  | "bmp" | "tiff" |
        "mp3" | "wav" | "aac" | "flac" | "ogg" | "m4a" |
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "wmv" |
        "pdf"
    )
}

#[command]
pub async fn open_file_from_directory(filepath: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(&filepath)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(&filepath)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try to open the parent directory
        if let Some(parent) = std::path::Path::new(&filepath).parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to open directory: {}", e))?;
        } else {
            return Err("Failed to get parent directory".to_string());
        }
    }

    Ok(())
}


#[command]
pub fn rename_file(old_path: String, new_name: String) -> Result<String, String> {
    if new_name.trim().is_empty() || new_name.contains('/') || new_name.contains('\\') || new_name.contains("..") {
        return Err("Invalid file name".to_string());
    }

    let old = PathBuf::from(&old_path);

    if !old.exists() {
        return Err("File does not exist".to_string());
    }

    let parent = old.parent().ok_or("Could not determine parent directory")?;

    // Preserve the original extension if the new name doesn't already specify one.
    let new_file_name = match old.extension().and_then(|e| e.to_str()) {
        Some(ext) if !new_name.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase())) => {
            format!("{}.{}", new_name, ext)
        }
        _ => new_name,
    };

    let new_path = parent.join(&new_file_name);

    if new_path.exists() {
        return Err("A file with that name already exists".to_string());
    }

    fs::rename(&old, &new_path).map_err(|e| format!("Failed to rename file: {}", e))?;

    path_to_str(&new_path).map(|s| s.to_string())
}

#[tauri::command]
pub fn convert_file_path_to_url(filepath: String) -> Result<String, String> {
    use std::path::PathBuf;
    use std::fs;
    
    let path = PathBuf::from(&filepath);
    
    if !path.exists() {
        return Err(format!("File does not exist: {}", filepath));
    }
    
    // Get the absolute path
    let absolute_path = fs::canonicalize(&path)
        .map_err(|e| format!("Failed to get absolute path: {}", e))?;
    
    // Convert to string
    let path_str = absolute_path.to_string_lossy().to_string();
    
    // Remove Windows extended-length path prefix if present
    let clean_path = if path_str.starts_with(r"\\?\") {
        path_str.trim_start_matches(r"\\?\").to_string()
    } else {
        path_str
    };
    
    println!("Original path: {}", filepath);
    println!("Canonicalized: {}", absolute_path.display());
    println!("Clean path: {}", clean_path);
    
    // Return the clean absolute path - we'll convert it on the frontend
    Ok(clean_path)
}