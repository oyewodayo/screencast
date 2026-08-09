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

fn docs_root() -> Result<PathBuf, String> {
    let root = briefcast_dir()?.join(DOCS_DIR_NAME);
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Docs folder: {}", e))?;
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
}

#[derive(Debug, serde::Serialize)]
pub struct DocSummary {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    linked_to: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct LoadedDoc {
    bytes: Vec<u8>,
    title: String,
    created_at: String,
    updated_at: String,
    linked_to: Option<String>,
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
    Some(DocSummary { id: id.to_string(), title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to })
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
    let meta = DocMeta { title: title.clone(), created_at: now.clone(), updated_at: now.clone(), linked_to: None };
    write_meta(&dir, &meta)?;

    let target = dir.join("doc.bin");
    let tmp = dir.join("doc.bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save document: {}", e))?;

    Ok(DocSummary { id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to })
}

#[command]
pub fn save_doc(id: String, bytes: Vec<u8>, title: String) -> Result<(), String> {
    let dir = doc_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create document folder: {}", e))?;

    let target = dir.join("doc.bin");
    let tmp = dir.join("doc.bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save document: {}", e))?;

    // Preserve created_at and linked_to from any existing metadata - this command only ever
    // changes content/title, never the doc's link (that's link_doc_to_file/unlink_doc's job).
    let now = chrono::Local::now().to_rfc3339();
    let existing = read_meta(&dir);
    let created_at = existing.as_ref().map(|m| m.created_at.clone()).unwrap_or_else(|| now.clone());
    let linked_to = existing.and_then(|m| m.linked_to);
    write_meta(&dir, &DocMeta { title, created_at, updated_at: now, linked_to })
}

#[command]
pub fn load_doc(id: String) -> Result<LoadedDoc, String> {
    let dir = doc_dir(&id)?;
    let bytes = fs::read(dir.join("doc.bin")).map_err(|e| format!("Failed to load document: {}", e))?;
    let meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    Ok(LoadedDoc { bytes, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to })
}

#[command]
pub fn delete_doc(id: String) -> Result<(), String> {
    let dir = doc_dir(&id)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete document: {}", e))
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
    Ok(DocSummary { id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to })
}

#[command]
pub fn unlink_doc(id: String) -> Result<DocSummary, String> {
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.linked_to = None;
    write_meta(&dir, &meta)?;
    Ok(DocSummary { id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at, linked_to: meta.linked_to })
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
