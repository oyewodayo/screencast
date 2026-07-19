// services/trash.rs
//
// Soft delete: files removed from the sidebar move to a hidden .trash folder inside the
// Briefcast directory instead of straight to fs::remove_file, so an accidental delete (a stray
// click on a hover-only menu item, easy to trigger on a list you're scrolling past) isn't
// unrecoverable. list_briefcast_files (see services/utility.rs) skips .trash entirely, so
// trashed files never reappear in the normal Video/Audio/Image/Pdf lists.
//
// A small JSON manifest alongside the trashed files themselves (manifest.json) is what makes
// restore possible — the on-disk trashed filename is deliberately not the original name (see
// unique_trashed_name), so the manifest is the only record of where a given file actually came
// from and when it was deleted.
use std::fs;
use std::path::{Path, PathBuf};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tauri::command;

use crate::services::utility::{briefcast_dir, path_to_str};

const MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Serialize, Deserialize, Clone)]
struct TrashRecord {
    trashed_name: String,
    original_path: String,
    deleted_at: i64,
}

#[derive(Debug, Serialize)]
pub struct TrashEntry {
    trashed_name: String,
    name: String,
    original_path: String,
    deleted_at: i64,
}

fn trash_dir() -> Result<PathBuf, String> {
    let dir = briefcast_dir()?.join(".trash");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("Failed to create trash directory: {}", e))?;
    }
    Ok(dir)
}

fn manifest_path() -> Result<PathBuf, String> {
    Ok(trash_dir()?.join(MANIFEST_FILE))
}

fn read_manifest() -> Result<Vec<TrashRecord>, String> {
    let path = manifest_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let contents = fs::read_to_string(&path).map_err(|e| format!("Failed to read trash manifest: {}", e))?;
    if contents.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&contents).map_err(|e| format!("Failed to parse trash manifest: {}", e))
}

fn write_manifest(records: &[TrashRecord]) -> Result<(), String> {
    let path = manifest_path()?;
    let json = serde_json::to_string_pretty(records).map_err(|e| format!("Failed to serialize trash manifest: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write trash manifest: {}", e))
}

// Guards against two different trashed files colliding on the same on-disk name inside .trash
// (e.g. "screenshot.png" trashed, a new "screenshot.png" recorded, then that one trashed too) —
// the manifest is what actually remembers the real name and original location; this is just a
// guaranteed-unique physical filename.
fn unique_trashed_name(original_name: &str) -> String {
    format!("{}_{}", Utc::now().timestamp_millis(), original_name)
}

#[command]
pub fn move_to_trash(path: String) -> Result<(), String> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err("File does not exist".to_string());
    }
    let original_name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Could not determine file name")?
        .to_string();

    let trashed_name = unique_trashed_name(&original_name);
    let destination = trash_dir()?.join(&trashed_name);

    fs::rename(&source, &destination).map_err(|e| format!("Failed to move file to trash: {}", e))?;

    let mut records = read_manifest()?;
    records.push(TrashRecord {
        trashed_name,
        original_path: path,
        deleted_at: Utc::now().timestamp(),
    });
    write_manifest(&records)?;

    Ok(())
}

#[command]
pub fn list_trash() -> Result<Vec<TrashEntry>, String> {
    let mut records = read_manifest()?;
    records.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(records
        .into_iter()
        .map(|r| {
            let name = Path::new(&r.original_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| r.trashed_name.clone());
            TrashEntry {
                trashed_name: r.trashed_name,
                name,
                original_path: r.original_path,
                deleted_at: r.deleted_at,
            }
        })
        .collect())
}

// If the original spot is free, restores there; otherwise finds a free "name (restored N).ext"
// in the same folder rather than failing outright — the original file being gone (or replaced)
// is exactly the kind of situation restoring from trash exists to recover from, so refusing
// because of that would defeat the point.
fn free_restore_path(original_path: &Path) -> PathBuf {
    if !original_path.exists() {
        return original_path.to_path_buf();
    }

    let parent = original_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = original_path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = original_path.extension().and_then(|e| e.to_str());

    for attempt in 1.. {
        let candidate_name = match ext {
            Some(ext) => format!("{} (restored {}).{}", stem, attempt, ext),
            None => format!("{} (restored {})", stem, attempt),
        };
        let candidate = parent.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

#[command]
pub fn restore_from_trash(trashed_name: String) -> Result<String, String> {
    let mut records = read_manifest()?;
    let index = records
        .iter()
        .position(|r| r.trashed_name == trashed_name)
        .ok_or("Trash entry not found")?;
    let record = records.remove(index);

    let source = trash_dir()?.join(&record.trashed_name);
    if !source.exists() {
        write_manifest(&records)?; // manifest entry is stale — drop it so it doesn't linger forever
        return Err("Trashed file is missing on disk".to_string());
    }

    let destination = free_restore_path(&PathBuf::from(&record.original_path));
    if let Some(parent) = destination.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to recreate original folder: {}", e))?;
        }
    }

    fs::rename(&source, &destination).map_err(|e| format!("Failed to restore file: {}", e))?;
    write_manifest(&records)?;

    path_to_str(&destination).map(|s| s.to_string())
}

#[command]
pub fn delete_trash_item(trashed_name: String) -> Result<(), String> {
    let mut records = read_manifest()?;
    let index = records
        .iter()
        .position(|r| r.trashed_name == trashed_name)
        .ok_or("Trash entry not found")?;
    let record = records.remove(index);

    let path = trash_dir()?.join(&record.trashed_name);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))?;
    }
    write_manifest(&records)?;

    Ok(())
}

#[command]
pub fn empty_trash() -> Result<(), String> {
    let records = read_manifest()?;
    for record in &records {
        let path = trash_dir()?.join(&record.trashed_name);
        let _ = fs::remove_file(&path);
    }
    write_manifest(&Vec::new())?;
    Ok(())
}

// Called once on app startup (see Dashboard.tsx) with the user's configured retention period.
// Deliberately not a background timer: this is a desktop app, "check whenever it's opened" is
// the same policy every mainstream trash implementation (Gmail, Google Photos, ...) already uses
// in practice, without needing a persistent scheduler for something this low-stakes.
#[command]
pub fn purge_expired_trash(retention_days: i64) -> Result<u32, String> {
    if retention_days <= 0 {
        return Ok(0); // 0/negative means "never auto-purge"
    }

    let cutoff = Utc::now().timestamp() - retention_days * 24 * 60 * 60;
    let records = read_manifest()?;
    let (expired, remaining): (Vec<_>, Vec<_>) = records.into_iter().partition(|r| r.deleted_at < cutoff);

    for record in &expired {
        let path = trash_dir()?.join(&record.trashed_name);
        let _ = fs::remove_file(&path);
    }

    if !expired.is_empty() {
        write_manifest(&remaining)?;
    }

    Ok(expired.len() as u32)
}
