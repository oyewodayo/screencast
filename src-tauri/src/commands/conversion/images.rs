// Image conversion, Image-to-PDF, HEIC previews, thumbnails, and scrub sprites.
use super::*;

/// Wraps JPEG bytes in a standard single-page PDF document sized exactly to the image's dimensions.
pub(crate) fn wrap_jpeg_in_pdf(jpeg_bytes: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    let mut offsets = Vec::new();

    // 1: Catalog
    offsets.push(out.len());
    out.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

    // 2: Pages
    offsets.push(out.len());
    out.extend_from_slice(b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");

    // 3: Page (MediaBox: width x height points at 1px = 1pt)
    offsets.push(out.len());
    let page_obj = format!(
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n",
        width, height
    );
    out.extend_from_slice(page_obj.as_bytes());

    // 4: Contents stream (places /Im1 at (0, 0) scaled to width x height)
    offsets.push(out.len());
    let stream_content = format!("q\n{} 0 0 {} 0 0 cm\n/Im1 Do\nQ\n", width, height);
    let content_obj = format!(
        "4 0 obj\n<< /Length {} >>\nstream\n{}endstream\nendobj\n",
        stream_content.len(),
        stream_content
    );
    out.extend_from_slice(content_obj.as_bytes());

    // 5: Image XObject with DCTDecode (native JPEG compression)
    offsets.push(out.len());
    let img_header = format!(
        "5 0 obj\n<< /Type /XObject /Subtype /Image /Width {} /Height {} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
        width, height, jpeg_bytes.len()
    );
    out.extend_from_slice(img_header.as_bytes());
    out.extend_from_slice(jpeg_bytes);
    out.extend_from_slice(b"\nendstream\nendobj\n");

    // xref table (each entry exactly 20 bytes per ISO 32000-1)
    let xref_offset = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", offsets.len() + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for off in &offsets {
        out.extend_from_slice(format!("{:010} 00000 n \n", off).as_bytes());
    }

    // trailer
    let trailer = format!(
        "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
        offsets.len() + 1,
        xref_offset
    );
    out.extend_from_slice(trailer.as_bytes());

    out
}

/// Converts any supported image file (PNG, JPEG, WebP, BMP, etc.) into a standalone PDF document.
pub(crate) fn convert_image_file_to_pdf(input: &Path, output: &Path) -> Result<(), String> {
    use image::ImageDecoder;

    let parent = output.parent().unwrap_or_else(|| Path::new(""));
    if !parent.as_os_str().is_empty() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create destination folder: {e}"))?;
    }

    // Decode with orientation awareness so phone camera EXIF tags are respected
    let (mut img, orientation) = match image::ImageReader::open(input)
        .and_then(|reader| reader.with_guessed_format())
    {
        Ok(reader) => match reader.into_decoder() {
            Ok(mut decoder) => {
                let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
                match image::DynamicImage::from_decoder(decoder) {
                    Ok(img) => (img, orientation),
                    Err(_) => (image::open(input).map_err(|e| format!("Failed to decode image: {e}"))?, image::metadata::Orientation::NoTransforms),
                }
            }
            Err(_) => (image::open(input).map_err(|e| format!("Failed to decode image: {e}"))?, image::metadata::Orientation::NoTransforms),
        },
        Err(_) => (image::open(input).map_err(|e| format!("Failed to open image: {e}"))?, image::metadata::Orientation::NoTransforms),
    };
    img.apply_orientation(orientation);

    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return Err("Image has zero width or height".to_string());
    }

    // Composite any transparent alpha over a crisp white background
    let rgb_image = match &img {
        image::DynamicImage::ImageRgba8(rgba) => {
            let mut rgb = image::RgbImage::new(w, h);
            for (x, y, pixel) in rgba.enumerate_pixels() {
                let [r, g, b, a] = pixel.0;
                if a == 255 {
                    rgb.put_pixel(x, y, image::Rgb([r, g, b]));
                } else if a == 0 {
                    rgb.put_pixel(x, y, image::Rgb([255, 255, 255]));
                } else {
                    let alpha = a as f32 / 255.0;
                    let bg = 255.0 * (1.0 - alpha);
                    let cr = (r as f32 * alpha + bg).round() as u8;
                    let cg = (g as f32 * alpha + bg).round() as u8;
                    let cb = (b as f32 * alpha + bg).round() as u8;
                    rgb.put_pixel(x, y, image::Rgb([cr, cg, cb]));
                }
            }
            rgb
        }
        _ => img.to_rgb8(),
    };

    let mut jpeg_bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_bytes, 95)
        .encode(&rgb_image, w, h, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("Failed to encode image for PDF: {e}"))?;

    let pdf_bytes = wrap_jpeg_in_pdf(&jpeg_bytes, w, h);

    let tmp_file_name = format!("{}.tmp", output.file_name().unwrap_or_default().to_string_lossy());
    let tmp = output.with_file_name(tmp_file_name);
    std::fs::write(&tmp, &pdf_bytes).map_err(|e| format!("Failed to write PDF: {e}"))?;
    std::fs::rename(&tmp, output).map_err(|e| format!("Failed to save PDF: {e}"))?;

    Ok(())
}

// Convert a still image (screenshot) between png/jpeg/webp/bmp/pdf.
#[tauri::command]
pub async fn convert_image(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    output_format: String,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => input.with_extension(&output_format),
    };

    let target_format = output_format.to_lowercase();

    // PDF output path
    if target_format == "pdf" {
        let final_output = unique_output_path(output);
        let _ = window.emit(
            "conversion-progress",
            ConversionProgress {
                input_path: input_path.clone(),
                output_path: final_output.to_string_lossy().to_string(),
                progress: 0.0,
                status: ConversionStatus::Starting,
                message: "Converting image to PDF...".to_string(),
            },
        );

        #[cfg(windows)]
        {
            let input_ext = input
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase());
            if matches!(input_ext.as_deref(), Some("heic") | Some("heif")) {
                return convert_heic_windows(
                    &app_handle,
                    &window,
                    &state,
                    &input,
                    final_output,
                    "pdf",
                    preserve_original,
                )
                .await;
            }
        }

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let input_ext = input
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase());
            if matches!(input_ext.as_deref(), Some("heic") | Some("heif")) {
                return convert_heic_unix(
                    &app_handle,
                    &window,
                    &state,
                    &input,
                    final_output,
                    "pdf",
                    preserve_original,
                )
                .await;
            }
        }

        let result = convert_image_file_to_pdf(&input, &final_output);
        match result {
            Ok(()) => {
                let _ = window.emit(
                    "conversion-progress",
                    ConversionProgress {
                        input_path: input_path.clone(),
                        output_path: final_output.to_string_lossy().to_string(),
                        progress: 100.0,
                        status: ConversionStatus::Completed,
                        message: "Conversion completed".to_string(),
                    },
                );
                if !preserve_original {
                    let _ = std::fs::remove_file(&input);
                }
                return Ok(final_output.to_string_lossy().to_string());
            }
            Err(err) => {
                let _ = window.emit(
                    "conversion-progress",
                    ConversionProgress {
                        input_path: input_path.clone(),
                        output_path: String::new(),
                        progress: 0.0,
                        status: ConversionStatus::Failed,
                        message: err.clone(),
                    },
                );
                return Err(err);
            }
        }
    }

    let codec_args: Vec<&str> = match target_format.as_str() {
        "png" | "jpeg" | "jpg" | "webp" | "bmp" => vec![],
        _ => return Err(format!("Unsupported output format: {}", output_format)),
    };

    // HEIC/HEIF inputs skip ffmpeg entirely on Windows - see heic_windows.rs's module doc for why
    // (the bundled ffmpeg build mis-decodes modern iPhone Portrait-mode/multi-image HEIC files as
    // a black frame). Not gated on the *output* format because the bug is in reading the HEIC
    // source, not in what ffmpeg would have encoded it to.
    #[cfg(windows)]
    {
        let input_ext = input
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());
        if matches!(input_ext.as_deref(), Some("heic") | Some("heif")) {
            return convert_heic_windows(
                &app_handle,
                &window,
                &state,
                &input,
                output,
                &output_format,
                preserve_original,
            )
            .await;
        }
    }

    // macOS/Linux counterpart to the Windows block above - same bug (ffmpeg mis-decodes modern
    // multi-image HEIC), same fix (libheif via heic_unix.rs), just one tier instead of two since
    // there's no OS-built-in decoder to try first here the way Windows has WIC.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let input_ext = input
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());
        if matches!(input_ext.as_deref(), Some("heic") | Some("heif")) {
            return convert_heic_unix(
                &app_handle,
                &window,
                &state,
                &input,
                output,
                &output_format,
                preserve_original,
            )
            .await;
        }
    }

    let result = run_conversion(
        &app_handle,
        &window,
        &state,
        &[InputSpec::plain(input_path.clone())],
        &input_path,
        output,
        &codec_args,
    )
    .await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}

// HEIC/HEIF path for convert_image, above - always decodes through Windows' own HEIF codec to a
// full-resolution PNG first (see heic_windows::decode_to_png), then - unless PNG is what was
// actually asked for - hands that PNG to the same ffmpeg image2 pipeline every other image format
// already uses to reach jpeg/webp/bmp. ffmpeg is perfectly reliable at that second step; the only
// thing it couldn't be trusted with was reading the HEIC file in the first place.
#[cfg(windows)]
pub(crate) async fn convert_heic_windows(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    input: &PathBuf,
    output: PathBuf,
    output_format: &str,
    preserve_original: bool,
) -> Result<String, String> {
    let _ = window.emit(
        "conversion-progress",
        ConversionProgress {
            input_path: input.to_string_lossy().to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 0.0,
            status: ConversionStatus::Starting,
            message: "Decoding HEIC photo...".to_string(),
        },
    );

    let format = output_format.to_lowercase();
    let final_output = unique_output_path(output);

    let native_result: Result<String, String> = async {
        if format == "png" {
            crate::services::heic_windows::decode_to_png(input.clone(), final_output.clone())
                .await?;
            Ok(final_output.to_string_lossy().to_string())
        } else if format == "pdf" {
            let temp_png = final_output.with_extension("heic_tmp.png");
            crate::services::heic_windows::decode_to_png(input.clone(), temp_png.clone()).await?;
            let res = convert_image_file_to_pdf(&temp_png, &final_output);
            let _ = std::fs::remove_file(&temp_png);
            res.map(|_| final_output.to_string_lossy().to_string())
        } else {
            let temp_png = final_output.with_extension("heic_tmp.png");
            crate::services::heic_windows::decode_to_png(input.clone(), temp_png.clone()).await?;
            let transcode = run_conversion(
                app_handle,
                window,
                state,
                &[InputSpec::plain(temp_png.to_string_lossy().to_string())],
                &input.to_string_lossy(),
                final_output.clone(),
                &[],
            )
            .await;
            let _ = std::fs::remove_file(&temp_png);
            transcode
        }
    }
    .await;

    // Windows' own HEIC decoder needs the HEVC Video Extensions codec package installed (separate
    // from HEIF Image Extensions, which just handles the container/metadata) - plenty of machines
    // only have the latter. Rather than fail outright when that codec is missing, fall back to a
    // bundled libheif build (services/heif_tool.rs) instead of the app's own ffmpeg - ffmpeg's
    // HEIF tile-grid reconstruction badly under-reconstructs the tiled grid modern iPhone photos
    // are stored as (a small, blown-up fragment of the real photo, not just lower resolution -
    // confirmed against real user photos), where libheif is the reference implementation and gets
    // it right.
    let result = match native_result {
        Ok(path) => Ok(path),
        Err(native_err) => {
            log::warn!(
                "HEIC native decode failed for {}: {native_err}; falling back to bundled libheif",
                input.display()
            );
            let fallback: Result<String, String> = async {
                if format == "png" {
                    crate::services::heif_tool::decode_to_png(
                        app_handle.clone(),
                        input.clone(),
                        final_output.clone(),
                    )
                    .await?;
                    Ok(final_output.to_string_lossy().to_string())
                } else if format == "pdf" {
                    let temp_png = final_output.with_extension("heic_tmp.png");
                    crate::services::heif_tool::decode_to_png(
                        app_handle.clone(),
                        input.clone(),
                        temp_png.clone(),
                    )
                    .await?;
                    let res = convert_image_file_to_pdf(&temp_png, &final_output);
                    let _ = std::fs::remove_file(&temp_png);
                    res.map(|_| final_output.to_string_lossy().to_string())
                } else {
                    let temp_png = final_output.with_extension("heic_tmp.png");
                    crate::services::heif_tool::decode_to_png(
                        app_handle.clone(),
                        input.clone(),
                        temp_png.clone(),
                    )
                    .await?;
                    let transcode = run_conversion(
                        app_handle,
                        window,
                        state,
                        &[InputSpec::plain(temp_png.to_string_lossy().to_string())],
                        &input.to_string_lossy(),
                        final_output.clone(),
                        &[],
                    )
                    .await;
                    let _ = std::fs::remove_file(&temp_png);
                    transcode
                }
            }
            .await;
            if let Err(heif_err) = &fallback {
                log::error!(
                    "HEIC libheif fallback also failed for {}: {heif_err}",
                    input.display()
                );
            }
            fallback.map_err(|heif_err| {
                format!("{native_err}; fallback conversion also failed: {heif_err}")
            })
        }
    };

    match &result {
        Ok(path) => {
            let _ = window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: input.to_string_lossy().to_string(),
                    output_path: path.clone(),
                    progress: 100.0,
                    status: ConversionStatus::Completed,
                    message: "Conversion completed".to_string(),
                },
            );
            if !preserve_original {
                let _ = std::fs::remove_file(input);
            }
        }
        Err(err) => {
            let _ = window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: input.to_string_lossy().to_string(),
                    output_path: String::new(),
                    progress: 0.0,
                    status: ConversionStatus::Failed,
                    message: err.clone(),
                },
            );
        }
    }

    result
}

// macOS/Linux counterpart to convert_heic_windows above - same shape (decode to PNG first, then
// hand off to the normal ffmpeg image2 pipeline unless PNG is what was actually asked for), just a
// single tier since there's no OS-built-in HEIC decoder to try before falling back to libheif here.
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) async fn convert_heic_unix(
    app_handle: &AppHandle,
    window: &Window,
    state: &ConversionState,
    input: &PathBuf,
    output: PathBuf,
    output_format: &str,
    preserve_original: bool,
) -> Result<String, String> {
    let _ = window.emit(
        "conversion-progress",
        ConversionProgress {
            input_path: input.to_string_lossy().to_string(),
            output_path: output.to_string_lossy().to_string(),
            progress: 0.0,
            status: ConversionStatus::Starting,
            message: "Decoding HEIC photo...".to_string(),
        },
    );

    let format = output_format.to_lowercase();
    let final_output = unique_output_path(output);

    let result: Result<String, String> = async {
        if format == "png" {
            crate::services::heic_unix::decode_to_png(input.clone(), final_output.clone()).await?;
            Ok(final_output.to_string_lossy().to_string())
        } else if format == "pdf" {
            let temp_png = final_output.with_extension("heic_tmp.png");
            crate::services::heic_unix::decode_to_png(input.clone(), temp_png.clone()).await?;
            let res = convert_image_file_to_pdf(&temp_png, &final_output);
            let _ = std::fs::remove_file(&temp_png);
            res.map(|_| final_output.to_string_lossy().to_string())
        } else {
            let temp_png = final_output.with_extension("heic_tmp.png");
            crate::services::heic_unix::decode_to_png(input.clone(), temp_png.clone()).await?;
            let transcode = run_conversion(
                app_handle,
                window,
                state,
                &[InputSpec::plain(temp_png.to_string_lossy().to_string())],
                &input.to_string_lossy(),
                final_output.clone(),
                &[],
            )
            .await;
            let _ = std::fs::remove_file(&temp_png);
            transcode
        }
    }
    .await;

    match &result {
        Ok(path) => {
            let _ = window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: input.to_string_lossy().to_string(),
                    output_path: path.clone(),
                    progress: 100.0,
                    status: ConversionStatus::Completed,
                    message: "Conversion completed".to_string(),
                },
            );
            if !preserve_original {
                let _ = std::fs::remove_file(input);
            }
        }
        Err(err) => {
            let _ = window.emit(
                "conversion-progress",
                ConversionProgress {
                    input_path: input.to_string_lossy().to_string(),
                    output_path: String::new(),
                    progress: 0.0,
                    status: ConversionStatus::Failed,
                    message: err.clone(),
                },
            );
        }
    }

    result
}

// Silent, cached HEIC/HEIF -> PNG preview for on-screen display only, at full resolution - the
// single-image viewer's counterpart to get_playable_preview above but for photos instead of
// video (get_image_thumbnail below is the gallery-grid counterpart - deliberately a *different*
// command, since a grid tile only ever needs a few hundred pixels and paying this function's full
// decode cost per thumbnail was exactly what made opening a large HEIC folder painfully slow).
// WebView2 has no HEIC decoder at all, so a plain <img src> just fails to load one. Unlike
// convert_image/convert_heic_windows (an explicit, user-triggered "Convert" that writes a
// permanent sibling file into the library), this never touches the source file and never adds
// anything to the library - it only ever writes into the same content-addressed temp cache
// get_playable_preview uses, so viewing the same photo again is instant and nothing shows up next
// to the original in the file list. Frontend calls this once per HEIC/HEIF file (see
// Dashboard.tsx's resolveImageDisplayUrl) and feeds the returned path through the same
// convert_file_path_to_url + convertFileSrc round-trip every other preview already uses.
#[tauri::command]
pub async fn get_heic_preview(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
) -> Result<String, String> {
    heic_preview(app_handle, window, &state, input_path).await
}

pub(super) async fn heic_preview(app_handle: AppHandle, window: Window, state: &ConversionState, input_path: String) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "heic_v2", "png")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create preview cache directory: {}", e))?;
    }

    #[cfg(windows)]
    {
        let _ = (&window, &state); // only used by the non-Windows branch below
        if let Err(native_err) =
            crate::services::heic_windows::decode_to_png(input.clone(), cache_path.clone()).await
        {
            // Windows' own HEIC decoder needs the HEVC Video Extensions codec package installed
            // (separate from HEIF Image Extensions) - plenty of machines only have the latter. Same
            // bundled-libheif fallback as convert_heic_windows above; see its comment for why that
            // replaced an ffmpeg fallback here.
            log::warn!(
                "HEIC native decode failed for {}: {native_err}; falling back to bundled libheif",
                input.display()
            );
            if let Err(heif_err) = crate::services::heif_tool::decode_to_png(
                app_handle.clone(),
                input.clone(),
                cache_path.clone(),
            )
            .await
            {
                log::error!(
                    "HEIC libheif fallback also failed for {}: {heif_err}",
                    input.display()
                );
                return Err(format!(
                    "{native_err}; fallback conversion also failed: {heif_err}"
                ));
            }
        }
        path_to_str(&cache_path).map(|s| s.to_string())
    }

    // macOS/Linux: try libheif first (see heic_unix.rs) - ffmpeg's own HEIF tile-grid
    // reconstruction is the same known-bad path documented on the Windows side above. Falls back
    // to ffmpeg only if libheif isn't installed, since this is a silent/cached background preview
    // rather than an explicit user action - producing a possibly-low-quality preview beats a hard
    // error here (unlike convert_image/convert_heic_unix, where a failed conversion should surface
    // clearly rather than silently write a degraded file into the library).
    #[cfg(not(windows))]
    {
        if let Err(err) =
            crate::services::heic_unix::decode_to_png(input.clone(), cache_path.clone()).await
        {
            log::warn!(
                "HEIC libheif decode failed for {}: {err}; falling back to ffmpeg (may be low quality for multi-image HEIC)",
                input.display()
            );
            run_conversion(
                &app_handle,
                &window,
                &state,
                &[InputSpec::plain(input_path.clone())],
                &input_path,
                cache_path,
                &[],
            )
            .await
        } else {
            path_to_str(&cache_path).map(|s| s.to_string())
        }
    }
}

// Long edge, in pixels, of a gallery-grid thumbnail - generous headroom over the CSS tile size
// (ImageFolderGallery.tsx renders these well under 300px) for high-DPI displays, while staying
// small enough that decoding one in the browser is cheap and 100+ of them fit comfortably in the
// renderer's image cache at once (the full-resolution originals didn't - see get_image_thumbnail
// below).
pub(super) const GALLERY_THUMBNAIL_MAX_DIMENSION: u32 = 480;

// Silent, cached, small preview for an image gallery grid tile - counterpart to get_heic_preview
// above, but deliberately NOT that function at a smaller size: ImageFolderGallery.tsx used to
// point every grid tile straight at the full-resolution decode (get_heic_preview, or the plain
// original file for non-HEIC), which is correct for a single enlarged view but wrong for a grid
// of 100+ tiles - each one is a multi-megapixel decoded bitmap the browser's image cache can't
// hold all of at once, so scrolling away and back forced a re-decode of whatever got evicted
// (observed directly: images visibly "reloading" on scroll-up, and the initial load being far
// slower than it needed to be). This produces something actually sized for a thumbnail instead.
//
// HEIC/HEIF goes through the bundled heif-thumbnailer (services/heif_tool.rs) - it renders the
// small embedded preview HEIC containers already carry (or a fast downscale of the primary image
// if there isn't one) rather than doing heif-dec's full tile-grid reconstruction, which measured
// roughly 20x faster per photo in practice. Every other format is decoded and downscaled directly
// via the `image` crate, in-process - no bundled binary needed for those, and cheaper than
// shelling out to ffmpeg for something this small.
#[tauri::command]
pub async fn get_image_thumbnail(
    app_handle: AppHandle,
    input_path: String,
) -> Result<String, String> {
    // Unconditional entry log (cache hit or miss) - the only line in this command that always
    // fires. Every other line here only logs on error, so a request that hangs (concurrencyLimiter
    // ts's withLimit racing it against a timeout instead of waiting forever - see that file's own
    // comment) previously left zero trace of ever having reached Rust at all: nothing in this log
    // to say whether the hang was in here or below the IPC layer entirely. This one line answers
    // that immediately next time - if it's missing for a stuck request, look at the frontend/IPC
    // side instead of in here.
    log::debug!("get_image_thumbnail: {}", input_path);
    let input = PathBuf::from(&input_path);
    // v2: thumbnails now honor EXIF orientation (see generate_plain_thumbnail) - the bump is what
    // retires every sideways phone-photo thumbnail cached under v1.
    let cache_path = preview_cache_path(&input, "thumb_v2", "jpg")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }

    #[cfg(not(windows))]
    let _ = &app_handle; // only used by heif_tool on Windows - heic_unix needs no AppHandle

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase());
    #[cfg(windows)]
    if matches!(ext.as_deref(), Some("heic") | Some("heif")) {
        if let Err(err) = crate::services::heif_tool::extract_thumbnail(
            app_handle,
            input.clone(),
            cache_path.clone(),
            GALLERY_THUMBNAIL_MAX_DIMENSION,
        )
        .await
        {
            log::error!("HEIC thumbnail failed for {}: {err}", input.display());
            return Err(err);
        }
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    // macOS/Linux counterpart to the Windows block above - see heic_unix.rs. No ffmpeg fallback
    // here (unlike get_heic_preview) since a gallery thumbnail is cheap to retry and a silently
    // wrong/blank tile is worse than a clear per-file error surfaced to the frontend.
    #[cfg(not(windows))]
    if matches!(ext.as_deref(), Some("heic") | Some("heif")) {
        if let Err(err) = crate::services::heic_unix::extract_thumbnail(
            input.clone(),
            cache_path.clone(),
            GALLERY_THUMBNAIL_MAX_DIMENSION,
        )
        .await
        {
            log::error!("HEIC thumbnail failed for {}: {err}", input.display());
            return Err(err);
        }
        return path_to_str(&cache_path).map(|s| s.to_string());
    }

    let input_for_blocking = input.clone();
    let cache_for_blocking = cache_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        generate_plain_thumbnail(&input_for_blocking, &cache_for_blocking)
    })
    .await
    .map_err(|e| format!("Thumbnail task panicked: {e}"))?
    .map_err(|err| {
        log::error!("Image thumbnail failed for {}: {err}", input.display());
        err
    })?;

    path_to_str(&cache_path).map(|s| s.to_string())
}

pub(super) fn generate_plain_thumbnail(input: &PathBuf, output: &PathBuf) -> Result<(), String> {
    use image::ImageDecoder;
    // Decoded through the format's own decoder (not image::open) so the EXIF orientation a phone
    // camera writes instead of rotating the pixels can be applied - image::open ignores it, which
    // left every portrait phone photo's thumbnail lying on its side. ffmpeg (image clip previews
    // and export) already honors the same tag, so thumbnails now match what renders.
    let mut decoder = image::ImageReader::open(input)
        .and_then(|reader| reader.with_guessed_format())
        .map_err(|e| format!("Failed to open image: {e}"))?
        .into_decoder()
        .map_err(|e| format!("Failed to open image: {e}"))?;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| format!("Failed to decode image: {e}"))?;
    img.apply_orientation(orientation);
    img.thumbnail(
        GALLERY_THUMBNAIL_MAX_DIMENSION,
        GALLERY_THUMBNAIL_MAX_DIMENSION,
    )
    .save(output)
    .map_err(|e| format!("Failed to save thumbnail: {e}"))
}

// Silent, cached poster-frame thumbnail for a video gallery grid tile - the video counterpart to
// get_image_thumbnail above. Extracts a single downscaled frame via the bundled ffmpeg, 1 second
// in rather than frame 0 (a screen recording's very first frame is very often solid black/blank
// before anything's actually happened on screen) - with a fallback to frame 0 if that seek fails,
// which happens for clips shorter than a second. Cached the same way every other gallery
// thumbnail is (content-addressed by path+mtime - see preview_cache_path), so revisiting a video
// folder is instant after the first pass.
#[tauri::command]
pub async fn get_video_thumbnail(
    app_handle: AppHandle,
    input_path: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    // One the user chose ("Set thumbnail") wins over any extracted frame - see custom_thumbnail_path.
    if let Ok(custom) = custom_thumbnail_path(&app_handle, &input) {
        if custom.exists() {
            return path_to_str(&custom).map(|s| s.to_string());
        }
    }
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;

    if cache_path.exists() {
        return path_to_str(&cache_path).map(|s| s.to_string());
    }
    // A file that already failed both extractions isn't retried until it changes (the cache path
    // is keyed by mtime, so a changed file gets a fresh key) - a broken file in a gallery used to
    // cost two ffmpeg runs every time the grid re-rendered, about once a second, indefinitely.
    // The marker file carries that across restarts too - otherwise every launch re-ran both
    // extractions for every broken file in the library (over a thousand logged failures a day).
    let failed_marker = cache_path.with_extension("failed");
    if failed_video_thumbnails().contains(&cache_path) || failed_marker.exists() {
        return Err("Thumbnail extraction already failed for this version of the file".to_string());
    }
    // An empty file (a recording or export that never got going) can't hold a frame - no need to
    // spend two ffmpeg runs finding that out.
    if std::fs::metadata(&input).map(|m| m.len() == 0).unwrap_or(false) {
        failed_video_thumbnails().insert(cache_path);
        return Err("The file is empty".to_string());
    }

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }

    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    if let Err(err) = extract_video_frame(&ffmpeg_path, &input, &cache_path, "00:00:01", 480).await {
        log::warn!(
            "Video thumbnail seek to 1s failed for {}: {err}; retrying at frame 0",
            input.display()
        );
        if let Err(err2) = extract_video_frame(&ffmpeg_path, &input, &cache_path, "00:00:00", 480).await
        {
            let combined = format!("{err}; retry at frame 0 also failed: {err2}");
            log::error!("Video thumbnail failed for {}: {combined}", input.display());
            let _ = std::fs::write(&failed_marker, b"");
            failed_video_thumbnails().insert(cache_path);
            return Err(combined);
        }
    }

    path_to_str(&cache_path).map(|s| s.to_string())
}

pub(super) fn failed_video_thumbnails() -> std::sync::MutexGuard<'static, std::collections::HashSet<PathBuf>> {
    static FAILED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<PathBuf>>> =
        std::sync::OnceLock::new();
    FAILED
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

// Lets a user pick which frame becomes a video's thumbnail - both inside Briefcast (gallery/
// sidebar poster, get_video_thumbnail's cache) AND wherever the file itself is shared, by
// embedding that same frame as the file's attached-picture/cover image (the same mechanism MP3
// cover art uses) - the thing an app-side cache alone can never affect, since Explorer, WhatsApp,
// etc. never see Briefcast's cache, only the file's own bytes/metadata.
//
// Two ffmpeg passes: extract_video_frame gets the chosen frame as a jpg straight into
// get_video_thumbnail's own cache slot (so the in-app poster updates for free, no separate write),
// then embed_cover_art re-muxes that jpg into a new copy of the video with `-c copy` on the real
// audio/video streams (fast, lossless - only the newly-added still-image stream gets encoded, as
// mjpeg) and `-disposition:v:1 attached_pic` marking it as cover art. The re-mux writes to a
// sibling temp file, never in place - ffmpeg cannot read and write the same file at once - and
// only replaces the original on success, same write-tmp-then-rename convention as every sidecar
// in this app, just applied to the video file itself here instead of a JSON file next to it.
//
// Replacing the original changes its mtime, which orphans (not corrupts - just makes unreachable)
// every other path+mtime-keyed cache for this file (scrub sprite, captions, whisper transcript) -
// accepted fallout, identical in kind to what exporting/re-encoding this file already does today;
// each regenerates transparently on next use. Sidecars (.edits.json/.chapters.json) stay valid
// since they're keyed by path, not mtime.
#[tauri::command]
pub async fn set_video_thumbnail(
    app_handle: AppHandle,
    input_path: String,
    time: f64,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;

    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }

    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let seek = format!("{:.3}", time.max(0.0));
    extract_video_frame(&ffmpeg_path, &input, &cache_path, &seek, 1920).await?;
    embed_cover_and_replace(&app_handle, &ffmpeg_path, &input, &cache_path, &input_path).await
}

// set_video_thumbnail's counterpart for a picture from disk instead of one of the video's own
// frames ("Choose image..." in the thumbnail picker). ffmpeg converts whatever image it is (png,
// webp, a big camera jpg...) into the same downscaled jpg in get_video_thumbnail's cache slot,
// then the same embed-and-replace step runs.
#[tauri::command]
pub async fn set_video_thumbnail_from_image(
    app_handle: AppHandle,
    input_path: String,
    image_path: String,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    let image = PathBuf::from(&image_path);
    if !image.is_file() {
        return Err("That image no longer exists".to_string());
    }
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    }
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    image_to_cover_jpg(&ffmpeg_path, &image, &cache_path).await?;
    embed_cover_and_replace(&app_handle, &ffmpeg_path, &input, &cache_path, &input_path).await
}

// The thumbnail editor's output (a frame or picture with text/logo layers drawn on, composed in
// the webview's canvas) - same as set_video_thumbnail_from_image, from the encoded bytes instead
// of a file that already exists on disk.
#[tauri::command]
pub async fn set_video_thumbnail_from_bytes(
    app_handle: AppHandle,
    input_path: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("The edited thumbnail came through empty".to_string());
    }
    let input = PathBuf::from(&input_path);
    let cache_path = preview_cache_path(&input, "video_thumb_v1", "jpg")?;
    let parent = cache_path
        .parent()
        .ok_or("Invalid thumbnail cache path")?
        .to_path_buf();
    std::fs::create_dir_all(&parent)
        .map_err(|e| format!("Failed to create thumbnail cache directory: {}", e))?;
    let source = parent.join(format!("edited_{}.jpg", std::process::id()));
    std::fs::write(&source, &bytes).map_err(|e| format!("Failed to write the edited thumbnail: {}", e))?;
    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    let converted = image_to_cover_jpg(&ffmpeg_path, &source, &cache_path).await;
    let _ = std::fs::remove_file(&source);
    converted?;
    embed_cover_and_replace(&app_handle, &ffmpeg_path, &input, &cache_path, &input_path).await
}

pub(super) async fn image_to_cover_jpg(ffmpeg_path: &PathBuf, image: &PathBuf, output: &PathBuf) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let image = image.clone();
    let output = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y");
        cmd.arg("-i").arg(path_to_str(&image)?);
        // Even dimensions (mjpeg in an mp4 is happier) and never upscaled past the original.
        cmd.args(["-frames:v", "1", "-update", "1", "-vf", "scale='min(1920,iw)':-2", "-q:v", "2"]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        let result = cmd.output().map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() || !output.exists() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let reason = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("unknown ffmpeg error").to_string();
            return Err(format!("Couldn't read that image: {reason}"));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Thumbnail image task panicked: {e}"))?
}

// Where a thumbnail the user chose is kept: the app's own data folder (not the temp-dir preview
// cache, which Windows' disk cleanup empties), keyed by the file's path - so it survives restarts
// and holds for files that can't carry a cover themselves (.mov, .avi, .mkv...).
pub(super) fn custom_thumbnail_path(app_handle: &AppHandle, input: &PathBuf) -> Result<PathBuf, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use tauri::Manager;
    let mut hasher = DefaultHasher::new();
    input.to_string_lossy().to_lowercase().hash(&mut hasher);
    let dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("No app data folder: {e}"))?
        .join("custom_thumbnails");
    Ok(dir.join(format!("{:x}.jpg", hasher.finish())))
}

// Why the cover can't go INTO this file, if it can't - the file is then left untouched and the
// thumbnail lives in Briefcast only. Measured against the bundled ffmpeg:
// - only the MP4 writer stores a cover; the QuickTime (.mov) writer silently drops it, so a .mov
//   used to come out rewritten with no cover at all;
// - keeping Apple's metadata (recording date, location, camera model) needs -movflags
//   use_metadata_tags, which in turn makes the MP4 writer drop the cover - so an MP4 carrying
//   those tags is never rewritten either: a cover isn't worth anyone's date/location history.
// Otherwise returns the number of real (non-cover) video streams - where the new cover goes.
pub(super) fn embed_blocker(app_handle: &AppHandle, input: &PathBuf) -> Result<usize, &'static str> {
    let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if ext != "mp4" && ext != "m4v" {
        return Err("format");
    }
    let ffprobe_path = get_ffprobe_path(app_handle).map_err(|_| "probe")?;
    let mut cmd = Command::new(&ffprobe_path);
    cmd.args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams"]);
    cmd.arg(path_to_str(input).map_err(|_| "probe")?);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd.output().map_err(|_| "probe")?;
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| "probe")?;
    let has_apple_tags = probe["format"]["tags"]
        .as_object()
        .map(|tags| tags.keys().any(|k| k.to_lowercase().starts_with("com.apple.")))
        .unwrap_or(false);
    if has_apple_tags {
        return Err("metadata");
    }
    let real_videos = probe["streams"]
        .as_array()
        .map(|streams| {
            streams
                .iter()
                .filter(|st| st["codec_type"] == "video" && st["disposition"]["attached_pic"].as_i64() != Some(1))
                .count()
        })
        .unwrap_or(0);
    if real_videos == 0 {
        return Err("probe");
    }
    Ok(real_videos)
}

// Applies `cover` (already in get_video_thumbnail's cache slot) as this video's thumbnail: always
// in Briefcast (custom_thumbnail_path), and also inside the file itself - a re-muxed copy swapped
// in for the original - only where that's possible without losing anything (embed_blocker).
// Returns "embedded", or "app-only:<why>" (embed_blocker's reason), so the picker can say which.
pub(super) async fn embed_cover_and_replace(
    app_handle: &AppHandle,
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    cover: &PathBuf,
    input_path: &str,
) -> Result<String, String> {
    let cache_path = cover;
    let custom = custom_thumbnail_path(app_handle, input)?;
    if let Some(parent) = custom.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create the thumbnails folder: {}", e))?;
    }
    std::fs::copy(cache_path, &custom).map_err(|e| format!("Failed to keep the thumbnail: {}", e))?;

    let blocker = {
        let app_handle = app_handle.clone();
        let input = input.clone();
        tauri::async_runtime::spawn_blocking(move || embed_blocker(&app_handle, &input))
            .await
            .map_err(|e| format!("Thumbnail check panicked: {e}"))?
    };
    let video_streams = match blocker {
        Ok(n) => n,
        Err(reason) => {
            let _ = app_handle.emit("video-thumbnail-updated", input_path);
            return Ok(format!("app-only:{reason}"));
        }
    };

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_string();
    let tmp_output = input.with_extension(format!("thumbtmp.{ext}"));

    if let Err(err) = embed_cover_art(ffmpeg_path, input, cache_path, &tmp_output, video_streams).await {
        let _ = std::fs::remove_file(&tmp_output);
        return Err(err);
    }

    // Windows won't let this rename succeed while another process (most likely this same video,
    // still open in the player that triggered this) holds the original file open - surfaced as a
    // clear, actionable error rather than a raw OS error code, with the half-written temp file
    // cleaned up either way so a retry doesn't trip over it.
    if let Err(e) = std::fs::rename(&tmp_output, input) {
        let _ = std::fs::remove_file(&tmp_output);
        return Err(format!(
            "Saved the thumbnail in Briefcast, but couldn't update the video file itself - it may still be open in the player. Try again in a moment. ({e})"
        ));
    }

    let _ = app_handle.emit("video-thumbnail-updated", input_path);
    Ok("embedded".to_string())
}

// mjpeg-encodes only the newly-added cover-image stream (map 1); -c copy on both mapped streams
// together would otherwise apply to it too, and ffmpeg can't stream-copy a jpg into a video-track
// slot. attached_pic is the disposition flag that tells MP4/MOV/MKV muxers (and, in turn, Explorer
// and any app that reads embedded cover art) "this stream is a poster image, not a played track."
pub(super) async fn embed_cover_art(
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    cover: &PathBuf,
    output: &PathBuf,
    video_streams: usize,
) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let input = input.clone();
    let cover = cover.clone();
    let output = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y");
        cmd.arg("-i").arg(path_to_str(&input)?);
        cmd.arg("-i").arg(path_to_str(&cover)?);
        cmd.args([
            // Video first (0:V is video WITHOUT attached pictures - an old cover is dropped, or it
            // would take the new one's place), then audio/subtitles, then the new cover.
            "-map", "0:V", "-map", "0:a?", "-map", "0:s?", "-map", "1", "-map_metadata", "0",
            "-c", "copy",
        ]);
        // The cover is the video stream right after the real ones.
        let cover_stream = format!("v:{video_streams}");
        cmd.args([format!("-c:{cover_stream}"), "mjpeg".to_string(), format!("-disposition:{cover_stream}"), "attached_pic".to_string()]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let result = cmd
            .output()
            .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let tail: Vec<&str> = stderr
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .rev()
                .take(4)
                .collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "Failed to embed thumbnail into the video file: {}",
                if reason.is_empty() { "unknown ffmpeg error".to_string() } else { reason }
            ));
        }
        if !output.exists() {
            return Err("ffmpeg exited successfully but produced no output file".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Thumbnail embed task panicked: {e}"))?
}

// -ss before -i is ffmpeg's fast (keyframe-seeking, not frame-accurate) seek - plenty precise for
// a thumbnail and far quicker than decoding from the start, which matters here since this runs
// once per video in a folder that can hold hundreds of them (bounded by the same shared
// thumbnailLimiter the frontend routes every gallery/sidebar thumbnail request through).
pub(super) async fn extract_video_frame(
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    output: &PathBuf,
    seek: &str,
    max_width: u32,
) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let input = input.clone();
    let output = output.clone();
    let seek = seek.to_string();
    let scale = format!("scale='min({max_width},iw)':-2");
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.args(["-y", "-ss", &seek]);
        cmd.arg("-i").arg(path_to_str(&input)?);
        cmd.args([
            "-frames:v",
            "1",
            "-update",
            "1",
            "-vf",
            &scale,
            "-q:v",
            "4",
        ]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let result = cmd
            .output()
            .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            // ffmpeg's stderr always opens with its full version/build-config banner before
            // anything about THIS run - keeping only the last few non-empty lines is what
            // actually explains the failure (e.g. "Invalid data found when processing input"),
            // instead of a wall of --enable-* flags every single error gets buried under.
            let tail: Vec<&str> = stderr
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .rev()
                .take(3)
                .collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "ffmpeg frame extraction failed: {}",
                if reason.is_empty() {
                    "unknown error".to_string()
                } else {
                    reason
                }
            ));
        }
        if !output.exists() {
            return Err("ffmpeg exited successfully but produced no output file".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Video thumbnail task panicked: {e}"))?
}

// Fixed per-tile size for the scrub-bar hover-preview sprite sheet (see get_video_scrub_sprite) -
// matches the 16:9 aspect ratio the frontend's hover-preview box (.preview-img-wrap in player.css)
// already renders at, just at a real decode resolution instead of a CSS box size.
pub(super) const SCRUB_SPRITE_TILE_WIDTH: u32 = 160;
pub(super) const SCRUB_SPRITE_TILE_HEIGHT: u32 = 90;
// Aim for one tile roughly every 5s of footage - granular enough that scrubbing feels responsive
// - but keep the grid bounded on both ends: a very short clip still gets a useful number of
// tiles (MIN), and a very long recording can't force ffmpeg to decode+encode an enormous sprite
// or the frontend to size an oversized <img> (MAX).
pub(super) const SCRUB_SPRITE_TARGET_INTERVAL_SECS: f64 = 5.0;
pub(super) const SCRUB_SPRITE_MIN_TILES: u32 = 10;
pub(super) const SCRUB_SPRITE_MAX_TILES: u32 = 100;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrubSprite {
    pub sprite_path: String,
    pub columns: u32,
    pub rows: u32,
    pub tile_width: u32,
    pub tile_height: u32,
    pub count: u32,
    // Seconds of footage each tile represents - the frontend divides a hover position's time by
    // this to pick which tile to show.
    pub interval: f64,
}

// Pre-generated, cached hover-preview sprite for the scrub bar - one ffmpeg call builds a single
// grid image of downsampled frames spanning the whole video, so hovering the timeline afterwards
// is an instant CSS crop (VideoPlayer.tsx's handleTimelineHover) rather than a per-hover decode.
// Cached the same content-addressed way get_video_thumbnail is (path+mtime, see
// preview_cache_path), alongside a small JSON sidecar recording the grid layout that produced it -
// needed because that layout depends on this specific video's duration and has to be reproduced
// exactly on a cache hit for the frontend's tile math to stay correct, and re-probing duration
// on every hit just to recompute it would be wasted work the sidecar avoids entirely.
#[tauri::command]
pub async fn get_video_scrub_sprite(
    app_handle: AppHandle,
    input_path: String,
) -> Result<ScrubSprite, String> {
    let input = PathBuf::from(&input_path);
    let sprite_cache_path = preview_cache_path(&input, "scrub_sprite_v1", "jpg")?;
    let meta_cache_path = preview_cache_path(&input, "scrub_sprite_v1", "json")?;

    if sprite_cache_path.exists() {
        if let Ok(bytes) = std::fs::read(&meta_cache_path) {
            if let Ok(cached) = serde_json::from_slice::<ScrubSprite>(&bytes) {
                return Ok(ScrubSprite {
                    sprite_path: path_to_str(&sprite_cache_path)?.to_string(),
                    ..cached
                });
            }
        }
        // Sprite image exists but its metadata sidecar is missing/unreadable - fall through and
        // regenerate both together rather than risk the frontend slicing tiles with a guessed
        // layout that doesn't match what's actually in the cached image.
    }

    if let Some(parent) = sprite_cache_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create scrub-sprite cache directory: {}", e))?;
    }

    let ffprobe_path = get_ffprobe_path(&app_handle)?;
    let duration = {
        let ffprobe_path = ffprobe_path.clone();
        let input = input.clone();
        blocking(move || probe_duration_secs(&ffprobe_path, &input)).await??
    };
    if duration <= 0.0 {
        return Err("Video has no measurable duration".to_string());
    }

    let target = ((duration / SCRUB_SPRITE_TARGET_INTERVAL_SECS).round() as u32)
        .clamp(SCRUB_SPRITE_MIN_TILES, SCRUB_SPRITE_MAX_TILES)
        .min((duration.floor() as u32).max(1));
    let columns = (target as f64).sqrt().ceil() as u32;
    let rows = ((target as f64) / (columns as f64)).ceil() as u32;
    // The tile filter below always consumes exactly columns*rows input frames to emit its one
    // output grid - using that (rather than `target`) as the authoritative count keeps this
    // metadata truthful even though it can be a few tiles more than `target` asked for (the last
    // couple of cells then just repeat the final frame, an imperceptible edge case for a hover
    // preview).
    let count = columns * rows;
    let interval = duration / count as f64;

    let ffmpeg_path = get_ffmpeg_path(&app_handle)?;
    generate_scrub_sprite(&ffmpeg_path, &input, &sprite_cache_path, interval, columns, rows).await?;

    let sprite = ScrubSprite {
        sprite_path: path_to_str(&sprite_cache_path)?.to_string(),
        columns,
        rows,
        tile_width: SCRUB_SPRITE_TILE_WIDTH,
        tile_height: SCRUB_SPRITE_TILE_HEIGHT,
        count,
        interval,
    };
    std::fs::write(
        &meta_cache_path,
        serde_json::to_vec(&sprite).map_err(|e| format!("Failed to serialize scrub-sprite metadata: {}", e))?,
    )
    .map_err(|e| format!("Failed to write scrub-sprite metadata: {}", e))?;

    Ok(sprite)
}

pub(super) fn probe_duration_secs(ffprobe_path: &PathBuf, input: &PathBuf) -> Result<f64, String> {
    let mut cmd = Command::new(ffprobe_path);
    cmd.args([
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        path_to_str(input)?,
    ]);
    #[cfg(windows)]
    hide_console_window(&mut cmd);
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;
    let probe: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {}", e))?;
    probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .ok_or_else(|| "ffprobe returned no duration for this file".to_string())
}

// Single ffmpeg call: samples one frame every `interval` seconds (fps=1/interval), downsizes each
// to the fixed tile size, then tiles them into one columns x rows grid image - see
// get_video_scrub_sprite's own doc comment for why a sprite sheet instead of per-tile files.
pub(super) async fn generate_scrub_sprite(
    ffmpeg_path: &PathBuf,
    input: &PathBuf,
    output: &PathBuf,
    interval: f64,
    columns: u32,
    rows: u32,
) -> Result<(), String> {
    let ffmpeg_path = ffmpeg_path.clone();
    let input = input.clone();
    let output = output.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new(&ffmpeg_path);
        #[cfg(windows)]
        hide_console_window(&mut cmd);
        cmd.arg("-y");
        // Decode keyframes only once tiles are far enough apart for keyframe spacing not to show
        // (recordings carry one every 1-2s). Otherwise every frame of the file is decoded on the
        // CPU just to keep a few dozen - measured 18s of CPU against 0.6s for a 15s 4K60
        // recording, and it scales with length, right when the user opens a fresh recording.
        if interval >= 2.0 {
            cmd.args(["-skip_frame", "nokey"]);
        }
        cmd.arg("-i").arg(path_to_str(&input)?);
        cmd.args([
            "-frames:v",
            "1",
            "-update",
            "1",
            "-vf",
            &format!(
                "fps=1/{interval},scale={tw}:{th},tile={cols}x{rows}",
                interval = interval,
                tw = SCRUB_SPRITE_TILE_WIDTH,
                th = SCRUB_SPRITE_TILE_HEIGHT,
                cols = columns,
                rows = rows
            ),
            "-q:v",
            "4",
        ]);
        cmd.arg(path_to_str(&output)?);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let result = cmd
            .output()
            .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;
        if !result.status.success() {
            let stderr = String::from_utf8_lossy(&result.stderr);
            let tail: Vec<&str> = stderr
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .rev()
                .take(3)
                .collect();
            let reason: String = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
            return Err(format!(
                "ffmpeg scrub-sprite generation failed: {}",
                if reason.is_empty() {
                    "unknown error".to_string()
                } else {
                    reason
                }
            ));
        }
        if !output.exists() {
            return Err("ffmpeg exited successfully but produced no scrub-sprite file".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Scrub-sprite task panicked: {e}"))?
}
