import React, { Dispatch, SetStateAction, useEffect, useRef, useState } from "react";
import OsInfo from "./OsInfo";

import { message } from "@tauri-apps/api/dialog";
import { invoke } from "@tauri-apps/api/tauri";
import ActiveRecordingState from "./ActiveRecordingState";
import EnhancedScreenOptions from "./EnhancedScreenOptions";
import RecordingDocker from "./docker/RecordingDocker";
import FileToolsDocker, { DockerFile } from "./docker/FileToolsDocker";

interface Props {
  // Which content the collapsible panel below ActiveRecordingState shows - the default
  // recording-setup controls, or quick tools for whichever file is currently open. Toggled from
  // Dashboard's sidebar (see the button next to "new folder"); falls back to "record" whenever
  // activeFile is null; either way, the presence check happens in BottomDocker's render, not here.
  dockerMode: "record" | "file-tools";
  activeFile: DockerFile | null;
  // Asset:// URL for activeFile (already converted for the main player) — needed only by the
  // video-tools timeline, which loads its own hidden <video> to capture thumbnail frames.
  activeFilePlayableSrc: string | null;
  // Live playback position of the main player, and a way to seek it - what lets the video-tools
  // timeline's playhead track and drive real playback instead of being purely decorative.
  activeFileCurrentTime: number;
  onSeekActiveFile: (time: number) => void;
  onConvertFile: (file: DockerFile) => void;
  onRenameFile: (file: DockerFile, newName: string) => Promise<void>;
  onDeleteFile: (file: DockerFile) => Promise<void>;
  handleFolderSettings: () => void;
  handleGoHome: () => void;
  handleOpenSettings: () => void;
  handleOpenExternalFile: () => void;
  showFileList: boolean;
  selectScreen: boolean;
  setScreen: () => void;
  unSetScreen: () => void;
  selectedScreen: string;
  setSelectedScreen: React.Dispatch<React.SetStateAction<string>>;
  screenSize: string; // ADD THIS
  setScreenSize: React.Dispatch<React.SetStateAction<string>>; // ADD THIS
  overlayShape: string; // ADD THIS
  setOverlayShape: React.Dispatch<React.SetStateAction<string>>; // ADD THIS
  overlayPosition: string; // ADD THIS
  setOverlayPosition: React.Dispatch<React.SetStateAction<string>>; // ADD THIS
  overlaySize: string; // ADD THIS
  setOverlaySize: React.Dispatch<React.SetStateAction<string>>; // ADD THIS
  includeSystemAudio: boolean;
  setIncludeSystemAudio: React.Dispatch<React.SetStateAction<boolean>>;
  isMonitoring: boolean;
  setIsMonitoring: Dispatch<SetStateAction<boolean>>;
  windowTitles?: any[];
  handleStartRecording: (formData: {
    file_name: string;
    file_ext: string;
    record_type: string;
    audio_device: string;
    video_devices: string[];
    screen_size: string; // Make sure this is here
    overlay_shape: string;
    overlay_position: string;
    overlay_size: string;
    include_system_audio: boolean;
  }) => void;
  handleStopRecording: () => void;
  isRecording: boolean;
  recordingStartTime: number | null;
  ramInfo: [number, number] | null;
  fileName: string;
  setFileName: React.Dispatch<React.SetStateAction<string>>;
  fileExt: string;
  setFileExt: React.Dispatch<React.SetStateAction<string>>;
  recordType: string;
  setRecordType: React.Dispatch<React.SetStateAction<string>>;
  audioDevice: string;
  setAudioDevice: React.Dispatch<React.SetStateAction<string>>;
  videoDevices: string[];
  setVideoDevices: React.Dispatch<React.SetStateAction<string[]>>;
}

type ConnectedDevice = string[];
const BottomDocker = ({
  dockerMode,
  activeFile,
  activeFilePlayableSrc,
  activeFileCurrentTime,
  onSeekActiveFile,
  onConvertFile,
  onRenameFile,
  onDeleteFile,
  handleFolderSettings,
  handleGoHome,
  handleOpenSettings,
  handleOpenExternalFile,
  showFileList,
  selectScreen,
  setScreen,
  unSetScreen,
  selectedScreen,
  setSelectedScreen,
  screenSize, // ADD THIS
  setScreenSize, // ADD THIS
  overlayShape, // ADD THIS
  setOverlayShape, // ADD THIS
  overlayPosition, // ADD THIS
  setOverlayPosition, // ADD THIS
  overlaySize, // ADD THIS
  setOverlaySize, // ADD THIS
  includeSystemAudio,
  setIncludeSystemAudio,
  handleStartRecording,
  handleStopRecording,
  isMonitoring,
  setIsMonitoring,
  windowTitles,
  isRecording,
  recordingStartTime,
  ramInfo,
  fileName,
  setFileName,
  fileExt,
  setFileExt,
  recordType,
  setRecordType,
  audioDevice,
  setAudioDevice,
  videoDevices,
  setVideoDevices
}: Props) => {
  const [modalOpenScreen, setModalOpenScreen] = useState(false);
  // Set while the standalone Screenshot button drives the flow, so recordType can be
  // switched to "c" (screenshot) for the modal/backend and then restored to whatever the
  // Recording options dropdown had selected once the modal closes.
  const [previousRecordType, setPreviousRecordType] = useState<string | null>(null);
  const [connectedAudioDevices, setConnectedAudioDevices] = useState<ConnectedDevice | null>(null);
  const [connectedCameraDevices, setConnectedCameraDevices] = useState<ConnectedDevice | null>(null);
  const [showDocker, setShowDocker] = useState(true);
  // This whole docker is `fixed bottom-0`, sitting on top of the video player rather than
  // participating in its flex layout - so the player's own control bar (see .video-controls-
  // container in player.css) has no natural way to know how tall it is and previously assumed a
  // fixed 64px (the collapsed-only height), which put the controls out of view any time the full
  // panel below (file name/type/recording options/etc.) was expanded. Measuring the real height
  // and publishing it as a CSS var lets the player's controls track it exactly, collapsed or not.
  const dockerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = dockerRef.current;
    if (!el) return;

    const publishHeight = (): void => {
      document.documentElement.style.setProperty('--docker-height', `${el.offsetHeight}px`);
    };

    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(el);
    return () => observer.disconnect();
  }, [showDocker]);
  
  // REMOVE THESE - now coming from props:
  // const [screenSize, setScreenSize] = useState("fullscreen")
  // const [overlayShape, setOverlayShape] = useState("rounded")
  // const [overlayPosition, setOverlayPosition] = useState("bottom_right")
  // const [overlaySize, setOverlaySize] = useState("small")

  // ... rest of your component stays the same
  //   // const [windowInfos, setWindowInfos] = useState<WindowInfo[]>([]);
  // const [isLoading, setIsLoading] = useState(false);

  // const captureScreenshots = async () => {
  //   setIsLoading(true);

  //   try {
  //     const result = await invoke<WindowInfo[]>('capture_window_screenshots_by_title_command');
  //     console.log(result)
  //     setWindowInfos(result);
  //   } catch (err) {
  //     // setError('Failed to capture screenshots: ' + (err as Error).message);
  //   } finally {
  //     setIsLoading(false);
  //   }
  // };

  // useEffect(() => {
  //   captureScreenshots();
  // }, []);

  const loadDevices = () => {
    invoke<ConnectedDevice>("get_connected_audios")
      .then((devices) => {
        setConnectedAudioDevices(devices);
        if (devices.length > 0) {
          setAudioDevice(devices[0]); // Set default audio device
        }
      })
      .catch(console.error);

    invoke<ConnectedDevice>("get_connected_cameras")
      .then((devices) => {
        setConnectedCameraDevices(devices);
        if (devices.length > 0) {
          setVideoDevices([devices[0]]); // Default to the first detected camera
        }
      })
      .catch(console.error);
  };

  useEffect(() => {
    loadDevices();
  }, []);

  useEffect(() => {
    // Set default file extension based on recordType
    switch (recordType) {
      case "c":
        setFileExt("png");
        break;
      case "a":
        setFileExt("mp3");
        break;
      default:
        setFileExt("Avi");
        break;
    }
  }, [recordType]);

  const handleRecordTypeChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    setRecordType(event.target.value);
  };

  const handleFileExtChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    console.log(event.target.value);

    setFileExt(event.target.value);
  };

  const handleFileNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setFileName(event.target.value);
  };

  const handleAudioDeviceChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    setAudioDevice(event.target.value);
  };

  const toggleVideoDevice = (device: string) => {
    setVideoDevices((prev) =>
      prev.includes(device) ? prev.filter((d) => d !== device) : [...prev, device]
    );
  };

  // EnhancedScreenOptions passes the resolved target directly when it has one (e.g. clicking a
  // window thumbnail confirms and starts in the same click) rather than relying on the
  // screenSize/selectedScreen props it just set — those are async state updates, so reading
  // them back here in that same synchronous call would still see the *previous* selection.
  const onStartRecording = (target?: { screenSize: string; selectedScreen: string }) => {
    const effectiveScreenSize = target?.screenSize ?? screenSize;
    const effectiveSelectedScreen = target?.selectedScreen ?? selectedScreen;

    const formData = {
      file_name: fileName,
      file_ext: fileExt,
      record_type: recordType,
      audio_device: audioDevice,
      screen_size: effectiveScreenSize,
      video_devices: videoDevices,
      overlay_shape:overlayShape,
      overlay_position:overlayPosition,
      overlay_size:overlaySize,
      // screen_size only carries the window's hwnd ("window:<hwnd>") — gdigrab targets windows
      // by title, not handle, so the actual title has to travel separately. Monitor capture
      // reuses the same field for its overlay's on-screen label.
      window_title: effectiveScreenSize !== 'fullscreen' ? effectiveSelectedScreen : '',
      include_system_audio: includeSystemAudio,
    };

    console.log(formData)
    handleStartRecording(formData);
    setModalOpenScreen(false)

  };

  const openModalScreen = async ()=>{
    try {
      if (!isMonitoring) {
        console.log("Is monitoring: ",isMonitoring)
        await invoke("start_monitoring_windows")

        setIsMonitoring(true)
        console.log("Monitoring started")
      }


    } catch (error) {
      console.error("Error monitoring screens: ",error)
    }
    setModalOpenScreen(true)
  }

  const closeModalScreen = ()=>{
    setModalOpenScreen(false)
    if (previousRecordType !== null) {
      setRecordType(previousRecordType);
      setPreviousRecordType(null);
    }
  }

  // Screenshot is a standalone action rather than a "Recording options" choice, but the
  // screen-selection modal and the backend both key off recordType === "c" to behave as a
  // screenshot flow. Switch to it just for this flow and restore the dropdown's value
  // (in closeModalScreen) once the modal closes.
  const handleScreenshotClick = () => {
    setPreviousRecordType(recordType);
    setRecordType("c");
    openModalScreen();
  }

  const handleVideoOverlayAction = async() =>{
    return await message("Video recording is going on as overlay to screen recoring", "Video recording");
  }
  const videoFormatInfo = async() =>{
    return await message("Avi or Mkv format is highly rocommended to record video. However, you can remuxe or convert to other format when you are done recording.", { title: 'Video format', type: 'info' });
  }

  return (
    <>
    <EnhancedScreenOptions
     recordType={recordType}
     videoDevices={videoDevices}
     selectScreen={selectScreen}
     setScreen={setScreen}
     unSetScreen={unSetScreen}
     selectedScreen={selectedScreen}
     setSelectedScreen={setSelectedScreen}
      screenSize={screenSize}
      setScreenSize={setScreenSize}
      windowTitles={windowTitles || []}
      overlayPosition={overlayPosition} 
      overlayShape={overlayShape} 
      overlaySize={overlaySize} 
      setOverlayShape={setOverlayShape}
      setOverlayPosition={setOverlayPosition}
      setOverlaySize={setOverlaySize}
      isOpenScreen={modalOpenScreen} 
      onCloseScreen={closeModalScreen} 
      onStartRecording={onStartRecording} 
      setOpen={setModalOpenScreen}
    />
    <div ref={dockerRef} className="w-full fixed bottom-0 flex flex-col">
     
        <ActiveRecordingState
            isRecording={isRecording}
            recordingStartTime={recordingStartTime}
            recordType={recordType}
            handleFolderSettings={handleFolderSettings}
            handleGoHome={handleGoHome}
            handleOpenSettings={handleOpenSettings}
            handleOpenExternalFile={handleOpenExternalFile}
            handleVideoOverlayAction={handleVideoOverlayAction}
            handleStopRecording={handleStopRecording}
            showDocker={showDocker}
            setShowDocker={setShowDocker}
            showFileList={showFileList} 
        />
      
      {showDocker && (<div className="w-full flex flex-col gap-3 p-4 bg-neutral-50 dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 border-t border-neutral-200 dark:border-neutral-800">
        {dockerMode === "file-tools" && activeFile ? (
          <FileToolsDocker
            file={activeFile}
            playableSrc={activeFilePlayableSrc}
            currentTime={activeFileCurrentTime}
            onSeek={onSeekActiveFile}
            onConvert={onConvertFile}
            onRename={onRenameFile}
            onDelete={onDeleteFile}
          />
        ) : (
          <RecordingDocker
            fileName={fileName}
            onFileNameChange={handleFileNameChange}
            fileExt={fileExt}
            onFileExtChange={handleFileExtChange}
            onShowVideoFormatInfo={videoFormatInfo}
            recordType={recordType}
            onRecordTypeChange={handleRecordTypeChange}
            audioDevice={audioDevice}
            onAudioDeviceChange={handleAudioDeviceChange}
            connectedAudioDevices={connectedAudioDevices}
            connectedCameraDevices={connectedCameraDevices}
            videoDevices={videoDevices}
            onToggleVideoDevice={toggleVideoDevice}
            onRefreshDevices={loadDevices}
            includeSystemAudio={includeSystemAudio}
            onToggleIncludeSystemAudio={() => setIncludeSystemAudio((prev) => !prev)}
            isRecording={isRecording}
            onScreenshotClick={handleScreenshotClick}
            onStartRecordingClick={() => openModalScreen()}
            onStopRecordingClick={handleStopRecording}
          />
        )}

        <div className="w-full grid grid-cols-1 grid-flow-col text-xs">
          <div>
          <span>{Date()}</span>

          <span className="cpu-info">
            {" "}
            | CPU RAM:{" "}
            {ramInfo ? (
              <span>
                {" "}
                <span className="text-green-800 dark:text-green-400">
                  {(ramInfo[1] / 1024).toFixed(2)} GB
                </span>
                /
                <span className="text-blue-500 dark:text-blue-400">
                  {(ramInfo[0] / 1024).toFixed(2)} GB
                </span>
              </span>
            ) : (
              <span>...</span>
            )}
          </span>
          <OsInfo />
          </div>
          <div className="right-0"><span> <a href="https://x.com/oyewodayo" target="blank" className="text-blue-600 dark:text-blue-400">Request feature / Report a bug</a></span></div>
        </div>
      </div>)}
    </div>
    </>
  );
};

export default BottomDocker;
