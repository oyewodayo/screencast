// services/heic_windows.rs
//
// Decodes HEIC/HEIF photos via WIC/WinRT (Windows.Graphics.Imaging) instead of ffmpeg.
//
// Why this exists: commands/conversion.rs's convert_image just shells out to ffmpeg for every
// image format, which works fine for plain HEIC files. But modern iPhone photos (Portrait mode,
// Deep Fusion, anything with depth/gain-map data) store several embedded images in one HEIC
// container - the real photo plus auxiliary grayscale depth maps, at multiple resolutions. The
// ffmpeg build bundled with the app (binaries/ffmpeg) picks the wrong embedded image for these
// (a depth map, so the output is solid black) via its automatic stream selection, and even with
// explicit stream mapping its HEIF tile-grid reconstruction tops out at a fraction of the photo's
// real resolution - a real limitation of that ffmpeg build's HEIF support, not a flag to tune away.
//
// Windows' own HEIF codec (installed as part of the "HEIF Image Extensions" package - present by
// default on modern Windows 11 machines, and exactly what File Explorer's thumbnail/preview pane
// already uses for these files) gets this right: it knows which embedded image is the actual
// primary photo and decodes it at full resolution. GetSoftwareBitmapTransformedAsync with
// ExifOrientationMode::RespectExifOrientation also takes care of applying the photo's rotation
// metadata, which the raw decoded bitmap does not carry (iPhones commonly store portrait photos
// as landscape pixel data plus a rotation flag).
//
// Always decodes to PNG - the lossless intermediate every other format conversion (jpeg/webp/bmp)
// already goes through via ffmpeg in commands/conversion.rs, so this module only has to solve
// "get correct full-resolution pixels out of the HEIC file", not re-implement encoding for every
// target format WIC happens to support.
use std::path::Path;
use windows::core::{Interface, HSTRING};
use windows::Graphics::Imaging::{
    BitmapAlphaMode, BitmapDecoder, BitmapEncoder, BitmapPixelFormat, BitmapTransform,
    ColorManagementMode, ExifOrientationMode, IBitmapFrameWithSoftwareBitmap,
};
use windows::Storage::{CreationCollisionOption, FileAccessMode, StorageFile, StorageFolder};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

// Guarantees CoUninitialize runs even if a ? short-circuits out of decode_to_png_blocking early -
// this thread only ever does this one COM/WinRT job, but leaking apartment state on a threadpool
// thread would corrupt whatever the next task scheduled onto it tries to do with COM.
struct ComGuard;
impl Drop for ComGuard {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn decode_to_png_blocking(input_path: &Path, output_path: &Path) -> Result<(), String> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED)
            .ok()
            .map_err(|e| format!("Failed to initialize COM: {e}"))?;
    }
    let _com_guard = ComGuard;

    let input_str = input_path
        .to_str()
        .ok_or_else(|| "Input path is not valid UTF-8".to_string())?;
    let output_dir = output_path
        .parent()
        .ok_or_else(|| "Output path has no parent directory".to_string())?;
    let output_name = output_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Output path has no valid file name".to_string())?;

    let input_file = StorageFile::GetFileFromPathAsync(&HSTRING::from(input_str))
        .and_then(|op| op.get())
        .map_err(|e| format!("Failed to open HEIC file: {e}"))?;
    let input_stream = input_file
        .OpenAsync(FileAccessMode::Read)
        .and_then(|op| op.get())
        .map_err(|e| format!("Failed to read HEIC file: {e}"))?;
    let decoder = BitmapDecoder::CreateAsync(&input_stream)
        .and_then(|op| op.get())
        .map_err(|e| {
            format!(
                "Failed to decode HEIC file (the HEIF Image Extensions codec may not be installed): {e}"
            )
        })?;

    let frame: IBitmapFrameWithSoftwareBitmap = decoder
        .cast()
        .map_err(|e| format!("Failed to access decoded HEIC frame: {e}"))?;
    let transform =
        BitmapTransform::new().map_err(|e| format!("Failed to create bitmap transform: {e}"))?;
    // If this fails with something like "No suitable transform was found to encode or decode the
    // content" (0xC00D5212), it means the HEIF Image Extensions package (container/metadata - the
    // thing that let CreateAsync above succeed) is installed but the separate HEVC Video
    // Extensions package (the actual H.265 pixel decoder those photos are encoded with) is not.
    // commands/conversion.rs's caller falls back to ffmpeg's own bundled HEVC decoder when this
    // errors, so that gap doesn't turn into a hard failure for the user - it just means a lower-
    // resolution result for complex (Portrait mode / Deep Fusion) photos until they install it.
    let software_bitmap = frame
        .GetSoftwareBitmapTransformedAsync(
            BitmapPixelFormat::Bgra8,
            BitmapAlphaMode::Premultiplied,
            &transform,
            ExifOrientationMode::RespectExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )
        .and_then(|op| op.get())
        .map_err(|e| format!("Failed to render HEIC photo: {e}"))?;

    let out_folder = StorageFolder::GetFolderFromPathAsync(&HSTRING::from(
        output_dir
            .to_str()
            .ok_or_else(|| "Output directory is not valid UTF-8".to_string())?,
    ))
    .and_then(|op| op.get())
    .map_err(|e| format!("Failed to open output folder: {e}"))?;
    let out_file = out_folder
        .CreateFileAsync(
            &HSTRING::from(output_name),
            CreationCollisionOption::ReplaceExisting,
        )
        .and_then(|op| op.get())
        .map_err(|e| format!("Failed to create output file: {e}"))?;
    let out_stream = out_file
        .OpenAsync(FileAccessMode::ReadWrite)
        .and_then(|op| op.get())
        .map_err(|e| format!("Failed to open output file for writing: {e}"))?;

    let png_id =
        BitmapEncoder::PngEncoderId().map_err(|e| format!("Failed to resolve PNG encoder: {e}"))?;
    let encoder = BitmapEncoder::CreateAsync(png_id, &out_stream)
        .and_then(|op| op.get())
        .map_err(|e| format!("Failed to create PNG encoder: {e}"))?;
    encoder
        .SetSoftwareBitmap(&software_bitmap)
        .map_err(|e| format!("Failed to hand photo to PNG encoder: {e}"))?;
    encoder
        .FlushAsync()
        .and_then(|op| op.get())
        .map_err(|e| format!("Failed to write PNG output: {e}"))?;

    Ok(())
}

// Runs the COM/WinRT work on a dedicated blocking-pool thread - COM apartment state and the
// `.get()` blocking waits below don't belong on an async worker thread.
pub async fn decode_to_png(
    input_path: std::path::PathBuf,
    output_path: std::path::PathBuf,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || decode_to_png_blocking(&input_path, &output_path))
        .await
        .map_err(|e| format!("HEIC decode task panicked: {e}"))?
}
