# Briefcast

Briefcast is a Windows desktop app for screen recording, media playback, PDF viewing
and markup, media format conversion, rich-text documents, whiteboards and mindmaps, and
file organization — all in one window. It's
built with [Tauri](https://tauri.app/) (Rust) and [React](https://react.dev/) +
TypeScript, and uses bundled [FFmpeg](https://ffmpeg.org/) binaries for capture,
transcoding, and probing.

**User guide:** see the [documentation at withbriefs.com/briefcast/docs](https://withbriefs.com/briefcast/docs) for how to use every feature, from your first recording to the keyboard shortcuts. This README covers the project from a developer's side.

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
- **Previous / next file** — skip buttons either side of play/pause step through the
  other videos or tracks in the same list as the sidebar (shuffle-aware for audio), so
  you don't need to open the sidebar to move on. `Shift+P` / `Shift+N` do the same.
- **Noise cleanup while you watch** — Settings (the gear in the player) → Noise offers
  **Reduce noise** (softens hiss, hum and room noise, keeping some ambience) or **Remove
  noise** (AI voice isolation), with a strength slider. It's applied live to what you
  hear on both video and audio files and never changes the file. The choice is
  remembered for the next file.
- **Adjustable skip amount** — double-click either skip button to pick 5s, 10s, 15s,
  30s or 1 minute.
- **Window title** — the title bar shows the open file's name (`lecture.mp4 - Briefcast`).
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

### Presentation annotation

- **Draw anywhere on screen** — press `Ctrl+Shift+D` from any app to circle, underline
  or point at anything on screen (slides, a browser, the whiteboard, a recording in
  progress). It covers every connected monitor. Press `Esc` or `Ctrl+Shift+D` again to
  stop.
- **Ink styles** — Pen (tapers with stylus pressure), Marker (wide and see-through),
  Neon (glowing line with a bright core) and Laser (a glowing trail that vanishes
  almost at once, for pointing).
- **Fading strokes** — strokes fade on their own after a Quick, Normal or Slow delay,
  or stay until you clear them or leave draw mode.
- **Optional toolbar** — a small floating toolbar switches style and colour or clears
  the screen. Hide it in Settings and drawing appears from nowhere ("magic" mode); its
  keyboard shortcuts keep working (see Keyboard shortcuts).
- **Light on resources** — the overlay only draws while you're drawing or a stroke is
  fading, so it uses no CPU or GPU while idle, recording or presenting.

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

There are two ways in. Open a video from the sidebar and toggle the wrench icon, as with
any other file type; or click the **scissors icon** in the bottom icon bar to open the
video editor as a standalone tool, the same way Whiteboard and Mindmap open. The tool
starts on a landing screen that lists every video in your library (with poster-frame
thumbnails), the ones you opened most recently, and an **Open video from anywhere**
button for editing a file that was never imported into Briefcast. Picking one there
opens it with the timeline already showing — no wrench click — and leaves a "Back to
video editor" button to return to the list. Both routes are the same editor on the same
edit list; the tool icon just means you don't have to find and open a file first.

- **Timeline & clips** — a scrubbable, zoomable filmstrip of real thumbnails with a
  playhead synced to the actual player; split, trim, reorder, and delete clips; drag a
  file straight from the sidebar (or from Explorer) onto the timeline to insert it as a
  new clip, so one edit can combine several source videos.
- **Razor tool** — switch the select tool to Razor to split a clip wherever you click,
  staying armed for several cuts in a row.
- **Trim silence** — scans the audio for silent gaps and lists them; nothing is cut
  until you confirm **Remove**.
- **Speed** — per clip, 0.25× to 4× (presets 0.5×, 1×, 1.5×, 2× plus a fine slider), with
  the new duration shown; audio pitch is preserved.
- **Crop and flip** — a free-form crop of the clip's frame (drag it on the video, not
  locked to the original aspect ratio) and a horizontal mirror.
- **Clip effects** — colour grades (Vibrant, Cinematic, Black & white, Warm, Cool,
  Vignette) with an intensity slider; Ken Burns motion (zoom in/out, pan left/right);
  and a transition into the clip from the previous one (fade, fade to black, wipes,
  slides, circle, zoom, pixelate, radial, dissolve) with adjustable length. Transitions
  render in the export; the preview shows a cut at that point.
- **Auto zoom** — finds the mouse clicks in a screen recording and adds a short zoom
  centred on each one, after you review the list.
- **Clean up audio** — per clip: **Reduce noise** (spectral, keeps some room tone, can
  learn from a noise-only stretch you mark on the waveform) or **Remove noise** (AI voice
  isolation), with a strength slider, plus optional low-cut (rumble/wind), mains-hum
  removal (50 or 60 Hz), a gate for the silence between phrases, and loudness levelling.
  Everything is heard live while editing and applied the same way on export.
- **Extract and detach audio** — save a clip's sound as MP3, WAV or AAC, or detach the
  video's sound onto the audio lane as separate tracks (per audio stream, or split into
  Voice and Music when the separation engine is installed).
- **Text overlays** — click-to-place captions with per-character rich formatting
  (color, bold, italic), alignment, a background with adjustable padding and square,
  rounded or pill corners, a text outline, drag to reposition, resize/rotate handles
  (with angle snapping and a numeric input), and a timeline lane chip to retime when it
  appears/disappears.
- **Image overlays** — place an image on the video, drag/resize (aspect-locked or
  free), rotate, flip horizontal/vertical, opacity, rounded corners, border and shadow,
  replace the source image in place, and crop via a dedicated crop panel.
- **Blur regions** — blur a rectangle or ellipse over part of the picture (rounded and
  rotatable) for a set stretch of time, e.g. to hide an email address or password;
  burned into the export.
- **Picture-in-picture** — overlay another video (typically a webcam recorded
  separately from the screen) as a circle, rounded or rectangular inset; move, resize
  and crop it on the video or with precise sliders, trim it, and choose whether its
  audio plays (muted by default).
- **Audio overlays** — add background music/voiceover tracks with a real waveform
  (decoded from the actual audio), trim-to-resize semantics, volume, fade in/out, and
  mute — mixed into the export alongside the video's own audio without auto-ducking
  either track.
- **Main video audio control** — mute or adjust the volume of the original video's own
  audio track, independent of the audio overlays and independent of the player's own
  local listening-volume slider.
- **Entry/exit animations** for text and image overlays (fade, slide in from any side,
  pop). Pop shows in the preview only.
- **Layering** — bring an overlay to front or send it to back when overlays stack.
- **Duplicate** — Ctrl+D, or right-click a text/image overlay for a context menu.
- **Arrow-key nudge** for fine-positioning a selected overlay.
- **Undo/redo** across the whole edit (clips, overlays, trims, and audio settings)
  via Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y.
- **Export** renders the full edit — trimmed/reordered clips with their speed, crop,
  effects and transitions, burned-in text, image, blur and picture-in-picture overlays,
  and the mixed audio (video track + overlays, cleaned up and volume-adjusted as
  configured) — to a single output file via FFmpeg. The chevron next to Save picks the
  quality (Smaller file, Standard, High quality) and where to save.

### Whiteboard

A separate draw.io-style diagramming surface — shapes and connectors on an infinite
pan/zoom canvas, independent of the recording/playback/PDF tools above. A whiteboard can
have multiple pages, each with its own undo history.

- **Shape library** — Basic (rectangles, ellipses, polygons, stars, flowchart symbols,
  tables with mergeable/resizable cells), General (banners, frames, hourglasses, half
  circles), Waveforms (sine/cosine/square/triangle/sawtooth), Science (resistors,
  capacitors, diodes, op-amps, flasks, benzene rings, bond-line chains, unit circles,
  number lines), Charts & Plots (bar/line/pie/scatter charts, curated function plots),
  and a math equation shape rendered via KaTeX.
- **Graph tool** — a genuine formula grapher: type any expression in `x` (parsed by a
  small hand-rolled arithmetic parser, never `eval`), with explicit or auto-fitting axis
  ranges and grid/tick controls. A "Blank Graph" preset starts with just axes, for
  **manually plotting points and lines directly on the canvas** — double-click the plot
  area to add a point, drag a point to reposition it, double-click a point to remove
  it — with points staying correctly scaled if the graph is later resized or its axis
  range changed.
- **Lattice Gauge Theory widget** — a live, interactive 3D WebGL teaching diagram (quark
  spheres on lattice sites, gluon links between them) with orbit/zoom/pan camera control
  and three teaching modes (free exploration, a highlighted plaquette/Wilson loop, and a
  gauge-transformation color demo), plus adjustable lattice size, spacing, and
  spin-model visualization (Ising/XY/Heisenberg).
- **Connectors** — straight, orthogonal, or curved routing; solid/dashed/dotted lines;
  arrowhead styles per end; bend points (double-click the line to add one, drag to
  reposition, double-click to remove); rotate and nudge a free-floating connector from
  the style panel just like a shape.
- **Direct data manipulation** — drag a bar chart's bar, a line chart's point, or a
  scatter dot vertically to change its underlying value live, instead of only editing
  the comma-separated data field.
- **Selection & editing** — click or marquee-select (shapes and connectors both),
  multi-select, group/ungroup, duplicate, bring-to-front/send-to-back, lock a shape to
  keep it from being dragged/resized/rotated/nudged while you work around it,
  snap-to-grid, and a laser pointer for presenting without leaving marks.
- **Freehand pen** (including a freehand arrow variant) and inline text editing on any
  shape.
- **Clipboard paste** — `Ctrl+V` pastes whatever was copied last: a screenshot (Print
  Screen, Snipping Tool) or an image copied from a browser lands as an image shape,
  plain text lands as a text shape sized to fit, and shapes copied on the board paste
  with the connectors between them. Pasted images are saved into the whiteboard's own
  `assets/` folder.
- **Export** the current page to PNG.

### Mindmap

A structured learning-roadmap builder in the shape of [roadmap.sh](https://roadmap.sh),
opened from its own icon in the bottom bar. Where the whiteboard treats a box as a
*drawing*, a mindmap node is a *curriculum entry*: it has a semantic type, a slot in a
hierarchy, its own curated list of learning resources, and a progress state you tick off
as you work through it. Each mindmap is a single infinite canvas with a document-wide
undo history, autosaved as you go.

- **Typed components** — drag from the left-hand palette to place a Title, Topic,
  Sub-topic, Paragraph, Label, Button, Image, Checklist, Links Group, Section backdrop,
  or a horizontal/vertical divider. Each type arrives at a sensible size, colour, and
  text weight for what it is, so a roadmap stays visually coherent without per-node
  styling work.
- **Directional add-topic arrows** — hover a node and click the arrow on any side to
  create a connected child in that direction. Repeated adds fan out along the
  perpendicular axis instead of stacking, so a topic's sub-topics lay themselves out.
- **Connectors** — drag between node sides to link them, solid or dashed (roadmap.sh's
  own convention: dashed for "belongs to", solid for "go here next"). Sides are explicit
  and never silently re-route, because the lines are part of the diagram's meaning.
- **Content & Links** — the inspector's second tab, and the reason the feature exists.
  Give a topic a description and a curated resource list, each entry typed as
  article/video/course/docs/book/tool/feed/open-source and optionally flagged
  "official", so a reader can tell a 40-minute video from a two-minute reference page
  before clicking.
- **Progress tracking** — mark a topic pending, in progress, done, or skipped; the
  canvas and reader view both reflect it.
- **Live View** — a one-click read-only rendering of the roadmap the way someone
  following it would see it: clicking a topic opens its description and resources in a
  drawer, and progress can be set from there. Nothing can be moved or restyled by
  accident.
- **Checklists and link groups** — multi-row nodes for prerequisites and inline link
  lists, with per-node checkmark glyph (tick, cross, dot, square) and colour so several
  checklists in one roadmap can mean different things at a glance.
- **Images** are imported into the mindmap's own `assets/` folder rather than linked by
  URL, so a roadmap keeps working if the original file moves. (The app's
  content-security policy only permits `asset:`/`data:` images, so remote URLs are
  blocked by the webview.)
- **Copy & paste** — `Ctrl+C`/`Ctrl+V` copies selected nodes along with the connectors
  between them. `Ctrl+V` also pastes from the system clipboard: a screenshot or copied
  image becomes an Image node, short text becomes a Label, and longer or multi-line
  text becomes a Paragraph. Whichever was copied last wins.
- **Canvas controls** — pan/zoom (space-drag, pinch, Ctrl+wheel), fit-to-content,
  optional grid and snap-to-grid, marquee and multi-select, auto-size a box to its own
  text, layering, and per-node lock.
- **Starter template** — a new mindmap opens with an editable skeleton roadmap whose
  instruction panel documents the editor's own gestures, rather than a blank grid.
- **Export** the roadmap to PNG or PDF, either straight into your library or to a path
  you pick.

### Docs

A Google-Docs-style word processor, opened from the document icon in the bottom bar.
Documents are paginated on screen exactly as they will print, save automatically as you
type, and can be attached to a recording as its notes.

**Documents page**

- **New document** and **Import .docx** — imported Word files keep their headings,
  lists, tables, images, links and per-paragraph colours, fonts and sizes.
- **Folders** — nested folders in a sidebar; drag a document onto a folder or use
  **Move to…** from its ⋮ menu.
- **Card menu** — **Open**, **Pin** (pinned documents sort first), **Move to…** and
  **Delete**.
- **Search** — full-text search across every document's contents, not just titles.
- **Trash** — deleted documents can be restored or deleted forever.

**Editing**

- **Formatting toolbar** — one bar in the Google Docs order: undo/redo, paragraph style
  (Normal, Heading 1–4), font, font size with −/+, bold/italic/underline, text and
  highlight colour, link, comment, image, table, alignment, line spacing, lists, indent
  and clear formatting. As the window narrows, the less-used tools move into the **⋮
  More** menu instead of the bar wrapping (strikethrough, inline code,
  superscript/subscript, quote, code block, horizontal line and page break are always
  there).
- **Text and highlight colour** — select text and pick a colour to apply it. Pick a
  colour with nothing selected to turn on **highlighter mode**: the pointer becomes a
  marker and every selection you make (drag, double-click a word, Shift+arrows) is
  coloured as soon as you finish it, with a live preview while dragging. Going over text
  that already has that colour removes it. `Esc`, **Done** on the banner, or the colour
  button ends it.
- **"/" commands** — type `/` for a quick menu of blocks: text, headings, lists, quote,
  code block, table, divider, page break and image.
- **Tables** — insert from a size grid; add/delete rows and columns, merge/split cells,
  header row/column, resizable columns.
- **Images** — insert from disk, paste or drag in; resize, crop and drag to reorder.
  Images are copied into the document's own folder.
- **Links** — `Ctrl+K` to add or edit; URLs and email addresses typed or pasted become
  links automatically.
- **Code blocks** with syntax highlighting.
- **Find and replace** — `Ctrl+F`, with match case, previous/next and replace all.
- **Comments** — select text and add a comment; the comments panel lists them in
  document order (click one to jump to its text), with resolve, reopen and delete.
- **Version history** — a snapshot is taken when a document opens and every ~10 minutes
  while it changes (the last 20 are kept). Preview any version and restore it; restoring
  first snapshots the current state, so it can be undone.
- **Link to a recording** — attach a document to a file in your library as its notes.
  The file shows a notes badge in the sidebar, and the link follows the file if it is
  renamed or moved.
- **Title and counts** — a new document takes its title from its first line; the title
  row shows save state, word count and page count. `Ctrl+S` saves immediately.

**Pages, margins and rulers**

- **Live pages** — the document is laid out as separate sheets with the real page
  margins and gaps between them, matching what Print and PDF export produce. Manual page
  breaks (`Ctrl+Enter`) start a new page.
- **Page setup** — paper size (Letter, A4, Legal), margins for each side with Normal /
  Narrow / Moderate / Wide presets, and header/footer text repeated on every printed page.
- **Rulers** — a horizontal ruler above the page and a vertical one beside it (toggle in
  **⋮ More → Show ruler**). Drag the edges of the grey margin areas to change the
  margins, and the blue markers to set the current paragraph's first-line, left and
  right indents. Drags snap to 1/8 inch (or 0.25 cm) and to the other markers; hold
  `Alt` for free positioning, `Shift` while dragging the left indent to move the first
  line with it, and `Esc` to cancel. A tooltip shows the exact value and a guide line
  runs down the page. Markers can also be moved with the arrow keys; double-click an
  indent marker to type exact values (including a hanging indent), or a margin to open
  Page setup. Click the unit label to switch between inches and centimetres.

**Voice typing**

- **Dictation** — click the microphone (or press `Ctrl+Shift+S`) and speak. Text is
  inserted after each short pause, with your words shown in grey while you're still
  speaking. It runs entirely on this computer using the same whisper.cpp engine as
  captions; the speech model is downloaded automatically the first time.
- **Context-aware** — the text before the cursor is given to the speech engine, so
  names and terms already in the document are spelled consistently. Capitalisation and
  spacing are fixed up where phrases join.
- **Language** — detected automatically (and remembered), or chosen from the
  microphone's ▾ menu.
- **Voice commands** (English) — "new line", "new paragraph", "comma", "period",
  "question mark", "open quote" … "close quote", "scratch that" (removes the last
  phrase), "bullet list", "numbered list", "heading one" … "normal text", and "stop
  dictation".
- Click anywhere in the document while dictating to move where the text goes; each
  phrase is one undo step.

**Export and print**

- **Export** — PDF, Word (.docx), web page (.html, with images embedded), Markdown and
  plain text, each through a Save dialog; afterwards the title row offers **Open** and
  **Show in folder**. Word export keeps the page size, margins, indents, header/footer
  and comments.
- **PDF** is written directly, without a print dialog and without the browser's own
  date/title header and footer.
- **Print** (`Ctrl+P`) uses the same page layout.

### Customization

Settings (gear icon) is organized into sections — Appearance, Recording, Storage,
Annotation, Files, and PDF Annotator:

- **Appearance** — light/dark/system theme, and the home screen's background style
  (a subtle graph-paper-line backdrop, or plain).
- **Recording** — default recording type, output format, and file name prefix.
- **Storage** — relocate where Briefcast stores its files via a folder picker (with a
  reset-to-default option); the file list refreshes automatically after a move.
- **Annotation** — turn presentation annotation on or off, show or hide its toolbar,
  and pick the ink: colour (palette or custom), size, style, fade time and an optional
  drop shadow, with a live preview. Changes apply the next time draw mode opens.
- **PDF Annotator** — starting tool, default zoom, pen/highlighter color, stroke width.
- **Files** — trash auto-purge retention.

## Keyboard shortcuts

| Context | Keys | Action |
|---|---|---|
| Global | `Ctrl+Shift+D` | Start/stop drawing on screen (presentation annotation) |
| | `Ctrl+Shift+R` | Start/stop a recording with your current settings |
| | `Alt+Shift+S` | Take a screenshot |
| | `Ctrl+Shift+B` | Show/hide the recording buttons at the bottom right |
| | `Ctrl+Shift+H` | Show/hide the floating recording overlay (while recording) |
| | `Alt+Shift+V` | Switch between screen and camera (while recording, when available) |
| Drawing on screen | `Esc` | Stop drawing |
| | `Backspace` / `Delete` | Clear the screen |
| | `1`–`8` | Pick a colour |
| | `P` / `M` / `N` / `L` | Pen / Marker / Neon / Laser |
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
| | `,` / `.` | Previous/next frame |
| | `Shift+P` / `Shift+N` | Previous/next file |
| | `?` | Show all player shortcuts |
| PDF viewer | `V` / `P` / `H` / `T` / `E` | Select / Pen / Highlighter / Text / Eraser |
| | `←` `→` | Previous/next page |
| | `B` | Toggle two-page spread |
| | `F` | Fullscreen presentation mode (`Esc` to exit) |
| | `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in/out/reset |
| | `[` / `]` | Decrease/increase stroke width |
| Whiteboard | `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Undo / redo |
| | `Ctrl+C` / `Ctrl+V` | Copy the selected shapes / paste the last thing copied (shapes, a screenshot or image, or text) |
| | `Ctrl+A` | Select every shape and connector on the page |
| | `Delete` / `Backspace` | Delete the selection |
| | `←` `→` `↑` `↓` | Nudge the selection (hold Shift for 10px) |
| | `Esc` | Deselect, or cancel the currently armed tool |
| Mindmap | `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Undo / redo |
| | `Ctrl+C` / `Ctrl+V` | Copy the selected nodes / paste the last thing copied (nodes, a screenshot or image, or text) |
| | `Delete` / `Backspace` | Delete the selection |
| | `Space` (hold) | Drag to pan the canvas |
| | `Esc` | Deselect, or leave the inline label editor |
| Docs | `Ctrl+B` / `Ctrl+I` / `Ctrl+U` | Bold / italic / underline |
| | `Alt+Shift+5` | Strikethrough |
| | `Ctrl+K` | Add or edit a link |
| | `Ctrl+F` | Find and replace |
| | `Ctrl+S` | Save now |
| | `Ctrl+P` | Print |
| | `Ctrl+Enter` | Page break |
| | `Ctrl+]` / `Ctrl+[` | Increase / decrease indent |
| | `Ctrl+Shift+L` / `E` / `R` / `J` | Align left / centre / right / justify |
| | `Ctrl+Shift+8` / `Ctrl+Shift+7` | Bulleted / numbered list |
| | `Ctrl+\` | Clear formatting |
| | `Ctrl+Shift+S` | Start/stop voice typing |
| | `/` | Insert a block ("/" menu) |
| | `Esc` | Leave highlighter mode |
| Docs rulers | Drag / `Alt`+drag / `Esc` | Move a marker (snapped) / move freely / cancel |
| | `←` `→` (`Alt`, `Shift`) | Nudge the focused marker by one step (0.01 / ½ inch) |

## Known limitations

- **Global shortcuts can be taken by other apps.** If another running app already owns
  one of the global shortcuts above, Briefcast shows an error saying so and that
  shortcut won't work until the other app releases it.
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
button, when no subtitle file already exists) and Docs voice typing need a bundled offline
speech-to-text engine at `src-tauri/binaries/whisper/` — same deal again.

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

Auto-generated captions and Docs voice typing use [whisper.cpp](https://github.com/ggml-org/whisper.cpp) as a
plain bundled CLI binary - not a Rust crate, so there's no C++ toolchain needed to build
this project itself. Download the CPU-only Windows build from its
[releases page](https://github.com/ggml-org/whisper.cpp/releases) (the
`whisper-bin-x64.zip` asset - avoid the `-blas`/`-cublas` variants, which need matching
GPU drivers/libraries this app doesn't otherwise depend on) and copy `whisper-cli.exe`
plus `whisper.dll`, `ggml.dll`, `ggml-base.dll`, and every `ggml-cpu-*.dll` into
`src-tauri/binaries/whisper/`. The speech model itself isn't bundled: the first caption or
dictation run downloads `ggml-base.bin` (the multilingual model, ~148 MB, checked against a
pinned SHA-256) from
[the ggml-org/whisper.cpp model repo on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp)
into `%LOCALAPPDATA%\com.withbriefs.briefcast\whisper\`, showing download progress.

The audio cleanup tool's "Remove noise" mode exports through ffmpeg's `arnndn` filter, which
needs an RNNoise model file: download
[`bd.rnnn`](https://raw.githubusercontent.com/GregorR/rnnoise-models/master/beguiling-drafter-2018-08-30/bd.rnnn)
(~300KB, from GregorR/rnnoise-models - trained on voice over recording noise) into
`src-tauri/binaries/rnnoise/`. Without it, export falls back to the spectral `afftdn` filter.

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
- **Whiteboards** are saved one folder per board under
  `%USERPROFILE%\Videos\Briefcast\Whiteboards\` (a `whiteboard.json` document plus a
  cached `thumbnail.png`); PNG exports go to `%USERPROFILE%\Videos\Briefcast\Whiteboard\`.
- **Mindmaps** follow the same pattern, one folder per mindmap under
  `%USERPROFILE%\Videos\Briefcast\Mindmaps\` (a `mindmap.json` document, a cached
  `thumbnail.png`, and an `assets/` folder holding a copy of every image placed on it);
  PNG/PDF exports go to `%USERPROFILE%\Videos\Briefcast\Mindmap\`.
- **Docs** are saved one folder per document under `%USERPROFILE%\Videos\Briefcast\Docs\`
  (`doc.bin` content, `meta.json` with title, folder, link and page setup, `comments.json`,
  an `assets/` folder for images and a `versions/` folder of snapshots), with
  `folders.json` for the folder tree, `search.db` for full-text search, and deleted
  documents in a hidden `.trash` folder. Exports go wherever you choose in the Save dialog.
- **The speech model** for captions and voice typing is downloaded to
  `%LOCALAPPDATA%\com.withbriefs.briefcast\whisper\` on first use.
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
│   │   ├── video/                   # Video editor landing screen + overlay editing surface (text/image overlays, crop panel)
│   │   ├── whiteboard/              # Whiteboard canvas, style panel, table/lattice widgets (see Whiteboard)
│   │   ├── mindmap/                 # Mindmap canvas, component palette, inspector, Live View (see Mindmap)
│   │   ├── docs/                    # Docs: documents page, editor, toolbar, rulers, comments, version history, page setup (see Docs)
│   │   ├── Modals/                  # Settings and recording-completed modals
│   │   ├── custom/                  # Small shared UI primitives (toasts, dropdowns, alerts)
│   │   ├── BottomDocker.tsx         # Switches between the docker/ panels above
│   │   ├── ActiveRecordingState.tsx # Fixed bottom icon bar (folder/open/home/tools/settings) + recording controls
│   │   ├── VideoPlayer.tsx          # Video/audio/image player
│   │   └── PdfAnnotator.tsx         # PDF viewer + markup surface
│   ├── handlers/
│   │   ├── videoEditHandlers.ts     # Pure-function overlay/clip CRUD shared by the video edit store
│   │   ├── whiteboardHandlers.ts    # Pure-function shape geometry, connector routing, graph/chart math
│   │   └── mindmapHandlers.ts       # Pure-function mindmap geometry, edge routing, add-topic placement
│   ├── hooks/
│   │   ├── useVideoEditStore.ts     # Video edit state, undo/redo, export, sidecar persistence
│   │   ├── useWhiteboardStore.ts    # Whiteboard document state, per-page undo/redo
│   │   ├── useMindmapStore.ts       # Mindmap document state, undo/redo, debounced autosave
│   │   ├── useDocsEditStore.ts      # Docs document (Yjs) state, autosave, versions, comments, page setup
│   │   ├── useDocDictation.ts       # Docs voice typing: microphone, pause detection, whisper queue
│   │   └── useClampedPopoverPosition.ts # Keeps floating overlay popovers inside the viewport
│   ├── contexts/ThemeContext.tsx    # Light/dark/system theme
│   └── utils/                       # Formatting, file-category, media-handling, video overlay/render, whiteboard/mindmap helpers, and the Docs editor extensions (doc*.ts: pagination, indents, dictation, highlighter, .docx import/export, Markdown)
├── src-tauri/                        # Rust backend
│   ├── src/
│   │   ├── main.rs                  # Entry point, logging, window/command setup
│   │   ├── commands/
│   │   │   ├── recording.rs         # Recording/screenshot start/stop, FFmpeg process management
│   │   │   ├── recording/           # Per-OS capture backends (win/macos/linux)
│   │   │   ├── conversion.rs        # Media format conversion
│   │   │   ├── window_capture.rs    # Window/monitor enumeration, window thumbnails
│   │   │   └── snip.rs              # Snipping-style screenshot overlay
│   │   ├── services/
│   │   │   ├── utility.rs           # Shared helpers, file/folder listing, rename, move, path utils
│   │   │   ├── trash.rs             # Soft delete, restore, empty, auto-purge
│   │   │   ├── pdf_annotations.rs   # PDF annotation persistence
│   │   │   ├── loopback_audio.rs    # WASAPI loopback (system audio) capture
│   │   │   ├── whiteboards.rs       # Whiteboard document CRUD, thumbnails, PNG export
│   │   │   ├── mindmaps.rs          # Mindmap document CRUD, thumbnails, image assets, PNG/PDF export
│   │   │   ├── docs.rs              # Docs CRUD, folders, trash, versions, comments, links, page setup, export (incl. direct PDF)
│   │   │   ├── docs_search.rs       # Docs full-text search index (SQLite FTS5)
│   │   │   └── whisper_model.rs     # Downloads/verifies the whisper speech model on first use
│   │   └── views/                   # Standalone window (recording-completed popup)
│   ├── binaries/ffmpeg/             # Bundled ffmpeg/ffprobe/ffplay
│   ├── binaries/heif/               # Bundled libheif (heif-dec.exe + DLLs) - HEIC/HEIF fallback decode
│   ├── binaries/whisper/            # Bundled whisper.cpp CLI + DLLs - captions and Docs voice typing (model downloaded on first use)
│   ├── binaries/rnnoise/            # bd.rnnn RNNoise model - arnndn for the audio cleanup tool's "Remove noise" export
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

**"Failed to resolve whisper-cli at ..." when generating captions or dictating**
Same as above but for `src-tauri/binaries/whisper/whisper-cli.exe` — see
[Getting started](#getting-started) for how to obtain it. This path only gets hit when
you explicitly choose "Generate captions from audio" (and no sibling .vtt/.srt file
exists for the video) or start voice typing in Docs. The first such run also downloads
the speech model, so it needs an internet connection once.

**Voice typing says "Microphone permission denied" or "No microphone found"**
Check that a microphone is connected and enabled in Windows (Settings → Privacy &
security → Microphone, with desktop apps allowed).

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
