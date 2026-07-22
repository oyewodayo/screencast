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
  down to a single "exit" control — with trackpad pinch-to-zoom and scroll-past-the-
  edge page turning.
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
- **File tools docker** — select a file and toggle the wrench icon next to "new
  folder" to swap the bottom panel from recording controls to quick actions for that
  file: rename, convert, reveal in its folder, delete, and at-a-glance
  duration/resolution/size info. Video files get a richer timeline docker instead —
  a scrubbable, zoomable filmstrip of real thumbnails with a playhead synced to the
  actual player (its fuller toolbar — split, crop, effects, etc. — is a visual
  scaffold for tools still to come).

### Customization

Settings (gear icon) covers appearance (light/dark/system theme), recording defaults
(type, format, file name prefix), PDF annotator defaults (starting tool, zoom, pen/
highlighter color, stroke width), and trash auto-purge retention.

## Keyboard shortcuts

| Context | Keys | Action |
|---|---|---|
| Global | `Ctrl+Shift+H` | Show/hide the floating recording overlay |
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
- The video-tools timeline docker's fuller toolbar (split, crop, mirror, effects,
  text, audio) is a visual scaffold — only the playhead/scrubbing, zoom, and the
  "..." rename/convert/reveal/delete menu are wired up so far.

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
to place them yourself before the app can record, convert, or probe anything.

## Getting started

```bash
git clone https://github.com/oyewodayo/screencast.git
cd screencast

npm install
```

Then download a Windows FFmpeg build (e.g. from
[gyan.dev](https://www.gyan.dev/ffmpeg/builds/)) and copy `ffmpeg.exe`, `ffprobe.exe`,
and `ffplay.exe` into `src-tauri/binaries/ffmpeg/`.

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
│   │   ├── Modals/                  # Settings and recording-completed modals
│   │   ├── custom/                  # Small shared UI primitives (toasts, dropdowns, alerts)
│   │   ├── BottomDocker.tsx         # Switches between the docker/ panels above
│   │   ├── VideoPlayer.tsx          # Video/audio/image player
│   │   └── PdfAnnotator.tsx         # PDF viewer + markup surface
│   ├── handlers/                    # Keyboard/media event handler builders
│   ├── hooks/                       # Shared React hooks (PDF rendering, annotation store, ...)
│   ├── contexts/ThemeContext.tsx    # Light/dark/system theme
│   └── utils/                       # Formatting, file-category, and media-handling helpers
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
