// services/docs.rs
//
// Persistence for the "Docs" feature (src/components/docs/*) - a rich-text editor whose content is
// a Yjs CRDT document (chosen so a future real-time-sync phase can bolt a network provider onto
// the same Y.Doc without a rewrite). Each document is its own project folder under
// briefcast_dir()/Docs/<id>/:
//   doc.bin    - Y.encodeStateAsUpdate(ydoc), an opaque binary snapshot - unlike board.json this
//                 can't be parsed for a title, so metadata lives in a sibling file instead
//   meta.json  - { title, createdAt, updatedAt, linkedTo, folderId }, the only part of a doc Rust
//                 ever reads
// The optional folder tree a doc can be filed under lives in one sibling manifest,
// Docs/folders.json, rather than real nested directories - see DocFolder's own comment for why.
//
// Write-then-rename on every save, same crash-safety convention as boards.rs/image_annotations.rs.
use super::utility::briefcast_dir;
use std::{fs, path::PathBuf};
use tauri::command;

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

// Folder tree lives in one sibling manifest, not one file per folder - folders are pure
// organizational metadata (a name + a parent pointer), unlike a doc which owns real content
// (doc.bin/assets/), so there's nothing that benefits from folders having their own directories.
const FOLDERS_FILE_NAME: &str = "folders.json";

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
pub(crate) fn doc_dir(id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("Invalid document id".to_string());
    }
    Ok(docs_root()?.join(id))
}

// Full Yjs snapshots (same raw format as doc.bin), named by capture time - see write_version's own
// comment for why the filename is epoch millis rather than an RFC3339 string.
fn versions_dir(id: &str) -> Result<PathBuf, String> {
    let dir = doc_dir(id)?.join("versions");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create versions folder: {}", e))?;
    Ok(dir)
}

// Page margins in inches. Crosses the command boundary as-is (load_doc, set_doc_page_setup).
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct DocMargins {
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

impl DocMargins {
    // Each side 0-4in, and at least 1in of page left between opposite margins (on the smallest
    // supported page, 8.27in wide) - guards against a hand-edited meta.json or a bad drag.
    fn sanitized(self) -> Self {
        let clamp = |v: f64| if v.is_finite() { v.clamp(0.0, 4.0) } else { 1.0 };
        let (mut top, mut right, mut bottom, mut left) = (clamp(self.top), clamp(self.right), clamp(self.bottom), clamp(self.left));
        if left + right > 7.27 {
            let k = 7.27 / (left + right);
            left *= k;
            right *= k;
        }
        if top + bottom > 10.0 {
            let k = 10.0 / (top + bottom);
            top *= k;
            bottom *= k;
        }
        Self { top, right, bottom, left }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    // Which node in folders.json this doc is filed under - `default` so meta.json files written
    // before folders existed keep deserializing as "unfiled" (None), same convention as linked_to.
    #[serde(rename = "folderId", default, skip_serializing_if = "Option::is_none")]
    folder_id: Option<String>,
    // Print/PDF-export page setup - "letter"/"a4"/"legal", and repeating header/footer text (see
    // DocsEditor.tsx's own comment on the position:fixed trick that makes those actually repeat on
    // every printed page in Chromium). None/absent means "use the app's own defaults" everywhere
    // these are read, same default-lets-old-docs-deserialize convention as folder_id/linked_to.
    #[serde(rename = "pageSize", default, skip_serializing_if = "Option::is_none")]
    page_size: Option<String>,
    #[serde(
        rename = "headerText",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    header_text: Option<String>,
    #[serde(
        rename = "footerText",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    footer_text: Option<String>,
    // None = the default 1in on every side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    margins: Option<DocMargins>,
}

// Unlike DocMeta (an internal, camelCase-keyed storage format never returned to the frontend
// as-is), DocFolder crosses the command boundary directly from list_doc_folders/create_doc_folder/
// etc. - so it stays plain snake_case, same as DocSummary's own fields, rather than mixing
// conventions between Docs' API types.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DocFolder {
    id: String,
    name: String,
    parent_id: Option<String>,
    created_at: String,
}

fn folders_path() -> Result<PathBuf, String> {
    Ok(docs_root()?.join(FOLDERS_FILE_NAME))
}

fn read_folders() -> Result<Vec<DocFolder>, String> {
    let path = folders_path()?;
    let Ok(json) = fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&json).map_err(|e| format!("Failed to parse folders: {}", e))
}

fn write_folders(folders: &[DocFolder]) -> Result<(), String> {
    let path = folders_path()?;
    let json =
        serde_json::to_string(folders).map_err(|e| format!("Failed to encode folders: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write folders: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to save folders: {}", e))
}

// True if `candidate` is `ancestor_of` itself or any of its ancestors, walking parent_id pointers.
// Used to reject a move that would turn the tree into a cycle (dragging a folder into its own
// descendant) - same defensive-boundary spirit as doc_dir()'s path-escape check, just for the
// folder tree's own invariant instead of the filesystem's.
fn is_ancestor_or_self(folders: &[DocFolder], candidate: &str, ancestor_of: &str) -> bool {
    let mut current = Some(ancestor_of.to_string());
    while let Some(id) = current {
        if id == candidate {
            return true;
        }
        current = folders
            .iter()
            .find(|f| f.id == id)
            .and_then(|f| f.parent_id.clone());
    }
    false
}

#[command(async)]
pub fn list_doc_folders() -> Result<Vec<DocFolder>, String> {
    let _serial = crate::services::responsiveness::serial();
    read_folders()
}

// id is frontend-generated (crypto.randomUUID()), same convention as create_doc's own id param -
// there's no existing UUID-generation dependency on the Rust side to reuse for one call site.
#[command(async)]
pub fn create_doc_folder(
    id: String,
    name: String,
    parent_id: Option<String>,
) -> Result<DocFolder, String> {
    let _serial = crate::services::responsiveness::serial();
    let mut folders = read_folders()?;
    if folders.iter().any(|f| f.id == id) {
        return Err("A folder with that id already exists".to_string());
    }
    if let Some(ref pid) = parent_id {
        if !folders.iter().any(|f| &f.id == pid) {
            return Err("Parent folder does not exist".to_string());
        }
    }
    let folder = DocFolder {
        id,
        name,
        parent_id,
        created_at: chrono::Local::now().to_rfc3339(),
    };
    folders.push(folder.clone());
    write_folders(&folders)?;
    Ok(folder)
}

#[command(async)]
pub fn rename_doc_folder(id: String, name: String) -> Result<DocFolder, String> {
    let _serial = crate::services::responsiveness::serial();
    let mut folders = read_folders()?;
    let folder = folders
        .iter_mut()
        .find(|f| f.id == id)
        .ok_or_else(|| "Folder not found".to_string())?;
    folder.name = name;
    let result = folder.clone();
    write_folders(&folders)?;
    Ok(result)
}

#[command(async)]
pub fn move_doc_folder(id: String, new_parent_id: Option<String>) -> Result<DocFolder, String> {
    let _serial = crate::services::responsiveness::serial();
    let mut folders = read_folders()?;
    if let Some(ref pid) = new_parent_id {
        if !folders.iter().any(|f| &f.id == pid) {
            return Err("Parent folder does not exist".to_string());
        }
        if is_ancestor_or_self(&folders, &id, pid) {
            return Err(
                "Cannot move a folder into itself or one of its own subfolders".to_string(),
            );
        }
    }
    let folder = folders
        .iter_mut()
        .find(|f| f.id == id)
        .ok_or_else(|| "Folder not found".to_string())?;
    folder.parent_id = new_parent_id;
    let result = folder.clone();
    write_folders(&folders)?;
    Ok(result)
}

// Deletes this folder and every descendant folder, then un-files (not deletes) any doc that was
// filed under one of them - folders are organizational metadata, not containers, same reasoning
// relink_doc_path uses to repair a stale reference rather than cascading a delete onto the doc
// that holds it.
#[command(async)]
pub fn delete_doc_folder(id: String) -> Result<(), String> {
    let _serial = crate::services::responsiveness::serial();
    let mut folders = read_folders()?;

    let mut doomed: Vec<String> = vec![id];
    loop {
        let mut grew = false;
        for f in &folders {
            if let Some(ref pid) = f.parent_id {
                if doomed.contains(pid) && !doomed.contains(&f.id) {
                    doomed.push(f.id.clone());
                    grew = true;
                }
            }
        }
        if !grew {
            break;
        }
    }

    folders.retain(|f| !doomed.contains(&f.id));
    write_folders(&folders)?;

    let root = docs_root()?;
    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read Docs folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(entry_id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if entry_id == DOCS_TRASH_DIR_NAME {
            continue;
        }
        if let Some(mut meta) = read_meta(&path) {
            if meta
                .folder_id
                .as_ref()
                .is_some_and(|fid| doomed.contains(fid))
            {
                meta.folder_id = None;
                write_meta(&path, &meta)?;
            }
        }
    }

    Ok(())
}

#[command(async)]
pub fn set_doc_folder(id: String, folder_id: Option<String>) -> Result<DocSummary, String> {
    let _serial = crate::services::responsiveness::serial();
    if let Some(ref fid) = folder_id {
        let folders = read_folders()?;
        if !folders.iter().any(|f| &f.id == fid) {
            return Err("Folder does not exist".to_string());
        }
    }
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.folder_id = folder_id;
    write_meta(&dir, &meta)?;
    Ok(DocSummary {
        id,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        linked_to: meta.linked_to,
        deleted_at: meta.deleted_at,
        folder_id: meta.folder_id,
    })
}

#[derive(Debug, serde::Serialize)]
pub struct DocSummary {
    id: String,
    title: String,
    created_at: String,
    updated_at: String,
    linked_to: Option<String>,
    deleted_at: Option<String>,
    folder_id: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct LoadedDoc {
    bytes: Vec<u8>,
    title: String,
    created_at: String,
    updated_at: String,
    linked_to: Option<String>,
    deleted_at: Option<String>,
    folder_id: Option<String>,
    page_size: Option<String>,
    header_text: Option<String>,
    footer_text: Option<String>,
    margins: Option<DocMargins>,
}

fn read_meta(dir: &PathBuf) -> Option<DocMeta> {
    let json = fs::read_to_string(dir.join("meta.json")).ok()?;
    serde_json::from_str(&json).ok()
}

fn write_meta(dir: &PathBuf, meta: &DocMeta) -> Result<(), String> {
    let json =
        serde_json::to_string(meta).map_err(|e| format!("Failed to encode metadata: {}", e))?;
    let target = dir.join("meta.json");
    let tmp = dir.join("meta.json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write metadata: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save metadata: {}", e))
}

fn read_summary(dir: &PathBuf, id: &str) -> Option<DocSummary> {
    let meta = read_meta(dir)?;
    Some(DocSummary {
        id: id.to_string(),
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        linked_to: meta.linked_to,
        deleted_at: meta.deleted_at,
        folder_id: meta.folder_id,
    })
}

#[command(async)]
pub fn list_docs() -> Result<Vec<DocSummary>, String> {
    let _serial = crate::services::responsiveness::serial();
    let root = docs_root()?;
    let mut summaries: Vec<DocSummary> = Vec::new();

    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read Docs folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
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

#[command(async)]
pub fn create_doc(
    id: String,
    title: String,
    bytes: Vec<u8>,
    folder_id: Option<String>,
) -> Result<DocSummary, String> {
    let _serial = crate::services::responsiveness::serial();
    let dir = doc_dir(&id)?;
    if dir.exists() {
        return Err("A document with that id already exists".to_string());
    }
    if let Some(ref fid) = folder_id {
        let folders = read_folders()?;
        if !folders.iter().any(|f| &f.id == fid) {
            return Err("Folder does not exist".to_string());
        }
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create document folder: {}", e))?;

    let now = chrono::Local::now().to_rfc3339();
    let meta = DocMeta {
        title: title.clone(),
        created_at: now.clone(),
        updated_at: now.clone(),
        linked_to: None,
        deleted_at: None,
        folder_id,
        page_size: None,
        header_text: None,
        footer_text: None,
        margins: None,
    };
    write_meta(&dir, &meta)?;

    let target = dir.join("doc.bin");
    let tmp = dir.join("doc.bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save document: {}", e))?;

    Ok(DocSummary {
        id,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        linked_to: meta.linked_to,
        deleted_at: meta.deleted_at,
        folder_id: meta.folder_id,
    })
}

#[command(async)]
pub fn save_doc(id: String, bytes: Vec<u8>, title: String) -> Result<(), String> {
    let _serial = crate::services::responsiveness::serial();
    let dir = doc_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create document folder: {}", e))?;

    let target = dir.join("doc.bin");
    let tmp = dir.join("doc.bin.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save document: {}", e))?;

    // Preserve every field this command doesn't itself own from any existing metadata - it only
    // ever changes content/title, never the doc's link/trash/folder state or its page setup.
    // Copied wholesale rather than field by field so a new meta field can't be silently dropped on
    // every autosave by forgetting to list it here.
    let now = chrono::Local::now().to_rfc3339();
    let meta = match read_meta(&dir) {
        Some(existing) => DocMeta { title, updated_at: now, ..existing },
        None => DocMeta {
            title,
            created_at: now.clone(),
            updated_at: now,
            linked_to: None,
            deleted_at: None,
            folder_id: None,
            page_size: None,
            header_text: None,
            footer_text: None,
            margins: None,
        },
    };
    write_meta(&dir, &meta)
}

#[command(async)]
pub fn load_doc(id: String) -> Result<LoadedDoc, String> {
    let _serial = crate::services::responsiveness::serial();
    let dir = doc_dir(&id)?;
    let bytes =
        fs::read(dir.join("doc.bin")).map_err(|e| format!("Failed to load document: {}", e))?;
    let meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    Ok(LoadedDoc {
        bytes,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        linked_to: meta.linked_to,
        deleted_at: meta.deleted_at,
        folder_id: meta.folder_id,
        page_size: meta.page_size,
        header_text: meta.header_text,
        footer_text: meta.footer_text,
        margins: meta.margins,
    })
}

// Meta-only field, written straight through like link_doc_to_file - independent of the debounced
// Yjs save_doc path, since page setup isn't part of the document's actual content.
#[derive(Debug, serde::Serialize)]
pub struct DocPageSetup {
    page_size: Option<String>,
    header_text: Option<String>,
    footer_text: Option<String>,
    margins: Option<DocMargins>,
}

#[command(async)]
pub fn set_doc_page_setup(
    id: String,
    page_size: Option<String>,
    header_text: Option<String>,
    footer_text: Option<String>,
    margins: Option<DocMargins>,
) -> Result<DocPageSetup, String> {
    let _serial = crate::services::responsiveness::serial();
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.page_size = page_size;
    meta.header_text = header_text;
    meta.footer_text = footer_text;
    meta.margins = margins.map(DocMargins::sanitized);
    write_meta(&dir, &meta)?;
    Ok(DocPageSetup {
        page_size: meta.page_size,
        header_text: meta.header_text,
        footer_text: meta.footer_text,
        margins: meta.margins,
    })
}

// Soft delete: moves the doc's whole folder into Docs/.trash/<id> rather than removing it, same
// "an accidental click shouldn't be unrecoverable" reasoning as services/trash.rs's file-level
// move_to_trash. list_docs already skips DOCS_TRASH_DIR_NAME, so a trashed doc immediately stops
// appearing in the normal list without a real delete.
#[command(async)]
pub fn delete_doc(id: String) -> Result<(), String> {
    let _serial = crate::services::responsiveness::serial();
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.deleted_at = Some(chrono::Local::now().to_rfc3339());
    write_meta(&dir, &meta)?;

    let trash_dest = docs_trash_root()?.join(&id);
    fs::rename(&dir, &trash_dest).map_err(|e| format!("Failed to move document to trash: {}", e))
}

#[command(async)]
pub fn list_trashed_docs() -> Result<Vec<DocSummary>, String> {
    let _serial = crate::services::responsiveness::serial();
    let root = docs_trash_root()?;
    let mut summaries: Vec<DocSummary> = Vec::new();

    let entries =
        fs::read_dir(&root).map_err(|e| format!("Failed to read Docs trash folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if let Some(summary) = read_summary(&path, id) {
            summaries.push(summary);
        }
    }

    // Most-recently-deleted first - deleted_at is always Some(...) for anything in this folder
    // (set by delete_doc right before the move), empty string is just a defensive fallback for
    // sort stability if that were somehow ever not true.
    summaries.sort_by(|a, b| {
        b.deleted_at
            .clone()
            .unwrap_or_default()
            .cmp(&a.deleted_at.clone().unwrap_or_default())
    });
    Ok(summaries)
}

#[command(async)]
pub fn restore_doc(id: String) -> Result<DocSummary, String> {
    let _serial = crate::services::responsiveness::serial();
    let trash_dir = docs_trash_root()?.join(&id);
    if !trash_dir.exists() {
        return Err("Document is not in the trash".to_string());
    }
    let dir = doc_dir(&id)?;
    if dir.exists() {
        return Err("A document with that id already exists outside the trash".to_string());
    }

    let mut meta =
        read_meta(&trash_dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.deleted_at = None;
    write_meta(&trash_dir, &meta)?;

    fs::rename(&trash_dir, &dir).map_err(|e| format!("Failed to restore document: {}", e))?;
    Ok(DocSummary {
        id,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        linked_to: meta.linked_to,
        deleted_at: meta.deleted_at,
        folder_id: meta.folder_id,
    })
}

// The real, unrecoverable delete - only ever called on a doc already sitting in the trash.
#[command(async)]
pub fn delete_doc_permanently(id: String) -> Result<(), String> {
    let _serial = crate::services::responsiveness::serial();
    let trash_dir = docs_trash_root()?.join(&id);
    fs::remove_dir_all(&trash_dir)
        .map_err(|e| format!("Failed to permanently delete document: {}", e))
}

// Points this doc at a recording/file elsewhere in the library ("notes for this screencast"). One
// doc links to at most one file; a file can have several docs pointing at it (see
// find_docs_linked_to) - a recording might accumulate more than one separate note over time.
#[command(async)]
pub fn link_doc_to_file(id: String, file_path: String) -> Result<DocSummary, String> {
    let _serial = crate::services::responsiveness::serial();
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.linked_to = Some(file_path);
    write_meta(&dir, &meta)?;
    Ok(DocSummary {
        id,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        linked_to: meta.linked_to,
        deleted_at: meta.deleted_at,
        folder_id: meta.folder_id,
    })
}

#[command(async)]
pub fn unlink_doc(id: String) -> Result<DocSummary, String> {
    let _serial = crate::services::responsiveness::serial();
    let dir = doc_dir(&id)?;
    let mut meta = read_meta(&dir).ok_or_else(|| "Failed to load document metadata".to_string())?;
    meta.linked_to = None;
    write_meta(&dir, &meta)?;
    Ok(DocSummary {
        id,
        title: meta.title,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
        linked_to: meta.linked_to,
        deleted_at: meta.deleted_at,
        folder_id: meta.folder_id,
    })
}

// Reverse lookup for a given file path - which doc(s) are "notes for" it. A full scan over every
// doc's meta.json rather than a second sidecar-per-recording index: trivially cheap at
// desktop/local doc-count scale, and avoids a second data structure that could drift out of sync.
#[command(async)]
pub fn find_docs_linked_to(file_path: String) -> Result<Vec<DocSummary>, String> {
    let _serial = crate::services::responsiveness::serial();
    let root = docs_root()?;
    let mut summaries: Vec<DocSummary> = Vec::new();

    let entries = fs::read_dir(&root).map_err(|e| format!("Failed to read Docs folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
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
#[command(async)]
pub fn relink_doc_path(old_path: String, new_path: String) -> Result<u32, String> {
    let _serial = crate::services::responsiveness::serial();
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
// Shared by export_doc and export_doc_binary so the sanitized-name + timestamp filename
// convention can't drift between the text and binary export paths.
fn build_export_path(doc_title: &str, extension: &str) -> Result<PathBuf, String> {
    let root = briefcast_dir()?;
    fs::create_dir_all(&root).map_err(|e| format!("Failed to create Briefcast folder: {}", e))?;

    let safe_name: String = doc_title
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
        "Document".to_string()
    } else {
        safe_name
    };
    let stamp = chrono::Local::now().format("%Y-%m-%d %H-%M-%S");
    Ok(root.join(format!("{} {}.{}", safe_name, stamp, extension)))
}

// `output_path` is where the user chose in the frontend's Save dialog; without one the file goes to
// the Briefcast folder under a timestamped name (the original behaviour). The extension is forced
// to the export type so a dialog filename typo can't produce "notes.docx" holding Markdown.
fn resolve_export_path(output_path: Option<String>, doc_title: &str, extension: &str) -> Result<PathBuf, String> {
    let Some(raw) = output_path.filter(|p| !p.trim().is_empty()) else {
        return build_export_path(doc_title, extension);
    };
    let mut path = PathBuf::from(raw);
    let matches = path
        .extension()
        .map(|e| e.to_string_lossy().eq_ignore_ascii_case(extension))
        .unwrap_or(false);
    if !matches {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        path.set_file_name(format!("{}.{}", name, extension));
    }
    match path.parent() {
        Some(parent) if parent.is_dir() => Ok(path),
        _ => Err("The chosen folder doesn't exist".to_string()),
    }
}

#[command(async)]
pub fn export_doc(doc_title: String, extension: String, content: String, output_path: Option<String>) -> Result<String, String> {
    let _serial = crate::services::responsiveness::serial();
    if extension != "md" && extension != "txt" && extension != "html" {
        return Err(format!("Unsupported export extension: {}", extension));
    }

    let output = resolve_export_path(output_path, &doc_title, &extension)?;
    let tmp_file_name = format!("{}.tmp", output.file_name().unwrap().to_string_lossy());
    let tmp = output.with_file_name(tmp_file_name);
    fs::write(&tmp, content.as_bytes()).map_err(|e| format!("Failed to write export: {}", e))?;
    fs::rename(&tmp, &output).map_err(|e| format!("Failed to save export: {}", e))?;
    Ok(output.to_string_lossy().to_string())
}

#[command(async)]
pub fn export_doc_binary(
    doc_title: String,
    extension: String,
    bytes: Vec<u8>,
    output_path: Option<String>,
) -> Result<String, String> {
    let _serial = crate::services::responsiveness::serial();
    if extension != "docx" {
        return Err(format!("Unsupported export extension: {}", extension));
    }

    let output = resolve_export_path(output_path, &doc_title, &extension)?;
    let tmp_file_name = format!("{}.tmp", output.file_name().unwrap().to_string_lossy());
    let tmp = output.with_file_name(tmp_file_name);
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write export: {}", e))?;
    fs::rename(&tmp, &output).map_err(|e| format!("Failed to save export: {}", e))?;
    Ok(output.to_string_lossy().to_string())
}

// "Download PDF" straight to a file through WebView2's own PrintToPdf - the same Chromium print
// engine as window.print(), so the @media print CSS in DocsEditor.tsx lays the pages out, but with
// no dialog and with Chromium's date/title/URL/page-number header and footer switched off (the
// print dialog defaults them on, which is what stamped "10/2/26, 11:53 PM" and the doc title across
// the top of every exported page). Margins are zero here because the page frame in DocsEditor.tsx's
// print CSS supplies the 1in margins itself, identically for this path and for Print.
#[command]
pub async fn export_doc_pdf(
    webview: tauri::Webview,
    doc_title: String,
    page_size: Option<String>,
    output_path: Option<String>,
) -> Result<String, String> {
    let output = resolve_export_path(output_path, &doc_title, "pdf")?;
    let (width_in, height_in) = match page_size.as_deref() {
        Some("a4") => (8.27, 11.69),
        Some("legal") => (8.5, 14.0),
        _ => (8.5, 11.0),
    };

    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
        };
        use webview2_com::PrintToPdfCompletedHandler;
        use windows_core::{Interface, HSTRING};

        let (tx, rx) = std::sync::mpsc::channel::<Result<bool, String>>();
        let target = HSTRING::from(output.as_os_str());
        webview
            .with_webview(move |platform| {
                let failed = tx.clone();
                let started = (|| -> windows_core::Result<()> {
                    unsafe {
                        let core = platform.controller().CoreWebView2()?;
                        let core7: ICoreWebView2_7 = core.cast()?;
                        let env6: ICoreWebView2Environment6 = platform.environment().cast()?;
                        let settings = env6.CreatePrintSettings()?;
                        settings.SetOrientation(COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT)?;
                        settings.SetPageWidth(width_in)?;
                        settings.SetPageHeight(height_in)?;
                        settings.SetMarginTop(0.0)?;
                        settings.SetMarginBottom(0.0)?;
                        settings.SetMarginLeft(0.0)?;
                        settings.SetMarginRight(0.0)?;
                        settings.SetShouldPrintBackgrounds(true)?;
                        settings.SetShouldPrintHeaderAndFooter(false)?;
                        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                            let _ = tx.send(result.map(|_| ok).map_err(|e| e.message().to_string()));
                            Ok(())
                        }));
                        core7.PrintToPdf(&target, &settings, &handler)?;
                    }
                    Ok(())
                })();
                if let Err(e) = started {
                    let _ = failed.send(Err(e.message().to_string()));
                }
            })
            .map_err(|e| format!("Couldn't reach the document view: {}", e))?;

        let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(120)))
            .await
            .map_err(|e| format!("PDF export task failed: {}", e))?
            .map_err(|_| "PDF export timed out".to_string())?;
        match outcome {
            Ok(true) => Ok(output.to_string_lossy().to_string()),
            Ok(false) => Err("WebView2 couldn't write the PDF (is the file open in another program?)".to_string()),
            Err(e) => Err(format!("PDF export failed: {}", e)),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (webview, width_in, height_in, output);
        Err("Download as PDF is only available on Windows - use Print and choose Save as PDF".to_string())
    }
}

// Persists a pasted/dropped image's raw bytes into this doc's own assets/ folder, mirroring
// boards.rs's import_board_image - except this takes bytes directly (clipboard data starts as an
// in-memory File/Blob, not a path on disk) and returns the full absolute path rather than just a
// filename, so the frontend doesn't need to duplicate docs_root()-equivalent path-joining in JS.
#[command(async)]
pub fn save_doc_image(
    id: String,
    asset_id: String,
    extension: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let _serial = crate::services::responsiveness::serial();
    // extension comes from a clipboard MIME type, not a real file extension - whitelist rather
    // than trust it verbatim. Besides images, a document can keep the fonts it uses (uploaded, or
    // embedded in an imported PDF) and the original PDF behind an "exact pages" import.
    const ALLOWED: [&str; 10] = ["png", "jpg", "jpeg", "gif", "webp", "otf", "ttf", "woff", "woff2", "pdf"];
    if !ALLOWED.contains(&extension.as_str()) {
        return Err(format!("Unsupported asset extension: {}", extension));
    }

    let dir = doc_dir(&id)?;
    let assets_dir = dir.join("assets");
    fs::create_dir_all(&assets_dir)
        .map_err(|e| format!("Failed to create assets folder: {}", e))?;

    let target = assets_dir.join(format!("{}.{}", asset_id, extension));
    let tmp = assets_dir.join(format!("{}.{}.tmp", asset_id, extension));
    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write image: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save image: {}", e))?;
    Ok(target.to_string_lossy().to_string())
}

// ---- Version history ----
//
// Each doc's versions/ subfolder (see versions_dir()) holds full Y.encodeStateAsUpdate snapshots,
// one per file, named by capture time in epoch millis rather than RFC3339 - Windows filenames can't
// contain the `:` an RFC3339 string needs, and millis already sort correctly as plain strings/
// numbers with no reformatting. The frontend captures snapshots on two triggers (a periodic timer
// while a doc is being actively edited, and once whenever a doc is opened) - see
// useDocsEditStore.ts - this file only owns storage/retention, not when a snapshot is taken.

const VERSION_RETENTION: usize = 20;

#[derive(Debug, serde::Serialize)]
pub struct DocVersionSummary {
    // The epoch-millis filename stem, doubling as this version's opaque id for
    // load_doc_version/restore_doc_version below.
    id: String,
    created_at: String,
}

fn version_summary_from_millis(millis: i64) -> DocVersionSummary {
    let created_at = chrono::DateTime::from_timestamp_millis(millis)
        .map(|dt| dt.with_timezone(&chrono::Local).to_rfc3339())
        .unwrap_or_default();
    DocVersionSummary {
        id: millis.to_string(),
        created_at,
    }
}

// Every *.bin file's stem in `dir`, parsed back to millis and sorted newest-first - the single
// source of truth list_doc_versions/write_version's dedup-and-prune both walk, so "newest" and
// "oldest beyond the retention limit" can never disagree between the two.
fn list_version_files(dir: &PathBuf) -> Result<Vec<(i64, PathBuf)>, String> {
    let mut versions: Vec<(i64, PathBuf)> = Vec::new();
    let entries =
        fs::read_dir(dir).map_err(|e| format!("Failed to read versions folder: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("bin") {
            continue;
        }
        let Some(millis) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<i64>().ok())
        else {
            continue;
        };
        versions.push((millis, path));
    }
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(versions)
}

// Shared by create_doc_version and restore_doc_version's own pre-restore checkpoint - dedups
// against the current newest version (an "on open, nothing changed" snapshot, or restoring twice
// in a row, shouldn't create a redundant entry) and prunes down to VERSION_RETENTION afterward.
// Returns None when deduped (nothing was written), Some(...) when a new version was actually saved.
fn write_version(dir: &PathBuf, bytes: &[u8]) -> Result<Option<DocVersionSummary>, String> {
    let mut versions = list_version_files(dir)?;

    if let Some((_, newest_path)) = versions.first() {
        if fs::read(newest_path)
            .map(|existing| existing == bytes)
            .unwrap_or(false)
        {
            return Ok(None);
        }
    }

    // Bumped on the rare collision (two snapshots captured in the same millisecond) rather than
    // overwriting - every version is meant to be permanent until pruned by age, never silently
    // replaced.
    let mut millis = chrono::Local::now().timestamp_millis();
    while versions.iter().any(|(m, _)| *m == millis) {
        millis += 1;
    }
    let target = dir.join(format!("{}.bin", millis));
    let tmp = dir.join(format!("{}.bin.tmp", millis));
    fs::write(&tmp, bytes).map_err(|e| format!("Failed to write version: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save version: {}", e))?;
    versions.insert(0, (millis, target));

    // versions is newest-first, so everything past VERSION_RETENTION is the oldest overflow -
    // best-effort removal, a stale leftover file isn't worth failing the whole save over.
    for (_, stale_path) in versions.into_iter().skip(VERSION_RETENTION) {
        let _ = fs::remove_file(stale_path);
    }

    Ok(Some(version_summary_from_millis(millis)))
}

#[command(async)]
pub fn create_doc_version(id: String, bytes: Vec<u8>) -> Result<Option<DocVersionSummary>, String> {
    let _serial = crate::services::responsiveness::serial();
    write_version(&versions_dir(&id)?, &bytes)
}

#[command(async)]
pub fn list_doc_versions(id: String) -> Result<Vec<DocVersionSummary>, String> {
    let _serial = crate::services::responsiveness::serial();
    let versions = list_version_files(&versions_dir(&id)?)?;
    Ok(versions
        .into_iter()
        .map(|(millis, _)| version_summary_from_millis(millis))
        .collect())
}

// version_id is untrusted input reaching straight from a Tauri command argument - reject anything
// that isn't a bare non-negative integer before it's used to build a path, same defensive-boundary
// spirit as doc_dir()'s id check.
fn version_file_path(dir: &PathBuf, version_id: &str) -> Result<PathBuf, String> {
    if version_id.is_empty() || !version_id.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid version id".to_string());
    }
    Ok(dir.join(format!("{}.bin", version_id)))
}

#[command(async)]
pub fn load_doc_version(id: String, version_id: String) -> Result<Vec<u8>, String> {
    let _serial = crate::services::responsiveness::serial();
    let path = version_file_path(&versions_dir(&id)?, &version_id)?;
    fs::read(&path).map_err(|e| format!("Failed to load version: {}", e))
}

// Checkpoints the doc's current content as one more version (so restoring is itself undoable),
// then overwrites doc.bin with the target version's bytes and bumps meta.json's updated_at - same
// write-then-rename convention as save_doc. Returns the restored bytes so the frontend can apply
// them to a fresh Y.Doc without a second round trip.
#[command(async)]
pub fn restore_doc_version(id: String, version_id: String) -> Result<Vec<u8>, String> {
    let _serial = crate::services::responsiveness::serial();
    let dir = doc_dir(&id)?;
    let versions = versions_dir(&id)?;
    let target_path = version_file_path(&versions, &version_id)?;
    let restored_bytes =
        fs::read(&target_path).map_err(|e| format!("Failed to load version: {}", e))?;

    let current_bytes = fs::read(dir.join("doc.bin"))
        .map_err(|e| format!("Failed to read current document: {}", e))?;
    write_version(&versions, &current_bytes)?;

    let doc_target = dir.join("doc.bin");
    let doc_tmp = dir.join("doc.bin.tmp");
    fs::write(&doc_tmp, &restored_bytes).map_err(|e| format!("Failed to write document: {}", e))?;
    fs::rename(&doc_tmp, &doc_target).map_err(|e| format!("Failed to save document: {}", e))?;

    if let Some(mut meta) = read_meta(&dir) {
        meta.updated_at = chrono::Local::now().to_rfc3339();
        write_meta(&dir, &meta)?;
    }

    Ok(restored_bytes)
}

// ---- Comments ----
//
// One flat manifest per doc, Docs/<id>/comments.json - comments are metadata anchored to a range
// of the doc's content, not content themselves, same "sibling file, not folded into doc.bin"
// reasoning as folders.json/meta.json. `mark_id` is the id embedded in the live editor's `comment`
// mark (docCommentMark.ts) - the actual text range a comment is anchored to is never stored here,
// only looked up live by walking the current doc for a mark carrying this id, since ProseMirror
// positions shift as the document is edited and a stored from/to would go stale immediately.

const COMMENTS_FILE_NAME: &str = "comments.json";

// Unlike DocMeta (internal, camelCase-keyed, never returned as-is), DocComment crosses the command
// boundary directly - same plain-snake_case, always-emit-Option-as-null convention as DocSummary/
// DocFolder, not the storage-only skip_serializing_if treatment linked_to/folder_id use.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DocComment {
    id: String,
    mark_id: String,
    text: String,
    created_at: String,
    resolved_at: Option<String>,
}

fn comments_path(id: &str) -> Result<PathBuf, String> {
    Ok(doc_dir(id)?.join(COMMENTS_FILE_NAME))
}

fn read_comments(id: &str) -> Result<Vec<DocComment>, String> {
    let path = comments_path(id)?;
    let Ok(json) = fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    serde_json::from_str(&json).map_err(|e| format!("Failed to parse comments: {}", e))
}

fn write_comments(id: &str, comments: &[DocComment]) -> Result<(), String> {
    let path = comments_path(id)?;
    let json =
        serde_json::to_string(comments).map_err(|e| format!("Failed to encode comments: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write comments: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Failed to save comments: {}", e))
}

#[command(async)]
pub fn list_doc_comments(id: String) -> Result<Vec<DocComment>, String> {
    let _serial = crate::services::responsiveness::serial();
    read_comments(&id)
}

// id/mark_id are both frontend-generated (crypto.randomUUID()) - mark_id doubles as the comment
// mark's own attribute value applied to the selection at the same moment this is called, so the
// two ids start out equal, though only mark_id is ever looked up against the live document again.
#[command(async)]
pub fn add_doc_comment(
    id: String,
    comment_id: String,
    mark_id: String,
    text: String,
) -> Result<DocComment, String> {
    let _serial = crate::services::responsiveness::serial();
    let mut comments = read_comments(&id)?;
    let comment = DocComment {
        id: comment_id,
        mark_id,
        text,
        created_at: chrono::Local::now().to_rfc3339(),
        resolved_at: None,
    };
    comments.push(comment.clone());
    write_comments(&id, &comments)?;
    Ok(comment)
}

#[command(async)]
pub fn resolve_doc_comment(id: String, comment_id: String) -> Result<DocComment, String> {
    let _serial = crate::services::responsiveness::serial();
    let mut comments = read_comments(&id)?;
    let comment = comments
        .iter_mut()
        .find(|c| c.id == comment_id)
        .ok_or_else(|| "Comment not found".to_string())?;
    comment.resolved_at = Some(chrono::Local::now().to_rfc3339());
    let result = comment.clone();
    write_comments(&id, &comments)?;
    Ok(result)
}

#[command(async)]
pub fn reopen_doc_comment(id: String, comment_id: String) -> Result<DocComment, String> {
    let _serial = crate::services::responsiveness::serial();
    let mut comments = read_comments(&id)?;
    let comment = comments
        .iter_mut()
        .find(|c| c.id == comment_id)
        .ok_or_else(|| "Comment not found".to_string())?;
    comment.resolved_at = None;
    let result = comment.clone();
    write_comments(&id, &comments)?;
    Ok(result)
}

#[command(async)]
pub fn delete_doc_comment(id: String, comment_id: String) -> Result<(), String> {
    let _serial = crate::services::responsiveness::serial();
    let mut comments = read_comments(&id)?;
    comments.retain(|c| c.id != comment_id);
    write_comments(&id, &comments)
}
