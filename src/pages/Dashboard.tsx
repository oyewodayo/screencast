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
import VideoPlayer from "../components/VideoPlayer";
import ConversionDialog from "../components/ConversionDialog";
import PdfAnnotator from "../components/PdfAnnotator";
import SettingsModal from "../components/Modals/SettingsModal";
import Toast from "../components/custom/Toast";
import { loadSettings } from "../utils/appSettings";
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
} from "react-icons/io5";

type RAMInfo = [number, number];

type FileCategory = "video" | "audio" | "image" | "pdf";

const FILE_CATEGORY_EXTENSIONS: Record<FileCategory, string[]> = {
  video: ["mp4", "mov", "avi", "mkv", "webm", "wmv"],
  audio: ["mp3", "wav", "aac", "flac", "ogg", "m4a"],
  image: ["jpg", "jpeg", "png", "gif", "bmp", "tiff"],
  pdf: ["pdf"],
};

const getFileCategory = (fileName: string): FileCategory | null => {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const match = (Object.entries(FILE_CATEGORY_EXTENSIONS) as [FileCategory, string[]][])
    .find(([, exts]) => exts.includes(ext));
  return match ? match[0] : null;
};

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
  const [windowTitles, setWindowTitles] = useState<WindowInfo[]>([]);
  const [isMonitoring, setIsMonitoring] = useState<boolean>(false);
  const [showFileList, setShowFileList] = useState<boolean>(false);
  const [files, setFiles] = useState<FileMap>({});
  const [activeFileCategory, setActiveFileCategory] = useState<SidebarTab>("video");
  const [trashItems, setTrashItems] = useState<TrashEntry[]>([]);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; sourcePath: string } | null>(null);
const [conversionFile, setConversionFile] = useState<{path: string; name: string} | null>(null);
  // Audio playlist controls (repeat/shuffle/autoplay-next) — see navigateAudio/handleAudioEnded.
  const [audioRepeatMode, setAudioRepeatMode] = useState<"off" | "all" | "one">("off");
  const [audioShuffle, setAudioShuffle] = useState<boolean>(false);
  const [audioAutoplayNext, setAudioAutoplayNext] = useState<boolean>(true);

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
	};

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

	const startRename = (file: FileEntry) => {
		const dotIndex = file.name.lastIndexOf('.');
		setRenameValue(dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name);
		setRenamingFile(file.path);
		setOpenMenu(null);
	};

	const commitRename = async (file: FileEntry) => {
		const newName = renameValue.trim();
		setRenamingFile(null);
		if (!newName || newName === file.name) return;
		try {
			await invoke<string>('rename_file', { oldPath: file.path, newName });
			await handleDirectoryFiles();
		} catch (error) {
			console.error('Error renaming file:', error);
			setError(`Failed to rename file: ${error}`);
		}
	};

	// Computed once per render so both the fixed sidebar header and the scrollable list below
	// it can share the same grouping — previously this was recomputed inside an IIFE local to
	// just the list, which the header (now pulled out so it can stay fixed) couldn't reach.
	const filteredEntries = Object.entries(files)
		.map(([folder, fileList]) => [
			folder,
			fileList.filter((file) => getFileCategory(file.name) === activeFileCategory),
		] as [string, FileEntry[]])
		.filter(([, fileList]) => fileList.length > 0);
	const sidebarHeaderLabel =
		activeFileCategory === "trash"
			? "Trash:"
			: filteredEntries.length === 1 ? `${filteredEntries[0][0]}:` : filteredEntries.length > 1 ? "Files:" : "Briefcast:";
	const isAudioSelected = selectedFile !== null && getFileCategory(selectedFile.name) === "audio";

  return (
    <div className="w-full h-screen flex flex-col bg-neutral-50 dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100">
      <div className="p-">
        <div className="flex justify-between">
          {/* File list sidebar — force-collapsed in PDF fullscreen/presentation mode,
              regardless of showFileList, so it never reappears over the presented page. */}
          <div
            className={`h-screen bg-neutral-50 dark:bg-neutral-900 border-b border-gray-300 dark:border-neutral-700 transition-all duration-300 overflow-hidden ${
              showFileList && !isPdfFullscreen ? "w-[250px] opacity-100" : "w-0 opacity-0"
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
                      onClick={() => setActiveFileCategory(category)}
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
                  {(activeFileCategory === "image" || activeFileCategory === "audio") && (
                    <div className="flex items-center gap-0.5 shrink-0">
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
                    </div>
                  )}
                </div>

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
                    <div key={folder} className="mb-4">
                      {filteredEntries.length > 1 && (
                        <h4 className="text-xs font-semibold text-gray-500 dark:text-neutral-400 mb-1">{folder}</h4>
                      )}
                      <ul className="ml-2 mt-1">
                        {fileList.map((file) => (
                          <li
                            key={file.path}
                            className={`flex items-center justify-between group cursor-pointer hover:bg-gray-50 dark:hover:bg-neutral-800 ${
                              selectedFile?.sourcePath === file.path ? 'bg-blue-50 dark:bg-blue-500/10' : ''
                            }`}
                          >
                            {/* MODIFIED: Now clicking plays the file in VideoPlayer */}
                            {renamingFile === file.path ? (
                              <input
                                className="flex-1 border border-blue-400 rounded px-1 text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100"
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
                                className={`flex-1 hover:text-blue-500 dark:hover:text-blue-400 ${
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
                                }}
                              >
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
                                  <path d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
                                </svg>
                              </button>

                              {/* Popup Menu */}
                              {openMenu === file.path && (
                                <div className="absolute right-0 top-full mt-1 w-32 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg z-10">
                                  <button
                                    className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-neutral-700 text-sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      startRename(file);
                                    }}
                                  >
                                    Rename
                                  </button>
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
                key={selectedFile.path}
                src={selectedFile.path}
                filePath={selectedFile.sourcePath}
                title={selectedFile.name}
                autoPlay={true}
                initialTime={isAudioSelected ? audioPositionsRef.current[selectedFile.sourcePath] : undefined}
                loop={isAudioSelected && audioRepeatMode === "one"}
                onTimeUpdate={handleAudioTimeUpdate}
                onEnded={handleAudioEnded}
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
