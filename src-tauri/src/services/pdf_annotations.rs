// pdf_annotations.rs
use std::{ffi::OsString, fs, path::{Path, PathBuf}};
use tauri::command;

// Sidecar lives next to the source PDF as "<name>.pdf.annotations.json". Appends to the
// OsString rather than using PathBuf::with_extension, which would replace ".pdf" instead of
// appending after it.
fn sidecar_path_for(pdf_path: &Path) -> PathBuf {
    let mut name = pdf_path.as_os_str().to_os_string();
    name.push(OsString::from(".annotations.json"));
    PathBuf::from(name)
}

#[command]
pub fn save_pdf_annotations(pdf_path: String, json: String) -> Result<(), String> {
    let pdf = PathBuf::from(&pdf_path);
    if !pdf.exists() {
        return Err(format!("PDF does not exist: {}", pdf_path));
    }

    let sidecar = sidecar_path_for(&pdf);
    let tmp_file_name = format!("{}.tmp", sidecar.file_name().unwrap().to_string_lossy());
    let tmp = sidecar.with_file_name(tmp_file_name);

    // Write-then-rename so a crash mid-write can't leave a truncated/corrupt sidecar behind.
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write annotations: {}", e))?;
    fs::rename(&tmp, &sidecar).map_err(|e| format!("Failed to save annotations: {}", e))?;

    Ok(())
}

#[command]
pub fn load_pdf_annotations(pdf_path: String) -> Result<Option<String>, String> {
    let sidecar = sidecar_path_for(&PathBuf::from(&pdf_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read annotations: {}", e))
}
