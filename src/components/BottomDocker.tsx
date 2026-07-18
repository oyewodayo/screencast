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
    video_device: string;
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
  videoDevice: string;
  setVideoDevice: React.Dispatch<React.SetStateAction<string>>;
  res_message: string;
  error: string;
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
  videoDevice,
  setVideoDevice,
  res_message,
  error
}: Props) => {
  const [modalOpenScreen, setModalOpenScreen] = useState(false);
  const [showExt, setShowExt] = useState("sva");
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
          setVideoDevice(devices[0]);
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

    setShowExt(event.target.value);
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

  const handleVideoDeviceChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    setVideoDevice(event.target.value);
  };

  const onStartRecording = () => {

    const formData = {
      file_name: fileName,
      file_ext: fileExt,
      record_type: recordType,
      audio_device: audioDevice,
      screen_size:screenSize,
      video_device: videoDevice,
      overlay_shape:overlayShape,
      overlay_position:overlayPosition,
      overlay_size:overlaySize
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
        res_message={res_message}
        error={error}
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
      
      {showDocker && (<div className="light w-full flex flex-col p-4">
        <div className="w-full flex flex-row justify-between gap-5 overflow-auto">
          
          <div className="flex justify-end p-2">
            <div>
              <div className=" p-1 text-sm">Save file as</div>
              <input
                type="text"
                className="file_name p-2.5 rounded-l text-sm"
                name="file_name"
                id="file_name"
                value={fileName}
                onChange={handleFileNameChange}
                placeholder={"Recording-" + Date()}
              />
            </div>
            {["sva", "sa", "va", "s", "c", "v", "a"].includes(showExt) && (
              <div className="mr-3">
                <div className="p-1 text-sm flex items-center justify-between">Type <button><IoInformationCircle onClick={videoFormatInfo}/></button></div>
                <select
                  name="file_ext"
                  id="file_ext"
                  className="p-2.5 rounded-r text-sm"
                  value={fileExt}
                  onChange={handleFileExtChange}
                >
                  {showExt === "c" ? (
                    <>
                      <option value="png">Png</option>
                      <option value="jpeg">Jpeg</option>
                      <option value="webp">webp</option>
                    </>
                  ) : showExt === "a" ? (
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
            )}

            <div className=" mr-3">
              <div className="p-1 text-sm">Recording options</div>
              <select
                name="record_type"
                id="record_type"
                className="p-2.5 rounded-md text-sm "
                value={recordType}
                onChange={handleRecordTypeChange}
              >
                <option value="sva">
                  Screen record(Screen + Video + Audio)
                </option>
                <option value="sa">Screen record(Screen + Audio)</option>
                <option value="va">Screen record(Video and Audio)</option>
                <option value="s">Screen record(Screen only)</option>
                <option value="c">Screenshot</option>
                <option value="v">Video</option>
                <option value="a">Audio</option>
              </select>
            </div>

            
          </div>
         

          <div className="p-2 items-end">
            <div className="justify-end">
              {!isRecording && <button
                // onClick={captureScreenshots}
                // onClick={onStartRecording}
                onClick={()=>openModalScreen()}
                disabled={isRecording}
                className="p-2.5 rounded-md text-sm border mr-2"
              >
                {recordType == "c" ? "Capture" : "Start Recording"}
              </button>}

              {isRecording && (
                <button
                  onClick={handleStopRecording}
                  disabled={!isRecording}
                  className={"p-2.5 rounded-md text-sm bg-white"}
                >
                  Stop Recording
                </button>
              )}
            </div>
            <div className="flex py-2">
              <div>
                <select
                  name="audioDevice"
                  id="audioDevice"
                  className="p-2.5 rounded-md text-sm mr-2"
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

              <div>
                <select
                  name="videoDevice"
                  id="videoDevice"
                   className="p-2.5 rounded-md text-sm"
                  value={videoDevice}
                  onChange={handleVideoDeviceChange}
                >
                  {connectedCameraDevices ? (
                    connectedCameraDevices.map((videoDevice, index) => (
                      <option key={index} value={videoDevice}>
                        {videoDevice}
                      </option>
                    ))
                  ) : (
                    <option value="">No video cameras detected</option>
                  )}
                </select>
              </div>
              <div className="ml-2 align-middle">
                <IoRefresh
                  className="padding-bottom-7 padding-left-10 cursor-pointer"
                  onClick={loadDevices}
                  title="Refresh device list"
                  />
              </div>
            </div>
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
                <span className="text-green-800">
                  {(ramInfo[1] / 1024).toFixed(2)} GB
                </span>
                /
                <span className="text-blue-500">
                  {(ramInfo[0] / 1024).toFixed(2)} GB
                </span>
              </span>
            ) : (
              <span>...</span>
            )}
          </span>
          <OsInfo />
          </div>
          <div className="right-0"><span> <a href="https://x.com/oyewodayo" target="blank">Request feature / Report a bug</a></span></div>
        </div>
      </div>)}
    </div>
    </>
  );
};

export default BottomDocker;
