# Briefcast - Professional Screen Recording Application

<div align="center">
  <img src="public/screencast.png" alt="Briefcast Logo" width="120"/>
  
  [![Rust](https://img.shields.io/badge/Rust-1.70+-orange.svg)](https://www.rust-lang.org/)
  [![Tauri](https://img.shields.io/badge/Tauri-1.5+-blue.svg)](https://tauri.app/)
  [![React](https://img.shields.io/badge/React-18+-61DAFB.svg)](https://reactjs.org/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5+-3178C6.svg)](https://www.typescriptlang.org/)
  [![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

  **A powerful, cross-platform screen recording application built with Tauri, React, and FFmpeg**

  [Features](#features) • [Installation](#installation) • [Usage](#usage) • [Building](#building) • [Contributing](#contributing)
</div>

---

## 📋 Table of Contents

- [About](#about)
- [Features](#features)
- [Screenshots](#screenshots)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Building from Source](#building-from-source)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)

---

## 🎯 About

Briefcast is a modern, feature-rich screen recording application designed for professionals, content creators, educators, and anyone who needs high-quality screen capture capabilities. Built with cutting-edge technologies including Tauri (Rust) and React, Briefcast offers native performance with a beautiful, intuitive interface.

### Why Briefcast?

- **🚀 Lightning Fast**: Built with Rust for maximum performance
- **💾 Small Footprint**: Tauri-based architecture results in minimal resource usage
- **🎨 Modern UI**: Clean, intuitive interface built with React and TailwindCSS
- **🔒 Privacy-Focused**: All processing happens locally on your machine
- **🎥 Professional Quality**: Powered by FFmpeg for industry-standard encoding
- **⚙️ Highly Configurable**: Extensive customization options for power users

---

## ✨ Features

### Recording Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **SVA** | Screen + Video + Audio | Full presentation with webcam overlay |
| **SA** | Screen + Audio | Tutorial videos, lectures |
| **VA** | Video + Audio | Webcam-only recording |
| **S** | Screen Only | Silent screencasts, demos |
| **V** | Video Only | Video recording without screen |
| **A** | Audio Only | Podcast, voice notes |
| **C** | Screenshot | Quick screen capture |

### Core Features

#### 🎬 Recording Capabilities
- **Multiple Input Sources**: Record screen, webcam, and microphone simultaneously
- **Flexible Output Formats**: Support for AVI, MKV, WebM, MOV, MP4, and more
- **Custom Overlays**: Add webcam overlay with customizable shapes (circle, rounded, square)
- **Positioning Control**: Place overlays anywhere on the screen
- **High Frame Rates**: Support for up to 200 FPS recording
- **Real-time Preview**: See recording status with live indicators

#### 🎨 Customization
- **Overlay Shapes**: Circle, rounded rectangle, or standard rectangle
- **Overlay Positions**: Bottom-left, bottom-center, bottom-right
- **Overlay Sizes**: Small, medium, or custom dimensions
- **Screen Size Selection**: Full screen or custom dimensions
- **Audio/Video Device Selection**: Choose from all connected devices

#### 🖥️ Window Management
- **Window Monitoring**: Track active and recently active windows
- **Global Keyboard Hooks**: Capture keyboard events system-wide
- **Window Screenshot**: Capture individual window screenshots
- **Window Activation**: Quickly switch to specific windows

#### 💡 User Experience
- **Real-time Recording Timer**: Track recording duration
- **System Resource Monitor**: View CPU and RAM usage
- **Audio Notifications**: Sound alerts for recording start/stop
- **File Management**: Automatic file naming with timestamps
- **Direct File Access**: Quick access to recorded files

---

## 📸 Screenshots

> Add your application screenshots here

```
[Main Interface]
[Recording in Progress]
[Settings Panel]
[File Output]
```

---

## 🔧 Prerequisites

### System Requirements

- **Operating System**: Windows 10/11 (64-bit)
- **RAM**: Minimum 4GB (8GB recommended)
- **Storage**: 200MB for application + space for recordings
- **CPU**: Intel Core i3 or equivalent (i5+ recommended for high-quality recording)

### Development Requirements

- **Rust**: 1.70 or higher
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```

- **Node.js**: 16.x or higher
  ```bash
  # Download from https://nodejs.org/
  ```

- **pnpm** (recommended) or npm
  ```bash
  npm install -g pnpm
  ```

- **Tauri CLI**
  ```bash
  cargo install tauri-cli
  ```

---

## 📦 Installation

### For Users (Pre-built Binaries)

1. Download the latest release from the [Releases](https://github.com/yourusername/briefcast/releases) page
2. Run the installer for your platform
3. Launch Briefcast from your applications menu

### For Developers

```bash
# Clone the repository
git clone https://github.com/yourusername/briefcast.git
cd briefcast

# Install frontend dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Or using cargo
cargo tauri dev
```

---

## 🚀 Usage

### Quick Start Guide

1. **Launch Briefcast**: Open the application
2. **Select Recording Mode**: Choose from the dropdown (SVA, SA, VA, S, V, A, C)
3. **Configure Settings**:
   - Set output filename
   - Choose file format
   - Select audio/video devices
   - Configure overlay options (if using webcam)
4. **Start Recording**: Click "Start Recording" button
5. **Stop Recording**: Click "Stop Recording" when finished
6. **Access Files**: Files are automatically saved to `%USERPROFILE%/Videos/screencast/`

### Recording Tips

#### For Best Quality
- Use **AVI** or **MKV** format for recording
- Convert to MP4 after recording if needed
- Ensure sufficient disk space (approximately 1GB per 10 minutes at 1080p)
- Close unnecessary applications to free up system resources

#### For Webcam Overlay
- Position overlay strategically to avoid covering important content
- Use **rounded** or **circle** shapes for a professional look
- Adjust overlay size based on content importance

#### For Audio
- Use a quality microphone for clear audio
- Test audio levels before recording
- Minimize background noise

### Keyboard Shortcuts

> Feature coming soon - Global hotkeys for recording control

---

## 🏗️ Building from Source

### Build for Development

```bash
# Install dependencies
pnpm install

# Run development server with hot reload
pnpm tauri dev
```

### Build for Production

```bash
# Build optimized production bundle
pnpm tauri build
```

The built application will be in `src-tauri/target/release/`.

### Build Installers

```bash
# Windows (NSIS installer)
pnpm tauri build

# Output locations:
# - MSI: src-tauri/target/release/bundle/msi/
# - NSIS: src-tauri/target/release/bundle/nsis/
```

### Cross-Platform Builds

For building on different platforms:

```bash
# Add platform targets
rustup target add x86_64-pc-windows-msvc
rustup target add x86_64-apple-darwin
rustup target add x86_64-unknown-linux-gnu

# Build for specific target
cargo tauri build --target x86_64-pc-windows-msvc
```

---

## ⚙️ Configuration

### Directory Structure

```
briefcast/
├── src/                      # React frontend
│   ├── components/          # React components
│   ├── pages/              # Page components
│   └── Types.ts            # TypeScript types
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs         # Application entry point
│   │   ├── commands/       # Tauri commands
│   │   │   ├── recording.rs
│   │   │   └── windows_api.rs
│   │   └── services/       # Business logic
│   │       └── utility.rs
│   ├── binaries/           # Bundled binaries
│   │   └── ffmpeg/
│   │       └── ffmpeg.exe
│   ├── icons/              # Application icons
│   └── tauri.conf.json     # Tauri configuration
└── public/                 # Static assets
    └── sounds/             # Audio notifications
```

### Environment Variables

Create a `.env` file in the root directory:

```env
# Optional: Custom FFmpeg path
FFMPEG_PATH=/path/to/ffmpeg

# Development settings
RUST_BACKTRACE=1
RUST_LOG=info
```

### Tauri Configuration

Edit `src-tauri/tauri.conf.json`:

```json
{
  "build": {
    "devPath": "http://localhost:5173",
    "distDir": "../dist"
  },
  "tauri": {
    "bundle": {
      "identifier": "com.briefcast.app",
      "resources": [
        "binaries/ffmpeg/*"
      ]
    },
    "windows": [
      {
        "label": "main",
        "title": "Briefcast",
        "width": 1200,
        "height": 800
      }
    ]
  }
}
```

---

## 🏛️ Architecture

### Technology Stack

#### Frontend
- **React 18**: UI framework
- **TypeScript**: Type-safe JavaScript
- **TailwindCSS**: Utility-first CSS framework
- **React Icons**: Icon library
- **Tauri API**: Bridge to Rust backend

#### Backend
- **Rust**: Core application logic
- **Tauri**: Desktop application framework
- **Windows API**: Native Windows integration
- **FFmpeg**: Media processing

### Key Components

#### Frontend (`src/`)
```
Dashboard.tsx          → Main application view
BottomDocker.tsx       → Recording controls
ActiveRecordingState   → Recording status UI
SettingsModal          → Configuration panel
ScreenOptions          → Screen selection
```

#### Backend (`src-tauri/src/`)
```
main.rs                → Application entry, window management
commands/
  ├── recording.rs     → Recording logic, FFmpeg integration
  └── windows_api.rs   → Window management, hooks
services/
  └── utility.rs       → File operations
```

### Data Flow

```
User Interface (React)
        ↓
   Tauri Commands
        ↓
   Rust Handlers
        ↓
   FFmpeg Process / Windows API
        ↓
   File System / System Resources
```

---

## 🐛 Troubleshooting

### Common Issues

#### Blank Screen on Launch

**Problem**: Application opens but shows blank screen

**Solutions**:
1. Check if React dev server is running
2. Verify `tauri.conf.json` paths are correct
3. Clear browser cache (Ctrl + Shift + R in dev mode)
4. Check console for errors: Right-click → Inspect

#### FFmpeg Not Found

**Problem**: Recording fails with "Failed to resolve ffmpeg path"

**Solutions**:
1. Ensure `binaries/ffmpeg/ffmpeg.exe` exists in `src-tauri/`
2. Check `tauri.conf.json` includes FFmpeg in resources
3. Verify file permissions on FFmpeg binary

#### No Audio Devices Detected

**Problem**: Audio device dropdown shows "No audio device detected"

**Solutions**:
1. Ensure microphone is connected and enabled
2. Check Windows audio settings
3. Restart the application
4. Run as administrator if needed

#### Recording Quality Issues

**Problem**: Recording is laggy or poor quality

**Solutions**:
1. Close unnecessary applications
2. Reduce recording frame rate
3. Use AVI format instead of MP4 during recording
4. Check available disk space
5. Update graphics drivers

#### High CPU Usage

**Problem**: Application uses excessive CPU

**Solutions**:
1. Lower recording frame rate (60 FPS instead of 200 FPS)
2. Reduce recording resolution
3. Disable webcam overlay if not needed
4. Close other resource-intensive applications

### Debug Mode

Enable debug logging:

```bash
# Windows
set RUST_LOG=debug
set RUST_BACKTRACE=1
cargo tauri dev

# Or in PowerShell
$env:RUST_LOG="debug"
$env:RUST_BACKTRACE="1"
cargo tauri dev
```

Check logs:
- Application log: `app.log` in the application directory
- Console output: View in terminal where you ran `cargo tauri dev`

---

## 🤝 Contributing

We welcome contributions! Here's how you can help:

### Getting Started

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/amazing-feature
   ```
3. **Make your changes**
4. **Test thoroughly**
5. **Commit your changes**
   ```bash
   git commit -m "Add amazing feature"
   ```
6. **Push to your fork**
   ```bash
   git push origin feature/amazing-feature
   ```
7. **Open a Pull Request**

### Development Guidelines

- Follow Rust best practices and formatting (`cargo fmt`)
- Use TypeScript strictly (no `any` types)
- Write meaningful commit messages
- Add tests for new features
- Update documentation
- Ensure all warnings are resolved

### Code Style

**Rust**:
```bash
# Format code
cargo fmt

# Check for issues
cargo clippy
```

**TypeScript/React**:
```bash
# Format code
pnpm format

# Lint
pnpm lint
```

### Areas for Contribution

- 🌐 Cross-platform support (macOS, Linux)
- 🎨 UI/UX improvements
- 🚀 Performance optimizations
- 📝 Documentation enhancements
- 🧪 Test coverage
- 🌍 Internationalization (i18n)
- ♿ Accessibility improvements

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

```
MIT License

Copyright (c) 2024 Briefcast Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 🙏 Acknowledgments

- **[Tauri](https://tauri.app/)** - The amazing framework that powers this application
- **[FFmpeg](https://ffmpeg.org/)** - The backbone of our media processing
- **[React](https://reactjs.org/)** - For the powerful UI framework
- **[Rust](https://www.rust-lang.org/)** - For enabling high-performance native code
- **[TailwindCSS](https://tailwindcss.com/)** - For the beautiful styling system
- All our [contributors](https://github.com/yourusername/briefcast/graphs/contributors)

---

## 📞 Support & Contact

- **Report Bugs**: [GitHub Issues](https://github.com/yourusername/briefcast/issues)
- **Request Features**: [GitHub Discussions](https://github.com/yourusername/briefcast/discussions)
- **Twitter**: [@oyewodayo](https://x.com/oyewodayo)
- **Email**: support@briefcast.app

---

## 🗺️ Roadmap

### Version 1.1 (Upcoming)
- [ ] Global hotkeys for recording control
- [ ] Multiple monitor support
- [ ] Recording pause/resume functionality
- [ ] Advanced audio mixing

### Version 1.2
- [ ] macOS support
- [ ] Linux support
- [ ] Cloud upload integration
- [ ] Video editing capabilities

### Version 2.0
- [ ] Live streaming support
- [ ] Real-time annotations
- [ ] Team collaboration features
- [ ] Cloud storage integration

---

## 📊 Project Stats

![GitHub stars](https://img.shields.io/github/stars/yourusername/briefcast?style=social)
![GitHub forks](https://img.shields.io/github/forks/yourusername/briefcast?style=social)
![GitHub issues](https://img.shields.io/github/issues/yourusername/briefcast)
![GitHub pull requests](https://img.shields.io/github/issues-pr/yourusername/briefcast)

---

<div align="center">
  <p>Made by the Temidayo Oyewo</p>
  <p>
    <a href="https://github.com/oyewodayo/screencast">GitHub</a> •
    <a href="https://twitter.com/oyewodayo">Twitter</a> •
    <a href="#support--contact">Support</a>
  </p>
</div>


# Brief Studio

This is studio for streaming, recording videos, screen recording, audio recording, editing and manipulation of media files of any format.

## More
Show the List of all devices
ffmpeg -list_devices true -f dshow -i dummy

ffmpeg -list_options true -f dshow -i video="Integrated Webcam" 

Record Video + audio with webcam and System Microphone and save as video-audio-out.avi
ffmpeg -f dshow -video_size 320x240 -i video="Integrated Webcam":audio="Microphone (Realtek Audio)" video-audio-out7.avi

Record Video only
ffmpeg -f dshow -video_size 320x240 -i video="Integrated Webcam" video-audio-out6.avi

Record audio with system microphone. You can replace the "Microphone (Realtek Audio)" with your any of your listed audio device.
ffmpeg -f dshow -i audio="Microphone (Realtek Audio)" audio-out.mp3

Full screen recording
ffmpeg -f gdigrab -show_region 1 -framerate sntsc -offset_x 10 -offset_y 20 -i desktop outssscreens.avi

To pick selected screen size
ffmpeg -f gdigrab -video_size 1600x1200 -framerate sntsc -offset_x 10 -offset_y 20 -i desktop outscreens-size.avi
ffmpeg -f gdigrab -video_size 1600x1200 -S 55 -framerate sntsc -offset_x 10 -offset_y 20 -i desktop outscreens-size.avi

Capture video from webcam and overlay it on the recorded screen with audio
ffmpeg -f gdigrab -framerate sntsc -i desktop -f dshow -video_size 320x240 -i "video=Integrated Webcam":audio="Microphone (Realtek Audio)" -c:v mpeg4 -c:a aac -ac 2 -filter_complex [0:v][1:v]overlay=x=W-w-100:y=H-h-50 -segment_time 10 -segment_format avi vidplusaudio.avi

// #[tauri::command]
// async fn create_folder() {
//     let video_path = "c:\\Users\\HP\\Videos";
//     let audio_path = "c:\\Users\\HP\\Musics";
//     let picture_path = "c:\\Users\\HP\\Pictures";
//     let path = "Recordings";
//     DirBuilder::new().recursive(true).create(path).unwrap();
// }

"-show_video_device_dialog", "true",
"-crossbar_video_input_pin_number", "0",
"-crossbar_audio_input_pin_number", "3",
Video size ¶
Specify the size of the sourced video, it may be a string of the form widthxheight, or the name of a size abbreviation.

The following abbreviations are recognized:
‘ntsc’
720x480

‘pal’
720x576

‘qntsc’
352x240

‘qpal’
352x288

‘sntsc’
640x480

‘spal’
768x576

‘film’
352x240

‘ntsc-film’
352x240

‘sqcif’
128x96

‘qcif’
176x144

‘cif’
352x288

‘4cif’
704x576

‘16cif’
1408x1152

‘qqvga’
160x120

‘qvga’
320x240

‘vga’
640x480

‘svga’
800x600

‘xga’
1024x768

‘uxga’
1600x1200

‘qxga’
2048x1536

‘sxga’
1280x1024

‘qsxga’
2560x2048

‘hsxga’
5120x4096

‘wvga’
852x480

‘wxga’
1366x768

‘wsxga’
1600x1024

‘wuxga’
1920x1200

‘woxga’
2560x1600

‘wqsxga’
3200x2048

‘wquxga’
3840x2400

‘whsxga’
6400x4096

‘whuxga’
7680x4800

‘cga’
320x200

‘ega’
640x350

‘hd480’
852x480

‘hd720’
1280x720

‘hd1080’
1920x1080

‘2k’
2048x1080

‘2kflat’
1998x1080

‘2kscope’
2048x858

‘4k’
4096x2160

‘4kflat’
3996x2160

‘4kscope’
4096x1716

‘nhd’
640x360

‘hqvga’
240x160

‘wqvga’
400x240

‘fwqvga’
432x240

‘hvga’
480x320

‘qhd’
960x540

‘2kdci’
2048x1080

‘4kdci’
4096x2160

‘uhd2160’
3840x2160

‘uhd4320’
7680x4320



- [Briefstudio](https://studio.briefbrew.com/)
