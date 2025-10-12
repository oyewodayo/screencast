import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import BottomDocker from "../components/BottomDocker";
import { listen } from '@tauri-apps/api/event';
import FileModal from "../components/Modals/FileModal";
import { WindowInfo } from "../Types";
import { WebviewWindow } from '@tauri-apps/api/window';

type RAMInfo = [number, number];

const Dashboard = () => {  // REMOVED async - React components cannot be async
  const [lastKeyPressed, setLastKeyPressed] = useState<string>('');
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
  const [windowTitles, setWindowTitles] = useState<WindowInfo[]>([]);
  const [titles, setTitles] = useState<WindowInfo[]>([]);
  const [isMonitoring, setIsMonitoring] = useState<boolean>(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [showFileList, setShowFileList] = useState<boolean>(false);


  // Listen for global key events
  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen('global-key-event', (event) => {
        const keyName = event.payload as string;
        setLastKeyPressed(keyName);
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
        setFilePath(path);

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
    invoke<WindowInfo[]>('capture_window_screenshots_by_title')
      .then((windowTitles) => {
        console.log(windowTitles);
        setWindowTitles(windowTitles);
      })
      .catch(console.error);

    setSelectScreen(true);
  };

  const unSetScreen = () => {
    setSelectScreen(false);
  };

  const handleStartRecording = async (formData: any) => {
    try {
      // Create a Promise that resolves when the audio finishes playing
      const playAudioNotification = () => {
        return new Promise<void>((resolve) => {
          const audio = new Audio("/sounds/icq-modern-notification-sound.mp3");
          audio.onended = () => resolve();
          audio.play().catch(err => {
            console.error("Error playing audio:", err);
            resolve(); // Resolve anyway if audio fails
          });
        });
      };

      // Wait for the audio to finish playing
      await playAudioNotification();

      const response = await invoke<string>("start_recording", { formData });
      setMessage(response);
      setIsRecording(true);
      setError(""); // Clear any previous errors
    } catch (error) {
      console.error("Error starting recording:", error);
      setError(`Failed to start recording: ${error}`);
    }
  };

  const handleStopRecording = async () => {
    try {
      setError("");
      const response = await invoke<string>("stop_recording");
      
      const audio = new Audio("/sounds/option-3.mp3");
      audio.play().catch(err => console.error("Error playing audio:", err));
      
      setFilePath(response);
      setMessage(response);
      setIsRecording(false);
      
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
  const toggleFileList = () => setShowFileList(prev => !prev);

  return (
    <div className="w-full h-screen flex flex-col">
      <div className="p-">
        <div className="flex justify-between">
          {/* File list sidebar */}
          <div
            className={`h-screen light border-b border-gray-300 rounded-tr-lg bg-gray-200 border-2 transition-all duration-300 overflow-hidden ${
              showFileList ? "w-[250px] opacity-100" : "w-0 opacity-0"
            }`}
          >
            {showFileList && (
              <div className="p-3 text-sm">
                files list here
              </div>
            )}
          </div>

          <div>
              {/* Content page. */}
              This is content page
          </div>
          <div className="">
            <div>
              <img src="screencast.png" width={55} alt="Briefcast Logo" />
            </div>
            <div className="text-[12px] text-center  -mt-2.5">
              Briefcast
            </div>
          </div>
        </div>
        <div>
       </div>
      </div>
      

      <BottomDocker
        selectScreen={selectScreen}
        setScreen={setScreen}
        unSetScreen={unSetScreen}
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
      <div>
        {/* {filePath && <FileModal filePath={filePath} setFilePath={setFilePath} />} */}
      </div>
    </div>
  );
};

export default Dashboard;