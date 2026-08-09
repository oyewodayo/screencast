// services/docs.rs
//
// Persistence for the "Docs" feature (src/components/docs/*) - a rich-text editor whose content is
// a Yjs CRDT document (chosen so a future real-time-sync phase can bolt a network provider onto
// the same Y.Doc without a rewrite). Each document is its own project folder under
// briefcast_dir()/Docs/<id>/:
//   doc.bin    - Y.encodeStateAsUpdate(ydoc), an opaque binary snapshot - unlike board.json this
//                 can't be parsed for a title, so metadata lives in a sibling file instead
//   meta.json  - { title, createdAt, updatedAt }, the only part of a doc Rust ever reads
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
}

#[derive(Debug, serde::Serialize)]
pub struct DocSummary {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, serde::Serialize)]
pub struct LoadedDoc {
    bytes: Vec<u8>,
    title: String,
    created_at: String,
    updated_at: String,
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
    Some(DocSummary { id: id.to_string(), title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at })
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
    let meta = DocMeta { title: title.clone(), created_at: now.clone(), updated_at: now.clone() };
    write_meta(&dir, &meta)?;

    let target = dir.join("doc.bin");
    let tmp = dir.join("doc.bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save document: {}", e))?;

    Ok(DocSummary { id, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at })
}

#[command]
pub fn save_doc(id: String, bytes: Vec<u8>, title: String) -> Result<(), String> {
    let dir = doc_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create document folder: {}", e))?;

    let target = dir.join("doc.bin");
    let tmp = dir.join("doc.bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save document: {}", e))?;

    // Preserve the original created_at if metadata already exists; a brand-new doc without one
    // (shouldn't normally happen since create_doc always writes it first) falls back to now.
    let now = chrono::Local::now().to_rfc3339();
    let created_at = read_meta(&dir).map(|m| m.created_at).unwrap_or_else(|| now.clone());
    write_meta(&dir, &DocMeta { title, created_at, updated_at: now })
}

#[command]
pub fn load_doc(id: String) -> Result<LoadedDoc, String> {
    let dir = doc_dir(&id)?;
    let bytes = fs::read(dir.join("doc.bin")).map_err(|e| format!("Failed to load document: {}", e))?;
    let meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    Ok(LoadedDoc { bytes, title: meta.title, created_at: meta.created_at, updated_at: meta.updated_at })
}

#[command]
pub fn delete_doc(id: String) -> Result<(), String> {
    let dir = doc_dir(&id)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete document: {}", e))
}
