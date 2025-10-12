import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { IoCheckmarkDoneCircle } from 'react-icons/io5';
import { open } from '@tauri-apps/api/shell';

interface FileModalProps {
  filePath: string;
  setFilePath: (path: string | null) => void;
}

const FileModal = ({ filePath, setFilePath }:FileModalProps) => {
  const [fileName, setFileName] = useState<string>('');
  const [fileExtension, setFileExtension] = useState<string>('');

  useEffect(() => {
    const unlistenPromise = listen<string>('display-file-modal', (event) => {
      console.log("Received file path in FileModal:", event.payload);
      setFilePath(event.payload);
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  const updateFileInfo = (path: string) => {
    setFilePath(path);
    const pathParts = path.split('\\');
    const fullFileName = pathParts[pathParts.length - 1];
    const [name, ext] = fullFileName.split('.');
    setFileName(name);
    setFileExtension(ext);
  };

  const handleFileNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFileName(e.target.value);
  };

  const handleOpenFile = async () => {
    if (filePath) {
      await open(filePath);
    }
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

          <div className="flex justify-center items-center mb-4">
            <input
              type="text"
              name="file_name"
              value={fileName}
              onChange={handleFileNameChange}
              className="p-2 border rounded-l outline-none"
            />
            <span className="p-2 border border-l-0 rounded-r bg-gray-100">
              .{fileExtension}
            </span>
          </div>

          <div className="flex justify-center space-x-4">
            <button
              className="bg-black text-white px-5 py-2 rounded-l hover:bg-gray-800"
              onClick={handleOpenFile}
            >
              Open
            </button>
            <button
              className="bg-black text-white px-5 py-2 rounded-r hover:bg-gray-800"
              onClick={() => setFilePath(null)}
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
