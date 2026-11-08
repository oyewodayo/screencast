// commands/derived_images.rs
//
// Stills the frontend draws itself but needs as real files - a photo already fitted to a video
// frame over a blurred copy of itself (photoFill.ts), which then plays and exports like any other
// picture clip. Kept in the same derived-media cache as proxies and reversed clips, named from the
// source picture and what was made of it, so asking again finds the file already there.

// The stored JPEG for (`source_path`, `kind`, `key`), written from `jpeg_base64` the first time.
// Called without the bytes, it just says whether one is already there (None when not), so a still
// is only made once. `kind` is a short plain word - it becomes part of the file name.
#[tauri::command]
pub async fn store_derived_still(source_path: String, kind: String, key: String, jpeg_base64: Option<String>) -> Result<Option<String>, String> {
    if kind.is_empty() || kind.len() > 32 || !kind.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err("Invalid still kind".into());
    }
    let path = super::conversion::derived_media_path(&source_path, &kind, &key, "jpg")?;
    if path.is_file() {
        return Ok(Some(path.to_string_lossy().into_owned()));
    }
    let Some(encoded) = jpeg_base64 else { return Ok(None) };
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded.as_bytes()).map_err(|e| format!("Bad image data: {e}"))?;
    if bytes.len() < 4 || bytes[0..3] != [0xFF, 0xD8, 0xFF] {
        return Err("Not a JPEG".into());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {}", dir.display(), e))?;
    }
    // Written beside it first, then moved into place - never a half-written picture under the name.
    let tmp = path.with_extension("jpg.part");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("Couldn't save the picture: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Couldn't save the picture: {e}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}
