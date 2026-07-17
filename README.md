# Briefcast

Briefcast is a Windows desktop app for screen recording, media playback, and media
format conversion. It's built with [Tauri](https://tauri.app/) (Rust) and
[React](https://react.dev/) + TypeScript, and uses bundled [FFmpeg](https://ffmpeg.org/)
binaries for capture, transcoding, and probing.

## Features

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

- **Webcam overlay** — circle, rounded, or rectangular, positioned and sized to taste
  when recording in a mode that combines screen and webcam.
- **Screen/monitor/window picker** — pick a specific monitor or window to record, with
  live thumbnail previews of open windows.
- **Media conversion** — convert recordings (or any local file) to MP4, MOV, MKV, AVI,
  or WebM, individually or in batch, with a live progress bar.
- **Built-in player** — plays back video, audio, and image files, with volume,
  playback-speed, skip, fullscreen, picture-in-picture, and opacity controls.
- **File browser** — sidebar listing everything under your Briefcast recordings folder,
  with rename, reveal-in-Explorer, and convert actions.
- **Floating recording overlay** — a small always-on-top window with a live timer and a
  Stop button, so you don't need to keep the main window in view while recording.

## Platform support

Briefcast is Windows-only today. Screen/window capture (`gdigrab`/`dshow`), window and
monitor enumeration, and screenshot capture are all implemented directly against the
Win32 API, and only Windows FFmpeg binaries are bundled.

## Global key support
Ctrl + shift + H : Minimize and maximize recording shortcut.

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

- **Recordings** are saved to `%USERPROFILE%\Videos\Briefcast\`.
- **Logs** (`app.log`, `panic.log`) are written to the app's data directory, typically
  `%LOCALAPPDATA%\Briefcast\`.

## Project layout

```
screencast/
├── src/                          # React frontend
│   ├── pages/Dashboard.tsx       # Main application view
│   ├── components/               # UI components (docker, player, dialogs, ...)
│   ├── handlers/                 # Keyboard/media event handler builders
│   ├── hooks/                    # Shared React hooks
│   └── utils/                    # Formatting and media-handling helpers
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # Entry point, logging, window/command setup
│   │   ├── commands/
│   │   │   ├── recording.rs      # Recording start/stop, FFmpeg process management
│   │   │   ├── conversion.rs     # Media format conversion
│   │   │   └── windows_api.rs    # Window/monitor enumeration, screenshot capture
│   │   ├── services/utility.rs   # Shared helpers, file listing, rename, path utils
│   │   └── views/                # Standalone window (recording-completed popup)
│   ├── binaries/ffmpeg/          # Bundled ffmpeg/ffprobe/ffplay
│   └── tauri.conf.json           # Tauri app/window/permissions configuration
└── public/                       # Static assets (icons, notification sounds)
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

**Recording won't stop / hangs briefly**
Stop sends FFmpeg a graceful shutdown signal and polls for exit before falling back to
killing the process by PID. If a recording process is unusually slow to exit, check
`app.log` for details rather than force-quitting the app.

**Blank window on launch (dev mode)**
Confirm the Vite dev server is running on port 1420 (see `vite.config.ts`) and that
nothing else is bound to that port — Tauri's dev config expects it and will fail to load
otherwise.

## License

This repository does not currently include a license file. Treat it as all-rights-reserved
until one is added.
