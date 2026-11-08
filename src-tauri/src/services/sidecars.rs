// sidecars.rs
//
// A library file's companion files - its saved edits, kept next to it as "<file name><suffix>"
// (a video's or project's timeline .edits.json, its chapter markers, an image's edits, a PDF's
// annotations). The file and its companions have to travel together: renaming, moving or trashing
// just the file leaves its edits behind under the old name, where the editor never finds them
// again - and where a NEW file that later takes that name (the next "Untitled video (10)") picks
// them up, or overwrites them. Every operation that moves a library file goes through here.
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

// Every companion-file suffix the app writes (see each service's own sidecar_path_for).
pub const SIDECAR_SUFFIXES: &[&str] = &[".edits.json", ".chapters.json", ".imageedit.json", ".annotations.json", ".pointer.json"];

// Companions are hidden in Explorer (the Windows "hidden" attribute): the library folder shows the
// files people made, not the app's bookkeeping beside each one - yet each companion still sits next
// to its file, so copying or moving the two together in Explorer keeps the edits. A hidden file
// can't be overwritten in place on Windows (CreateFile refuses to truncate one), so every write
// goes through write_sidecar / commit_sidecar, which lift the attribute around it.
#[cfg(windows)]
pub fn set_hidden(path: &Path, hidden: bool) {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{GetFileAttributesW, SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES, INVALID_FILE_ATTRIBUTES};
    let wide = HSTRING::from(path.as_os_str());
    // SAFETY: plain Win32 attribute calls on a null-terminated path that outlives them.
    unsafe {
        let attrs = GetFileAttributesW(&wide);
        if attrs == INVALID_FILE_ATTRIBUTES {
            return;
        }
        // NORMAL is only valid alone.
        let mut next = if hidden { (attrs & !FILE_ATTRIBUTE_NORMAL.0) | FILE_ATTRIBUTE_HIDDEN.0 } else { attrs & !FILE_ATTRIBUTE_HIDDEN.0 };
        if next == 0 {
            next = FILE_ATTRIBUTE_NORMAL.0;
        }
        if next != attrs {
            let _ = SetFileAttributesW(&wide, FILE_FLAGS_AND_ATTRIBUTES(next));
        }
    }
}
// macOS: Finder's own hidden flag (UF_HIDDEN). Unlike Windows' attribute it doesn't stop a write, so only
// hiding is ever needed - and a write-then-rename makes a new file, which commit_sidecar hides again.
#[cfg(target_os = "macos")]
pub fn set_hidden(path: &Path, hidden: bool) {
    use std::os::macos::fs::MetadataExt;
    use std::os::unix::ffi::OsStrExt;
    const UF_HIDDEN: u32 = 0x8000;
    if !hidden {
        return;
    }
    let Ok(meta) = fs::metadata(path) else { return };
    let flags = meta.st_flags();
    if flags & UF_HIDDEN != 0 {
        return;
    }
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else { return };
    // SAFETY: a plain syscall on a NUL-terminated path that outlives it.
    unsafe {
        libc::chflags(c_path.as_ptr(), flags | UF_HIDDEN);
    }
}

// Linux: there is no hidden attribute, but GNOME Files, KDE's Dolphin and other file managers leave out
// the names listed in a folder's `.hidden` file - so each companion is listed there, once. (Unhiding is
// never needed: nothing stops a write.) A file moved out of the folder simply shows again.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn set_hidden(path: &Path, hidden: bool) {
    use std::io::Write;
    if !hidden {
        return;
    }
    let (Some(dir), Some(name)) = (path.parent(), path.file_name().and_then(|n| n.to_str())) else { return };
    if name.contains('\n') {
        return;
    }
    let list = dir.join(".hidden");
    let current = fs::read_to_string(&list).unwrap_or_default();
    if current.lines().any(|line| line == name) {
        return;
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&list) {
        if !current.is_empty() && !current.ends_with('\n') {
            let _ = file.write_all(b"\n");
        }
        let _ = writeln!(file, "{name}");
    }
}

#[cfg(not(any(windows, unix)))]
pub fn set_hidden(_path: &Path, _hidden: bool) {}

// Puts a fully written temp file in place as the companion `dest` (write-then-rename, so a crash
// can't leave a half-written one), hidden.
pub fn commit_sidecar(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    set_hidden(dest, false);
    let result = fs::rename(tmp, dest);
    set_hidden(dest, true);
    result
}

// Writes the companion `path` (a new one, or over a hidden one), hidden.
pub fn write_sidecar(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    set_hidden(path, false);
    let result = fs::write(path, contents);
    set_hidden(path, true);
    result
}

// Whether a file name is one of the app's companions (including a recording's clicks, webcam
// bubble and view switches - recording.rs - named after its stem rather than its whole name).
pub fn is_sidecar_name(name: &str) -> bool {
    SIDECAR_SUFFIXES.iter().any(|s| name.ends_with(s)) || [".clicks.json", ".bubble.json", ".viewswitch.json"].iter().any(|s| name.ends_with(s))
}

// Hides every companion under `root` that isn't yet - the ones written before they were hidden.
// Cheap (attributes only), so it simply runs at each start.
pub fn hide_sidecars_in(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            hide_sidecars_in(&path);
        } else if path.file_name().and_then(|n| n.to_str()).map_or(false, is_sidecar_name) {
            set_hidden(&path, true);
        }
    }
}

// Companions whose file is gone (deleted or moved outside the app), under `root` - left there,
// they'd be picked up by the next file to take that name. The trash's own folder is skipped (its
// companions sit with their trashed files).
pub fn find_orphans_in(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if kind.is_dir() {
            if !name.starts_with('.') {
                find_orphans_in(&path, out);
            }
            continue;
        }
        if let Some(suffix) = SIDECAR_SUFFIXES.iter().find(|s| name.ends_with(*s)) {
            let file = path.with_file_name(&name[..name.len() - suffix.len()]);
            if !file.exists() {
                out.push(path);
            }
        }
    }
}

// What "Tidy up library" needs before it starts: the Projects and Exports folders made, and the
// orphaned companions found (moved to the trash by the frontend, one by one).
#[tauri::command(async)]
pub fn prepare_library_tidy() -> Result<Vec<String>, String> {
    let root = crate::services::utility::briefcast_dir()?;
    for folder in [crate::services::video_edits::PROJECTS_FOLDER, crate::services::video_edits::EXPORTS_FOLDER] {
        fs::create_dir_all(root.join(folder)).map_err(|e| format!("Failed to create the {} folder: {}", folder, e))?;
    }
    let mut orphans = Vec::new();
    find_orphans_in(&root, &mut orphans);
    Ok(orphans.iter().filter_map(|p| p.to_str().map(String::from)).collect())
}

pub fn sidecar_path(file: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = file.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

// The companions `file` has on disk right now.
pub fn existing_sidecars(file: &Path) -> Vec<(&'static str, PathBuf)> {
    SIDECAR_SUFFIXES
        .iter()
        .map(|suffix| (*suffix, sidecar_path(file, suffix)))
        .filter(|(_, path)| path.exists())
        .collect()
}

// Refuses a move onto `new` when companions are already sitting there - from a file that used to
// have that name - so they're never overwritten, nor silently adopted by the arriving file.
pub fn check_destination_free(new: &Path) -> Result<(), String> {
    if existing_sidecars(new).is_empty() {
        Ok(())
    } else {
        Err("Another file's saved edits already use that name - choose a different name".to_string())
    }
}

// Moves `old`'s companions to sit beside `new` (call right after moving the file itself), and
// points any reference to the old path inside them at the new one - a recording's own timeline
// names its own file. On failure, everything moved so far is put back, so the caller can undo the
// file's own move and leave things exactly as they were.
pub fn carry_sidecars(old: &Path, new: &Path) -> Result<(), String> {
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (suffix, from) in existing_sidecars(old) {
        let to = sidecar_path(new, suffix);
        if let Err(e) = fs::rename(&from, &to) {
            for (a, b) in moved.iter().rev() {
                let _ = fs::rename(b, a);
            }
            return Err(format!("Failed to move the file's saved edits: {}", e));
        }
        moved.push((from, to));
    }
    let (Some(old_str), Some(new_str)) = (old.to_str(), new.to_str()) else {
        return Ok(());
    };
    for (_, to) in &moved {
        rewrite_path_references(to, old_str, new_str);
    }
    Ok(())
}

// Copies `old`'s companions to sit beside `new` (a "Copy to folder", or a move across drives where
// a rename can't work), pointing their path references at the copy. On failure the copies made so
// far are removed again, leaving the originals untouched.
pub fn copy_sidecars(old: &Path, new: &Path) -> Result<(), String> {
    let mut copied: Vec<PathBuf> = Vec::new();
    for (suffix, from) in existing_sidecars(old) {
        let to = sidecar_path(new, suffix);
        if let Err(e) = fs::copy(&from, &to) {
            for path in &copied {
                let _ = fs::remove_file(path);
            }
            return Err(format!("Failed to copy the file's saved edits: {}", e));
        }
        copied.push(to);
    }
    let (Some(old_str), Some(new_str)) = (old.to_str(), new.to_str()) else {
        return Ok(());
    };
    for to in &copied {
        rewrite_path_references(to, old_str, new_str);
    }
    Ok(())
}

pub fn remove_sidecars(file: &Path) {
    for (_, path) in existing_sidecars(file) {
        let _ = fs::remove_file(path);
    }
}

// Replaces every JSON string equal to `old` (case-insensitively - Windows paths) with `new`.
// Best effort: a companion that isn't JSON or can't be rewritten is left as it is.
fn rewrite_path_references(sidecar: &Path, old: &str, new: &str) {
    let Ok(text) = fs::read_to_string(sidecar) else { return };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    fn walk(v: &mut serde_json::Value, old: &str, new: &str, changed: &mut bool) {
        match v {
            serde_json::Value::String(s) if s.eq_ignore_ascii_case(old) => {
                *s = new.to_string();
                *changed = true;
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|i| walk(i, old, new, changed)),
            serde_json::Value::Object(map) => map.values_mut().for_each(|i| walk(i, old, new, changed)),
            _ => {}
        }
    }
    let mut changed = false;
    walk(&mut value, old, new, &mut changed);
    if !changed {
        return;
    }
    let Ok(out) = serde_json::to_string(&value) else { return };
    let tmp = sidecar_path(sidecar, ".tmp");
    if fs::write(&tmp, out).is_ok() && commit_sidecar(&tmp, sidecar).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn is_hidden(path: &Path) -> bool {
        use std::os::windows::fs::MetadataExt;
        fs::metadata(path).map(|m| m.file_attributes() & 0x2 != 0).unwrap_or(false)
    }

    #[test]
    fn finds_companions_whose_file_is_gone() {
        let dir = temp_dir("orphans");
        fs::write(dir.join("kept.mp4"), b"v").unwrap();
        fs::write(sidecar_path(&dir.join("kept.mp4"), ".edits.json"), "{}").unwrap();
        fs::write(sidecar_path(&dir.join("gone.mp4"), ".edits.json"), "{}").unwrap();
        fs::create_dir_all(dir.join(".trash")).unwrap();
        fs::write(sidecar_path(&dir.join(".trash").join("x.mp4"), ".edits.json"), "{}").unwrap();
        let mut found = Vec::new();
        find_orphans_in(&dir, &mut found);
        assert_eq!(found, vec![sidecar_path(&dir.join("gone.mp4"), ".edits.json")]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn hidden_sidecars_can_be_written_again() {
        let dir = temp_dir("hidden");
        let file = dir.join("clip.mp4");
        let edits = sidecar_path(&file, ".edits.json");
        // New, then over the hidden one - the write Windows refuses without lifting the attribute.
        write_sidecar(&edits, "{\"a\":1}").unwrap();
        assert!(is_hidden(&edits));
        write_sidecar(&edits, "{\"a\":2}").unwrap();
        assert!(is_hidden(&edits));
        // Write-then-rename onto the hidden one.
        let tmp = sidecar_path(&edits, ".tmp");
        fs::write(&tmp, "{\"a\":3}").unwrap();
        commit_sidecar(&tmp, &edits).unwrap();
        assert!(is_hidden(&edits));
        assert_eq!(fs::read_to_string(&edits).unwrap(), "{\"a\":3}");
        // Older visible ones get hidden by the start-up pass; other files don't.
        let old = sidecar_path(&dir.join("old.png"), ".imageedit.json");
        fs::write(&old, "{}").unwrap();
        fs::write(dir.join("old.png"), b"png").unwrap();
        hide_sidecars_in(&dir);
        assert!(is_hidden(&old));
        assert!(!is_hidden(&dir.join("old.png")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn a_folders_hidden_list_names_each_companion_once() {
        let dir = temp_dir("hidden_list");
        let edits = sidecar_path(&dir.join("clip.mp4"), ".edits.json");
        write_sidecar(&edits, "{\"a\":1}").unwrap();
        write_sidecar(&edits, "{\"a\":2}").unwrap();
        let tmp = sidecar_path(&edits, ".tmp");
        fs::write(&tmp, "{\"a\":3}").unwrap();
        commit_sidecar(&tmp, &edits).unwrap();
        assert_eq!(fs::read_to_string(&edits).unwrap(), "{\"a\":3}");
        // Older visible ones get listed by the start-up pass; ordinary files never are.
        fs::write(dir.join("old.png"), b"png").unwrap();
        fs::write(sidecar_path(&dir.join("old.png"), ".imageedit.json"), "{}").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(sidecar_path(&dir.join("sub").join("v.mp4"), ".chapters.json"), "[]").unwrap();
        hide_sidecars_in(&dir);
        let mut listed: Vec<String> = fs::read_to_string(dir.join(".hidden")).unwrap().lines().map(String::from).collect();
        listed.sort();
        assert_eq!(listed, vec!["clip.mp4.edits.json".to_string(), "old.png.imageedit.json".to_string()]);
        assert_eq!(fs::read_to_string(dir.join("sub").join(".hidden")).unwrap(), "v.mp4.chapters.json\n");
        let _ = fs::remove_dir_all(&dir);
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("briefcast_sidecars_{}_{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn companions_follow_the_file_and_their_paths_are_updated() {
        let dir = temp_dir("carry");
        let old = dir.join("Untitled video (10).mp4");
        let new = dir.join("ETH Zurich.mp4");
        fs::write(&old, b"video").unwrap();
        let edits = format!("{{\"clips\":[{{\"sourcePath\":{}}}],\"other\":\"keep\"}}", serde_json::to_string(old.to_str().unwrap()).unwrap());
        fs::write(sidecar_path(&old, ".edits.json"), edits).unwrap();
        fs::write(sidecar_path(&old, ".chapters.json"), "[]").unwrap();

        check_destination_free(&new).unwrap();
        fs::rename(&old, &new).unwrap();
        carry_sidecars(&old, &new).unwrap();

        assert!(existing_sidecars(&old).is_empty());
        let moved = fs::read_to_string(sidecar_path(&new, ".edits.json")).unwrap();
        assert!(moved.contains("ETH Zurich.mp4") && !moved.contains("Untitled video (10)"), "{moved}");
        assert!(moved.contains("\"other\":\"keep\""));
        assert!(sidecar_path(&new, ".chapters.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_name_whose_old_edits_are_still_there_is_refused() {
        let dir = temp_dir("refuse");
        let taken = dir.join("Untitled video (10).briefvideo");
        fs::write(sidecar_path(&taken, ".edits.json"), "{}").unwrap();
        assert!(check_destination_free(&taken).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
