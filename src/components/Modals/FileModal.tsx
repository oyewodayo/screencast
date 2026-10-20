import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
  IoCheckmarkCircle,
  IoDocumentTextOutline,
  IoFilmOutline,
  IoTimeOutline,
  IoServerOutline,
  IoFolderOpenOutline,
  IoPlay,
  IoAlertCircle,
} from 'react-icons/io5';
import { open } from '@tauri-apps/plugin-shell';
const appWindow = getCurrentWebviewWindow()

// "processing": Stop was pressed and the window is shown straight away, while the backend is still
// cleaning the audio and assembling the file - which takes a while for a long recording, and with
// nothing on screen the first Stop looked ignored. The backend reloads this window as "done" (or
// "failed") when it finishes - see stop_recording's finish_recording_modal.
export type RecordingModalStatus = "processing" | "done" | "failed";

interface FileModalProps {
  filePath: string;
  status?: RecordingModalStatus;
  error?: string;
}

const formatDuration = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const InfoRow = ({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) => (
  <div className="flex items-center justify-between py-2.5 px-3 border-b border-gray-100 dark:border-neutral-800 last:border-b-0">
    <div className="flex items-center gap-2 text-gray-400 dark:text-neutral-500">
      {icon}
      <span className="text-sm">{label}</span>
    </div>
    <span className="text-sm font-medium text-gray-800 dark:text-neutral-200 truncate max-w-[190px]">{value}</span>
  </div>
);

const FileModal = ({ filePath, status = "done", error }: FileModalProps) => {
  const [duration, setDuration] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<string | null>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(true);

  useEffect(() => {
    if (!filePath || status !== "done") return;
    invoke<Record<string, string>>('get_conversion_info', { inputPath: filePath })
      .then((info) => {
        if (info.duration) {
          const seconds = parseFloat(info.duration);
          if (!Number.isNaN(seconds)) setDuration(formatDuration(seconds));
        }
        if (info.input_size) setFileSize(info.input_size);
      })
      .catch((error) => console.error('Failed to load recording info:', error))
      .finally(() => setIsLoadingInfo(false));
  }, [filePath, status]);

  if (!filePath && status !== "failed") return null;

  const fileName = filePath.split(/[\\/]/).pop() || filePath;
  const dotIndex = fileName.lastIndexOf('.');
  const fileType = dotIndex > 0 ? fileName.slice(dotIndex + 1).toUpperCase() : 'Unknown';

  const handleOpenFile = async () => {
    await open(filePath);
  };

  const handleConvertFormat = async () => {
    // This modal runs in its own Tauri window (see src-tauri/src/views/completed_recording.*),
    // so opening the conversion UI means asking the main window to do it, then closing this one.
    await emit('open-conversion-dialog', filePath);
    await appWindow.close();
  };

  // Plays the recording in Briefcast itself rather than handing it to whatever the OS has
  // registered for the extension - the file-path button above already covers "open it elsewhere",
  // and staying in the app is what makes the editor and its tools reachable from here.
  //
  // Same shape as handleConvertFormat: this window can't host the player, so it asks the main
  // window to load the file and then gets out of the way.
  const handlePlay = async () => {
    await emit('open-recording-playback', filePath);
    await appWindow.close();
  };

  const handleClose = async () => {
    await appWindow.close();
  };

  if (status !== "done") {
    const processing = status === "processing";
    return (
      <div className="fixed inset-0 flex flex-col bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100" data-tauri-drag-region>
        <div className="flex-1 flex flex-col items-center justify-center px-8 text-center" data-tauri-drag-region>
          {processing ? (
            <div className="w-16 h-16 mb-4 rounded-full border-[3px] border-gray-200 dark:border-neutral-700 border-t-blue-500 animate-spin" />
          ) : (
            <div className="w-16 h-16 mb-3 rounded-full bg-red-50 dark:bg-red-500/10 flex items-center justify-center">
              <IoAlertCircle className="text-red-500 text-4xl" />
            </div>
          )}
          <h1 className="text-base font-semibold mb-1.5">{processing ? "Finishing your recording…" : "Recording couldn't be saved"}</h1>
          <p className="text-xs leading-relaxed text-gray-500 dark:text-neutral-400 max-w-[300px]">
            {processing
              ? "Cleaning up the audio and putting the video together. Long recordings can take a minute or two - you can close this, and the file will appear in your library when it's ready."
              : error || "Something went wrong while saving the recording."}
          </p>
          {fileName && processing && <p className="mt-4 text-[11px] font-mono text-gray-400 dark:text-neutral-500 truncate max-w-full">{fileName}</p>}
        </div>
        <div className="flex border-t border-gray-100 dark:border-neutral-800">
          <button
            className="flex-1 py-3.5 text-sm font-medium text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors"
            onClick={handleClose}
          >
            {processing ? "Hide" : "Close"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100" data-tauri-drag-region>
      <div className="flex-1 flex flex-col items-center px-6 pt-8 pb-4 overflow-hidden">
        <div className="w-16 h-16 rounded-full bg-green-50 dark:bg-green-500/10 flex items-center justify-center mb-3">
          <IoCheckmarkCircle className="text-green-500 text-4xl" />
        </div>
        <h1 className="text-base font-semibold text-gray-900 dark:text-neutral-100 mb-1">Recording completed</h1>
        <p className="text-xs text-gray-400 dark:text-neutral-500 mb-5">Your recording has been saved</p>

        <div className="w-full bg-gray-50 dark:bg-neutral-800 rounded-xl mb-4">
          <InfoRow icon={<IoDocumentTextOutline className="text-base" />} label="File name" value={fileName} />
          <InfoRow icon={<IoFilmOutline className="text-base" />} label="Type" value={fileType} />
          <InfoRow
            icon={<IoTimeOutline className="text-base" />}
            label="Duration"
            value={isLoadingInfo ? 'Loading…' : duration ?? 'Unknown'}
          />
          {fileSize && (
            <InfoRow icon={<IoServerOutline className="text-base" />} label="Size" value={fileSize} />
          )}
        </div>

        <button
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 dark:border-neutral-700 hover:border-gray-300 dark:hover:border-neutral-600 hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors text-left"
          onClick={handleOpenFile}
          title={filePath}
        >
          <IoFolderOpenOutline className="text-gray-400 dark:text-neutral-500 text-base shrink-0" />
          <span className="text-xs text-gray-500 dark:text-neutral-400 truncate">{filePath}</span>
        </button>
      </div>

      <div className="flex border-t border-gray-100 dark:border-neutral-800">
        <button
          className="flex-1 py-3.5 text-sm font-medium text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors"
          onClick={handleClose}
        >
          Close
        </button>
        <button
          className="flex-1 flex items-center justify-center gap-1.5 py-3.5 text-sm font-medium text-gray-700 dark:text-neutral-200 border-l border-gray-100 dark:border-neutral-800 hover:bg-gray-50 dark:hover:bg-neutral-800 transition-colors"
          onClick={handlePlay}
        >
          <IoPlay className="text-base" />
          Play
        </button>
        <button
          className="flex-1 py-3.5 text-sm font-medium bg-black dark:bg-neutral-100 text-white dark:text-neutral-900 hover:bg-gray-800 dark:hover:bg-white transition-colors"
          onClick={handleConvertFormat}
        >
          Convert format
        </button>
      </div>
    </div>
  );
};

export default FileModal;
