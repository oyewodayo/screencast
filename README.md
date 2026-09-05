# Briefcast

Briefcast is a Windows desktop app for screen recording, media playback, PDF viewing
and markup, media format conversion, and file organization — all in one window. It's
built with [Tauri](https://tauri.app/) (Rust) and [React](https://react.dev/) +
TypeScript, and uses bundled [FFmpeg](https://ffmpeg.org/) binaries for capture,
transcoding, and probing.

## Features

### Recording

- **Recording modes** — screen, webcam, and microphone in any combination, plus a
  one-shot screenshot capture mode:

  | Mode  | Captures                  |
  |-------|----------------------------|
  | `sva` | Screen + webcam + audio    |
  | `sv`  | Screen + webcam            |
  | `sa`  | Screen + audio             |
  | `va`  | Webcam + audio             |
  | `s`   | Screen only                |
  | `v`   | Webcam only                |
  | `a`   | Audio only                 |
  | `c`   | Screenshot capture         |

- **System audio capture** — an optional "System audio" toggle on screen-capture
  modes (`sva`/`sa`/`s`) records whatever's playing through your speakers (e.g. a
  video open in another app) via native WASAPI loopback, and mixes it into the
  recording alongside the microphone track if one is also selected. This works on any
  Windows machine — it doesn't depend on a "Stereo Mix" device or any driver/virtual
  audio cable being installed.
- **Webcam overlay** — circle, rounded, or rectangular, positioned and sized to taste,
  with support for multiple cameras stacked outward from the chosen corner, when
  recording in a mode that combines screen and webcam.
- **Screen/monitor/window picker** — pick a specific monitor or window to record, with
  live thumbnail previews of open windows.
- **Recordings tuned for smooth playback** — screen capture is downscaled to a
  1080p ceiling and encoded with a bounded keyframe interval, so recordings play back
  smoothly instead of straining the built-in player's decoder (particularly relevant
  on high-resolution/scaled displays).
- **Floating recording overlay** — a small always-on-top window with a live timer and
  a Stop button, so you don't need to keep the main window in view while recording.

### Playback & conversion

- **Built-in player** — plays back video, audio, and image files, with volume,
  playback-speed, skip, fullscreen, picture-in-picture, and opacity controls.
- **Media conversion** — convert a recording (or any local file) between formats,
  matched to what it actually is: video (MP4/MOV/MKV/AVI/WebM), audio
  (MP3/WAV/AAC/FLAC/OGG/M4A), or image (PNG/JPEG/WebP/BMP) — individually or in
  batch, with a live progress bar. PDFs aren't offered a Convert option since there's
  nothing meaningful to transcode one to.

### PDF viewing & annotation

- **Markup toolbar** — pen, highlighter, text notes, and eraser, with full undo/redo,
  each tool remembering its own last-used color.
- **Page thumbnails and table of contents** — a toggleable sidebar shows either a
  scrollable grid of real page thumbnails or the PDF's own outline/bookmarks (when it
  has one), both clickable to jump straight to a page.
- **Zoom, two-page spreads, and a fullscreen presentation mode** that hides all chrome
  down to a single "exit" control — with trackpad pinch-to-zoom, direct two-finger
  touchscreen pinch-to-zoom, and scroll-past-the-edge page turning. Fullscreen pages
  are centered rather than pinned to the top, while still scrolling correctly when a
  page is taller than the viewport.
- Annotations are saved alongside the source PDF and reload automatically the next
  time you open it.

### File organization

- **File browser** — sidebar tabs for Video/Audio/Image/PDF, listing everything
  under your Briefcast recordings folder.
- **Folders** — create nested folders per file type, delete empty ones, and move
  files between folders either by dragging them onto a folder or via a "Move to"
  menu. Select multiple files at once (checkboxes) to move several files in one go.
- **Trash** — deleting a file soft-deletes it to a recoverable Trash view (restore or
  delete forever), with an optional auto-purge after a configurable number of days.
- **Rename** files inline from the sidebar.
- **Import** files from anywhere on disk into the Briefcast library via the sidebar's
  "Open file from anywhere" icon, or open one ad hoc without importing it.
- **Collapsible folders** — folder rows in the sidebar have a chevron to collapse/
  expand their contents, state remembered per folder for the session.
- **File tools docker** — select a file and toggle the wrench icon next to "new
  folder" to swap the bottom panel from recording controls to quick actions for that
  file: rename, convert, reveal in its folder, delete, and at-a-glance
  duration/resolution/size info.

### Non-destructive video editing

Video files get a full timeline docker instead of the simple file-tools panel — clips,
text, image, and audio overlays are stored as an ordered edit list next to the source
file and only baked into pixels/audio at export time, so nothing here ever touches the
original recording.

- **Timeline & clips** — a scrubbable, zoomable filmstrip of real thumbnails with a
  playhead synced to the actual player; split, trim, reorder, and delete clips; drag a
  file straight from the sidebar onto the timeline to insert it as a new clip.
- **Text overlays** — click-to-place captions with per-character rich formatting
  (color, bold, italic), a background with adjustable padding, drag to reposition,
  resize/rotate handles (with angle snapping and a numeric input), and a timeline lane
  chip to retime when it appears/disappears.
- **Image overlays** — place an image on the video, drag/resize (aspect-locked or
  free), rotate, flip horizontal/vertical, replace the source image in place, and crop
  via a dedicated crop panel.
- **Audio overlays** — add background music/voiceover tracks with a real waveform
  (decoded from the actual audio), trim-to-resize semantics, volume, fade in/out, and
  mute — mixed into the export alongside the video's own audio without auto-ducking
  either track.
- **Main video audio control** — mute or adjust the volume of the original video's own
  audio track, independent of the audio overlays and independent of the player's own
  local listening-volume slider.
- **Entry/exit animations** for text and image overlays.
- **Layering** — bring an overlay to front or send it to back when overlays stack.
- **Duplicate** — Ctrl+D, or right-click a text/image overlay for a context menu.
- **Arrow-key nudge** for fine-positioning a selected overlay.
- **Undo/redo** across the whole edit (clips, overlays, trims, and audio settings)
  via Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
- **Export** renders the full edit — trimmed/reordered clips, burned-in text and image
  overlays (with animations), and the mixed audio (video track + overlays, muted/
  volume-adjusted as configured) — to a single output file via FFmpeg.

### Customization

Settings (gear icon) is organized into sections — Appearance, Recording, Storage,
Annotation, Files, and PDF Annotator:

- **Appearance** — light/dark/system theme, and the home screen's background style
  (a subtle graph-paper-line backdrop, or plain).
- **Recording** — default recording type, output format, and file name prefix.
- **Storage** — relocate where Briefcast stores its files via a folder picker (with a
  reset-to-default option); the file list refreshes automatically after a move.
- **PDF Annotator** — starting tool, default zoom, pen/highlighter color, stroke width.
- **Files** — trash auto-purge retention.

## Keyboard shortcuts

| Context | Keys | Action |
|---|---|---|
| Global | `Ctrl+Shift+H` | Show/hide the floating recording overlay |
| Video editor (timeline) | `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Undo / redo |
| | `Ctrl+D` | Duplicate the selected text/image/audio overlay |
| | `Delete` / `Backspace` | Delete the selected clip or overlay |
| | `←` `→` `↑` `↓` | Nudge the selected overlay |
| Video/audio player | `K` / `Space` | Play/pause |
| | `F` | Fullscreen |
| | `T` | Theater mode |
| | `I` | Picture-in-picture |
| | `M` | Mute |
| | `J` / `L` | Playback speed down/up |
| | `C` | Toggle captions |
| PDF viewer | `V` / `P` / `H` / `T` / `E` | Select / Pen / Highlighter / Text / Eraser |
| | `←` `→` | Previous/next page |
| | `B` | Toggle two-page spread |
| | `F` | Fullscreen presentation mode (`Esc` to exit) |
| | `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in/out/reset |
| | `[` / `]` | Decrease/increase stroke width |

## Known limitations

- **System-wide stylus annotation** (drawing anywhere on screen via `Ctrl+Shift+D`,
  configurable in Settings) is present in the code but currently force-disabled — an
  unresolved deadlock in overlay window creation can hang the app on some displays.
  Don't re-enable `ANNOTATION_FEATURE_DISABLED` in `Dashboard.tsx` until that's fixed.
- **System audio capture** is Windows/WASAPI-only, and its start may lag the screen
  capture's own start by up to roughly a hundred milliseconds, which can show up as a
  small (sub-second) audio/video sync offset.

## Platform support

Briefcast is Windows-only today. Screen/window capture (`gdigrab`/`dshow`), window and
monitor enumeration, screenshot capture, and system-audio capture (WASAPI) are all
implemented directly against the Win32 API, and only Windows FFmpeg binaries are
bundled.

## Prerequisites

- Windows 10 or 11 (64-bit)
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- [Node.js](https://nodejs.org/) 18+ and npm
- [Tauri's Windows prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites) (Microsoft C++ Build Tools, WebView2 — WebView2 ships with Windows 10/11 by default)

Briefcast shells out to `ffmpeg.exe`/`ffprobe.exe`/`ffplay.exe` at
`src-tauri/binaries/ffmpeg/` rather than requiring a system-wide install — but those
binaries are gitignored (not committed to this repo, not even via Git LFS), so you need
to place them yourself before the app can record, convert, or probe anything. HEIC/HEIF
photo preview needs two more bundled binaries at `src-tauri/binaries/heif/` — same
gitignored-and-place-yourself deal (see below). Auto-generated captions (VideoPlayer's CC
button, when no subtitle file already exists) need a bundled offline speech-to-text
engine at `src-tauri/binaries/whisper/` — same deal again.

## Getting started

```bash
git clone https://github.com/oyewodayo/screencast.git
cd screencast

npm install
```

Then download a Windows FFmpeg build (e.g. from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/)) and copy `ffmpeg.exe`, `ffprobe.exe`,
and `ffplay.exe` into `src-tauri/binaries/ffmpeg/`.

HEIC/HEIF (iPhone photo) preview also needs two bundled binaries at
`src-tauri/binaries/heif/` — `heif-dec.exe` (full-resolution decode, for the single-image
viewer and "Convert") and `heif-thumbnailer.exe` (fast small preview, for the image
gallery grid) — alongside every DLL they depend on. Windows' own HEIC decoder (used
first) needs OS codec packages that aren't reliably present on every machine, and the
ffmpeg build above doesn't reconstruct these photos' tiled internal format correctly, so
this app bundles [libheif](https://github.com/strukturag/libheif) — the reference HEIF
implementation — as its fallback decoder instead. The simplest way to get a matching
build: install [MSYS2](https://www.msys2.org/), then from an MSYS2 shell:

```bash
pacman -S mingw-w64-x86_64-libheif
```

and copy `heif-dec.exe`, `heif-thumbnailer.exe`, and every DLL `ldd heif-dec.exe` (run
from `/mingw64/bin`) lists under `/mingw64/bin` into `src-tauri/binaries/heif/` (the two
tools share the same DLLs, so one `ldd` pass covers both).

Auto-generated captions use [whisper.cpp](https://github.com/ggml-org/whisper.cpp) as a
plain bundled CLI binary - not a Rust crate, so there's no C++ toolchain needed to build
this project itself. Download the CPU-only Windows build from its
[releases page](https://github.com/ggml-org/whisper.cpp/releases) (the
`whisper-bin-x64.zip` asset - avoid the `-blas`/`-cublas` variants, which need matching
GPU drivers/libraries this app doesn't otherwise depend on) and copy `whisper-cli.exe`
plus `whisper.dll`, `ggml.dll`, `ggml-base.dll`, and every `ggml-cpu-*.dll` into
`src-tauri/binaries/whisper/`. Then download a model - `ggml-base.en.bin` from
[the ggml-org/whisper.cpp model repo on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp)
is the size/accuracy balance this app defaults to (~141MB; en-only, since Briefcast has no
language picker for this yet) - into the same folder.

```bash
npm run tauri dev
```

This starts the Vite dev server and launches the Tauri app pointed at it, with hot
reload for the frontend.

## Building

```bash
npm run tauri build
```

Produces a release build and installer(s) under `src-tauri/target/release/bundle/`.

To type-check and build just the frontend bundle (without packaging the Tauri app):

```bash
npm run build
```

## Where things live at runtime

- **Recordings** are saved to `%USERPROFILE%\Videos\Briefcast\`, including any
  subfolders you create. Trashed files move to a hidden `.trash` folder inside it
  (with a small JSON manifest) rather than being deleted outright.
- **PDF annotations** are saved alongside their source PDF.
- **Video edits** (clips, text/image/audio overlays) are saved as a sidecar JSON next
  to the source video and reload automatically the next time you open it.
- **Logs** (`app.log`, `panic.log`) are written to the app's data directory, typically
  `%LOCALAPPDATA%\Briefcast\`.

## Project layout

```
screencast/
├── src/                             # React frontend
│   ├── pages/Dashboard.tsx          # Main application view
│   ├── components/
│   │   ├── docker/                  # Bottom panel: recording setup, per-file tools, video timeline
│   │   ├── pdf/                     # PDF toolbar, page rendering, thumbnails/outline sidebar
│   │   ├── video/                   # Video-only overlay editing surface (text/image overlays, crop panel)
│   │   ├── Modals/                  # Settings and recording-completed modals
│   │   ├── custom/                  # Small shared UI primitives (toasts, dropdowns, alerts)
│   │   ├── BottomDocker.tsx         # Switches between the docker/ panels above
│   │   ├── ActiveRecordingState.tsx # Fixed bottom icon bar (folder/open/home/settings) + recording controls
│   │   ├── VideoPlayer.tsx          # Video/audio/image player
│   │   └── PdfAnnotator.tsx         # PDF viewer + markup surface
│   ├── handlers/
│   │   └── videoEditHandlers.ts     # Pure-function overlay/clip CRUD shared by the video edit store
│   ├── hooks/
│   │   ├── useVideoEditStore.ts     # Video edit state, undo/redo, export, sidecar persistence
│   │   └── useClampedPopoverPosition.ts # Keeps floating overlay popovers inside the viewport
│   ├── contexts/ThemeContext.tsx    # Light/dark/system theme
│   └── utils/                       # Formatting, file-category, media-handling, and video overlay/render helpers
├── src-tauri/                        # Rust backend
│   ├── src/
│   │   ├── main.rs                  # Entry point, logging, window/command setup
│   │   ├── commands/
│   │   │   ├── recording.rs         # Recording/screenshot start/stop, FFmpeg process management
│   │   │   ├── recording/           # Per-OS capture backends (win/macos/linux)
│   │   │   ├── conversion.rs        # Media format conversion
│   │   │   ├── window_capture.rs    # Window/monitor enumeration, window thumbnails
│   │   │   └── annotation.rs        # System-wide stylus annotation overlay (see Known limitations)
│   │   ├── services/
│   │   │   ├── utility.rs           # Shared helpers, file/folder listing, rename, move, path utils
│   │   │   ├── trash.rs             # Soft delete, restore, empty, auto-purge
│   │   │   ├── pdf_annotations.rs   # PDF annotation persistence
│   │   │   └── loopback_audio.rs    # WASAPI loopback (system audio) capture
│   │   └── views/                   # Standalone window (recording-completed popup)
│   ├── binaries/ffmpeg/             # Bundled ffmpeg/ffprobe/ffplay
│   ├── binaries/heif/               # Bundled libheif (heif-dec.exe + DLLs) - HEIC/HEIF fallback decode
│   ├── binaries/whisper/            # Bundled whisper.cpp CLI + DLLs + ggml-base.en.bin model - auto-generated captions
│   └── tauri.conf.json              # Tauri app/window/permissions configuration
└── public/                          # Static assets (icons, notification sounds)
```

## Configuration notes

- The Tauri allowlist in `src-tauri/tauri.conf.json` is scoped to only the filesystem
  and window APIs the app actually uses, with filesystem/asset access limited to the
  recordings folder (`$VIDEO/Briefcast/**`) and the OS temp directory (used for window
  thumbnail captures). If you add a feature that needs a broader permission, extend the
  allowlist deliberately rather than reverting to `"all": true`.
- A Content-Security-Policy is set in the same file; if you add new external image/media
  sources, you'll need to extend it.

## Troubleshooting

**"Failed to resolve ffmpeg at ..." when recording or converting**
The FFmpeg binaries are gitignored and not part of a fresh clone — confirm
`src-tauri/binaries/ffmpeg/ffmpeg.exe` and `ffprobe.exe` actually exist on disk (see
[Getting started](#getting-started)).

**"Failed to resolve heif-dec at ..." when opening a HEIC/HEIF photo**
Same as above but for `src-tauri/binaries/heif/heif-dec.exe` — see
[Getting started](#getting-started) for how to obtain it. This path only gets hit as a
fallback (when Windows' own HEIC decoder fails), so most HEIC photos will still preview
fine without it on a machine that already has the OS codec packages installed; only
photos that need the fallback will error until it's in place.

**"Failed to resolve whisper-cli at ..." when generating captions**
Same as above but for `src-tauri/binaries/whisper/whisper-cli.exe` — see
[Getting started](#getting-started) for how to obtain it and the model. This path only
gets hit when you explicitly choose "Generate captions from audio" and no sibling
.vtt/.srt file exists for the video — loading an existing subtitle file, or a video with
no captions requested at all, never touches this.

**No audio/video devices listed**
Briefcast enumerates DirectShow devices via `ffmpeg -f dshow -list_devices`. Make sure
your microphone/camera are connected and enabled in Windows before opening the device
dropdowns, and use the refresh icon next to the device selectors to re-scan.

**"System audio" recordings are silent or fail**
This uses WASAPI loopback against your default playback device, not a DirectShow
device — check that Windows actually has a default output device set (Sound settings)
and that something is genuinely routed through it during the recording.

**Recording won't stop / hangs briefly**
Stop sends FFmpeg a graceful shutdown signal and polls for exit before falling back to
killing the process by PID. If a recording process is unusually slow to exit, check
`app.log` for details rather than force-quitting the app.

**Blank window on launch (dev mode)**
Confirm the Vite dev server is running on port 1420 (see `vite.config.ts`) and that
nothing else is bound to that port — Tauri's dev config expects it and will fail to load
otherwise.

## License

MIT — see [LICENSE](LICENSE).
