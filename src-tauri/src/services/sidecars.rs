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
    if fs::write(&tmp, out).is_ok() && fs::rename(&tmp, sidecar).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
