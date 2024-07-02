import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import BottomDocker from "./components/BottomDocker";


type RAMInfo = [number, number];
function App() {
  const [message, setMessage] = useState<string>("");
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [elapsedTime, setElapsedTime] = useState<number>(0);

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




  useEffect(() => {
    let interval: number | undefined;
    if (isRecording) {
      interval = window.setInterval(() => {
        setElapsedTime((prevTime) => prevTime + 1);
      }, 1000);
    } else {
      setElapsedTime(0);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  const handleStartRecording = async (formData: any) => {
    try {
      setError("");
      console.log(formData)
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

    <div className="m-0 pt-2vh flex flex-col justify-center text-center">
      <div className="section">
        <div className="section-head">
          <div className="">
            <div>
            <img src="screencast.png" width={55}></img>
            </div>
            <div className="font-size-12 align-left margin-top-n20 margin-right-5">
              Briefcast
            </div>
          </div>

          {isRecording && (
            <div className="recording-indicator text-right">
              <span className="record-icon"></span>
              Recording: {formatTime(elapsedTime)}
            </div>
          )}
          {message && <p className="message text-right">{message}</p>}
          {error && <p className="error text-right">{error}</p>}
        </div>
        <div>
       
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
      />

    </div>

  );
}

export default App;
