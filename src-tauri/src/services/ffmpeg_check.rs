// services/ffmpeg_check.rs
//
// Is the ffmpeg Briefcast will use good enough? Windows ships its own (binaries/ffmpeg, a recent
// full build), but macOS and Linux use whatever the system has, and that can be too old: Ubuntu
// 22.04's ffmpeg is 4.4, while the app relies on `-fps_mode` (ffmpeg 5.1+) for the phone-camera
// finish step, editor conversions and recording assembly. Without this check those failed at the
// moment of use, with ffmpeg's "Unrecognized option" - nothing a user could act on.
//
// Checked once in the background at startup and cached; the frontend asks for the result and shows
// what to do. Never blocks startup and never refuses to run: a check that can't tell (an unusual
// build string) gives the benefit of the doubt.

use serde::Serialize;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::AppHandle;

/// `-fps_mode` arrived in ffmpeg 5.1.
pub const MIN_VERSION: (u32, u32) = (5, 1);
/// Encoders every recording needs: H.264 video and AAC audio (codec_args_for_ext).
pub const REQUIRED_ENCODERS: [(&str, &str); 2] = [("libx264", "H.264 video"), ("aac", "AAC audio")];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub ok: bool,
    pub path: Option<String>,
    /// What ffmpeg reports itself as, e.g. "4.4.2-0ubuntu0.22.04.1".
    pub version: Option<String>,
    /// Plain sentences, one per problem.
    pub problems: Vec<String>,
    /// How to fix it on this platform; None when there is nothing to fix.
    pub fix: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Version {
    Release(u32, u32),
    /// A build from git (`N-118000-g...`, `2024-10-13-git-...`): no release number to compare, and
    /// such builds are newer than any release they came after.
    Snapshot,
    Unknown,
}

/// The version from `ffmpeg -version`'s first line: "ffmpeg version 4.4.2-0ubuntu0.22.04.1 ...",
/// "ffmpeg version n7.1 ...", "ffmpeg version 9.0-full_build-www.gyan.dev ...".
pub fn parse_version(banner: &str) -> (Version, Option<String>) {
    let Some(token) = banner.lines().next().and_then(|l| l.split_whitespace().nth(2)) else {
        return (Version::Unknown, None);
    };
    let raw = token.to_string();
    if token.starts_with("N-") || token.contains("-git-") || token.starts_with("git-") {
        return (Version::Snapshot, Some(raw));
    }
    let numeric = token.trim_start_matches('n');
    let mut parts = numeric.split(|c: char| !c.is_ascii_digit());
    let major = parts.next().and_then(|p| p.parse::<u32>().ok());
    let minor = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    match major {
        Some(major) => (Version::Release(major, minor), Some(raw)),
        None => (Version::Unknown, Some(raw)),
    }
}

/// Encoder names from `ffmpeg -hide_banner -encoders` (rows like " V....D libx264  ...").
fn encoder_names(listing: &str) -> Vec<&str> {
    listing
        .lines()
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let flags = cols.next()?;
            let name = cols.next()?;
            // Rows start with a six-character flag field (V/A/S then dots or letters); the legend
            // rows above the list ("V..... = Video") have the same shape, with "=" for a name.
            (flags.len() == 6 && matches!(flags.chars().next(), Some('V' | 'A' | 'S')) && name != "=")
                .then_some(name)
        })
        .collect()
}

fn fix_hint() -> &'static str {
    if cfg!(target_os = "windows") {
        "Briefcast ships its own ffmpeg on Windows - reinstall Briefcast to restore it."
    } else if cfg!(target_os = "macos") {
        "Install or update it with `brew install ffmpeg` (or `brew upgrade ffmpeg`), then switch back to Briefcast - it checks again by itself."
    } else {
        "Install ffmpeg 5.1 or newer from your distribution - Ubuntu 22.04's is 4.4, too old; Ubuntu 24.04 and Debian 12 or newer are fine - or put a newer ffmpeg first on your PATH, then switch back to Briefcast - it checks again by itself."
    }
}

/// The decision, from what ffmpeg printed. Pure, so every case is testable without ffmpeg.
pub fn evaluate(path: Option<&Path>, banner: Option<&str>, encoders: Option<&str>) -> FfmpegStatus {
    let Some(path) = path else {
        return FfmpegStatus {
            ok: false,
            path: None,
            version: None,
            problems: vec!["ffmpeg was not found, so Briefcast can't record or export.".into()],
            fix: Some(fix_hint().into()),
        };
    };
    let mut problems = Vec::new();
    let (version, raw) = banner.map(parse_version).unwrap_or((Version::Unknown, None));
    match (banner, version) {
        (None, _) => problems.push("ffmpeg is there but would not run.".to_string()),
        (_, Version::Release(major, minor)) if (major, minor) < MIN_VERSION => problems.push(format!(
            "Your ffmpeg is version {major}.{minor}; Briefcast needs {}.{} or newer.",
            MIN_VERSION.0, MIN_VERSION.1
        )),
        // A newer release, a snapshot, or a build string we don't recognise: give it the benefit of
        // the doubt rather than refuse a working ffmpeg.
        _ => {}
    }
    if let Some(listing) = encoders {
        let have = encoder_names(listing);
        let missing: Vec<&str> =
            REQUIRED_ENCODERS.iter().filter(|(name, _)| !have.contains(name)).map(|(_, what)| *what).collect();
        if !missing.is_empty() {
            problems.push(format!("Your ffmpeg was built without {} encoding.", missing.join(" or ")));
        }
    }
    FfmpegStatus {
        ok: problems.is_empty(),
        path: Some(path.display().to_string()),
        version: raw,
        fix: (!problems.is_empty()).then(|| fix_hint().to_string()),
        problems,
    }
}

fn run(ffmpeg: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    crate::commands::recording::hide_console_window(&mut cmd);
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Runs ffmpeg twice (version, encoders). Blocking - call off the async runtime.
pub fn check_blocking(app: &AppHandle) -> FfmpegStatus {
    let path = crate::services::utility::get_ffmpeg_path(app).ok();
    let banner = path.as_deref().and_then(|p| run(p, &["-hide_banner", "-version"]));
    // -hide_banner on -version drops the copyright line only on some builds; ask plainly as well.
    let banner = banner.or_else(|| path.as_deref().and_then(|p| run(p, &["-version"])));
    let encoders = path.as_deref().and_then(|p| run(p, &["-hide_banner", "-encoders"]));
    let status = evaluate(path.as_deref(), banner.as_deref(), encoders.as_deref());
    if status.ok {
        log::info!("ffmpeg ok: {} ({})", status.version.as_deref().unwrap_or("?"), status.path.as_deref().unwrap_or("?"));
    } else {
        log::warn!("ffmpeg not usable: {:?}", status.problems);
    }
    status
}

static CACHE: Mutex<Option<FfmpegStatus>> = Mutex::new(None);

/// At startup, on its own thread, so the answer is ready before anything asks.
pub fn warm(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let status = check_blocking(&app);
        *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some(status);
    });
}

/// The cached result; `recheck` runs it again - the page does that when its window comes back after
/// a failed check, the usual moment after installing a newer ffmpeg.
#[tauri::command]
pub async fn ffmpeg_status(app: AppHandle, recheck: Option<bool>) -> Result<FfmpegStatus, String> {
    if !recheck.unwrap_or(false) {
        if let Some(cached) = CACHE.lock().unwrap_or_else(|p| p.into_inner()).clone() {
            return Ok(cached);
        }
    }
    let status = crate::services::responsiveness::blocking(move || check_blocking(&app)).await?;
    *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some(status.clone());
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ENCODERS: &str = "Encoders:\n V..... = Video\n ------\n V....D libx264              libx264 H.264 / AVC\n A....D aac                  AAC (Advanced Audio Coding)\n A....D libmp3lame           libmp3lame MP3\n";

    fn path() -> PathBuf {
        PathBuf::from("/usr/bin/ffmpeg")
    }

    #[test]
    fn reads_the_version_from_real_banners() {
        let v = |s: &str| parse_version(s).0;
        assert_eq!(v("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021"), Version::Release(4, 4));
        assert_eq!(v("ffmpeg version n7.1 Copyright (c) 2000-2024"), Version::Release(7, 1));
        assert_eq!(v("ffmpeg version 7.1.1 Copyright"), Version::Release(7, 1));
        assert_eq!(v("ffmpeg version 9.0-full_build-www.gyan.dev Copyright"), Version::Release(9, 0));
        assert_eq!(v("ffmpeg version 5.1.6-0+deb12u1 Copyright"), Version::Release(5, 1));
        assert_eq!(v("ffmpeg version N-118000-g1234abcd Copyright"), Version::Snapshot);
        assert_eq!(v("ffmpeg version 2024-10-13-git-e347b4ff31-full_build-www.gyan.dev"), Version::Snapshot);
        assert_eq!(v("something else entirely"), Version::Unknown);
        assert_eq!(v(""), Version::Unknown);
    }

    #[test]
    fn ubuntu_22_04_ffmpeg_is_too_old_and_says_how_to_fix_it() {
        let s = evaluate(Some(&path()), Some("ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright"), Some(ENCODERS));
        assert!(!s.ok);
        assert_eq!(s.version.as_deref(), Some("4.4.2-0ubuntu0.22.04.1"));
        assert!(s.problems[0].contains("4.4") && s.problems[0].contains("5.1"), "{:?}", s.problems);
        assert!(s.fix.is_some());
    }

    #[test]
    fn a_current_ffmpeg_with_the_encoders_is_fine() {
        for banner in ["ffmpeg version 5.1.6-0+deb12u1", "ffmpeg version 6.1.1-3ubuntu5", "ffmpeg version 9.0-full_build"] {
            let s = evaluate(Some(&path()), Some(banner), Some(ENCODERS));
            assert!(s.ok, "{banner}: {:?}", s.problems);
            assert!(s.problems.is_empty() && s.fix.is_none());
        }
    }

    #[test]
    fn snapshots_and_unrecognised_builds_get_the_benefit_of_the_doubt() {
        assert!(evaluate(Some(&path()), Some("ffmpeg version N-118000-gabc"), Some(ENCODERS)).ok);
        assert!(evaluate(Some(&path()), Some("ffmpeg version custom-build"), Some(ENCODERS)).ok);
    }

    #[test]
    fn a_build_without_x264_or_aac_is_reported() {
        let only_aac = "Encoders:\n A....D aac                  AAC\n";
        let s = evaluate(Some(&path()), Some("ffmpeg version 7.1"), Some(only_aac));
        assert!(!s.ok);
        assert!(s.problems[0].contains("H.264"), "{:?}", s.problems);
        let neither = "Encoders:\n V....D mpeg4                MPEG-4\n";
        let s = evaluate(Some(&path()), Some("ffmpeg version 7.1"), Some(neither));
        assert!(s.problems[0].contains("H.264 video or AAC audio"), "{:?}", s.problems);
    }

    #[test]
    fn missing_or_broken_ffmpeg_is_reported() {
        let s = evaluate(None, None, None);
        assert!(!s.ok && s.problems[0].contains("not found") && s.fix.is_some());
        let s = evaluate(Some(&path()), None, None);
        assert!(!s.ok && s.problems[0].contains("would not run"));
    }

    // The real thing, by hand: `cargo test --lib real_ffmpeg_on_this_machine -- --ignored --nocapture`.
    // Ignored because the right answer depends on the machine; it prints the verdict instead.
    #[test]
    #[ignore]
    fn real_ffmpeg_on_this_machine() {
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/ffmpeg/ffmpeg.exe");
        let ffmpeg = if cfg!(windows) && bundled.is_file() {
            Some(bundled)
        } else {
            crate::services::utility::find_on_path("ffmpeg")
        };
        let banner = ffmpeg.as_deref().and_then(|p| run(p, &["-version"]));
        let encoders = ffmpeg.as_deref().and_then(|p| run(p, &["-hide_banner", "-encoders"]));
        let status = evaluate(ffmpeg.as_deref(), banner.as_deref(), encoders.as_deref());
        println!("{status:#?}");
    }

    #[test]
    fn encoder_names_ignore_headers_and_legend_rows() {
        assert_eq!(encoder_names(ENCODERS), vec!["libx264", "aac", "libmp3lame"]);
    }
}
