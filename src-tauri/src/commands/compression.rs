// compression.rs
//
// File compression commands for video, image, audio, and general files (zip).
// Separated from conversion.rs for modularity, clean maintenance, and focused testing.

use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State, Window};

use super::conversion::{
    run_conversion_low_priority, unique_output_path, ConversionProgress, ConversionState, ConversionStatus, InputSpec,
};

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompressionResult {
    pub output_path: String,
    pub new_file_name: String,
    pub original_size: u64,
    pub compressed_size: u64,
}

#[tauri::command]
pub async fn compress_video(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    quality: Option<String>,
    resolution: Option<String>,
    output_format: Option<String>,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let ext = output_format.as_deref().unwrap_or_else(|| {
        input.extension().and_then(|e| e.to_str()).unwrap_or("mp4")
    });

    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => {
            let parent = input.parent().map(PathBuf::from).unwrap_or_default();
            let stem = input.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            parent.join(format!("{}_compressed.{}", stem, ext))
        }
    };

    let q = quality.as_deref().unwrap_or("balanced");
    let (crf, preset, audio_bitrate) = match q {
        "high" => ("32", "faster", "96k"),
        "light" => ("23", "medium", "160k"),
        _ => ("28", "faster", "128k"),
    };

    let mut codec_args: Vec<String> = vec![
        "-c:v".into(), "libx264".into(),
        "-preset".into(), preset.into(),
        "-crf".into(), crf.into(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-c:a".into(), "aac".into(),
        "-b:a".into(), audio_bitrate.into(),
        "-movflags".into(), "+faststart".into(),
    ];

    if let Some(res) = resolution.as_deref() {
        match res {
            "1080p" => codec_args.extend(["-vf".into(), "scale='min(1920,iw)':-2".into()]),
            "720p" => codec_args.extend(["-vf".into(), "scale='min(1280,iw)':-2".into()]),
            "480p" => codec_args.extend(["-vf".into(), "scale='min(854,iw)':-2".into()]),
            _ => {}
        }
    }

    let codec_refs: Vec<&str> = codec_args.iter().map(|s| s.as_str()).collect();

    let result = run_conversion_low_priority(
        &app_handle,
        &window,
        &state,
        &[InputSpec::plain(input_path.clone())],
        &input_path,
        output,
        &codec_refs,
    )
    .await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}

#[tauri::command]
pub async fn compress_image(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    quality: Option<String>,
    max_dimension: Option<u32>,
    output_format: Option<String>,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let input_ext = input
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "jpg".to_string());

    let target_format = output_format
        .map(|f| f.to_lowercase())
        .unwrap_or_else(|| {
            if matches!(input_ext.as_str(), "heic" | "heif") {
                "jpg".to_string()
            } else {
                input_ext.clone()
            }
        });

    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => {
            let parent = input.parent().map(PathBuf::from).unwrap_or_default();
            let stem = input.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            parent.join(format!("{}_compressed.{}", stem, target_format))
        }
    };

    let q = quality.as_deref().unwrap_or("balanced");

    #[cfg(windows)]
    if matches!(input_ext.as_str(), "heic" | "heif") {
        return super::conversion::convert_heic_windows(
            &app_handle,
            &window,
            &state,
            &input,
            output,
            &target_format,
            preserve_original,
        )
        .await;
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if matches!(input_ext.as_str(), "heic" | "heif") {
        return super::conversion::convert_heic_unix(
            &app_handle,
            &window,
            &state,
            &input,
            output,
            &target_format,
            preserve_original,
        )
        .await;
    }

    let mut codec_args: Vec<String> = Vec::new();

    match target_format.as_str() {
        "jpg" | "jpeg" => {
            let q_val = match q {
                "high" => "10",
                "light" => "2",
                _ => "5",
            };
            codec_args.extend(["-q:v".into(), q_val.into()]);
        }
        "webp" => {
            let q_val = match q {
                "high" => "50",
                "light" => "88",
                _ => "75",
            };
            codec_args.extend(["-c:v".into(), "libwebp".into(), "-quality".into(), q_val.into()]);
        }
        "png" => {
            codec_args.extend(["-compression_level".into(), "9".into(), "-pred".into(), "mixed".into()]);
        }
        _ => {}
    }

    if let Some(dim) = max_dimension {
        if dim > 0 {
            codec_args.extend(["-vf".into(), format!("scale='min({},iw)':-1", dim)]);
        }
    }

    let codec_refs: Vec<&str> = codec_args.iter().map(|s| s.as_str()).collect();

    let result = run_conversion_low_priority(
        &app_handle,
        &window,
        &state,
        &[InputSpec::plain(input_path.clone())],
        &input_path,
        output,
        &codec_refs,
    )
    .await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}

#[tauri::command]
pub async fn compress_audio(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    quality: Option<String>,
    output_format: Option<String>,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let ext = output_format.as_deref().unwrap_or_else(|| {
        input.extension().and_then(|e| e.to_str()).unwrap_or("mp3")
    });

    let output = match output_path {
        Some(path) => PathBuf::from(path),
        None => {
            let parent = input.parent().map(PathBuf::from).unwrap_or_default();
            let stem = input.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            parent.join(format!("{}_compressed.{}", stem, ext))
        }
    };

    let q = quality.as_deref().unwrap_or("balanced");
    let mut codec_args: Vec<String> = vec!["-vn".into()];

    match ext.to_lowercase().as_str() {
        "mp3" => {
            let (br, ac) = match q {
                "high" => ("64k", Some("1")),
                "light" => ("192k", None),
                _ => ("128k", None),
            };
            codec_args.extend(["-c:a".into(), "libmp3lame".into(), "-b:a".into(), br.into()]);
            if let Some(c) = ac {
                codec_args.extend(["-ac".into(), c.into()]);
            }
        }
        "aac" | "m4a" => {
            let br = match q {
                "high" => "64k",
                "light" => "192k",
                _ => "128k",
            };
            codec_args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), br.into()]);
        }
        "ogg" => {
            let q_scale = match q {
                "high" => "2",
                "light" => "6",
                _ => "4",
            };
            codec_args.extend(["-c:a".into(), "libvorbis".into(), "-q:a".into(), q_scale.into()]);
        }
        _ => {
            codec_args.extend(["-c:a".into(), "libmp3lame".into(), "-b:a".into(), "128k".into()]);
        }
    }

    let codec_refs: Vec<&str> = codec_args.iter().map(|s| s.as_str()).collect();

    let result = run_conversion_low_priority(
        &app_handle,
        &window,
        &state,
        &[InputSpec::plain(input_path.clone())],
        &input_path,
        output,
        &codec_refs,
    )
    .await?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    Ok(result)
}

#[tauri::command]
pub async fn compress_to_zip(
    window: Window,
    input_paths: Vec<String>,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<String, String> {
    if input_paths.is_empty() {
        return Err("No input files provided".to_string());
    }

    let first = PathBuf::from(&input_paths[0]);
    let default_output = match output_path {
        Some(p) => PathBuf::from(p),
        None => {
            let parent = first.parent().map(PathBuf::from).unwrap_or_default();
            if input_paths.len() == 1 {
                let stem = first.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "archive".to_string());
                parent.join(format!("{}_compressed.zip", stem))
            } else {
                parent.join("archive.zip")
            }
        }
    };

    let target_output = unique_output_path(default_output);

    let _ = window.emit(
        "conversion-progress",
        ConversionProgress {
            input_path: input_paths[0].clone(),
            output_path: target_output.to_string_lossy().to_string(),
            progress: 10.0,
            status: ConversionStatus::Starting,
            message: "Creating zip archive...".to_string(),
        },
    );

    let file = std::fs::File::create(&target_output).map_err(|e| format!("Failed to create zip file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let total = input_paths.len();
    for (i, p_str) in input_paths.iter().enumerate() {
        let p = PathBuf::from(p_str);
        if !p.exists() || !p.is_file() {
            continue;
        }
        let file_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("file");
        zip.start_file(file_name, options).map_err(|e| format!("Zip error: {}", e))?;
        let mut f = std::fs::File::open(&p).map_err(|e| format!("Failed to open file {}: {}", p_str, e))?;
        std::io::copy(&mut f, &mut zip).map_err(|e| format!("Failed to write to zip: {}", e))?;

        let pct = ((i + 1) as f64 / total as f64) * 85.0 + 10.0;
        let _ = window.emit(
            "conversion-progress",
            ConversionProgress {
                input_path: p_str.clone(),
                output_path: target_output.to_string_lossy().to_string(),
                progress: pct,
                status: ConversionStatus::Processing,
                message: format!("Compressed {}/{} files", i + 1, total),
            },
        );
    }

    zip.finish().map_err(|e| format!("Failed to finalize zip: {}", e))?;

    if !preserve_original {
        for p_str in &input_paths {
            let _ = std::fs::remove_file(p_str);
        }
    }

    let _ = window.emit(
        "conversion-progress",
        ConversionProgress {
            input_path: input_paths[0].clone(),
            output_path: target_output.to_string_lossy().to_string(),
            progress: 100.0,
            status: ConversionStatus::Completed,
            message: "Archive created successfully".to_string(),
        },
    );

    Ok(target_output.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn compress_file(
    app_handle: AppHandle,
    window: Window,
    state: State<'_, ConversionState>,
    input_path: String,
    quality: Option<String>,
    resolution: Option<String>,
    max_dimension: Option<u32>,
    output_format: Option<String>,
    output_path: Option<String>,
    preserve_original: bool,
) -> Result<CompressionResult, String> {
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let original_size = std::fs::metadata(&input)
        .map(|m| m.len())
        .unwrap_or(0);

    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let is_video = matches!(ext.as_str(), "mp4" | "mov" | "avi" | "mkv" | "webm" | "wmv" | "flv");
    let is_audio = matches!(ext.as_str(), "mp3" | "wav" | "aac" | "flac" | "ogg" | "m4a");
    let is_image = matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tiff" | "heic" | "heif");

    let result_path = if is_video {
        compress_video(
            app_handle,
            window,
            state,
            input_path.clone(),
            quality,
            resolution,
            output_format,
            output_path,
            preserve_original,
        )
        .await?
    } else if is_audio {
        compress_audio(
            app_handle,
            window,
            state,
            input_path.clone(),
            quality,
            output_format,
            output_path,
            preserve_original,
        )
        .await?
    } else if is_image {
        compress_image(
            app_handle,
            window,
            state,
            input_path.clone(),
            quality,
            max_dimension,
            output_format,
            output_path,
            preserve_original,
        )
        .await?
    } else {
        compress_to_zip(
            window,
            vec![input_path.clone()],
            output_path,
            preserve_original,
        )
        .await?
    };

    let compressed_size = std::fs::metadata(&result_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let new_file_name = PathBuf::from(&result_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(CompressionResult {
        output_path: result_path,
        new_file_name,
        original_size,
        compressed_size,
    })
}


#[tauri::command]
pub async fn save_compressed_blob(
    input_path: String,
    bytes: Vec<u8>,
    output_ext: String,
    preserve_original: bool,
) -> Result<CompressionResult, String> {
    let input = PathBuf::from(&input_path);
    if !input.exists() {
        return Err(format!("Input file does not exist: {}", input_path));
    }

    let original_size = std::fs::metadata(&input)
        .map(|m| m.len())
        .unwrap_or(0);

    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let parent = input.parent().map(PathBuf::from).unwrap_or_default();
    let ext = output_ext.trim_start_matches('.');
    let target = parent.join(format!("{}_compressed.{}", stem, ext));
    let output = unique_output_path(target);

    std::fs::write(&output, &bytes)
        .map_err(|e| format!("Failed to save compressed file: {}", e))?;

    if !preserve_original {
        let _ = std::fs::remove_file(&input);
    }

    let compressed_size = bytes.len() as u64;
    let new_file_name = output
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    Ok(CompressionResult {
        output_path: output.to_string_lossy().to_string(),
        new_file_name,
        original_size,
        compressed_size,
    })
}
