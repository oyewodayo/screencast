// Dashboard.tsx
import { useState, useEffect } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/tauri";
import BottomDocker from "../components/BottomDocker";
import { listen } from '@tauri-apps/api/event';
import { WindowInfo } from "../Types";
import { WebviewWindow } from '@tauri-apps/api/window';
import { formatFileName } from "../utils/Formater";
import VideoPlayer from "../components/VideoPlayer";
import ConversionDialog from "../components/ConversionDialog";

type RAMInfo = [number, number];

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
  const [error, setError] = useState<string>("");
  const [ramInfo, setRamInfo] = useState<RAMInfo | null>(null);
  const [fileName, setFileName] = useState("Recording_" + new Date().toLocaleDateString().replace(/\//g, "_"));
  const [fileExt, setFileExt] = useState("avi");
  const [recordType, setRecordType] = useState("sva");
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
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<{ path: string; name: string } | null>(null);
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
      
      // Hide the overlay window
      const overlayWindow = WebviewWindow.getByLabel('recording-overlay');
      if (overlayWindow) {
        await overlayWindow.hide();
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

  // Listen for global key events
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen('global-key-event', (event) => {
        const keyName = event.payload as string;
        console.log('Key pressed:', keyName);
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

  // Get RAM info
  useEffect(() => {
    invoke<RAMInfo>('get_ram_info')
      .then(setRamInfo)
      .catch(console.error);
  }, []);

  // Listen for file modal display event
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<string>('show-file-modal', (event) => {
        console.log("File path from Dashboard::", event.payload);
        const path = event.payload;

        const fileModal = WebviewWindow.getByLabel('file-modal');
        if (fileModal) {
          fileModal.emit('display-file-modal', path);
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
        setMessage(response);
        setIsRecording(true);
        setError("");

        // Create/show the overlay window
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
            focus: false,
          });
        }

        await overlayWindow.show();
        
        // Send recording state to overlay
        overlayWindow.emit('recording-state-update', {
          isRecording: true,
          recordType: formData.record_type,
          elapsedTime: 0
        });
        
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
	  // ADD THIS: Hide the overlay window
		const overlayWindow = WebviewWindow.getByLabel('recording-overlay');
		if (overlayWindow) {
		await overlayWindow.hide();
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

  // NEW: Handler to pass file selection to VideoPlayer
	const handleFileClick = async (file: FileEntry) => {
	try {
		// Get the absolute file path from Rust
		const absolutePath = await invoke<string>("convert_file_path_to_url", { 
		filepath: file.path 
		});
		
		console.log('Absolute file path:', absolutePath);
		
		// Convert to asset protocol URL using Tauri's helper
		const fileUrl = convertFileSrc(absolutePath);
		
		console.log('Converted file URL:', fileUrl);
		
		// Update the selected file state
		setSelectedFile({
		path: fileUrl,
		name: file.name
		});
		
		console.log('File selected for playback:', file.name);
	} catch (error) {
		console.error('Error loading file:', error);
		setError(`Failed to load file: ${error}`);
	}
	};


  return (
    <div className="w-full h-screen flex flex-col">
      <div className="p-">
        <div className="flex justify-between">
          {/* File list sidebar */}
          <div
            className={`h-screen light border-b border-gray-300 transition-all duration-300 overflow-hidden ${
              showFileList ? "w-[250px] opacity-100" : "w-0 opacity-0"
            }`}
          >
            {showFileList && (
              <div className="p-3 text-sm overflow-y-auto max-h-[76%]">
                {Object.keys(files).length === 0 ? (
                  <p>No media files found</p>
                ) : (
                  Object.entries(files).map(([folder, fileList]) => (
                    <div key={folder} className="mb-4">
                      <h3 className="font-semibold text-gray-700">{folder}:</h3>
                      <ul className="ml-2 mt-1">
                        {fileList.map((file) => (
                          <li
                            key={file.path}
                            className="flex items-center justify-between group cursor-pointer hover:bg-gray-50"
                          >
                            {/* MODIFIED: Now clicking plays the file in VideoPlayer */}
                            <div 
                              className="flex-1 hover:text-blue-500"
                              title={file.name}
                              onClick={() => handleFileClick(file)}
                            >
                              {formatFileName(file.name)}
                            </div>
                            
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
                                      console.log('Rename:', file.name);
                                      setOpenMenu(null);
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
                  ))
                )}
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
                    name: newFileName
                  });
                } catch (error) {
                  console.error('Error loading converted file:', error);
                }
              }}
            />
          )}
         <div className="flex-1 flex items-center justify-center bg-gray-100">
      
          {selectedFile ? (
            <VideoPlayer 
				key={selectedFile.path}
              	src={selectedFile.path}
              	title={selectedFile.name}
            	autoPlay={true}
            />
          ) : (
            <div className="flex items-center justify-center h-full w-full text-gray-500 italic">
              Select a file from the list to play
            </div>
          )}
        </div>

          
          {/* <div className="">
            <div>
              <img src="screencast.png" width={55} alt="Briefcast Logo" />
            </div>
            <div className="text-[12px] text-center -mt-2.5">
              Briefcast
            </div>
          </div> */}
        </div>
      </div>

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
        res_message={message}
        error={error}
        handleFolderSettings={toggleFileList}
        showFileList={showFileList}
      />
    </div>
  );
};

export default Dashboard;
