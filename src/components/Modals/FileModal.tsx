import { useEffect } from 'react';
import { listen, emit } from '@tauri-apps/api/event';
import { appWindow } from '@tauri-apps/api/window';
import { IoCheckmarkDoneCircle } from 'react-icons/io5';
import { open } from '@tauri-apps/api/shell';

interface FileModalProps {
  filePath: string;
  setFilePath: (path: string | null) => void;
}

const FileModal = ({ filePath, setFilePath }:FileModalProps) => {
  useEffect(() => {
    const unlistenPromise = listen<string>('display-file-modal', (event) => {
      console.log("Received file path in FileModal:", event.payload);
      setFilePath(event.payload);
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  const handleOpenFile = async () => {
    if (filePath) {
      await open(filePath);
    }
  };

  const handleConvertFormat = async () => {
    if (!filePath) return;
    // This modal runs in its own Tauri window (see src-tauri/src/views/completed_recording.*),
    // so opening the conversion UI means asking the main window to do it, then closing this one.
    await emit('open-conversion-dialog', filePath);
    await appWindow.close();
  };

  if (!filePath) return null;

  return (
    <div className="fixed inset-0 flex items-center justify-center" data-tauri-drag-region>
      <div className="bg-white rounded-lg w-[100vw] h-[100vh] max-w-2xl">
        <div className="p-6 text-center">
          <IoCheckmarkDoneCircle className="text-green-500 text-6xl mx-auto mb-4" />
          <p className="mb-2">Recording completed</p>
          <p>
            Recording saved to: 
            <a href={`file://${filePath}`}
               onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
                 e.preventDefault();
                 open(filePath);
               }} target="_blank">
              {filePath}
            </a>
          </p>

          <div className="flex justify-center space-x-4 mt-4">
            <button
              className="bg-black text-white px-5 py-2 rounded-l hover:bg-gray-800"
              onClick={handleOpenFile}
            >
              Open
            </button>
            <button
              className="bg-black text-white px-5 py-2 rounded-r hover:bg-gray-800"
              onClick={handleConvertFormat}
            >
              Convert format
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FileModal;
