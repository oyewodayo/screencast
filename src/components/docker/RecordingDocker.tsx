// components/docker/RecordingDocker.tsx
import React from "react";
import { IoInformationCircle, IoRefresh } from "react-icons/io5";

interface RecordingDockerProps {
  fileName: string;
  onFileNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  fileExt: string;
  onFileExtChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onShowVideoFormatInfo: () => void;
  recordType: string;
  onRecordTypeChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  audioDevice: string;
  onAudioDeviceChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  connectedAudioDevices: string[] | null;
  connectedCameraDevices: string[] | null;
  videoDevices: string[];
  onToggleVideoDevice: (device: string) => void;
  onRefreshDevices: () => void;
  // WASAPI loopback ("what you hear") capture, Windows-only - only offered for the screen-
  // capture record types (sva/sa/s), see this component's own render logic below and
  // start_recording's handling of FormData.include_system_audio on the backend.
  includeSystemAudio: boolean;
  onToggleIncludeSystemAudio: () => void;
  isRecording: boolean;
  onScreenshotClick: () => void;
  onStartRecordingClick: () => void;
  onStopRecordingClick: () => void;
}

// The default docker content: screen/video/audio recording setup. This is exactly what used to
// be BottomDocker's inline `scopedDocker()` closure, pulled out into its own component so
// BottomDocker can act as a plain switcher between this and FileToolsDocker (see dockerMode in
// Dashboard.tsx) instead of only ever having one thing to show.
const RecordingDocker: React.FC<RecordingDockerProps> = ({
  fileName,
  onFileNameChange,
  fileExt,
  onFileExtChange,
  onShowVideoFormatInfo,
  recordType,
  onRecordTypeChange,
  audioDevice,
  onAudioDeviceChange,
  connectedAudioDevices,
  connectedCameraDevices,
  videoDevices,
  onToggleVideoDevice,
  onRefreshDevices,
  includeSystemAudio,
  onToggleIncludeSystemAudio,
  isRecording,
  onScreenshotClick,
  onStartRecordingClick,
  onStopRecordingClick,
}) => {
  return (
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
            onChange={onFileNameChange}
            placeholder={"Recording-" + Date()}
          />
        </div>

        <div>
          <div className="p-1 text-sm flex items-center justify-between">
            Type{" "}
            <button type="button">
              <IoInformationCircle onClick={onShowVideoFormatInfo} />
            </button>
          </div>
          <select
            name="file_ext"
            id="file_ext"
            className="p-2.5 rounded-r text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700"
            value={fileExt}
            onChange={onFileExtChange}
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
            onChange={onRecordTypeChange}
          >
            <option value="sva">Screen record(Screen + Video + Audio)</option>
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
            onChange={onAudioDeviceChange}
          >
            {connectedAudioDevices ? (
              connectedAudioDevices.map((device, index) => (
                <option key={index} value={device}>
                  {device}
                </option>
              ))
            ) : (
              <option value="">No audio device detected</option>
            )}
          </select>
        </div>

        {/* Only meaningful for the screen-capture record types - "va"/"v"/"a" don't grab the
            screen at all, so there's no "what's playing while I record" scenario for them. */}
        {(recordType === "sva" || recordType === "sa" || recordType === "s") && (
          <div>
            <div className="p-1 text-sm">&nbsp;</div>
            <label
              title="Captures whatever's playing through your speakers (e.g. a video open in another app) via WASAPI loopback, alongside the screen capture. Windows only."
              className="flex items-center gap-2 h-[42px] px-2.5 rounded-md text-sm bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-700 cursor-pointer"
            >
              <input type="checkbox" checked={includeSystemAudio} onChange={onToggleIncludeSystemAudio} />
              System audio
            </label>
          </div>
        )}

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
                      onChange={() => onToggleVideoDevice(device)}
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
            onClick={onRefreshDevices}
            title="Refresh device list"
            className="p-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
          >
            <IoRefresh />
          </button>
        </div>
      </div>

      <div className="flex items-end gap-2">
        <button
          onClick={onScreenshotClick}
          disabled={isRecording}
          className="p-2.5 rounded-md text-sm border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-100 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Screenshot
        </button>

        {!isRecording ? (
          <button
            onClick={onStartRecordingClick}
            className="p-2.5 rounded-md text-sm bg-black dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-gray-800 dark:hover:bg-white"
          >
            Start Recording
          </button>
        ) : (
          <button
            onClick={onStopRecordingClick}
            className="p-2.5 rounded-md text-sm bg-black dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-gray-800 dark:hover:bg-white"
          >
            Stop Recording
          </button>
        )}
      </div>
    </div>
  );
};

export default RecordingDocker;
