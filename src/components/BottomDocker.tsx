import React, { Dispatch, SetStateAction, useEffect, useState } from "react";
import OsInfo from "./OsInfo";

import {
  IoInformationCircle,
  IoRefresh
} from "react-icons/io5";
import { message } from "@tauri-apps/api/dialog";
import { invoke } from "@tauri-apps/api/tauri";
import ActiveRecordingState from "./ActiveRecordingState";
import EnhancedScreenOptions from "./EnhancedScreenOptions";

interface Props {
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

        setIsMonitoring(isMonitoring)
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
    <div className="w-full fixed bottom-0 flex flex-col">
     
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
        <div className="w-full flex flex-wrap items-end justify-between gap-4 overflow-auto">

          <div className="flex flex-wrap items-end gap-3">
            <div>
              <div className="p-1 text-sm">Save file as</div>
              <input
                type="text"
                className="file_name p-2.5 rounded-l text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700"
                name="file_name"
                id="file_name"
                value={fileName}
                onChange={handleFileNameChange}
                placeholder={"Recording-" + Date()}
              />
            </div>

            <div>
              <div className="p-1 text-sm flex items-center justify-between">Type <button type="button"><IoInformationCircle onClick={videoFormatInfo}/></button></div>
              <select
                name="file_ext"
                id="file_ext"
                className="p-2.5 rounded-r text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700"
                value={fileExt}
                onChange={handleFileExtChange}
              >
                {recordType === "c" ? (
                  <>
                    <option value="png">Png</option>
                    <option value="jpeg">Jpeg</option>
                    <option value="webp">webp</option>
                  </>
                ) : recordType === "a" ? (
                  <>
                    <option value="mp3">Mp3</option>
                    <option value="wav">Wav</option>
                    <option value="aac">AAC</option>
                    <option value="wma">WMA</option>
                  </>
                ) : (
                  <>
                    <option value="avi">Avi</option>
                    <option value="mkv">Mkv</option>
                    <option value="webm">webm</option>
                    <option value="mov">Mov</option>
                    <option value="mp4">Mp4</option>
                  </>
                )}
              </select>
            </div>

            <div>
              <div className="p-1 text-sm">Recording options</div>
              <select
                name="record_type"
                id="record_type"
                className="p-2.5 rounded-md text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700"
                value={recordType}
                onChange={handleRecordTypeChange}
              >
                <option value="sva">
                  Screen record(Screen + Video + Audio)
                </option>
                <option value="sa">Screen record(Screen + Audio)</option>
                <option value="va">Screen record(Video and Audio)</option>
                <option value="s">Screen record(Screen only)</option>
                <option value="v">Video</option>
                <option value="a">Audio</option>
              </select>
            </div>

            <div>
              <div className="p-1 text-sm">Audio device</div>
              <select
                name="audioDevice"
                id="audioDevice"
                className="p-2.5 rounded-md text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700"
                value={audioDevice}
                onChange={handleAudioDeviceChange}
              >
                {connectedAudioDevices ? (
                  connectedAudioDevices.map((audioDevice, index) => (
                    <option key={index} value={audioDevice}>
                      {audioDevice}
                    </option>
                  ))
                ) : (
                  <option value="">No audio device detected</option>
                )}
              </select>
            </div>

            <div className="flex items-end gap-1">
              <div>
                <div className="p-1 text-sm">Video device(s)</div>
                <div className="p-2 rounded-md text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700 max-h-28 overflow-y-auto min-w-[180px]">
                  {connectedCameraDevices && connectedCameraDevices.length > 0 ? (
                    connectedCameraDevices.map((device, index) => (
                      <label key={index} className="flex items-center gap-2 py-0.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={videoDevices.includes(device)}
                          onChange={() => toggleVideoDevice(device)}
                        />
                        <span className="truncate">{device}</span>
                      </label>
                    ))
                  ) : (
                    <span className="text-neutral-500">No video cameras detected</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={loadDevices}
                title="Refresh device list"
                className="p-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
              >
                <IoRefresh />
              </button>
            </div>
          </div>

          <div className="flex items-end gap-2">
            <button
              onClick={handleScreenshotClick}
              disabled={isRecording}
              className="p-2.5 rounded-md text-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Screenshot
            </button>

            {!isRecording ? (
              <button
                onClick={()=>openModalScreen()}
                className="p-2.5 rounded-md text-sm bg-black dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-gray-800 dark:hover:bg-white"
              >
                Start Recording
              </button>
            ) : (
              <button
                onClick={handleStopRecording}
                className="p-2.5 rounded-md text-sm bg-black dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-gray-800 dark:hover:bg-white"
              >
                Stop Recording
              </button>
            )}
          </div>
        </div>

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
