//utility.rs
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{command, path::BaseDirectory, AppHandle, Manager};

pub fn path_to_str(path: &Path) -> Result<&str, String> {
    path.to_str()
        .ok_or_else(|| format!("Path is not valid UTF-8: {:?}", path))
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
        .path()
        .resolve(&resource_path, BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve ffmpeg at {}: {}", resource_path, e))
}

// Centralized ffprobe path resolution, mirroring get_ffmpeg_path
pub fn get_ffprobe_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(windows)]
    let binary_name = "ffprobe.exe";

    #[cfg(not(windows))]
    let binary_name = "ffprobe";

    let resource_path = format!("binaries/ffmpeg/{}", binary_name);

    app_handle
        .path()
        .resolve(&resource_path, BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve ffprobe at {}: {}", resource_path, e))
}

// Bundled libheif CLI decoder (binaries/heif/) - the fallback HEIC/HEIF decode path used when
// Windows' own WIC decoder can't (see services/heif_tool.rs). Windows-only, mirroring
// get_ffmpeg_path's shape rather than its cross-platform support - there's no macOS/Linux binary
// bundled because that fallback path is never reached on those platforms in the first place (see
// main.rs's cfg-gating of the heic_windows/heif_tool modules).
pub fn get_heif_decoder_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let resource_path = "binaries/heif/heif-dec.exe";

    app_handle
        .path()
        .resolve(resource_path, BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve heif-dec at {}: {}", resource_path, e))
}

// Same bundle as get_heif_decoder_path (shares its DLLs), but for gallery-grid thumbnails - see
// services/heif_tool.rs's extract_thumbnail for why this is a different tool from heif-dec: it
// renders/extracts the small embedded preview HEIC containers already carry instead of doing a
// full tile-grid reconstruction, which is dramatically faster (~0.4s vs ~9s per photo, measured)
// for something that's only ever displayed a few hundred pixels wide anyway.
//
// Deliberately derived from get_heif_decoder_path's own resolved path rather than a second,
// independent resolve_resource("binaries/heif/heif-thumbnailer.exe") call: that second call was
// observed failing to find a real, verified-present file after this binary was added to the
// already-registered binaries/heif/ resource glob with no accompanying Rust source change - dev
// mode's resource resolution apparently doesn't always notice a bare file addition to a directory
// it already resolved once. Piggybacking on the proven-working heif-dec.exe resolution and just
// swapping the file name sidesteps that entirely, and is arguably more correct anyway: the two
// tools are always co-located by construction (README's bundling instructions), so "wherever
// heif-dec.exe actually resolved to" is a more reliable source of truth than a second lookup.
pub fn get_heif_thumbnailer_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let decoder_path = get_heif_decoder_path(app_handle)?;
    let thumbnailer_path = decoder_path.with_file_name("heif-thumbnailer.exe");
    if !thumbnailer_path.exists() {
        return Err(format!(
            "heif-thumbnailer.exe not found next to heif-dec.exe at {}",
            thumbnailer_path.display()
        ));
    }
    Ok(thumbnailer_path)
}

#[derive(Debug, serde::Serialize)]
pub struct FileEntry {
    name: String,
    path: String,
}

fn home_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let home = env::var("USERPROFILE");
    #[cfg(not(target_os = "windows"))]
    let home = env::var("HOME");

    home.map(PathBuf::from)
        .map_err(|_| "Failed to get user's home directory".to_string())
}

// Windows/Linux both conventionally keep recordings under ~/Videos; macOS uses ~/Movies instead.
// The out-of-the-box location, used whenever no custom location has been configured (see
// briefcast_dir below) — Previously this *was* briefcast_dir itself, and utility.rs's own copy
// specifically only ever checked USERPROFILE (Windows' home-dir env var), meaning file listing
// silently returned nothing at all on macOS/Linux regardless of anything else already being
// cross-platform there.
fn default_briefcast_dir() -> Result<PathBuf, String> {
    let mut path = home_dir()?;

    #[cfg(target_os = "macos")]
    path.push("Movies");
    #[cfg(not(target_os = "macos"))]
    path.push("Videos");

    path.push("Briefcast");
    Ok(path)
}

// Where a user-chosen storage location (see set_briefcast_dir) is remembered — deliberately a
// dotfile under the user's home directory rather than inside the Briefcast folder itself (which
// would make it impossible to read once that folder has been relocated) or Tauri's own
// app_config_dir (which would require threading an AppHandle through every one of the many
// existing call sites below and in trash.rs/recording.rs for no real benefit - this is the same
// plain env-var home-dir lookup default_briefcast_dir already uses).
fn config_file_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".briefcast").join("config.json"))
}

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct AppConfig {
    custom_briefcast_dir: Option<String>,
}

fn read_custom_briefcast_dir() -> Result<Option<PathBuf>, String> {
    let path = config_file_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("Failed to read config: {}", e))?;
    let config: AppConfig = serde_json::from_str(&contents).unwrap_or_default();
    Ok(config
        .custom_briefcast_dir
        .filter(|s| !s.is_empty())
        .map(PathBuf::from))
}

fn write_custom_briefcast_dir(dir: Option<&Path>) -> Result<(), String> {
    let path = config_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
    }
    let config = AppConfig {
        custom_briefcast_dir: dir.map(|d| d.display().to_string()),
    };
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write config: {}", e))
}

// The one place this app's "where do Briefcast's files live" convention is decided — shared by
// list_briefcast_files below, trash.rs, and commands/recording.rs. Checks for a user-configured
// override (see set_briefcast_dir) before falling back to default_briefcast_dir's out-of-the-box
// location - every existing caller already treats this as opaque (just "the Briefcast root"), so
// none of them need to change for a relocated folder to take effect everywhere at once.
pub fn briefcast_dir() -> Result<PathBuf, String> {
    if let Some(custom) = read_custom_briefcast_dir()? {
        return Ok(custom);
    }
    default_briefcast_dir()
}

// Moves every top-level entry of `old_root` into `new_root` (which must already exist), then
// removes the now-empty old_root - used by both set_briefcast_dir and reset_briefcast_dir, the
// only difference between them being what new_root resolves to. fs::rename is tried first for
// each entry (an instant metadata-only op, even for a large video file) and only falls back to a
// recursive copy+delete when rename fails - the normal reason being old_root/new_root sitting on
// different volumes/drives, which fs::rename can never succeed across no matter how it's retried.
// This carries .trash (services/trash.rs) and any per-video .edits.json sidecar along for free,
// with no special-casing needed - they move as part of whatever folder already contains them.
fn relocate_briefcast_dir(old_root: &Path, new_root: &Path) -> Result<(), String> {
    let entries = fs::read_dir(old_root)
        .map_err(|e| format!("Failed to read {}: {}", old_root.display(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read {}: {}", old_root.display(), e))?;
        let src = entry.path();
        let dest = new_root.join(entry.file_name());
        if dest.exists() {
            return Err(format!(
                "\"{}\" already exists at the new location",
                entry.file_name().to_string_lossy()
            ));
        }
        if fs::rename(&src, &dest).is_ok() {
            continue;
        }
        copy_then_remove(&src, &dest)?;
    }
    fs::remove_dir_all(old_root)
        .map_err(|e| format!("Failed to remove the old Briefcast folder: {}", e))?;

    // Every file/folder now genuinely lives under new_root, but nothing above touched the
    // *contents* of any sidecar JSON (video_edits.rs's .edits.json, trash.rs's manifest.json) -
    // those still hold absolute paths baked in under the old root (an image overlay's `src`, a
    // clip's `sourcePath`, a trashed item's `original_path`), which is exactly why an image
    // overlay can go blank after a relocation even though the picture itself moved along with
    // everything else. Self-heals them here rather than leaving that for whoever notices later.
    repair_stale_file_references_in(new_root);
    Ok(())
}

// Rewrites any absolute path found inside a sidecar JSON file (.edits.json, trash's manifest.json)
// that no longer resolves, by looking up its filename among everything actually present under
// `root` and pointing it there instead - generic by design (walks the JSON tree blindly rather
// than knowing field names like "src"/"sourcePath"/"original_path") so it doesn't couple this
// Rust module to the frontend's evolving edit-state shape (see video_edits.rs's own header
// comment: the backend deliberately treats that JSON as opaque). Covers both the relocation case
// above and, as a standalone command, the same class of breakage from any other cause (a file
// renamed/moved by hand outside the app, etc.) - called once from the frontend on startup as a
// cheap best-effort safety net, not just right after a move.
fn repair_stale_file_references_in(root: &Path) -> u32 {
    let mut files_by_name: std::collections::HashMap<String, PathBuf> =
        std::collections::HashMap::new();
    index_files_by_name(root, &mut files_by_name);

    let mut repaired_count = 0u32;
    repair_sidecars_in_tree(root, &files_by_name, &mut repaired_count);
    repaired_count
}

fn index_files_by_name(dir: &Path, index: &mut std::collections::HashMap<String, PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            index_files_by_name(&path, index);
        } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            // A duplicate basename in two different folders just keeps whichever is seen last -
            // this repair only ever replaces a reference that's already broken (see the `!exists()`
            // check below), so an ambiguous guess is still strictly no worse than the untouched
            // broken path it started from.
            index.insert(name.to_string(), path);
        }
    }
}

fn repair_value_paths(
    value: &mut serde_json::Value,
    index: &std::collections::HashMap<String, PathBuf>,
    fixed_any: &mut bool,
) {
    match value {
        serde_json::Value::String(s) => {
            let candidate = Path::new(s.as_str());
            if candidate.is_absolute() && !candidate.exists() {
                if let Some(name) = candidate.file_name().and_then(|n| n.to_str()) {
                    if let Some(real_path) = index.get(name).and_then(|p| p.to_str()) {
                        *s = real_path.to_string();
                        *fixed_any = true;
                    }
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                repair_value_paths(item, index, fixed_any);
            }
        }
        serde_json::Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                repair_value_paths(item, index, fixed_any);
            }
        }
        _ => {}
    }
}

fn repair_sidecars_in_tree(
    dir: &Path,
    index: &std::collections::HashMap<String, PathBuf>,
    repaired_count: &mut u32,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            repair_sidecars_in_tree(&path, index, repaired_count);
            continue;
        }
        let is_sidecar = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".edits.json") || n == "manifest.json")
            .unwrap_or(false);
        if !is_sidecar {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        let mut fixed_any = false;
        repair_value_paths(&mut value, index, &mut fixed_any);
        if fixed_any {
            if let Ok(rewritten) = serde_json::to_string_pretty(&value) {
                if fs::write(&path, rewritten).is_ok() {
                    *repaired_count += 1;
                }
            }
        }
    }
}

#[command]
pub fn repair_stale_file_references() -> Result<u32, String> {
    let root = briefcast_dir()?;
    if !root.is_dir() {
        return Ok(0);
    }
    Ok(repair_stale_file_references_in(&root))
}

fn copy_then_remove(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir_all(dest)
            .map_err(|e| format!("Failed to create \"{}\": {}", dest.display(), e))?;
        for entry in
            fs::read_dir(src).map_err(|e| format!("Failed to read {}: {}", src.display(), e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read {}: {}", src.display(), e))?;
            copy_then_remove(&entry.path(), &dest.join(entry.file_name()))?;
        }
        fs::remove_dir(src).map_err(|e| format!("Failed to remove \"{}\": {}", src.display(), e))
    } else {
        fs::copy(src, dest).map_err(|e| format!("Failed to copy \"{}\": {}", src.display(), e))?;
        fs::remove_file(src).map_err(|e| format!("Failed to remove \"{}\": {}", src.display(), e))
    }
}

#[command]
pub fn get_briefcast_dir() -> Result<String, String> {
    briefcast_dir().and_then(|p| path_to_str(&p).map(|s| s.to_string()))
}

#[command]
pub fn get_default_briefcast_dir() -> Result<String, String> {
    default_briefcast_dir().and_then(|p| path_to_str(&p).map(|s| s.to_string()))
}

// new_parent_dir is a folder the user picked (e.g. the Desktop) - the actual new root always nests
// a "Briefcast" subfolder under it (matching the existing Videos/Briefcast convention) rather than
// using the picked folder directly, so this never dumps app files loose into an unrelated folder
// and never has to decide how to merge with whatever else might already be sitting in it.
// A plain (non-async) command, like every other one in this file - Tauri v1 already dispatches
// these on its own worker thread pool rather than the event loop, which is what keeps a large
// library move from freezing the UI without this needing to manually manage a runtime/thread pool
// of its own (that would require adding tokio as a direct dependency here just to reach a
// scheduler tauri already owns and uses internally for exactly this).
#[command]
pub fn set_briefcast_dir(new_parent_dir: String, app_handle: AppHandle) -> Result<String, String> {
    let new_parent = PathBuf::from(&new_parent_dir);
    if !new_parent.is_dir() {
        return Err("Selected location does not exist".to_string());
    }
    let new_root = new_parent.join("Briefcast");
    let old_root = briefcast_dir()?;

    if new_root == old_root {
        return path_to_str(&new_root).map(|s| s.to_string());
    }
    // Neither folder may sit inside the other - moving a directory into its own descendant is
    // meaningless (and would recurse forever), and the reverse would leave the "old" root still
    // existing as an ancestor of the very folder that's supposed to replace it.
    if new_root.starts_with(&old_root) {
        return Err("The new location can't be inside the current Briefcast folder".to_string());
    }
    if old_root.exists() && old_root.starts_with(&new_root) {
        return Err(
            "The new location can't be a parent of the current Briefcast folder".to_string(),
        );
    }

    if new_root.exists() {
        let has_entries = fs::read_dir(&new_root)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        if has_entries {
            return Err(
                "A non-empty \"Briefcast\" folder already exists at that location".to_string(),
            );
        }
    } else {
        fs::create_dir_all(&new_root)
            .map_err(|e| format!("Failed to create the new Briefcast folder: {}", e))?;
    }

    if old_root.exists() {
        relocate_briefcast_dir(&old_root, &new_root)?;
    }

    write_custom_briefcast_dir(Some(&new_root))?;
    crate::services::file_watcher::start_watching(&app_handle, &new_root);
    path_to_str(&new_root).map(|s| s.to_string())
}

#[command]
pub fn reset_briefcast_dir(app_handle: AppHandle) -> Result<String, String> {
    let old_root = briefcast_dir()?;
    let new_root = default_briefcast_dir()?;

    if old_root == new_root {
        write_custom_briefcast_dir(None)?;
        return path_to_str(&new_root).map(|s| s.to_string());
    }

    if new_root.exists() {
        let has_entries = fs::read_dir(&new_root)
            .map(|mut d| d.next().is_some())
            .unwrap_or(false);
        if has_entries {
            return Err(
                "A non-empty \"Briefcast\" folder already exists at the default location"
                    .to_string(),
            );
        }
    } else {
        fs::create_dir_all(&new_root)
            .map_err(|e| format!("Failed to create the default Briefcast folder: {}", e))?;
    }

    if old_root.exists() {
        relocate_briefcast_dir(&old_root, &new_root)?;
    }

    write_custom_briefcast_dir(None)?;
    crate::services::file_watcher::start_watching(&app_handle, &new_root);
    path_to_str(&new_root).map(|s| s.to_string())
}

#[command]
pub fn list_briefcast_files() -> HashMap<String, Vec<FileEntry>> {
    let mut result = HashMap::new();

    if let Ok(folder_path) = briefcast_dir() {
        if folder_path.exists() && folder_path.is_dir() {
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
        .map(|rel| {
            rel.iter()
                .map(|c| c.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn scan_directory(root: &Path, dir: &Path, result: &mut HashMap<String, Vec<FileEntry>>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let key = relative_key(root, dir);

    let mut files = Vec::new();
    let mut subdirs = Vec::new();

    for entry in entries.flatten() {
        let entry_path = entry.path();

        if entry_path.is_file() {
            if let Some(ext) = entry_path.extension().and_then(|e| e.to_str()) {
                let ext = ext.to_lowercase();

                if is_media_file(&ext) {
                    if let Some(file_name) = entry_path.file_name() {
                        files.push(FileEntry {
                            name: file_name.to_string_lossy().to_string(),
                            path: entry_path.display().to_string(),
                        });
                    }
                }
            }
        } else if entry_path.is_dir() {
            // Trashed files (.trash, see services/trash.rs), board projects/assets (Boards, see
            // services/boards.rs), and doc projects (Docs, see services/docs.rs) all live here but
            // must never surface in the normal file list — that's the whole point of each being
            // "hidden" rather than just another folder.
            let dir_name = entry_path.file_name().and_then(|n| n.to_str());
            if dir_name == Some(".trash")
                || dir_name == Some(super::boards::BOARDS_DIR_NAME)
                || dir_name == Some(super::docs::DOCS_DIR_NAME)
            {
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
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
    {
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

    Ok(if parent_path.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", parent_path, name)
    })
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

fn is_media_file(ext: &str) -> bool {
    matches!(
        ext,
        "jpg" | "jpeg" | "png" | "gif"  | "bmp" | "tiff" | "heic" | "heif" |
        "mp3" | "wav" | "aac" | "flac" | "ogg" | "m4a" |
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "wmv" |
        "pdf" |
        // docx/md/txt: what Docs' export feature (services/docs.rs's export_doc/
        // export_doc_binary) writes into briefcast_dir() - without these here they'd be filtered
        // out of scan_directory below and never reach the frontend's file list at all.
        "docx" | "md" | "txt"
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

// Launches filepath in whatever app the OS has associated with its extension - used by the
// Documents tab's preview panel for docx/md/txt, which have no in-app renderer. Deliberately a
// dedicated OS-spawn command rather than @tauri-apps/api/shell's open() - that API's default
// validation regex only accepts http(s)/mailto/tel targets and rejects local file paths outright,
// and Tauri v1's allowlist has no way to widen it to permit arbitrary local paths without opening
// the same hole up for URLs too.
#[command]
pub async fn open_file_with_default_app(filepath: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Passing a file path (not a directory) launches its associated default app - the same
        // trick open_file_from_directory uses with /select, just without that flag.
        Command::new("explorer")
            .arg(&filepath)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&filepath)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&filepath)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

#[command]
pub fn rename_file(old_path: String, new_name: String) -> Result<String, String> {
    if new_name.trim().is_empty()
        || new_name.contains('/')
        || new_name.contains('\\')
        || new_name.contains("..")
    {
        return Err("Invalid file name".to_string());
    }

    let old = PathBuf::from(&old_path);

    if !old.exists() {
        return Err("File does not exist".to_string());
    }

    let parent = old.parent().ok_or("Could not determine parent directory")?;

    // Preserve the original extension if the new name doesn't already specify one.
    let new_file_name = match old.extension().and_then(|e| e.to_str()) {
        Some(ext)
            if !new_name
                .to_lowercase()
                .ends_with(&format!(".{}", ext.to_lowercase())) =>
        {
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
    use std::fs;
    use std::path::PathBuf;

    let path = PathBuf::from(&filepath);

    if !path.exists() {
        return Err(format!("File does not exist: {}", filepath));
    }

    // Get the absolute path
    let absolute_path =
        fs::canonicalize(&path).map_err(|e| format!("Failed to get absolute path: {}", e))?;

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

// Cursor position in this window's own client (CSS/logical pixel) coordinate space, for
// drag-and-drop position tracking that can't rely on DOM dragover events - Tauri v1's
// FileDropEvent (window.onFileDropEvent) fires reliably for an external OS-level drag
// (Explorer -> this window) but carries no cursor position at all, and WebView2's own DOM
// dragover/dragleave events are unreliable for that same cross-window drag (they're solid for
// an in-page drag that never leaves the webview, which is why the existing sidebar-to-folder
// move feature and this app's own clip-reordering both use plain dragover successfully - but a
// drag whose *origin* is a different native window doesn't reliably reach the DOM the same way).
//
// Everything here is computed with plain Win32 calls in this one function, deliberately never
// mixed with Tauri's own JS-side window.innerPosition()/scaleFactor() - a first version did mix
// them (native GetCursorPos + JS-side window geometry) and produced consistently wrong
// coordinates (confirmed: a drop over the visible timeline resolved to a DOM element in the
// sidebar instead) on a display with 250% scaling. Root cause: tauri itself depends on its own
// `windows` crate version (0.61, as of the v2 upgrade - was 0.39 under tauri 1.8.3) which can
// differ from this file's own direct dependency (pinned at 0.57) - the two crate versions don't
// always agree on HWND's inner representation (older versions wrap a bare `isize`; 0.61 wraps a
// `*mut c_void` instead), so window.hwnd().0 needs an explicit `as isize` to rebuild this crate's
// own HWND from it rather than assuming the two are interchangeable as-is. Separately, the two
// dependency graphs also disagree somewhere on the DPI virtualization applied to a plain
// cross-process GetCursorPos call vs. what WebView2 itself sees. Asking Win32 for the window's own
// client-area origin (ClientToScreen) and DPI (GetDpiForWindow) *in the same call*, instead of
// trusting a second source to agree, sidesteps having to figure out exactly which of the two
// disagreed.
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn get_cursor_position_in_window(window: tauri::Window) -> Result<(f64, f64), String> {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let hwnd = HWND(
        window
            .hwnd()
            .map_err(|e| format!("Failed to get window handle: {}", e))?
            .0 as isize,
    );

    // (0, 0) in client coordinates -> the client area's top-left corner in screen coordinates.
    let mut origin = POINT::default();
    unsafe {
        if !ClientToScreen(hwnd, &mut origin).as_bool() {
            return Err("ClientToScreen failed".to_string());
        }
    }

    let mut cursor = POINT::default();
    unsafe {
        GetCursorPos(&mut cursor).map_err(|e| format!("Failed to get cursor position: {}", e))?;
    }

    let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.0;
    let client_x = (cursor.x - origin.x) as f64 / scale;
    let client_y = (cursor.y - origin.y) as f64 / scale;

    Ok((client_x, client_y))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_cursor_position_in_window(_window: tauri::Window) -> Result<(f64, f64), String> {
    Err("Cursor position lookup is only implemented on Windows".to_string())
}
