// services/docs.rs
//
// Persistence for the "Docs" feature (src/components/docs/*) - a rich-text editor whose content is
// a Yjs CRDT document (chosen so a future real-time-sync phase can bolt a network provider onto
// the same Y.Doc without a rewrite). Each document is its own project folder under
// briefcast_dir()/Docs/<id>/:
//   doc.bin    - Y.encodeStateAsUpdate(ydoc), an opaque binary snapshot - unlike board.json this
//                 can't be parsed for a title, so metadata lives in a sibling file instead
//   meta.json  - { title, createdAt, updatedAt, linkedTo }, the only part of a doc Rust ever reads
//
// Write-then-rename on every save, same crash-safety convention as boards.rs/image_annotations.rs.
use std::{fs, path::PathBuf};
use tauri::command;
use super::utility::briefcast_dir;

// Also used by utility.rs's scan_directory to exclude this folder from the normal file list, same
// reasoning as boards.rs's BOARDS_DIR_NAME - doc project files must never show up as loose entries
// in the sidebar's file list.
pub const DOCS_DIR_NAME: &str = "Docs";

// Soft-deleted docs live in a hidden folder nested inside Docs itself, not the app-wide .trash
// (services/trash.rs) - that system is built for single files (its permanent-delete/purge paths
// call fs::remove_file, which errors on a directory) and has no concept of a document's title, only
// a raw file path. A doc is a whole folder (doc.bin + meta.json + assets/), and its title already
// lives in meta.json, so mirroring Docs' own title-aware DocSummary pattern for a trashed-docs list
// is simpler and more correct than teaching the shared file-trash system about directories.
const DOCS_TRASH_DIR_NAME: &str = ".trash";

fn docs_root() -> Result<PathBuf, String> {
    let root = briefcast_dir()?.join(DOCS_DIR_NAME);
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Docs folder: {}", e))?;
    Ok(root)
}

fn docs_trash_root() -> Result<PathBuf, String> {
    let root = docs_root()?.join(DOCS_TRASH_DIR_NAME);
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Docs trash folder: {}", e))?;
    Ok(root)
}

// Doc ids are frontend-generated UUIDs (crypto.randomUUID(), same convention as boards.rs), but
// every command below is directly reachable, so this boundary is enforced here regardless of
// caller - rejects anything that could escape docs_root() via a path separator or a "."/".." segment.
fn doc_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("Invalid document id".to_string());
    }
    Ok(docs_root()?.join(id))
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct DocMeta {
    title: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
    // A recording/file elsewhere in the library this doc is "notes for" - see link_doc_to_file.
    // `default` lets meta.json files written before this field existed keep deserializing.
    #[serde(rename = "linkedTo", default, skip_serializing_if = "Option::is_none")]
    linked_to: Option<String>,
    // Set only while a doc sits in Docs/.trash/ - lets the trash list show "deleted 3 days ago"
    // without needing a second manifest file (see services/trash.rs's manifest.json precedent,
    // not reused here since meta.json already travels with the folder on every move).
    #[serde(rename = "deletedAt", default, skip_serializing_if = "Option::is_none")]
    deleted_at: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct DocSummary {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    linked_to: Option<String>,
    deleted_at: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct LoadedDoc {
    bytes: Vec<u8>,
    title: String,
    created_at: String,
    updated_at: String,
    linked_to: Option<String>,
    deleted_at: Option<String>,
}

fn read_meta(dir: &PathBuf) -> Option<DocMeta> {
    let json = fs::read_to_string(dir.join("meta.json")).ok()?;
    serde_json::from_str(&json).ok()
}

fn write_meta(dir: &PathBuf, meta: &DocMeta) -> Result<(), String> {
    let json = serde_json::to_string(meta).map_err(|e| format!("Failed to encode metadata: {}", e))?;
    let target = dir.join("meta.json");
    let tmp = dir.join("meta.json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write metadata: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save metadata: {}", e))
}

fn read_summary(dir: &PathBuf, id: &str) -> Option<DocSummary> {
    let meta = read_meta(dir)?;
    Some(DocSummary { id: id.to_string(), title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to, deleted_at: meta.deleted_at })
}

#[command]
pub fn list_docs() -> Result<Vec<DocSummary>, String> {
    let root = docs_root()?;
    let mut summaries: Vec<DocSummary> = Vec::new();

    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read Docs folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else { continue };
        // Docs/.trash/ sits alongside real doc folders (see docs_trash_root()) - never surface a
        // trashed doc, or the trash folder itself, in the normal list.
        if id == DOCS_TRASH_DIR_NAME {
            continue;
        }
        // A doc folder that fails to parse (e.g. mid-write, or corrupted) is skipped rather than
        // failing the whole list - one bad doc shouldn't hide every other one.
        if let Some(summary) = read_summary(&path, id) {
            summaries.push(summary);
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

#[command]
pub fn create_doc(id: String, title: String, bytes: Vec<u8>) -> Result<DocSummary, String> {
    let dir = doc_dir(&id)?;
    if dir.exists() {
        return Err("A document with that id already exists".to_string());
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create document folder: {}", e))?;

    let now = chrono::Local::now().to_rfc3339();
    let meta = DocMeta { title: title.clone(), created_at: now.clone(), updated_at: now.clone(), linked_to: None, deleted_at: None };
    write_meta(&dir, &meta)?;

    let target = dir.join("doc.bin");
    let tmp = dir.join("doc.bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save document: {}", e))?;

    Ok(DocSummary { id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to, deleted_at: meta.deleted_at })
}

#[command]
pub fn save_doc(id: String, bytes: Vec<u8>, title: String) -> Result<(), String> {
    let dir = doc_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create document folder: {}", e))?;

    let target = dir.join("doc.bin");
    let tmp = dir.join("doc.bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save document: {}", e))?;

    // Preserve created_at/linked_to/deleted_at from any existing metadata - this command only
    // ever changes content/title, never the doc's link or trash state.
    let now = chrono::Local::now().to_rfc3339();
    let existing = read_meta(&dir);
    let created_at = existing.as_ref().map(|m| m.created_at.clone()).unwrap_or_else(|| now.clone());
    let linked_to = existing.as_ref().and_then(|m| m.linked_to.clone());
    let deleted_at = existing.and_then(|m| m.deleted_at);
    write_meta(&dir, &DocMeta { title, created_at, updated_at: now, linked_to, deleted_at })
}

#[command]
pub fn load_doc(id: String) -> Result<LoadedDoc, String> {
    let dir = doc_dir(&id)?;
    let bytes = fs::read(dir.join("doc.bin")).map_err(|e| format!("Failed to load document: {}", e))?;
    let meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    Ok(LoadedDoc { bytes, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to, deleted_at: meta.deleted_at })
}

// Soft delete: moves the doc's whole folder into Docs/.trash/<id> rather than removing it, same
// "an accidental click shouldn't be unrecoverable" reasoning as services/trash.rs's file-level
// move_to_trash. list_docs already skips DOCS_TRASH_DIR_NAME, so a trashed doc immediately stops
// appearing in the normal list without a real delete.
#[command]
pub fn delete_doc(id: String) -> Result<(), String> {
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.deleted_at = Some(chrono::Local::now().to_rfc3339());
    write_meta(&dir, &meta)?;

    let trash_dest = docs_trash_root()?.join(&id);
    fs::rename(&dir, &trash_dest).map_err(|e| format!("Failed to move document to trash: {}", e))
}

#[command]
pub fn list_trashed_docs() -> Result<Vec<DocSummary>, String> {
    let root = docs_trash_root()?;
    let mut summaries: Vec<DocSummary> = Vec::new();

    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read Docs trash folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if let Some(summary) = read_summary(&path, id) {
            summaries.push(summary);
        }
    }

    // Most-recently-deleted first - deleted_at is always Some(...) for anything in this folder
    // (set by delete_doc right before the move), empty string is just a defensive fallback for
    // sort stability if that were somehow ever not true.
    summaries.sort_by(|a, b| b.deleted_at.clone().unwrap_or_default().cmp(&a.deleted_at.clone().unwrap_or_default()));
    Ok(summaries)
}

#[command]
pub fn restore_doc(id: String) -> Result<DocSummary, String> {
    let trash_dir = docs_trash_root()?.join(&id);
    if !trash_dir.exists() {
        return Err("Document is not in the trash".to_string());
    }
    let dir = doc_dir(&id)?;
    if dir.exists() {
        return Err("A document with that id already exists outside the trash".to_string());
    }

    let mut meta = read_meta(&trash_dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.deleted_at = None;
    write_meta(&trash_dir, &meta)?;

    fs::rename(&trash_dir, &dir).map_err(|e| format!("Failed to restore document: {}", e))?;
    Ok(DocSummary { id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to, deleted_at: meta.deleted_at })
}

// The real, unrecoverable delete - only ever called on a doc already sitting in the trash.
#[command]
pub fn delete_doc_permanently(id: String) -> Result<(), String> {
    let trash_dir = docs_trash_root()?.join(&id);
    fs::remove_dir_all(&trash_dir).map_err(|e| format!("Failed to permanently delete document: {}", e))
}

// Points this doc at a recording/file elsewhere in the library ("notes for this screencast"). One
// doc links to at most one file; a file can have several docs pointing at it (see
// find_docs_linked_to) - a recording might accumulate more than one separate note over time.
#[command]
pub fn link_doc_to_file(id: String, file_path: String) -> Result<DocSummary, String> {
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.linked_to = Some(file_path);
    write_meta(&dir, &meta)?;
    Ok(DocSummary { id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to, deleted_at: meta.deleted_at })
}

#[command]
pub fn unlink_doc(id: String) -> Result<DocSummary, String> {
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.linked_to = None;
    write_meta(&dir, &meta)?;
    Ok(DocSummary { id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to, deleted_at: meta.deleted_at })
}

// Reverse lookup for a given file path - which doc(s) are "notes for" it. A full scan over every
// doc's meta.json rather than a second sidecar-per-recording index: trivially cheap at
// desktop/local doc-count scale, and avoids a second data structure that could drift out of sync.
#[command]
pub fn find_docs_linked_to(file_path: String) -> Result<Vec<DocSummary>, String> {
    let root = docs_root()?;
    let mut summaries: Vec<DocSummary> = Vec::new();

    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read Docs folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if id == DOCS_TRASH_DIR_NAME {
            continue;
        }
        if let Some(summary) = read_summary(&path, id) {
            if summary.linked_to.as_deref() == Some(file_path.as_str()) {
                summaries.push(summary);
            }
        }
    }

    summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(summaries)
}

// Called when a linked recording is renamed/moved, alongside the frontend's existing
// repathFile()-style pin/recent repair, so a doc's link doesn't silently go stale. Returns how
// many docs were updated (0 is a valid, expected result for a file nothing links to).
#[command]
pub fn relink_doc_path(old_path: String, new_path: String) -> Result<u32, String> {
    let root = docs_root()?;
    let mut updated = 0u32;

    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read Docs folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(mut meta) = read_meta(&path) {
            if meta.linked_to.as_deref() == Some(old_path.as_str()) {
                meta.linked_to = Some(new_path.clone());
                write_meta(&path, &meta)?;
                updated += 1;
            }
        }
    }

    Ok(updated)
}

// Writes a Markdown/plain-text export directly into the Briefcast root (no Save dialog exists in
// this app's Tauri allowlist) with a timestamp-suffixed filename, so it shows up in the sidebar's
// file list immediately via the existing file watcher - same convention as export_board_png.
#[command]
pub fn export_doc(doc_title: String, extension: String, content: String) -> Result<String, String> {
    if extension != "md" && extension != "txt" {
        return Err(format!("Unsupported export extension: {}", extension));
    }

    let root = briefcast_dir()?;
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Briefcast folder: {}", e))?;

    let safe_name: String = doc_title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let safe_name = if safe_name.trim().is_empty() { "Document".to_string() } else { safe_name };
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    let output = root.join(format!("{} {}.{}", safe_name, stamp, extension));

    let tmp_file_name = format!("{}.tmp", output.file_name().unwrap().to_string_lossy());
    let tmp = output.with_file_name(tmp_file_name);
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Failed to write export: {}", e))?;
    fs::rename(&tmp, &output).map_err(|e| format!("Failed to save export: {}", e))?;
    Ok(output.to_string_lossy().to_string())
}

// Persists a pasted/dropped image's raw bytes into this doc's own assets/ folder, mirroring
// boards.rs's import_board_image - except this takes bytes directly (clipboard data starts as an
// in-memory File/Blob, not a path on disk) and returns the full absolute path rather than just a
// filename, so the frontend doesn't need to duplicate docs_root()-equivalent path-joining in JS.
#[command]
pub fn save_doc_image(id: String, asset_id: String, extension: String, bytes: Vec<u8>) -> Result<String, String> {
    // extension comes from a clipboard MIME type, not a real file extension - whitelist rather
    // than trust it verbatim.
    const ALLOWED: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];
    if !ALLOWED.contains(&extension.as_str()) {
        return Err(format!("Unsupported image extension: {}", extension));
    }

    let dir = doc_dir(&id)?;
    let assets_dir = dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|e| format!("Failed to create assets folder: {}", e))?;

    let target = assets_dir.join(format!("{}.{}", asset_id, extension));
    let tmp = assets_dir.join(format!("{}.{}.tmp", asset_id, extension));
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write image: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save image: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}
