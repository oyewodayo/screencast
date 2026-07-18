// Dashboard.tsx
import { useState, useEffect } from "react";
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
import { IoVideocam, IoMusicalNotes, IoImage, IoDocumentText } from "react-icons/io5";

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
  const [videoDevice, setVideoDevice] = useState("");
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
  const [activeFileCategory, setActiveFileCategory] = useState<FileCategory>("video");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState<string>("");
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string; sourcePath: string } | null>(null);
const [conversionFile, setConversionFile] = useState<{path: string; name: string} | null>(null);


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

  const handleStartRecording = async (formData: any) => {
    try {
        // NOW screenSize is accessible here
        if (screenSize.startsWith('monitor:')) {
            const monitorId = screenSize.replace('monitor:', '');
            console.log('Recording monitor:', monitorId);
            // Add monitor-specific logic
        } else if (screenSize.startsWith('window:')) {
            const windowHwnd = screenSize.replace('window:', '');
            console.log('Recording window:', windowHwnd, selectedScreen);
            
            // Activate the window before recording
            await invoke('activate_and_open_window', { 
                title: selectedScreen 
            });
            await new Promise(resolve => setTimeout(resolve, 500));
        }

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


  return (
    <div className="w-full h-screen flex flex-col">
      <div className="p-">
        <div className="flex justify-between">
          {/* File list sidebar — force-collapsed in PDF fullscreen/presentation mode,
              regardless of showFileList, so it never reappears over the presented page. */}
          <div
            className={`h-screen light border-b border-gray-300 transition-all duration-300 overflow-hidden ${
              showFileList && !isPdfFullscreen ? "w-[250px] opacity-100" : "w-0 opacity-0"
            }`}
          >
            {showFileList && !isPdfFullscreen && (
              <div className="flex flex-col h-full">
                {/* File type tabs */}
                <div className="flex items-center justify-around border-b border-gray-300 py-2 shrink-0">
                  {FILE_CATEGORY_TABS.map(({ category, label, icon }) => (
                    <button
                      key={category}
                      type="button"
                      title={label}
                      onClick={() => setActiveFileCategory(category)}
                      className={`flex flex-col items-center gap-1 px-2 py-1 rounded text-[11px] transition-colors ${
                        activeFileCategory === category
                          ? "text-blue-600 bg-blue-50"
                          : "text-gray-500 hover:text-blue-500 hover:bg-gray-50"
                      }`}
                    >
                      {icon}
                      <span>{label}</span>
                    </button>
                  ))}
                </div>

                <div className="p-3 text-sm overflow-y-auto flex-1">
                {(() => {
                  const filteredEntries = Object.entries(files)
                    .map(([folder, fileList]) => [
                      folder,
                      fileList.filter((file) => getFileCategory(file.name) === activeFileCategory),
                    ] as [string, FileEntry[]])
                    .filter(([, fileList]) => fileList.length > 0);

                  if (filteredEntries.length === 0) {
                    return <p>No {activeFileCategory} files found</p>;
                  }

                  return filteredEntries.map(([folder, fileList]) => (
                    <div key={folder} className="mb-4">
                      <h3 className="font-semibold text-gray-700">{folder}:</h3>
                      <ul className="ml-2 mt-1">
                        {fileList.map((file) => (
                          <li
                            key={file.path}
                            className={`flex items-center justify-between group cursor-pointer hover:bg-gray-50 ${
                              selectedFile?.sourcePath === file.path ? 'bg-blue-50' : ''
                            }`}
                          >
                            {/* MODIFIED: Now clicking plays the file in VideoPlayer */}
                            {renamingFile === file.path ? (
                              <input
                                className="flex-1 border border-blue-400 rounded px-1 text-sm"
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
                                className={`flex-1 hover:text-blue-500 ${
                                  selectedFile?.sourcePath === file.path ? 'text-blue-600 font-medium' : ''
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
                                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 transition-opacity"
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
                                <div className="absolute right-0 top-full mt-1 w-32 bg-white border border-gray-200 rounded-md shadow-lg z-10">
                                  <button
                                    className="w-full text-left px-3 py-2 hover:bg-gray-100 text-sm"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      startRename(file);
                                    }}
                                  >
                                    Rename
                                  </button>
                                   <button
                                      className="w-full text-left px-3 py-2 hover:bg-gray-100 text-sm"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setConversionFile(file);
                                        setOpenMenu(null);
                                      }}
                                    >
                                    Convert
                                  </button>
                                </div>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ));
                })()}
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
         <div className="flex-1 min-w-0 flex items-center justify-center bg-gray-100">
      
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
                title={selectedFile.name}
                autoPlay={true}
              />
            )
          ) : (
            <div className="flex items-center justify-center h-full w-full text-gray-500 italic">
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
        videoDevice={videoDevice}
        setVideoDevice={setVideoDevice}
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
