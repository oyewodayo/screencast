// services/whiteboards.rs
//
// Persistence for the "Whiteboard" feature (src/components/whiteboard/*) - a diagramming surface
// (shapes + connectors), distinct from the "Board" feature (services/boards.rs), which is an
// image-collage/moodboard tool. Each whiteboard is its own project folder under
// briefcast_dir()/Whiteboards/<id>/:
//   whiteboard.json - the frontend's WhiteboardDocument (src/utils/whiteboardTypes.ts), stored as
//                      an opaque string here (this file only ever peeks at a few top-level fields
//                      via serde_json::Value for list_whiteboards - the document shape is
//                      FE-owned, same philosophy as boards.rs treating BoardDocument as opaque)
//   thumbnail.png   - small preview PNG for the whiteboard-picker grid (see save_whiteboard_thumbnail)
//
// No assets/ subfolder (unlike boards.rs) - a whiteboard's nodes are vector shapes/text, nothing
// that needs a copied-in source file.
//
// Write-then-rename on every save, same crash-safety convention as boards.rs/image_annotations.rs.
use super::utility::briefcast_dir;
use std::{fs, path::PathBuf};
use tauri::command;

// Also used by utility.rs's scan_directory to exclude this folder from the normal file list, same
// reasoning as boards.rs's BOARDS_DIR_NAME - whiteboard project files must never show up as loose
// entries in the sidebar's file list.
pub const WHITEBOARDS_DIR_NAME: &str = "Whiteboards";

fn whiteboards_root() -> Result<PathBuf, String> {
    let root = briefcast_dir()?.join(WHITEBOARDS_DIR_NAME);
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Whiteboards folder: {}", e))?;
    Ok(root)
}

// Whiteboard ids are frontend-generated UUIDs (crypto.randomUUID(), same convention as boards.rs),
// but every command below is directly reachable, so this boundary is enforced here regardless of
// caller - rejects anything that could escape whiteboards_root() via a path separator or a
// "." / ".." segment.
fn whiteboard_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("Invalid whiteboard id".to_string());
    }
    Ok(whiteboards_root()?.join(id))
}

#[derive(Debug, serde::Serialize)]
pub struct WhiteboardSummary {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
    thumbnail_path: Option<String>,
}

fn read_summary(dir: &PathBuf, id: &str) -> Option<WhiteboardSummary> {
    let json = fs::read_to_string(dir.join("whiteboard.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    let name = value.get("name")?.as_str()?.to_string();
    let created_at = value.get("createdAt")?.as_str()?.to_string();
    let updated_at = value.get("updatedAt")?.as_str()?.to_string();
    let thumbnail = dir.join("thumbnail.png");
    let thumbnail_path = thumbnail
        .is_file()
        .then(|| thumbnail.to_string_lossy().to_string());
    Some(WhiteboardSummary {
        id: id.to_string(),
        name,
        created_at,
        updated_at,
        thumbnail_path,
    })
}

#[command]
pub fn list_whiteboards() -> Result<Vec<WhiteboardSummary>, String> {
    let root = whiteboards_root()?;
    let mut summaries: Vec<WhiteboardSummary> = Vec::new();

    let entries =
        fs::read_dir(&root).map_err(|e| format!("Failed to read Whiteboards folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // A whiteboard folder that fails to parse (e.g. mid-write, or corrupted) is skipped rather
        // than failing the whole list - one bad whiteboard shouldn't hide every other one.
        if let Some(summary) = read_summary(&path, id) {
            summaries.push(summary);
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

#[command]
pub fn create_whiteboard(id: String, name: String, json: String) -> Result<WhiteboardSummary, String> {
    let dir = whiteboard_dir(&id)?;
    if dir.exists() {
        return Err("A whiteboard with that id already exists".to_string());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create whiteboard folder: {}", e))?;
    save_whiteboard(id.clone(), json)?;
    read_summary(&dir, &id)
        .ok_or_else(|| "Failed to read back newly created whiteboard".to_string())
        .map(|mut s| {
            s.name = name;
            s
        })
}

// Recursive plain-file copy (whiteboard.json, thumbnail.png) - std::fs has no built-in directory
// copy, so this is the manual equivalent of `cp -r`. Used only by duplicate_whiteboard below.
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

// Copies an existing whiteboard's whole project folder (whiteboard.json, thumbnail.png) verbatim
// into a new id - deliberately does NOT touch whiteboard.json's id/name/timestamps fields itself,
// same "frontend owns the document shape" division of labor as boards.rs's duplicate_board:
// the frontend calls load_whiteboard/save_whiteboard right after this to patch those fields in.
// `new_id` is frontend-generated (crypto.randomUUID()), same convention create_whiteboard's `id` uses.
#[command]
pub fn duplicate_whiteboard(source_id: String, new_id: String) -> Result<(), String> {
    let source_dir = whiteboard_dir(&source_id)?;
    if !source_dir.is_dir() {
        return Err("Source whiteboard does not exist".to_string());
    }
    let dest_dir = whiteboard_dir(&new_id)?;
    if dest_dir.exists() {
        return Err("A whiteboard with that id already exists".to_string());
    }
    copy_dir_recursive(&source_dir, &dest_dir)
}

#[command]
pub fn save_whiteboard(id: String, json: String) -> Result<(), String> {
    let dir = whiteboard_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create whiteboard folder: {}", e))?;

    let target = dir.join("whiteboard.json");
    let tmp = dir.join("whiteboard.json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write whiteboard: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save whiteboard: {}", e))?;
    Ok(())
}

#[command]
pub fn load_whiteboard(id: String) -> Result<String, String> {
    let target = whiteboard_dir(&id)?.join("whiteboard.json");
    fs::read_to_string(&target).map_err(|e| format!("Failed to load whiteboard: {}", e))
}

#[command]
pub fn delete_whiteboard(id: String) -> Result<(), String> {
    let dir = whiteboard_dir(&id)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete whiteboard: {}", e))
}

#[command]
pub fn save_whiteboard_thumbnail(whiteboard_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let dir = whiteboard_dir(&whiteboard_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create whiteboard folder: {}", e))?;

    let target = dir.join("thumbnail.png");
    let tmp = dir.join("thumbnail.png.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write thumbnail: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save thumbnail: {}", e))
}

// Writes a flattened export into a "Whiteboard" subfolder of the Briefcast root (not a
// source-file's sibling - a whiteboard has no single source file, and not the root itself - same
// "keep every export easy to find in one place" reasoning as boards.rs's export_board_png).
// Singular "Whiteboard", not "Whiteboards" (WHITEBOARDS_DIR_NAME) - the latter is this module's own
// internal project storage, excluded from the sidebar entirely; this is a normal, browsable
// library folder, just like any the user creates themselves. Timestamp-suffixed so repeat exports
// of the same whiteboard never collide.
#[command]
pub fn export_whiteboard_png(whiteboard_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let root = briefcast_dir()?.join("Whiteboard");
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Whiteboard folder: {}", e))?;

    let safe_name: String = whiteboard_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe_name = if safe_name.trim().is_empty() {
        "Whiteboard".to_string()
    } else {
        safe_name
    };
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let output = root.join(format!("{} {}.png", safe_name, stamp));

    let tmp_file_name = format!("{}.tmp", output.file_name().unwrap().to_string_lossy());
    let tmp = output.with_file_name(tmp_file_name);
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write export: {}", e))?;
    fs::rename(&tmp, &output).map_err(|e| format!("Failed to save export: {}", e))?;
    Ok(output.to_string_lossy().to_string())
}

// "Save As" counterpart to export_whiteboard_png above - writes to an EXACT destination path the
// frontend already resolved via its own native save-file dialog, rather than always landing in
// briefcast_dir()/Whiteboard/. Same write-then-rename crash-safety convention as every other save
// in this file.
#[command]
pub fn export_whiteboard_png_to_path(dest_path: String, bytes: Vec<u8>) -> Result<(), String> {
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination folder: {}", e))?;
    }
    let file_name = dest
        .file_name()
        .ok_or("Invalid destination path")?
        .to_string_lossy();
    let tmp = dest.with_file_name(format!("{}.tmp", file_name));
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write export: {}", e))?;
    fs::rename(&tmp, &dest).map_err(|e| format!("Failed to save export: {}", e))?;
    Ok(())
}
