import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import BottomDocker from "./components/BottomDocker";

type RAMInfo = [number, number];
function App() {

  const [message, setMessage] = useState<string>("");
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  const [ramInfo, setRamInfo] = useState<RAMInfo | null>(null);
  const [fileName, setFileName] = useState("Recording_"+new Date().toLocaleDateString().replace(/\//g, "_"));
  const [fileExt, setFileExt] = useState("avi");
  const [recordType, setRecordType] = useState("sva");
  const [audioDevice, setAudioDevice] = useState("");
  const [videoDevice, setVideoDevice] = useState("");

  useEffect(() => {
    invoke<RAMInfo>('get_ram_info')
      .then(setRamInfo)
      .catch(console.error);
  }, []);




  const handleStartRecording = async (formData: any) => {
    try {
      setError("");
      const response = await invoke<string>("start_recording", { formData });
      setMessage(response);
      setIsRecording(true);
    } catch (error) {
      console.error("Error starting recording:", error);
      setError(`Failed to start recording: ${error}`);
    }
  };

  const handleStopRecording = async () => {
    try {
      setError("");
      const formData = {
        file_name: fileName,
        file_ext: fileExt,
        record_type: recordType,
        audio_device:audioDevice,
        video_device:videoDevice
      };
      const response = await invoke<string>("stop_recording", formData);
      setMessage(response);
      setIsRecording(false);
    } catch (error) {
      console.error("Error stopping recording:", error);
      setError(`Failed to stop recording: ${error}`);
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  return (

    <div className="w-full h-screen flex flex-col">
      <div className="p-4">
        <div className="flex justify-end text-center">
          <div className="">
            <div>
              <img src="screencast.png" width={55}></img>
            </div>
            <div className="text-[12px] -mt-2.5">
              Briefcast
            </div>
          </div>


          {/* {message && <p className="message text-right">{message}</p>}
          {error && <p className="error text-right">{error}</p>} */}
        </div>
        <div>
          {/* Content page. */}
        </div>
      </div>

      <BottomDocker
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

      />

    </div>

  );
}

export default App;
