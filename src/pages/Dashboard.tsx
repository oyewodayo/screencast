// Dashboard.tsx
import FindHideTool, { type FindStatus } from "../components/video/FindHideTool";
import { cancelFaceMatchingDownload, cancelFind, coversFor, downloadFaceMatching, faceMatchingStatus, findEverywhere, outlineKind, type FaceMatchingStatus, type HideEffect, type HideShape, type OutlineKind } from "../utils/objectFind";
// What motion tracking can make follow a subject.
type TrackKind = "text" | "image" | "blur" | "adjustment";
import { cameraEffectSpec } from "../utils/cameraEffect";
import WebcamBubbleMarker from "../components/video/WebcamBubbleMarker";
import type { BubbleRegion } from "../utils/webcamBubble";
import { removeBackground } from "../utils/backgroundRemoval";
import { BLUR_DEFAULT, cutoutBackgroundFromPref } from "../utils/cutoutBackground";
import { VIDEO_CHANNEL, silencedBySolo, useMixerSession } from "../utils/mixerState";
import { useState, useEffect, useRef, useCallback, useMemo, startTransition } from "react";
import { ToolPanelHostContext, ToolPanelOpenContext } from "../components/docker/ToolPanelHost";
import CaptionOverlayLayer from "../components/video/CaptionOverlayLayer";
import { buildCaptionLines } from "../utils/captions";
import * as Y from "yjs";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { ask, open as openFileDialog, message as showMessageDialog } from "@tauri-apps/plugin-dialog";
import MoveCopyMenu, { FileTransferOptions, FileTransferRequest } from "../components/docker/MoveCopyMenu";
import type { PopoverAnchor } from "../hooks/useClampedPopoverPosition";
import BottomDocker, { SHOW_DOCKER_EVENT } from "../components/BottomDocker";
import { listen, emit } from '@tauri-apps/api/event';
import { CaptureCapabilities, WindowInfo } from "../Types";
import { WebviewWindow, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PhysicalPosition, PhysicalSize, availableMonitors } from '@tauri-apps/api/window';
import { fadeTotalMs } from '../utils/annotationStyles';
import { describeShortcutFailures, onGlobalShortcut, onShortcutFailures, type ShortcutAction } from '../services/globalShortcuts';
import { formatFileName, formatFileSize, formatMediaDuration, truncateFileName } from "../utils/Formater";
import { useMediaDurations } from "../hooks/useMediaDurations";
import {
  canMoveFolder,
  folderMatchesQuery,
  getPinnedFolders,
  getSidebarViewMode,
  movedFolderKey,
  orderFolders,
  pinRank,
  repathFolderKey,
  repathPinnedFolders,
  getFolderSorts,
  type FolderSortMap,
  getSidebarCollapsed,
  getSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
  SIDEBAR_RAIL_W,
  type SidebarMode,
  type SidebarViewMode,
} from "../utils/sidebarFolders";
import { FileNameText, SidebarRail, SidebarResizeHandle } from "../components/SidebarResize";
import VideoPlayer, { EditTimeline, VideoPlayerHandle } from "../components/VideoPlayer";
import { seekTimeline, timelineTime } from "../utils/timelineTransport";
import { chapterAtOutputTime, outputChapters } from "../utils/videoChapters";
import useVideoEditStore from "../hooks/useVideoEditStore";
import useImageEditStore from "../hooks/useImageEditStore";
import VideoOverlayLayer from "../components/video/VideoOverlayLayer";
import PipOverlayLayer from "../components/video/PipOverlayLayer";
import { setMasterBus } from "../utils/mixerGraph";
import { isNeutralMaster } from "../utils/masterBus";
import AudioOnlyStage from "../components/video/AudioOnlyStage";
import ClipCropOverlay from "../components/video/ClipCropOverlay";
import { ActiveClipEffects } from "../utils/videoColorFilters";
import ConversionDialog from "../components/ConversionDialog";
import BulkConversionDialog, { BulkConversionSummary } from "../components/BulkConversionDialog";
import PdfAnnotator from "../components/PdfAnnotator";
import ImageEditor from "../components/ImageEditor";
import ImageFolderGallery from "../components/ImageFolderGallery";
import VideoFolderGallery from "../components/VideoFolderGallery";
import PdfFolderGallery from "../components/PdfFolderGallery";
import DocumentFolderGallery from "../components/DocumentFolderGallery";
import BoardWorkspace, { BoardScreen } from "../components/board/BoardWorkspace";
import { BoardEditorHandle } from "../components/board/BoardEditor";
import DocsWorkspace, { DocsScreen } from "../components/docs/DocsWorkspace";
import { ItemLinksProvider } from "../contexts/ItemLinksContext";
import LinksControl from "../components/links/LinksControl";
import { fileRef, normalizePath, type ItemRef } from "../utils/itemLinks";
import WhiteboardWorkspace, { WhiteboardScreen } from "../components/whiteboard/WhiteboardWorkspace";
import MindmapWorkspace, { MindmapScreen } from "../components/mindmap/MindmapWorkspace";
import VideoEditorHome from "../components/video/VideoEditorHome";
import SidebarFileTree, { SidebarSkeleton } from "../components/sidebar/SidebarFileTree";
import SidebarHeader from "../components/sidebar/SidebarHeader";
import { FILE_CATEGORY_TABS } from "../components/sidebar/categoryTabs";
import TidyLibraryDialog from "../components/video/TidyLibraryDialog";
import { folderCollapse } from "../components/sidebar/folderCollapse";
import { useStableCallbacks } from "../hooks/useStableCallbacks";
import { FileEntry, GALLERY_CATEGORIES, SidebarTab, TrashEntry } from "../utils/libraryEntries";
import { setEditorIntent, type EditorIntent } from "../utils/editorIntent";
import NewVideoProjectDialog, { NewVideoProjectRequest } from "../components/video/NewVideoProjectDialog";
import { Clip, OverlayTrackInfo, VideoProjectFrame, createProjectState, isImageClipPath, isVideoProjectPath } from "../utils/videoEditTypes";
import PhonePreviewLayer from "../components/video/PhonePreviewLayer";
import SplitArrangeBar from "../components/video/SplitArrangeBar";
import { usePhonePreview } from "../hooks/usePhonePreview";
import { splitGroupMembers } from "../utils/splitGroups";
import AdjustmentLayersLayer from "../components/video/AdjustmentLayersLayer";
import StageLayer from "../components/video/StageLayer";
import TrackTargetPicker from "../components/video/TrackTargetPicker";
import ExportQueueChip from "../components/docker/ExportQueueChip";
import { type Box as TrackBox, cancelTracking, trackOverlay } from "../utils/motionTracking";
import { type ExportJob, installGlobalCloseGuard, onJobFinished } from "../utils/exportQueue";
import { addCloseGuard, addReleaseBlocker, HIDDEN_TO_TRAY_EVENT, installCloseGuards, quitApp } from "../utils/closeGuards";
import { stopAllPlayback } from "../utils/previewHead";
import { heldItemsFor, isTimelineMarker } from "../utils/timelineClipboard";
import SharePanel from "../components/video/SharePanel";
import { resolveClipPreviewUrl } from "../utils/clipPreviewSource";
import { loadWorkspace, saveWorkspace } from "../utils/sessionRestore";
import { useGradeLut } from "../utils/gradeLuts";
import { clipOutputDuration, outputOffsetToSource, sourceToOutputOffset } from "../utils/clipTiming";
import { OverlayKeyframe, keyframeAt, keyframeStateAt, upsertKeyframe } from "../utils/keyframes";
import TransitionPreviewLayer from "../components/video/TransitionPreviewLayer";
import ClipFxLayer from "../components/video/ClipFxLayer";
import { forgetTimelineBootstrap } from "../components/docker/VideoTimelineDocker";
import ClipHandoffLayer, { ClipHandoffApi } from "../components/video/ClipHandoffLayer";
import ReframePreviewLayer, { type ReframePreview } from "../components/video/ReframePreviewLayer";
import PointerLayer from "../components/video/PointerLayer";
import KeystrokeLayer from "../components/video/KeystrokeLayer";
import ScreenBackdropLayer from "../components/video/ScreenBackdropLayer";
import { useClipRecordings } from "../hooks/useClipRecordings";
import { pointerStyleOf } from "../utils/pointerTrack";
import { buildKeyChips, keystrokeStyleOf } from "../utils/keystrokes";
import { screenContentRect } from "../utils/screenStyle";
import { DocSummary } from "../utils/docTypes";
import ErrorBoundary from "../components/ErrorBoundary";
import SettingsModal from "../components/Modals/SettingsModal";
import PhoneCameraModal from "../components/Modals/PhoneCameraModal";
import { PhoneTransferHost } from "../components/Modals/PhoneTransferModal";
import {
  broadcastToPhones,
  IncomingStatus,
  onPhoneClip,
  onPhoneFileArrived,
  onPhoneRemote,
  onPhoneTimelineFile,
  PhoneRemoteCommand,
  openPhoneTransfer,
  reportPhonePlacement,
  setPhoneTimeline,
} from "../services/phoneTransfer";
import PhoneIncomingTray from "../components/PhoneIncomingTray";
import UsbPhoneTray from "../components/UsbPhoneTray";
import { UsbImportHost } from "../components/Modals/UsbImportModal";
import FileInfoModal from "../components/Modals/FileInfoModal";
import LiveCameraRecordingView from "../components/LiveCameraRecordingView";
import { PresentationLiveBar } from "../components/PresentationControls";
import { getPresentationState, visibleCameras } from "../services/presentation";
import { SnipResult, startSnip } from "../services/snip";

// Record types that capture cameras and no screen (win.rs recording_with_output_va/_v). Mirrors
// CAMERA_ONLY_TYPES in EnhancedScreenOptions.tsx.
const CAMERA_ONLY_RECORD_TYPES = ["va", "v"];
import {
  getPhoneCameraState,
  listenForPhoneCamera,
  PHONE_CAMERA_DEVICE,
  startPhoneCapture,
  subscribePhoneCamera,
  type PhoneCaptureHandle,
} from "../services/phoneCamera";
import Toast from "../components/custom/Toast";
import { copyImageUrlToClipboard } from "../utils/imageClipboard";
import PhoneShelf, { dropOnPhone, phoneDropAt, phonesPaired } from "../components/PhoneShelf";
import { PhonesHubHost } from "../components/PhonesHub";
import UpdateBanner from "../components/custom/UpdateBanner";
import TelemetryNotice from "../components/custom/TelemetryNotice";
import type { RecordingStatus } from "../utils/recordingStatus";
import { cancelCountdown, isCountdownRunning, runRecordingCountdown } from "../utils/recordingCountdown";
import { checkForUpdate } from "../utils/updater";
import { trackEvent } from "../utils/telemetry";
import type { Update } from "@tauri-apps/plugin-updater";
import { AppSettings, loadSettings, saveSettings, updateSettings } from "../utils/appSettings";
import { FileCategory, FILE_CATEGORY_EXTENSIONS, getFileCategory, getFileExtension } from "../utils/fileCategory";
import {
  getPinnedPaths,
  getRecentPaths,
  togglePin,
  recordFileOpened,
  repathFile,
  forgetFile,
} from "../utils/homeScreenFiles";
import { getArrivals, getOpenedAt, recordFileArrived, recordItemOpened } from "../utils/homeScreenFiles";
import { onUsbImported } from "../services/usbPhone";
import { buildHomeItems, homeItemKey, relativeTime, type HomeItem } from "../utils/homeLibraryItems";
import { isOpenableDocument, openDocumentFile } from "../utils/docFileImport";
import type { WhiteboardSummary } from "../utils/whiteboardTypes";
import type { MindmapSummary } from "../utils/mindmapTypes";
import {
  getResumeTime,
  recordPlaybackPosition,
  clearPlaybackPosition,
  flushPlaybackPositions,
  getLastOpenedFile,
  recordLastOpenedFile,
  forgetLastOpenedFile,
  repathPlaybackState,
  forgetPlaybackState,
} from "../utils/playbackResume";
import {
  IoDocumentText,
  IoChevronBack,
  IoArrowUndoOutline,
  IoFolderOutline,
  IoOptionsOutline,
  IoPin,
  IoLocateOutline,
  IoCutOutline,
  IoDocumentTextOutline,
  IoGitNetworkOutline,
  IoMapOutline,
  IoImagesOutline,
  IoFolderOpenOutline,
  IoPhonePortraitOutline,
} from "react-icons/io5";
import { MdOutlineDescription } from "react-icons/md";
const appWindow = getCurrentWebviewWindow()

type RAMInfo = [number, number];


// The sidebar's active tab is either a real file category or the Trash view — the latter isn't
// a FileCategory (getFileCategory never returns it; it's a distinct data source, not an
// extension-based filter over `files`), so it gets its own type rather than being folded in.

// Filters shown in the native "open file" dialog — same extensions the sidebar already
// understands, so anything pickable there is guaranteed playable/viewable here too.
const OPEN_FILE_DIALOG_FILTERS = [
  { name: "All supported files", extensions: Object.values(FILE_CATEGORY_EXTENSIONS).flat() },
  { name: "Video", extensions: FILE_CATEGORY_EXTENSIONS.video },
  { name: "Audio", extensions: FILE_CATEGORY_EXTENSIONS.audio },
  { name: "Image", extensions: FILE_CATEGORY_EXTENSIONS.image },
  { name: "PDF", extensions: FILE_CATEGORY_EXTENSIONS.pdf },
  { name: "Document", extensions: FILE_CATEGORY_EXTENSIONS.document },
];

// Every system-wide shortcut is registered by Rust (src-tauri/src/services/shortcuts.rs, which
// holds the key combinations) and arrives here as a `global-shortcut` action - see the dispatcher
// effect below. The constants that remain are for labels shown to the user.


const toggleOverlayVisibility = async () => {
  const overlayWindow = await WebviewWindow.getByLabel('recording-overlay');
  if (!overlayWindow) return;
  if (await overlayWindow.isVisible()) {
    await overlayWindow.hide();
  } else {
    await overlayWindow.show();
  }
};

// The record shortcut (Ctrl+Shift+R, "record-toggle") starts a full-screen recording with the
// current setup when not recording, or stops the one in progress - a single toggle rather than two
// bindings. It deliberately skips EnhancedScreenOptions' target picker (screen_size is always
// "fullscreen"), since the whole point of a global shortcut is starting without switching to this
// window first.

// Whether a format from the bottom bar can carry this record type - a format picked while on
// "mic only" (mp3) must not be handed to a screen recording started from the tray.
const formatSuitsRecordType = (ext: string, recordType: string): boolean =>
	recordType === 'a' ? ['mp3', 'wav', 'aac', 'wma'].includes(ext) : ['mp4', 'mkv', 'mov', 'webm', 'avi'].includes(ext);
// How long to keep the overlay window shown (but click-through) after draw mode turns off, so a
// stroke that's still fading gets to finish instead of vanishing instantly - the longest fade the
// current Settings > Annotation fade can produce (the overlay's toolbar can switch style, never
// fade), plus margin. "Until I exit" strokes are dropped by the overlay itself on exit; laser trails
// still fade, which is what the laser term covers there.
const annotationFadeGraceMs = (): number => {
	const { annotationFade } = loadSettings();
	return Math.max(fadeTotalMs('pen', annotationFade), fadeTotalMs('laser', annotationFade)) + 400;
};


interface FileMap {
    [folder: string]: FileEntry[]
}

// The Video Editor tool's two states - its landing screen (pick a video), and "a video picked
// there is now open in the editor". See videoEditorScreen's own doc comment below for why the
// second carries no payload of its own.
type VideoEditorScreen = { mode: "home" } | { mode: "editing" };

const Dashboard = () => {
  const [message, setMessage] = useState<string>("");
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);
  // Pause/resume timing model: elapsed time is (now or, while paused, the moment it paused) minus
  // recordingStartTime minus every millisecond already spent paused so far. pausedAccumulatedMs
  // only changes at a pause->resume transition (not every tick), so unlike recordingStartTime this
  // is cheap to keep as ordinary state - ActiveRecordingState/RecordingOverlayWindow both need it
  // as a prop/event field to compute their own ticking display, since each runs its own timer.
  const [isPaused, setIsPaused] = useState<boolean>(false);
  // Live Screen <-> Camera cutting for the recording in progress. canSwitchView: the recording has
  // a second (camera) file to cut to - a separately recorded webcam or the phone camera. The
  // current view is owned here, so the hotkey, the recording bar's buttons and the overlay
  // window's buttons all act on one state (see switchView).
  const [canSwitchView, setCanSwitchView] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'screen' | 'camera'>('screen');
  const [pauseStartedAt, setPauseStartedAt] = useState<number | null>(null);
  const [pausedAccumulatedMs, setPausedAccumulatedMs] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const [ramInfo, setRamInfo] = useState<RAMInfo | null>(null);
  const [fileName, setFileName] = useState(
    () => loadSettings().defaultFileNamePrefix + "_" + new Date().toLocaleDateString().replace(/\//g, "_")
  );
  const [fileExt, setFileExt] = useState(() => loadSettings().defaultFileExt);
  const [recordType, setRecordType] = useState(() => loadSettings().defaultRecordType);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showRecordingDocker, setShowRecordingDocker] = useState<boolean>(() => loadSettings().showRecordingDocker);
  const [showRecordingPanelButtons, setShowRecordingPanelButtons] = useState<boolean>(() => loadSettings().showRecordingPanelButtons);
  const [showDockerStatusBar, setShowDockerStatusBar] = useState<boolean>(() => loadSettings().showDockerStatusBar);

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
  //
  // Not revealed when Rust rebuilt this window hidden to run a recording that needs a page (the
  // phone camera - services/main_window.rs). If asking fails, reveal anyway.
  useEffect(() => {
    let cancelled = false;
    let fallbackTimer: number | undefined;
    const revealWindow = (): void => {
      appWindow.show().catch((err) => console.error("Failed to show main window:", err));
      appWindow.setFocus().catch((err) => console.error("Failed to focus main window:", err));
    };
    void invoke<boolean>("main_window_should_reveal")
      .catch(() => true)
      .then((reveal) => {
        if (cancelled || !reveal) return;
        revealWindow();
        // Safety net: showing an already-visible window is a harmless no-op, so retrying shortly
        // after is free insurance against this specific call failing/never resolving for some
        // reason - a bug in this effect must never be able to leave the user with an app that
        // looks like it silently failed to launch (permanently hidden behind nothing).
        fallbackTimer = window.setTimeout(revealWindow, 1500);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(fallbackTimer);
    };
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
  // The webcam bubble's look, remembered between launches - see AppSettings.cameraOverlayShape.
  const [overlayShape, setOverlayShape] = useState(() => loadSettings().cameraOverlayShape);
  const [overlayPosition, setOverlayPosition] = useState(() => loadSettings().cameraOverlayPosition);
  const [overlaySize, setOverlaySize] = useState(() => loadSettings().cameraOverlaySize);
  // Phone-as-camera (see src/services/phoneCamera.ts). Only the connected flag lives in React
  // state here - the stream itself is held by the service singleton, because the pairing modal,
  // the overlay preview and the recorder below all need the same one.
  const [showPhoneCamera, setShowPhoneCamera] = useState(false);
  const [isPhoneCameraConnected, setIsPhoneCameraConnected] = useState(false);
  // The in-flight phone recording, if any. A ref rather than state: handleStopRecording has to
  // read it synchronously, and nothing renders from it.
  const phoneCaptureRef = useRef<PhoneCaptureHandle | null>(null);
  // True while a stop is in flight, so repeated clicks on Stop (or the hotkey) while the backend is
  // still finalizing don't each run stop_recording and open their own completion popup.
  const isStoppingRef = useRef(false);

  useEffect(
    () => subscribePhoneCamera((s) => setIsPhoneCameraConnected(s.status === "live")),
    []
  );

  // WASAPI loopback ("what you hear") capture, Windows-only - see start_recording's handling of
  // FormData.include_system_audio and services/loopback_audio.rs for why this exists (dshow alone
  // can't capture system audio on a machine with no Stereo Mix-equivalent device). Only
  // meaningful for the screen-capture record types (sva/sa/s); RecordingDocker only shows the
  // toggle for those.
  const [includeSystemAudio, setIncludeSystemAudio] = useState<boolean>(() => loadSettings().defaultIncludeSystemAudio);
  // Opt-in, off by default every session (this is a new, less-proven capture path, so it shouldn't
  // silently carry forward as someone's default). Held in the settings so the Rust-built start
  // request sees it, but settings_store.rs drops it at every launch - see SESSION_ONLY_KEYS.
  // When on (and exactly one camera is selected - see start_recording's own doc comment on why
  // more than one isn't supported), recording_with_output_sva writes the webcam as its own
  // second, uncomposited file alongside the main recording instead of baking it into a single
  // overlay - lets the editor's new PiP layer reposition/resize/reshape it after the fact, which
  // baked-in footage never could be. Recording with this off is byte-for-byte the same as before
  // this feature existed.
  const [separateWebcamCapture, setSeparateWebcamCapture] = useState<boolean>(() => loadSettings().separateWebcamCapture);
  // Opt-in, off by default every session (session-only, same reasoning as separateWebcamCapture
  // above - a new, less-proven capture path). When on, start_recording installs a Windows mouse
  // hook (services/click_tracker.rs) for the duration of the recording and writes every click's
  // time+position to a "<name>.clicks.json" sidecar - the editor's own "auto zoom on click" tool
  // reads this back to suggest where to punch in. Recording with this off starts no hook at all.
  const [trackClicks, setTrackClicks] = useState<boolean>(() => loadSettings().trackClicks);
  // Max output width for screen-capture record types - null means "use the backend's own default"
  // (1920px, see FormData.resolution_width's own doc comment on the Rust side), so a caller that
  // never touches this control gets byte-for-byte the same recording as before it existed. The
  // "Native" option is represented as a very large number rather than a separate flag - see the
  // same doc comment for why that needs no special-casing on either side.
  const [resolutionWidth, setResolutionWidth] = useState<number | null>(() => loadSettings().defaultResolutionWidth);
  // Target capture framerate for screen-capture record types - null means "use the backend's own
  // per-mode default" (60 for sva, 30 for sa/s), same "untouched control changes nothing" reasoning
  // as resolutionWidth above.
  const [framerate, setFramerate] = useState<number | null>(() => loadSettings().defaultFramerate);
  const [windowTitles, setWindowTitles] = useState<WindowInfo[]>([]);
  // Whether a picked window is captured on its own (covered or not) - asked once; until it
  // answers, the cautious answer (it isn't) keeps the bring-it-forward steps in place.
  const captureCapsRef = useRef<CaptureCapabilities>({ window_isolated: false });
  useEffect(() => {
    invoke<CaptureCapabilities>('get_capture_capabilities')
      .then((caps) => { captureCapsRef.current = caps; })
      .catch((err) => console.error('Failed to read capture capabilities:', err));
  }, []);
  const [isMonitoring, setIsMonitoring] = useState<boolean>(false);
  const [showFileList, setShowFileList] = useState<boolean>(false);
  const [sidebarContentReady, setSidebarContentReady] = useState<boolean>(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState<boolean>(true);
  const [isLoadingTrash, setIsLoadingTrash] = useState<boolean>(false);
  const [files, setFiles] = useState<FileMap>({});
  const [activeFileCategory, setActiveFileCategory] = useState<SidebarTab>("video");
  const [trashItems, setTrashItems] = useState<TrashEntry[]>([]);

  useEffect(() => {
    if (!showFileList) {
      setSidebarContentReady(false);
      return;
    }
    const raf = requestAnimationFrame(() => {
      startTransition(() => setSidebarContentReady(true));
    });
    return () => cancelAnimationFrame(raf);
  }, [showFileList]);
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
  // Imperative handle onto whichever BoardEditor is currently mounted (see BoardEditorHandle) -
  // lets the sidebar's "Add to board" menu item and bulk action bar reach into it and reuse its
  // image-import pipeline, the same way videoPlayerRef lets the sidebar reach into VideoPlayer.
  // null whenever boardScreen isn't in "editor" mode (BoardWorkspace renders BoardHome instead,
  // which never attaches anything to this ref).
  const boardEditorRef = useRef<BoardEditorHandle>(null);
  // Which Docs screen (if any) is showing in the main content pane - same null-means-off pattern
  // as boardScreen. See handleOpenDocs.
  const [docsScreen, setDocsScreen] = useState<DocsScreen | null>(null);
  // Which Whiteboard screen (if any) is showing in the main content pane - same null-means-off
  // pattern as boardScreen/docsScreen. See handleOpenWhiteboard.
  const [whiteboardScreen, setWhiteboardScreen] = useState<WhiteboardScreen | null>(null);
  const [mindmapScreen, setMindmapScreen] = useState<MindmapScreen | null>(null);
  // Whiteboards and mind maps for the home screen's "From your library" list (documents come from
  // docsIndex below), and when each library item was last opened - see utils/homeLibraryItems.ts.
  const [whiteboardIndex, setWhiteboardIndex] = useState<WhiteboardSummary[]>([]);
  const [mindmapIndex, setMindmapIndex] = useState<MindmapSummary[]>([]);
  const [openedAt, setOpenedAt] = useState<Record<string, number>>(() => getOpenedAt());
  // Files that came in from a phone - tagged on the home screen with where from (homeScreenFiles.ts).
  const [arrivals, setArrivals] = useState(() => getArrivals());
  useEffect(() => {
    const arrive = (paths: string[], from: string, batch: string) => {
      if (!paths.length) return;
      let recent: string[] = [];
      for (const path of paths) ({ recent } = recordFileArrived(path, from, batch));
      setRecentPaths(recent);
      setArrivals(getArrivals());
      setOpenedAt(getOpenedAt());
    };
    const stopWifi = onPhoneFileArrived((file) => arrive(file.path ? [file.path] : [], file.device_name, file.batch ?? file.id));
    const stopUsb = onUsbImported((t) => arrive(t.paths, t.device_name || "Phone", `usb:${t.id}`));
    return () => {
      stopWifi();
      stopUsb();
    };
  }, []);
  // Which Video Editor screen (if any) is active - same null-means-off pattern as the tool
  // screens above, but with one deliberate difference: "editing" renders nothing of its own. The
  // video editor has always been "an open video in VideoPlayer + FileToolsDocker's video tools",
  // so this state's only job in that mode is to remember that the user got here through the Video
  // Editor tool rather than by clicking a file - which is what keeps the docker's Video Editor
  // icon lit and gives the open video a "Back to video editor" way out. See
  // components/video/VideoEditorHome.tsx's own doc comment.
  const [videoEditorScreen, setVideoEditorScreen] = useState<VideoEditorScreen | null>(null);
  // On the Video Editor's home, a video dragged in from outside opens for editing instead of
  // being imported (VideoEditorHome shows where to drop it, and opens it set up for whatever
  // starter it was asking for).
  const videoEditorHomeRef = useRef(false);
  videoEditorHomeRef.current = videoEditorScreen?.mode === "home";
  const [editorHomeDrag, setEditorHomeDrag] = useState(false);
  const [editorHomeDrop, setEditorHomeDrop] = useState<{ paths: string[]; at: number } | null>(null);
  // Every doc's summary (id/title/linked_to/etc.), refreshed via refreshDocsIndex - backs both the
  // "Link to recording" picker's libraryFiles-independent state and the per-file "has linked
  // notes" badge/menu below, from one list_docs call rather than one find_docs_linked_to per row.
  const [docsIndex, setDocsIndex] = useState<DocSummary[]>([]);
  // "Link notes" flyout inside a file's 3-dot menu when 2+ docs are already linked to it - same
  // expand-in-place pattern the old "Move to" flyout used.
  const [linkDocsMenuOpenFor, setLinkDocsMenuOpenFor] = useState<string | null>(null);
  // Spins the sidebar's manual refresh icon while a refresh is in flight — see handleRefreshFiles.
  const [isRefreshingFiles, setIsRefreshingFiles] = useState<boolean>(false);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  // Which surface owns the inline rename field. The sidebar row and the folder gallery tile both
  // show the same file, so keying the field off renamingFile alone mounted two autoFocus inputs:
  // the second stole focus, the first blurred and committed the untouched name straight away.
  const [renameInGallery, setRenameInGallery] = useState<boolean>(false);
  // Folder relative-path (see FileMap's keys) whose inline "new folder" input is active, or null
  // if none is. "" means creating a top-level folder directly under Briefcast.
  const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null);
  const [newFolderValue, setNewFolderValue] = useState<string>("");
  // Which folders are collapsed lives in the sidebar tree's own store (folderCollapse.ts).
  // Sidebar declutter/ordering controls for the active category's file list - both in-memory
  // only, same lifetime as collapsedFolders above. Hiding empty folders only affects folders with
  // zero files in the *active* category (the "No {category} files" ones) — it never hides a
  // folder while searching (isFolderEmpty-style filtering already takes over then) and the root
  // is never eligible to be hidden.
  const [hideEmptyFolders, setHideEmptyFolders] = useState<boolean>(false);
  // Folders pinned to the top of the sidebar (a work folder kept in reach while editing) and the
  // list/grid choice - both remembered across restarts, see utils/sidebarFolders.ts.
  const [pinnedFolders, setPinnedFolders] = useState<string[]>(() => getPinnedFolders());
  const [sidebarViewMode, setSidebarViewMode] = useState<SidebarViewMode>(() => getSidebarViewMode());
  // The sidebar's width, dragged by its right edge (SidebarResizeHandle below) and kept across
  // launches - one for browsing, one for editing (sidebarFolders.ts) - or folded to its icon rail.
  const [sidebarWidths, setSidebarWidths] = useState<Record<SidebarMode, number>>(() => ({ browsing: getSidebarWidth("browsing"), editing: getSidebarWidth("editing") }));
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => getSidebarCollapsed());
  const setSidebarFolded = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed);
    saveSidebarCollapsed(collapsed);
  };
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [fileSortMode, setFileSortMode] = useState<"name-asc" | "name-desc" | "type">("name-asc");
  const [folderSorts, setFolderSorts] = useState<FolderSortMap>(() => getFolderSorts());
  const sortFileList = (fileList: FileEntry[], folder: string): FileEntry[] => {
    const sorted = [...fileList];
    const folderSort = folderSorts[folder];
    if (folderSort) {
      const dir = folderSort === "date-desc" ? -1 : 1;
      sorted.sort((a, b) => dir * ((a.modified ?? 0) - (b.modified ?? 0)) || a.name.localeCompare(b.name));
      return sorted;
    }
    if (fileSortMode === "name-desc") sorted.sort((a, b) => b.name.localeCompare(a.name));
    else if (fileSortMode === "type") {
      sorted.sort((a, b) => {
        const extA = a.name.split(".").pop()?.toLowerCase() ?? "";
        const extB = b.name.split(".").pop()?.toLowerCase() ?? "";
        return extA.localeCompare(extB) || a.name.localeCompare(b.name);
      });
    } else sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  };
  // Drag-and-drop move: the file(s) currently being dragged (more than one if the dragged file
  // was part of the active multi-selection below), and whichever folder header the pointer is
  // presently over (for the drop-target highlight). Both null outside a drag gesture.
  const [draggingFiles, setDraggingFiles] = useState<FileEntry[] | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  // A folder header being dragged (to move the whole folder) and the "Move folder to…" popover.
  const [draggingFolder, setDraggingFolder] = useState<string | null>(null);
  // Where the user was before a folder gallery took over the main pane (an open video being edited,
  // a board, a document...), so the gallery can offer a one-click way back. `restore` closes over
  // what was on screen at that moment.
  const [returnPoint, setReturnPoint] = useState<{ label: string; restore: () => void } | null>(null);
  const [folderMoveMenu, setFolderMoveMenu] = useState<{ folder: string; anchor: { left: number; top: number } } | null>(null);
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
    // Videos, pictures and sound can be dragged into the open video (addMediaToVideo).
    const category = getFileCategory(file.name);
    if (category !== "video" && category !== "image" && category !== "audio") return;
    if (category !== "video" && !editingVideoRef.current) return;
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
    if (drag.isDragging) setDragPoint({ x: e.clientX, y: e.clientY, over: dropTargetAt(e.clientX, e.clientY) });
  };
  const handleSidebarFilePointerUp = (file: FileEntry) => (e: React.PointerEvent): Promise<void> | void => {
    const drag = sidebarDragRef.current;
    sidebarDragRef.current = null;
    if (!drag?.isDragging) {
      // No real drag happened - a plain tap, handled the same as clicking the filename always has.
      return openFileFromSidebar(file);
    }
    setDraggingFiles(null);
    setDragPoint(null);
    const phone = phoneDropAt(e.clientX, e.clientY);
    if (phone) {
      void dropOnPhone(phone, [file.path]);
      return;
    }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // A drop zone that takes a file itself (a split screen's shot rows).
    const zone = el?.closest("[data-media-drop]");
    if (zone) {
      zone.dispatchEvent(new CustomEvent("media-drop", { detail: { path: file.path }, bubbles: true }));
      return;
    }
    if (el?.closest("[data-timeline-track]")) {
      // Sound gets its own track at the playhead; a video or picture goes where it was dropped.
      if (getFileCategory(file.name) === "audio") void addMediaToVideo(file.path, "end");
      else setPendingTimelineInsert({ paths: [file.path], clientX: e.clientX });
      return;
    }
    // On the picture: shown there, where it was dropped.
    const frame = videoFrameAt(e.clientX, e.clientY);
    if (frame && editingVideoRef.current) {
      const r = frame.getBoundingClientRect();
      void addMediaToVideo(file.path, "overlay", { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, frameAspect: r.width / Math.max(1, r.height) });
    }
  };
  // The player's picture under (x, y), if that's where the point is - by its rectangle: the frame
  // layer lets clicks through (pointer-events: none), so elementFromPoint never returns it.
  const videoFrameAt = (x: number, y: number): HTMLElement | null => {
    const frame = document.querySelector<HTMLElement>("[data-video-frame]");
    const r = frame?.getBoundingClientRect();
    if (!frame || !r || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
    // Not when something else (a dialog, a menu) is on top there.
    const top = document.elementFromPoint(x, y);
    return top && top.closest(".video-container") ? frame : null;
  };
  // Where a sidebar drag would land, for the hint that follows the pointer.
  const dropTargetAt = (x: number, y: number): "timeline" | "video" | "zone" | null => {
    const el = document.elementFromPoint(x, y);
    if (el?.closest("[data-media-drop]")) return "zone";
    if (el?.closest("[data-timeline-track]")) return "timeline";
    if (videoFrameAt(x, y) && editingVideoRef.current) return "video";
    return null;
  };
  const [dragPoint, setDragPoint] = useState<{ x: number; y: number; over: "timeline" | "video" | "zone" | null } | null>(null);
  // The phone shelf (PhoneShelf.tsx): where the pointer is during a drag the shelf should follow -
  // a library file dragged the browser's own way, or files dragged in from Explorer.
  const [externalDrag, setExternalDrag] = useState(false);
  const [shelfPoint, setShelfPoint] = useState<{ x: number; y: number } | null>(null);
  const shelfPointRef = useRef<{ x: number; y: number } | null>(null);
  // Multi-select for bulk move — a set of file.path values, spanning whichever folders are
  // currently visible under the active category. Cleared whenever the category tab changes so
  // a stale selection from "Video" doesn't silently carry over into "Audio".
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set());
  // The one "Move or copy to..." menu (MoveCopyMenu.tsx) every sidebar/gallery Move-to opens.
  const [transferMenu, setTransferMenu] = useState<{ files: { name: string; path: string }[]; anchor: PopoverAnchor } | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; sourcePath: string } | null>(null);
  // Folder relative-path whose images are shown as a thumbnail grid in the main board - set by
  // clicking an Image-tab folder header in the sidebar (see the folder header onClick below), and
  // cleared whenever the active category tab changes so a stale gallery can't linger into another
  // tab's empty state. Independent of selectedFile: opening a thumbnail sets selectedFile without
  // clearing this, so the board's "Back to <folder>" button (below) can return to the grid.
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  // Lifted here (single call site - useVideoEditStore is a stateful hook, unsafe to call from
  // more than one component) so both the video-tools timeline (via BottomDocker/FileToolsDocker/
  // VideoTimelineDocker) and the text-overlay preview layer mounted alongside VideoPlayer below
  // share the exact same edit state/undo-redo stack. Gated to video files only so selecting a
  // pdf/audio/image never triggers a wasted load_video_edit_state invoke.
  const editStore = useVideoEditStore(
    selectedFile && getFileCategory(selectedFile.name) === "video" ? selectedFile.sourcePath : undefined
  );
  // The mixer's session state (open for its meters, solo) - mixerState.ts.
  const mixerSession = useMixerSession();
  // The open project's master bus drives the preview's (mixerGraph.ts) - none outside the editor.
  const editingMaster = selectedFile && getFileCategory(selectedFile.name) === "video" ? editStore.master : undefined;
  useEffect(() => setMasterBus(editingMaster), [editingMaster]);
  // The assembled/output timeline's own total length - a clip's own contribution is
  // (end-start)/speed, not just (end-start), once it has a speed edit (Clip.speed's own doc
  // comment, videoEditTypes.ts): a sped-up clip plays back in LESS output time than its source
  // range spans. Fed to VideoOverlayLayer/PipOverlayLayer below so a freshly-placed overlay's own
  // default end time clamps against the timeline's REAL length instead of a stale, too-long value
  // that ignores every sped-up clip already on it.
  // playbackClips: an audio-only project runs as long as its audio (blankClipsFor).
  const totalOutputDuration = editStore.playbackClips.reduce((sum, c) => sum + clipOutputDuration(c), 0);
  // Burned-in captions preview (CaptionOverlayLayer) - the same lines Save exports.
  const captionLines = useMemo(() => buildCaptionLines(editStore.clips, editStore.captions), [editStore.clips, editStore.captions]);
  // Gated to image files only so selecting a pdf/audio/video never triggers a wasted
  // load_image_edit_state invoke. HEIC/HEIF included - selectedFile.path is already a decoded
  // PNG for them by the time this reads it (see resolveImageDisplayUrl/loadFileForPlayback), so
  // there's nothing left to fail decoding.
  const isImageFileSelected = !!selectedFile && getFileCategory(selectedFile.name) === "image";
  const selectedCategory = selectedFile ? getFileCategory(selectedFile.name) : null;
  const isMediaFileSelected = selectedCategory === "video" || selectedCategory === "audio";
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
  // The on-screen clip's color grade, baked for the player's WebGL layer (gradeLuts.ts).
  const activeGradeLut = useGradeLut(activeClipEffects?.grade);
  // Export's Fill window, shown on the player while the export options are open.
  const [reframePreview, setReframePreview] = useState<ReframePreview | null>(null);
  // Screen-recording polish (Screen Style panel): each source's recorded pointer and shortcuts, the
  // shortcut chips on the output timeline, and the frame's content rectangle (fractions of the
  // project frame) the edited picture is laid out in.
  const clipRecordings = useClipRecordings(editStore.clips);
  const pointerStyle = useMemo(() => pointerStyleOf(editStore.pointerStyle), [editStore.pointerStyle]);
  const keystrokeStyle = useMemo(() => keystrokeStyleOf(editStore.keystrokeStyle), [editStore.keystrokeStyle]);
  const keyChips = useMemo(() => buildKeyChips(editStore.clips, clipRecordings), [editStore.clips, clipRecordings]);
  const projectFrame = activeClipEffects?.frame ?? null;
  const screenContentInset = useMemo(() => {
    if (!editStore.screenStyle || !projectFrame) return null;
    const r = screenContentRect(projectFrame.width, projectFrame.height, editStore.screenStyle);
    return { x: r.x / projectFrame.width, y: r.y / projectFrame.height, width: r.width / projectFrame.width, height: r.height / projectFrame.height };
  }, [editStore.screenStyle, projectFrame?.width, projectFrame?.height]);

  // Moving a keyframed overlay sets its keyframe at the playhead rather than its base x/y (which
  // the keyframes have replaced): the move is added to where the keyframes put it there.
  const keyframeAwarePatch = <P extends { x?: number; y?: number; keyframes?: OverlayKeyframe[] }>(
    overlay: { x: number; y: number; startTime: number; endTime: number; keyframes?: OverlayKeyframe[]; track?: OverlayTrackInfo } | undefined,
    patch: P
  ): P => {
    if (!overlay?.keyframes?.length || patch.keyframes !== undefined) return patch;
    const dx = patch.x !== undefined ? patch.x - overlay.x : 0;
    const dy = patch.y !== undefined ? patch.y - overlay.y : 0;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return patch;
    if (overlay.track) {
      // A motion-tracked overlay keeps following: the drag moves its whole path.
      return { ...patch, keyframes: overlay.keyframes.map((k) => ({ ...k, x: k.x + dx, y: k.y + dy })) } as P;
    }
    const local = Math.max(0, Math.min(overlay.endTime - overlay.startTime, currentOutputTime - overlay.startTime));
    const state = keyframeStateAt(overlay.keyframes, local)!;
    const here = keyframeAt(overlay.keyframes, local);
    const { x: _x, y: _y, ...rest } = patch;
    return { ...rest, keyframes: upsertKeyframe(overlay.keyframes, { time: here?.time ?? local, easing: here?.easing ?? "ease", ...state, x: state.x + dx, y: state.y + dy }) } as P;
  };
  // Live status of VideoPlayer's own noise-reduction Web Audio graph (see its
  // onNoiseReductionStatusChange prop) - relayed straight through to VideoTimelineDocker
  // (noiseReductionStatus) so NoiseReductionPopover can show it, same round-trip shape as
  // activeClipEffects just above, just travelling the other direction (player -> timeline docker
  // instead of timeline docker -> player).
  const [noiseReductionStatus, setNoiseReductionStatus] = useState<"idle" | "calibrating" | "active">("idle");
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [isPlacingText, setIsPlacingText] = useState<boolean>(false);
  const [selectedImageOverlayId, setSelectedImageOverlayId] = useState<string | null>(null);
  const [isPlacingImage, setIsPlacingImage] = useState<boolean>(false);
  const [selectedBlurOverlayId, setSelectedBlurOverlayId] = useState<string | null>(null);
  const [selectedAdjustmentId, setSelectedAdjustmentId] = useState<string | null>(null);
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  // Motion tracking (motionTracking.ts): picking what to follow, then following it.
  const [trackSession, setTrackSession] = useState<null | {
    kind: TrackKind;
    id: string;
    initial: TrackBox;
    tracking: { progress: number; jobId: string } | null;
    error: string | null;
  }>(null);
  const [isPlacingBlur, setIsPlacingBlur] = useState<boolean>(false);
  const [selectedPipOverlayId, setSelectedPipOverlayId] = useState<string | null>(null);
  const [isPlacingPip, setIsPlacingPip] = useState<boolean>(false);
  // "Fix webcam background": the bubble outline is up (WebcamBubbleMarker), and the pip panel to
  // open once it's lifted off the recording.
  const [isMarkingBubble, setIsMarkingBubble] = useState(false);
  // Find & hide (FindHideTool / objectFind.ts): the tool is up, and how its search is going.
  const [isFinding, setIsFinding] = useState(false);
  const [findStatus, setFindStatus] = useState<FindStatus>({ phase: "idle" });
  const findJobRef = useRef<string | null>(null);
  // Face matching's state, read when Find & hide opens (and again once it's been downloaded).
  const [faceMatching, setFaceMatching] = useState<FaceMatchingStatus | null>(null);
  useEffect(() => {
    if (!isFinding) return;
    faceMatchingStatus()
      .then((status) => {
        setFaceMatching(status);
        // Ready: load the models now, while the user draws.
        if (status.state === "ready") void invoke("prepare_face_matching").catch(() => {});
      })
      .catch(() => setFaceMatching(null));
  }, [isFinding]);
  const probeOutline = async (target: { x: number; y: number; width: number; height: number }, anchorTime: number): Promise<OutlineKind> => {
    if (!selectedFile || faceMatching?.state !== "ready") return "unknown";
    try {
      return await outlineKind({ clips: editStore.clips, frame: await resolveTimelineFrame(selectedFile.sourcePath), target, anchorTime });
    } catch {
      return "unknown";
    }
  };
  const runFindAndHide = async (target: { x: number; y: number; width: number; height: number }, effect: HideEffect, shape: HideShape, sensitivity: number, anchorTime: number, person: boolean) => {
    if (!selectedFile) return;
    if (videoPlayerRef.current?.getPlaybackState()?.paused === false) videoPlayerRef.current.togglePlay();
    const jobId = crypto.randomUUID();
    findJobRef.current = jobId;
    try {
      if (person && faceMatching?.state !== "ready") {
        setFindStatus({ phase: "downloading", progress: 0 });
        await downloadFaceMatching((progress) => findJobRef.current === jobId && setFindStatus({ phase: "downloading", progress }));
        if (findJobRef.current !== jobId) return;
        setFaceMatching(await faceMatchingStatus());
      }
      setFindStatus({ phase: "searching", progress: 0, found: 0 });
      const frame = await resolveTimelineFrame(selectedFile.sourcePath);
      const appearances = await findEverywhere({
        clips: editStore.clips,
        frame,
        target,
        anchorTime,
        sensitivity,
        jobId,
        person,
        onProgress: (progress, found) => findJobRef.current === jobId && setFindStatus({ phase: "searching", progress, found }),
      });
      if (findJobRef.current !== jobId) return;
      const W = frame?.width ?? 1920;
      const H = frame?.height ?? 1080;
      editStore.addFoundCovers(coversFor(appearances, effect, shape, 0.12, W, H));
      setFindStatus({ phase: "done", found: appearances.length });
    } catch (err) {
      if (findJobRef.current !== jobId) return;
      const message = String(err instanceof Error ? err.message : err);
      if (message.includes("cancelled") || message.includes("CANCELLED")) setFindStatus({ phase: "idle" });
      else if (message.includes("NO_FACE_IN_OUTLINE")) setFindStatus({ phase: "error", message: "There's no face inside the outline - draw around the face, or choose This thing." });
      else setFindStatus({ phase: "error", message });
    } finally {
      if (findJobRef.current === jobId) findJobRef.current = null;
    }
  };
  const [pipPanelRequest, setPipPanelRequest] = useState<{ id: string } | null>(null);
  // A separately recorded webcam put on the timeline (its own layer, *_webcam.mp4) gets the live
  // background the user records with - automatically, in the editor's full quality: its background is
  // removed and the same blur/colour/picture goes behind them. Only layers added from now on; layers
  // already in a project when it opens are left as they are.
  const seenPipIdsRef = useRef<Set<string> | null>(null);
  const seenForPathRef = useRef<string | null>(null);
  useEffect(() => {
    const path = selectedFile?.sourcePath ?? null;
    if (seenForPathRef.current !== path || seenPipIdsRef.current === null) {
      seenForPathRef.current = path;
      seenPipIdsRef.current = new Set(editStore.pipOverlays.map((o) => o.id));
      return;
    }
    const seen = seenPipIdsRef.current;
    const fresh = editStore.pipOverlays.filter((o) => !seen.has(o.id));
    fresh.forEach((o) => seen.add(o.id));
    const pref = loadSettings().cameraBackground;
    const background = cutoutBackgroundFromPref(pref);
    if (!background) return;
    const webcams = fresh.filter((o) => /_webcam\.[a-z0-9]+$/i.test(o.sourcePath) && !o.cutout && !o.bakedBubble);
    const bySource = new Map<string, string[]>();
    webcams.forEach((o) => bySource.set(o.sourcePath, [...(bySource.get(o.sourcePath) ?? []), o.id]));
    bySource.forEach((ids, sourcePath) => {
      void removeBackground(ids[0], sourcePath, (path) => ids.forEach((id) => editStore.updatePipOverlayContent(id, { cutout: { path, sourcePath, background } })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editStore.pipOverlays, selectedFile?.sourcePath]);

  const handleBubbleMarked = useCallback(
    (sourcePath: string, region: BubbleRegion) => {
      setIsMarkingBubble(false);
      const ids = editStore.liftWebcamBubble(sourcePath, region);
      if (ids.length === 0) {
        window.alert("This clip is sped up, cropped or panned, so its webcam bubble can't be lifted off it.");
        return;
      }
      setSelectedPipOverlayId(ids[0]);
      setPipPanelRequest({ id: ids[0] });
      const crop = { x: region.x, y: region.y, width: region.width, height: region.height };
      // One cut-out serves every piece (same recording, same spot); it starts blurred behind you.
      void removeBackground(
        ids[0],
        sourcePath,
        (path) => ids.forEach((id) => editStore.updatePipOverlayContent(id, { cutout: { path, sourcePath, region: crop, background: { kind: "blur", amount: BLUR_DEFAULT } } })),
        crop
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editStore.liftWebcamBubble, editStore.updatePipOverlayContent]
  );
  // Esc disarms whichever placement tool is armed (and with it the "Click anywhere on the video
  // to place …" banner), the same as clicking its toolbar button again.
  const isPlacingAny = isPlacingText || isPlacingImage || isPlacingBlur || isPlacingPip;
  useEffect(() => {
    if (!isPlacingAny) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setIsPlacingText(false);
      setIsPlacingImage(false);
      setIsPlacingBlur(false);
      setIsPlacingPip(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isPlacingAny]);
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
// File whose "Info" panel (FileInfoModal) is open, from the sidebar file menu.
const [infoFile, setInfoFile] = useState<{path: string; name: string} | null>(null);
// Same panel for a Trash row, which is addressed by its trashed name rather than a live path.
const [infoTrashItem, setInfoTrashItem] = useState<TrashEntry | null>(null);
const [bulkConversionFiles, setBulkConversionFiles] = useState<FileEntry[] | null>(null);
  // What BottomDocker's collapsible panel shows: the default recording-setup controls, or quick
  // tools (rename/convert/reveal/delete + at-a-glance info) for whichever file is currently open.
  // Toggled from the sidebar header's tools icon (next to "new folder"); falls back to "record"
  // whenever there's no open file to show tools for, so it never gets stuck on an empty panel.
  const [dockerMode, setDockerMode] = useState<"record" | "file-tools">("record");
  // While a video is being edited, the sidebar swaps between the timeline tools' docked settings
  // panels ("tools" - see components/docker/ToolPanelHost.tsx) and the usual file list ("media",
  // still needed there to drag clips onto the timeline). toolPanelHostEl is the Tools tab's panel
  // container, held in state (callback ref) so the context re-renders the popovers once it mounts.
  const [videoSidebarTab, setVideoSidebarTab] = useState<"tools" | "media">("tools");
  const [toolPanelHostEl, setToolPanelHostEl] = useState<HTMLDivElement | null>(null);
  // The player's own sidebar panels (viewing captions, chapters) are open - shows the Tools tab
  // for them even when no video is being edited. See VideoPlayer's onSidebarPanelChange.
  const [playerSidebarOpen, setPlayerSidebarOpen] = useState<boolean>(false);
  const handlePlayerSidebarPanelChange = useCallback((open: boolean) => {
    setPlayerSidebarOpen(open);
    if (open) {
      setShowFileList(true);
      setVideoSidebarTab("tools");
    }
  }, []);
  const openToolsPanel = useCallback(() => {
    setShowFileList(true);
    setVideoSidebarTab("tools");
  }, []);
  // Opening a tool from the timeline while the Media tab is showing brings its panel into view.
  useEffect(() => {
    if (!toolPanelHostEl) return;
    const observer = new MutationObserver((records) => {
      if (records.some((r) => r.addedNodes.length > 0)) setVideoSidebarTab("tools");
    });
    observer.observe(toolPanelHostEl, { childList: true });
    return () => observer.disconnect();
  }, [toolPanelHostEl]);
  useEffect(() => {
    if (!selectedFile) setDockerMode("record");
  }, [selectedFile]);
  // Whether each video had its editor open when it was left (a linked document opened, a folder,
  // home, another file), so coming back to it brings the editor back exactly as it was - open or
  // closed - instead of always closed. Session-only. Read in the cleanup, which runs before the
  // reset just above has had its own render, so it still sees the mode the video was left in.
  const dockerModeRef = useRef(dockerMode);
  dockerModeRef.current = dockerMode;
  const editorOpenByVideoRef = useRef(new Map<string, boolean>());
  const selectedVideoPath = selectedFile && getFileCategory(selectedFile.name) === "video" ? selectedFile.sourcePath : null;
  useEffect(() => {
    if (!selectedVideoPath) return;
    return () => {
      editorOpenByVideoRef.current.set(selectedVideoPath, dockerModeRef.current === "file-tools");
    };
  }, [selectedVideoPath]);
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
  // Floating panels drop their backdrop blur while the video plays (index.css) - it costs a frame.
  useEffect(() => {
    document.body.classList.toggle("media-playing", playerIsPlaying);
  }, [playerIsPlaying]);
  useEffect(() => {
    setPlayerCurrentTime(0);
    setPlayerIsPlaying(false);
    // A cross-clip preview switch (see resolvePreviewAssetUrl/handleSeekActiveFile below) may have
    // left the player pointed at some *other* file's asset URL - opening a genuinely different
    // file here always starts fresh, so the "what's actually loaded" tracker needs to reset too.
    previewSourcePathRef.current = selectedFile?.sourcePath ?? null;
    previewSwitchPendingRef.current = false;
    // Closing/replacing the open file is exactly the moment where the position updates still
    // sitting in playbackResume's write-behind buffer matter most (leaving for Docs/home unmounts
    // the player, so no further ticks are coming), so force them out instead of waiting for the
    // timer. Runs on unmount too, via the cleanup.
    return flushPlaybackPositions;
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
  // True while handleSeekActiveFile is switching the player to a different file - from resolving its
  // URL until the player has landed on the requested frame. Meanwhile the player still shows and
  // reports the clip being left, so its time reports are ignored.
  const previewSwitchPendingRef = useRef(false);
  // Where that switch is headed (source time) - what the playback state reports until it's there.
  const pendingSeekTimeRef = useRef(0);
  // Gapless clip changes (ClipHandoffLayer): a warmed standby of the next clip that covers the switch.
  const handoffRef = useRef<ClipHandoffApi | null>(null);

  // useCallback'd (stable identity across renders, not just a stable cache Map) because these
  // three resolvers are passed as props into ImageFolderGallery, whose own thumbnail-resolving
  // effect depends on resolveThumbnailUrl's identity (see that file). Without this, every
  // Dashboard re-render - including one triggered by nothing more than a gallery selection click,
  // since selectedFilePaths lives here - handed the gallery a brand-new function reference, which
  // re-triggered that effect and re-resolved every already-cached thumbnail on every click. That
  // was the actual "selection is lagging/hanging" bug: not the selection logic itself, but a full
  // thumbnail-resolution storm firing on every click as a side effect of it.
  // bypassCache is for exactly one case: a video's poster was just overwritten in place
  // (set_video_thumbnail, conversion.rs) at the SAME cache path it always had, so neither this
  // Map nor the browser's own HTTP cache has any way to notice the bytes underneath changed - see
  // the video-thumbnail-updated listener below. The `?t=` it appends only matters for that path;
  // every normal (non-bypassed) resolve keeps returning the plain, cacheable URL.
  const resolvePreviewAssetUrl = useCallback(async (sourcePath: string, bypassCache = false): Promise<string> => {
    if (!bypassCache) {
      const cached = previewAssetUrlCacheRef.current.get(sourcePath);
      if (cached) return cached;
    }
    const absolutePath = await invoke<string>("convert_file_path_to_url", { filepath: sourcePath });
    const url = convertFileSrc(absolutePath) + (bypassCache ? `?t=${Date.now()}` : "");
    previewAssetUrlCacheRef.current.set(sourcePath, url);
    return url;
  }, []);

  // The open timeline's frame size - a project's own (its file's header), or the open video's
  // native resolution. Image clips preview letterboxed into exactly this frame (see
  // get_image_clip_proxy), which is what keeps their crop/Ken Burns/overlay positions identical in
  // preview and export. null if it couldn't be read; cached per primary file for the session.
  const timelineFrameCacheRef = useRef<Map<string, Promise<VideoProjectFrame | null>>>(new Map());
  // A canvas chosen for the edit (canvasFormats.ts) is the timeline's frame instead.
  const canvasRef = useRef(editStore.canvas);
  canvasRef.current = editStore.canvas;
  // A canvas's Blur background (canvasFormats.ts) - not under a Screen Style, which draws its own.
  const canvasBlur = editStore.canvas?.background === "blur" && !editStore.screenStyle;
  const canvasBlurRef = useRef(canvasBlur);
  canvasBlurRef.current = canvasBlur;
  const resolveTimelineFrame = useCallback((primaryPath: string): Promise<VideoProjectFrame | null> => {
    const canvas = canvasRef.current;
    if (canvas) return Promise.resolve({ width: canvas.width, height: canvas.height });
    let pending = timelineFrameCacheRef.current.get(primaryPath);
    if (!pending) {
      pending = (
        isVideoProjectPath(primaryPath)
          ? invoke<VideoProjectFrame>("read_video_project", { projectPath: primaryPath })
          : invoke<Record<string, string>>("get_conversion_info", { inputPath: primaryPath }).then((info) => {
              const match = info.resolution?.match(/^(\d+)x(\d+)$/);
              return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
            })
      ).catch((error) => {
        console.error("Failed to read timeline frame size for", primaryPath, error);
        timelineFrameCacheRef.current.delete(primaryPath);
        return null;
      });
      timelineFrameCacheRef.current.set(primaryPath, pending);
    }
    return pending;
  }, []);

  // An image clip's preview source - a cached still-video proxy of that image, fitted to the
  // timeline's frame (see clipPreviewSource.ts, shared with the transition preview and the clip
  // viewer so all three show the same picture). The prefetch effect below and an actual seek share
  // one encode through that module's cache.
  const resolveImageClipProxyUrl = useCallback(
    async (imagePath: string, primaryPath: string): Promise<string> =>
      resolveClipPreviewUrl(imagePath, await resolveTimelineFrame(primaryPath), canvasBlurRef.current ? "blur" : null),
    [resolveTimelineFrame]
  );
  // Stable (TransitionPreviewLayer's animation loop restarts whenever it changes).
  // During a clip handoff, the standby stands in for the player; mid-switch without one, the player's
  // own report still belongs to the clip it's leaving, so it reads as "not there yet".
  const getMainPlaybackState = useCallback(() => videoPlayerRef.current?.getPlaybackState() ?? null, []);
  const getMainVideoElement = useCallback(() => videoPlayerRef.current?.getVideoElement() ?? null, []);
  const getPlayerPlaybackState = useCallback(() => {
    const handoff = handoffRef.current;
    if (handoff?.isActive()) return handoff.state();
    const main = videoPlayerRef.current?.getPlaybackState() ?? null;
    if (main && previewSwitchPendingRef.current) return { ...main, src: null, time: pendingSeekTimeRef.current, hasFrame: false };
    return main;
  }, []);
  // The timeline's frame-accurate clip-boundary check reads this - null while it can't be trusted.
  const getTimelinePlayerTime = useCallback((): number | null => {
    const handoff = handoffRef.current;
    if (handoff?.isActive()) return handoff.state()?.time ?? null;
    if (previewSwitchPendingRef.current) return null;
    const main = videoPlayerRef.current?.getPlaybackState();
    return main && !main.seeking ? main.time : null;
  }, []);
  const isMainSwitching = useCallback(() => previewSwitchPendingRef.current, []);
  const seekMainPlayer = useCallback((time: number) => videoPlayerRef.current?.seek(time), []);

  // The exact output time right now - the on-screen clip's output start plus how far the player is
  // into it, read from the <video> itself. For per-frame preview (keyframed overlays); the
  // timeline's own currentOutputTime only updates a few times a second.
  const outputTimingRef = useRef<{ clips: Clip[]; activeId: string | null }>({ clips: [], activeId: null });
  outputTimingRef.current = { clips: editStore.playbackClips, activeId: activeClipEffects?.id ?? null };
  const getExactOutputTime = useCallback((): number | null => {
    const playback = getPlayerPlaybackState();
    const { clips, activeId } = outputTimingRef.current;
    const index = clips.findIndex((c) => c.id === activeId);
    if (!playback || index < 0) return null;
    let start = 0;
    for (let i = 0; i < index; i++) start += clipOutputDuration(clips[i]);
    const clip = clips[index];
    return start + sourceToOutputOffset(clip, Math.max(clip.start, Math.min(clip.end, playback.time)));
  }, [getPlayerPlaybackState]);
  // The player's bar and time readout follow the edit while the timeline editor is open.
  const editingTimeline = dockerMode === "file-tools" && editStore.playbackClips.length > 0;
  // Its chapters on the edit's time; a changed one is re-anchored to the moment now under it, and
  // chapters on footage that's been cut out (not on the timeline) are kept as they are.
  const editChapters = editStore.chapters;
  const editClips = editStore.clips;
  const setEditChapters = editStore.setChapters;
  const playerEditTimeline = useMemo<EditTimeline | null>(() => {
    if (!editingTimeline) return null;
    const shown = outputChapters(editClips, editChapters);
    return {
      duration: totalOutputDuration,
      getTime: () => timelineTime() ?? getExactOutputTime(),
      seek: seekTimeline,
      chapters: shown,
      onChaptersChange: (next) => {
        const before = new Map(shown.map((c) => [c.id, c]));
        const cutOut = editChapters.filter((c) => !before.has(c.id));
        const kept = next.flatMap((c) => {
          const was = before.get(c.id);
          const original = editChapters.find((o) => o.id === c.id);
          if (was && original && Math.abs(was.time - c.time) < 1e-3) return [{ ...original, label: c.label }];
          const anchored = chapterAtOutputTime(editClips, c.time, c.label);
          return anchored ? [{ ...anchored, id: c.id }] : [];
        });
        setEditChapters([...cutOut, ...kept]);
      },
    };
  }, [editingTimeline, totalOutputDuration, getExactOutputTime, editClips, editChapters, setEditChapters]);

  // ---- Motion tracking: pick what to follow on the paused frame, follow it, bake it into the
  // overlay's keyframes (motionTracking.ts) as one undo step.
  const trackAnchorRef = useRef(0);
  const overlayForTracking = (kind: TrackKind, id: string) => {
    if (kind === "adjustment") {
      // An adjustment layer's area, followed like a blur region (position only).
      const l = editStore.adjustmentLayers.find((a) => a.id === id);
      const r = l?.region;
      return l && r ? { x: r.x, y: r.y, width: r.width, height: r.height, startTime: l.startTime, endTime: l.endTime, keyframes: r.keyframes } : undefined;
    }
    return kind === "text" ? editStore.textOverlays.find((o) => o.id === id) : kind === "image" ? editStore.imageOverlays.find((o) => o.id === id) : editStore.blurOverlays.find((o) => o.id === id);
  };
  const startMotionTrack = (kind: TrackKind, id: string) => {
    const o = overlayForTracking(kind, id);
    if (!o) return;
    // The timeline's playhead; the player's exact clock refines it only when they agree (it can
    // still report where playback ended after the timeline has moved on).
    const exact = getExactOutputTime();
    const t = exact !== null && Math.abs(exact - currentOutputTime) < 0.5 ? exact : currentOutputTime;
    if (o.endTime - o.startTime < 0.25) {
      setMessage("This overlay is only on screen for a moment - drag its end on the timeline to make it longer, then track");
      return;
    }
    if (t < o.startTime - 1e-3 || t > o.endTime + 1e-3) {
      setMessage("Move the playhead to a moment when the overlay is on screen, then track");
      return;
    }
    if (videoPlayerRef.current?.getPlaybackState()?.paused === false) videoPlayerRef.current.togglePlay();
    trackAnchorRef.current = t;
    const state = keyframeStateAt(o.keyframes, t - o.startTime) ?? { x: o.x, y: o.y };
    // The picker starts on the overlay itself - right for a blur region over what it hides; for a
    // title or sticker the user drags it onto the thing to follow.
    const initial = { x: Math.max(0, Math.min(1 - o.width, state.x)), y: Math.max(0, Math.min(1 - o.height, state.y)), width: Math.min(1, o.width), height: Math.min(1, o.height) };
    setTrackSession({ kind, id, initial, tracking: null, error: null });
  };
  const runMotionTrack = async (target: TrackBox, followScale: boolean) => {
    const session = trackSession;
    const o = session && overlayForTracking(session.kind, session.id);
    if (!session || !o || !selectedFile) return;
    const jobId = crypto.randomUUID();
    setTrackSession((s) => (s ? { ...s, tracking: { progress: 0, jobId }, error: null } : s));
    try {
      const frame = await resolveTimelineFrame(selectedFile.sourcePath);
      const result = await trackOverlay({
        clips: editStore.clips,
        frame,
        overlay: o,
        target,
        anchorTime: trackAnchorRef.current,
        followScale,
        positionOnly: session.kind === "blur" || session.kind === "adjustment",
        jobId,
        onProgress: (progress) => setTrackSession((s) => (s?.tracking?.jobId === jobId ? { ...s, tracking: { progress, jobId } } : s)),
      });
      const patch = { keyframes: result.keyframes, track: result.track };
      if (session.kind === "text") editStore.updateTextOverlayContent(session.id, patch);
      else if (session.kind === "image") editStore.updateImageOverlayContent(session.id, patch);
      else if (session.kind === "adjustment") {
        const region = editStore.adjustmentLayers.find((a) => a.id === session.id)?.region;
        if (region) editStore.updateAdjustmentLayer(session.id, { region: { ...region, ...patch } });
      } else editStore.updateBlurOverlayContent(session.id, patch);
      setTrackSession(null);
      const lost = Math.round(result.track.lostFraction * 100);
      setMessage(lost > 20 ? `Following it - it was out of sight ${lost}% of the time, held in place there` : "Pinned - it follows the motion now");
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setTrackSession((s) => (s && s.tracking?.jobId === jobId ? { ...s, tracking: null, error: /cancel/i.test(text) ? null : text } : s));
    }
  };
  const cancelMotionTrack = () => {
    if (trackSession?.tracking) void cancelTracking(trackSession.tracking.jobId);
    setTrackSession(null);
  };

  // ---- Adding a library file to the open video: dragged from the sidebar or from its "+" menu.
  // "insert" puts a video or picture on the timeline after the clip at the playhead, "end" after
  // the last clip, "overlay" shows a picture (or a video, as picture-in-picture) on the video -
  // at `at` (frame fractions) when dropped there - and sound always goes on its own track.
  const editingVideoRef = useRef(false);
  editingVideoRef.current = !!selectedFile && getFileCategory(selectedFile.name) === "video" && dockerMode === "file-tools";
  const addMediaToVideo = async (path: string, how: "insert" | "end" | "overlay", at?: { x: number; y: number; frameAspect: number }) => {
    const category = getFileCategory(path.split(/[\\/]/).pop() ?? path);
    const total = totalOutputDuration;
    const t = Math.max(0, Math.min(currentOutputTime, total));
    const fileDuration = async () => {
      const info = await invoke<Record<string, string>>("get_conversion_info", { inputPath: path });
      const d = parseFloat(info.duration?.match(/[\d.]+/)?.[0] ?? "");
      if (!Number.isFinite(d) || d <= 0) throw new Error("Couldn't read how long it is");
      return d;
    };
    try {
      if (category === "audio") {
        const d = await fileDuration();
        editStore.addAudioOverlay(path, d, t, Math.min(total, t + d));
        setMessage("Added on its own audio track at the playhead");
        return;
      }
      if (how !== "overlay") {
        let index = editStore.clips.length;
        if (how === "insert") {
          let end = 0;
          index = editStore.clips.findIndex((c) => (end += clipOutputDuration(c)) > t + 1e-3) + 1;
          if (index <= 0) index = editStore.clips.length;
        }
        await editStore.insertClipAt(path, index);
        return;
      }
      // On the video, centred where it was dropped (or in the middle), a third of the frame wide.
      const frameAspect = at?.frameAspect ?? 16 / 9;
      const place = (aspect: number) => {
        const width = 0.33;
        const height = Math.min(1, (width * frameAspect) / aspect);
        const cx = at?.x ?? 0.5;
        const cy = at?.y ?? 0.5;
        return { x: Math.max(0, Math.min(1 - width, cx - width / 2)), y: Math.max(0, Math.min(1 - height, cy - height / 2)), width, height };
      };
      const start = total > 0 ? Math.max(0, Math.min(t, total - Math.min(5, total))) : 0;
      if (category === "image") {
        const size = await new Promise<{ w: number; h: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => reject(new Error("Couldn't open the picture"));
          img.src = convertFileSrc(path);
        });
        const box = place(size.w / Math.max(1, size.h));
        setSelectedImageOverlayId(editStore.addImageOverlay(path, box.x, box.y, box.width, box.height, start, Math.min(total, start + 5)));
        return;
      }
      const [w, h] = await invoke<[number, number]>("video_frame_size", { sourcePath: path });
      const d = await fileDuration();
      const box = place(w / Math.max(1, h));
      setSelectedPipOverlayId(editStore.addPipOverlay(path, d, box.x, box.y, box.width, box.height, t, Math.min(total, t + d)));
    } catch (err) {
      setError(`Couldn't add ${path.split(/[\\/]/).pop()}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const [addMenuFor, setAddMenuFor] = useState<string | null>(null);

  // ---- From a phone: its "Add to timeline" button and Android's share sheet (see
  // phone_transfer_page.html). Phones are told which video is open, and offer "Add to timeline"
  // while there is one. Files arrive one at a time; a batch goes in after the clip at the playhead
  // in the order it was picked - each after the one before - and sound lines up on its own track
  // from the playhead. Every file gets an answer, so the phone can say where it really landed.
  const phoneTimelineName =
    selectedFile && getFileCategory(selectedFile.name) === "video" && dockerMode === "file-tools" ? selectedFile.name : null;
  useEffect(() => {
    void setPhoneTimeline(phoneTimelineName);
  }, [phoneTimelineName]);
  const phoneBatchRef = useRef<{ batch: string; index: number; audioAt: number; added: number } | null>(null);
  // Voice-over takes on the timeline, by the upload that brought them - a Retake swaps one out.
  const voiceTakesRef = useRef(new Map<string, string>());
  const placeFromPhoneRef = useRef<(file: IncomingStatus) => Promise<void>>(async () => {});
  placeFromPhoneRef.current = async (file) => {
    const keep = (why: string) => void reportPhonePlacement(file, false, why);
    if (!editingVideoRef.current || !file.path) return keep("No video is open in Briefcast — saved to your library");
    if (file.target === "voiceover") {
      let d = file.duration ?? NaN;
      if (!Number.isFinite(d) || d <= 0) {
        const info = await invoke<Record<string, string>>("get_conversion_info", { inputPath: file.path }).catch(() => ({} as Record<string, string>));
        d = parseFloat(info.duration?.match(/[\d.]+/)?.[0] ?? "");
      }
      if (!Number.isFinite(d) || d <= 0) return keep("Briefcast couldn't read this take — saved to your library");
      const at = Math.max(0, Math.min(file.at ?? currentOutputTime, totalOutputDuration));
      const replaced = file.replaces ? voiceTakesRef.current.get(file.replaces) : undefined;
      if (replaced) {
        editStore.deleteAudioOverlay(replaced);
        voiceTakesRef.current.delete(file.replaces!);
      }
      const end = Math.max(at + 0.1, Math.min(totalOutputDuration, at + d));
      voiceTakesRef.current.set(file.id, editStore.addAudioOverlay(file.path, d, at, end));
      setMessage(`${replaced ? "Retake" : "Voice-over"} from ${file.device_name} placed on its own track`);
      void reportPhonePlacement(file, true);
      return;
    }
    const category = getFileCategory(file.name);
    if (category !== "video" && category !== "image" && category !== "audio") {
      return keep("Not a picture, video or sound — saved to your library");
    }
    const batch = file.batch ?? file.id;
    let cursor = phoneBatchRef.current;
    if (!cursor || cursor.batch !== batch) {
      const t = Math.max(0, Math.min(currentOutputTime, totalOutputDuration));
      let end = 0;
      let index = editStore.clips.findIndex((c) => (end += clipOutputDuration(c)) > t + 1e-3) + 1;
      if (index <= 0) index = editStore.clips.length;
      cursor = phoneBatchRef.current = { batch, index, audioAt: t, added: 0 };
    }
    try {
      if (category === "audio") {
        const info = await invoke<Record<string, string>>("get_conversion_info", { inputPath: file.path });
        const d = parseFloat(info.duration?.match(/[\d.]+/)?.[0] ?? "");
        if (!Number.isFinite(d) || d <= 0) return keep("Briefcast couldn't read this sound — saved to your library");
        const total = Math.max(totalOutputDuration, cursor.audioAt + d);
        editStore.addAudioOverlay(file.path, d, cursor.audioAt, Math.min(total, cursor.audioAt + d));
        cursor.audioAt += d;
      } else {
        if (!(await editStore.insertClipAt(file.path, cursor.index))) {
          return keep("Briefcast couldn't open this file — saved to your library");
        }
        cursor.index += 1;
      }
      cursor.added += 1;
      setMessage(
        cursor.added === 1
          ? `Added ${file.name} from ${file.device_name}`
          : `Added ${cursor.added} files from ${file.device_name} to the timeline`
      );
      void reportPhonePlacement(file, true);
    } catch (err) {
      keep(`Couldn't add it (${err instanceof Error ? err.message : String(err)}) — saved to your library`);
    }
  };
  // One at a time, in arrival order - a batch's files must not race each other into the timeline.
  useEffect(() => {
    let chain = Promise.resolve();
    const stop = onPhoneTimelineFile((file) => {
      chain = chain.then(() => placeFromPhoneRef.current(file)).catch(() => {});
    });
    return () => {
      stop();
      void setPhoneTimeline(null);
    };
  }, []);

  // Ctrl+V in the video editor: what was copied on the timeline (timelineClipboard.ts), pasted at
  // the playhead - or, when something else was copied since, that: files copied in Explorer
  // (videos go in as clips at the playhead, pictures onto the video, sound on its own track), or a
  // picture on the clipboard (a screenshot, an image copied in a browser), saved to the library's
  // Pasted folder and put on the video.
  const pasteRef = useRef<(e: ClipboardEvent) => void>(() => {});
  pasteRef.current = (e: ClipboardEvent) => {
    if (!editingVideoRef.current) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    const data = e.clipboardData;
    const text = data ? data.getData("text/plain") : null;
    const held = heldItemsFor(text);
    const t = Math.max(0, Math.min(currentOutputTime, totalOutputDuration));
    if (held) {
      e.preventDefault();
      // Clips go in after the clip at the playhead.
      let end = 0;
      let index = editStore.clips.findIndex((c) => (end += clipOutputDuration(c)) > t + 1e-3) + 1;
      if (index <= 0) index = editStore.clips.length;
      editStore.pasteItems(held, index, t);
      return;
    }
    if (text && isTimelineMarker(text)) return; // a copy from an older session - nothing held
    const hasFiles = !!data && (data.files.length > 0 || Array.from(data.types).includes("Files"));
    if (!hasFiles) return;
    e.preventDefault();
    const picture = data ? Array.from(data.files).find((f) => f.type.startsWith("image/")) : undefined;
    void (async () => {
      const paths = await invoke<string[]>("clipboard_file_paths").catch(() => [] as string[]);
      const usable = paths.filter((p) => ["video", "image", "audio"].includes(getFileCategory(p.split(/[\\/]/).pop() ?? p) ?? ""));
      if (usable.length > 0) {
        for (const path of usable) {
          // eslint-disable-next-line no-await-in-loop
          await addMediaToVideo(path, getFileCategory(path.split(/[\\/]/).pop() ?? path) === "image" ? "overlay" : "insert");
        }
        setMessage(usable.length === 1 ? "Pasted into the video" : `Pasted ${usable.length} files into the video`);
        return;
      }
      if (picture) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(picture);
        });
        const saved = await invoke<string>("save_pasted_image", { dataBase64: dataUrl, extension: picture.type.split("/")[1] ?? "png" });
        await addMediaToVideo(saved, "overlay");
        void handleDirectoryFiles();
        setMessage("Pasted the picture onto the video (saved in Pasted)");
        return;
      }
      if (paths.length > 0) setMessage("Only videos, pictures and sound can be pasted into a video");
    })().catch((err) => setError(`Couldn't paste: ${err instanceof Error ? err.message : String(err)}`));
  };
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => pasteRef.current(e);
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  // One thing selected at a time across overlays and adjustment layers (each has its own panel).
  const selectAdjustment = useCallback((id: string | null) => {
    setSelectedAdjustmentId(id);
    if (id) {
      setSelectedOverlayId(null);
      setSelectedImageOverlayId(null);
      setSelectedBlurOverlayId(null);
      setSelectedPipOverlayId(null);
      setSelectedSceneId(null);
    }
  }, []);
  useEffect(() => {
    if (selectedOverlayId || selectedImageOverlayId || selectedBlurOverlayId || selectedPipOverlayId) setSelectedAdjustmentId(null);
  }, [selectedOverlayId, selectedImageOverlayId, selectedBlurOverlayId, selectedPipOverlayId]);
  // A click on the player around the picture (the black bars) lets go of the selected picture,
  // region or PiP - as a click on the picture away from them already does (VideoOverlayLayer) -
  // and, like that one, only deselects: the click doesn't also start or pause playback.
  // The split screen the selected layer belongs to (SplitArrangeBar).
  const [phonePreview] = usePhonePreview();
  const selectedSplitGroup =
    (selectedPipOverlayId ? editStore.pipOverlays.find((o) => o.id === selectedPipOverlayId)?.split?.group : undefined) ??
    (selectedImageOverlayId ? editStore.imageOverlays.find((o) => o.id === selectedImageOverlayId)?.split?.group : undefined);
  const selectedSplit = useMemo(() => {
    if (!selectedSplitGroup) return null;
    const { cells, settings } = splitGroupMembers(editStore.pipOverlays, editStore.imageOverlays, selectedSplitGroup);
    return settings && cells > 0 ? { group: selectedSplitGroup, cells, settings } : null;
  }, [selectedSplitGroup, editStore.pipOverlays, editStore.imageOverlays]);
  const hasPictureSelectionRef = useRef(false);
  hasPictureSelectionRef.current = !!(selectedImageOverlayId || selectedBlurOverlayId || selectedPipOverlayId);
  useEffect(() => {
    let swallowClick = false;
    const aroundPicture = (target: EventTarget | null) => {
      const el = target instanceof Element ? target : null;
      if (!el || !el.closest(".video-container") || el.closest("[data-video-frame]")) return false;
      return el.tagName === "VIDEO" || el.tagName === "CANVAS" || el.classList.contains("video-container");
    };
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0 || !hasPictureSelectionRef.current || !aroundPicture(e.target)) return;
      swallowClick = true;
      setSelectedImageOverlayId(null);
      setSelectedBlurOverlayId(null);
      setSelectedPipOverlayId(null);
    };
    const onClick = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, []);
  // A Stage scene is edited on its own - selecting one lets go of every other selection, and the
  // other way round.
  const selectScene = useCallback((id: string | null) => {
    setSelectedSceneId(id);
    if (id) {
      setSelectedOverlayId(null);
      setSelectedImageOverlayId(null);
      setSelectedBlurOverlayId(null);
      setSelectedPipOverlayId(null);
      setSelectedAdjustmentId(null);
    }
  }, []);
  useEffect(() => {
    if (selectedOverlayId || selectedImageOverlayId || selectedBlurOverlayId || selectedPipOverlayId || selectedAdjustmentId) setSelectedSceneId(null);
  }, [selectedOverlayId, selectedImageOverlayId, selectedBlurOverlayId, selectedPipOverlayId, selectedAdjustmentId]);
  // A scene deleted or undone away lets go of its selection.
  useEffect(() => {
    if (selectedSceneId && !editStore.scenes.some((s) => s.id === selectedSceneId)) setSelectedSceneId(null);
  }, [selectedSceneId, editStore.scenes]);
  // Any clip's preview source as the player loads it - the primary file's already-resolved URL,
  // an image's proxy, or another video's asset URL (TransitionPreviewLayer compares this against
  // what the player actually has loaded).
  const resolveTimelineClipUrl = useCallback(
    (sourcePath: string): Promise<string> => {
      const open = selectedFileRef.current;
      if (open && sourcePath === open.sourcePath) return Promise.resolve(open.path);
      return open && isImageClipPath(sourcePath) ? resolveImageClipProxyUrl(sourcePath, open.sourcePath) : resolvePreviewAssetUrl(sourcePath);
    },
    [resolveImageClipProxyUrl, resolvePreviewAssetUrl]
  );

  // What a video project plays as its primary file - a black canvas at the project's frame size
  // (see get_video_canvas_proxy) - since the project file itself is only a small JSON header.
  const resolveProjectCanvasUrl = useCallback(async (projectPath: string): Promise<string> => {
    const frame = await resolveTimelineFrame(projectPath);
    if (!frame) throw new Error("This video project couldn't be read");
    const canvasPath = await invoke<string>("get_video_canvas_proxy", { width: frame.width, height: frame.height });
    return resolvePreviewAssetUrl(canvasPath);
  }, [resolveTimelineFrame, resolvePreviewAssetUrl]);

  // Full-resolution display URL for an image file - the single-image viewer's resolver (also used
  // by the gallery's "Copy image" action, which should copy full quality, not a thumbnail). Same
  // as resolvePreviewAssetUrl above except HEIC/HEIF (WebView2 has no decoder for it at all) first
  // gets silently decoded to a cached PNG on the backend (get_heic_preview, content-addressed by
  // path+mtime - see conversion.rs) so it just displays with no "Convert" step and nothing added
  // to the library. get_heic_preview itself is nearly free on a cache hit (a single file-exists
  // check), so it's fine to call on every resolve rather than adding a second JS-side cache here.
  //
  // Deliberately NOT what the gallery grid (ImageFolderGallery.tsx) uses for its tiles - see
  // resolveImageThumbnailUrl below for why a full decode per grid tile turned out to be a real
  // problem, not just a slower one.
  const resolveImageDisplayUrl = useCallback(async (file: { name: string; path: string }): Promise<string> => {
    if (!["heic", "heif"].includes(getFileExtension(file.name))) return resolvePreviewAssetUrl(file.path);
    const previewPath = await invoke<string>("get_heic_preview", { inputPath: file.path });
    return resolvePreviewAssetUrl(previewPath);
  }, [resolvePreviewAssetUrl]);

  // Small (~480px) display URL for an image gallery grid tile - get_image_thumbnail generates and
  // caches a properly downscaled preview on the backend (HEIC/HEIF via the bundled
  // heif-thumbnailer, everything else via the `image` crate) instead of handing the tile a
  // full-resolution decode. The grid used to just call resolveImageDisplayUrl above for every
  // tile: fine for one image, but a folder of 100+ multi-megapixel photos meant the browser's
  // image cache couldn't hold every decoded bitmap at once, so scrolling away and back forced a
  // re-decode of whatever got evicted - visible as thumbnails "reloading" while scrolling, on top
  // of the initial load already being far slower than a grid of small tiles should be.
  const resolveImageThumbnailUrl = useCallback(async (file: { name: string; path: string }): Promise<string> => {
    const thumbPath = await invoke<string>("get_image_thumbnail", { inputPath: file.path });
    return resolvePreviewAssetUrl(thumbPath);
  }, [resolvePreviewAssetUrl]);

  // Poster-frame thumbnail for a video gallery grid tile (VideoFolderGallery.tsx) - the video
  // counterpart to resolveImageThumbnailUrl above, backed by get_video_thumbnail's own
  // content-addressed cache on the Rust side (a single ffmpeg frame extraction, ~1s into the
  // clip). Routed through the same shared thumbnailLimiter as every other gallery/sidebar
  // thumbnail request by the callers of this function, not here - this just resolves one URL.
  // A video project has no frames of its own, so its tile shows its first clip instead.
  const resolveVideoThumbnailUrl = useCallback(async (file: { name: string; path: string }, bypassCache = false): Promise<string> => {
    let videoPath = file.path;
    if (isVideoProjectPath(file.path)) {
      const json = await invoke<string | null>("load_video_edit_state", { videoPath: file.path });
      const firstClipPath: unknown = json ? JSON.parse(json)?.clips?.[0]?.sourcePath : undefined;
      if (typeof firstClipPath !== "string") throw new Error("Empty video project - nothing to thumbnail");
      if (isImageClipPath(firstClipPath)) return resolveImageThumbnailUrl({ name: firstClipPath, path: firstClipPath });
      videoPath = firstClipPath;
    }
    const thumbPath = await invoke<string>("get_video_thumbnail", { inputPath: videoPath });
    return resolvePreviewAssetUrl(thumbPath, bypassCache);
  }, [resolvePreviewAssetUrl, resolveImageThumbnailUrl]);

  // VideoPlayer.tsx's "set current frame as thumbnail" overwrites get_video_thumbnail's cached jpg
  // in place, at the SAME path it always had - so this listens for its completion and clears the
  // stale cached URL for that video, keyed by re-deriving the same thumbPath (a cache hit, and
  // thus effectively free) rather than trying to track path->thumbPath mappings separately.
  // VideoFolderGallery.tsx has its own listener alongside this one, to actually refresh whatever
  // it's already rendered - this one only clears Dashboard's own cache so that gallery's re-fetch
  // doesn't just receive the identical stale URL back.
  useEffect(() => {
    const unlistenPromise = listen<string>("video-thumbnail-updated", (event) => {
      invoke<string>("get_video_thumbnail", { inputPath: event.payload })
        .then((thumbPath) => previewAssetUrlCacheRef.current.delete(thumbPath))
        .catch((err) => console.error("Failed to invalidate thumbnail cache:", err));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // The video-tools timeline's own seek, extended to know *which file* it's seeking within -
  // once a clip can be dragged in from a different file than the one currently open, "seek to
  // this time" is ambiguous without also saying which file's timeline that time belongs to. Swaps
  // the player's actual source (via the imperative loadSource, not the `src` prop/selectedFile -
  // see VideoPlayerHandle's own comment for why) only when the target differs from what's already
  // loaded, so scrubbing within the same clip stays a plain, cheap seek.
  // `resume` (playback running from one clip into the next): keep playing even if the previous
  // clip ran to the very end of its file, which leaves the <video> paused in "ended".
  const handleSeekActiveFile = (sourcePath: string, time: number, resume = false) => {
    // Playback running on into the next clip: a warmed standby of it takes over on this very frame
    // (ClipHandoffLayer) while the player gets there, then the player lands where the standby is.
    const handoff = handoffRef.current;
    const bridged = !!handoff && resume && handoff.begin(sourcePath, time);
    if (!bridged && handoff?.isActive()) handoff.cancel();
    const target = () => (bridged && handoffRef.current?.isActive() ? handoffRef.current.targetTime() : time);
    pendingSeekTimeRef.current = time;
    // The playhead goes straight to the new spot. Until the player gets there it still reports the
    // clip it's leaving - for an image clip, a time at that clip's end, which the timeline read as
    // "already at the end of the next clip": the playhead leapt ahead, then fell back.
    setPlayerCurrentTime(time);
    if (previewSourcePathRef.current === sourcePath) {
      const player = videoPlayerRef.current;
      const state = player?.getPlaybackState();
      // Running straight on into a clip that starts where playback already is (a split) - no seek,
      // so no stutter.
      const continuous = resume && !!state && !state.paused && Math.abs(state.time - time) < 0.08;
      if (!continuous) player?.seek(target());
      if (resume) player?.play();
      return;
    }
    previewSourcePathRef.current = sourcePath;
    previewSwitchPendingRef.current = true;
    const settled = () => {
      if (previewSourcePathRef.current === sourcePath) previewSwitchPendingRef.current = false;
    };
    if (sourcePath === selectedFile?.sourcePath) {
      // Back to the primary file - its asset URL is already resolved (selectedFile.path).
      void (videoPlayerRef.current?.loadSource(selectedFile.path, target, selectedFile.sourcePath, resume || undefined) ?? Promise.resolve()).finally(settled);
      return;
    }
    resolveTimelineClipUrl(sourcePath)
      .then((url) => {
        // Dropped if the player has moved on while the URL resolved - opening a different file
        // resets previewSourcePathRef (effect above), and a late load here would otherwise swap
        // the newly opened video back out for this one.
        if (previewSourcePathRef.current !== sourcePath) return;
        return videoPlayerRef.current?.loadSource(url, target, isImageClipPath(sourcePath) ? undefined : sourcePath, resume || undefined);
      })
      .catch((error) => console.error("Failed to load preview source for", sourcePath, error))
      .finally(settled);
  };
  // Prepares every image clip's preview proxy ahead of the playhead, one at a time, so playback
  // crossing into an image doesn't stall on its first encode. Re-runs on every edit, but anything
  // already prepared is a cached promise - only newly added images do any work.
  useEffect(() => {
    const primaryPath = selectedFile?.sourcePath;
    if (!primaryPath || getFileCategory(selectedFile.name) !== "video") return;
    const imagePaths = Array.from(new Set(editStore.playbackClips.map((clip) => clip.sourcePath).filter(isImageClipPath)));
    let cancelled = false;
    (async () => {
      for (const imagePath of imagePaths) {
        if (cancelled) return;
        // eslint-disable-next-line no-await-in-loop
        await resolveImageClipProxyUrl(imagePath, primaryPath).catch((error) => console.error("Failed to prepare image clip preview", imagePath, error));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFile?.sourcePath, editStore.playbackClips, resolveImageClipProxyUrl]);
  // Audio playlist controls (repeat/shuffle/autoplay-next) — see navigateAudio/handleAudioEnded.
  const [audioRepeatMode, setAudioRepeatMode] = useState<"off" | "all" | "one">("off");
  const [audioShuffle, setAudioShuffle] = useState<boolean>(false);
  const [audioAutoplayNext, setAudioAutoplayNext] = useState<boolean>(true);
  // Video autoplay-next-file — mirrors audioAutoplayNext, but there's no video repeat/shuffle UI,
  // so it's just the one flag. Driven by VideoPlayer's own Autoplay button/settings row (it can't
  // hold this itself since it fully remounts on every file change via `key={selectedFile.path}`).
  const [videoAutoplayNext, setVideoAutoplayNext] = useState<boolean>(true);
  // Whether the system-wide annotation overlay is allowed to exist at all this session — see
  // handleSettingsSaved and the effect below that hides the overlay window when this turns off.
  // (Its shortcuts follow the same setting from the Rust side - services/shortcuts.rs.)
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

  // Playback positions used to live here as an audio-only ref; they're now in
  // utils/playbackResume.ts, which covers video too and survives an app restart. See
  // handleMediaTimeUpdate below for the write side and the `initialTime` prop for the read side.
  // Sourcepaths visited while shuffle is on, so "previous" can undo a shuffled "next" instead of
  // computing a sequential-order previous that wouldn't match what was actually just played.
  const shuffleHistoryRef = useRef<string[]>([]);
  // Lets stable (useCallback, empty-deps) callbacks passed down to VideoPlayer read whichever
  // file is *currently* selected without needing to be recreated every time it changes.
  const selectedFileRef = useRef(selectedFile);
  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  // Native window title shows what's open - "lecture.mp4 - Briefcast", the usual Windows order -
  // and goes back to plain "Briefcast" when nothing is.
  useEffect(() => {
    const title = selectedFile ? `${selectedFile.name} - Briefcast` : "Briefcast";
    getCurrentWebviewWindow()
      .setTitle(title)
      .catch((err) => console.error("Failed to set window title:", err));
  }, [selectedFile?.name]);


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
      setIsPaused(false);
      setPauseStartedAt(null);
      setPausedAccumulatedMs(0);
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
      const overlayWindow = await WebviewWindow.getByLabel('recording-overlay');
      if (overlayWindow) {
        await overlayWindow.hide();
      }
      setCanSwitchView(false);
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

  // Mirrors the recording-overlay window's own pause/resume buttons back into this window's state
  // - same "whichever window acted, sync the other one" idea as the recording-stopped listener
  // above, just for pause instead of stop.
  useEffect(() => {
    const unlistenPromise = listen<{ isPaused: boolean; pauseStartedAt: number | null; pausedAccumulatedMs: number }>(
      'recording-pause-changed',
      (event) => {
        setIsPaused(event.payload.isPaused);
        setPauseStartedAt(event.payload.pauseStartedAt);
        setPausedAccumulatedMs(event.payload.pausedAccumulatedMs);
        setMessage(event.payload.isPaused ? "Recording paused" : "Recording resumed");
      }
    );
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

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

  // The "Play" button in the same recording-completed popup. That window has no player of its
  // own, so it hands the path over here and closes itself - the same arrangement
  // 'open-conversion-dialog' above uses.
  //
  // setFocus matters: this window is behind the popup, so without it the file would load out of
  // sight and clicking Play would look like it did nothing.
  useEffect(() => {
    const setupListener = async () => {
      return await listen<string>('open-recording-playback', async (event) => {
        const path = event.payload;
        const name = path.split(/[\\/]/).pop() || path;
        try {
          await getCurrentWebviewWindow().setFocus();
        } catch {
          /* focus is a nicety - never let it stop the file from loading */
        }
        await loadFileForPlayback(path, name);
      });
    };

    let unlistenFn: (() => void) | undefined;
    setupListener().then((fn) => {
      unlistenFn = fn;
    });

    return () => {
      if (unlistenFn) unlistenFn();
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

  // A window captured on its own needs nothing done to it - it's recorded wherever it is, so
  // focus stays where the user has it. Only when a window is recorded as the screen area it covers
  // is it raised first (best effort: Windows' SetForegroundWindow restriction - see
  // openScreenshotOverlay below - can no-op, and the user can bring it forward themselves).
  const windowHwnd = (formData: any): number | null => {
    const raw = typeof formData.screen_size === 'string' && formData.screen_size.startsWith('window:')
      ? Number(formData.screen_size.slice('window:'.length))
      : NaN;
    return Number.isFinite(raw) && raw !== 0 ? raw : null;
  };
  const activateTargetWindowIfNeeded = async (formData: any): Promise<void> => {
    const hwnd = windowHwnd(formData);
    if (hwnd === null || captureCapsRef.current.window_isolated) return;
    await invoke('activate_and_open_window', { title: formData.window_title ?? '', hwnd });
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
    // A window captured on its own is taken straight away, wherever it is - Briefcast's own
    // window included. The short wait lets the options dialog that was just closed leave the
    // screen first, so a screenshot of Briefcast shows Briefcast, not the dialog.
    const isolatedWindow = windowHwnd(formData) !== null && captureCapsRef.current.window_isolated;
    if (formData.screen_size !== 'fullscreen' && !isolatedWindow) {
      await openScreenshotOverlay(formData);
      return;
    }
    if (isolatedWindow) await new Promise(resolve => setTimeout(resolve, 250));
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
      const overlayWindow = await WebviewWindow.getByLabel('screenshot-overlay');
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
    // Record pressed again (button or hotkey) while the countdown is still running: that's a
    // change of mind - cancel it rather than queue a second start.
    if (isCountdownRunning()) {
      cancelCountdown();
      return;
    }
    // Read at the moment of recording rather than threaded through every caller - the panel and
    // the record hotkey both land here.
    const recordingPrefs = loadSettings();
    formData = {
      ...formData,
      enhance_audio: recordingPrefs.autoEnhanceAudio,
      overlay_border: recordingPrefs.cameraBorder,
      overlay_border_color: recordingPrefs.cameraBorderColor,
      capture_cursor: recordingPrefs.captureCursor,
      window_title_bar: recordingPrefs.windowTitleBar,
      // The pointer and shortcuts for the editor's Screen Style (services/input_tracker.rs).
      track_pointer: recordingPrefs.editablePointer,
      track_keys: recordingPrefs.recordShortcuts,
      mute_notifications: recordingPrefs.muteNotificationsWhileRecording,
      // Live background behind the person in a bubble recorded into the screen (camera_effects.rs) -
      // a separately recorded webcam gets it in the editor instead, at full quality.
      camera_effect: formData.record_type === "sva" && !formData.separate_webcam_capture ? cameraEffectSpec(recordingPrefs.cameraBackground) : null,
    };
    if (formData.record_type === "c") {
      await handleTakeScreenshot(formData);
      return;
    }
    // The live display holds its cameras open, and a Windows camera serves one app at a time -
    // ffmpeg couldn't open one that's on the display. Say so now rather than fail mid-start.
    const presentation = getPresentationState();
    if (presentation.active && ['sva', 'va', 'v'].includes(formData.record_type)) {
      const onDisplay = visibleCameras(presentation);
      // The phone is shared, not opened - recording it while it's on the display is fine.
      const clash = (formData.video_devices ?? []).filter((d: string) => d !== PHONE_CAMERA_DEVICE && onDisplay.includes(d));
      if (clash.length > 0) {
        setError(
          `${clash.join(', ')} ${clash.length === 1 ? 'is' : 'are'} on the live display. Take ${clash.length === 1 ? 'it' : 'them'} off the display (or stop it) to record ${clash.length === 1 ? 'that camera' : 'those cameras'}.`
        );
        return;
      }
    }
    // Optional "3, 2, 1" (Settings > Recording) - after the checks above, so a start that's going to
    // be refused anyway doesn't make the user wait through a countdown first.
    if (recordingPrefs.recordingCountdownEnabled) {
      const go = await runRecordingCountdown(recordingPrefs.recordingCountdownSeconds);
      if (!go) return;
    }
    try {
        await activateTargetWindowIfNeeded(formData);

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

        // Timestamped before start_recording so the offset handed to the backend covers the
        // whole gap - spawning ffmpeg plus its own half-second early-exit check - rather than
        // only the part after it returns. save_phone_camera_capture pads the camera file by this
        // much so both files share a t=0.
        const recordingLaunchedAt = Date.now();
        const response = await invoke<string>("start_recording", { formData });
        const startTime = Date.now();
        trackEvent("recording_started", {
          recordType: String(formData.record_type),
          format: String(formData.file_ext ?? ""),
          phoneCamera: !!formData.video_devices?.includes(PHONE_CAMERA_DEVICE),
        });

        // The phone records in this WebView, not in ffmpeg: its frames arrive over WebRTC and
        // never reach the backend as a capture device (start_recording strips the sentinel out of
        // video_devices for exactly that reason). The result lands as the same `<stem>_webcam.mp4`
        // sidecar a real separately-captured webcam produces, so the editor needs no new path.
        if (formData.video_devices?.includes(PHONE_CAMERA_DEVICE)) {
          phoneCaptureRef.current = startPhoneCapture(recordingLaunchedAt, (msg) => setError(msg));
          if (!phoneCaptureRef.current) {
            setError(
              "The screen recording started, but the phone camera wasn't connected so it isn't being recorded."
            );
          }
        }
        setIsRecording(true);
        setRecordingStartTime(startTime);
        setIsPaused(false);
        setPauseStartedAt(null);
        setPausedAccumulatedMs(0);
        setError("");

        // Create the overlay window, but don't show it - it stays hidden until the user
        // asks for it via the toggle shortcut below, rather than popping up unasked-for
        // every time a recording starts.
        let overlayWindow = await WebviewWindow.getByLabel('recording-overlay');

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
        // canSwitchView: the toggle needs a second (camera) file to cut to. Two things produce
        // one: separate_webcam_capture, and the phone camera - which always records to that same
        // `<stem>_webcam.mp4` sidecar (save_phone_camera_capture, recording.rs) even though
        // start_recording deliberately clears separate_webcam_capture for it, since the phone
        // owns that slot. So the phone gets live view-switching on exactly the same terms.
        // (camera) file the live Screen/Camera toggle needs something to switch to - see
        // RECORDING_UPGRADE_NOTES.md's view-switching feature design.
        overlayWindow.emit('recording-state-update', {
          isRecording: true,
          recordType: formData.record_type,
          startTime,
          isPaused: false,
          pauseStartedAt: null,
          pausedAccumulatedMs: 0,
          canSwitchView:
            formData.record_type === 'sva' &&
            (Boolean(formData.separate_webcam_capture) ||
              Boolean(formData.video_devices?.includes(PHONE_CAMERA_DEVICE))),
        });


        const switchable =
          formData.record_type === 'sva' &&
          (Boolean(formData.separate_webcam_capture) || Boolean(formData.video_devices?.includes(PHONE_CAMERA_DEVICE)));
        setCanSwitchView(switchable);
        setViewMode('screen');
        viewSwitchRef.current.canSwitchView = switchable;
        viewSwitchRef.current.viewMode = 'screen';

        // Opt-in (Settings > Recording) - see AppSettings.notifyOnRecordingStart.
        if (loadSettings().notifyOnRecordingStart) {
          setMessage(
            switchable
              ? `${response} (Alt+Shift+V switches between screen and camera, Ctrl+Shift+H shows the recording overlay)`
              : `${response} (Ctrl+Shift+H to show/hide the recording overlay)`
          );
        }

    } catch (error) {
        console.error("Error starting recording:", error);
        setError(`Failed to start recording: ${error}`);
    }
  };

  
  // The latest recording timing and view state, for switchView - which the global hotkey calls
  // through switchViewRef, registered once per recording, so it must never read a stale render.
  const viewSwitchRef = useRef({
    startTime: null as number | null,
    isPaused: false,
    pauseStartedAt: null as number | null,
    pausedAccumulatedMs: 0,
    viewMode: 'screen' as 'screen' | 'camera',
    canSwitchView: false,
  });
  useEffect(() => {
    viewSwitchRef.current = {
      startTime: recordingStartTime,
      isPaused,
      pauseStartedAt,
      pausedAccumulatedMs,
      viewMode,
      canSwitchView,
    };
  });

  // Cuts the main view between screen and camera: logs the cut at the recording's elapsed time
  // (same pause-aware formula as every timer) - assembly re-bases these onto the final file, and
  // the editor/export cut to match - then tells every window, so the overlay's and the recording
  // bar's buttons all show the live view.
  const switchView = async (requested: 'screen' | 'camera' | 'toggle') => {
    const st = viewSwitchRef.current;
    if (!st.canSwitchView || !st.startTime) return;
    const mode = requested === 'toggle' ? (st.viewMode === 'screen' ? 'camera' : 'screen') : requested;
    if (mode === st.viewMode) return;
    st.viewMode = mode;
    setViewMode(mode);
    const now = st.isPaused && st.pauseStartedAt ? st.pauseStartedAt : Date.now();
    const elapsedSecs = Math.max(0, (now - st.startTime - st.pausedAccumulatedMs) / 1000);
    try {
      await invoke('record_view_switch', { elapsedSecs, mode });
    } catch (error) {
      console.error('Error recording view switch:', error);
    }
    void emit('view-mode-changed', { mode });
  };
  const switchViewRef = useRef(switchView);
  switchViewRef.current = switchView;

  // The overlay window asks rather than acting itself, so there's one place a cut is logged.
  useEffect(() => {
    const unlisten = listen<{ mode: 'screen' | 'camera' }>('view-switch-requested', (event) => {
      void switchViewRef.current(event.payload.mode);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  let handleStopRecording = async () => {
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    try {
      await stopRecordingOnce();
    } finally {
      isStoppingRef.current = false;
    }
  };

  const stopRecordingOnce = async () => {
    setError("");

    // Flushed and written BEFORE stop_recording, so the finished camera file is already on disk
    // next to the screen recording by the time the completion UI points the user at it.
    if (phoneCaptureRef.current) {
      const capture = phoneCaptureRef.current;
      phoneCaptureRef.current = null;
      try {
        await capture.stop();
      } catch (e) {
        console.error("Error saving phone camera recording:", e);
      }
    }

    // Everything the user sees changes NOW, not when stop_recording returns: capture ends within a
    // moment, but cleaning the audio and assembling the file can take minutes for a long
    // recording, and a Stop that leaves the timer running that long reads as ignored (it got
    // pressed again, on the overlay, which then failed with "No recording in progress"). The
    // backend shows the completion window in a "finishing" state meanwhile.
    // Wall-clock span (includes any paused time) - the overlay's own stop path reports the exact
    // pause-aware duration instead.
    const durationSeconds = recordingStartTime ? Math.round((Date.now() - recordingStartTime) / 1000) : 0;
    setIsRecording(false);
    setRecordingStartTime(null);
    setIsPaused(false);
    setPauseStartedAt(null);
    setPausedAccumulatedMs(0);
    setCanSwitchView(false);
    const audio = new Audio("/sounds/option-3.mp3");
    audio.play().catch(err => console.error("Error playing audio:", err));

    // Hide the overlay window and drop the toggle shortcut now that there's nothing to show
    const overlayWindow = await WebviewWindow.getByLabel('recording-overlay');
    if (overlayWindow) {
      await overlayWindow.hide();
    }

    try {
      // The finished path is shown by the completion window, so no toast repeats it here.
      await invoke<string>("stop_recording");
      trackEvent("recording_finished", { durationSeconds, stoppedFrom: "main" });
    } catch (error) {
      // A second Stop (from the overlay, a shortcut) while the first is still finishing - the
      // recording is already being saved, so there is nothing to report.
      if (!String(error).includes("No recording in progress")) {
        console.error("Error stopping recording:", error);
        setError(`Failed to stop recording: ${error}`);
      }
    }

    if (isMonitoring) {
      try {
        await invoke("stop_monitoring_windows");
        setIsMonitoring(false);
        console.log("Monitoring stopped");
      } catch (error) {
        console.error("Error stopping monitoring:", error);
      }
    }
  };

  // Pauses the in-progress recording - suspends ffmpeg (and, on Windows, the WASAPI loopback
  // capture if system audio is on) at the backend level, and freezes this window's own elapsed
  // timer at the moment of pause by recording when it happened rather than resetting it.
  const handlePauseRecording = async () => {
    try {
      await invoke("pause_recording");
      const now = Date.now();
      setIsPaused(true);
      setPauseStartedAt(now);
      setMessage("Recording paused");

      const overlayWindow = await WebviewWindow.getByLabel('recording-overlay');
      overlayWindow?.emit('recording-state-update', {
        isRecording: true,
        recordType,
        startTime: recordingStartTime,
        isPaused: true,
        pauseStartedAt: now,
        pausedAccumulatedMs,
        canSwitchView:
          recordType === 'sva' && (separateWebcamCapture || videoDevices.includes(PHONE_CAMERA_DEVICE)),
      });
    } catch (error) {
      console.error("Error pausing recording:", error);
      setError(`Failed to pause recording: ${error}`);
    }
  };

  const handleResumeRecording = async () => {
    try {
      await invoke("resume_recording");
      // Folds the just-finished pause into the running total before clearing pauseStartedAt -
      // this is the one moment pausedAccumulatedMs actually changes (see its own doc comment).
      const addedMs = pauseStartedAt ? Date.now() - pauseStartedAt : 0;
      const newAccumulatedMs = pausedAccumulatedMs + addedMs;
      setIsPaused(false);
      setPauseStartedAt(null);
      setPausedAccumulatedMs(newAccumulatedMs);
      setMessage("Recording resumed");

      const overlayWindow = await WebviewWindow.getByLabel('recording-overlay');
      overlayWindow?.emit('recording-state-update', {
        isRecording: true,
        recordType,
        startTime: recordingStartTime,
        isPaused: false,
        pauseStartedAt: null,
        pausedAccumulatedMs: newAccumulatedMs,
        canSwitchView:
          recordType === 'sva' && (separateWebcamCapture || videoDevices.includes(PHONE_CAMERA_DEVICE)),
      });
    } catch (error) {
      console.error("Error resuming recording:", error);
      setError(`Failed to resume recording: ${error}`);
    }
  };

  // One library scan at a time: a burst of refresh events (a batch copy, a recording finishing)
  // runs at most one more scan after the current one, instead of stacking them up.
  const fileScanRef = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });
  const handleDirectoryFiles = async () => {
    if (fileScanRef.current.running) {
      fileScanRef.current.again = true;
      return;
    }
    fileScanRef.current.running = true;
    try {
      do {
        fileScanRef.current.again = false;
        await scanDirectoryFiles();
      } while (fileScanRef.current.again);
    } finally {
      fileScanRef.current.running = false;
    }
  };

  const scanDirectoryFiles = async () => {
    try {
      const data = await invoke<FileMap>("list_briefcast_files");
      setFiles(data); 
    } catch (error) {
      console.error("Error getting files:", error);
      setError(`Failed to load files: ${error}`);
    } finally {
      setIsLoadingFiles(false);
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

	// A recording can outlive this page: services/webview_recovery.rs reloads it if its renderer
	// crashes. Picking the running recording back up keeps the Stop button (and timer) working -
	// otherwise the page would offer Record, which the backend refuses while one is in progress.
	useEffect(() => {
		invoke<RecordingStatus>("get_recording_status")
			.then(({ recording, clock }) => {
				if (!recording || !clock) return;
				setIsRecording(true);
				setRecordingStartTime(clock.startedAt);
				setIsPaused(clock.pauseStartedAt !== null);
				setPauseStartedAt(clock.pauseStartedAt);
				setPausedAccumulatedMs(clock.pausedAccumulatedMs);
			})
			.catch((error) => console.error("Error checking for a recording in progress:", error));
	}, []);

	// Quitting Briefcast (main.rs) would end a recording in progress abruptly - its parts never
	// assembled into a file. So while recording, quitting asks first, and "Stop and quit" saves the
	// recording properly before letting the quit through. (Hiding to the tray never gets here, and a
	// release to the tray lets the recording carry on - Rust runs it without this page.)
	useEffect(() => {
		if (!isRecording) return;
		return addCloseGuard(async (reason) => {
			if (reason === "release") return true;
			const stopAndQuit = await ask("A recording is in progress. Stop and save it, then quit Briefcast?", {
				title: "Recording in progress",
				kind: "warning",
				okLabel: "Stop and quit",
				cancelLabel: "Keep recording",
			});
			if (!stopAndQuit) return false;
			try {
				await invoke("stop_recording");
			} catch (error) {
				console.error("Error stopping recording before quitting:", error);
			}
			return true;
		});
	}, [isRecording]);

	// macOS and Linux use the system ffmpeg, which can be too old or built without the encoders
	// recordings need (services/ffmpeg_check.rs). Say what to do - and check again each time this
	// window comes back after a failed check, which is when someone has just installed a newer one in
	// a terminal, so there is no button to find.
	useEffect(() => {
		let disposed = false;
		let shown: string | null = null;
		const check = async (recheck: boolean) => {
			const status = await invoke<{ ok: boolean; version: string | null; problems: string[]; fix: string | null }>("ffmpeg_status", { recheck }).catch(() => null);
			if (disposed || !status) return;
			if (!status.ok) {
				shown = [...status.problems, status.fix].filter(Boolean).join(" ");
				setError(shown);
			} else if (shown) {
				// Fixed while Briefcast was open: take back only our own message.
				const ours = shown;
				shown = null;
				setError((current) => (current === ours ? "" : current));
				setMessage(`ffmpeg ${status.version ?? ""} found - recording and export are ready.`);
			}
		};
		void check(false);
		const unlisten = appWindow.onFocusChanged(({ payload: focused }) => {
			if (focused && shown) void check(true);
		});
		return () => {
			disposed = true;
			void unlisten.then((fn) => fn());
		};
	}, []);

	// Closing to the tray only hides the window - the page keeps running - so a video playing in it
	// carried on, heard but not seen. Whatever plays stops as the window goes, as it would if the window
	// really closed; it stays paused when Briefcast is opened again. The player is paused through its
	// own controls so the editor's other layers stop with it. Live camera previews are left alone:
	// they're streams rather than playback, and a paused one would come back frozen.
	useEffect(() => {
		const stopPlayback = () => {
			if (videoPlayerRef.current?.getPlaybackState()?.paused === false) videoPlayerRef.current.togglePlay();
			// The timeline, the mixer's audition and the panels' previews.
			stopAllPlayback();
			document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((el) => {
				if (!el.paused && !el.srcObject) el.pause();
			});
		};
		window.addEventListener(HIDDEN_TO_TRAY_EVENT, stopPlayback);
		return () => window.removeEventListener(HIDDEN_TO_TRAY_EVENT, stopPlayback);
	}, []);

	// One update check per launch, delayed so it never competes with startup work (device probes,
	// file list, thumbnails). Shown as a dismissible card - see UpdateBanner.
	const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);
	useEffect(() => {
		const timer = setTimeout(() => {
			void checkForUpdate().then((update) => {
				if (update) setPendingUpdate(update);
			});
		}, 15_000);
		return () => clearTimeout(timer);
	}, []);

	const loadTrash = async () => {
		setIsLoadingTrash(true);
		try {
			const items = await invoke<TrashEntry[]>("list_trash");
			setTrashItems(items);
		} catch (error) {
			console.error("Error loading trash:", error);
			setError(`Failed to load trash: ${error}`);
		} finally {
			setIsLoadingTrash(false);
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

	// Opening a document, whiteboard or mind map counts as "recent" for the home screen even if
	// nothing in it changes.
	const openedDocId = docsScreen?.mode === "editor" ? docsScreen.docId : null;
	const openedWhiteboardId = whiteboardScreen?.mode === "editor" ? whiteboardScreen.whiteboardId : null;
	const openedMindmapId = mindmapScreen?.mode === "editor" ? mindmapScreen.mindmapId : null;
	useEffect(() => {
		if (openedDocId) setOpenedAt(recordItemOpened(homeItemKey("doc", openedDocId)));
	}, [openedDocId]);
	useEffect(() => {
		if (openedWhiteboardId) setOpenedAt(recordItemOpened(homeItemKey("whiteboard", openedWhiteboardId)));
	}, [openedWhiteboardId]);
	useEffect(() => {
		if (openedMindmapId) setOpenedAt(recordItemOpened(homeItemKey("mindmap", openedMindmapId)));
	}, [openedMindmapId]);

	// The home screen is whatever shows when no tool and no file is open. Its library list is
	// refreshed every time it comes back into view, so a document just written or a whiteboard just
	// drawn is there straight away.
	const onHomeScreen = videoEditorScreen?.mode !== "home" && !mindmapScreen && !whiteboardScreen && !boardScreen && !docsScreen && !selectedFile;
	useEffect(() => {
		if (!onHomeScreen) return;
		let live = true;
		void refreshDocsIndex();
		setOpenedAt(getOpenedAt());
		invoke<WhiteboardSummary[]>("list_whiteboards")
			.then((list) => live && setWhiteboardIndex(list))
			.catch((error) => console.error("Failed to load whiteboards for the home screen:", error));
		invoke<MindmapSummary[]>("list_mindmaps")
			.then((list) => live && setMindmapIndex(list))
			.catch((error) => console.error("Failed to load mind maps for the home screen:", error));
		return () => {
			live = false;
		};
	}, [onHomeScreen, refreshDocsIndex]);

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

	const handleDeleteFile = async (file: { name: string; path: string }) => {
		try {
			await invoke("move_to_trash", { path: file.path });
			if (selectedFile?.sourcePath === file.path) setSelectedFile(null);
			setOpenMenu(null);
			const { pinned, recent } = forgetFile(file.path);
			setPinnedPaths(pinned);
			setRecentPaths(recent);
			forgetPlaybackState(file.path);
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

	// `force` (double-click on Home): also leave a folder gallery and drop the "back to…" point, so
	// it always lands on the main home screen whatever was on top.
	const handleGoHome = (force?: boolean) => { if (force === true) { setSelectedFolder(null); setReturnPoint(null); } setSelectedFile(null); setBoardScreen(null); setDocsScreen(null); setWhiteboardScreen(null); setMindmapScreen(null); setVideoEditorScreen(null); };
	const handleOpenBoard = () => { setSelectedFile(null); setBoardScreen({ mode: "home" }); setDocsScreen(null); setWhiteboardScreen(null); setMindmapScreen(null); setVideoEditorScreen(null); };
	const handleOpenDocs = () => { setSelectedFile(null); setBoardScreen(null); setDocsScreen({ mode: "home" }); setWhiteboardScreen(null); setMindmapScreen(null); setVideoEditorScreen(null); };
	const handleOpenWhiteboard = () => { setSelectedFile(null); setBoardScreen(null); setDocsScreen(null); setWhiteboardScreen({ mode: "home" }); setMindmapScreen(null); setVideoEditorScreen(null); };
	const handleOpenMindmap = () => { setSelectedFile(null); setBoardScreen(null); setDocsScreen(null); setWhiteboardScreen(null); setMindmapScreen({ mode: "home" }); setVideoEditorScreen(null); };
	const handleOpenVideoEditor = () => { setSelectedFile(null); setBoardScreen(null); setDocsScreen(null); setWhiteboardScreen(null); setMindmapScreen(null); setVideoEditorScreen({ mode: "home" }); };
	// Opening a video from the Video Editor's landing screen: exactly the same load the sidebar
	// does, then two extra beats - stay in the editor (so the tool icon stays lit and "Back to
	// video editor" is offered), and open the tools panel straight away, since arriving via the
	// Video Editor already said "I'm here to edit" and shouldn't need the separate
	// "show tools for this file" click. Ordered after the await because loadFileForPlayback
	// resolves videoEditorScreen itself (see its own handling below).
	// `intent`: opened from one of the home's starters - the editor sets itself up for it once
	// the video has loaded (editorIntent.ts).
	const handleOpenVideoInEditor = async (file: { path: string; name: string }, intent?: EditorIntent): Promise<void> => {
		setEditorIntent(file.path, intent);
		await loadFileForPlayback(file.path, file.name);
		setVideoEditorScreen({ mode: "editing" });
		setDockerMode("file-tools");
	};
	// The Video Editor's "Open video from anywhere" - same OS picker as the docker's own
	// open-from-anywhere button, but filtered to video only, since anything else can't be edited
	// by the tool the user is standing in.
	const handleOpenExternalVideoForEditing = async (intent?: EditorIntent): Promise<void> => {
		try {
			const selected = await openFileDialog({
				multiple: false,
				filters: [{ name: "Video", extensions: FILE_CATEGORY_EXTENSIONS.video }],
			});
			if (!selected || Array.isArray(selected)) return; // cancelled

			const name = selected.split(/[\\/]/).pop() ?? selected;
			if (getFileCategory(name) !== "video") {
				await showMessageDialog(`"${name}" isn't a video file the editor can open.`, {
					title: 'Unsupported file',
					kind: 'warning',
				});
				return;
			}

			await handleOpenVideoInEditor({ path: selected, name }, intent);
		} catch (error) {
			console.error('Error opening video for editing:', error);
			setError(`Failed to open video: ${error}`);
		}
	};
	const handleOpenSettings = () => setShowSettings(true);
	const handleCloseSettings = () => setShowSettings(false);
	// Settings apply immediately to the current session too, not just future ones — otherwise
	// saving a new default file extension/type wouldn't visibly do anything until next launch.
	const handleSettingsSaved = (settings: ReturnType<typeof loadSettings>) => {
		setFileExt(settings.defaultFileExt);
		setRecordType(settings.defaultRecordType);
		setAnnotationEnabled(settings.enableAnnotationTool);
		setHomeBackgroundStyle(settings.homeBackgroundStyle);
		setShowRecordingDocker(settings.showRecordingDocker);
		setShowRecordingPanelButtons(settings.showRecordingPanelButtons);
		setShowDockerStatusBar(settings.showDockerStatusBar);
		setIncludeSystemAudio(settings.defaultIncludeSystemAudio);
		setResolutionWidth(settings.defaultResolutionWidth);
		setFramerate(settings.defaultFramerate);
		if (settings.defaultAudioDevice) setAudioDevice(settings.defaultAudioDevice);
		if (settings.defaultVideoDevices.length > 0) setVideoDevices(settings.defaultVideoDevices);
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
	// The overlay stays hidden except for this deliberately brief, user-initiated window: a
	// click-through style that silently fails to apply is nearly harmless on a window that's about
	// to be hidden anyway, but catastrophic on one left permanently visible in the background (an
	// invisible, always-on-top, all-monitors window eating every click on the desktop).
	// show()/setIgnoreCursorEvents are also always sequenced show-before-ignore when turning draw
	// mode on, since setting that style before a window has ever been shown is what didn't reliably
	// stick on Windows.
	//
	// The window itself is pre-declared in tauri.conf.json (like the snip overlay) and placed from
	// here, over the union of every monitor, each time it's shown - so a monitor plugged in or
	// rearranged since last time is covered too. Building and placing it from a Rust command instead
	// deadlocked the whole app on a 4K/250% display (what kept this feature switched off).
	const toggleAnnotationDrawMode = useCallback(async (forceOff = false) => {
		const overlay = await WebviewWindow.getByLabel('annotation-overlay');
		if (!overlay) return;
		const next = forceOff ? false : !annotationDrawModeRef.current;
		annotationDrawModeRef.current = next;

		if (annotationHideTimeoutRef.current !== null) {
			window.clearTimeout(annotationHideTimeoutRef.current);
			annotationHideTimeoutRef.current = null;
		}

		try {
			if (next) {
				const monitors = await availableMonitors();
				if (monitors.length > 0) {
					const left = Math.min(...monitors.map((m) => m.position.x));
					const top = Math.min(...monitors.map((m) => m.position.y));
					const right = Math.max(...monitors.map((m) => m.position.x + m.size.width));
					const bottom = Math.max(...monitors.map((m) => m.position.y + m.size.height));
					await overlay.setPosition(new PhysicalPosition(left, top));
					await overlay.setSize(new PhysicalSize(right - left, bottom - top));
				}
				await overlay.show();
				await overlay.setIgnoreCursorEvents(false);
				// Focused so Esc reaches the overlay's own keydown listener; hiding it hands focus
				// back to whatever was underneath (the slides, the browser...).
				await overlay.setFocus();
				await overlay.emit('annotation-mode-changed', { active: true });
			} else {
				await overlay.emit('annotation-mode-changed', { active: false });
				await overlay.setIgnoreCursorEvents(true);
				// Not hidden immediately - a still-fading stroke should keep fading, not vanish the
				// instant draw mode turns off. annotationFadeGraceMs covers the overlay's own fade
				// (utils/annotationStyles.ts) with margin. Click-through
				// is already applied above, so even if this timer never fires (e.g. the app closes
				// first), the overlay can't block input in the meantime.
				annotationHideTimeoutRef.current = window.setTimeout(() => {
					annotationHideTimeoutRef.current = null;
					if (!annotationDrawModeRef.current) void overlay.hide();
				}, annotationFadeGraceMs());
			}
		} catch (err) {
			console.error('Failed to toggle annotation draw mode:', err);
		}
	}, []);

	// Turning the annotation tool off ends draw mode and hides its overlay. Its shortcuts are
	// registered and dropped by Rust from the same setting (services/shortcuts.rs), and the
	// dispatcher below ignores a press while the tool is off.
	useEffect(() => {
		if (annotationEnabled) return;
		void (async () => {
			if (annotationDrawModeRef.current) {
				await toggleAnnotationDrawMode(true);
			}
			const overlay = await WebviewWindow.getByLabel('annotation-overlay');
			if (overlay) await overlay.hide();
		})();
	}, [annotationEnabled, toggleAnnotationDrawMode]);

	// Privacy blur strength and auto-blur rules (services/screen_blur.rs). Re-sent when recording
	// starts/stops (the WhatsApp rule defaults to "while recording") and whenever Settings closes -
	// saved or cancelled, which also undoes the strength slider's unsaved live preview.
	useEffect(() => {
		if (showSettings) return;
		const st = loadSettings();
		const active = (mode: 'off' | 'recording' | 'always') => mode === 'always' || (mode === 'recording' && isRecording);
		invoke('screen_blur_configure', {
			config: {
				strength: st.annotationBlurStrength,
				autoWhatsapp: active(st.annotationAutoBlurWhatsApp),
				whatsappParts: st.annotationBlurWhatsAppParts,
				autoText: active(st.annotationAutoBlurText),
				textRules: {
					...st.annotationBlurTextRules,
					keywords: st.annotationBlurKeywords.split(',').map((k) => k.trim()).filter(Boolean),
				},
			},
		}).catch((err) => console.error('Screen blur config:', err));
	}, [isRecording, showSettings]);

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

	// Flips the panel-buttons visibility and persists it directly - bypassing the Settings modal's
	// "must click Save" flow is the whole point here, so the next time Settings is opened it should
	// still show the state this shortcut/checkbox last left it in, not silently revert on save.
	const toggleRecordingPanelButtons = useCallback(() => {
		setShowRecordingPanelButtons((prev) => {
			const next = !prev;
			saveSettings({ ...loadSettings(), showRecordingPanelButtons: next });
			return next;
		});
	}, []);

	// handleStartRecording/handleStopRecording (and the bottom bar's name/format below) are
	// recreated or reassigned on every render, so a stable (empty-deps) hotkey callback can't
	// reference them directly without capturing a stale first-render snapshot forever - this ref
	// is refreshed after every render instead (same pattern as selectedFileRef above) so the
	// hotkey handler, registered once, always acts on the latest values.
	const recordingHotkeyRef = useRef({
		isRecording, startRecording: handleStartRecording, stopRecording: handleStopRecording,
		fileName, fileExt,
	});
	useEffect(() => {
		recordingHotkeyRef.current = {
			isRecording, startRecording: handleStartRecording, stopRecording: handleStopRecording,
			fileName, fileExt,
		};
	});

	// recordTypeOverride: the tray's "Start recording" submenu picks the setup and starts in one go.
	const handleRecordingToggleHotkey = useCallback((recordTypeOverride?: string) => {
		const s = recordingHotkeyRef.current;
		if (s.isRecording) {
			void s.stopRecording();
			return;
		}
		if (recordTypeOverride) setRecordType(recordTypeOverride);
		void (async () => {
			try {
				// Built in Rust from the settings file (services/recording_setup.rs) - the same request
				// a start with no window gets, so the two can't drift. It records the whole screen,
				// skipping EnhancedScreenOptions' target picker (see the note on the record shortcut).
				const request = await invoke<Record<string, unknown>>("get_current_setup_request", {
					recordTypeOverride: recordTypeOverride ?? null,
				});
				// The name and format in the bottom bar belong to this take only and are never saved,
				// so with a window open they win - as they always have.
				const fileExt = s.fileExt?.toLowerCase();
				void s.startRecording({
					...request,
					file_name: s.fileName || request.file_name,
					...(fileExt && formatSuitsRecordType(fileExt, String(request.record_type)) ? { file_ext: fileExt } : {}),
				});
			} catch (err) {
				console.error("Couldn't build the recording request:", err);
				setError(`Failed to start recording: ${err}`);
			}
		})();
	}, []);

	// Every system-wide shortcut lands here as an action (registered by Rust - see
	// services/globalShortcuts.ts). One subscription for the window's life; the handlers are read
	// through a ref so a press always acts on the latest render's state. Presentation cuts are
	// handled by services/presentation.ts, which subscribes on its own.
	const shortcutHandlersRef = useRef<Partial<Record<ShortcutAction, () => void>>>({});
	shortcutHandlersRef.current = {
		'record-toggle': () => handleRecordingToggleHotkey(),
		'panel-buttons-toggle': toggleRecordingPanelButtons,
		'snip': () => {
			startSnip().catch((err) => setError(`Couldn't start a screenshot: ${err}`));
		},
		'annotation-toggle': () => {
			if (annotationEnabled) void toggleAnnotationDrawMode();
		},
		'blur-window': () => {
			if (annotationEnabled) invoke('screen_blur_toggle_window').catch((err) => console.error('Blur window:', err));
		},
		'overlay-toggle': () => void toggleOverlayVisibility(),
		'view-switch': () => void switchViewRef.current('toggle'),
	};
	useEffect(() => onGlobalShortcut((action) => shortcutHandlersRef.current[action]?.()), []);

	// A shortcut another app holds would otherwise just silently do nothing.
	useEffect(() => onShortcutFailures((failures) => setError(describeShortcutFailures(failures))), []);

	// The live setup is what Ctrl+Shift+R, the tray and the phone remote record with - and Rust
	// builds that start request itself (services/recording_setup.rs), so every part of it is written
	// through to the settings file as it changes. Bottom bar and Settings are therefore one setting.
	// "c" is only the screenshot flow's brief detour, never a recording setup to keep. Devices are
	// saved by the pickers themselves (BottomDocker), on an explicit pick only: an automatic fallback
	// to the first device while the usual one is unplugged must not overwrite the user's choice.
	useEffect(() => {
		updateSettings({
			...(["sva", "sa", "s", "va", "v", "a"].includes(recordType) ? { defaultRecordType: recordType } : {}),
			defaultIncludeSystemAudio: includeSystemAudio,
			defaultResolutionWidth: resolutionWidth,
			defaultFramerate: framerate,
			cameraOverlayShape: overlayShape,
			cameraOverlayPosition: overlayPosition,
			cameraOverlaySize: overlaySize,
			separateWebcamCapture,
			trackClicks,
		});
	}, [recordType, includeSystemAudio, resolutionWidth, framerate, overlayShape, overlayPosition, overlaySize, separateWebcamCapture, trackClicks]);

	// The tray icon's menu (services/tray.rs) - it can be used with this window hidden in the tray.
	// Also the work Rust queued for this page (services/main_window.rs): a start that needs a page
	// (the phone camera) or an error to show, from a shortcut/tray/remote press while no window
	// existed. The queue is pulled once the listeners are in place - pushed events could arrive
	// before them and be lost.
	const mainActionRef = useRef<(payload: { action: string; recordType?: string; message?: string }) => void>(() => {});
	mainActionRef.current = (payload) => {
		switch (payload.action) {
			case "record":
				if (!recordingHotkeyRef.current.isRecording) handleRecordingToggleHotkey(payload.recordType);
				break;
			case "stop":
				if (recordingHotkeyRef.current.isRecording) handleRecordingToggleHotkey();
				break;
			case "screenshot":
				startSnip().catch((err) => setError(`Couldn't start a screenshot: ${err}`));
				break;
			case "quit":
				void quitApp();
				break;
			case "error":
				if (payload.message) setError(payload.message);
				break;
		}
	};
	useEffect(() => {
		let disposed = false;
		const unlisteners: Array<() => void> = [];
		void (async () => {
			for (const event of ["tray-action", "main-action"]) {
				const fn = await listen<{ action: string; recordType?: string; message?: string }>(event, ({ payload }) => mainActionRef.current(payload));
				if (disposed) fn();
				else unlisteners.push(fn);
			}
			if (disposed) return;
			const pending = await invoke<Array<{ action: string; recordType?: string; message?: string }>>("take_main_window_actions").catch(() => []);
			pending.forEach((payload) => mainActionRef.current(payload));
		})();
		return () => {
			disposed = true;
			unlisteners.forEach((fn) => fn());
		};
	}, []);

	// (The tray's red dot and the recording-only shortcuts are set by the recording commands
	// themselves - services/recording_session.rs - so they're right whoever starts or stops.)

	// ---- The phone app's Remote, Voice-over and Beam (phone_transfer_page.html). Phones mirror this
	// window's state: recording (with a pause-aware elapsed snapshot the phone ticks on from, so the
	// two clocks never have to agree), the screen/camera view, and the open video's playback. It goes
	// out when something meaningful changes - checked twice a second, a few bytes each time.
	const remoteSnapshotRef = useRef<() => Record<string, unknown>>(() => ({}));
	remoteSnapshotRef.current = () => {
		const now = Date.now();
		const elapsedMs =
			isRecording && recordingStartTime
				? Math.max(0, (isPaused && pauseStartedAt ? pauseStartedAt : now) - recordingStartTime - pausedAccumulatedMs)
				: 0;
		const playback = phoneTimelineName ? videoPlayerRef.current?.getPlaybackState() : null;
		return {
			recording: isRecording,
			paused: isPaused,
			elapsedMs,
			canSwitchView: isRecording && canSwitchView,
			view: viewMode,
			editing: phoneTimelineName,
			playing: !!playback && !playback.paused,
			time: Math.round(currentOutputTime * 10) / 10,
			duration: Math.round(totalOutputDuration * 10) / 10,
			canUndo: !!phoneTimelineName && editStore.canUndo,
			canRedo: !!phoneTimelineName && editStore.canRedo,
			// What a Record press will capture, and with which camera - the phone's Remote picks both.
			mode: recordType,
			cameraSource: videoDevices.includes(PHONE_CAMERA_DEVICE) ? "phone" : videoDevices.length ? "pc" : "none",
			phoneCam: getPhoneCameraState().status,
		};
	};
	useEffect(() => {
		let last = "";
		const send = () => {
			const state = remoteSnapshotRef.current();
			// The elapsed time ticks on by itself on the phone - only a change of state is news.
			const key = JSON.stringify({ ...state, elapsedMs: 0 });
			if (key === last) return;
			last = key;
			void broadcastToPhones("remote_state", state);
		};
		send();
		const timer = window.setInterval(send, 500);
		return () => window.clearInterval(timer);
	}, []);

	// The playhead to timeline time `t` - on the clips as they play, so a project made only of scenes
	// (on its blank canvas) seeks too. What the scene panel uses to show a beat at rest.
	const seekPlaybackTime = (t: number) => {
		let acc = 0;
		const clips = editStore.playbackClips;
		for (let i = 0; i < clips.length; i++) {
			const d = clipOutputDuration(clips[i]);
			if (acc + d > t + 1e-3 || i === clips.length - 1) {
				handleSeekActiveFile(clips[i].sourcePath, outputOffsetToSource(clips[i], Math.min(d, Math.max(0, t - acc))));
				return;
			}
			acc += d;
		}
	};

	// Timeline time -> the clip and source time under it, for the remote's Retake (which goes back to
	// where the take it replaces began).
	const seekOutputTime = (t: number) => {
		let acc = 0;
		for (const clip of editStore.clips) {
			const d = clipOutputDuration(clip);
			if (acc + d > t + 1e-3) {
				handleSeekActiveFile(clip.sourcePath, outputOffsetToSource(clip, t - acc));
				return;
			}
			acc += d;
		}
	};

	// Studio Silence: while a voice-over take rolls, everything this window plays is muted, so the
	// phone's mic hears only the voice - then each element goes back to exactly how it was. If the
	// phone vanishes mid-take, a failsafe brings the sound back.
	const studioSilenceRef = useRef<{ muted: Map<HTMLMediaElement, boolean>; failsafe: number } | null>(null);
	const endStudioSilence = () => {
		const s = studioSilenceRef.current;
		if (!s) return;
		studioSilenceRef.current = null;
		window.clearTimeout(s.failsafe);
		s.muted.forEach((was, el) => {
			el.muted = was;
		});
		const playback = videoPlayerRef.current?.getPlaybackState();
		if (playback && !playback.paused) videoPlayerRef.current?.togglePlay();
		void broadcastToPhones("voiceover", { state: "idle" });
	};
	const startStudioSilence = async (requestedAt: unknown) => {
		if (!editingVideoRef.current) {
			void broadcastToPhones("voiceover", { state: "unavailable" });
			return;
		}
		endStudioSilence();
		const retakeAt = typeof requestedAt === "number" && Number.isFinite(requestedAt) ? requestedAt : null;
		if (retakeAt !== null) {
			seekOutputTime(retakeAt);
			await new Promise((r) => window.setTimeout(r, 300));
		}
		const at = retakeAt ?? Math.max(0, Math.min(currentOutputTime, totalOutputDuration));
		const muted = new Map<HTMLMediaElement, boolean>();
		document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((el) => {
			muted.set(el, el.muted);
			el.muted = true;
		});
		studioSilenceRef.current = { muted, failsafe: window.setTimeout(endStudioSilence, 15 * 60_000) };
		videoPlayerRef.current?.play();
		void broadcastToPhones("voiceover", { state: "rolling", at, startedAt: Date.now() });
	};

	// The computer cameras that were picked before the phone took over, so "Computer camera" on the
	// Remote goes back to exactly those.
	const pcCamerasRef = useRef<string[]>([]);
	const remoteActionRef = useRef<(command: PhoneRemoteCommand) => void>(() => {});
	remoteActionRef.current = (command) => {
		const editing = editingVideoRef.current;
		switch (command.action) {
			case "record.mode":
				if (!isRecording && ["sva", "sa", "s", "va", "v", "a"].includes(String(command.value))) setRecordType(String(command.value));
				break;
			case "camera.source":
				if (isRecording) break;
				if (command.value === "phone") {
					// The phone app is about to offer its camera over its own connection.
					void listenForPhoneCamera();
					const pc = videoDevices.filter((d) => d !== PHONE_CAMERA_DEVICE);
					if (pc.length) pcCamerasRef.current = pc;
					setVideoDevices([PHONE_CAMERA_DEVICE]);
				} else {
					setVideoDevices((prev) => {
						const pc = prev.filter((d) => d !== PHONE_CAMERA_DEVICE);
						return pc.length ? pc : pcCamerasRef.current;
					});
				}
				break;
			case "record.toggle":
				handleRecordingToggleHotkey();
				break;
			case "record.pause":
				if (isRecording) void (isPaused ? handleResumeRecording() : handlePauseRecording());
				break;
			case "view.toggle":
				void switchViewRef.current("toggle");
				break;
			case "play.toggle":
				if (editing) videoPlayerRef.current?.togglePlay();
				break;
			case "seek":
				// The same arrow keys the keyboard uses, so it behaves exactly as they do in every mode.
				if (editing) document.dispatchEvent(new KeyboardEvent("keydown", { key: Number(command.value) < 0 ? "ArrowLeft" : "ArrowRight", bubbles: true }));
				break;
			case "undo":
				if (editing && editStore.canUndo) editStore.undo();
				break;
			case "redo":
				if (editing && editStore.canRedo) editStore.redo();
				break;
			case "voiceover.start":
				void startStudioSilence(command.value);
				break;
			case "voiceover.stop":
				endStudioSilence();
				break;
		}
	};
	useEffect(() => {
		const stopRemote = onPhoneRemote((command) => remoteActionRef.current(command));
		const stopClip = onPhoneClip((clip) =>
			setMessage(clip.opened ? `Opened a link from ${clip.device_name}` : `Copied from ${clip.device_name}: “${clip.text.slice(0, 60)}${clip.text.length > 60 ? "…" : ""}”`)
		);
		return () => {
			stopRemote();
			stopClip();
		};
	}, []);

	// Screenshots: Alt+Shift+S from any app opens the screen picker, and the picker reports back
	// here when it's done (commands/snip.rs emits snip-done; null means cancelled).
	useEffect(() => {
		const unlisten = listen<SnipResult | null>('snip-done', (event) => {
			if (!event.payload) return;
			const name = event.payload.path.split(/[\\/]/).pop() ?? event.payload.path;
			setError('');
			setMessage(event.payload.copied ? `Screenshot saved and copied to the clipboard: ${name}` : `Screenshot saved: ${name}`);
		});
		return () => {
			unlisten.then((fn) => fn());
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
	// The Video Editor's "Create video" - a new project (services/video_edits.rs) in the library,
	// seeded with one clip per picked image (or none, for a blank timeline), opened straight into
	// the editor. Errors are thrown back to NewVideoProjectDialog so it can show them in place.
	const [isNewVideoProjectOpen, setIsNewVideoProjectOpen] = useState(false);
	const handleCreateVideoProject = async (request: NewVideoProjectRequest): Promise<void> => {
		const state = request.state ?? createProjectState(request.imagePaths, request.options);
		const projectPath = await invoke<string>("create_video_project", {
			name: request.name,
			width: request.frame.width,
			height: request.frame.height,
			editStateJson: JSON.stringify(state),
		});
		setIsNewVideoProjectOpen(false);
		// The library re-listing waits until the editor is up - run alongside, its re-render of the
		// whole library competed with opening the project and made Create feel slow.
		try {
			await handleOpenVideoInEditor({ path: projectPath, name: projectPath.split(/[\\/]/).pop() ?? projectPath });
		} finally {
			void handleDirectoryFiles();
		}
	};
	// Back to where the user was after a reload (sleep/wake, a recovered WebView, Ctrl+R) rather
	// than the home screen - see sessionRestore.ts. Restored once on mount; saving only starts
	// after that attempt, so the empty first render can't overwrite what's about to be restored.
	const workspaceRestoredRef = useRef(false);
	useEffect(() => {
		const saved = loadWorkspace();
		if (!saved) {
			workspaceRestoredRef.current = true;
			return;
		}
		(async () => {
			try {
				if (saved.file) {
					await loadFileForPlayback(saved.file.path, saved.file.name);
					// loadFileForPlayback leaves the Video Editor unless it was already open.
					setVideoEditorScreen(saved.videoEditor);
				} else if (saved.videoEditor) setVideoEditorScreen(saved.videoEditor);
				else if (saved.docs) setDocsScreen(saved.docs);
				else if (saved.whiteboard) setWhiteboardScreen(saved.whiteboard);
				else if (saved.mindmap) setMindmapScreen(saved.mindmap);
				else if (saved.board) setBoardScreen(saved.board);
				setDockerMode(saved.dockerMode);
			} catch (error) {
				console.error("Couldn't restore the previous workspace:", error);
			} finally {
				workspaceRestoredRef.current = true;
			}
		})();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useEffect(() => {
		if (!workspaceRestoredRef.current) return;
		saveWorkspace({
			file: selectedFile ? { path: selectedFile.sourcePath, name: selectedFile.name } : null,
			videoEditor: videoEditorScreen,
			docs: docsScreen,
			whiteboard: whiteboardScreen,
			mindmap: mindmapScreen,
			board: boardScreen,
			dockerMode,
		});
	}, [selectedFile, videoEditorScreen, docsScreen, whiteboardScreen, mindmapScreen, boardScreen, dockerMode]);
	const loadFileForPlayback = async (filePath: string, fileName: string) => {
	// Document files (.docx/.md/.txt) open in Briefcast Docs - converted into a Briefcast document,
	// or the one already made from the same unchanged file - rather than in another app.
	if (isOpenableDocument(fileName)) {
		setMessage(`Opening ${fileName}…`);
		try {
			const { docId } = await openDocumentFile(filePath, fileName);
			handleOpenDocs();
			setDocsScreen({ mode: "editor", docId });
			setMessage("");
			void refreshDocsIndex();
		} catch (error) {
			console.error("Error opening document:", error);
			setMessage("");
			setError(`Couldn't open ${fileName}: ${error instanceof Error ? error.message : error}`);
		}
		return;
	}
	try {
		// Images (including HEIC/HEIF, auto-decoded to a cached PNG - see resolveImageDisplayUrl)
		// resolve through their own path; everything else is the plain convert_file_path_to_url +
		// convertFileSrc round-trip.
		const fileUrl = getFileCategory(fileName) === "image"
			? await resolveImageDisplayUrl({ name: fileName, path: filePath })
			: isVideoProjectPath(filePath)
				? await resolveProjectCanvasUrl(filePath)
				: convertFileSrc(await invoke<string>("convert_file_path_to_url", { filepath: filePath }));

		console.log('Converted file URL:', fileUrl);

		// Update the selected file state
		setSelectedFile({
		path: fileUrl,
		name: fileName,
		sourcePath: filePath
		});
		setBoardScreen(null);
		setDocsScreen(null);
		setWhiteboardScreen(null);
		// Opening another video while the Video Editor is open stays in the editor (jumping from
		// clip to clip is ordinary editing); opening anything it can't edit - an image, a PDF -
		// leaves it, since the tool has nothing to do with what's now on screen.
		setVideoEditorScreen((prev) => (prev && getFileCategory(fileName) === "video" ? { mode: "editing" } : null));
		// The player starts over on the file's own picture - the timeline must re-seat playback on
		// its first clip (see forgetTimelineBootstrap).
		forgetTimelineBootstrap(filePath);
		// A project has nothing to show but its timeline (its own picture is a blank canvas), so it
		// always opens in the editor.
		if (isVideoProjectPath(filePath)) {
			setVideoEditorScreen({ mode: "editing" });
			setDockerMode("file-tools");
			window.dispatchEvent(new Event(SHOW_DOCKER_EVENT));
		} else if (getFileCategory(fileName) === "video" && editorOpenByVideoRef.current.has(filePath)) {
			// Back to a video seen earlier this session: its editor as it was left (see
			// editorOpenByVideoRef). The timeline puts the playhead back too (leftAtByFile).
			const wasOpen = editorOpenByVideoRef.current.get(filePath);
			setDockerMode(wasOpen ? "file-tools" : "record");
			if (wasOpen) window.dispatchEvent(new Event(SHOW_DOCKER_EVENT));
		}
		setRecentPaths(recordFileOpened(filePath));
		// Remembered per category so clicking the sidebar's Video/Audio/Image/Pdf/Documents tab can
		// bring this file back later (see restoreLastOpenedForCategory below), rather than leaving
		// whatever unrelated file happens to be on screen when the tab changes.
		const openedCategory = getFileCategory(fileName);
		if (openedCategory) recordLastOpenedFile(openedCategory, { path: filePath, name: fileName });

		console.log('File selected for playback:', fileName);
	} catch (error) {
		console.error('Error loading file:', error);
		setError(`Failed to load file: ${error}`);
	}
	};

	// A plain click on a sidebar file. Mid-edit it would swap the editor out for that file, so it
	// asks first - same prompt as opening a folder (openFolderGallery).
	const openFileFromSidebar = async (file: FileEntry): Promise<void> => {
		if (editingVideoRef.current && file.path !== selectedFile?.sourcePath) {
			const proceed = await ask(`You are about to open "${file.name}". The video you're editing will be closed.`, {
				title: "Open file?",
				kind: "warning",
				okLabel: "Open",
				cancelLabel: "Close",
			});
			if (!proceed) return;
		}
		await handleFileClick(file);
	};

	const handleFileClick = async (file: FileEntry) => {
		await loadFileForPlayback(file.path, file.name);
	};

	// Fired by VideoTimelineDocker's Save button once export_trimmed_video finishes - same
	// refresh-list-then-select-the-result shape as ConversionDialog's onConverted below, since
	// this is exactly the same kind of event (a new file appeared in the library, backed by a
	// real render already sitting on disk). The video that was being edited is left exactly as it
	// was; this just adds its trimmed/cut sibling alongside it.
	// Background exports (exportQueue.ts): each finished file joins the library; nothing jumps away
	// from what's being edited - the exports panel offers to open, show or share it.
	const libraryRefreshRef = useRef<() => void>(() => {});
	libraryRefreshRef.current = () => void handleDirectoryFiles();
	useEffect(() => {
		installCloseGuards();
		// What this page is doing that can't carry on without it - the window is kept (only hidden)
		// in the tray while any of these is true. A plain recording isn't one: Rust runs it.
		const stopBlocking = addReleaseBlocker(() => {
			if (phoneCaptureRef.current) return "the phone camera is being recorded";
			if (getPresentationState().active) return "the live display is on";
			if (studioSilenceRef.current) return "a voice-over take is rolling";
			return null;
		});
		installGlobalCloseGuard();
		const stopListening = onJobFinished((job) => {
			libraryRefreshRef.current();
			setMessage(`Exported ${formatFileName(job.resultPath?.split(/[\\/]/).pop() ?? job.title)}`);
		});
		return () => {
			stopBlocking();
			stopListening();
		};
	}, []);
	const [shareJob, setShareJob] = useState<ExportJob | null>(null);

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

	// Small icon shown next to a file name in the home-screen "From your library" preview list, the
	// sidebar file list, and the "Now open" banner.
	const categoryIcon = (category: FileCategory | null): React.ReactNode =>
		FILE_CATEGORY_TABS.find((tab) => tab.category === category)?.icon ?? <IoDocumentText size={18} />;

	// A distinct color per category, matching categoryIcon 1:1 - gives the sidebar's otherwise
	// text-only file rows a quick, scannable visual cue for "what kind of file is this" at a
	// glance, the same job the old per-row emoji (formatFileName's icon) used to do less legibly.
	const CATEGORY_ICON_COLOR: Record<FileCategory, string> = {
		video: "text-violet-500 dark:text-violet-400",
		audio: "text-pink-500 dark:text-pink-400",
		image: "text-emerald-500 dark:text-emerald-400",
		pdf: "text-red-500 dark:text-red-400",
		document: "text-blue-500 dark:text-blue-400",
	};
	const categoryIconColorClassName = (category: FileCategory | null): string =>
		category ? CATEGORY_ICON_COLOR[category] : "text-neutral-400 dark:text-neutral-500";

	// What to surface on the empty home screen so it isn't just a blank void: library files and
	// Briefcast's own documents, whiteboards and mind maps in one most-recent-first list, with
	// pinned files (in pin order - see utils/homeScreenFiles.ts) always on top. See
	// utils/homeLibraryItems.ts for the ranking.
	// Memoized (with the per-tool lists below) so the Video Editor home and Create dialog get the
	// same arrays back on every unrelated Dashboard render - a new array re-ran their thumbnail
	// effects and re-rendered every tile.
	const allLibraryFiles = useMemo(() => Object.values(files).flat(), [files]);
	// Each library file's folder, looked up at once (findFileFolder walks every folder).
	const folderByPath = useMemo(() => new Map(Object.entries(files).flatMap(([folder, list]) => list.map((f) => [f.path, folder] as const))), [files]);
	const folderOfPath = useCallback((path: string) => folderByPath.get(path) ?? null, [folderByPath]);
	// "Tidy up library" (TidyLibraryDialog) - from the Video Editor's home.
	const [tidyOpen, setTidyOpen] = useState(false);
	const libraryVideoFiles = useMemo(() => allLibraryFiles.filter((file) => getFileCategory(file.name) === "video"), [allLibraryFiles]);
	const libraryImageClipFiles = useMemo(() => allLibraryFiles.filter((file) => isImageClipPath(file.path)), [allLibraryFiles]);
	const libraryClipVideoFiles = useMemo(() => libraryVideoFiles.filter((file) => !isVideoProjectPath(file.path)), [libraryVideoFiles]);
	// The home screen's items - rebuilt only when the library, pins, history or indexes change,
	// not on every render of the page (playback ticks re-render it several times a second).
	const libraryFilesByPath = useMemo(() => new Map(allLibraryFiles.map((file) => [file.path, file])), [allLibraryFiles]);
	const homeItems = useMemo(
		() =>
			buildHomeItems({
				files: allLibraryFiles,
				pinnedPaths,
				recentPaths,
				openedAt,
				docs: docsIndex.filter((d) => !d.deleted_at).map((d) => ({ id: d.id, name: d.title, updated_at: d.updated_at })),
				whiteboards: whiteboardIndex,
				mindmaps: mindmapIndex,
			}),
		[allLibraryFiles, pinnedPaths, recentPaths, openedAt, docsIndex, whiteboardIndex, mindmapIndex]
	);
	const homeFiles = useMemo(
		() => homeItems.flatMap((item) => (item.kind === "file" && libraryFilesByPath.has(item.id) ? [libraryFilesByPath.get(item.id)!] : [])),
		[homeItems, libraryFilesByPath]
	);
	const openHomeItem = (item: HomeItem) => {
		if (item.kind === "file") {
			const file = libraryFilesByPath.get(item.id);
			if (file) handleFileClick(file);
		} else if (item.kind === "doc") {
			handleOpenDocs();
			setDocsScreen({ mode: "editor", docId: item.id });
		} else if (item.kind === "whiteboard") {
			handleOpenWhiteboard();
			setWhiteboardScreen({ mode: "editor", whiteboardId: item.id });
		} else {
			handleOpenMindmap();
			setMindmapScreen({ mode: "editor", mindmapId: item.id });
		}
	};
	// Cross-links (contexts/ItemLinksContext): every viewer's "Linked" control lands here to switch
	// to the other end, whatever it is.
	const openLinkedItem = (target: ItemRef) => {
		if (target.kind === "file") {
			const wanted = normalizePath(target.id);
			const file = allLibraryFiles.find((f) => normalizePath(f.path) === wanted);
			if (file) handleFileClick(file);
			return;
		}
		openHomeItem({ kind: target.kind, id: target.id } as HomeItem);
	};
	const HOME_KIND: Record<Exclude<HomeItem["kind"], "file">, { label: string; icon: React.ReactNode; color: string }> = {
		doc: { label: "Document", icon: <IoDocumentTextOutline size={18} />, color: "text-blue-500 dark:text-blue-400" },
		whiteboard: { label: "Whiteboard", icon: <IoGitNetworkOutline size={18} />, color: "text-amber-500 dark:text-amber-400" },
		mindmap: { label: "Mind map", icon: <IoMapOutline size={18} />, color: "text-teal-500 dark:text-teal-400" },
	};
	// Length shown next to each audio/video row's size - probed only for those (at most
	// HOME_LIST_SIZE) rows, never the whole library.
	const libraryPreviewDurations = useMediaDurations(
		homeFiles.filter((file) => {
			const category = getFileCategory(file.name);
			return category === "video" || category === "audio";
		})
	);

	// Flattened, sidebar-order file list for a category — spans all folders, not just the one
	// the currently selected file happens to live in, so prev/next still works when a category
	// is split across multiple folders.
	const getFlatFilesForCategory = (category: FileCategory): FileEntry[] =>
		Object.values(files)
			.flat()
			.filter((file) => getFileCategory(file.name) === category);

	// Switching to a sidebar category tab reopens whatever was last open under it, so the tabs
	// behave like the per-type workspaces they look like rather than only re-filtering the file
	// list while some unrelated file stays on screen. Paired with the resume positions above, that
	// means clicking Video mid-way through a podcast and clicking back to Audio lands exactly where
	// each was left.
	//
	// Deliberately conservative about *not* acting:
	//   - nothing remembered for the category, or the file list hasn't loaded yet: leave the main
	//     pane exactly as it is, rather than blanking out whatever the user is looking at.
	//   - the remembered file is gone from disk (deleted/moved outside the app): drop the entry so
	//     the tab stops trying, and leave the pane alone this time.
	//   - it's already what's open: don't reload it, which would restart playback from the resume
	//     point and throw away the live player's position.
	const restoreLastOpenedForCategory = async (category: FileCategory) => {
		const last = getLastOpenedFile(category);
		if (!last) return;

		const categoryFiles = getFlatFilesForCategory(category);
		// An empty list here means "not loaded yet" as often as it means "none left", and forgetting
		// the entry on the former would quietly lose it, so only treat a *populated* list that's
		// missing the file as proof it's gone.
		if (categoryFiles.length === 0) return;
		if (!categoryFiles.some((file) => file.path === last.path)) {
			forgetLastOpenedFile(category);
			return;
		}

		if (selectedFileRef.current?.sourcePath === last.path) return;
		await loadFileForPlayback(last.path, last.name);
	};

	// Cycles to the previous/next image relative to whatever's currently selected, wrapping
	// around at either end (matches how most image viewers handle prev/next at the boundaries).
	//
	// `images` is `getFlatFilesForCategory`'s raw order - whatever list_briefcast_files' own
	// std::fs::read_dir happened to return (no sort applied on either side), which is an NTFS
	// directory-enumeration order, not a guaranteed name/date order. Confirmed directly (both the
	// on-screen "Next (→)" button and the keyboard Down/Right arrows, which call this with the
	// exact same direction=1) that walking that raw order forward from a file lands on what a
	// user reading the gallery grid perceives as the PREVIOUS tile, not the next one - so `next`/
	// `previous` here are named for what they mean to the caller (Next button, Right/Down arrow =
	// "forward"), and the sign flip below is what makes that match raw array order rather than
	// fight it.
	const navigateImage = (direction: 1 | -1) => {
		if (!selectedFile) return;
		const images = getFlatFilesForCategory("image");
		if (images.length === 0) return;
		const currentIndex = images.findIndex((file) => file.path === selectedFile.sourcePath);
		if (currentIndex === -1) return;
		const nextIndex = (currentIndex - direction + images.length) % images.length;
		const next = images[nextIndex];
		loadFileForPlayback(next.path, next.name);
	};

	// Persists the currently-playing file's position on every tick, keyed by its filesystem path —
	// read back in the `initialTime` passed to VideoPlayer below so navigating away and back
	// (leaving for Docs/Board/home, switching sidebar tabs, or an accidental prev/next tap)
	// resumes instead of restarting. Applies to video and audio alike; the persistence itself,
	// including the throttling that keeps ~4 ticks/sec off localStorage, lives in
	// utils/playbackResume.ts. Stable identity (empty deps) so VideoPlayer's own timeupdate
	// listener doesn't get torn down and re-attached on every unrelated Dashboard re-render.
	const handleMediaTimeUpdate = useCallback((time: number) => {
		const current = selectedFileRef.current;
		if (!current) return;
		const category = getFileCategory(current.name);
		if (category === "video" || category === "audio") {
			recordPlaybackPosition(current.sourcePath, time);
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
		// A file watched to the end has no position worth resuming - without this it would reopen a
		// second before the end and immediately end again. Done before the auto-advance handlers
		// below, which may change what selectedFileRef points at.
		const finished = selectedFileRef.current;
		if (finished) clearPlaybackPosition(finished.sourcePath);
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

	// Escape clears the current multi-selection - the sidebar's checkbox multi-select and the
	// image gallery's Ctrl/Shift-click selection (ImageFolderGallery.tsx) are the same
	// selectedFilePaths Set, so this one shortcut covers both. Only attached while there's
	// actually a selection to clear, and skipped while focus is in a text field (the search box,
	// an inline rename, a new-folder name) so it doesn't steal Escape from whatever that field's
	// own handler - or its default browser behavior - would otherwise do with it.
	useEffect(() => {
		if (selectedFilePaths.size === 0) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
			setSelectedFilePaths(new Set());
		};

		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [selectedFilePaths.size]);

	// Closes a file row's 3-dot menu (and its Move-to/Link-notes submenus) on a click anywhere
	// else, or on Escape - previously it only closed via its own toggle button or by picking an
	// action, so clicking away (or even just wanting out without picking anything) left it stuck
	// open. pointerdown, not click, so a press that's opening a *different* row's menu doesn't get
	// eaten by this one closing first (same reasoning as ImageFolderGallery.tsx's own outside-click
	// handler for its context menu) - and it never fires for the toggle button's own click in the
	// first place, since that handler already calls stopPropagation.
	useEffect(() => {
		if (!openMenu) return;

		const close = (e: Event) => {
			if (e instanceof KeyboardEvent && e.key !== "Escape") return;
			setOpenMenu(null);
			setLinkDocsMenuOpenFor(null);
		};

		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", close);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", close);
		};
	}, [openMenu]);

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
				await showMessageDialog(`"${name}" isn't a supported file type (video, audio, image, PDF, or document).`, {
					title: 'Unsupported file',
					kind: 'warning',
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

	// Memoized for the same reason resolvePreviewAssetUrl etc. are useCallback'd above: passed as
	// the `files`/`folderOptions` props into ImageFolderGallery/VideoFolderGallery, which use
	// `files`'s identity as a dependency of their own thumbnail-resolving effect. Recomputing a
	// fresh array here on every Dashboard render (as this used to do inline in the JSX below)
	// handed the gallery a new array reference on every render regardless of whether the underlying
	// file list had actually changed - including on every selection click - which re-triggered that
	// effect needlessly.
	const selectedFolderImages = useMemo(
		() => (selectedFolder !== null ? (files[selectedFolder] || []).filter((file) => getFileCategory(file.name) === "image") : []),
		[files, selectedFolder]
	);
	const selectedFolderVideos = useMemo(
		() => (selectedFolder !== null ? (files[selectedFolder] || []).filter((file) => getFileCategory(file.name) === "video") : []),
		[files, selectedFolder]
	);
	const selectedFolderPdfs = useMemo(
		() => (selectedFolder !== null ? (files[selectedFolder] || []).filter((file) => getFileCategory(file.name) === "pdf") : []),
		[files, selectedFolder]
	);
	const selectedFolderDocuments = useMemo(
		() => (selectedFolder !== null ? (files[selectedFolder] || []).filter((file) => getFileCategory(file.name) === "document") : []),
		[files, selectedFolder]
	);
	// Not category-specific despite living alongside the memos above - every folder in the
	// library, for any gallery's "Move to" list.
	const folderOptions = useMemo(
		() => Object.keys(files).sort((a, b) => a.localeCompare(b)).map((key) => ({ key, label: folderDisplayName(key) })),
		[files]
	);

	const findFileFolder = (path: string): string | null => {
		for (const [folder, list] of Object.entries(files)) {
			if (list.some((f) => f.path === path)) return folder;
		}
		return null;
	};

	// Set right before a scroll-into-view should happen, then consumed (and reset to null) by the
	// effect below - not read directly, just a trigger. A plain function call can't do this itself
	// because the target row may not exist in the DOM yet (its category tab might not be active,
	// its folder might be collapsed) until the state changes below actually re-render the sidebar.
	const [pendingScrollToPath, setPendingScrollToPath] = useState<string | null>(null);

	// Jumps the sidebar to wherever the currently open file actually lives - switches to its
	// category tab and expands its folder if either is hiding it, then scrolls its row into view.
	// See the "now open" sticky banner below for the one caller.
	const handleJumpToOpenFile = () => {
		if (!selectedFile) return;
		const category = getFileCategory(selectedFile.name);
		if (category && category !== activeFileCategory) {
			setActiveFileCategory(category);
			setSelectedFilePaths(new Set());
			setSelectedFolder(null);
		}
		const folder = findFileFolder(selectedFile.sourcePath);
		if (folder !== null) folderCollapse.expand(folder);
		setPendingScrollToPath(selectedFile.sourcePath);
	};

	// Runs after whichever of the category/collapse-state changes above actually needed to happen
	// has committed and re-rendered the sidebar, so the target row is guaranteed to exist in the
	// DOM by the time this queries for it - a plain setTimeout/rAF after the click would be racing
	// that render instead of waiting on it.
	useEffect(() => {
		if (!pendingScrollToPath) return;
		// A frame on, so a folder just expanded (folderCollapse - the tree re-renders on its own) is in.
		const target = pendingScrollToPath;
		requestAnimationFrame(() => document.querySelector(`[data-file-path="${CSS.escape(target)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
		setPendingScrollToPath(null);
	}, [pendingScrollToPath, activeFileCategory]);

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
		folderCollapse.expand(parentFolder);
	};

	const commitCreateFolder = async () => {
		const parent = creatingFolderIn;
		const name = newFolderValue.trim();
		setCreatingFolderIn(null);
		if (parent === null || !name) return;
		// The backend only rejects a duplicate name within the same parent directory - nothing stops
		// two folders sharing a name elsewhere in the tree (e.g. "MSC Research" under two different
		// parents), and since the sidebar only ever shows a folder's last path segment, that pair
		// would otherwise render identically with no indication anything's ambiguous. Non-blocking:
		// this only warns after creation succeeds, it never prevents it.
		const collidesElsewhere = Object.keys(files).some((existingFolder) => folderDisplayName(existingFolder) === name && existingFolder !== `${parent}/${name}` && existingFolder !== name);
		try {
			await invoke<string>("create_folder", { parentPath: parent, name });
			await handleDirectoryFiles();
			setMessage(
				collidesElsewhere
					? `Created folder: ${name} (note: another folder is already named "${name}" elsewhere - hover a folder to see its full path)`
					: `Created folder: ${name}`
			);
		} catch (error) {
			console.error("Error creating folder:", error);
			setError(`Failed to create folder: ${error}`);
		}
	};

	// Handles both a single-file move and a bulk move — `fileList` is whatever filesToActOn()
	// decided applies (see its comment). Files already in destFolder are silently skipped rather
	// than erroring, since a multi-selection spanning folders will often already include some
	// that are exactly where they're being dropped.
	const handleMoveFiles = async (fileList: FileEntry[], destFolder: string, quiet = false): Promise<number> => {
		setOpenMenu(null);
		setDragOverFolder(null);
		const toMove = fileList.filter((file) => findFileFolder(file.path) !== destFolder);
		if (toMove.length === 0) return 0;
		try {
			const results = await Promise.allSettled(
				// A name already taken there: both kept, this one numbered ("name (2).ext") - never overwritten.
				toMove.map((file) => invoke<string>("move_file", { sourcePath: file.path, destFolderPath: destFolder, keepBoth: true }))
			);

			// Keep pin/recent-history pointed at each moved file's new path — repathFile reads then
			// writes localStorage synchronously, so chaining through fulfilled results in order is safe.
			results.forEach((result, i) => {
				if (result.status === "fulfilled") {
					const { pinned, recent } = repathFile(toMove[i].path, result.value);
					setPinnedPaths(pinned);
					setRecentPaths(recent);
					repathPlaybackState(toMove[i].path, result.value);
				}
			});

			// Same repair for any doc's linked_to pointing at a moved file - one refresh after the
			// loop rather than per-file, to avoid redundant list_docs calls during a bulk move.
			const relinkResults = await Promise.allSettled(
				results
					.map((result, i) => (result.status === "fulfilled" ? Promise.all([invoke("relink_doc_path", { oldPath: toMove[i].path, newPath: result.value }), invoke("relink_file_path", { oldPath: toMove[i].path, newPath: result.value })]) as Promise<unknown> : null))
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
			} else if (quiet) {
					// the caller reports the combined result
				} else if (toMove.length === 1) {
				const newName = results[0].status === "fulfilled" ? results[0].value.split(/[\\/]/).pop() ?? toMove[0].name : toMove[0].name;
				setMessage(
					newName === toMove[0].name
						? `Moved ${formatFileName(toMove[0].name)} to ${folderDisplayName(destFolder)}`
						: `Moved ${formatFileName(toMove[0].name)} to ${folderDisplayName(destFolder)} as ${formatFileName(newName)} - that name was taken`
				);
			} else {
				const renamed = results.filter((r, i) => r.status === "fulfilled" && (r.value.split(/[\\/]/).pop() ?? "") !== toMove[i].name).length;
				setMessage(`Moved ${toMove.length} files to ${folderDisplayName(destFolder)}${renamed ? ` (${renamed} numbered - their names were taken)` : ""}`);
			}
			return failedCount;
		} catch (error) {
			console.error("Error moving files:", error);
			setError(`Failed to move files: ${error}`);
			return fileList.length;
		}
	};

	// Moves a whole folder (its files and subfolders) under another folder, or to the root ("").
	// Done file by file through handleMoveFiles rather than one directory rename, so every file
	// keeps what travels with it - saved edits, linked notes, pins, playback position. The old
	// folders are removed afterwards, deepest first; delete_folder refuses a non-empty one, so a
	// folder still holding something that couldn't be moved stays put instead of losing it.
	const handleMoveFolder = async (folder: string, destFolder: string): Promise<void> => {
		setDragOverFolder(null);
		setDraggingFolder(null);
		setFolderMoveMenu(null);
		if (!canMoveFolder(folder, destFolder)) return;
		const newKey = movedFolderKey(folder, destFolder);
		if (newKey in files) {
			setError(`"${folderDisplayName(destFolder)}" already has a folder named "${folderDisplayName(folder)}"`);
			return;
		}
		const subtree = Object.keys(files)
			.filter((key) => key === folder || key.startsWith(`${folder}/`))
			.sort((a, b) => folderDepth(a) - folderDepth(b) || a.localeCompare(b));
		const target = (key: string): string => newKey + key.slice(folder.length);
		try {
			for (const key of subtree) {
				const to = target(key);
				const slash = to.lastIndexOf("/");
				await invoke<string>("create_folder", { parentPath: slash === -1 ? "" : to.slice(0, slash), name: to.slice(slash + 1) });
			}
			let failed = 0;
			let movedCount = 0;
			for (const key of subtree) {
				const list = files[key] ?? [];
				movedCount += list.length;
				failed += await handleMoveFiles(list, target(key), true);
			}
			const leftovers: string[] = [];
			for (const key of [...subtree].reverse()) {
				try {
					await invoke("delete_folder", { folderPath: key });
				} catch {
					leftovers.push(key);
				}
			}
			if (leftovers.length === 0) {
				setPinnedFolders(repathPinnedFolders(folder, newKey));
				folderCollapse.repath((k) => repathFolderKey(k, folder, newKey));
				setSelectedFolder((prev) => (prev === null ? prev : repathFolderKey(prev, folder, newKey)));
			}
			await handleDirectoryFiles();
			if (failed > 0 || leftovers.length > 0) {
				setError(
					`Moved "${folderDisplayName(folder)}" to ${folderDisplayName(destFolder)}, but ${failed || "some"} item(s) could not be moved, so the original folder was kept`
				);
			} else {
				setMessage(`Moved folder "${folderDisplayName(folder)}" (${movedCount} file${movedCount === 1 ? "" : "s"}) to ${folderDisplayName(destFolder)}`);
			}
		} catch (error) {
			console.error("Error moving folder:", error);
			await handleDirectoryFiles();
			setError(`Failed to move folder: ${error}`);
		}
	};

	// Routes a batch of already-in-the-library files (a sidebar row's "Add to board" menu item, the
	// bulk action bar's own button, or - separately - a sidebar drag onto the canvas, which
	// BoardEditor handles itself via the libraryDraggingFiles prop rather than this function) into
	// whichever board is currently open, via boardEditorRef's imperative handle. Silently drops any
	// non-image file rather than erroring - both call sites already only show the option for image
	// files/the image tab, so this filter is a safety net, not the primary gate.
	const handleAddFilesToBoard = async (fileList: FileEntry[]): Promise<void> => {
		setOpenMenu(null);
		const imagePaths = fileList.filter((file) => getFileCategory(file.name) === "image").map((file) => file.path);
		if (imagePaths.length === 0 || !boardEditorRef.current) return;
		await boardEditorRef.current.addImagesFromPaths(imagePaths);
		setSelectedFilePaths(new Set());
	};

	// Bulk counterpart to handleDeleteFile above - same move_to_trash-per-file/Promise.allSettled/
	// combined-message shape handleMoveFiles uses for a bulk move. Shared by the sidebar's own
	// bulk action bar and the image gallery's selection panel (ImageFolderGallery.tsx).
	const handleBulkDeleteFiles = async (fileList: FileEntry[]) => {
		if (fileList.length === 0) return;
		try {
			const results = await Promise.allSettled(fileList.map((file) => invoke("move_to_trash", { path: file.path })));
			results.forEach((result, i) => {
				if (result.status === "fulfilled") {
					if (selectedFile?.sourcePath === fileList[i].path) setSelectedFile(null);
					const { pinned, recent } = forgetFile(fileList[i].path);
					setPinnedPaths(pinned);
					setRecentPaths(recent);
					forgetPlaybackState(fileList[i].path);
				}
			});
			await handleDirectoryFiles();
			setSelectedFilePaths(new Set());
			const failedCount = results.filter((r) => r.status === "rejected").length;
			if (failedCount > 0) {
				const firstError = results.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
				setError(`Moved ${fileList.length - failedCount} of ${fileList.length} file(s) to trash — ${failedCount} failed: ${firstError}`);
			} else if (fileList.length === 1) {
				setMessage(`Moved to trash: ${formatFileName(fileList[0].name)}`);
			} else {
				setMessage(`Moved ${fileList.length} files to trash`);
			}
		} catch (error) {
			console.error("Error deleting files:", error);
			setError(`Failed to delete files: ${error}`);
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
			if (phonesPaired()) {
				shelfPointRef.current = { x: clientX, y: clientY };
				setShelfPoint(shelfPointRef.current);
				setExternalDrag(true);
			}
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
		const unlistenPromise = appWindow.onDragDropEvent(async (event) => {
			console.log("[Dashboard] onDragDropEvent", event.payload.type, event.payload.type === "drop" ? event.payload.paths : undefined);
			if (event.payload.type === "enter" || event.payload.type === "over") {
				if (videoEditorHomeRef.current) setEditorHomeDrag(true);
				// v1's single "hover" type (fired repeatedly for the whole drag) is split into "enter"
				// (once, with paths) and "over" (repeatedly, position only) in v2 - both are treated the
				// same here since this handler only ever needed the position, not the paths, until drop.
				// Only the most recently *requested* hover's resolution is ever applied - hover events
				// can arrive faster than the position round-trip resolves, and an out-of-order stale
				// result landing last would leave dragOverTimelineXRef pointing at an old position.
				const token = ++hoverTokenRef.current;
				const clientX = await resolveExternalDropClientX();
				if (hoverTokenRef.current === token) dragOverTimelineXRef.current = clientX;
				return;
			}
			if (event.payload.type === "drop" || event.payload.type === "leave") {
				const at = shelfPointRef.current;
				shelfPointRef.current = null;
				setExternalDrag(false);
				setShelfPoint(null);
				// Dropped on a phone (the shelf, or a card in the Phones panel): it's sent, not imported.
				const phone = event.payload.type === "drop" && at ? phoneDropAt(at.x, at.y) : null;
				if (phone && event.payload.type === "drop") {
					dragOverTimelineXRef.current = null;
					void dropOnPhone(phone, event.payload.paths);
					return;
				}
			}
			if (event.payload.type === "drop" || event.payload.type === "leave") setEditorHomeDrag(false);
			if (event.payload.type === "drop" && videoEditorHomeRef.current && event.payload.paths.some((p) => getFileCategory(p) === "video")) {
				setEditorHomeDrop({ paths: event.payload.paths, at: Date.now() });
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
			} else if (event.payload.type === "leave") {
				setDragOverFolder(null);
				dragOverTimelineXRef.current = null;
			}
		});
		return () => {
			unlistenPromise.then((unlisten) => unlisten());
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		if (!draggingFiles) return;
		const over = (e: DragEvent) => {
			setShelfPoint({ x: e.clientX, y: e.clientY });
			if ((e.target as Element | null)?.closest?.("[data-phone-drop]")) {
				e.preventDefault();
				if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
			}
		};
		const drop = (e: DragEvent) => {
			const phone = (e.target as Element | null)?.closest?.<HTMLElement>("[data-phone-drop]")?.dataset.phoneDrop;
			if (!phone) return;
			e.preventDefault();
			void dropOnPhone(phone, draggingFiles.map((f) => f.path));
			setDraggingFiles(null);
		};
		document.addEventListener("dragover", over);
		document.addEventListener("drop", drop);
		return () => {
			document.removeEventListener("dragover", over);
			document.removeEventListener("drop", drop);
			setShelfPoint(null);
		};
	}, [draggingFiles]);
	const shelfDragging = !!draggingFiles || externalDrag;
	const shelfAt = dragPoint ?? shelfPoint;
	const phoneHover = shelfDragging && shelfAt ? phoneDropAt(shelfAt.x, shelfAt.y) : null;

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

	const startRename = (file: FileEntry, inGallery = false) => {
		setRenameInGallery(inGallery);
		setRenamingFile(file.path);
		setOpenMenu(null);
	};

	// Shared by the sidebar's inline rename (commitRename below) and the "file tools" docker's
	// rename field — also fixes a latent staleness bug the inline rename used to have on its own:
	// renaming the file currently open in the player left `selectedFile` pointing at a path that
	// no longer existed on disk until the next unrelated refresh happened to fix it.
	// "Move or copy to..." (MoveCopyMenu.tsx) for one file or a whole selection - a library folder,
	// a brand-new one made right there, or anywhere on disk. Works the same for a file opened from
	// outside the library; transfer_file (utility.rs) handles name clashes, other drives and saved
	// edits. Files go one at a time (the backend serializes file moves anyway), so a failure part
	// way leaves every earlier file correctly moved and accounted for.
	const handleTransferFiles = async (fileList: { name: string; path: string }[], request: FileTransferRequest): Promise<void> => {
		setOpenMenu(null);
		setTransferMenu(null);
		if (fileList.length === 0) return;
		const pathName = (p: string) => p.split(/[\/]/).pop() ?? p;
		let destFolder: string;
		let absolute = false;
		try {
			if (request.dest.kind === "pick") {
				const picked = await openFileDialog({ directory: true, multiple: false, title: request.copy ? "Copy to folder" : "Move to folder" });
				if (typeof picked !== "string") return;
				destFolder = picked;
				absolute = true;
			} else if (request.dest.kind === "new-folder") {
				destFolder = await invoke<string>("create_folder", { parentPath: request.dest.parent, name: request.dest.name });
			} else {
				destFolder = request.dest.folder;
			}
		} catch (error) {
			setError(`Failed to create folder: ${error}`);
			return;
		}
		const destLabel = absolute ? pathName(destFolder) : folderDisplayName(destFolder);
		const verb = request.copy ? "copy" : "move";
		let done = 0;
		let alreadyThere = 0;
		let reopen: { path: string; name: string } | null = null;
		const failures: string[] = [];
		for (const file of fileList) {
			const isOpen = selectedFile?.sourcePath === file.path;
			// Moving the open video: its pending timeline edits go with it, nothing is left behind.
			const undoPrepare = !request.copy && isOpen ? await editStore.prepareFileMove() : null;
			try {
				const newPath = await invoke<string>("transfer_file", { sourcePath: file.path, destFolderPath: destFolder, destIsAbsolute: absolute, copy: request.copy });
				if (!request.copy && newPath === file.path) {
					undoPrepare?.();
					alreadyThere++;
					continue;
				}
				done++;
				if (!request.copy) {
					const { pinned, recent } = repathFile(file.path, newPath);
					setPinnedPaths(pinned);
					setRecentPaths(recent);
					repathPlaybackState(file.path, newPath);
					await invoke("relink_doc_path", { oldPath: file.path, newPath }).catch((error) => console.error("Failed to repair doc links after move:", error));
				await invoke("relink_file_path", { oldPath: file.path, newPath }).catch((error) => console.error("Failed to repair item links after move:", error));
					if (isOpen) reopen = { path: newPath, name: pathName(newPath) };
				}
			} catch (error) {
				undoPrepare?.();
				console.error(`Error trying to ${verb} file:`, file.path, error);
				failures.push(`${formatFileName(file.name)}: ${error}`);
			}
		}
		if (!request.copy && done > 0) await refreshDocsIndex().catch(() => {});
		await handleDirectoryFiles();
		if (reopen) await loadFileForPlayback(reopen.path, reopen.name);
		if (done > 0) setSelectedFilePaths(new Set());

		const what = fileList.length === 1 ? formatFileName(fileList[0].name) : `${done} files`;
		if (failures.length > 0) {
			setError(`${request.copy ? "Copied" : "Moved"} ${done} of ${fileList.length} — couldn't ${verb} ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ""}`);
		} else if (done > 0) {
			setMessage(`${request.copy ? "Copied" : "Moved"} ${what} to ${destLabel}${alreadyThere > 0 ? ` (${alreadyThere} already there)` : ""}`);
		} else if (alreadyThere > 0) {
			setMessage(`${fileList.length === 1 ? formatFileName(fileList[0].name) + " is" : "They're"} already in ${destLabel}`);
		}
	};

	// Opens "Set thumbnail" for a video - from the sidebar/gallery menus as well as the player's own
	// settings. A video that isn't open yet is opened first; the picker then waits for it to load.
	const [pendingThumbnailFor, setPendingThumbnailFor] = useState<string | null>(null);
	const handleSetThumbnail = async (file: { name: string; path: string }) => {
		setOpenMenu(null);
		if (selectedFile?.sourcePath === file.path) {
			videoPlayerRef.current?.openThumbnailPicker();
			return;
		}
		setPendingThumbnailFor(file.path);
		await loadFileForPlayback(file.path, file.name);
	};
	// Runs after VideoPlayer's own effects in the same commit, so the player already holds the newly
	// opened file by now and openThumbnailPicker waits on the right <video> load.
	useEffect(() => {
		if (!pendingThumbnailFor || selectedFile?.sourcePath !== pendingThumbnailFor) return;
		setPendingThumbnailFor(null);
		videoPlayerRef.current?.openThumbnailPicker();
	}, [pendingThumbnailFor, selectedFile?.sourcePath]);

	const fileTransferOptions: FileTransferOptions = { folders: folderOptions, folderOf: findFileFolder, onTransfer: handleTransferFiles };

	const renameFile = async (file: { name: string; path: string }, newName: string): Promise<void> => {
		if (!newName || newName === file.name) return;
		// The rename field shows the name without its extension, and rename_file adds it back - so
		// an untouched stem is the same name, not a clash with itself.
		const dotIndex = file.name.lastIndexOf('.');
		if (dotIndex > 0 && newName === file.name.slice(0, dotIndex)) return;
		const undoPrepare = selectedFile?.sourcePath === file.path ? await editStore.prepareFileMove() : null;
		try {
			const newPath = await invoke<string>('rename_file', { oldPath: file.path, newName });
			const { pinned, recent } = repathFile(file.path, newPath);
			setPinnedPaths(pinned);
			setRecentPaths(recent);
			repathPlaybackState(file.path, newPath);
			try {
				await invoke("relink_doc_path", { oldPath: file.path, newPath });
				await invoke("relink_file_path", { oldPath: file.path, newPath });
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
			undoPrepare?.();
			console.error('Error renaming file:', error);
			setError(`Failed to rename file: ${error}`);
		}
	};

	// The draft lives in InlineRenameInput, which also guarantees a single commit per rename.
	const commitRename = async (file: FileEntry, newName: string) => {
		setRenamingFile(null);
		await renameFile(file, newName);
	};

	const cancelRename = () => setRenamingFile(null);

	const handleCopyFilePath = async (file: FileEntry) => {
		setOpenMenu(null);
		try {
			await navigator.clipboard.writeText(file.path);
			setMessage("Path copied");
		} catch (error) {
			console.error("Failed to copy path to clipboard:", error);
			setError(`Failed to copy path: ${error}`);
		}
	};

	const handleCopyFileImage = async (file: FileEntry) => {
		setOpenMenu(null);
		try {
			await copyImageUrlToClipboard(await resolveImageDisplayUrl(file));
			setMessage("Image copied");
		} catch (error) {
			console.error("Failed to copy image to clipboard:", error);
			setError(`Failed to copy image: ${error}`);
		}
	};

	// Computed once per render so both the fixed sidebar header and the scrollable list below
	// it can share the same grouping — previously this was recomputed inside an IIFE local to
	// just the list, which the header (now pulled out so it can stay fixed) couldn't reach.
	// Every real folder is kept (even ones with zero files in the active category) so it stays
	// visible — and usable as a create-subfolder/move/drop target — regardless of which file-type
	// tab happens to be open. Sorted lexicographically on the relative-path key, which conveniently
	// also sorts every folder after its own parent ("Workshops" before "Workshops/Papers") and
	// puts the root ("") first, so this doubles as the hierarchical display order.
	// Clicking a folder's name loads its files as a thumbnail grid in the main board (gallery
	// categories only - the audio tab has no gallery view yet). Mid-edit that would swap the
	// editor out from under the user, so it asks first. Collapsing is the caret's job alone.
	const openFolderGallery = async (folder: string): Promise<void> => {
		if (!GALLERY_CATEGORIES.includes(activeFileCategory)) return;
		if (editingVideoRef.current) {
			const proceed = await ask(`You are about to open the folder "${folderDisplayName(folder)}". The video you're editing will be closed.`, {
				title: "Open folder?",
				kind: "warning",
				okLabel: "Open",
				cancelLabel: "Close",
			});
			if (!proceed) return;
		}
		const somethingOpen = selectedFile !== null || !!boardScreen || !!docsScreen || !!whiteboardScreen || !!videoEditorScreen;
		if (somethingOpen) {
			const prev = { selectedFile, boardScreen, docsScreen, whiteboardScreen, videoEditorScreen, dockerMode };
			const label = prev.selectedFile
				? `${editingVideoRef.current ? "editing " : ""}${truncateFileName(prev.selectedFile.name)}`
				: prev.docsScreen
				? "your document"
				: prev.whiteboardScreen
				? "your whiteboard"
				: prev.boardScreen
				? "your board"
				: "the video editor";
			setReturnPoint({
				label,
				restore: () => {
					setSelectedFolder(null);
					setBoardScreen(prev.boardScreen);
					setDocsScreen(prev.docsScreen);
					setWhiteboardScreen(prev.whiteboardScreen);
					setVideoEditorScreen(prev.videoEditorScreen);
					setSelectedFile(prev.selectedFile);
					setDockerMode(prev.dockerMode);
					setReturnPoint(null);
				},
			});
		} else if (selectedFolder === null) {
			setReturnPoint(null);
		}
		setSelectedFolder(folder);
		setSelectedFile(null);
		setBoardScreen(null);
		setDocsScreen(null);
		setWhiteboardScreen(null);
		// The main board is about to show this folder's gallery, so no tool screen can still be
		// the thing on it.
		setVideoEditorScreen(null);
	};
	const normalizedSearchQuery = fileSearchQuery.trim().toLowerCase();
	const isSearchingFiles = normalizedSearchQuery.length > 0;
	// Search also matches folder names: a folder whose path matches shows all of its files (and
	// stays listed even if it holds none in this tab), otherwise only files whose name matches.
	const filteredEntries = useMemo(() => orderFolders(Object.entries(files)
		.map(([folder, fileList]) => {
			const folderMatches = folderMatchesQuery(folder, normalizedSearchQuery);
			return [
				folder,
				sortFileList(
					fileList.filter(
						(file) =>
							getFileCategory(file.name) === activeFileCategory &&
							(!isSearchingFiles || folderMatches || file.name.toLowerCase().includes(normalizedSearchQuery))
					),
						folder
				),
				folderMatches,
			] as [string, FileEntry[], boolean];
		})
		// A folder with zero matches is only worth hiding while actively searching - normally
		// every real folder stays visible (even empty ones, per this file's own comment above)
		// so it's still usable as a create-subfolder/move/drop target. hideEmptyFolders is the
		// opt-in exception: user has explicitly asked to declutter, so folders with nothing in
		// the active category are dropped too (root exempted - it's never hidden).
		.filter(([, fileList, folderMatches]) => !isSearchingFiles || fileList.length > 0 || folderMatches)
		.filter(([folder, fileList]) => !hideEmptyFolders || fileList.length > 0 || folder === "")
		.map(([folder, fileList]) => [folder, fileList] as [string, FileEntry[]]),
		// Pinned folders (and what's inside them) first, then the usual path order.
		pinnedFolders),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[files, normalizedSearchQuery, activeFileCategory, hideEmptyFolders, pinnedFolders, fileSortMode, folderSorts]);
	// Folders the search is leaving out (of those this tab would otherwise list).
	const hiddenBySearch = useMemo(
		() =>
			isSearchingFiles
				? Object.entries(files).filter(([folder, list]) => !hideEmptyFolders || folder === "" || list.some((f) => getFileCategory(f.name) === activeFileCategory)).length - filteredEntries.length
				: 0,
		[isSearchingFiles, files, hideEmptyFolders, activeFileCategory, filteredEntries]
	);
	const isGridView = sidebarViewMode === "grid";
	const firstUnpinnedIndex = filteredEntries.findIndex(([folder]) => pinRank(folder, pinnedFolders) === -1);
	const filteredTrashItems = useMemo(
		() => (normalizedSearchQuery ? trashItems.filter((item) => item.name.toLowerCase().includes(normalizedSearchQuery)) : trashItems),
		[trashItems, normalizedSearchQuery]
	);
	const sidebarHeaderLabel =
		activeFileCategory === "trash"
			? "Trash:"
			: isSearchingFiles
			? "Search results:"
			: filteredEntries.length === 1 ? `${folderDisplayName(filteredEntries[0][0])}:` : filteredEntries.length > 1 ? "Files:" : "Briefcast:";
	const isAudioSelected = selectedFile !== null && getFileCategory(selectedFile.name) === "audio";
	// Whether the player's own prev/next buttons have anywhere to go - same list navigateAudio/
	// navigateVideo walk.
	const selectedMediaCategory = selectedFile ? getFileCategory(selectedFile.name) : null;
	const hasSiblingMedia =
		(selectedMediaCategory === "audio" || selectedMediaCategory === "video") &&
		getFlatFilesForCategory(selectedMediaCategory).length > 1;

  // The timeline (VideoTimelineDocker) is showing for the open video - see BottomDocker.
  const isEditingVideo =
    dockerMode === "file-tools" &&
    !!selectedFile &&
    getFileCategory(selectedFile.name) === "video" &&
    !boardScreen &&
    !docsScreen &&
    !whiteboardScreen &&
    !mindmapScreen &&
    videoEditorScreen?.mode !== "home";
  // Tools/Media tabs (and a docking host) whenever something wants the sidebar's Tools tab.
  const showToolsSidebar = isEditingVideo || playerSidebarOpen;
  // Its own width while editing, so opening the editor can widen it for the docked panels and
  // closing it gives the picture its room back - animated by the sidebar's width transition.
  const sidebarMode: SidebarMode = isEditingVideo ? "editing" : "browsing";
  const sidebarWidth = sidebarCollapsed ? SIDEBAR_RAIL_W : sidebarWidths[sidebarMode];
  // Picking a file type tab - the sidebar's own tabs and the folded rail's.
  const selectFileCategory = (category: FileCategory) => {
    setActiveFileCategory(category);
    setSelectedFilePaths(new Set());
    setSelectedFolder(null);
    // Mid-edit these tabs only switch which files the sidebar lists - reopening the
    // category's last file would replace the editor with it.
    if (!editingVideoRef.current && videoEditorScreen?.mode !== "editing") void restoreLastOpenedForCategory(category);
  };
  const railGroups = [
    ...(showToolsSidebar
      ? [
          [
            { key: "tools", label: "Tools", icon: <IoOptionsOutline size={18} />, active: videoSidebarTab === "tools", onSelect: () => { setVideoSidebarTab("tools"); setSidebarFolded(false); } },
            { key: "media", label: "Media", icon: <IoFolderOpenOutline size={18} />, active: videoSidebarTab === "media", onSelect: () => { setVideoSidebarTab("media"); setSidebarFolded(false); } },
          ],
        ]
      : []),
    FILE_CATEGORY_TABS.map(({ category, label, icon }) => ({
      key: category,
      label,
      icon,
      active: activeFileCategory === category && !(showToolsSidebar && videoSidebarTab === "tools"),
      onSelect: () => {
        if (showToolsSidebar) setVideoSidebarTab("media");
        selectFileCategory(category);
        setSidebarFolded(false);
      },
    })),
  ];
  // Ctrl+\ folds the sidebar to its rail and back (opening it first if it's hidden). Not while
  // typing - and not Ctrl+B, which is bold in Docs and the text tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key !== "\\") return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      if (!showFileList) {
        setShowFileList(true);
        setSidebarFolded(false);
        return;
      }
      setSidebarCollapsed((prev) => {
        saveSidebarCollapsed(!prev);
        return !prev;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFileList]);

  // The "Back to …" button for whatever VideoPlayer is showing - rendered at the left end of its
  // control bar (fading with it) rather than as a row above the picture.
  const playerBackButtonClass =
    "flex items-center gap-1 min-w-0 max-w-full px-2 py-1 rounded-md bg-white/10 hover:bg-white/20 text-xs font-medium text-white whitespace-nowrap transition-colors";
  // Just "Back" - the title says where to (video editor / which folder) on hover. Drops to the
  // bare chevron once the player is very narrow (VideoPlayer's `player` size container).
  const playerBackLabelClass = "@max-[520px]/player:hidden";
  const playerBackButton =
    videoEditorScreen?.mode === "editing" ? (
      <button type="button" title="Back to video editor" className={playerBackButtonClass} onClick={() => { setSelectedFile(null); setVideoEditorScreen({ mode: "home" }); }}>
        <IoChevronBack size={12} className="shrink-0" />
        <span className={playerBackLabelClass}>Back</span>
      </button>
    ) : selectedFolder !== null ? (
      <button type="button" title={`Back to ${folderDisplayName(selectedFolder)}`} className={playerBackButtonClass} onClick={() => setSelectedFile(null)}>
        <IoChevronBack size={12} className="shrink-0" />
        <span className={playerBackLabelClass}>Back</span>
      </button>
    ) : undefined;

  // The sidebar file tree's actions - stable, so the memoized tree skips re-rendering when nothing
  // it shows changed (SidebarFileTree), yet always the latest.
  const sidebarTreeActions = useStableCallbacks({
    addMediaToVideo,
    cancelRename,
    categoryIcon,
    categoryIconColorClassName,
    commitCreateFolder,
    commitRename,
    filesToActOn,
    folderDepth,
    folderDisplayName,
    handleAddFilesToBoard,
    handleCopyFileImage,
    handleCopyFilePath,
    handleDeleteFile,
    handleDeleteFolder,
    handleDeleteForever,
    handleEmptyTrash,
    handleLinkNotes,
    handleMoveFiles,
    handleMoveFolder,
    handleRestoreFromTrash,
    handleSetThumbnail,
    handleSidebarFilePointerDown,
    handleSidebarFilePointerMove,
    handleSidebarFilePointerUp,
    handleTogglePin,
    isFolderEmpty,
    isSidebarDragging: () => !!sidebarDragRef.current?.isDragging,
    openFolderGallery,
    refreshDocsIndex,
    resolveImageThumbnailUrl,
    resolveVideoThumbnailUrl,
    startCreateFolder,
    startRename,
    toggleFileSelected,
    setAddMenuFor,
    setConversionFile,
    setCreatingFolderIn,
    setDocsScreen,
    setDraggingFiles,
    setDraggingFolder,
    setDragOverFolder,
    setError,
    setFolderMoveMenu,
    setInfoFile,
    setInfoTrashItem,
    setLinkDocsMenuOpenFor,
    setNewFolderValue,
    setOpenMenu,
    setPinnedFolders,
    setSelectedFile,
    setTransferMenu,
  });

  return (
    <ItemLinksProvider files={allLibraryFiles} onOpen={openLinkedItem}>
    <ToolPanelHostContext.Provider value={showToolsSidebar ? toolPanelHostEl : null}>
    <ToolPanelOpenContext.Provider value={isEditingVideo ? openToolsPanel : null}>
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
            ref={sidebarRef}
            // No width transition while it's being dragged - the edge must stay under the pointer.
            className={`relative shrink-0 h-screen bg-neutral-50 dark:bg-neutral-900 border-b border-gray-300 dark:border-neutral-700 overflow-hidden ${
              resizingSidebar ? "" : "transition-[width,opacity] duration-150 ease-out"
            } ${showFileList && !isPdfFullscreen ? "opacity-100" : "w-0 opacity-0"}`}
            style={showFileList && !isPdfFullscreen ? { width: sidebarWidth } : undefined}
          >
            {showFileList && !isPdfFullscreen && (
              <SidebarResizeHandle
                sidebarRef={sidebarRef}
                width={sidebarWidths[sidebarMode]}
                collapsed={sidebarCollapsed}
                onResizingChange={setResizingSidebar}
                onCollapsedChange={setSidebarCollapsed}
                onCommit={(w, collapsed) => {
                  setSidebarFolded(collapsed);
                  if (!collapsed) setSidebarWidths((prev) => ({ ...prev, [sidebarMode]: saveSidebarWidth(sidebarMode, w) }));
                }}
              />
            )}
            {showFileList && !isPdfFullscreen && sidebarCollapsed && <SidebarRail groups={railGroups} onExpand={() => setSidebarFolded(false)} />}
            {showFileList && !isPdfFullscreen && !sidebarCollapsed && (
              <div
                className="flex flex-col h-full"
                style={!resizingSidebar ? { width: sidebarWidths[sidebarMode], minWidth: sidebarWidths[sidebarMode] } : undefined}
              >
                {showToolsSidebar && (
                  <div className="flex items-center gap-1 p-2 border-b border-gray-300 dark:border-neutral-700 shrink-0">
                    {([
                      { tab: "tools", label: "Tools", icon: <IoOptionsOutline size={15} /> },
                      { tab: "media", label: "Media", icon: <IoFolderOpenOutline size={15} /> },
                    ] as const).map(({ tab, label, icon }) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setVideoSidebarTab(tab)}
                        className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                          videoSidebarTab === tab
                            ? "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10"
                            : "text-gray-500 dark:text-neutral-400 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
                        }`}
                      >
                        {icon}
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {/* Tools tab - the timeline's settings popovers portal into the host div below
                    (ToolPanelHost.tsx). Kept mounted (just hidden) on the Media tab so an open
                    panel isn't torn down, and so a panel opening there can flip back to it. */}
                {showToolsSidebar && (
                  <div
                    className={`flex-1 min-h-0 overflow-y-auto overscroll-contain p-3 pb-[var(--docker-height,64px)] ${
                      videoSidebarTab === "tools" ? "" : "hidden"
                    }`}
                  >
                    <div ref={setToolPanelHostEl} className="peer flex flex-col gap-3" />
                    <div className="hidden peer-empty:flex flex-col items-center text-center gap-2 px-4 pt-10 text-neutral-500 dark:text-neutral-400">
                      <IoOptionsOutline size={28} className="text-neutral-300 dark:text-neutral-600" />
                      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300">No tool selected</p>
                      <p className="text-xs leading-relaxed">
                        Select a clip on the timeline, then choose Effects, Speed or Reduce noise from the toolbar - or click an audio clip - to adjust it here.
                      </p>
                    </div>
                  </div>
                )}
                <div className={`flex flex-col flex-1 min-h-0 ${showToolsSidebar && videoSidebarTab === "tools" ? "hidden" : ""}`}>
                <SidebarHeader
                  activeFileCategory={activeFileCategory}
                  selectFileCategory={selectFileCategory}
                  handleOpenTrash={handleOpenTrash}
                  fileSearchQuery={fileSearchQuery}
                  setFileSearchQuery={setFileSearchQuery}
                  isSearchingFiles={isSearchingFiles}
                  hiddenBySearch={hiddenBySearch}
                  sidebarHeaderLabel={sidebarHeaderLabel}
                  isRefreshingFiles={isRefreshingFiles}
                  handleRefreshFiles={handleRefreshFiles}
                  startCreateFolder={startCreateFolder}
                  hideEmptyFolders={hideEmptyFolders}
                  setHideEmptyFolders={setHideEmptyFolders}
                  fileSortMode={fileSortMode}
                  setFileSortMode={setFileSortMode}
                  isGridView={isGridView}
                  setSidebarViewMode={setSidebarViewMode}
                  selectedFile={selectedFile}
                  isImageFileSelected={isImageFileSelected}
                  audioRepeatMode={audioRepeatMode}
                  cycleAudioRepeatMode={cycleAudioRepeatMode}
                  audioShuffle={audioShuffle}
                  setAudioShuffle={setAudioShuffle}
                  audioAutoplayNext={audioAutoplayNext}
                  setAudioAutoplayNext={setAudioAutoplayNext}
                  navigateAudio={navigateAudio}
                  navigateImage={navigateImage}
                  dockerMode={dockerMode}
                  setDockerMode={setDockerMode}
                  selectedFilePaths={selectedFilePaths}
                  setSelectedFilePaths={setSelectedFilePaths}
                  getSelectedFileEntries={getSelectedFileEntries}
                  handleBulkDeleteFiles={handleBulkDeleteFiles}
                  handleAddFilesToBoard={handleAddFilesToBoard}
                  boardScreen={boardScreen}
                  setBulkConversionFiles={setBulkConversionFiles}
                  setTransferMenu={setTransferMenu}
                />

                {/* pb tracks --docker-height (published by BottomDocker's ResizeObserver, see
                    player.css for the sibling usage) so the last row can always scroll clear of
                    the fixed bottom icon bar instead of rendering underneath it, unclickable.
                    overscroll-contain stops scroll momentum at this list's own top/bottom instead
                    of chaining into whatever's behind it (the main content pane, the tools panel)
                    once you scroll past its own content - each panel should scroll on its own. */}
                <div
                  className={`px-3 ${selectedFile ? "pt-0" : "pt-3"} pb-[var(--docker-height,64px)] text-sm overflow-y-auto overscroll-contain flex-1 isolate [contain:paint] text-neutral-800 dark:text-neutral-200`}
                >
                {/* isolate + contain:paint: the grid cards' checkboxes are absolutely positioned (z-10, fading
                    opacity), which WebView2 otherwise paints unclipped once scrolled out of this list - over the
                    timeline and the bottom docker. The scroller now owns their stacking and clipping. */}
                {/* "Now open" banner - pinned to the top of this scrolling list (not the whole
                    sidebar; the search box/tabs/Files header above it never scroll away in the
                    first place) so it's always reachable no matter how deep the currently open
                    file's row has scrolled off screen in a long library. Clicking it switches to
                    that file's category tab and expands its folder if either is hiding its row
                    (see handleJumpToOpenFile), then scrolls straight to it - the file itself is
                    already visually marked once found (the existing bg-blue-50/text-blue-600
                    "currently open" row styling below), so this doesn't add a second, redundant
                    highlight on arrival. */}
                {selectedFile && (
                  <button
                    type="button"
                    onClick={handleJumpToOpenFile}
                    title={`Locate "${selectedFile.name}" in the sidebar`}
                    className="sticky top-0 z-10 -mx-3 mb-2 flex w-[calc(100%+1.5rem)] items-center gap-2 border-b border-blue-200 bg-blue-50/95 px-3 py-2 text-left backdrop-blur-sm transition-colors hover:bg-blue-100 dark:border-blue-500/30 dark:bg-blue-500/15 dark:hover:bg-blue-500/25"
                  >
                    <span className="shrink-0 text-blue-500 dark:text-blue-400">
                      {categoryIcon(getFileCategory(selectedFile.name))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="mb-0.5 block text-[10px] font-semibold uppercase leading-none tracking-wide text-blue-400 dark:text-blue-500/80">
                        Now open
                      </span>
                      <FileNameText name={selectedFile.name} className="text-xs font-medium leading-tight text-blue-700 dark:text-blue-300" />
                    </span>
                    <IoLocateOutline size={14} className="shrink-0 text-blue-400 dark:text-blue-500" />
                  </button>
                )}
                {!sidebarContentReady ? (
                  <SidebarSkeleton isGridView={isGridView} />
                ) : (
                  <SidebarFileTree
                    activeFileCategory={activeFileCategory}
                    filteredEntries={filteredEntries}
                    filteredTrashItems={filteredTrashItems}
                    firstUnpinnedIndex={firstUnpinnedIndex}
                    isSearchingFiles={isSearchingFiles}
                    fileSearchQuery={fileSearchQuery}
                    isGridView={isGridView}
                    isLoading={activeFileCategory === "trash" ? isLoadingTrash : isLoadingFiles}
                    selectedPath={selectedFile?.sourcePath}
                    selectedFolder={selectedFolder}
                    selectedFilePaths={selectedFilePaths}
                    editingVideo={editingVideoRef.current}
                    boardScreen={boardScreen}
                    pinnedFolders={pinnedFolders}
                    folderSorts={folderSorts}
                    setFolderSorts={setFolderSorts}
                    pinnedPaths={pinnedPaths}
                    linkedDocsByPath={linkedDocsByPath}
                    openMenu={openMenu}
                    addMenuFor={addMenuFor}
                    linkDocsMenuOpenFor={linkDocsMenuOpenFor}
                    renamingFile={renamingFile}
                    renameInGallery={renameInGallery}
                    creatingFolderIn={creatingFolderIn}
                    newFolderValue={newFolderValue}
                    draggingFiles={draggingFiles}
                    draggingFolder={draggingFolder}
                    dragOverFolder={dragOverFolder}
                    {...sidebarTreeActions}
                  />
                )}
                </div>
                </div>
              </div>
            )}
          </div>

          {tidyOpen && (
            <TidyLibraryDialog
              files={allLibraryFiles}
              folderOf={folderOfPath}
              // handleMoveFiles answers how many failed; the dialog wants how many moved.
              onMove={async (list, folder) => list.length - (await handleMoveFiles(list, folder, true))}
              onDone={() => void handleDirectoryFiles()}
              onClose={() => setTidyOpen(false)}
            />
          )}

          {infoTrashItem && (
            <FileInfoModal
              item={{ kind: "trash", id: infoTrashItem.trashed_name }}
              fileName={infoTrashItem.name}
              onClose={() => setInfoTrashItem(null)}
            />
          )}

          {folderMoveMenu && (
            <>
              <div className="fixed inset-0 z-40" onPointerDown={() => setFolderMoveMenu(null)} />
              <div
                style={{ left: Math.max(8, Math.min(folderMoveMenu.anchor.left - 180, window.innerWidth - 248)), top: Math.min(folderMoveMenu.anchor.top, window.innerHeight - 300) }}
                className="fixed z-50 w-60 max-h-72 overflow-y-auto rounded-xl bg-white/95 dark:bg-neutral-800/95 backdrop-blur-md border border-gray-200/80 dark:border-neutral-700/80 shadow-xl ring-1 ring-black/5 py-1 text-sm text-neutral-700 dark:text-neutral-200"
              >
                <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500 truncate">
                  Move "{folderDisplayName(folderMoveMenu.folder)}" to
                </div>
                {Object.keys(files)
                  .sort((a, b) => a.localeCompare(b))
                  .filter((dest) => canMoveFolder(folderMoveMenu.folder, dest) && !(movedFolderKey(folderMoveMenu.folder, dest) in files))
                  .map((dest) => (
                    <button
                      key={dest || "__root"}
                      type="button"
                      onClick={() => void handleMoveFolder(folderMoveMenu.folder, dest)}
                      className="w-full flex items-center gap-2 pr-3 py-1.5 text-left hover:bg-gray-100 dark:hover:bg-neutral-700/70 transition-colors"
                      style={{ paddingLeft: 12 + folderDepth(dest) * 12 }}
                    >
                      <IoFolderOutline size={14} className="shrink-0 text-neutral-400 dark:text-neutral-500" />
                      <span className="truncate">{dest === "" ? "Briefcast (top level)" : folderDisplayName(dest)}</span>
                    </button>
                  ))}
              </div>
            </>
          )}
          {transferMenu && (
            <MoveCopyMenu files={transferMenu.files} options={fileTransferOptions} anchor={transferMenu.anchor} onClose={() => setTransferMenu(null)} />
          )}

          {infoFile && (
            <FileInfoModal
              filePath={infoFile.path}
              fileName={infoFile.name}
              onClose={() => setInfoFile(null)}
            />
          )}

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
                  setWhiteboardScreen(null);
                  // Same stay-in-the-editor-only-for-videos rule loadFileForPlayback applies.
                  setVideoEditorScreen((prev) => (prev && getFileCategory(newFileName) === "video" ? { mode: "editing" } : null));
                } catch (error) {
                  console.error('Error loading converted file:', error);
                }
              }}
            />
          )}

          {/* Bulk Conversion Dialog */}
          {bulkConversionFiles && (
            <BulkConversionDialog
              files={bulkConversionFiles}
              onClose={() => setBulkConversionFiles(null)}
              onDone={async (summary: BulkConversionSummary) => {
                setBulkConversionFiles(null);
                setSelectedFilePaths(new Set());
                await handleDirectoryFiles();
                setMessage(
                  summary.failedCount > 0
                    ? `Converted ${summary.converted.length} file${summary.converted.length === 1 ? "" : "s"}, ${summary.failedCount} failed`
                    : `Converted ${summary.converted.length} file${summary.converted.length === 1 ? "" : "s"}`
                );
              }}
            />
          )}
         <div className="relative flex-1 min-w-0 min-h-0 flex flex-col bg-gray-100 dark:bg-neutral-950">

          {/* selectedFolder !== null, not a truthy check - the root ("Briefcast") folder's key is
              "", which is falsy in JS even though it's a perfectly valid, currently-selected
              folder. A truthy check here silently treated selecting the root folder as "nothing
              selected" (observed directly: clicking it fell through to the empty state instead of
              showing a gallery). Same fix applies to the two ternary branches below.

              A real row above the viewer, not an absolute overlay on top of it - it used to float
              at top-3 left-3 directly over whatever the active viewer rendered there, which for
              ImageEditor/PdfAnnotator is that viewer's own persistent header (also flush top-left:
              a tools-toggle icon then the filename) - the two sat in the exact same few pixels, so
              this button visually swallowed the icon and the start of the filename (observed
              directly: only the filename's tail end still peeked out past this button's right
              edge). Stacking it as its own shrink-0 row instead means every viewer's own header,
              image/pdf included, renders in the space actually left for it. */}
          {/* Video/audio files (VideoPlayer) carry their "Back to …" button inside the player's own
              control bar instead (playerBackButton below), so the picture gets this row's height
              back - this row is only for the image/pdf/document viewers. */}
          {selectedFolder !== null && selectedFile && !isMediaFileSelected && !boardScreen && !docsScreen && (
            <div className="shrink-0 px-3 pt-3">
              <button
                type="button"
                onClick={() => setSelectedFile(null)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-md bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-gray-200 dark:border-neutral-800 text-sm text-gray-700 dark:text-neutral-200 hover:border-blue-400 dark:hover:border-blue-500 shadow-sm"
              >
                <IoChevronBack size={14} />
                Back to {folderDisplayName(selectedFolder)}
              </button>
            </div>
          )}

          {/* Folder gallery on screen after leaving something open: one click back to it. */}
          {selectedFolder !== null && !selectedFile && !boardScreen && !docsScreen && !whiteboardScreen && !videoEditorScreen && returnPoint && (
            <div className="shrink-0 px-3 pt-3">
              <button
                type="button"
                onClick={returnPoint.restore}
                title={`Go back to ${returnPoint.label}`}
                className="flex items-center gap-1 pl-2 pr-3 py-1 rounded-full bg-white/90 dark:bg-neutral-900/90 border border-gray-200 dark:border-neutral-800 text-xs font-medium text-gray-700 dark:text-neutral-200 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 shadow-sm transition-colors"
              >
                <IoArrowUndoOutline size={13} />
                Back to {returnPoint.label}
              </button>
            </div>
          )}

          <div className="relative flex-1 min-w-0 min-h-0 flex items-center justify-center">
          {isNewVideoProjectOpen && (
            <NewVideoProjectDialog
              libraryImages={libraryImageClipFiles}
              libraryVideos={libraryClipVideoFiles}
              resolveThumbnailUrl={resolveImageThumbnailUrl}
              resolveVideoThumbnailUrl={resolveVideoThumbnailUrl}
              onCreate={handleCreateVideoProject}
              onClose={() => setIsNewVideoProjectOpen(false)}
            />
          )}
          {videoEditorScreen?.mode === "home" ? (
            <VideoEditorHome
              videos={libraryVideoFiles}
              recentPaths={recentPaths}
              resolveThumbnailUrl={resolveVideoThumbnailUrl}
              onOpenVideo={(file, intent) => void handleOpenVideoInEditor(file, intent)}
              onOpenExternalVideo={(intent) => void handleOpenExternalVideoForEditing(intent)}
              onCreateVideo={() => setIsNewVideoProjectOpen(true)}
              onSendToPhone={openPhoneTransfer}
              externalDrag={editorHomeDrag}
              droppedPaths={editorHomeDrop}
              onTidyUp={() => setTidyOpen(true)}
            />
          ) : mindmapScreen ? (
            <ErrorBoundary
              key={mindmapScreen.mode === "editor" ? `mm-editor-${mindmapScreen.mindmapId}` : "mm-home"}
              fallbackTitle="This mindmap ran into a problem"
              onReset={() => setMindmapScreen({ mode: "home" })}
            >
              <MindmapWorkspace screen={mindmapScreen} onScreenChange={setMindmapScreen} />
            </ErrorBoundary>
          ) : whiteboardScreen ? (
            <ErrorBoundary
              key={whiteboardScreen.mode === "editor" ? `editor-${whiteboardScreen.whiteboardId}` : "home"}
              fallbackTitle="This whiteboard ran into a problem"
              onReset={() => setWhiteboardScreen({ mode: "home" })}
            >
              <WhiteboardWorkspace screen={whiteboardScreen} onScreenChange={setWhiteboardScreen} />
            </ErrorBoundary>
          ) : boardScreen ? (
            <BoardWorkspace ref={boardEditorRef} screen={boardScreen} onScreenChange={setBoardScreen} libraryDraggingFiles={draggingFiles} />
          ) : docsScreen ? (
            <ErrorBoundary
              key={docsScreen.mode === "editor" ? `editor-${docsScreen.docId}` : "home"}
              fallbackTitle="This document ran into a problem"
              onReset={() => setDocsScreen({ mode: "home" })}
            >
              <DocsWorkspace
                screen={docsScreen}
                onScreenChange={setDocsScreen}
                libraryFiles={allLibraryFiles}
                onOpenLinkedFile={(path, name) => {
                  setDocsScreen(null);
                  void loadFileForPlayback(path, name);
                }}
              />
            </ErrorBoundary>
          ) : selectedFile ? (
            getFileCategory(selectedFile.name) === "pdf" ? (
              <PdfAnnotator
                key={selectedFile.path}
                src={selectedFile.path}
                sourcePath={selectedFile.sourcePath}
                isFullscreen={isPdfFullscreen}
                onToggleFullscreen={handleTogglePdfFullscreen}
              />
            ) : getFileCategory(selectedFile.name) === "image" ? (
              // HEIC/HEIF (iPhone's default photo format) has no Chromium/WebView2 decoder, but
              // selectedFile.path is already a silently-decoded, cached PNG for those by the time
              // it gets here (see resolveImageDisplayUrl/loadFileForPlayback) - ImageEditor never
              // has to know the source was HEIC at all.
              <ImageEditor
                key={selectedFile.path}
                sourcePath={selectedFile.sourcePath}
                title={selectedFile.name}
                onSaved={handleImageSaved}
                store={imageEditStore}
                isToolsPanelOpen={dockerMode === "file-tools"}
                onToolsPanelOpenChange={(open) => setDockerMode(open ? "file-tools" : "record")}
              />
            ) : getFileCategory(selectedFile.name) === "document" ? (
              // .docx/.md/.txt (e.g. Docs' own Export menu output) have no in-app renderer, unlike
              // pdf/image/video above - hand off to the OS's own default app rather than pretending
              // to preview them.
              <div key={selectedFile.path} className="w-full h-full flex flex-col items-center justify-center gap-3 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300">
                <MdOutlineDescription size={48} className="text-neutral-300 dark:text-neutral-600" />
                <p className="text-sm font-medium max-w-md truncate px-4">{selectedFile.name}</p>
                <p className="text-xs text-neutral-400 dark:text-neutral-500">This file type can't be previewed inside Briefcast.</p>
                <button
                  type="button"
                  onClick={() => invoke("open_file_with_default_app", { filepath: selectedFile.sourcePath }).catch((err) => setError(`Failed to open file: ${err}`))}
                  className="mt-1 px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700"
                >
                  Open with default app
                </button>
              </div>
            ) : (
              <VideoPlayer
                ref={videoPlayerRef}
                key={selectedFile.path}
                src={selectedFile.path}
                filePath={selectedFile.sourcePath}
                title={selectedFile.name}
                autoPlay={true}
                initialTime={getResumeTime(selectedFile.sourcePath)}
                loop={isAudioSelected && audioRepeatMode === "one"}
                onTimeUpdate={(time) => {
                  handleMediaTimeUpdate(time);
                  if (!previewSwitchPendingRef.current && !handoffRef.current?.isActive()) setPlayerCurrentTime(time);
                }}
                onPlayStateChange={setPlayerIsPlaying}
                onEnded={handleMediaEnded}
                onPrevious={hasSiblingMedia ? () => (isAudioSelected ? navigateAudio(-1) : navigateVideo(-1)) : undefined}
                onNext={hasSiblingMedia ? () => (isAudioSelected ? navigateAudio(1) : navigateVideo(1)) : undefined}
                autoplayNext={isAudioSelected ? audioAutoplayNext : videoAutoplayNext}
                onEditVideo={
                  getFileCategory(selectedFile.name) === "video"
                    ? () => {
                        if (dockerMode === "file-tools") return setDockerMode("record");
                        setDockerMode("file-tools");
                        window.dispatchEvent(new Event(SHOW_DOCKER_EVENT));
                      }
                    : undefined
                }
                isEditingVideo={dockerMode === "file-tools"}
                editTimeline={playerEditTimeline}
                onAutoplayNextChange={() =>
                  isAudioSelected ? setAudioAutoplayNext((prev) => !prev) : setVideoAutoplayNext((prev) => !prev)
                }
                overlay={
                  getFileCategory(selectedFile.name) === "video"
                    ? (fullFrame) => {
                        // With a Screen Style the edited picture - and every layer placed on it - is laid
                        // out in the frame's content rectangle with the wallpaper around it; only the
                        // shortcut chips and captions sit on the whole frame, as export composites them.
                        const inset = screenContentInset;
                        const frameRect = inset
                          ? { left: fullFrame.left + inset.x * fullFrame.width, top: fullFrame.top + inset.y * fullFrame.height, width: inset.width * fullFrame.width, height: inset.height * fullFrame.height }
                          : fullFrame;
                        const contentBox = { left: (inset?.x ?? 0) * fullFrame.width, top: (inset?.y ?? 0) * fullFrame.height, width: frameRect.width, height: frameRect.height };
                        // Pictures and text: on the picture, or - with a Screen Style - over the frame
                        // around it, laid out on the picture still but free to sit on the padding
                        // (export composites them after the frame too, prepareExport's onFrame).
                        const overlayLayer = (
                        <VideoOverlayLayer
                          frameRect={frameRect}
                          overlays={editStore.textOverlays}
                          imageOverlays={editStore.imageOverlays}
                          currentOutputTime={currentOutputTime}
                          selectedOverlayId={selectedOverlayId}
                          onSelectOverlay={setSelectedOverlayId}
                          selectedImageOverlayId={selectedImageOverlayId}
                          onSelectImageOverlay={setSelectedImageOverlayId}
                          isPlaying={playerIsPlaying}
                          isPlacingText={isPlacingText}
                          onPlacementConsumed={() => setIsPlacingText(false)}
                          onAddTextOverlay={editStore.addTextOverlay}
                          onUpdateTextOverlayContent={(id, patch) => editStore.updateTextOverlayContent(id, keyframeAwarePatch(editStore.textOverlays.find((o) => o.id === id), patch))}
                          getOutputTime={getExactOutputTime}
                          onDeleteTextOverlay={editStore.deleteTextOverlay}
                          onDuplicateTextOverlay={(id) => setSelectedOverlayId(editStore.duplicateTextOverlay(id))}
                          onBringTextOverlayToFront={editStore.bringTextOverlayToFront}
                          onSendTextOverlayToBack={editStore.sendTextOverlayToBack}
                          isPlacingImage={isPlacingImage}
                          onPlacementImageConsumed={() => setIsPlacingImage(false)}
                          onAddImageOverlay={editStore.addImageOverlay}
                          onUpdateImageOverlayContent={(id, patch) => editStore.updateImageOverlayContent(id, keyframeAwarePatch(editStore.imageOverlays.find((o) => o.id === id), patch))}
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
                          onSetOverlayTime={(kind, id, edge, time) => {
                            const clamped = Math.max(0, Math.min(totalOutputDuration, time));
                            if (kind === "text") editStore.resizeTextOverlayTime(id, edge, clamped);
                            else if (kind === "image") editStore.resizeImageOverlayTime(id, edge, clamped);
                            else editStore.resizeBlurOverlayTime(id, edge, clamped);
                          }}
                          onTrackMotion={startMotionTrack}
                          totalOutputDuration={totalOutputDuration}
                          placeBounds={inset ? { x0: -inset.x / inset.width, y0: -inset.y / inset.height, x1: (1 - inset.x) / inset.width, y1: (1 - inset.y) / inset.height } : undefined}
                        />
                        );
                        return (
                        <>
                          <div className="absolute pointer-events-none" style={contentBox}>
                          {/* A project that is only sound: its live waveform over the blank picture. */}
                          {isVideoProjectPath(selectedFile.sourcePath) && editStore.clips.length === 0 && editStore.audioOverlays.length > 0 && (
                            <AudioOnlyStage audioOverlays={editStore.audioOverlays} isPlaying={playerIsPlaying} currentOutputTime={currentOutputTime} />
                          )}
                          {/* The next clip, covering the player while it switches to it. Under
                              the transition preview, which draws the outgoing clip over it. */}
                          <ClipHandoffLayer
                            frameRect={frameRect}
                            clips={editStore.playbackClips}
                            activeClipId={activeClipEffects?.id ?? null}
                            apiRef={handoffRef}
                            resolveClipUrl={resolveTimelineClipUrl}
                            getMainState={getMainPlaybackState}
                            isMainSwitching={isMainSwitching}
                            seekMain={seekMainPlayer}
                            onTime={setPlayerCurrentTime}
                          />
                          {/* The clip's effect (echo, RGB split...) over its picture (clipFx.ts). */}
                          <ClipFxLayer
                            frameRect={frameRect}
                            clips={editStore.clips}
                            activeClipId={activeClipEffects?.id ?? null}
                            getPlaybackState={getPlayerPlaybackState}
                            getVideoElement={getMainVideoElement}
                          />
                          {/* The recorded pointer, drawn on the clip's own picture (pointerTrack.ts). */}
                          <PointerLayer
                            frameRect={frameRect}
                            clips={editStore.clips}
                            activeClipId={activeClipEffects?.id ?? null}
                            recordings={clipRecordings}
                            style={pointerStyle}
                            frame={projectFrame}
                            getPlaybackState={getPlayerPlaybackState}
                          />
                          {/* First, so it sits under every overlay - export composites the
                              transition into the base video before any overlay too. */}
                          <TransitionPreviewLayer
                            frameRect={frameRect}
                            clips={editStore.clips}
                            activeClipId={activeClipEffects?.id ?? null}
                            getPlaybackState={getPlayerPlaybackState}
                            getVideoElement={getMainVideoElement}
                            resolveClipUrl={resolveTimelineClipUrl}
                          />
                          {/* Adjustment layers on the video itself - beneath blur regions and every
                              overlay, where export applies them. */}
                          <AdjustmentLayersLayer mode="under" frameRect={frameRect} layers={editStore.adjustmentLayers} currentOutputTime={currentOutputTime} getOutputTime={getExactOutputTime} />
                          {reframePreview && <ReframePreviewLayer preview={reframePreview} getOutputTime={getExactOutputTime} fallbackTime={currentOutputTime} />}
                          {/* Video tracks (PiP, B-roll) straight on the video - under blur regions,
                              pictures and text, where export composites them (videoTracks.ts). */}
                          <PipOverlayLayer
                            frameRect={frameRect}
                            pipOverlays={editStore.pipOverlays}
                            currentOutputTime={currentOutputTime}
                            totalOutputDuration={totalOutputDuration}
                            isPlaying={playerIsPlaying}
                            selectedPipOverlayId={selectedPipOverlayId}
                            onSelectPipOverlay={setSelectedPipOverlayId}
                            isPlacingPip={isPlacingPip}
                            onPlacementPipConsumed={() => setIsPlacingPip(false)}
                            onAddPipOverlay={editStore.addPipOverlay}
                            onUpdatePipOverlayContent={editStore.updatePipOverlayContent}
                            onDeletePipOverlay={editStore.deletePipOverlay}
                            getOutputTime={getExactOutputTime}
                            hiddenTracks={editStore.hiddenVideoTracks}
                            panelRequest={pipPanelRequest}
                          />
                          {/* Stage scenes over the video and its tracks, beneath blur regions,
                              pictures and text - where export composites them. */}
                          {editStore.scenes.length > 0 && (
                            <StageLayer mode="render" frameRect={frameRect} scenes={editStore.scenes} currentOutputTime={currentOutputTime} getOutputTime={getExactOutputTime} isPlaying={playerIsPlaying} />
                          )}
                          {!inset && overlayLayer}
                        <AdjustmentLayersLayer mode="over" frameRect={frameRect} layers={editStore.adjustmentLayers} currentOutputTime={currentOutputTime} getOutputTime={getExactOutputTime} />
                        </div>
                        {/* The frame around the edited picture, then what sits on the frame itself. */}
                        {editStore.screenStyle && projectFrame && <ScreenBackdropLayer style={editStore.screenStyle} frame={projectFrame} />}
                        {inset && (
                          <div className="absolute pointer-events-none" style={contentBox}>
                            {overlayLayer}
                          </div>
                        )}
                        <KeystrokeLayer frameRect={fullFrame} chips={keyChips} style={keystrokeStyle} getOutputTime={getExactOutputTime} fallbackTime={currentOutputTime} />
                        {/* The canvas as the phone's screen - its corners, camera and app areas (guides only). */}
                        {editStore.canvas && phonePreview && <PhonePreviewLayer canvas={editStore.canvas} width={fullFrame.width} height={fullFrame.height} isPlaying={playerIsPlaying} />}
                        {/* Rearranging the selected layer's split screen, right over the picture. */}
                        {selectedSplit && !playerIsPlaying && (
                          <div className="absolute left-0 right-0 flex justify-center pointer-events-none" style={{ top: Math.max(6, fullFrame.height * 0.055), zIndex: 70 }}>
                            <SplitArrangeBar
                              settings={selectedSplit.settings}
                              cells={selectedSplit.cells}
                              frameAspect={frameRect.width / Math.max(1, frameRect.height)}
                              onChange={(change) => editStore.updateSplitGroup({ group: selectedSplit.group, ...change }, frameRect.width / Math.max(1, frameRect.height))}
                              onEdit={() => window.dispatchEvent(new CustomEvent("briefcast:edit-split", { detail: { group: selectedSplit.group } }))}
                            />
                          </div>
                        )}
                        {/* Above PiP and every other overlay - same stacking as the export, where the
                            captions are the last video stage (export_trimmed_video). */}
                        {editStore.captions?.settings.enabled && captionLines.length > 0 && (
                          <CaptionOverlayLayer
                            frameRect={fullFrame}
                            lines={captionLines}
                            settings={editStore.captions.settings}
                            currentOutputTime={currentOutputTime}
                            isPlaying={playerIsPlaying}
                            clipSpeed={activeClipEffects?.speed ?? 1}
                          />
                        )}
                        {/* Tools that work on the picture itself, laid out with it. */}
                        <div className="absolute pointer-events-none" style={contentBox}>
                        {isFinding && (
                          <FindHideTool
                            frameRect={frameRect}
                            status={findStatus}
                            onFind={(target, effect, shape, sensitivity, anchorTime, person) => void runFindAndHide(target, effect, shape, sensitivity, anchorTime, person)}
                            onProbe={probeOutline}
                            faceMatching={faceMatching}
                            getTime={getExactOutputTime}
                            currentTime={currentOutputTime}
                            onDrawStart={() => {
                              if (videoPlayerRef.current?.getPlaybackState()?.paused === false) videoPlayerRef.current.togglePlay();
                            }}
                            onCancelSearch={() => {
                              if (findStatus.phase === "downloading") void cancelFaceMatchingDownload();
                              if (findJobRef.current) void cancelFind(findJobRef.current);
                              findJobRef.current = null;
                              setFindStatus({ phase: "idle" });
                            }}
                            onClose={() => {
                              if (findJobRef.current) void cancelFind(findJobRef.current);
                              findJobRef.current = null;
                              setIsFinding(false);
                            }}
                          />
                        )}
                        {isMarkingBubble && (
                          <WebcamBubbleMarker
                            frameRect={frameRect}
                            sourcePath={activeClipEffects?.sourcePath ?? selectedFile.sourcePath}
                            onConfirm={(region) => handleBubbleMarked(activeClipEffects?.sourcePath ?? selectedFile.sourcePath, region)}
                            onCancel={() => setIsMarkingBubble(false)}
                          />
                        )}
                        <StageLayer
                          mode="controls"
                          frameRect={frameRect}
                          scenes={editStore.scenes}
                          currentOutputTime={currentOutputTime}
                          getOutputTime={getExactOutputTime}
                          selectedSceneId={selectedSceneId}
                          onSelectScene={selectScene}
                          onUpdateScene={editStore.updateScene}
                          onDeleteScene={editStore.deleteScene}
                          onDuplicateScene={(id) => selectScene(editStore.duplicateScene(id))}
                          onSeek={(t) => {
                            if (videoPlayerRef.current?.getPlaybackState()?.paused === false) videoPlayerRef.current.togglePlay();
                            seekPlaybackTime(t);
                          }}
                        />
                        <AdjustmentLayersLayer
                          mode="controls"
                          frameRect={frameRect}
                          layers={editStore.adjustmentLayers}
                          currentOutputTime={currentOutputTime}
                          selectedId={selectedAdjustmentId}
                          onSelect={selectAdjustment}
                          onUpdate={editStore.updateAdjustmentLayer}
                          onSetTime={(id, edge, time) => editStore.resizeAdjustmentLayerTime(id, edge, Math.max(0, Math.min(totalOutputDuration, time)))}
                          onDuplicate={(id) => selectAdjustment(editStore.duplicateAdjustmentLayer(id))}
                          onDelete={editStore.deleteAdjustmentLayer}
                          onTrackMotion={(id) => startMotionTrack("adjustment", id)}
                        />
                        {trackSession && (
                          <TrackTargetPicker
                            key={`${trackSession.kind}:${trackSession.id}`}
                            frameRect={frameRect}
                            initial={trackSession.initial}
                            canFollowScale={trackSession.kind !== "blur" && trackSession.kind !== "adjustment"}
                            tracking={trackSession.tracking}
                            error={trackSession.error}
                            onTrack={(target, followScale) => void runMotionTrack(target, followScale)}
                            onCancel={cancelMotionTrack}
                          />
                        )}
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
                        </div>
                      </>
                        );
                      }
                    : undefined
                }
                contentInset={screenContentInset}
                controlsLeading={
                  <div className="flex items-center gap-1.5 min-w-0">
                    {playerBackButton}
                    <LinksControl self={fileRef(selectedFile.sourcePath)} title={selectedFile.name} variant="player" />
                  </div>
                }
                onSidebarPanelChange={handlePlayerSidebarPanelChange}
                trackVolume={editStore.videoAudioVolume}
                trackMuted={editStore.videoAudioMuted || !!activeClipEffects?.muted || silencedBySolo(mixerSession, VIDEO_CHANNEL)}
                trackFx={editStore.videoAudioFx}
                // The master bus in use takes every sound through it - this one included.
                meterTrack={mixerSession.open || !isNeutralMaster(editStore.master)}
                activeClipEffects={activeClipEffects}
                frameBackground={canvasBlur ? "blur" : null}
                gradeLut={activeGradeLut}
                onNoiseReductionStatusChange={setNoiseReductionStatus}
              />
            )
          ) : selectedFolder !== null && activeFileCategory === "image" ? (
            <ImageFolderGallery
              files={selectedFolderImages}
              folderLabel={folderDisplayName(selectedFolder)}
              resolveThumbnailUrl={resolveImageThumbnailUrl}
              resolveFullUrl={resolveImageDisplayUrl}
              onOpenImage={(file) => loadFileForPlayback(file.path, file.name)}
              onDeleteFile={handleDeleteFile}
              onShowInfo={(file) => setInfoFile(file)}
              onConvertFile={(file) => setConversionFile(file)}
              renamingFile={renameInGallery ? renamingFile : null}
              onStartRename={(file) => startRename(file, true)}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
              selectedFilePaths={selectedFilePaths}
              onToggleFileSelected={toggleFileSelected}
              onSelectOnly={(path) => setSelectedFilePaths(new Set([path]))}
              onSelectRange={(paths) => setSelectedFilePaths((prev) => new Set([...prev, ...paths]))}
              onClearSelection={() => setSelectedFilePaths(new Set())}
              onOpenMoveCopy={(fileList, anchor) => setTransferMenu({ files: fileList, anchor })}
              onBulkDelete={handleBulkDeleteFiles}
            />
          ) : selectedFolder !== null && activeFileCategory === "video" ? (
            <VideoFolderGallery
              files={selectedFolderVideos}
              folderLabel={folderDisplayName(selectedFolder)}
              resolveThumbnailUrl={resolveVideoThumbnailUrl}
              onOpenVideo={(file) => loadFileForPlayback(file.path, file.name)}
              onSetThumbnail={(file) => void handleSetThumbnail(file)}
              onDeleteFile={handleDeleteFile}
              onShowInfo={(file) => setInfoFile(file)}
              onConvertFile={(file) => setConversionFile(file)}
              renamingFile={renameInGallery ? renamingFile : null}
              onStartRename={(file) => startRename(file, true)}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
              selectedFilePaths={selectedFilePaths}
              onToggleFileSelected={toggleFileSelected}
              onSelectOnly={(path) => setSelectedFilePaths(new Set([path]))}
              onSelectRange={(paths) => setSelectedFilePaths((prev) => new Set([...prev, ...paths]))}
              onClearSelection={() => setSelectedFilePaths(new Set())}
              onOpenMoveCopy={(fileList, anchor) => setTransferMenu({ files: fileList, anchor })}
              onBulkDelete={handleBulkDeleteFiles}
            />
          ) : selectedFolder !== null && activeFileCategory === "pdf" ? (
            <PdfFolderGallery
              files={selectedFolderPdfs}
              folderLabel={folderDisplayName(selectedFolder)}
              resolveAssetUrl={resolvePreviewAssetUrl}
              onOpenPdf={(file) => loadFileForPlayback(file.path, file.name)}
              onDeleteFile={handleDeleteFile}
              onShowInfo={(file) => setInfoFile(file)}
              renamingFile={renameInGallery ? renamingFile : null}
              onStartRename={(file) => startRename(file, true)}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
              selectedFilePaths={selectedFilePaths}
              onToggleFileSelected={toggleFileSelected}
              onSelectOnly={(path) => setSelectedFilePaths(new Set([path]))}
              onSelectRange={(paths) => setSelectedFilePaths((prev) => new Set([...prev, ...paths]))}
              onClearSelection={() => setSelectedFilePaths(new Set())}
              onOpenMoveCopy={(fileList, anchor) => setTransferMenu({ files: fileList, anchor })}
              onBulkDelete={handleBulkDeleteFiles}
            />
          ) : selectedFolder !== null && activeFileCategory === "document" ? (
            <DocumentFolderGallery
              files={selectedFolderDocuments}
              folderLabel={folderDisplayName(selectedFolder)}
              onOpenDocument={(file) => loadFileForPlayback(file.path, file.name)}
              onDeleteFile={handleDeleteFile}
              onShowInfo={(file) => setInfoFile(file)}
              renamingFile={renameInGallery ? renamingFile : null}
              onStartRename={(file) => startRename(file, true)}
              onCommitRename={commitRename}
              onCancelRename={cancelRename}
              selectedFilePaths={selectedFilePaths}
              onToggleFileSelected={toggleFileSelected}
              onSelectOnly={(path) => setSelectedFilePaths(new Set([path]))}
              onSelectRange={(paths) => setSelectedFilePaths((prev) => new Set([...prev, ...paths]))}
              onClearSelection={() => setSelectedFilePaths(new Set())}
              onOpenMoveCopy={(fileList, anchor) => setTransferMenu({ files: fileList, anchor })}
              onBulkDelete={handleBulkDeleteFiles}
            />
          ) : (
            <div className="relative flex flex-col items-center justify-[safe_center] h-full w-full gap-6 px-8 pt-8 pb-24 overflow-y-auto overflow-x-hidden">
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

              {/* A camera-only recording captures no screen, so this otherwise-idle home area is
                  the natural place to show what the cameras are actually sending - see
                  LiveCameraRecordingView for why it's polled frames rather than a MediaStream. */}
              {isRecording && CAMERA_ONLY_RECORD_TYPES.includes(recordType) ? (
                <LiveCameraRecordingView videoDevices={videoDevices} isPaused={isPaused} />
              ) : (
              <div className="relative flex flex-col items-center gap-5 text-center w-full max-w-3xl">
                <div>
                  <p className="text-xl text-gray-800 dark:text-neutral-100 font-semibold">
                    What would you like to create today?
                  </p>
                  <p className="text-gray-500 dark:text-neutral-400 text-sm mt-1">
                    Jump into a tool, open a file from your computer, or pick up something from your library.
                  </p>
                </div>
                {/* Same tools (and icons) as the bottom dock's tool row, surfaced here with labels
                    so a first-time user can see what the app does without hovering icons. */}
                <div className="flex flex-wrap justify-center gap-2">
                  {[
                    { label: "Edit a video", icon: <IoCutOutline size={22} />, onClick: handleOpenVideoEditor },
                    { label: "Write a document", icon: <IoDocumentTextOutline size={22} />, onClick: handleOpenDocs },
                    { label: "Whiteboard", icon: <IoGitNetworkOutline size={22} />, onClick: handleOpenWhiteboard },
                    { label: "Mind map", icon: <IoMapOutline size={22} />, onClick: handleOpenMindmap },
                    { label: "Board", icon: <IoImagesOutline size={22} />, onClick: handleOpenBoard },
                    { label: "Open a file", icon: <IoFolderOpenOutline size={22} />, onClick: handleOpenExternalFile },
                  ].map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={action.onClick}
                      className="flex flex-col items-center justify-center gap-2 w-28 h-24 rounded-lg bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-gray-200 dark:border-neutral-800 text-gray-600 dark:text-neutral-300 hover:border-blue-400 dark:hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                    >
                      {action.icon}
                      <span className="text-xs font-medium">{action.label}</span>
                    </button>
                  ))}
                </div>
              </div>
              )}

              {homeItems.length > 0 && (
                <div className="relative w-full max-w-md">
                  <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-2 text-center">
                    From your library
                  </p>
                  <div className="flex flex-col gap-1">
                    {homeItems.map((item) => {
                      const file = item.kind === "file" ? libraryFilesByPath.get(item.id) : undefined;
                      const kind = item.kind === "file" ? null : HOME_KIND[item.kind];
                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => openHomeItem(item)}
                          className="flex items-center gap-3 px-3 py-2 rounded-md bg-white/90 dark:bg-neutral-900/90 backdrop-blur-sm border border-gray-200 dark:border-neutral-800 hover:border-blue-400 dark:hover:border-blue-500 text-left transition-colors"
                        >
                          <span className={`shrink-0 ${kind ? kind.color : "text-gray-400 dark:text-neutral-500"}`}>
                            {kind ? kind.icon : categoryIcon(getFileCategory(item.name))}
                          </span>
                          <span className="text-sm text-gray-700 dark:text-neutral-200 truncate">
                            {file ? truncateFileName(file.name) : item.name}
                          </span>
                          <span className="ml-auto flex items-center gap-2 shrink-0 text-xs tabular-nums text-gray-400 dark:text-neutral-500">
                            {file && arrivals[file.path] ? (
                              <span
                                className="flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2 py-0.5"
                                title={`Sent from ${arrivals[file.path].from} ${relativeTime(arrivals[file.path].at)}`}
                              >
                                <IoPhonePortraitOutline size={12} />
                                <span className="max-w-[9rem] truncate">{arrivals[file.path].from}</span>
                                {arrivals[file.path].count > 1 && <span>· +{arrivals[file.path].count - 1} more</span>}
                                <span aria-hidden>·</span>
                                <span>{relativeTime(arrivals[file.path].at)}</span>
                              </span>
                            ) : file ? (
                              <>
                                {libraryPreviewDurations.has(file.path) && (
                                  <>
                                    <span>{formatMediaDuration(libraryPreviewDurations.get(file.path)!)}</span>
                                    <span aria-hidden>·</span>
                                  </>
                                )}
                                <span>{formatFileSize(file.size)}</span>
                              </>
                            ) : (
                              <>
                                <span>{kind!.label}</span>
                                {item.time > 0 && (
                                  <>
                                    <span aria-hidden>·</span>
                                    <span>{relativeTime(item.time)}</span>
                                  </>
                                )}
                              </>
                            )}
                            {item.pinned && <IoPin size={13} />}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          </div>
        </div>
        </div>
      </div>

      {/* Cut cameras on the live display without reopening the modal - only while it's live. */}
      <PresentationLiveBar />

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
        fileTransfer={fileTransferOptions}
        onSetThumbnail={() => videoPlayerRef.current?.openThumbnailPicker()}
        onExportedFile={handleVideoExported}
        draggingLibraryFile={
          draggingFiles && draggingFiles.length === 1 && ["video", "image", "audio"].includes(getFileCategory(draggingFiles[0].name) ?? "")
            ? { path: draggingFiles[0].path, name: draggingFiles[0].name }
            : null
        }
        pendingTimelineInsert={pendingTimelineInsert}
        onTimelineInsertHandled={() => setPendingTimelineInsert(null)}
        onOutputTimeChange={setCurrentOutputTime}
        getExactOutputTime={getExactOutputTime}
        getPlayerTime={getTimelinePlayerTime}
        onPausePlayer={() => {
          if (videoPlayerRef.current?.getPlaybackState()?.paused === false) videoPlayerRef.current.togglePlay();
        }}
        onActiveClipChange={setActiveClipEffects}
        onReframePreviewChange={setReframePreview}
        noiseReductionStatus={noiseReductionStatus}
        onPreviewNoiseOriginal={(bypass) => videoPlayerRef.current?.setNoisePreviewBypass(bypass)}
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
        selectedAdjustmentId={selectedAdjustmentId}
        onSelectAdjustment={selectAdjustment}
        selectedSceneId={selectedSceneId}
        onSelectScene={selectScene}
        isPlacingBlur={isPlacingBlur}
        onToggleArmPlaceBlur={() => setIsPlacingBlur((v) => !v)}
        selectedPipOverlayId={selectedPipOverlayId}
        onSelectPipOverlay={setSelectedPipOverlayId}
        isPlacingPip={isPlacingPip}
        onToggleArmPlacePip={() => setIsPlacingPip((v) => !v)}
        onMarkWebcamBubble={() => setIsMarkingBubble(true)}
        onFindAndHide={() => {
          setFindStatus({ phase: "idle" });
          setIsFinding(true);
        }}
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
        separateWebcamCapture={separateWebcamCapture}
        setSeparateWebcamCapture={setSeparateWebcamCapture}
        trackClicks={trackClicks}
        setTrackClicks={setTrackClicks}
        resolutionWidth={resolutionWidth}
        setResolutionWidth={setResolutionWidth}
        framerate={framerate}
        setFramerate={setFramerate}
        selectedScreen={selectedScreen}
        setSelectedScreen={setSelectedScreen}
        windowTitles={windowTitles}
        isMonitoring={isMonitoring}
        setIsMonitoring={setIsMonitoring}
        isRecording={isRecording}
        recordingStartTime={recordingStartTime}
        handleStartRecording={handleStartRecording}
        handleStopRecording={handleStopRecording}
        onOpenPhoneCamera={() => setShowPhoneCamera(true)}
        isPhoneCameraConnected={isPhoneCameraConnected}
        isPaused={isPaused}
        canSwitchView={canSwitchView}
        viewMode={viewMode}
        onSwitchView={(mode: 'screen' | 'camera') => void switchView(mode)}
        pauseStartedAt={pauseStartedAt}
        pausedAccumulatedMs={pausedAccumulatedMs}
        handlePauseRecording={handlePauseRecording}
        handleResumeRecording={handleResumeRecording}
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
        showRecordingDocker={showRecordingDocker}
        showRecordingPanelButtons={showRecordingPanelButtons}
        showDockerStatusBar={showDockerStatusBar}
        handleFolderSettings={toggleFileList}
        handleGoHome={handleGoHome}
        isHome={selectedFile === null && boardScreen === null && docsScreen === null && whiteboardScreen === null && mindmapScreen === null && videoEditorScreen === null}
        handleOpenBoard={handleOpenBoard}
        isBoard={boardScreen !== null}
        handleOpenDocs={handleOpenDocs}
        isDocs={docsScreen !== null}
        handleOpenWhiteboard={handleOpenWhiteboard}
        isWhiteboard={whiteboardScreen !== null}
        handleOpenMindmap={handleOpenMindmap}
        isMindmap={mindmapScreen !== null}
        handleOpenVideoEditor={handleOpenVideoEditor}
        isVideoEditor={videoEditorScreen !== null}
        handleOpenSettings={handleOpenSettings}
        handleOpenExternalFile={handleOpenExternalFile}
        showFileList={showFileList}
      />
      )}

      <PhoneTransferHost />
      <PhonesHubHost dropHover={phoneHover} />
      <PhoneShelf dragging={shelfDragging} point={shelfAt} />
      <UsbImportHost />
      {showSettings && <SettingsModal onClose={handleCloseSettings} onSave={handleSettingsSaved} onStorageChanged={handleStorageChanged} />}
      {showPhoneCamera && (
        <PhoneCameraModal
          onClose={() => setShowPhoneCamera(false)}
          onConnected={() => {
            // Arm the phone the moment it's actually usable, so pairing and selecting it aren't
            // two separate chores.
            setVideoDevices((prev) =>
              prev.includes(PHONE_CAMERA_DEVICE) ? prev : [...prev, PHONE_CAMERA_DEVICE]
            );
          }}
        />
      )}

      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 items-end">
        {dragPoint && draggingFiles?.length === 1 && (
          <div
            className="fixed z-[90] pointer-events-none px-2.5 py-1.5 rounded-lg shadow-lg text-[12px] whitespace-nowrap bg-neutral-900/95 text-white ring-1 ring-white/10"
            style={{ left: dragPoint.x + 14, top: dragPoint.y + 14 }}
          >
            <span className="font-medium">{draggingFiles[0].name}</span>
            <span className="text-white/55">
              {" · "}
              {dragPoint.over === "timeline"
                ? getFileCategory(draggingFiles[0].name) === "audio"
                  ? "drop to add as a sound track"
                  : "drop to insert here"
                : dragPoint.over === "video"
                  ? getFileCategory(draggingFiles[0].name) === "audio"
                    ? "drop to add as a sound track"
                    : "drop to show it here on the video"
                  : dragPoint.over === "zone"
                    ? "drop to use it here"
                    : "drop on the timeline or the picture"}
            </span>
          </div>
        )}
        <PhoneIncomingTray onOpen={(path, name) => void loadFileForPlayback(path, name)} />
        <UsbPhoneTray />
        <ExportQueueChip
          onOpen={(job) => job.resultPath && void loadFileForPlayback(job.resultPath, job.resultPath.split(/[\\/]/).pop() ?? job.title)}
          onShare={setShareJob}
        />
        {shareJob?.resultPath && <SharePanel filePath={shareJob.resultPath} meta={shareJob.share} durationSec={shareJob.durationSec} onClose={() => setShareJob(null)} />}
        {message && <Toast key={`msg-${message}`} message={message} variant="info" onDismiss={() => setMessage("")} />}
        {error && <Toast key={`err-${error}`} message={error} variant="error" onDismiss={() => setError("")} />}
        {pendingUpdate && (
          <UpdateBanner update={pendingUpdate} isRecording={isRecording} onDismiss={() => setPendingUpdate(null)} />
        )}
        <TelemetryNotice /> 
      </div>
    </div>
    </ToolPanelOpenContext.Provider>
    </ToolPanelHostContext.Provider>
    </ItemLinksProvider>
  );
};

export default Dashboard;