// services/mindmaps.rs
//
// Persistence for the "Mindmap" feature (src/components/mindmap/*) - a structured learning-roadmap
// builder, distinct from the "Whiteboard" feature (services/whiteboards.rs), which is a freeform
// diagramming surface. Each mindmap is its own project folder under briefcast_dir()/Mindmaps/<id>/:
//   mindmap.json    - the frontend's MindmapDocument (src/utils/mindmapTypes.ts), stored as an
//                      opaque string here (this file only peeks at a few top-level fields via
//                      serde_json::Value for list_mindmaps - the document shape is FE-owned, the
//                      same philosophy whiteboards.rs and boards.rs both apply to theirs)
//   thumbnail.png   - small preview PNG for the mindmap-picker grid
//
// No assets/ subfolder: a mindmap's nodes are typed text boxes and links, with no copied-in binary
// content of their own. (Should images ever land on this canvas, follow whiteboards.rs's own
// import_whiteboard_image convention rather than inventing a second one.)
//
// Write-then-rename on every save, same crash-safety convention as every other service here.
use super::utility::briefcast_dir;
use std::{fs, path::PathBuf};
use tauri::command;

// Also used by utility.rs's scan_directory to exclude this folder from the normal file list, same
// reasoning as BOARDS_DIR_NAME/WHITEBOARDS_DIR_NAME - project files must never show up as loose
// entries in the sidebar's file list.
pub const MINDMAPS_DIR_NAME: &str = "Mindmaps";

fn mindmaps_root() -> Result<PathBuf, String> {
    let root = briefcast_dir()?.join(MINDMAPS_DIR_NAME);
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Mindmaps folder: {}", e))?;
    Ok(root)
}

// Ids are frontend-generated UUIDs (crypto.randomUUID()), but every command below is directly
// reachable, so this boundary is enforced here regardless of caller - rejects anything that could
// escape mindmaps_root() via a path separator or a "." / ".." segment.
fn mindmap_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("Invalid mindmap id".to_string());
    }
    Ok(mindmaps_root()?.join(id))
}

#[derive(Debug, serde::Serialize)]
pub struct MindmapSummary {
    id: String,
    name: String,
    description: String,
    created_at: String,
    updated_at: String,
    thumbnail_path: Option<String>,
    // Shown on the picker card - "how much roadmap is actually in here" is the one thing a name and
    // a date can't convey, and it's cheap to read off the document we've already parsed.
    node_count: u64,
}

fn read_summary(dir: &PathBuf, id: &str) -> Option<MindmapSummary> {
    let json = fs::read_to_string(dir.join("mindmap.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    let name = value.get("name")?.as_str()?.to_string();
    let created_at = value.get("createdAt")?.as_str()?.to_string();
    let updated_at = value.get("updatedAt")?.as_str()?.to_string();
    // Absent on a document written before the field existed - an empty description is a perfectly
    // valid state, so this falls back rather than rejecting the whole summary.
    let description = value
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .to_string();
    let node_count = value
        .get("nodes")
        .and_then(|n| n.as_array())
        .map(|a| a.len() as u64)
        .unwrap_or(0);
    let thumbnail = dir.join("thumbnail.png");
    let thumbnail_path = thumbnail
        .is_file()
        .then(|| thumbnail.to_string_lossy().to_string());
    Some(MindmapSummary {
        id: id.to_string(),
        name,
        description,
        created_at,
        updated_at,
        thumbnail_path,
        node_count,
    })
}

#[command]
pub fn list_mindmaps() -> Result<Vec<MindmapSummary>, String> {
    let root = mindmaps_root()?;
    let mut summaries: Vec<MindmapSummary> = Vec::new();
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return Ok(summaries),
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        // A folder without a readable mindmap.json is skipped rather than failing the whole listing
        // - one corrupt project should never make the picker unopenable.
        if let Some(summary) = read_summary(&entry.path(), &id) {
            summaries.push(summary);
        }
    }
    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

#[command]
pub fn create_mindmap(id: String, name: String, json: String) -> Result<MindmapSummary, String> {
    let dir = mindmap_dir(&id)?;
    if dir.exists() {
        return Err("A mindmap with that id already exists".to_string());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create mindmap folder: {}", e))?;
    save_mindmap(id.clone(), json)?;
    read_summary(&dir, &id)
        .ok_or_else(|| "Failed to read back newly created mindmap".to_string())
        .map(|mut s| {
            s.name = name;
            s
        })
}

// Recursive plain-file copy - std::fs has no built-in directory copy, so this is the manual
// equivalent of `cp -r`. Used only by duplicate_mindmap below.
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("Failed to create folder: {}", e))?;
    for entry in fs::read_dir(src).map_err(|e| format!("Failed to read folder: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read folder entry: {}", e))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to read entry type: {}", e))?;
        let dest_path = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            fs::copy(entry.path(), &dest_path)
                .map_err(|e| format!("Failed to copy file: {}", e))?;
        }
    }
    Ok(())
}

// Copies an existing mindmap's whole project folder into a new id - deliberately does NOT touch
// mindmap.json's own id/name/timestamps, same "frontend owns the document shape" division of labor
// duplicate_whiteboard uses: the frontend loads and re-saves right after this to patch those in.
#[command]
pub fn duplicate_mindmap(source_id: String, new_id: String) -> Result<(), String> {
    let source_dir = mindmap_dir(&source_id)?;
    if !source_dir.is_dir() {
        return Err("Source mindmap does not exist".to_string());
    }
    let dest_dir = mindmap_dir(&new_id)?;
    if dest_dir.exists() {
        return Err("A mindmap with that id already exists".to_string());
    }
    copy_dir_recursive(&source_dir, &dest_dir)
}

#[command]
pub fn save_mindmap(id: String, json: String) -> Result<(), String> {
    let dir = mindmap_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create mindmap folder: {}", e))?;
    let target = dir.join("mindmap.json");
    let tmp = dir.join("mindmap.json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write mindmap: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save mindmap: {}", e))?;
    Ok(())
}

#[command]
pub fn load_mindmap(id: String) -> Result<String, String> {
    let target = mindmap_dir(&id)?.join("mindmap.json");
    fs::read_to_string(&target).map_err(|e| format!("Failed to load mindmap: {}", e))
}

#[command]
pub fn delete_mindmap(id: String) -> Result<(), String> {
    let dir = mindmap_dir(&id)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete mindmap: {}", e))
}

#[command]
pub fn save_mindmap_thumbnail(mindmap_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let dir = mindmap_dir(&mindmap_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create mindmap folder: {}", e))?;
    let target = dir.join("thumbnail.png");
    let tmp = dir.join("thumbnail.png.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write thumbnail: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save thumbnail: {}", e))?;
    Ok(())
}

// Writes an exported file into the Briefcast library itself (rather than a user-chosen path), so it
// shows up in the sidebar's own file list alongside recordings and screenshots - same convention
// export_whiteboard_png follows. `extension` is what makes this serve both the PNG and PDF exports
// from one implementation; it is whitelisted rather than trusted, since a command is directly
// reachable and this decides a filename on disk.
#[command]
pub fn export_mindmap_file(
    mindmap_name: String,
    extension: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    const ALLOWED: [&str; 2] = ["png", "pdf"];
    let ext = extension.to_ascii_lowercase();
    if !ALLOWED.contains(&ext.as_str()) {
        return Err(format!("Unsupported export type: {}", ext));
    }
    let root = briefcast_dir()?.join("Mindmap");
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Mindmap folder: {}", e))?;
    let safe: String = mindmap_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == ' ' { c } else { '_' })
        .collect();
    let stem = if safe.trim().is_empty() { "Mindmap".to_string() } else { safe.trim().to_string() };

    // Never overwrite an earlier export - suffix until the name is free, same "always version, never
    // clobber" convention the rest of this app's exports use.
    let mut candidate = root.join(format!("{}.{}", stem, ext));
    let mut counter = 2;
    while candidate.exists() {
        candidate = root.join(format!("{} ({}).{}", stem, counter, ext));
        counter += 1;
    }
    fs::write(&candidate, &bytes).map_err(|e| format!("Failed to write export: {}", e))?;
    Ok(candidate.to_string_lossy().to_string())
}

// Save-As counterpart: the destination comes from the frontend's own native save dialog, which is
// what constrains where this can write, so no extension whitelist applies here - the user picked
// the path and the format along with it.
#[command]
pub fn export_mindmap_to_path(dest_path: String, bytes: Vec<u8>) -> Result<(), String> {
    fs::write(&dest_path, &bytes).map_err(|e| format!("Failed to write file: {}", e))
}
