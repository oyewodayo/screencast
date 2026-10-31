// services/links.rs
//
// Cross-links between any two things in the library - a PDF to a video, an image to a whiteboard, a
// document to a PDF, and so on - so a presentation can hop between related material and each side
// can show "this is linked to that". A link is undirected: it is stored once and is listed from
// both ends.
//
// Everything lives in one manifest, briefcast_dir()/briefcast-links.json. It's a loose .json, so the
// library scanner (utility.rs's scan_directory only lists media extensions) never shows it. Same
// write-then-rename crash-safety convention as docs.rs's meta.json.
//
// This sits beside docs.rs's own single `linked_to` (a doc's "notes for" recording) rather than
// replacing it: that field keeps working untouched, and the frontend merges both into one list.
use super::utility::briefcast_dir;
use std::{fs, path::PathBuf};
use tauri::command;

const LINKS_FILE_NAME: &str = "briefcast-links.json";

// `kind` is "file" | "doc" | "whiteboard" | "mindmap"; `id` is a file path for "file" and the
// project id for the rest.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LinkEnd {
    kind: String,
    id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLink {
    id: String,
    a: LinkEnd,
    b: LinkEnd,
    created_at: String,
}

fn links_path() -> Result<PathBuf, String> {
    Ok(briefcast_dir()?.join(LINKS_FILE_NAME))
}

fn read_all() -> Vec<ItemLink> {
    links_path()
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

fn write_all(links: &[ItemLink]) -> Result<(), String> {
    let json =
        serde_json::to_string(links).map_err(|e| format!("Failed to encode links: {}", e))?;
    let target = links_path()?;
    let tmp = target.with_extension("json.tmp");
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write links: {}", e))?;
    fs::rename(&tmp, &target).map_err(|e| format!("Failed to save links: {}", e))
}

fn validate(end: &LinkEnd) -> Result<(), String> {
    if !matches!(end.kind.as_str(), "file" | "doc" | "whiteboard" | "mindmap") {
        return Err(format!("Unknown link kind: {}", end.kind));
    }
    if end.id.trim().is_empty() {
        return Err("Link target is empty".to_string());
    }
    Ok(())
}

fn same_pair(link: &ItemLink, a: &LinkEnd, b: &LinkEnd) -> bool {
    (&link.a == a && &link.b == b) || (&link.a == b && &link.b == a)
}

#[command]
pub fn list_links() -> Result<Vec<ItemLink>, String> {
    Ok(read_all())
}

// Idempotent: linking a pair that's already linked returns the existing link.
#[command]
pub fn add_link(a: LinkEnd, b: LinkEnd) -> Result<ItemLink, String> {
    validate(&a)?;
    validate(&b)?;
    if a == b {
        return Err("Can't link an item to itself".to_string());
    }
    let mut links = read_all();
    if let Some(existing) = links.iter().find(|l| same_pair(l, &a, &b)) {
        return Ok(existing.clone());
    }
    let link = ItemLink {
        id: format!(
            "{:x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ),
        a,
        b,
        created_at: chrono_now(),
    };
    links.push(link.clone());
    write_all(&links)?;
    Ok(link)
}

#[command]
pub fn remove_link(id: String) -> Result<(), String> {
    let mut links = read_all();
    let before = links.len();
    links.retain(|l| l.id != id);
    if links.len() != before {
        write_all(&links)?;
    }
    Ok(())
}

// A renamed/moved file keeps its links - mirrors docs.rs's relink_doc_path for stale paths.
#[command]
pub fn relink_file_path(old_path: String, new_path: String) -> Result<(), String> {
    let mut links = read_all();
    let mut changed = false;
    for link in links.iter_mut() {
        for end in [&mut link.a, &mut link.b] {
            if end.kind == "file" && end.id == old_path {
                end.id = new_path.clone();
                changed = true;
            }
        }
    }
    if changed {
        write_all(&links)?;
    }
    Ok(())
}

fn chrono_now() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default()
}
