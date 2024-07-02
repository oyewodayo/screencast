import React, { useEffect, useState } from "react";
import OsInfo from "./OsInfo";
import {
  IoMicCircle,
  IoRefresh,
  IoScanSharp,
  IoSettingsSharp,
  IoVideocam,
  IoVideocamSharp,
} from "react-icons/io5";
import { message } from "@tauri-apps/api/dialog";
import { invoke } from "@tauri-apps/api/tauri";

interface Props {
  handleStartRecording: (formData: {
    file_name: string;
    file_ext: string;
    record_type: string;
    audio_device: string;
    video_device: string;
  }) => void;
  handleStopRecording: () => void;
  isRecording: boolean;
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
}
type ConnectedDevice = string[];
const BottomDocker = ({
  handleStartRecording,
  handleStopRecording,
  isRecording,
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
}: Props) => {
  const [showExt, setShowExt] = useState("sva");
  const [connectedAudioDevices, setConnectedAudioDevices] =
    useState<ConnectedDevice | null>(null);
  const [connectedCameraDevices, setConnectedCameraDevices] =
    useState<ConnectedDevice | null>(null);

  useEffect(() => {
    invoke<ConnectedDevice>("get_connected_audios")
      .then((devices) => {
        setConnectedAudioDevices(devices);
        if (devices.length > 0) {
          setAudioDevice(devices[0]); // Set default audio device
        }
      })
      .catch(console.error);
  }, []);

  useEffect(() => {
    invoke<ConnectedDevice>("get_connected_cameras")
      .then((devices) => {
        setConnectedCameraDevices(devices);
        if (devices.length > 0) {
          setVideoDevice(devices[0]);
        }
      })
      .catch(console.error);
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
        setFileExt("mp4");
        break;
    }
  }, [recordType]);

  const handleRecordTypeChange = (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    console.log(event.target.value);
    console.log(fileExt);
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
      video_device: videoDevice,
    };
    console.log(formData);
    handleStartRecording(formData);
  };

  const handleSettingsPage = async () => {
    return await message("Settings", "Message");
  };

  return (
    <div className="main-dock-container">
      {recordType == "sva" && (
        <div className="align-right">
          <IoScanSharp
            className={
              isRecording ? `text-green padding-right-10` : `padding-right-10`
            }
          />
          <IoVideocam
            className={
              isRecording ? `text-green padding-right-10` : `padding-right-10`
            }
          />
          <IoMicCircle className={isRecording ? `text-green` : ``} />
        </div>
      )}
      {recordType == "sa" && (
        <div className="align-right">
          <IoScanSharp
            className={
              isRecording ? `text-green padding-right-10` : `padding-right-10`
            }
          />
          <IoMicCircle className={isRecording ? `text-green` : ``} />
        </div>
      )}
      {recordType == "va" && (
        <div className="align-right">
          <IoVideocamSharp
            className={
              isRecording ? `text-green padding-right-10` : `padding-right-10`
            }
          />
          <IoMicCircle className={isRecording ? `text-green` : ``} />
        </div>
      )}
      {recordType == "s" && (
        <div className="align-right">
          <IoScanSharp
            className={
              isRecording ? `text-green padding-right-10` : `padding-right-10`
            }
          />
        </div>
      )}
      {recordType == "v" && (
        <div className="align-right">
          <IoVideocamSharp
            className={
              isRecording ? `text-green padding-right-10` : `padding-right-10`
            }
          />
        </div>
      )}
      {recordType == "a" && (
        <div className="align-right">
          <IoMicCircle
            className={
              isRecording ? `text-green padding-right-10` : `padding-right-10`
            }
          />
        </div>
      )}
      {recordType == "c" && (
        <div className="align-right">
          <IoScanSharp
            className={
              isRecording ? `text-green padding-right-10` : `padding-right-10`
            }
          />
        </div>
      )}
      <div className="main-dock">
        <div className="docking-container">
          <div className="recording h">
            <div>
              <div className="label item">Save file as</div>
              <input
                type="text"
                className="file_name"
                name="file_name"
                id="file_name"
                value={fileName}
                onChange={handleFileNameChange}
                placeholder={"Recording-" + Date()}
              />
            </div>
            {["sva", "sa", "va", "s", "c", "v", "a"].includes(showExt) && (
              <div>
                <div className="label">Type</div>
                <select
                  name="file_ext"
                  id="file_ext"
                  className="file_ext"
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
                      <option value="mp4">Mp4</option>
                      <option value="avi">Avi</option>
                      <option value="webm">webm</option>
                      <option value="mov">Mov</option>
                    </>
                  )}
                </select>
              </div>
            )}

            <div className="margin-left-10">
              <div className="label">Recording options</div>
              <select
                name="record_type"
                id="record_type"
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
            <div className="flex-end">
              <IoSettingsSharp
                onClick={handleSettingsPage}
                className="padding-left-20 padding-bottom-7 font-size-22 cursor-pointer"
              />
            </div>
          </div>

          <div className="docking-right">
            <div className="margin-bottom-10">
              <button
                onClick={onStartRecording}
                disabled={isRecording}
                className={isRecording ? "disabled" : "active"}
              >
                {recordType == "c" ? "Capture" : "Start Recording"}
              </button>
              {isRecording && (
                <button
                  onClick={handleStopRecording}
                  disabled={!isRecording}
                  className={!isRecording ? "disabled" : "active"}
                >
                  Stop Recording
                </button>
              )}
            </div>
            <div className="d-flex">
              <div>
                <select
                  name="audioDevice"
                  id="audioDevice"
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
              <div className="flex-end ">
                <IoRefresh className="padding-bottom-7 padding-left-10 cursor-pointer" />
              </div>
            </div>
          </div>
        </div>

        <div className="system-info font-size-12 bg-b">
          <span>{Date()}</span>

          <span className="cpu-info">
            {" "}
            | CPU RAM:{" "}
            {ramInfo ? (
              <span>
                {" "}
                <span className="text-green">
                  {(ramInfo[1] / 1024).toFixed(2)} GB
                </span>{" "}
                /
                <span className="text-blue">
                  {(ramInfo[0] / 1024).toFixed(2)} GB
                </span>
              </span>
            ) : (
              <span>...</span>
            )}
          </span>

          <OsInfo />
        </div>
      </div>
    </div>
  );
};

export default BottomDocker;
