// services/boards.rs
//
// Persistence for the "Board" feature (src/components/board/*) - a workspace where the user
// arranges several images into one composed layout with per-image padding/border/margin/corner
// styling. Each board is its own project folder under briefcast_dir()/Boards/<id>/:
//   board.json      - the frontend's BoardDocument (src/utils/boardTypes.ts), stored as an opaque
//                      string here (this file only ever peeks at a few top-level fields via
//                      serde_json::Value for list_boards - the document shape is FE-owned, same
//                      philosophy as image_annotations.rs treating ImageEditDocument as opaque)
//   assets/<id>.ext - copies of every image placed on the board (see import_board_image) so the
//                      board keeps working even if the original source file is later moved,
//                      renamed, or deleted elsewhere in the user's library
//   thumbnail.png   - small preview PNG for the board-picker grid (see save_board_thumbnail)
//
// Write-then-rename on every save, same crash-safety convention as image_annotations.rs.
use std::{fs, path::PathBuf};
use tauri::command;
use super::utility::briefcast_dir;

// Also used by utility.rs's scan_directory to exclude this folder from the normal file list, the
// same way ".trash" is already excluded - board project files/assets must never show up as loose
// entries in the sidebar's Image tab.
pub const BOARDS_DIR_NAME: &str = "Boards";

fn boards_root() -> Result<PathBuf, String> {
    let root = briefcast_dir()?.join(BOARDS_DIR_NAME);
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Boards folder: {}", e))?;
    Ok(root)
}

// Board ids are frontend-generated UUIDs (crypto.randomUUID(), same convention as every other id
// in this codebase), but every command below is directly reachable, so this boundary is enforced
// here regardless of caller - rejects anything that could escape boards_root() via a path
// separator or a "." / ".." segment.
fn board_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("Invalid board id".to_string());
    }
    Ok(boards_root()?.join(id))
}

#[derive(Debug, serde::Serialize)]
pub struct BoardSummary {
    id: String,
    name: String,
    created_at: String,
    updated_at: String,
    thumbnail_path: Option<String>,
}

fn read_summary(dir: &PathBuf, id: &str) -> Option<BoardSummary> {
    let json = fs::read_to_string(dir.join("board.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&json).ok()?;
    let name = value.get("name")?.as_str()?.to_string();
    let created_at = value.get("createdAt")?.as_str()?.to_string();
    let updated_at = value.get("updatedAt")?.as_str()?.to_string();
    let thumbnail = dir.join("thumbnail.png");
    let thumbnail_path = thumbnail.is_file().then(|| thumbnail.to_string_lossy().to_string());
    Some(BoardSummary { id: id.to_string(), name, created_at, updated_at, thumbnail_path })
}

#[command]
pub fn list_boards() -> Result<Vec<BoardSummary>, String> {
    let root = boards_root()?;
    let mut summaries: Vec<BoardSummary> = Vec::new();

    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read Boards folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else { continue };
        // A board folder that fails to parse (e.g. mid-write, or corrupted) is skipped rather
        // than failing the whole list - one bad board shouldn't hide every other one.
        if let Some(summary) = read_summary(&path, id) {
            summaries.push(summary);
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

#[command]
pub fn create_board(id: String, name: String, json: String) -> Result<BoardSummary, String> {
    let dir = board_dir(&id)?;
    if dir.exists() {
        return Err("A board with that id already exists".to_string());
    }
    fs::create_dir_all(dir.join("assets")).map_err(|e| format!("Failed to create board folder: {}", e))?;
    save_board(id.clone(), json)?;
    read_summary(&dir, &id).ok_or_else(|| "Failed to read back newly created board".to_string())
        .map(|mut s| { s.name = name; s })
}

#[command]
pub fn save_board(id: String, json: String) -> Result<(), String> {
    let dir = board_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create board folder: {}", e))?;

    let target = dir.join("board.json");
    let tmp = dir.join("board.json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write board: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save board: {}", e))?;
    Ok(())
}

#[command]
pub fn load_board(id: String) -> Result<String, String> {
    let target = board_dir(&id)?.join("board.json");
    fs::read_to_string(&target).map_err(|e| format!("Failed to load board: {}", e))
}

#[command]
pub fn delete_board(id: String) -> Result<(), String> {
    let dir = board_dir(&id)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete board: {}", e))
}

// Copies an arbitrary source image (already chosen via the frontend's file dialog) into this
// board's own assets/ folder under a fresh name, so the board keeps working even if the original
// file later moves/is renamed/deleted. Always copies (never moves) - the source lives outside
// this board's folder and must be left untouched. asset_id comes from the frontend's own
// crypto.randomUUID() (it already needs one for the new BoardImage) rather than generating one
// here, which would need a new uuid crate dependency for no real benefit.
#[command]
pub fn import_board_image(board_id: String, source_path: String, asset_id: String) -> Result<String, String> {
    let dir = board_dir(&board_id)?;
    let assets_dir = dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|e| format!("Failed to create assets folder: {}", e))?;

    let source = PathBuf::from(&source_path);
    if !source.is_file() {
        return Err(format!("Image does not exist: {}", source_path));
    }
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let asset_file_name = format!("{}.{}", asset_id, ext);
    let dest = assets_dir.join(&asset_file_name);
    fs::copy(&source, &dest).map_err(|e| format!("Failed to copy image: {}", e))?;
    Ok(asset_file_name)
}

#[command]
pub fn save_board_thumbnail(board_id: String, bytes: Vec<u8>) -> Result<(), String> {
    let dir = board_dir(&board_id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create board folder: {}", e))?;

    let target = dir.join("thumbnail.png");
    let tmp = dir.join("thumbnail.png.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write thumbnail: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save thumbnail: {}", e))
}

// Writes a flattened export into a "Board" subfolder of the Briefcast root (not a source-file's
// sibling - a board has no single source file, and not the root itself - that quickly buried
// exports among every other loose image once someone exported a few boards) so every board export
// lands in one place, easy to find, and still shows up in the sidebar's Image tab immediately via
// the existing file watcher. Singular "Board", not "Boards" (BOARDS_DIR_NAME) - the latter is this
// module's own internal project storage, excluded from the sidebar entirely (see its own doc
// comment); this is a normal, browsable library folder, just like any the user creates themselves.
// Timestamp-suffixed so repeat exports of the same board never collide.
#[command]
pub fn export_board_png(board_name: String, bytes: Vec<u8>) -> Result<String, String> {
    let root = briefcast_dir()?.join("Board");
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Board folder: {}", e))?;

    let safe_name: String = board_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let safe_name = if safe_name.trim().is_empty() { "Board".to_string() } else { safe_name };
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let output = root.join(format!("{} {}.png", safe_name, stamp));

    let tmp_file_name = format!("{}.tmp", output.file_name().unwrap().to_string_lossy());
    let tmp = output.with_file_name(tmp_file_name);
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write export: {}", e))?;
    fs::rename(&tmp, &output).map_err(|e| format!("Failed to save export: {}", e))?;
    Ok(output.to_string_lossy().to_string())
}

// "Save As" counterpart to export_board_png above - writes to an EXACT destination path the
// frontend already resolved via its own native save-file dialog (@tauri-apps/api/dialog's `save`),
// rather than always landing in briefcast_dir()/Board/. Deliberately doesn't touch briefcast_dir()
// at all: the whole point of Save As is picking a location outside (or inside, if the user chooses)
// the library, so nothing here should assume one. Same write-then-rename crash-safety convention as
// every other save in this file.
#[command]
pub fn export_board_png_to_path(dest_path: String, bytes: Vec<u8>) -> Result<(), String> {
    let dest = PathBuf::from(&dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create destination folder: {}", e))?;
    }
    let file_name = dest.file_name().ok_or("Invalid destination path")?.to_string_lossy();
    let tmp = dest.with_file_name(format!("{}.tmp", file_name));
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write export: {}", e))?;
    fs::rename(&tmp, &dest).map_err(|e| format!("Failed to save export: {}", e))?;
    Ok(())
}
