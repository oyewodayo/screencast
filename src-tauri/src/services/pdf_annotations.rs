// pdf_annotations.rs
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};
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

// Writes a fully flattened PDF (annotations baked into the page bitmaps by the frontend, via
// pdf-lib) to "<name> (annotated).pdf" next to the source PDF - same naming convention
// export_trimmed_video uses for its own sibling output file. Unlike the sidecar JSON, this is a
// real, standalone PDF: readable in any viewer, not just this app.
#[command]
pub fn save_exported_pdf(pdf_path: String, bytes: Vec<u8>) -> Result<String, String> {
    let pdf = PathBuf::from(&pdf_path);
    if !pdf.exists() {
        return Err(format!("PDF does not exist: {}", pdf_path));
    }

    let stem = pdf
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let parent = pdf.parent().map(PathBuf::from).unwrap_or_default();
    let output = parent.join(format!("{} (annotated).pdf", stem));

    let tmp_file_name = format!("{}.tmp", output.file_name().unwrap().to_string_lossy());
    let tmp = output.with_file_name(tmp_file_name);

    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write exported PDF: {}", e))?;
    fs::rename(&tmp, &output).map_err(|e| format!("Failed to save exported PDF: {}", e))?;

    Ok(output.to_string_lossy().to_string())
}
