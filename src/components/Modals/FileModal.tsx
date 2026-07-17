import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { emit } from '@tauri-apps/api/event';
import { appWindow } from '@tauri-apps/api/window';
import {
  IoCheckmarkCircle,
  IoDocumentTextOutline,
  IoFilmOutline,
  IoTimeOutline,
  IoServerOutline,
  IoFolderOpenOutline,
} from 'react-icons/io5';
import { open } from '@tauri-apps/api/shell';

interface FileModalProps {
  filePath: string;
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
  <div className="flex items-center justify-between py-2.5 px-3 border-b border-gray-100 last:border-b-0">
    <div className="flex items-center gap-2 text-gray-400">
      {icon}
      <span className="text-sm">{label}</span>
    </div>
    <span className="text-sm font-medium text-gray-800 truncate max-w-[190px]">{value}</span>
  </div>
);

const FileModal = ({ filePath }: FileModalProps) => {
  const [duration, setDuration] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<string | null>(null);
  const [isLoadingInfo, setIsLoadingInfo] = useState(true);

  useEffect(() => {
    if (!filePath) return;
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
  }, [filePath]);

  if (!filePath) return null;

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

  const handleClose = async () => {
    await appWindow.close();
  };

  return (
    <div className="fixed inset-0 flex flex-col bg-white" data-tauri-drag-region>
      <div className="flex-1 flex flex-col items-center px-6 pt-8 pb-4 overflow-hidden">
        <div className="w-16 h-16 rounded-full bg-green-50 flex items-center justify-center mb-3">
          <IoCheckmarkCircle className="text-green-500 text-4xl" />
        </div>
        <h1 className="text-base font-semibold text-gray-900 mb-1">Recording completed</h1>
        <p className="text-xs text-gray-400 mb-5">Your recording has been saved</p>

        <div className="w-full bg-gray-50 rounded-xl mb-4">
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
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors text-left"
          onClick={handleOpenFile}
          title={filePath}
        >
          <IoFolderOpenOutline className="text-gray-400 text-base shrink-0" />
          <span className="text-xs text-gray-500 truncate">{filePath}</span>
        </button>
      </div>

      <div className="flex border-t border-gray-100">
        <button
          className="flex-1 py-3.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors"
          onClick={handleClose}
        >
          Close
        </button>
        <button
          className="flex-1 py-3.5 text-sm font-medium bg-black text-white hover:bg-gray-800 transition-colors"
          onClick={handleConvertFormat}
        >
          Convert format
        </button>
      </div>
    </div>
  );
};

export default FileModal;
