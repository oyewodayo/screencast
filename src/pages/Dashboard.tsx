// Dashboard.tsx
import { useState, useEffect, useRef, useCallback } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import { open as openFileDialog, message as showMessageDialog } from "@tauri-apps/api/dialog";
import BottomDocker from "../components/BottomDocker";
import { listen } from '@tauri-apps/api/event';
import { WindowInfo } from "../Types";
import { WebviewWindow, appWindow } from '@tauri-apps/api/window';
import { register, unregister, isRegistered } from '@tauri-apps/api/globalShortcut';
import { formatFileName } from "../utils/Formater";
import VideoPlayer, { VideoPlayerHandle } from "../components/VideoPlayer";
import ConversionDialog from "../components/ConversionDialog";
import PdfAnnotator from "../components/PdfAnnotator";
import SettingsModal from "../components/Modals/SettingsModal";
import Toast from "../components/custom/Toast";
import { loadSettings } from "../utils/appSettings";
import { FileCategory, FILE_CATEGORY_EXTENSIONS, getFileCategory, isConvertibleCategory } from "../utils/fileCategory";
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
} from "react-icons/io5";
import { MdCreateNewFolder } from "react-icons/md";

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
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  // "Move to ▸" flyout inside a file's 3-dot menu — keyed by file.path, separate from openMenu
  // so it can be nested inside that same popup instead of needing its own positioning.
  const [moveMenuOpenFor, setMoveMenuOpenFor] = useState<string | null>(null);
  // Folder relative-path (see FileMap's keys) whose inline "new folder" input is active, or null
  // if none is. "" means creating a top-level folder directly under Briefcast.
  const [creatingFolderIn, setCreatingFolderIn] = useState<string | null>(null);
  const [newFolderValue, setNewFolderValue] = useState<string>("");
  // Drag-and-drop move: the file(s) currently being dragged (more than one if the dragged file
  // was part of the active multi-selection below), and whichever folder header the pointer is
  // presently over (for the drop-target highlight). Both null outside a drag gesture.
  const [draggingFiles, setDraggingFiles] = useState<FileEntry[] | null>(null);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  // Multi-select for bulk move — a set of file.path values, spanning whichever folders are
  // currently visible under the active category. Cleared whenever the category tab changes so
  // a stale selection from "Video" doesn't silently carry over into "Audio".
  const [selectedFilePaths, setSelectedFilePaths] = useState<Set<string>>(new Set());
  const [bulkMoveMenuOpen, setBulkMoveMenuOpen] = useState<boolean>(false);
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; sourcePath: string } | null>(null);
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
  useEffect(() => {
    setPlayerCurrentTime(0);
  }, [selectedFile?.path]);
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

	const handleDeleteFile = async (file: FileEntry) => {
		try {
			await invoke("move_to_trash", { path: file.path });
			if (selectedFile?.sourcePath === file.path) setSelectedFile(null);
			setOpenMenu(null);
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

	const handleGoHome = () => setSelectedFile(null);
	const handleOpenSettings = () => setShowSettings(true);
	const handleCloseSettings = () => setShowSettings(false);
	// Settings apply immediately to the current session too, not just future ones — otherwise
	// saving a new default file extension/type wouldn't visibly do anything until next launch.
	const handleSettingsSaved = (settings: ReturnType<typeof loadSettings>) => {
		setFileExt(settings.defaultFileExt);
		setRecordType(settings.defaultRecordType);
		setAnnotationEnabled(settings.enableAnnotationTool);
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

		console.log('File selected for playback:', fileName);
	} catch (error) {
		console.error('Error loading file:', error);
		setError(`Failed to load file: ${error}`);
	}
	};

	const handleFileClick = async (file: FileEntry) => {
		await loadFileForPlayback(file.path, file.name);
	};

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
	const handleVideoEnded = useCallback(() => {
		const current = selectedFileRef.current;
		if (!current || getFileCategory(current.name) !== "video") return;
		if (!videoAutoplayNext) return;
		navigateVideo(1, { wrap: false });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [videoAutoplayNext, files]);

	// Single onEnded handed to VideoPlayer for both audio and video playback — each of the two
	// handlers above bails immediately if the file that just ended isn't its category, so exactly
	// one of them actually does anything on any given call.
	const handleMediaEnded = useCallback(() => {
		handleAudioEnded();
		handleVideoEnded();
	}, [handleAudioEnded, handleVideoEnded]);

	// Arrow-key navigation — only active while an image or audio file is the currently displayed
	// one, so it doesn't hijack arrow keys elsewhere (video seeking, PDF page turns, form inputs).
	useEffect(() => {
		if (!selectedFile) return;
		const category = getFileCategory(selectedFile.name);
		if (category !== "image" && category !== "audio") return;

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
	}, [selectedFile, files, audioShuffle]);

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

	useEffect(() => {
		const unlistenPromise = appWindow.onFileDropEvent((event) => {
			if (event.payload.type === "drop") {
				const destFolder = dragOverFolderRef.current ?? "";
				setDragOverFolder(null);
				handleImportFiles(event.payload.paths, destFolder);
			} else if (event.payload.type === "cancel") {
				setDragOverFolder(null);
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
	const filteredEntries = Object.entries(files)
		.map(([folder, fileList]) => [
			folder,
			fileList.filter((file) => getFileCategory(file.name) === activeFileCategory),
		] as [string, FileEntry[]])
		.sort(([a], [b]) => a.localeCompare(b));
	const sidebarHeaderLabel =
		activeFileCategory === "trash"
			? "Trash:"
			: filteredEntries.length === 1 ? `${folderDisplayName(filteredEntries[0][0])}:` : filteredEntries.length > 1 ? "Files:" : "Briefcast:";
	const isAudioSelected = selectedFile !== null && getFileCategory(selectedFile.name) === "audio";

  return (
    <div className="w-full h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="p-">
        <div className="flex justify-between">
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

                {/* Folder label + prev/next/repeat/shuffle/autoplay controls — fixed below the
                    tabs, does not scroll with the file list beneath it. */}
                <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-neutral-700 shrink-0">
                  <h3 className="font-semibold text-gray-700 dark:text-neutral-300 text-sm truncate">{sidebarHeaderLabel}</h3>
                  <div className="flex items-center gap-0.5 shrink-0">
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
                            ? "Show recording controls"
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

                <div className="p-3 text-sm overflow-y-auto flex-1 text-neutral-800 dark:text-neutral-200">
                {activeFileCategory === "trash" ? (
                  trashItems.length === 0 ? (
                    <p>Trash is empty</p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs text-neutral-500 dark:text-neutral-400">
                          {trashItems.length} item{trashItems.length === 1 ? "" : "s"}
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
                        {trashItems.map((item) => (
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
                  <p>No {activeFileCategory} files found</p>
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
                          className="text-xs font-semibold text-gray-500 dark:text-neutral-400 flex items-center gap-1 min-w-0 truncate"
                          title={folderDisplayName(folder)}
                        >
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

                      {creatingFolderIn === folder && (
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

                      {fileList.length === 0 ? (
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
                                  onClick={() => handleFileClick(file)}
                                >
                                  {formatFileName(file.name)}
                                </div>
                              )}

                              {/* Three vertical dots menu */}
                              <div className="relative">
                                <button
                                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 dark:hover:bg-neutral-700 transition-opacity"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMenu(openMenu === file.path ? null : file.path);
                                    setMoveMenuOpenFor(null);
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
                } catch (error) {
                  console.error('Error loading converted file:', error);
                }
              }}
            />
          )}
         <div className="flex-1 min-w-0 flex items-center justify-center bg-gray-100 dark:bg-neutral-950">

          {selectedFile ? (
            getFileCategory(selectedFile.name) === "pdf" ? (
              <PdfAnnotator
                key={selectedFile.path}
                src={selectedFile.path}
                sourcePath={selectedFile.sourcePath}
                title={selectedFile.name}
                isFullscreen={isPdfFullscreen}
                onToggleFullscreen={handleTogglePdfFullscreen}
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
                onEnded={handleMediaEnded}
                autoplayNext={isAudioSelected ? audioAutoplayNext : videoAutoplayNext}
                onAutoplayNextChange={() =>
                  isAudioSelected ? setAudioAutoplayNext((prev) => !prev) : setVideoAutoplayNext((prev) => !prev)
                }
              />
            )
          ) : (
            <div className="flex items-center justify-center h-full w-full text-gray-500 dark:text-neutral-400 italic">
              Select a file from the list to play
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
        activeFileCurrentTime={playerCurrentTime}
        onSeekActiveFile={(time) => videoPlayerRef.current?.seek(time)}
        onConvertFile={(file) => setConversionFile(file)}
        onRenameFile={renameFile}
        onDeleteFile={handleDeleteFile}
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
        handleOpenSettings={handleOpenSettings}
        handleOpenExternalFile={handleOpenExternalFile}
        showFileList={showFileList}
      />
      )}

      {showSettings && <SettingsModal onClose={handleCloseSettings} onSave={handleSettingsSaved} />}

      <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2 items-end">
        {message && <Toast key={`msg-${message}`} message={message} variant="info" onDismiss={() => setMessage("")} />}
        {error && <Toast key={`err-${error}`} message={error} variant="error" onDismiss={() => setError("")} />}
      </div>
    </div>
  );
};

export default Dashboard;
