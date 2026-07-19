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
            scan_directory(&folder_path, &mut result);
        }
    }
    println!("Folder: {:?}", &result);
    result
}

fn scan_directory(path: &Path, result: &mut HashMap<String, Vec<FileEntry>>){
    if let Ok(entries) = fs::read_dir(path){
        let folder_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "Briefcast".to_string());

        let mut files = Vec::new();

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
                scan_directory(&entry_path, result);
             }
        }

        files.sort_by(|a, b| b.name.cmp(&a.name));
        if !files.is_empty(){
            result.insert(folder_name, files);
        }
    }
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