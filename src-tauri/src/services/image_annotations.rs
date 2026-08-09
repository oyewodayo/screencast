// image_annotations.rs
//
// Mirrors pdf_annotations.rs exactly - same sidecar-json-plus-flattened-export shape, just for
// the standalone image editor instead of PDF annotation. See that file's own comments for the
// rationale behind write-then-rename and the "<name> (edited)" sibling-file convention.
use std::{ffi::OsString, fs, path::{Path, PathBuf}};
use tauri::command;

// Sidecar lives next to the source image as "<name>.<ext>.imageedit.json" - appends to the
// OsString (rather than PathBuf::with_extension, which would replace the image's own extension)
// so "photo.png" gets "photo.png.imageedit.json", not "photo.imageedit.json".
fn sidecar_path_for(image_path: &Path) -> PathBuf {
    let mut name = image_path.as_os_str().to_os_string();
    name.push(OsString::from(".imageedit.json"));
    PathBuf::from(name)
}

#[command]
pub fn save_image_annotations(image_path: String, json: String) -> Result<(), String> {
    let image = PathBuf::from(&image_path);
    if !image.exists() {
        return Err(format!("Image does not exist: {}", image_path));
    }

    let sidecar = sidecar_path_for(&image);
    let tmp_file_name = format!("{}.tmp", sidecar.file_name().unwrap().to_string_lossy());
    let tmp = sidecar.with_file_name(tmp_file_name);

    // Write-then-rename so a crash mid-write can't leave a truncated/corrupt sidecar behind.
    fs::write(&tmp, json.as_bytes()).map_err(|e| format!("Failed to write image edits: {}", e))?;
    fs::rename(&tmp, &sidecar).map_err(|e| format!("Failed to save image edits: {}", e))?;

    Ok(())
}

#[command]
pub fn load_image_annotations(image_path: String) -> Result<Option<String>, String> {
    let sidecar = sidecar_path_for(&PathBuf::from(&image_path));
    if !sidecar.exists() {
        return Ok(None);
    }
    fs::read_to_string(&sidecar)
        .map(Some)
        .map_err(|e| format!("Failed to read image edits: {}", e))
}

// Writes the fully composed image (base photo + adjustments + every annotation baked in by the
// frontend's canvas, PNG-encoded) to "<name> (edited).png" next to the source image - same
// naming convention save_exported_pdf/export_trimmed_video already use for their own sibling
// output files. The source image is never modified.
#[command]
pub fn save_edited_image(image_path: String, bytes: Vec<u8>) -> Result<String, String> {
    let image = PathBuf::from(&image_path);
    if !image.exists() {
        return Err(format!("Image does not exist: {}", image_path));
    }

    let stem = image.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let parent = image.parent().map(PathBuf::from).unwrap_or_default();
    let output = parent.join(format!("{} (edited).png", stem));

    let tmp_file_name = format!("{}.tmp", output.file_name().unwrap().to_string_lossy());
    let tmp = output.with_file_name(tmp_file_name);

    fs::write(&tmp, &bytes).map_err(|e| format!("Failed to write edited image: {}", e))?;
    fs::rename(&tmp, &output).map_err(|e| format!("Failed to save edited image: {}", e))?;

    Ok(output.to_string_lossy().to_string())
}
