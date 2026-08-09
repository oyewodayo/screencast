// Dashboard.tsx
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import * as Y from "yjs";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { open as openFileDialog, message as showMessageDialog } from "@tauri-apps/api/dialog";
import BottomDocker from "../components/BottomDocker";
import { listen } from '@tauri-apps/api/event';
import { WindowInfo } from "../Types";
import { WebviewWindow, appWindow } from '@tauri-apps/api/window';
import { register, unregister, isRegistered } from '@tauri-apps/api/globalShortcut';
import { formatFileName } from "../utils/Formater";
import VideoPlayer, { VideoPlayerHandle } from "../components/VideoPlayer";
import useVideoEditStore from "../hooks/useVideoEditStore";
import useImageEditStore from "../hooks/useImageEditStore";
import VideoOverlayLayer from "../components/video/VideoOverlayLayer";
import ClipCropOverlay from "../components/video/ClipCropOverlay";
import { ActiveClipEffects } from "../utils/videoColorFilters";
import ConversionDialog from "../components/ConversionDialog";
import PdfAnnotator from "../components/PdfAnnotator";
import ImageEditor from "../components/ImageEditor";
import BoardWorkspace, { BoardScreen } from "../components/board/BoardWorkspace";
import DocsWorkspace, { DocsScreen } from "../components/docs/DocsWorkspace";
import { DocSummary } from "../utils/docTypes";
import SettingsModal from "../components/Modals/SettingsModal";
import Toast from "../components/custom/Toast";
import { AppSettings, loadSettings } from "../utils/appSettings";
import { FileCategory, FILE_CATEGORY_EXTENSIONS, getFileCategory, isConvertibleCategory } from "../utils/fileCategory";
import {
  MAX_HOME_SCREEN_FILES,
  getPinnedPaths,
  getRecentPaths,
  togglePin,
  recordFileOpened,
  repathFile,
  forgetFile,
} from "../utils/homeScreenFiles";
import {
  IoVideocam,
  IoMusicalNotes,
  IoImage,
  IoDocumentText,
  IoChevronBack,
  IoChevronForward,
  IoRepeatOutline,
  IoShuffleOutline,
  IoPlayForwardOutline,
  IoTrashOutline,
  IoArrowUndoOutline,
  IoFolderOutline,
  IoAddCircleOutline,
  IoBuildOutline,
  IoPin,
  IoRefresh,
  IoSearch,
  IoClose,
} from "react-icons/io5";
import { MdCreateNewFolder, MdOutlineDescription } from "react-icons/md";

type RAMInfo = [number, number];

const FILE_CATEGORY_TABS: { category: FileCategory; label: string; icon: React.ReactNode }[] = [
  { category: "video", label: "Video", icon: <IoVideocam size={18} /> },
  { category: "audio", label: "Audio", icon: <IoMusicalNotes size={18} /> },
  { category: "image", label: "Image", icon: <IoImage size={18} /> },
  { category: "pdf", label: "Pdf", icon: <IoDocumentText size={18} /> },
];

// The sidebar's active tab is either a real file category or the Trash view — the latter isn't
// a FileCategory (getFileCategory never returns it; it's a distinct data source, not an
// extension-based filter over `files`), so it gets its own type rather than being folded in.
type SidebarTab = FileCategory | "trash";

interface TrashEntry {
  trashed_name: string;
  name: string;
  original_path: string;
  deleted_at: number; // unix seconds
}

const formatDeletedAt = (unixSeconds: number): string => {
  const diffDays = Math.floor((Date.now() - unixSeconds * 1000) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
};

// Filters shown in the native "open file" dialog — same extensions the sidebar already
// understands, so anything pickable there is guaranteed playable/viewable here too.
const OPEN_FILE_DIALOG_FILTERS = [
  { name: "All supported files", extensions: Object.values(FILE_CATEGORY_EXTENSIONS).flat() },
  { name: "Video", extensions: FILE_CATEGORY_EXTENSIONS.video },
  { name: "Audio", extensions: FILE_CATEGORY_EXTENSIONS.audio },
  { name: "Image", extensions: FILE_CATEGORY_EXTENSIONS.image },
  { name: "PDF", extensions: FILE_CATEGORY_EXTENSIONS.pdf },
];

// Toggles the recording-overlay window's visibility. Registered as an OS-level hotkey via
// Tauri's globalShortcut API (backed by RegisterHotKey) while a recording is in progress -
// this only ever fires for this exact key combo, unlike a low-level keyboard hook that would
// see every keystroke system-wide.
const OVERLAY_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+H';

const toggleOverlayVisibility = async () => {
  const overlayWindow = WebviewWindow.getByLabel('recording-overlay');
  if (!overlayWindow) return;
  if (await overlayWindow.isVisible()) {
    await overlayWindow.hide();
  } else {
    await overlayWindow.show();
  }
};

// Toggles the system-wide stylus annotation overlay's "draw mode" - unlike the recording overlay
// above, this one is available any time (not gated on an active recording), so its hotkey is
// registered/unregistered purely based on the enableAnnotationTool setting (see the effect that
// watches annotationEnabled below), not recording state.
const ANNOTATION_TOGGLE_SHORTCUT = 'CommandOrControl+Shift+D';
// Hard kill switch, independent of the Settings checkbox/localStorage. Confirmed on 2026-07-21:
// flipping this to false reliably hangs the whole app (Briefcast.exe stops responding, verified via
// Get-Process -> Responding: False) on first launch, right as ensure_annotation_overlay
// (annotation.rs) creates the overlay window - it appears in the window list but the app never
// gets past window.set_position()/set_size() afterward. This is a real deadlock, not just the
// click-through issue the surrounding comments describe, and reproduced twice in a row on a 4K/2.5x
// scaled display. Root cause not yet found - likely something in tauri::WindowBuilder::build() or
// the physical set_position/set_size calls blocking the main event loop thread from an async
// command context. Do not flip this without first fixing that deadlock and confirming
// ensure_annotation_overlay can return successfully (add temporary eprintln checkpoints around the
// build()/set_position()/set_size() calls in annotation.rs and watch `npm run tauri dev`'s output -
// the run stops dead between the bounds log line and a final success log line).
const ANNOTATION_FEATURE_DISABLED = true;
// How long to keep the overlay window shown (but click-through) after draw mode turns off, so a
// stroke that's still fading gets to finish instead of vanishing instantly. Covers
// AnnotationOverlayWindow.tsx's FADE_HOLD_MS (1200) + FADE_OUT_MS (1400) with margin.
const ANNOTATION_FADE_GRACE_MS = 3000;

interface FileEntry {
    name: string;
    path: string;
}

interface FileMap {
    [folder: string]: FileEntry[]
}

const Dashboard = () => {
  const [message, setMessage] = useState<string>("");
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  const [error, setError] = useState<string>("");
  const [ramInfo, setRamInfo] = useState<RAMInfo | null>(null);
  const [fileName, setFileName] = useState(
    () => loadSettings().defaultFileNamePrefix + "_" + new Date().toLocaleDateString().replace(/\//g, "_")
  );
  const [fileExt, setFileExt] = useState(() => loadSettings().defaultFileExt);
  const [recordType, setRecordType] = useState(() => loadSettings().defaultRecordType);
  const [showSettings, setShowSettings] = useState<boolean>(false);

  // The main window is created hidden (tauri.conf.json's "visible": false on the main window
  // entry) specifically so this can show it only once there's real, already-painted UI behind it
  // to reveal - showing it immediately on native window creation (the default) meant the window
  // appeared before WebView2 had finished loading/painting the bundled app, showing its own blank
  // default background (black) for a beat first. A hidden window's webview still loads and paints
  // normally in the background, so by the time this effect fires (useEffect intentionally, not
  // useLayoutEffect - it's deferred until *after* the browser has actually painted this render),
  // there's already a fully rendered frame ready to reveal instantly instead of a flash of black.
  // Scoped correctly to only the main window: Dashboard only ever mounts on the "/" route (see
  // App.tsx's router), never in the recording-overlay/screenshot-overlay/annotation-overlay
  // windows, which manage their own visibility entirely separately.
  useEffect(() => {
    const revealWindow = (): void => {
      appWindow.show().catch((err) => console.error("Failed to show main window:", err));
      appWindow.setFocus().catch((err) => console.error("Failed to focus main window:", err));
    };
    revealWindow();
    // Safety net: showing an already-visible window is a harmless no-op, so retrying shortly
    // after is free insurance against this specific call failing/never resolving for some
    // reason - a bug in this effect must never be able to leave the user with an app that looks
    // like it silently failed to launch (permanently hidden behind nothing).
    const fallbackTimer = window.setTimeout(revealWindow, 1500);
    return () => window.clearTimeout(fallbackTimer);
  }, []);
  // Presentation mode for the PDF viewer: hides the sidebar and BottomDocker (not just the PDF's
  // own toolbar, which PdfAnnotator hides itself) and puts the actual OS window into fullscreen,
  // so it reads as a real presentation rather than just a bigger PDF pane with app chrome still
  // visible around it.
  const [isPdfFullscreen, setIsPdfFullscreen] = useState<boolean>(false);
  const [audioDevice, setAudioDevice] = useState("");
  const [videoDevices, setVideoDevices] = useState<string[]>([]);
  const [selectScreen, setSelectScreen] = useState(false);
  const [selectedScreen, setSelectedScreen] = useState("");
   const [screenSize, setScreenSize] = useState("fullscreen");
     const [overlayShape, setOverlayShape] = useState("rounded"); // ADD THIS
  const [overlayPosition, setOverlayPosition] = useState("bottom_right"); // ADD THIS
  const [overlaySize, setOverlaySize] = useState("small"); // ADD THIS
  // WASAPI loopback ("what you hear") capture, Windows-only - see start_recording's handling of
  // FormData.include_system_audio and services/loopback_audio.rs for why this exists (dshow alone
  // can't capture system audio on a machine with no Stereo Mix-equivalent device). Only
  // meaningful for the screen-capture record types (sva/sa/s); RecordingDocker only shows the
  // toggle for those.
  const [includeSystemAudio, setIncludeSystemAudio] = useState<boolean>(false);
  const [windowTitles, setWindowTitles] = useState<WindowInfo[]>([]);
  const [isMonitoring, setIsMonitoring] = useState<boolean>(false);
  const [showFileList, setShowFileList] = useState<boolean>(false);
  const [files, setFiles] = useState<FileMap>({});
  const [activeFileCategory, setActiveFileCategory] = useState<SidebarTab>("video");
  const [trashItems, setTrashItems] = useState<TrashEntry[]>([]);
  // Sidebar file-list search - filters the active category's files (and trash) by name, case-
  // insensitive substring match. Kept as a single query shared across every tab/trash rather than
  // per-tab state, same as a normal file explorer's search box.
  const [fileSearchQuery, setFileSearchQuery] = useState<string>("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  // Pinned + recently-opened file paths behind the home screen's "From your library" preview —
  // see utils/homeScreenFiles.ts. Mirrored into React state (rather than read fresh from
  // localStorage on every render) so toggling a pin or opening a file re-renders that preview.
  const [pinnedPaths, setPinnedPaths] = useState<string[]>(() => getPinnedPaths());
  const [recentPaths, setRecentPaths] = useState<string[]>(() => getRecentPaths());
  // Which Board screen (if any) is showing in the main content pane - null means Board mode is
  // off entirely (showing the normal selectedFile/home content instead). See handleOpenBoard.
  const [boardScreen, setBoardScreen] = useState<BoardScreen | null>(null);
  // Which Docs screen (if any) is showing in the main content pane - same null-means-off pattern
  // as boardScreen. See handleOpenDocs.
  const [docsScreen, setDocsScreen] = useState<DocsScreen | null>(null);
  // Every doc's summary (id/title/linked_to/etc.), refreshed via refreshDocsIndex - backs both the
  // "Link to recording" picker's libraryFiles-independent state and the per-file "has linked
  // notes" badge/menu below, from one list_docs call rather than one find_docs_linked_to per row.
  const [docsIndex, setDocsIndex] = useState<DocSummary[]>([]);
  // "Link notes" flyout inside a file's 3-dot menu when 2+ docs are already linked to it - same
  // expand-in-place pattern as moveMenuOpenFor.
  const [linkDocsMenuOpenFor, setLinkDocsMenuOpenFor] = useState<string | null>(null);
  // Spins the sidebar's manual refresh icon while a refresh is in flight — see handleRefreshFiles.
  const [isRefreshingFiles, setIsRefreshingFiles] = useState<boolean>(false);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  // "Move to ▸" flyout inside a file's 3-dot menu — keyed by file.path, separate from openMenu
  // so it can be nested inside that same popup instead of needing its own positioning.
  const [moveMenuOpenFor, setMoveMenuOpenFor] = useState<string | null>(null);
  // Folder relative-path (see FileMap's keys) whose inline "new folder" input is active, or null
  // if none is. "" means creating a top-level folder directly under Briefcast.
  const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null);
  const [newFolderValue, setNewFolderValue] = useState<string>("");
  // Folder relative-paths whose file list is currently hidden - in-memory only (resets on
  // restart), same as every other sidebar UI toggle here. A folder isn't in this set until
  // explicitly collapsed, so everything starts expanded, matching the pre-existing behavior.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const toggleFolderCollapsed = (folder: string): void => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  };
  // Drag-and-drop move: the file(s) currently being dragged (more than one if the dragged file
  // was part of the active multi-selection below), and whichever folder header the pointer is
  // presently over (for the drop-target highlight). Both null outside a drag gesture.
  const [draggingFiles, setDraggingFiles] = useState<FileEntry[] | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  // Sidebar-file-to-timeline dragging runs on plain pointer events, not the native HTML5 drag-and-
  // drop API (draggable/onDragStart/onDrop) that the folder-move feature above uses - the same
  // root cause as the external Explorer-drag investigation turned out to be broader than just
  // "cross-window drags": this app's window has a native OS-level drop-target hook registered
  // (needed for onFileDropEvent, the only way to get real filesystem paths out of an external
  // drop at all), and that hook appears to take over drag handling for the whole webview, not just
  // drags that cross a window boundary - confirmed by this exact pattern (native DnD -> plain
  // pointer events) being what got clip-reordering inside the timeline itself working earlier.
  // The click-vs-drag threshold mirrors VideoTimelineDocker's own clip-drag handling: a plain tap
  // still opens/plays the file, it only becomes a drag once the pointer moves a few px.
  const SIDEBAR_DRAG_THRESHOLD_PX = 4;
  const sidebarDragRef = useRef<{ file: FileEntry; startX: number; startY: number; isDragging: boolean } | null>(null);

  const handleSidebarFilePointerDown = (file: FileEntry) => (e: React.PointerEvent) => {
    if (getFileCategory(file.name) !== "video") return; // only meaningful for the video timeline
    e.currentTarget.setPointerCapture(e.pointerId);
    sidebarDragRef.current = { file, startX: e.clientX, startY: e.clientY, isDragging: false };
  };
  const handleSidebarFilePointerMove = (e: React.PointerEvent) => {
    const drag = sidebarDragRef.current;
    if (!drag) return;
    if (!drag.isDragging && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) >= SIDEBAR_DRAG_THRESHOLD_PX) {
      drag.isDragging = true;
      setDraggingFiles([drag.file]);
    }
  };
  const handleSidebarFilePointerUp = (file: FileEntry) => (e: React.PointerEvent) => {
    const drag = sidebarDragRef.current;
    sidebarDragRef.current = null;
    if (!drag?.isDragging) {
      // No real drag happened - a plain tap, handled the same as clicking the filename always has.
      handleFileClick(file);
      return;
    }
    setDraggingFiles(null);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el?.closest("[data-timeline-track]")) {
      setPendingTimelineInsert({ paths: [file.path], clientX: e.clientX });
    }
  };
  // Multi-select for bulk move — a set of file.path values, spanning whichever folders are
  // currently visible under the active category. Cleared whenever the category tab changes so
  // a stale selection from "Video" doesn't silently carry over into "Audio".
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set());
  const [bulkMoveMenuOpen, setBulkMoveMenuOpen] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; sourcePath: string } | null>(null);
  // Lifted here (single call site - useVideoEditStore is a stateful hook, unsafe to call from
  // more than one component) so both the video-tools timeline (via BottomDocker/FileToolsDocker/
  // VideoTimelineDocker) and the text-overlay preview layer mounted alongside VideoPlayer below
  // share the exact same edit state/undo-redo stack. Gated to video files only so selecting a
  // pdf/audio/image never triggers a wasted load_video_edit_state invoke.
  const editStore = useVideoEditStore(
    selectedFile && getFileCategory(selectedFile.name) === "video" ? selectedFile.sourcePath : undefined
  );
  // Gated to image files only so selecting a pdf/audio/video never triggers a wasted
  // load_image_edit_state invoke.
  const isImageFileSelected = !!selectedFile && getFileCategory(selectedFile.name) === "image";
  const imageEditStore = useImageEditStore(
    isImageFileSelected ? selectedFile!.sourcePath : undefined,
    isImageFileSelected ? selectedFile!.path : undefined
  );
  // Text-overlay UI state - lifted here (rather than local to either subtree) because it's shared
  // by two siblings: the preview-layer editor mounted next to VideoPlayer below, and the timeline
  // lane's chips inside VideoTimelineDocker (reached via BottomDocker/FileToolsDocker).
  const [currentOutputTime, setCurrentOutputTime] = useState<number>(0);
  // The active clip's own color grade/Ken Burns fields, reported up by VideoTimelineDocker
  // (onActiveClipChange) and threaded straight into VideoPlayer (activeClipEffects) - same "held
  // in Dashboard state, passed to both the timeline docker and the sibling player" shape as
  // currentOutputTime just above.
  const [activeClipEffects, setActiveClipEffects] = useState<ActiveClipEffects | null>(null);
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [isPlacingText, setIsPlacingText] = useState<boolean>(false);
  const [selectedImageOverlayId, setSelectedImageOverlayId] = useState<string | null>(null);
  const [isPlacingImage, setIsPlacingImage] = useState<boolean>(false);
  const [selectedBlurOverlayId, setSelectedBlurOverlayId] = useState<string | null>(null);
  const [isPlacingBlur, setIsPlacingBlur] = useState<boolean>(false);
  // Arms the on-canvas crop tool (ClipCropOverlay, mounted as a sibling to VideoOverlayLayer just
  // below) - unlike the placement tools above, there's no "consumed" step, it just shows/hides a
  // drag window over whichever clip activeClipEffects currently points at. Deliberately NOT reset
  // when the active CLIP changes within the same file's timeline (playhead crossing a cut, or a
  // new clip getting selected) - it's meant to follow whichever clip is on screen, per its own
  // comment above. Only reset when the open FILE itself changes, below.
  const [isCroppingClip, setIsCroppingClip] = useState<boolean>(false);
  useEffect(() => {
    setIsCroppingClip(false);
  }, [selectedFile?.path]);
const [conversionFile, setConversionFile] = useState<{path: string; name: string} | null>(null);
  // What BottomDocker's collapsible panel shows: the default recording-setup controls, or quick
  // tools (rename/convert/reveal/delete + at-a-glance info) for whichever file is currently open.
  // Toggled from the sidebar header's tools icon (next to "new folder"); falls back to "record"
  // whenever there's no open file to show tools for, so it never gets stuck on an empty panel.
  const [dockerMode, setDockerMode] = useState<"record" | "file-tools">("record");
  useEffect(() => {
    if (!selectedFile) setDockerMode("record");
  }, [selectedFile]);
  // Lets the video-tools timeline (FileToolsDocker -> VideoTimelineDocker) seek the actual player
  // imperatively — there's no controlled "currentTime" prop on VideoPlayer, since native
  // <video>/timeupdate already reports position out via onTimeUpdate below; this ref is just the
  // one missing direction back in. Playhead position itself is tracked in state (not read
  // straight off the ref) so the timeline re-renders as playback advances.
  const videoPlayerRef = useRef<VideoPlayerHandle>(null);
  const [playerCurrentTime, setPlayerCurrentTime] = useState<number>(0);
  // Mirrors playerCurrentTime's round-trip, but for play/pause state - lets the video-tools
  // timeline show an accurate Play/Pause icon and toggle real playback from its own transport
  // button, the same way its playhead already tracks and drives the real player.
  const [playerIsPlaying, setPlayerIsPlaying] = useState<boolean>(false);
  useEffect(() => {
    setPlayerCurrentTime(0);
    setPlayerIsPlaying(false);
    // A cross-clip preview switch (see resolvePreviewAssetUrl/handleSeekActiveFile below) may have
    // left the player pointed at some *other* file's asset URL - opening a genuinely different
    // file here always starts fresh, so the "what's actually loaded" tracker needs to reset too.
    previewSourcePathRef.current = selectedFile?.sourcePath ?? null;
  }, [selectedFile?.path]);

  // Asset URLs for files referenced by a timeline clip other than the one currently open -
  // resolved on demand (same convert_file_path_to_url + convertFileSrc round-trip
  // loadFileForPlayback already does for the primary file) and cached forever per path, since a
  // given file's asset URL never changes for the life of the app.
  const previewAssetUrlCacheRef = useRef<Map<string, string>>(new Map());
  // Which source file's content is actually loaded into the player right now - starts matching
  // selectedFile.sourcePath, but a cross-clip preview seek (see handleSeekActiveFile below) can
  // point it at a different file entirely without touching selectedFile itself.
  const previewSourcePathRef = useRef<string | null>(null);

  const resolvePreviewAssetUrl = async (sourcePath: string): Promise<string> => {
    const cached = previewAssetUrlCacheRef.current.get(sourcePath);
    if (cached) return cached;
    const absolutePath = await invoke<string>("convert_file_path_to_url", { filepath: sourcePath });
    const url = convertFileSrc(absolutePath);
    previewAssetUrlCacheRef.current.set(sourcePath, url);
    return url;
  };

  // The video-tools timeline's own seek, extended to know *which file* it's seeking within -
  // once a clip can be dragged in from a different file than the one currently open, "seek to
  // this time" is ambiguous without also saying which file's timeline that time belongs to. Swaps
  // the player's actual source (via the imperative loadSource, not the `src` prop/selectedFile -
  // see VideoPlayerHandle's own comment for why) only when the target differs from what's already
  // loaded, so scrubbing within the same clip stays a plain, cheap seek.
  const handleSeekActiveFile = (sourcePath: string, time: number) => {
    if (previewSourcePathRef.current === sourcePath) {
      videoPlayerRef.current?.seek(time);
      return;
    }
    previewSourcePathRef.current = sourcePath;
    if (sourcePath === selectedFile?.sourcePath) {
      // Back to the primary file - its asset URL is already resolved (selectedFile.path).
      videoPlayerRef.current?.loadSource(selectedFile.path, time);
      return;
    }
    resolvePreviewAssetUrl(sourcePath)
      .then((url) => videoPlayerRef.current?.loadSource(url, time))
      .catch((error) => console.error("Failed to load preview source for", sourcePath, error));
  };
  // Audio playlist controls (repeat/shuffle/autoplay-next) — see navigateAudio/handleAudioEnded.
  const [audioRepeatMode, setAudioRepeatMode] = useState<"off" | "all" | "one">("off");
  const [audioShuffle, setAudioShuffle] = useState<boolean>(false);
  const [audioAutoplayNext, setAudioAutoplayNext] = useState<boolean>(true);
  // Video autoplay-next-file — mirrors audioAutoplayNext, but there's no video repeat/shuffle UI,
  // so it's just the one flag. Driven by VideoPlayer's own Autoplay button/settings row (it can't
  // hold this itself since it fully remounts on every file change via `key={selectedFile.path}`).
  const [videoAutoplayNext, setVideoAutoplayNext] = useState<boolean>(true);
  // Whether the system-wide annotation overlay is allowed to exist at all this session — see
  // handleSettingsSaved and the effect below that creates/hides the overlay window and
  // registers/unregisters ANNOTATION_TOGGLE_SHORTCUT whenever this changes.
  const [annotationEnabled, setAnnotationEnabled] = useState<boolean>(() => loadSettings().enableAnnotationTool);
  // The "Nothing playing yet" home screen's backdrop (Settings > Appearance > "Home screen
  // background") - see the decorative block a few hundred lines down in this file's JSX.
  const [homeBackgroundStyle, setHomeBackgroundStyle] = useState<AppSettings["homeBackgroundStyle"]>(() => loadSettings().homeBackgroundStyle);
  // Mirrors whether the overlay is currently in "draw mode" (capturing input) vs click-through.
  // A ref, not state — read inside the global-shortcut callback and the turn-off-request
  // listener, both registered once and needing the *current* value, not whatever was in scope
  // when they were set up.
  const annotationDrawModeRef = useRef<boolean>(false);
  // Pending "hide the overlay" timeout scheduled when draw mode turns off (see
  // toggleAnnotationDrawMode) — tracked so a quick off-then-on re-toggle can cancel it instead of
  // hiding a window the user just turned drawing back on for.
  const annotationHideTimeoutRef = useRef<number | null>(null);

  // Last known playback position per audio file (keyed by sourcePath), so switching away and
  // back — including by accident via prev/next — resumes instead of restarting at 0. A ref, not
  // state: it's written on every timeupdate tick and shouldn't trigger re-renders.
  const audioPositionsRef = useRef<Record<string, number>>({});
  // Sourcepaths visited while shuffle is on, so "previous" can undo a shuffled "next" instead of
  // computing a sequential-order previous that wouldn't match what was actually just played.
  const shuffleHistoryRef = useRef<string[]>([]);
  // Lets stable (useCallback, empty-deps) callbacks passed down to VideoPlayer read whichever
  // file is *currently* selected without needing to be recreated every time it changes.
  const selectedFileRef = useRef(selectedFile);
  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);


useEffect(() => {
  const setupListener = async () => {
    const unlisten = await listen('recording-stopped', async () => {
      console.log('Recording stopped from overlay window');
      
      // Play stop sound
      const audio = new Audio("/sounds/option-3.mp3");
      audio.play().catch(err => console.error("Error playing audio:", err));
      
      // Update main window state
      setIsRecording(false);
      setRecordingStartTime(null);
      setMessage("Recording stopped");
      
      // Stop monitoring if active
      if (isMonitoring) {
        try {
          await invoke("stop_monitoring_windows");
          setIsMonitoring(false);
          console.log("Monitoring stopped");
        } catch (error) {
          console.error("Error stopping monitoring:", error);
        }
      }
      
      // Hide the overlay window and drop the toggle shortcut now that there's nothing to show
      const overlayWindow = WebviewWindow.getByLabel('recording-overlay');
      if (overlayWindow) {
        await overlayWindow.hide();
      }
      if (await isRegistered(OVERLAY_TOGGLE_SHORTCUT)) {
        await unregister(OVERLAY_TOGGLE_SHORTCUT);
      }
    });
    
    return unlisten;
  };

  let unlistenFn: (() => void) | undefined;
  setupListener().then(fn => {
    unlistenFn = fn;
  });

  return () => {
    if (unlistenFn) {
      unlistenFn();
    }
  };
}, [isMonitoring]); 

  // Get RAM info
  useEffect(() => {
    invoke<RAMInfo>('get_ram_info')
      .then(setRamInfo)
      .catch(console.error);
  }, []);

  // The "Convert format" button in the recording-completed popup (a separate Tauri window)
  // can't render ConversionDialog itself, so it asks this window to open it instead.
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<string>('open-conversion-dialog', (event) => {
        const path = event.payload;
        const name = path.split(/[\\/]/).pop() || path;
        setConversionFile({ path, name });
      });
      return unlisten;
    };

    let unlistenFn: (() => void) | undefined;
    setupListener().then(fn => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

  // ScreenshotOverlayWindow does the actual capture itself (it's the one holding the formData
  // by then) and reports the outcome back here purely for the toast — the sidebar refresh
  // already happens on its own via the existing refresh-file-list listener below, since
  // take_screenshot emits that on the backend regardless of which window called it.
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<{ message: string; isError?: boolean }>('screenshot-captured', (event) => {
        if (event.payload.isError) {
          setError(event.payload.message);
        } else {
          setMessage(event.payload.message);
          setError("");
        }
      });
      return unlisten;
    };

    let unlistenFn: (() => void) | undefined;
    setupListener().then(fn => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) {
        unlistenFn();
      }
    };
  }, []);

const setScreen = () => {
    invoke<WindowInfo[]>('capture_window_screenshots_by_title_command')
      .then((windowTitles) => {
        console.log('Received windows:', windowTitles);
        setWindowTitles(windowTitles);
        setSelectScreen(true);
      })
      .catch((error) => {
        console.error('Error capturing screenshots:', error);
        setError(`Failed to capture screenshots: ${error}`);
      });
};

  const unSetScreen = () => {
    setSelectScreen(false);
  };

  // Window-targeted *recording* still auto-raises its target: Windows' SetForegroundWindow
  // restriction (see openScreenshotOverlay below for the full explanation) applies here too and
  // can just as easily no-op, but a multi-second recording has room to be manually corrected
  // (switch to the window yourself once it starts) in a way a single-shot screenshot doesn't —
  // so recording keeps this best-effort auto-focus rather than also gaining an overlay step.
  const activateTargetWindowIfNeeded = async (): Promise<void> => {
    if (!screenSize.startsWith('window:')) return;
    await invoke('activate_and_open_window', { title: selectedScreen });
    await new Promise(resolve => setTimeout(resolve, 500));
  };

  // Anything other than Full Screen always goes through the overlay - Window capture can't rely
  // on auto-focus at all (there's no "fix it after the fact" for a single frame, see
  // openScreenshotOverlay below), and Monitor capture gets the same confirm-before-capture beat
  // so nothing gets grabbed the instant a target is picked. Full Screen has no specific target to
  // confirm against, so it stays instant.
  //
  // Reads screen_size off `formData` (built moments ago from whatever target was just resolved)
  // rather than the ambient `screenSize` state - that state update and this call can land in the
  // same synchronous tick (e.g. clicking a window thumbnail), in which case reading the state
  // directly here would still see the *previous* selection.
  const handleTakeScreenshot = async (formData: any) => {
    if (formData.screen_size !== 'fullscreen') {
      await openScreenshotOverlay(formData);
      return;
    }
    try {
      const playShutterSound = () => {
        return new Promise<void>((resolve) => {
          const audio = new Audio("/sounds/option-3.mp3");
          audio.onended = () => resolve();
          audio.play().catch(() => resolve());
        });
      };
      // Fired off without awaiting — the capture itself shouldn't wait on playback finishing,
      // this is just audible feedback that something happened.
      playShutterSound();

      const savedPath = await invoke<string>("take_screenshot", { formData });
      const fileName = savedPath.split(/[\\/]/).pop() ?? savedPath;
      setMessage(`Screenshot saved: ${fileName}`);
      setError("");
    } catch (error) {
      console.error("Error taking screenshot:", error);
      setError(`Failed to take screenshot: ${error}`);
    }
  };

  // Replaces auto-focusing the target window (which routinely failed — see the module-level
  // comment on ScreenshotOverlayWindow.tsx for the Windows-level reason why) with a small
  // always-on-top overlay: the user brings the real target window forward themselves — genuine
  // user input always wins the focus fight a program can't — then confirms capture on the
  // overlay, which hides itself immediately before the actual frame grab so it's never part of
  // the captured pixels.
  //
  // screenshot-overlay is pre-declared in tauri.conf.json (visible: false) and only ever
  // shown/hidden from here on, exactly like recording-overlay — not created fresh via
  // `new WebviewWindow(...)` each time, which is an unproven path in this app (every other
  // overlay window already existed by the time anything tried to show it) and turned out to be
  // unreliable in practice. Data reaches it via an event rather than the URL, since the window
  // (and its listener) already exists long before any particular capture request does.
  const openScreenshotOverlay = async (formData: any) => {
    try {
      const overlayWindow = WebviewWindow.getByLabel('screenshot-overlay');
      if (!overlayWindow) {
        setError('Screenshot overlay window is not available');
        return;
      }
      await overlayWindow.emit('screenshot-overlay-armed', { title: formData.window_title, formData });
      await overlayWindow.show();
      await overlayWindow.setFocus();
    } catch (error) {
      console.error('Error opening screenshot overlay:', error);
      setError(`Failed to open screenshot overlay: ${error}`);
    }
  };

  const handleStartRecording = async (formData: any) => {
    if (formData.record_type === "c") {
      await handleTakeScreenshot(formData);
      return;
    }
    try {
        await activateTargetWindowIfNeeded();

        // Play audio notification
        const playAudioNotification = () => {
          return new Promise<void>((resolve) => {
            const audio = new Audio("/sounds/icq-modern-notification-sound.mp3");
            audio.onended = () => resolve();
            audio.play().catch(err => {
              console.error("Error playing audio:", err);
              resolve();
            });
          });
        };

        await playAudioNotification();

        const response = await invoke<string>("start_recording", { formData });
        const startTime = Date.now();
        setIsRecording(true);
        setRecordingStartTime(startTime);
        setError("");

        // Create the overlay window, but don't show it - it stays hidden until the user
        // asks for it via the toggle shortcut below, rather than popping up unasked-for
        // every time a recording starts.
        let overlayWindow = WebviewWindow.getByLabel('recording-overlay');

        if (!overlayWindow) {
          overlayWindow = new WebviewWindow('recording-overlay', {
            url: '/recording-overlay',
            width: 350,
            height: 100,
            x: 100,
            y: 100,
            resizable: false,
            alwaysOnTop: true,
            skipTaskbar: true,
            decorations: false,
            transparent: true,
            visible: false,
            focus: false,
          });
        }

        // Send recording state to overlay - both windows derive elapsed time from this
        // same start timestamp so their displayed timers can't drift apart. Sent even while
        // hidden so the overlay is already in sync the moment the user reveals it.
        overlayWindow.emit('recording-state-update', {
          isRecording: true,
          recordType: formData.record_type,
          startTime
        });

        if (!(await isRegistered(OVERLAY_TOGGLE_SHORTCUT))) {
          await register(OVERLAY_TOGGLE_SHORTCUT, toggleOverlayVisibility);
        }

        setMessage(`${response} (Ctrl+Shift+H to show/hide the recording overlay)`);

    } catch (error) {
        console.error("Error starting recording:", error);
        setError(`Failed to start recording: ${error}`);
    }
  };

  
  let handleStopRecording = async () => {
    try {
      setError("");
      const response = await invoke<string>("stop_recording");
      
      const audio = new Audio("/sounds/option-3.mp3");
      audio.play().catch(err => console.error("Error playing audio:", err));
      
      setMessage(response);
      setIsRecording(false);
      setRecordingStartTime(null);
	  // Hide the overlay window and drop the toggle shortcut now that there's nothing to show
		const overlayWindow = WebviewWindow.getByLabel('recording-overlay');
		if (overlayWindow) {
		await overlayWindow.hide();
		}
		if (await isRegistered(OVERLAY_TOGGLE_SHORTCUT)) {
		await unregister(OVERLAY_TOGGLE_SHORTCUT);
		}

      if (isMonitoring) {
        await invoke("stop_monitoring_windows");
        setIsMonitoring(false);
        console.log("Monitoring stopped");
      }
    } catch (error) {
      console.error("Error stopping recording:", error);
      setError(`Failed to stop recording: ${error}`);
    }
  };

  const handleDirectoryFiles = async () => {
    try {
      const data = await invoke<FileMap>("list_briefcast_files");
      console.log("Files found:", data);
      setFiles(data); 
    } catch (error) {
      console.error("Error getting files:", error);
      setError(`Failed to load files: ${error}`);
    }
  };

	useEffect(() => {
		handleDirectoryFiles();
	}, []);

	// Best-effort, once per launch: self-heals absolute file paths baked into .edits.json/trash
	// manifest sidecars that no longer resolve (e.g. an image overlay's `src` left pointing at the
	// old Briefcast folder after a Settings > Storage relocation, or any file moved/renamed by hand
	// outside the app) - see repair_stale_file_references's own comment in utility.rs. Silent when
	// nothing needed fixing; only surfaces a message when it actually changed something, so this
	// isn't a mysterious toast on every ordinary launch.
	useEffect(() => {
		invoke<number>("repair_stale_file_references")
			.then((count) => {
				if (count > 0) setMessage(`Fixed ${count} file reference${count === 1 ? "" : "s"} broken by a previous move`);
			})
			.catch((error) => console.error("Failed to repair stale file references:", error));
	}, []);

	// Runs once per launch, not a background timer — same "check whenever it's opened" policy
	// the backend's purge_expired_trash itself is built around (see its own comment for why).
	useEffect(() => {
		const retentionDays = loadSettings().trashRetentionDays;
		invoke<number>("purge_expired_trash", { retentionDays })
			.then((purgedCount) => {
				if (purgedCount > 0) console.log(`Purged ${purgedCount} expired trash item(s)`);
			})
			.catch((error) => console.error("Error purging expired trash:", error));
	}, []);

	const loadTrash = async () => {
		try {
			const items = await invoke<TrashEntry[]>("list_trash");
			setTrashItems(items);
		} catch (error) {
			console.error("Error loading trash:", error);
			setError(`Failed to load trash: ${error}`);
		}
	};

	// Backs the sidebar's per-file "has linked notes" badge/menu (see linkedDocsByPath below) from
	// one list_docs call rather than a find_docs_linked_to round trip per visible row.
	const refreshDocsIndex = useCallback(async () => {
		try {
			setDocsIndex(await invoke<DocSummary[]>("list_docs"));
		} catch (error) {
			console.error("Failed to load docs index:", error);
		}
	}, []);

	useEffect(() => {
		refreshDocsIndex();
	}, [refreshDocsIndex]);

	// file.path -> every doc linked to it, derived once per docsIndex change rather than filtered
	// per row on every render.
	const linkedDocsByPath = useMemo(() => {
		const map = new Map<string, DocSummary[]>();
		for (const doc of docsIndex) {
			if (!doc.linked_to) continue;
			const existing = map.get(doc.linked_to);
			if (existing) existing.push(doc);
			else map.set(doc.linked_to, [doc]);
		}
		return map;
	}, [docsIndex]);

	// One-step "notes for this file" action from a file's 3-dot menu: create-and-link if nothing's
	// linked yet, jump straight in if exactly one doc is, or open the flyout (linkDocsMenuOpenFor)
	// if there's more than one - handled inline at the call site since the 2+ case needs UI state.
	const handleLinkNotes = async (file: FileEntry) => {
		setOpenMenu(null);
		const existing = linkedDocsByPath.get(file.path) ?? [];
		if (existing.length === 1) {
			setSelectedFile(null);
			setDocsScreen({ mode: "editor", docId: existing[0].id });
			return;
		}
		if (existing.length >= 2) {
			setLinkDocsMenuOpenFor(file.path);
			return;
		}
		try {
			const id = crypto.randomUUID();
			const title = `Notes for ${file.name}`;
			const bytes = Array.from(Y.encodeStateAsUpdate(new Y.Doc()));
			await invoke("create_doc", { id, title, bytes });
			await invoke("link_doc_to_file", { id, filePath: file.path });
			await refreshDocsIndex();
			setSelectedFile(null);
			setDocsScreen({ mode: "editor", docId: id });
		} catch (error) {
			console.error("Failed to create linked notes:", error);
			setError(`Failed to create linked notes: ${error}`);
		}
	};

	// Manual escape hatch for the sidebar's "Files:" refresh button — the backend also watches the
	// Briefcast folder itself and emits refresh-file-list on external changes (see the
	// 'refresh-file-list' listener below), but this covers watcher failures/platforms without one,
	// and just gives an immediate, visible "yes, it's current" action for the user to reach for.
	const handleRefreshFiles = async () => {
		setIsRefreshingFiles(true);
		try {
			await Promise.all([handleDirectoryFiles(), loadTrash(), refreshDocsIndex()]);
		} finally {
			setIsRefreshingFiles(false);
		}
	};

	const handleDeleteFile = async (file: FileEntry) => {
		try {
			await invoke("move_to_trash", { path: file.path });
			if (selectedFile?.sourcePath === file.path) setSelectedFile(null);
			setOpenMenu(null);
			const { pinned, recent } = forgetFile(file.path);
			setPinnedPaths(pinned);
			setRecentPaths(recent);
			await handleDirectoryFiles();
			setMessage(`Moved to trash: ${formatFileName(file.name)}`);
		} catch (error) {
			console.error("Error deleting file:", error);
			setError(`Failed to delete file: ${error}`);
		}
	};

	const handleRestoreFromTrash = async (item: TrashEntry) => {
		try {
			await invoke("restore_from_trash", { trashedName: item.trashed_name });
			await Promise.all([loadTrash(), handleDirectoryFiles()]);
			setMessage(`Restored: ${formatFileName(item.name)}`);
		} catch (error) {
			console.error("Error restoring file:", error);
			setError(`Failed to restore file: ${error}`);
		}
	};

	const handleDeleteForever = async (item: TrashEntry) => {
		try {
			await invoke("delete_trash_item", { trashedName: item.trashed_name });
			await loadTrash();
		} catch (error) {
			console.error("Error permanently deleting file:", error);
			setError(`Failed to permanently delete file: ${error}`);
		}
	};

	const handleEmptyTrash = async () => {
		try {
			await invoke("empty_trash");
			await loadTrash();
			setMessage("Trash emptied");
		} catch (error) {
			console.error("Error emptying trash:", error);
			setError(`Failed to empty trash: ${error}`);
		}
	};

	const handleOpenTrash = () => {
		setActiveFileCategory("trash");
		setSelectedFilePaths(new Set());
		loadTrash();
	};

	useEffect(() => {
		const setupListener = async () => {
			const unlistenRefresh = await listen('refresh-file-list', () => {
			console.log('🔄 Refresh file list event received...');
			handleDirectoryFiles();
			});

			return () => {
			unlistenRefresh();
			};
		};

		let cleanupFn: (() => void) | undefined;
		setupListener().then(fn => {
			cleanupFn = fn;
		});

		return () => {
			if (cleanupFn) cleanupFn();
		};
	}, []);
  
	const toggleFileList = () => setShowFileList(prev => !prev);

	const handleGoHome = () => { setSelectedFile(null); setBoardScreen(null); setDocsScreen(null); };
	const handleOpenBoard = () => { setSelectedFile(null); setBoardScreen({ mode: "home" }); setDocsScreen(null); };
	const handleOpenDocs = () => { setSelectedFile(null); setBoardScreen(null); setDocsScreen({ mode: "home" }); };
	const handleOpenSettings = () => setShowSettings(true);
	const handleCloseSettings = () => setShowSettings(false);
	// Settings apply immediately to the current session too, not just future ones — otherwise
	// saving a new default file extension/type wouldn't visibly do anything until next launch.
	const handleSettingsSaved = (settings: ReturnType<typeof loadSettings>) => {
		setFileExt(settings.defaultFileExt);
		setRecordType(settings.defaultRecordType);
		setAnnotationEnabled(settings.enableAnnotationTool);
		setHomeBackgroundStyle(settings.homeBackgroundStyle);
	};
	// After the Briefcast folder itself has been relocated (see SettingsModal's Storage section):
	// re-list from the new location, and drop whatever's currently open - its sourcePath was inside
	// the old root and no longer resolves to anything now that everything has actually moved.
	const handleStorageChanged = () => {
		handleDirectoryFiles();
		setSelectedFile(null);
	};

	// Shows/hides the annotation overlay and flips its click-through state, and tells its own page
	// to show/hide the floating toolbar. Called both by the global hotkey (toggles) and by the
	// turn-off-request listener below (forces off, e.g. from the overlay's Esc/close button).
	//
	// The overlay stays hidden except for this deliberately brief, user-initiated window - see the
	// long comment in ensure_annotation_overlay (annotation.rs) for why: a click-through style that
	// silently fails to apply is nearly harmless on a window that's about to be hidden anyway, but
	// catastrophic on one left permanently visible in the background. show()/setIgnoreCursorEvents
	// are also always sequenced show-before-ignore when turning draw mode on, since setting that
	// style before a window has ever been shown is what didn't reliably stick on Windows.
	const toggleAnnotationDrawMode = useCallback(async (forceOff = false) => {
		const overlay = WebviewWindow.getByLabel('annotation-overlay');
		if (!overlay) return;
		const next = forceOff ? false : !annotationDrawModeRef.current;
		annotationDrawModeRef.current = next;

		if (annotationHideTimeoutRef.current !== null) {
			window.clearTimeout(annotationHideTimeoutRef.current);
			annotationHideTimeoutRef.current = null;
		}

		try {
			if (next) {
				await overlay.show();
				await overlay.setIgnoreCursorEvents(false);
				await overlay.emit('annotation-mode-changed', { active: true });
			} else {
				await overlay.emit('annotation-mode-changed', { active: false });
				await overlay.setIgnoreCursorEvents(true);
				// Not hidden immediately - a still-fading stroke should keep fading, not vanish the
				// instant draw mode turns off. ANNOTATION_FADE_GRACE_MS covers the overlay's own
				// FADE_HOLD_MS + FADE_OUT_MS (AnnotationOverlayWindow.tsx) with margin. Click-through
				// is already applied above, so even if this timer never fires (e.g. the app closes
				// first), the overlay can't block input in the meantime.
				annotationHideTimeoutRef.current = window.setTimeout(() => {
					annotationHideTimeoutRef.current = null;
					if (!annotationDrawModeRef.current) void overlay.hide();
				}, ANNOTATION_FADE_GRACE_MS);
			}
		} catch (err) {
			console.error('Failed to toggle annotation draw mode:', err);
		}
	}, []);

	// Creates (idempotent) and shows the annotation overlay + registers its hotkey whenever the
	// feature is enabled; tears both down whenever it's disabled. Independent of recording state —
	// this feature is meant to be available any time, not just mid-recording (unlike
	// OVERLAY_TOGGLE_SHORTCUT above).
	useEffect(() => {
		if (ANNOTATION_FEATURE_DISABLED) return;
		let cancelled = false;

		(async () => {
			if (!annotationEnabled) {
				if (annotationDrawModeRef.current) {
					await toggleAnnotationDrawMode(true);
				}
				if (await isRegistered(ANNOTATION_TOGGLE_SHORTCUT)) {
					await unregister(ANNOTATION_TOGGLE_SHORTCUT);
				}
				const overlay = WebviewWindow.getByLabel('annotation-overlay');
				if (overlay) await overlay.hide();
				return;
			}

			try {
				await invoke('ensure_annotation_overlay');
			} catch (err) {
				console.error('Failed to create annotation overlay:', err);
				return;
			}
			if (cancelled) return;
			try {
				if (!(await isRegistered(ANNOTATION_TOGGLE_SHORTCUT))) {
					await register(ANNOTATION_TOGGLE_SHORTCUT, () => {
						void toggleAnnotationDrawMode();
					});
				}
			} catch (err) {
				// Most likely cause: another already-running app has this exact combo registered
				// as its own OS-level global hotkey, so ours is rejected - surfaced here (rather
				// than only console.error, which nobody sees without devtools) since otherwise the
				// symptom is just "the shortcut silently does nothing," indistinguishable from the
				// feature being broken.
				console.error('Failed to register annotation hotkey:', err);
				setError(`Couldn't register the annotation shortcut (${ANNOTATION_TOGGLE_SHORTCUT.replace('CommandOrControl', 'Ctrl')}) - it may already be in use by another app.`);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [annotationEnabled, toggleAnnotationDrawMode]);

	// The overlay's own Esc key / toolbar close button can't reach annotationDrawModeRef directly
	// (different window, different JS context) - it asks via this event instead.
	useEffect(() => {
		const unlistenPromise = listen('annotation-turn-off-request', () => {
			if (annotationDrawModeRef.current) {
				void toggleAnnotationDrawMode(true);
			}
		});
		return () => {
			unlistenPromise.then((fn) => fn());
		};
	}, [toggleAnnotationDrawMode]);

	// Unregister on unmount so the hotkey doesn't linger after Dashboard itself goes away.
	useEffect(() => {
		return () => {
			isRegistered(ANNOTATION_TOGGLE_SHORTCUT).then((registered) => {
				if (registered) void unregister(ANNOTATION_TOGGLE_SHORTCUT);
			});
		};
	}, []);

	const handleTogglePdfFullscreen = async () => {
		const next = !isPdfFullscreen;
		setIsPdfFullscreen(next);
		try {
			await appWindow.setFullscreen(next);
		} catch (err) {
			console.error('Failed to toggle window fullscreen:', err);
		}
	};

  // Shared by the sidebar (files already in the Briefcast library) and the "open file from
  // anywhere" picker below — both just need a raw filesystem path turned into a playable URL.
	const loadFileForPlayback = async (filePath: string, fileName: string) => {
	try {
		// Get the absolute file path from Rust
		const absolutePath = await invoke<string>("convert_file_path_to_url", {
		filepath: filePath
		});

		console.log('Absolute file path:', absolutePath);

		// Convert to asset protocol URL using Tauri's helper
		const fileUrl = convertFileSrc(absolutePath);

		console.log('Converted file URL:', fileUrl);

		// Update the selected file state
		setSelectedFile({
		path: fileUrl,
		name: fileName,
		sourcePath: filePath
		});
		setBoardScreen(null);
		setDocsScreen(null);
		setRecentPaths(recordFileOpened(filePath));

		console.log('File selected for playback:', fileName);
	} catch (error) {
		console.error('Error loading file:', error);
		setError(`Failed to load file: ${error}`);
	}
	};

	const handleFileClick = async (file: FileEntry) => {
		await loadFileForPlayback(file.path, file.name);
	};

	// Fired by VideoTimelineDocker's Save button once export_trimmed_video finishes - same
	// refresh-list-then-select-the-result shape as ConversionDialog's onConverted below, since
	// this is exactly the same kind of event (a new file appeared in the library, backed by a
	// real render already sitting on disk). The video that was being edited is left exactly as it
	// was; this just adds its trimmed/cut sibling alongside it.
	const handleVideoExported = async (newPath: string, newFileName: string) => {
		await handleDirectoryFiles();
		setMessage(`Saved edited video: ${formatFileName(newFileName)}`);
		await loadFileForPlayback(newPath, newFileName);
	};

	// Fired by ImageEditor's "Save a copy" once save_edited_image finishes - same
	// refresh-list-then-select-the-result shape as handleVideoExported above; the source image is
	// left untouched, this just adds its edited sibling alongside it.
	const handleImageSaved = async (newPath: string, newFileName: string) => {
		await handleDirectoryFiles();
		setMessage(`Saved edited image: ${formatFileName(newFileName)}`);
		await loadFileForPlayback(newPath, newFileName);
	};

	// Small icon shown next to a file name in the home-screen "From your library" preview list.
	const categoryIcon = (category: FileCategory | null): React.ReactNode =>
		FILE_CATEGORY_TABS.find((tab) => tab.category === category)?.icon ?? <IoDocumentText size={18} />;

	// What to surface on the empty home screen so it isn't just a blank void. Pinned files (in pin
	// order — see utils/homeScreenFiles.ts's newest-pin-first toggling) always come first, but they
	// only ever ADD to the top of the list — they never wholesale replace what's already showing
	// below. The rest of the slots fill in with recently opened/edited/viewed files (or, absent any
	// open history, just a taste of the library), skipping anything already pinned so nothing shows
	// twice.
	const allLibraryFiles = Object.values(files).flat();
	const libraryFilesByPath = new Map(allLibraryFiles.map((file) => [file.path, file]));
	const pinnedLibraryFiles = pinnedPaths
		.map((path) => libraryFilesByPath.get(path))
		.filter((file): file is FileEntry => !!file);
	const recentLibraryFiles = recentPaths
		.map((path) => libraryFilesByPath.get(path))
		.filter((file): file is FileEntry => !!file);
	const fillerFiles = (recentLibraryFiles.length > 0 ? recentLibraryFiles : allLibraryFiles).filter(
		(file) => !pinnedPaths.includes(file.path)
	);
	const libraryPreviewFiles = [...pinnedLibraryFiles, ...fillerFiles].slice(0, MAX_HOME_SCREEN_FILES);

	// Flattened, sidebar-order file list for a category — spans all folders, not just the one
	// the currently selected file happens to live in, so prev/next still works when a category
	// is split across multiple folders.
	const getFlatFilesForCategory = (category: FileCategory): FileEntry[] =>
		Object.values(files)
			.flat()
			.filter((file) => getFileCategory(file.name) === category);

	// Cycles to the previous/next image relative to whatever's currently selected, wrapping
	// around at either end (matches how most image viewers handle prev/next at the boundaries).
	const navigateImage = (direction: 1 | -1) => {
		if (!selectedFile) return;
		const images = getFlatFilesForCategory("image");
		if (images.length === 0) return;
		const currentIndex = images.findIndex((file) => file.path === selectedFile.sourcePath);
		if (currentIndex === -1) return;
		const nextIndex = (currentIndex + direction + images.length) % images.length;
		const next = images[nextIndex];
		loadFileForPlayback(next.path, next.name);
	};

	// Persists the currently-playing audio file's position on every tick, keyed by its
	// filesystem path — read back in the `initialTime` passed to VideoPlayer below so navigating
	// away and back (including by an accidental prev/next tap) resumes instead of restarting.
	// Stable identity (empty deps) so VideoPlayer's own timeupdate listener doesn't get torn
	// down and re-attached on every unrelated Dashboard re-render.
	const handleAudioTimeUpdate = useCallback((time: number) => {
		const current = selectedFileRef.current;
		if (current && getFileCategory(current.name) === "audio") {
			audioPositionsRef.current[current.sourcePath] = time;
		}
	}, []);

	// Prev/next for audio — shuffle-aware. Manual navigation (arrow keys, the sidebar buttons)
	// always wraps at the ends; auto-advance-on-end (handleAudioEnded below) opts out of that via
	// `wrap: false` unless repeat-all is on, so a non-repeating playlist actually stops instead of
	// looping forever.
	const navigateAudio = (direction: 1 | -1, options?: { wrap?: boolean }) => {
		const wrap = options?.wrap ?? true;
		const current = selectedFileRef.current;
		if (!current) return;
		const tracks = getFlatFilesForCategory("audio");
		if (tracks.length === 0) return;
		const currentIndex = tracks.findIndex((file) => file.path === current.sourcePath);
		if (currentIndex === -1) return;

		let nextIndex: number;
		if (direction === -1 && audioShuffle && shuffleHistoryRef.current.length > 0) {
			// Undo the last shuffled "next" rather than computing a sequential-order previous,
			// which wouldn't match whatever was actually played before this.
			const previousPath = shuffleHistoryRef.current.pop() as string;
			const foundIndex = tracks.findIndex((file) => file.path === previousPath);
			nextIndex = foundIndex === -1 ? currentIndex : foundIndex;
		} else if (audioShuffle && tracks.length > 1) {
			if (direction === 1) shuffleHistoryRef.current.push(current.sourcePath);
			do {
				nextIndex = Math.floor(Math.random() * tracks.length);
			} while (nextIndex === currentIndex);
		} else {
			nextIndex = currentIndex + direction;
			if (nextIndex < 0) {
				if (!wrap) return;
				nextIndex = tracks.length - 1;
			} else if (nextIndex >= tracks.length) {
				if (!wrap) return;
				nextIndex = 0;
			}
		}

		const next = tracks[nextIndex];
		loadFileForPlayback(next.path, next.name);
	};

	// Repeat-one is handled natively via <video loop> on VideoPlayer (see its `loop` prop below)
	// — 'ended' never even fires in that case, so it doesn't need to be special-cased here.
	const handleAudioEnded = useCallback(() => {
		const current = selectedFileRef.current;
		if (!current || getFileCategory(current.name) !== "audio") return;
		if (audioRepeatMode === "one") return;
		if (audioRepeatMode !== "all" && !audioAutoplayNext) return; // just stop, like today
		navigateAudio(1, { wrap: audioRepeatMode === "all" });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [audioRepeatMode, audioAutoplayNext, audioShuffle, files]);

	const cycleAudioRepeatMode = (): void => {
		setAudioRepeatMode((prev) => (prev === "off" ? "all" : prev === "all" ? "one" : "off"));
	};

	// Video equivalent of navigateAudio — no shuffle/repeat-all for video, so this is the simple
	// sequential-with-wrap form (matches navigateImage's shape).
	const navigateVideo = (direction: 1 | -1, options?: { wrap?: boolean }) => {
		const wrap = options?.wrap ?? true;
		const current = selectedFileRef.current;
		if (!current) return;
		const videos = getFlatFilesForCategory("video");
		if (videos.length === 0) return;
		const currentIndex = videos.findIndex((file) => file.path === current.sourcePath);
		if (currentIndex === -1) return;
		let nextIndex = currentIndex + direction;
		if (nextIndex < 0) {
			if (!wrap) return;
			nextIndex = videos.length - 1;
		} else if (nextIndex >= videos.length) {
			if (!wrap) return;
			nextIndex = 0;
		}
		const next = videos[nextIndex];
		loadFileForPlayback(next.path, next.name);
	};

	// Video equivalent of handleAudioEnded — advances to the next video in the list when the
	// player's own Autoplay toggle is on. No repeat mode for video, so a non-wrapping advance
	// (stops at the last file rather than looping) is the only behavior.
	//
	// Suppressed entirely while the video-tools timeline panel is open: autoplaying away from the
	// video someone is mid-edit on is disorienting (the player silently switches out from under
	// them) and is also what was quietly discarding in-session undo/redo history - see
	// useVideoEditStore's per-path history cache for the other half of that fix.
	const handleVideoEnded = useCallback(() => {
		const current = selectedFileRef.current;
		if (!current || getFileCategory(current.name) !== "video") return;
		if (!videoAutoplayNext) return;
		if (dockerMode === "file-tools") return;
		navigateVideo(1, { wrap: false });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [videoAutoplayNext, files, dockerMode]);

	// Single onEnded handed to VideoPlayer for both audio and video playback — each of the two
	// handlers above bails immediately if the file that just ended isn't its category, so exactly
	// one of them actually does anything on any given call.
	const handleMediaEnded = useCallback(() => {
		handleAudioEnded();
		handleVideoEnded();
	}, [handleAudioEnded, handleVideoEnded]);

	// Arrow-key navigation — only active while an image or audio file is the currently displayed
	// one, so it doesn't hijack arrow keys elsewhere (video seeking, PDF page turns, form inputs).
	// Suppressed for images while the image tools panel is open (dockerMode === "file-tools"):
	// ImageEditor.tsx binds its own arrow-key handler there to nudge a selected annotation object,
	// and this listener - being on `document` same as that one, with no relation between the two -
	// would otherwise ALSO fire for the exact same keypress and flip to the next/previous file out
	// from under whatever the user was actually trying to nudge.
	useEffect(() => {
		if (!selectedFile) return;
		const category = getFileCategory(selectedFile.name);
		if (category !== "image" && category !== "audio") return;
		if (category === "image" && dockerMode === "file-tools") return;

		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;

			if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
				e.preventDefault();
				if (category === "audio") navigateAudio(-1);
				else navigateImage(-1);
			} else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
				e.preventDefault();
				if (category === "audio") navigateAudio(1);
				else navigateImage(1);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [selectedFile, files, audioShuffle, dockerMode]);

	// Opens a native OS file picker scoped to nowhere in particular — unlike the sidebar (which
	// only ever lists files under the app's own Briefcast folder), this lets the user view/play
	// any video, audio, image, or PDF already sitting anywhere else on their system. Selecting
	// one just opens it in the player/annotator; it does not get copied or added to the sidebar.
	const handleOpenExternalFile = async () => {
		try {
			const selected = await openFileDialog({ multiple: false, filters: OPEN_FILE_DIALOG_FILTERS });
			if (!selected || Array.isArray(selected)) return; // cancelled

			const name = selected.split(/[\\/]/).pop() ?? selected;
			if (!getFileCategory(name)) {
				await showMessageDialog(`"${name}" isn't a supported file type (video, audio, image, or PDF).`, {
					title: 'Unsupported file',
					type: 'warning',
				});
				return;
			}

			await loadFileForPlayback(selected, name);
		} catch (error) {
			console.error('Error opening file:', error);
			setError(`Failed to open file: ${error}`);
		}
	};

	// FileMap's keys are relative_key-shaped paths from the Rust side ("" = Briefcast root,
	// "Workshops/Papers" = a nested folder) — these two just adapt that raw key for display.
	const folderDisplayName = (folder: string): string => (folder === "" ? "Briefcast" : folder.split("/").pop()!);
	const folderDepth = (folder: string): number => (folder === "" ? 0 : folder.split("/").length);

	const findFileFolder = (path: string): string | null => {
		for (const [folder, list] of Object.entries(files)) {
			if (list.some((f) => f.path === path)) return folder;
		}
		return null;
	};

	// True only if the filesystem folder is completely empty — no files of any type, no
	// subfolders — not merely "no files in the currently active category". Root can never be
	// deleted, so it's always reported non-empty here regardless of its real contents.
	const isFolderEmpty = (folder: string): boolean => {
		if (folder === "") return false;
		if ((files[folder]?.length ?? 0) > 0) return false;
		return !Object.keys(files).some((key) => key.startsWith(`${folder}/`));
	};

	const toggleFileSelected = (path: string) => {
		setSelectedFilePaths((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	};

	const getSelectedFileEntries = (): FileEntry[] => Object.values(files).flat().filter((f) => selectedFilePaths.has(f.path));

	// Whichever of "just this one file" or "the whole active selection" a drag/move action on
	// `file` should apply to — the shared rule behind both drag-and-drop and the per-file
	// "Move to" menu: dragging/moving a file that's part of a multi-selection moves the whole
	// selection, dragging/moving anything else only moves that one file.
	const filesToActOn = (file: FileEntry): FileEntry[] => {
		if (!selectedFilePaths.has(file.path)) return [file];
		const selection = getSelectedFileEntries();
		return selection.length > 1 ? selection : [file];
	};

	const startCreateFolder = (parentFolder: string) => {
		setCreatingFolderIn(parentFolder);
		setNewFolderValue("");
		setOpenMenu(null);
		// The new-subfolder input renders inside parentFolder's own (collapsible) body - expand it
		// first so starting to create a folder never opens an input the user can't actually see.
		setCollapsedFolders((prev) => {
			if (!prev.has(parentFolder)) return prev;
			const next = new Set(prev);
			next.delete(parentFolder);
			return next;
		});
	};

	const commitCreateFolder = async () => {
		const parent = creatingFolderIn;
		const name = newFolderValue.trim();
		setCreatingFolderIn(null);
		if (parent === null || !name) return;
		try {
			await invoke<string>("create_folder", { parentPath: parent, name });
			await handleDirectoryFiles();
			setMessage(`Created folder: ${name}`);
		} catch (error) {
			console.error("Error creating folder:", error);
			setError(`Failed to create folder: ${error}`);
		}
	};

	// Handles both a single-file move and a bulk move — `fileList` is whatever filesToActOn()
	// decided applies (see its comment). Files already in destFolder are silently skipped rather
	// than erroring, since a multi-selection spanning folders will often already include some
	// that are exactly where they're being dropped.
	const handleMoveFiles = async (fileList: FileEntry[], destFolder: string) => {
		setOpenMenu(null);
		setMoveMenuOpenFor(null);
		setDragOverFolder(null);
		setBulkMoveMenuOpen(false);
		const toMove = fileList.filter((file) => findFileFolder(file.path) !== destFolder);
		if (toMove.length === 0) return;
		try {
			const results = await Promise.allSettled(
				toMove.map((file) => invoke<string>("move_file", { sourcePath: file.path, destFolderPath: destFolder }))
			);

			// Keep pin/recent-history pointed at each moved file's new path — repathFile reads then
			// writes localStorage synchronously, so chaining through fulfilled results in order is safe.
			results.forEach((result, i) => {
				if (result.status === "fulfilled") {
					const { pinned, recent } = repathFile(toMove[i].path, result.value);
					setPinnedPaths(pinned);
					setRecentPaths(recent);
				}
			});

			// Same repair for any doc's linked_to pointing at a moved file - one refresh after the
			// loop rather than per-file, to avoid redundant list_docs calls during a bulk move.
			const relinkResults = await Promise.allSettled(
				results
					.map((result, i) => (result.status === "fulfilled" ? invoke("relink_doc_path", { oldPath: toMove[i].path, newPath: result.value }) : null))
					.filter((p): p is Promise<unknown> => p !== null)
			);
			if (relinkResults.length > 0) await refreshDocsIndex();

			await handleDirectoryFiles();

			// The file's playback URL is derived from its old absolute path, so a currently-open
			// file needs reloading from its new location rather than just refreshing the list.
			const openIndex = toMove.findIndex((file) => selectedFile?.sourcePath === file.path);
			if (openIndex !== -1) {
				const openResult = results[openIndex];
				if (openResult.status === "fulfilled") await loadFileForPlayback(openResult.value, toMove[openIndex].name);
			}

			setSelectedFilePaths(new Set());
			const failedCount = results.filter((r) => r.status === "rejected").length;
			if (failedCount > 0) {
				const firstError = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
				setError(`Moved ${toMove.length - failedCount} of ${toMove.length} file(s) — ${failedCount} failed: ${firstError}`);
			} else if (toMove.length === 1) {
				setMessage(`Moved ${formatFileName(toMove[0].name)} to ${folderDisplayName(destFolder)}`);
			} else {
				setMessage(`Moved ${toMove.length} files to ${folderDisplayName(destFolder)}`);
			}
		} catch (error) {
			console.error("Error moving files:", error);
			setError(`Failed to move files: ${error}`);
		}
	};

	// Copies files dragged in from outside the app (e.g. Windows Explorer) into destFolder — the
	// external-source counterpart to handleMoveFiles above, same Promise.allSettled/refresh/
	// combined-message shape, but via the import_file command (fs::copy, source left in place)
	// rather than move_file. `paths` are real absolute filesystem paths, which (unlike a plain
	// HTML5 drop's dataTransfer.files) only Tauri's own native file-drop event actually provides —
	// see the onFileDropEvent listener below for why.
	const handleImportFiles = async (paths: string[], destFolder: string) => {
		if (paths.length === 0) return;
		const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
		try {
			const results = await Promise.allSettled(
				paths.map((path) => invoke<string>("import_file", { sourcePath: path, destFolderPath: destFolder }))
			);
			await handleDirectoryFiles();

			const failedCount = results.filter((r) => r.status === "rejected").length;
			if (failedCount > 0) {
				const firstError = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
				setError(`Imported ${paths.length - failedCount} of ${paths.length} file(s) — ${failedCount} failed: ${firstError}`);
			} else if (paths.length === 1) {
				setMessage(`Imported ${formatFileName(baseName(paths[0]))} to ${folderDisplayName(destFolder)}`);
			} else {
				setMessage(`Imported ${paths.length} files to ${folderDisplayName(destFolder)}`);
			}
		} catch (error) {
			console.error("Error importing files:", error);
			setError(`Failed to import files: ${error}`);
		}
	};

	// Real OS file drops never reach the browser's own `drop` event with usable data on Tauri v1 —
	// browsers/webviews never expose an absolute filesystem path on a dropped File object (that's
	// what Tauri's native file-drop event exists to provide instead). So targeting still comes from
	// plain DOM dragover on each folder <div> (dragOverFolder, updated below) for the *visual*
	// highlight and "which folder" tracking, while the *paths* come from here — read via a ref
	// since this listener is registered once and would otherwise close over a stale dragOverFolder.
	// Tauri v1's FileDropEvent payload carries no cursor position, which is the reason this can't be
	// done with the native event alone.
	const dragOverFolderRef = useRef<string | null>(null);
	useEffect(() => {
		dragOverFolderRef.current = dragOverFolder;
	}, [dragOverFolder]);

	// The video-tools timeline's own drop target has the *same* "no cursor position in the native
	// event" problem as dragOverFolderRef above, but plain DOM dragover can't solve it the same way
	// here: that only works because an in-page drag (e.g. dragging a Briefcast sidebar row) never
	// leaves the webview, so Chromium's own drag-tracking dispatches it normally. A drag whose
	// *origin* is a different native window (Explorer) is a real OS-level drag session - Tauri's
	// file-drop event fires reliably for it, but WebView2's DOM dragover does not (confirmed: it
	// silently never fired, so the timeline's drop target was never detected and every external
	// drop fell through to a library import instead). The fix is to poll the cursor position
	// (get_cursor_position_in_window) each time Tauri's own 'hover' event fires and hit-test it
	// against the DOM directly - which works regardless of whether Chromium ever saw a dragover.
	//
	// get_cursor_position_in_window does the whole cursor-position-to-client-coordinates
	// conversion natively in one Win32-only call rather than combining a native GetCursorPos with
	// this window's own innerPosition()/scaleFactor() - an earlier version mixed those two sources
	// and produced consistently wrong coordinates on a 250%-scaled display (confirmed: a drop over
	// the visible timeline resolved to a DOM element in the sidebar instead), most likely because
	// Tauri 1.8.3 itself depends on an older `windows` crate than this app's own Rust code and the
	// two disagree on DPI virtualization for a plain cross-process GetCursorPos call.
	//
	// The actual insert can't happen here - it needs editStore, which lives inside
	// VideoTimelineDocker - so a confirmed timeline-targeted drop is just handed down as
	// pendingTimelineInsert for that component to act on and then clear.
	const dragOverTimelineXRef = useRef<number | null>(null);
	const [pendingTimelineInsert, setPendingTimelineInsert] = useState<{ paths: string[]; clientX: number } | null>(null);
	const hoverTokenRef = useRef(0);

	const resolveExternalDropClientX = async (): Promise<number | null> => {
		try {
			const [clientX, clientY] = await invoke<[number, number]>("get_cursor_position_in_window");
			const el = document.elementFromPoint(clientX, clientY);
			const overTimeline = !!el?.closest("[data-timeline-track]");
			// Temporary diagnostic - if clientX/clientY now land on the timeline while it's visibly
			// under the cursor, the DPI fix worked; if they're still off, something else is wrong.
			console.log("[Dashboard] resolveExternalDropClientX", { clientX, clientY, elementTag: el?.tagName, overTimeline });
			return overTimeline ? clientX : null;
		} catch (error) {
			console.error("Failed to resolve external drag position:", error);
			return null;
		}
	};

	useEffect(() => {
		const unlistenPromise = appWindow.onFileDropEvent(async (event) => {
			console.log("[Dashboard] onFileDropEvent", event.payload.type, event.payload.type !== "cancel" ? event.payload.paths : undefined);
			if (event.payload.type === "hover") {
				// Only the most recently *requested* hover's resolution is ever applied - hover events
				// can arrive faster than the position round-trip resolves, and an out-of-order stale
				// result landing last would leave dragOverTimelineXRef pointing at an old position.
				const token = ++hoverTokenRef.current;
				const clientX = await resolveExternalDropClientX();
				if (hoverTokenRef.current === token) dragOverTimelineXRef.current = clientX;
				return;
			}
			if (event.payload.type === "drop") {
				console.log("[Dashboard] drop - dragOverTimelineXRef was", dragOverTimelineXRef.current);
				if (dragOverTimelineXRef.current !== null) {
					setPendingTimelineInsert({ paths: event.payload.paths, clientX: dragOverTimelineXRef.current });
					dragOverTimelineXRef.current = null;
					return;
				}
				const destFolder = dragOverFolderRef.current ?? "";
				setDragOverFolder(null);
				handleImportFiles(event.payload.paths, destFolder);
			} else if (event.payload.type === "cancel") {
				setDragOverFolder(null);
				dragOverTimelineXRef.current = null;
			}
		});
		return () => {
			unlistenPromise.then((unlisten) => unlisten());
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleDeleteFolder = async (folder: string) => {
		try {
			await invoke("delete_folder", { folderPath: folder });
			await handleDirectoryFiles();
			setMessage(`Deleted folder: ${folderDisplayName(folder)}`);
		} catch (error) {
			console.error("Error deleting folder:", error);
			setError(`Failed to delete folder: ${error}`);
		}
	};

	const handleTogglePin = (file: FileEntry) => {
		setPinnedPaths(togglePin(file.path));
		setOpenMenu(null);
	};

	const startRename = (file: FileEntry) => {
		const dotIndex = file.name.lastIndexOf('.');
		setRenameValue(dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name);
		setRenamingFile(file.path);
		setOpenMenu(null);
	};

	// Shared by the sidebar's inline rename (commitRename below) and the "file tools" docker's
	// rename field — also fixes a latent staleness bug the inline rename used to have on its own:
	// renaming the file currently open in the player left `selectedFile` pointing at a path that
	// no longer existed on disk until the next unrelated refresh happened to fix it.
	const renameFile = async (file: FileEntry, newName: string): Promise<void> => {
		if (!newName || newName === file.name) return;
		try {
			const newPath = await invoke<string>('rename_file', { oldPath: file.path, newName });
			const { pinned, recent } = repathFile(file.path, newPath);
			setPinnedPaths(pinned);
			setRecentPaths(recent);
			try {
				await invoke("relink_doc_path", { oldPath: file.path, newPath });
				await refreshDocsIndex();
			} catch (error) {
				console.error("Failed to repair doc links after rename:", error);
			}
			await handleDirectoryFiles();
			if (selectedFile?.sourcePath === file.path) {
				const newFileName = newPath.split(/[\\/]/).pop() ?? newName;
				await loadFileForPlayback(newPath, newFileName);
			}
		} catch (error) {
			console.error('Error renaming file:', error);
			setError(`Failed to rename file: ${error}`);
		}
	};

	const commitRename = async (file: FileEntry) => {
		const newName = renameValue.trim();
		setRenamingFile(null);
		await renameFile(file, newName);
	};

	// Computed once per render so both the fixed sidebar header and the scrollable list below
	// it can share the same grouping — previously this was recomputed inside an IIFE local to
	// just the list, which the header (now pulled out so it can stay fixed) couldn't reach.
	// Every real folder is kept (even ones with zero files in the active category) so it stays
	// visible — and usable as a create-subfolder/move/drop target — regardless of which file-type
	// tab happens to be open. Sorted lexicographically on the relative-path key, which conveniently
	// also sorts every folder after its own parent ("Workshops" before "Workshops/Papers") and
	// puts the root ("") first, so this doubles as the hierarchical display order.
	const normalizedSearchQuery = fileSearchQuery.trim().toLowerCase();
	const isSearchingFiles = normalizedSearchQuery.length > 0;
	const filteredEntries = Object.entries(files)
		.map(([folder, fileList]) => [
			folder,
			fileList.filter(
				(file) => getFileCategory(file.name) === activeFileCategory && (!isSearchingFiles || file.name.toLowerCase().includes(normalizedSearchQuery))
			),
		] as [string, FileEntry[]])
		// A folder with zero matches is only worth hiding while actively searching - normally
		// every real folder stays visible (even empty ones, per this file's own comment above)
		// so it's still usable as a create-subfolder/move/drop target.
		.filter(([, fileList]) => !isSearchingFiles || fileList.length > 0)
		.sort(([a], [b]) => a.localeCompare(b));
	const filteredTrashItems = isSearchingFiles
		? trashItems.filter((item) => item.name.toLowerCase().includes(normalizedSearchQuery))
		: trashItems;
	const sidebarHeaderLabel =
		activeFileCategory === "trash"
			? "Trash:"
			: isSearchingFiles
			? "Search results:"
			: filteredEntries.length === 1 ? `${folderDisplayName(filteredEntries[0][0])}:` : filteredEntries.length > 1 ? "Files:" : "Briefcast:";
	const isAudioSelected = selectedFile !== null && getFileCategory(selectedFile.name) === "audio";

  return (
    <div className="w-full h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      {/* flex-1 min-h-0 here (and h-full min-h-0 on the row below) is load-bearing, not
          cosmetic: without a real height bound propagated all the way down, the main content
          pane (ImageEditor/PdfAnnotator/VideoPlayer) had nothing stopping it from growing taller
          than the viewport whenever its own content did - at which point the *whole document*
          became the only thing left to scroll, dragging the sidebar's fixed h-screen column along
          with it despite the sidebar's own file list having nothing to do with that scroll. That's
          also why the main content pane's internal overflow-auto panes (ImageEditor.tsx's canvas
          pane, ImageEditorToolbar's own panel) never had a genuine bounded scroll range of their
          own to begin with - see those files' own overscroll-contain comments for the other half
          of making each of the three panels scroll independently. */}
      <div className="p- flex-1 min-h-0">
        <div className="flex justify-between h-full min-h-0">
          {/* File list sidebar — force-collapsed in PDF fullscreen/presentation mode,
              regardless of showFileList, so it never reappears over the presented page. */}
          <div
            className={`h-screen bg-neutral-50 dark:bg-neutral-900 border-b border-gray-300 dark:border-neutral-700 transition-all duration-300 overflow-hidden ${
              showFileList && !isPdfFullscreen ? "w-[300px] opacity-100" : "w-0 opacity-0"
            }`}
          >
            {showFileList && !isPdfFullscreen && (
              <div className="flex flex-col h-full">
                {/* File type tabs */}
                <div className="flex items-center justify-around border-b border-gray-300 dark:border-neutral-700 py-2 shrink-0">
                  {FILE_CATEGORY_TABS.map(({ category, label, icon }) => (
                    <button
                      key={category}
                      type="button"
                      title={label}
                      onClick={() => {
                        setActiveFileCategory(category);
                        setSelectedFilePaths(new Set());
                      }}
                      className={`flex flex-col items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
                        activeFileCategory === category
                          ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                          : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {icon}
                      <span>{label}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    title="Trash"
                    onClick={handleOpenTrash}
                    className={`flex flex-col items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
                      activeFileCategory === "trash"
                        ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                        : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-50 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <IoTrashOutline size={18} />
                    <span>Trash</span>
                  </button>
                </div>

                {/* File search - filters the active tab's files (and trash) by name as you type.
                    Fixed below the tabs, same as the folder-label bar beneath it. */}
                <div className="px-3 py-2 border-b border-gray-200 dark:border-neutral-700 shrink-0">
                  <div className="relative">
                    <IoSearch size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 dark:text-neutral-500 pointer-events-none" />
                    <input
                      type="text"
                      value={fileSearchQuery}
                      onChange={(e) => setFileSearchQuery(e.target.value)}
                      placeholder="Search files"
                      className="w-full pl-7 pr-7 py-1.5 rounded-md text-xs bg-gray-100 dark:bg-neutral-800 border border-transparent focus:border-blue-400 dark:focus:border-blue-500 outline-none text-neutral-800 dark:text-neutral-100 placeholder:text-gray-400 dark:placeholder:text-neutral-500"
                    />
                    {fileSearchQuery && (
                      <button
                        type="button"
                        title="Clear search"
                        onClick={() => setFileSearchQuery("")}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700"
                      >
                        <IoClose size={13} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Folder label + prev/next/repeat/shuffle/autoplay controls — fixed below the
                    tabs, does not scroll with the file list beneath it. */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-neutral-700 shrink-0">
                  <h3 className="font-semibold text-gray-700 dark:text-neutral-300 text-sm truncate">{sidebarHeaderLabel}</h3>
                  <div className="flex items-center gap-0.5 shrink-0">
                    <button
                      type="button"
                      title="Refresh files"
                      onClick={handleRefreshFiles}
                      disabled={isRefreshingFiles}
                      className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                    >
                      <IoRefresh size={15} className={isRefreshingFiles ? "animate-spin" : ""} />
                    </button>
                    {activeFileCategory !== "trash" && (
                      <button
                        type="button"
                        title="New folder"
                        onClick={() => startCreateFolder("")}
                        className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
                      >
                        <MdCreateNewFolder size={16} />
                      </button>
                    )}
                    {activeFileCategory !== "trash" && (
                      <button
                        type="button"
                        disabled={!selectedFile}
                        title={
                          !selectedFile
                            ? "Select a file to see its tools"
                            : dockerMode === "file-tools"
                            ? isImageFileSelected
                              ? "Hide image tools"
                              : "Show recording controls"
                            : isImageFileSelected
                            ? "Show image tools"
                            : "Show tools for this file"
                        }
                        onClick={() => setDockerMode((prev) => (prev === "record" ? "file-tools" : "record"))}
                        className={`p-1 rounded transition-colors disabled:opacity-30 disabled:pointer-events-none ${
                          dockerMode === "file-tools"
                            ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                            : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
                        }`}
                      >
                        <IoBuildOutline size={15} />
                      </button>
                    )}
                    {(activeFileCategory === "image" || activeFileCategory === "audio") && (
                      <>
                        {activeFileCategory === "audio" && (
                          <>
                            <button
                              type="button"
                              title={`Repeat: ${audioRepeatMode === "off" ? "off" : audioRepeatMode === "all" ? "all" : "one"}`}
                              onClick={cycleAudioRepeatMode}
                              className={`relative p-1 rounded hover:bg-gray-100 dark:hover:bg-neutral-800 ${
                                audioRepeatMode !== "off"
                                  ? "text-blue-600 dark:text-blue-400"
                                  : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400"
                              }`}
                            >
                              <IoRepeatOutline size={14} />
                              {audioRepeatMode === "one" && (
                                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-blue-600 dark:bg-blue-500 text-white text-[8px] font-bold leading-none flex items-center justify-center">
                                  1
                                </span>
                              )}
                            </button>
                            <button
                              type="button"
                              title={`Shuffle: ${audioShuffle ? "on" : "off"}`}
                              onClick={() => setAudioShuffle((prev) => !prev)}
                              className={`p-1 rounded hover:bg-gray-100 dark:hover:bg-neutral-800 ${
                                audioShuffle
                                  ? "text-blue-600 dark:text-blue-400"
                                  : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400"
                              }`}
                            >
                              <IoShuffleOutline size={14} />
                            </button>
                            <button
                              type="button"
                              title={`Autoplay next track: ${audioAutoplayNext ? "on" : "off"}`}
                              onClick={() => setAudioAutoplayNext((prev) => !prev)}
                              className={`p-1 rounded hover:bg-gray-100 dark:hover:bg-neutral-800 ${
                                audioAutoplayNext
                                  ? "text-blue-600 dark:text-blue-400"
                                  : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400"
                              }`}
                            >
                              <IoPlayForwardOutline size={14} />
                            </button>
                            <div className="w-px h-4 bg-gray-300 dark:bg-neutral-600 mx-0.5" />
                          </>
                        )}
                        <button
                          type="button"
                          title="Previous (←)"
                          onClick={() => (activeFileCategory === "audio" ? navigateAudio(-1) : navigateImage(-1))}
                          className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
                        >
                          <IoChevronBack size={14} />
                        </button>
                        <button
                          type="button"
                          title="Next (→)"
                          onClick={() => (activeFileCategory === "audio" ? navigateAudio(1) : navigateImage(1))}
                          className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
                        >
                          <IoChevronForward size={14} />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Bulk action bar — only for a real multi-selection (not trash, which has its
                    own per-item restore/delete-forever actions already). */}
                {activeFileCategory !== "trash" && selectedFilePaths.size > 0 && (
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-200 dark:border-neutral-700 shrink-0 bg-blue-50 dark:bg-blue-500/10">
                    <span className="text-xs font-medium text-blue-700 dark:text-blue-300">
                      {selectedFilePaths.size} selected
                    </span>
                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setBulkMoveMenuOpen((prev) => !prev)}
                          className="flex items-center gap-0.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          Move to
                          <IoChevronForward size={11} className={`transition-transform ${bulkMoveMenuOpen ? 'rotate-90' : ''}`} />
                        </button>
                        {bulkMoveMenuOpen && (
                          <div className="absolute right-0 top-full mt-1 w-40 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg z-20 max-h-48 overflow-y-auto py-0.5">
                            {Object.keys(files)
                              .sort((a, b) => a.localeCompare(b))
                              .map((destFolder) => (
                                <button
                                  key={destFolder || "__root__"}
                                  className="w-full text-left px-3 py-1.5 text-xs truncate hover:bg-gray-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
                                  onClick={() => handleMoveFiles(getSelectedFileEntries(), destFolder)}
                                >
                                  {folderDisplayName(destFolder)}
                                </button>
                              ))}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedFilePaths(new Set())}
                        className="text-xs text-neutral-500 dark:text-neutral-400 hover:underline"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                )}

                {/* pb tracks --docker-height (published by BottomDocker's ResizeObserver, see
                    player.css for the sibling usage) so the last row can always scroll clear of
                    the fixed bottom icon bar instead of rendering underneath it, unclickable.
                    overscroll-contain stops scroll momentum at this list's own top/bottom instead
                    of chaining into whatever's behind it (the main content pane, the tools panel)
                    once you scroll past its own content - each panel should scroll on its own. */}
                <div
                  className="p-3 pb-[var(--docker-height,64px)] text-sm overflow-y-auto overscroll-contain flex-1 text-neutral-800 dark:text-neutral-200"
                >
                {activeFileCategory === "trash" ? (
                  filteredTrashItems.length === 0 ? (
                    <p>{isSearchingFiles ? "No matching trash items" : "Trash is empty"}</p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs text-neutral-500 dark:text-neutral-400">
                          {filteredTrashItems.length} item{filteredTrashItems.length === 1 ? "" : "s"}
                        </span>
                        <button
                          type="button"
                          onClick={handleEmptyTrash}
                          className="text-xs text-red-600 dark:text-red-400 hover:underline"
                        >
                          Empty Trash
                        </button>
                      </div>
                      <ul className="space-y-0.5">
                        {filteredTrashItems.map((item) => (
                          <li
                            key={item.trashed_name}
                            className="flex items-center justify-between gap-2 group px-1 py-1.5 rounded hover:bg-gray-50 dark:hover:bg-neutral-800"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="truncate" title={item.name}>{formatFileName(item.name)}</div>
                              <div className="text-[10px] text-neutral-400 dark:text-neutral-500">Deleted {formatDeletedAt(item.deleted_at)}</div>
                            </div>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                              <button
                                type="button"
                                title="Restore"
                                onClick={() => handleRestoreFromTrash(item)}
                                className="p-1 rounded text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-200 dark:hover:bg-neutral-700"
                              >
                                <IoArrowUndoOutline size={14} />
                              </button>
                              <button
                                type="button"
                                title="Delete forever"
                                onClick={() => handleDeleteForever(item)}
                                className="p-1 rounded text-red-500 hover:bg-red-100 dark:hover:bg-red-500/20"
                              >
                                <IoTrashOutline size={14} />
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  )
                ) : filteredEntries.length === 0 ? (
                  <p>{isSearchingFiles ? `No ${activeFileCategory} files match "${fileSearchQuery.trim()}"` : `No ${activeFileCategory} files found`}</p>
                ) : (
                  filteredEntries.map(([folder, fileList]) => (
                    <div
                      key={folder}
                      className="mb-3"
                      // Folder-as-drop-target: reacts to an in-app file drag (draggingFiles) or an
                      // OS file being dragged in from outside (e.dataTransfer.types includes
                      // "Files", e.g. from Windows Explorer — this "types" check works during
                      // dragover regardless of Tauri's native file-drop interception, which only
                      // affects the final `drop` event's data, not the drag session itself) —
                      // plain mouse hovering does neither, so it never lights up on its own.
                      // This is purely visual/targeting state: for an external OS drag, the actual
                      // import happens in the top-level onFileDropEvent listener above (which is
                      // where the real file paths are available), not in onDrop below — a plain
                      // HTML5 drop of an OS file never carries a usable path here.
                      onDragOver={(e) => {
                        if (!draggingFiles && !e.dataTransfer.types.includes("Files")) return;
                        e.preventDefault();
                        if (dragOverFolder !== folder) setDragOverFolder(folder);
                      }}
                      onDragLeave={() => setDragOverFolder((prev) => (prev === folder ? null : prev))}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (draggingFiles) handleMoveFiles(draggingFiles, folder);
                      }}
                    >
                      <div
                        className={`group/folder flex items-center justify-between gap-1 -mx-1 px-1 py-0.5 rounded transition-colors ${
                          dragOverFolder === folder ? "bg-blue-100 dark:bg-blue-500/20 ring-1 ring-blue-400" : ""
                        }`}
                        style={{ paddingLeft: 4 + folderDepth(folder) * 10 }}
                      >
                        <h4
                          className="text-xs font-semibold text-gray-500 dark:text-neutral-400 flex items-center gap-1 min-w-0 truncate cursor-pointer"
                          title={collapsedFolders.has(folder) ? `Expand ${folderDisplayName(folder)}` : `Collapse ${folderDisplayName(folder)}`}
                          onClick={() => toggleFolderCollapsed(folder)}
                        >
                          <IoChevronForward size={10} className={`shrink-0 transition-transform ${collapsedFolders.has(folder) ? "" : "rotate-90"}`} />
                          <IoFolderOutline size={12} className="shrink-0" />
                          <span className="truncate">{folderDisplayName(folder)}</span>
                        </h4>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover/folder:opacity-100 transition-opacity shrink-0">
                          {isFolderEmpty(folder) && (
                            <button
                              type="button"
                              title="Delete empty folder"
                              onClick={() => handleDeleteFolder(folder)}
                              className="p-0.5 rounded text-gray-400 hover:text-red-500 hover:bg-gray-200 dark:hover:bg-neutral-700"
                            >
                              <IoTrashOutline size={13} />
                            </button>
                          )}
                          <button
                            type="button"
                            title="New subfolder"
                            onClick={() => startCreateFolder(folder)}
                            className="p-0.5 rounded text-gray-400 hover:text-blue-500 hover:bg-gray-200 dark:hover:bg-neutral-700"
                          >
                            <IoAddCircleOutline size={14} />
                          </button>
                        </div>
                      </div>

                      {!collapsedFolders.has(folder) && creatingFolderIn === folder && (
                        <div className="flex items-center gap-1 mt-1" style={{ paddingLeft: 4 + (folderDepth(folder) + 1) * 10 }}>
                          <IoFolderOutline size={12} className="text-gray-400 shrink-0" />
                          <input
                            autoFocus
                            value={newFolderValue}
                            onChange={(e) => setNewFolderValue(e.target.value)}
                            onBlur={commitCreateFolder}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitCreateFolder();
                              if (e.key === "Escape") setCreatingFolderIn(null);
                            }}
                            placeholder="Folder name"
                            className="flex-1 min-w-0 border border-blue-400 rounded px-1 text-xs bg-white dark:bg-neutral-800"
                          />
                        </div>
                      )}

                      {collapsedFolders.has(folder) && !isSearchingFiles ? null : fileList.length === 0 ? (
                        <p
                          className="text-[11px] text-neutral-400 dark:text-neutral-500 italic mt-1"
                          style={{ paddingLeft: 4 + (folderDepth(folder) + 1) * 10 }}
                        >
                          No {activeFileCategory} files
                        </p>
                      ) : (
                        <ul className="mt-1" style={{ paddingLeft: 4 + (folderDepth(folder) + 1) * 10 }}>
                          {fileList.map((file) => (
                            <li
                              key={file.path}
                              draggable
                              onDragStart={(e) => {
                                setDraggingFiles(filesToActOn(file));
                                e.dataTransfer.effectAllowed = "move";
                              }}
                              onDragEnd={() => {
                                setDraggingFiles(null);
                                setDragOverFolder(null);
                              }}
                              className={`flex items-center justify-between gap-1 min-w-0 group cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800 ${
                                selectedFile?.sourcePath === file.path ? 'bg-blue-50 dark:bg-blue-500/10' : ''
                              } ${draggingFiles?.some((f) => f.path === file.path) ? 'opacity-40' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={selectedFilePaths.has(file.path)}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => toggleFileSelected(file.path)}
                                title="Select for bulk move"
                                className={`shrink-0 mr-1.5 accent-blue-500 transition-opacity ${
                                  selectedFilePaths.size > 0 || selectedFilePaths.has(file.path) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                                }`}
                              />
                              {/* MODIFIED: Now clicking plays the file in VideoPlayer */}
                              {renamingFile === file.path ? (
                                <input
                                  className="flex-1 min-w-0 border border-blue-400 rounded px-1 text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100"
                                  autoFocus
                                  value={renameValue}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  onBlur={() => commitRename(file)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') commitRename(file);
                                    if (e.key === 'Escape') setRenamingFile(null);
                                  }}
                                />
                              ) : (
                                <div
                                  className={`flex-1 min-w-0 truncate hover:text-blue-500 dark:hover:text-blue-400 ${
                                    selectedFile?.sourcePath === file.path ? 'text-blue-600 dark:text-blue-400 font-medium' : ''
                                  }`}
                                  title={file.name}
                                  onPointerDown={handleSidebarFilePointerDown(file)}
                                  onPointerMove={handleSidebarFilePointerMove}
                                  onPointerUp={handleSidebarFilePointerUp(file)}
                                >
                                  {formatFileName(file.name)}
                                </div>
                              )}

                              {pinnedPaths.includes(file.path) && (
                                <IoPin
                                  size={12}
                                  className="shrink-0 text-gray-400 dark:text-neutral-500"
                                  title="Pinned to home"
                                />
                              )}

                              {linkedDocsByPath.has(file.path) && (
                                <MdOutlineDescription
                                  size={13}
                                  className="shrink-0 text-gray-400 dark:text-neutral-500"
                                  title={`${linkedDocsByPath.get(file.path)!.length} linked note(s)`}
                                />
                              )}

                              {/* Three vertical dots menu */}
                              <div className="relative">
                                <button
                                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 dark:hover:bg-neutral-700 transition-opacity"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMenu(openMenu === file.path ? null : file.path);
                                    setMoveMenuOpenFor(null);
                                    setLinkDocsMenuOpenFor(null);
                                  }}
                                >
                                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
                                    <path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                                  </svg>
                                </button>

                                {/* Popup Menu */}
                                {openMenu === file.path && (
                                  <div className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg z-20">
                                    <button
                                      className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-neutral-700 text-sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleTogglePin(file);
                                      }}
                                    >
                                      {pinnedPaths.includes(file.path) ? "Unpin from home" : "Pin to home"}
                                    </button>
                                    <button
                                      className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-100 dark:hover:bg-neutral-700 text-sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleLinkNotes(file);
                                      }}
                                    >
                                      Link notes
                                      {linkedDocsByPath.has(file.path) && (linkedDocsByPath.get(file.path)!.length >= 2) && (
                                        <IoChevronForward
                                          size={12}
                                          className={`transition-transform ${linkDocsMenuOpenFor === file.path ? 'rotate-90' : ''}`}
                                        />
                                      )}
                                    </button>
                                    {linkDocsMenuOpenFor === file.path && (
                                      <div className="border-t border-gray-200 dark:border-neutral-700 max-h-40 overflow-y-auto py-0.5">
                                        {(linkedDocsByPath.get(file.path) ?? []).map((doc) => (
                                          <button
                                            key={doc.id}
                                            className="w-full text-left pl-6 pr-3 py-1.5 text-xs truncate hover:bg-gray-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setOpenMenu(null);
                                              setLinkDocsMenuOpenFor(null);
                                              setSelectedFile(null);
                                              setDocsScreen({ mode: "editor", docId: doc.id });
                                            }}
                                          >
                                            {doc.title || "Untitled document"}
                                          </button>
                                        ))}
                                        <button
                                          className="w-full text-left pl-6 pr-3 py-1.5 text-xs truncate hover:bg-gray-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setLinkDocsMenuOpenFor(null);
                                            void (async () => {
                                              try {
                                                const id = crypto.randomUUID();
                                                const title = `Notes for ${file.name}`;
                                                const bytes = Array.from(Y.encodeStateAsUpdate(new Y.Doc()));
                                                await invoke("create_doc", { id, title, bytes });
                                                await invoke("link_doc_to_file", { id, filePath: file.path });
                                                await refreshDocsIndex();
                                                setOpenMenu(null);
                                                setSelectedFile(null);
                                                setDocsScreen({ mode: "editor", docId: id });
                                              } catch (error) {
                                                console.error("Failed to create linked notes:", error);
                                                setError(`Failed to create linked notes: ${error}`);
                                              }
                                            })();
                                          }}
                                        >
                                          + New linked doc
                                        </button>
                                      </div>
                                    )}
                                    <button
                                      className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-neutral-700 text-sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        startRename(file);
                                      }}
                                    >
                                      Rename
                                    </button>
                                     {isConvertibleCategory(getFileCategory(file.name)) && (
                                       <button
                                          className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-neutral-700 text-sm"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setConversionFile(file);
                                            setOpenMenu(null);
                                          }}
                                        >
                                        Convert
                                      </button>
                                     )}

                                    {/* "Move to ▸" — expands in place into the folder list rather
                                        than as a hover flyout, so it works the same on touch/
                                        trackpad as a click, with no hover-timing to get wrong. */}
                                    <button
                                      className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-100 dark:hover:bg-neutral-700 text-sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setMoveMenuOpenFor((prev) => (prev === file.path ? null : file.path));
                                      }}
                                    >
                                      {filesToActOn(file).length > 1 ? `Move ${filesToActOn(file).length} items to` : "Move to"}
                                      <IoChevronForward
                                        size={12}
                                        className={`transition-transform ${moveMenuOpenFor === file.path ? 'rotate-90' : ''}`}
                                      />
                                    </button>
                                    {moveMenuOpenFor === file.path && (
                                      <div className="border-t border-gray-200 dark:border-neutral-700 max-h-40 overflow-y-auto py-0.5">
                                        {Object.keys(files)
                                          .sort((a, b) => a.localeCompare(b))
                                          .map((destFolder) => (
                                            <button
                                              key={destFolder || "__root__"}
                                              disabled={destFolder === folder}
                                              className={`w-full text-left pl-6 pr-3 py-1.5 text-xs truncate ${
                                                destFolder === folder
                                                  ? "text-neutral-300 dark:text-neutral-600 cursor-default"
                                                  : "hover:bg-gray-100 dark:hover:bg-neutral-700 text-neutral-700 dark:text-neutral-300"
                                              }`}
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                if (destFolder !== folder) handleMoveFiles(filesToActOn(file), destFolder);
                                              }}
                                            >
                                              {folderDisplayName(destFolder)}
                                            </button>
                                          ))}
                                      </div>
                                    )}

                                    <button
                                        className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-neutral-700 text-sm text-red-600 dark:text-red-400"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleDeleteFile(file);
                                        }}
                                      >
                                      Delete
                                    </button>
                                  </div>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))
                )}
                </div>
              </div>
            )}
          </div>

          {/* Conversion Dialog */}
          {conversionFile && (
            <ConversionDialog
              filePath={conversionFile.path}
              fileName={conversionFile.name}
              onClose={() => setConversionFile(null)}
              onConverted={async (newPath, newFileName) => {
                console.log('Conversion completed:', newPath);
                setConversionFile(null);
                
                // Refresh file list
                await handleDirectoryFiles();
                
                // Optionally auto-play the converted file
                try {
                  const absolutePath = await invoke<string>("convert_file_path_to_url", { 
                    filepath: newPath 
                  });
                  const fileUrl = convertFileSrc(absolutePath);
                  
                  setSelectedFile({
                    path: fileUrl,
                    name: newFileName,
                    sourcePath: newPath
                  });
                  setBoardScreen(null);
                  setDocsScreen(null);
                } catch (error) {
                  console.error('Error loading converted file:', error);
                }
              }}
            />
          )}
         <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center bg-gray-100 dark:bg-neutral-950">

          {boardScreen ? (
            <BoardWorkspace screen={boardScreen} onScreenChange={setBoardScreen} />
          ) : docsScreen ? (
            <DocsWorkspace
              screen={docsScreen}
              onScreenChange={setDocsScreen}
              libraryFiles={allLibraryFiles}
              onOpenLinkedFile={(path, name) => {
                setDocsScreen(null);
                void loadFileForPlayback(path, name);
              }}
            />
          ) : selectedFile ? (
            getFileCategory(selectedFile.name) === "pdf" ? (
              <PdfAnnotator
                key={selectedFile.path}
                src={selectedFile.path}
                sourcePath={selectedFile.sourcePath}
                title={selectedFile.name}
                isFullscreen={isPdfFullscreen}
                onToggleFullscreen={handleTogglePdfFullscreen}
              />
            ) : getFileCategory(selectedFile.name) === "image" ? (
              <ImageEditor
                key={selectedFile.path}
                sourcePath={selectedFile.sourcePath}
                title={selectedFile.name}
                onSaved={handleImageSaved}
                store={imageEditStore}
                isToolsPanelOpen={dockerMode === "file-tools"}
                onToolsPanelOpenChange={(open) => setDockerMode(open ? "file-tools" : "record")}
              />
            ) : (
              <VideoPlayer
                ref={videoPlayerRef}
                key={selectedFile.path}
                src={selectedFile.path}
                filePath={selectedFile.sourcePath}
                title={selectedFile.name}
                autoPlay={true}
                initialTime={isAudioSelected ? audioPositionsRef.current[selectedFile.sourcePath] : undefined}
                loop={isAudioSelected && audioRepeatMode === "one"}
                onTimeUpdate={(time) => {
                  handleAudioTimeUpdate(time);
                  setPlayerCurrentTime(time);
                }}
                onPlayStateChange={setPlayerIsPlaying}
                onEnded={handleMediaEnded}
                autoplayNext={isAudioSelected ? audioAutoplayNext : videoAutoplayNext}
                onAutoplayNextChange={() =>
                  isAudioSelected ? setAudioAutoplayNext((prev) => !prev) : setVideoAutoplayNext((prev) => !prev)
                }
                overlay={
                  getFileCategory(selectedFile.name) === "video"
                    ? (frameRect) => (
                        <>
                          <VideoOverlayLayer
                          frameRect={frameRect}
                          overlays={editStore.textOverlays}
                          imageOverlays={editStore.imageOverlays}
                          currentOutputTime={currentOutputTime}
                          selectedOverlayId={selectedOverlayId}
                          onSelectOverlay={setSelectedOverlayId}
                          selectedImageOverlayId={selectedImageOverlayId}
                          onSelectImageOverlay={setSelectedImageOverlayId}
                          isPlacingText={isPlacingText}
                          onPlacementConsumed={() => setIsPlacingText(false)}
                          onAddTextOverlay={editStore.addTextOverlay}
                          onUpdateTextOverlayContent={editStore.updateTextOverlayContent}
                          onDeleteTextOverlay={editStore.deleteTextOverlay}
                          onDuplicateTextOverlay={(id) => setSelectedOverlayId(editStore.duplicateTextOverlay(id))}
                          onBringTextOverlayToFront={editStore.bringTextOverlayToFront}
                          onSendTextOverlayToBack={editStore.sendTextOverlayToBack}
                          isPlacingImage={isPlacingImage}
                          onPlacementImageConsumed={() => setIsPlacingImage(false)}
                          onAddImageOverlay={editStore.addImageOverlay}
                          onUpdateImageOverlayContent={editStore.updateImageOverlayContent}
                          onDeleteImageOverlay={editStore.deleteImageOverlay}
                          onDuplicateImageOverlay={(id) => setSelectedImageOverlayId(editStore.duplicateImageOverlay(id))}
                          onBringImageOverlayToFront={editStore.bringImageOverlayToFront}
                          onSendImageOverlayToBack={editStore.sendImageOverlayToBack}
                          blurOverlays={editStore.blurOverlays}
                          selectedBlurOverlayId={selectedBlurOverlayId}
                          onSelectBlurOverlay={setSelectedBlurOverlayId}
                          isPlacingBlur={isPlacingBlur}
                          onPlacementBlurConsumed={() => setIsPlacingBlur(false)}
                          onAddBlurOverlay={editStore.addBlurOverlay}
                          onUpdateBlurOverlayContent={editStore.updateBlurOverlayContent}
                          onDeleteBlurOverlay={editStore.deleteBlurOverlay}
                          onDuplicateBlurOverlay={(id) => setSelectedBlurOverlayId(editStore.duplicateBlurOverlay(id))}
                          totalOutputDuration={editStore.clips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)}
                        />
                        {isCroppingClip && activeClipEffects && (
                          // Keyed on the active clip's own id so a clip change mid-drag (playback
                          // crossing a cut while the user is still holding a handle down - rare,
                          // but possible) unmounts/remounts this instead of silently committing
                          // the in-progress drag to whatever clip happens to be active at release:
                          // onChange closes over `activeClipEffects.id` fresh every render, so
                          // without this key a mid-drag identity change would let the commit land
                          // on the wrong clip using frame geometry computed against the OLD one.
                          <ClipCropOverlay
                            key={activeClipEffects.id}
                            frameRect={frameRect}
                            crop={activeClipEffects.crop}
                            onChange={(crop) => editStore.updateClipEffects(activeClipEffects.id, { crop })}
                            onLivePreview={(crop) => videoPlayerRef.current?.previewCropLive(crop)}
                          />
                        )}
                      </>
                      )
                    : undefined
                }
                trackVolume={editStore.videoAudioVolume}
                trackMuted={editStore.videoAudioMuted}
                activeClipEffects={activeClipEffects}
              />
            )
          ) : (
            <div className="relative flex flex-col items-center justify-center h-full w-full gap-6 px-8 overflow-hidden">
              {/* Purely decorative - a soft color glow plus a faint graph-paper line grid, sat
                  behind everything else in this empty state via z-index/pointer-events:none. Only
                  rendered on this "nothing open yet" screen, not the shared bg-neutral-950
                  container real video/PDF content plays inside a few lines up - a colorful
                  backdrop behind actual footage would fight with it instead of the empty state,
                  where there's nothing else competing for attention. Gated on Settings >
                  Appearance > "Home screen background" (homeBackgroundStyle) - "plain" skips this
                  whole block and falls back to the container's own flat themed background. */}
              {homeBackgroundStyle === "graph" && (
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                  {/* Deliberately faint and static (no drift/animation - motion is what actually
                      catches the eye, more than raw opacity does) - meant to read as a barely-
                      there warmth in the corner, not a "glow" anyone would consciously notice. */}
                  <div className="absolute -top-1/4 -left-1/4 w-[35%] h-[35%] rounded-full blur-2xl opacity-[0.07] dark:opacity-[0.05] bg-[radial-gradient(circle,theme(colors.blue.400),transparent_45%)]" />
                  <svg className="absolute inset-0 w-full h-full text-gray-400/40 dark:text-neutral-500/30" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                      <pattern id="home-empty-grid" width="36" height="36" patternUnits="userSpaceOnUse">
                        <path d="M 36 0 L 0 0 0 36" fill="none" stroke="currentColor" strokeWidth="1" />
                      </pattern>
                      {/* Fades the grid out toward the edges so it reads as a subtle texture behind
                          the centered content rather than a hard-edged tiled pattern. */}
                      <radialGradient id="home-empty-grid-fade" cx="50%" cy="45%" r="65%">
                        <stop offset="0%" stopColor="white" stopOpacity="1" />
                        <stop offset="100%" stopColor="white" stopOpacity="0" />
                      </radialGradient>
                      <mask id="home-empty-grid-mask">
                        <rect width="100%" height="100%" fill="url(#home-empty-grid-fade)" />
                      </mask>
                    </defs>
                    <rect width="100%" height="100%" fill="url(#home-empty-grid)" mask="url(#home-empty-grid-mask)" />
                  </svg>
                </div>
              )}

              <div className="relative flex flex-col items-center gap-3 text-center">
                <div className="flex items-center justify-center w-16 h-16 rounded-full bg-gray-200 dark:bg-neutral-800 text-gray-500 dark:text-neutral-400">
                  <IoVideocam size={28} />
                </div>
                <div>
                  <p className="text-gray-700 dark:text-neutral-200 font-medium">Nothing playing yet</p>
                  <p className="text-gray-500 dark:text-neutral-400 text-sm mt-1">
                    Pick a file from the sidebar, or open one from your computer.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleOpenExternalFile}
                  className="mt-1 px-4 py-2 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:opacity-90 transition-opacity"
                >
                  Open a file
                </button>
              </div>

              {libraryPreviewFiles.length > 0 && (
                <div className="relative w-full max-w-md">
                  <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">
                    From your library
                  </p>
                  <div className="flex flex-col gap-1">
                    {libraryPreviewFiles.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => handleFileClick(file)}
                        className="flex items-center gap-3 px-3 py-2 rounded-md bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 text-left transition-colors"
                      >
                        <span className="text-gray-400 dark:text-neutral-500 shrink-0">
                          {categoryIcon(getFileCategory(file.name))}
                        </span>
                        <span className="text-sm text-gray-700 dark:text-neutral-200 truncate">
                          {formatFileName(file.name)}
                        </span>
                        {pinnedPaths.includes(file.path) && (
                          <IoPin size={13} className="ml-auto text-gray-400 dark:text-neutral-500 shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {!isPdfFullscreen && (
      <BottomDocker
        dockerMode={dockerMode}
        activeFile={selectedFile ? { name: selectedFile.name, path: selectedFile.sourcePath } : null}
        activeFilePlayableSrc={selectedFile?.path ?? null}
        editStore={editStore}
        activeFileCurrentTime={playerCurrentTime}
        onSeekActiveFile={handleSeekActiveFile}
        activeFileIsPlaying={playerIsPlaying}
        onTogglePlayActiveFile={() => videoPlayerRef.current?.togglePlay()}
        onConvertFile={(file) => setConversionFile(file)}
        onRenameFile={renameFile}
        onDeleteFile={handleDeleteFile}
        onExportedFile={handleVideoExported}
        draggingLibraryFile={
          draggingFiles && draggingFiles.length === 1 && getFileCategory(draggingFiles[0].name) === "video"
            ? { path: draggingFiles[0].path, name: draggingFiles[0].name }
            : null
        }
        pendingTimelineInsert={pendingTimelineInsert}
        onTimelineInsertHandled={() => setPendingTimelineInsert(null)}
        onOutputTimeChange={setCurrentOutputTime}
        onActiveClipChange={setActiveClipEffects}
        selectedOverlayId={selectedOverlayId}
        onSelectOverlay={setSelectedOverlayId}
        isPlacingText={isPlacingText}
        onToggleArmPlaceText={() => setIsPlacingText((v) => !v)}
        selectedImageOverlayId={selectedImageOverlayId}
        onSelectImageOverlay={setSelectedImageOverlayId}
        isPlacingImage={isPlacingImage}
        onToggleArmPlaceImage={() => setIsPlacingImage((v) => !v)}
        selectedBlurOverlayId={selectedBlurOverlayId}
        onSelectBlurOverlay={setSelectedBlurOverlayId}
        isPlacingBlur={isPlacingBlur}
        onToggleArmPlaceBlur={() => setIsPlacingBlur((v) => !v)}
        isCroppingClip={isCroppingClip}
        onToggleCroppingClip={() => setIsCroppingClip((v) => !v)}
        selectScreen={selectScreen}
        setScreen={setScreen}
        unSetScreen={unSetScreen}
		screenSize={screenSize} 
        setScreenSize={setScreenSize} 
        overlayShape={overlayShape} 
        setOverlayShape={setOverlayShape} 
        overlayPosition={overlayPosition} 
        setOverlayPosition={setOverlayPosition} 
        overlaySize={overlaySize}
        setOverlaySize={setOverlaySize}
        includeSystemAudio={includeSystemAudio}
        setIncludeSystemAudio={setIncludeSystemAudio}
        selectedScreen={selectedScreen}
        setSelectedScreen={setSelectedScreen}
        windowTitles={windowTitles}
        isMonitoring={isMonitoring}
        setIsMonitoring={setIsMonitoring}
        isRecording={isRecording}
        recordingStartTime={recordingStartTime}
        handleStartRecording={handleStartRecording}
        handleStopRecording={handleStopRecording}
        ramInfo={ramInfo}
        fileName={fileName}
        setFileName={setFileName}
        fileExt={fileExt}
        setFileExt={setFileExt}
        recordType={recordType}
        setRecordType={setRecordType}
        audioDevice={audioDevice}
        videoDevices={videoDevices}
        setVideoDevices={setVideoDevices}
        setAudioDevice={setAudioDevice}
        handleFolderSettings={toggleFileList}
        handleGoHome={handleGoHome}
        isHome={selectedFile === null && boardScreen === null && docsScreen === null}
        handleOpenBoard={handleOpenBoard}
        isBoard={boardScreen !== null}
        handleOpenDocs={handleOpenDocs}
        isDocs={docsScreen !== null}
        handleOpenSettings={handleOpenSettings}
        handleOpenExternalFile={handleOpenExternalFile}
        showFileList={showFileList}
      />
      )}

      {showSettings && <SettingsModal onClose={handleCloseSettings} onSave={handleSettingsSaved} onStorageChanged={handleStorageChanged} />}

      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 items-end">
        {message && <Toast key={`msg-${message}`} message={message} variant="info" onDismiss={() => setMessage("")} />}
        {error && <Toast key={`err-${error}`} message={error} variant="error" onDismiss={() => setError("")} />}
      </div>
    </div>
  );
};

export default Dashboard;
