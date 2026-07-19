// components/ConversionDialog.tsx
import { invoke } from "@tauri-apps/api";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { isImageFile } from "../utils/videoUtils";

// Conversion types
interface ConversionProgress {
  input_path: string;
  output_path: string;
  progress: number;
  status: 'starting' | 'processing' | 'completed' | 'failed';
  message: string;
}

// React hook for conversion
export const useVideoConversion = () => {
  const [conversionProgress, setConversionProgress] = useState<ConversionProgress | null>(null);
  const [isConverting, setIsConverting] = useState(false);

  useEffect(() => {
    const setupListener = async () => {
      const unlisten = await listen<ConversionProgress>('conversion-progress', (event) => {
        console.log('Conversion progress:', event.payload);
        setConversionProgress(event.payload);
        
        if (event.payload.status === 'completed' || event.payload.status === 'failed') {
          setIsConverting(false);
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

  const convertToMp4 = async (
    inputPath: string, 
    outputPath?: string,
    preserveOriginal: boolean = true
  ) => {
    setIsConverting(true);
    setConversionProgress(null);
    
    try {
      const result = await invoke<string>('convert_to_mp4', {
        inputPath,
        outputPath: outputPath || null,
        preserveOriginal
      });
      return result;
    } catch (error) {
      console.error('Conversion failed:', error);
      setIsConverting(false);
      throw error;
    }
  };

  const convertVideo = async (
    inputPath: string,
    outputFormat: string,
    outputPath?: string,
    preserveOriginal: boolean = true
  ) => {
    setIsConverting(true);
    setConversionProgress(null);

    try {
      const result = await invoke<string>('convert_video', {
        inputPath,
        outputFormat,
        outputPath: outputPath || null,
        preserveOriginal
      });
      return result;
    } catch (error) {
      console.error('Conversion failed:', error);
      setIsConverting(false);
      throw error;
    }
  };

  const convertImage = async (
    inputPath: string,
    outputFormat: string,
    outputPath?: string,
    preserveOriginal: boolean = true
  ) => {
    setIsConverting(true);
    setConversionProgress(null);

    try {
      const result = await invoke<string>('convert_image', {
        inputPath,
        outputFormat,
        outputPath: outputPath || null,
        preserveOriginal
      });
      return result;
    } catch (error) {
      console.error('Conversion failed:', error);
      setIsConverting(false);
      throw error;
    }
  };

  const cancelConversion = async () => {
    try {
      await invoke('cancel_conversion');
      setIsConverting(false);
      setConversionProgress(null);
    } catch (error) {
      console.error('Failed to cancel conversion:', error);
    }
  };

  return {
    convertToMp4,
    convertVideo,
    convertImage,
    cancelConversion,
    conversionProgress,
    isConverting,
  };
};

const VIDEO_FORMATS = [
  { value: 'mp4', label: 'MP4 (Recommended)' },
  { value: 'mov', label: 'MOV' },
  { value: 'mkv', label: 'MKV' },
  { value: 'avi', label: 'AVI' },
  { value: 'webm', label: 'WebM' },
];

const IMAGE_FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
  { value: 'bmp', label: 'BMP' },
];

// Conversion UI Component
const ConversionDialog: React.FC<{
  filePath: string;
  fileName: string;
  onClose: () => void;
  onConverted: (newPath: string, fileName: string) => void;
}> = ({ filePath, fileName, onClose, onConverted }) => {
  const { convertToMp4, convertVideo, convertImage, cancelConversion, conversionProgress, isConverting } = useVideoConversion();
  const isImage = isImageFile(fileName);
  const formats = isImage ? IMAGE_FORMATS : VIDEO_FORMATS;
  const [selectedFormat, setSelectedFormat] = useState<string>(isImage ? 'png' : 'mp4');
  const [preserveOriginal, setPreserveOriginal] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const handleConvert = async () => {
    setError('');
    try {
      let newPath: string;

      if (isImage) {
        newPath = await convertImage(filePath, selectedFormat, undefined, preserveOriginal);
      } else if (selectedFormat === 'mp4') {
        newPath = await convertToMp4(filePath, undefined, preserveOriginal);
      } else {
        newPath = await convertVideo(filePath, selectedFormat, undefined, preserveOriginal);
      }

      // Extract filename with new extension
      const newFileName = fileName.replace(/\.[^/.]+$/, `.${selectedFormat}`);
      onConverted(newPath, newFileName);

    } catch (error: any) {
      console.error('Conversion failed:', error);
      setError(error.toString());
    }
  };

  const handleCancel = async () => {
    if (isConverting) {
      await cancelConversion();
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 p-6 rounded-lg max-w-md w-full">
        <h3 className="text-lg font-semibold mb-4">{isImage ? 'Convert Image' : 'Convert Video'}</h3>

        <div className="mb-4">
          <p className="text-sm text-gray-600 dark:text-neutral-400 mb-2">
            File: <strong>{fileName}</strong>
          </p>

          {/* Format Selection */}
          <div className="mb-3">
            <label className="block text-sm font-medium mb-1">Output Format</label>
            <select
              value={selectedFormat}
              onChange={(e) => setSelectedFormat(e.target.value)}
              disabled={isConverting}
              className="w-full border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 rounded px-3 py-2"
            >
              {formats.map(fmt => (
                <option key={fmt.value} value={fmt.value}>
                  {fmt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Preserve Original Checkbox */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={preserveOriginal}
              onChange={(e) => setPreserveOriginal(e.target.checked)}
              disabled={isConverting}
              className="rounded"
            />
            <span>Keep original file</span>
          </label>
        </div>

        {/* Progress Display */}
        {conversionProgress && (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="capitalize">{conversionProgress.status}</span>
              <span>{Math.round(conversionProgress.progress)}%</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-neutral-700 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  conversionProgress.status === 'failed' ? 'bg-red-600' :
                  conversionProgress.status === 'completed' ? 'bg-green-600' :
                  'bg-blue-600'
                }`}
                style={{ width: `${conversionProgress.progress}%` }}
              />
            </div>
            <p className="text-sm text-gray-600 dark:text-neutral-400 mt-1">{conversionProgress.message}</p>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded text-sm text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        {/* Buttons */}
        <div className="flex gap-2 justify-end">
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-gray-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded"
          >
            {isConverting ? 'Cancel' : 'Close'}
          </button>
          <button 
            onClick={handleConvert}
            disabled={isConverting}
            className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700"
          >
            {isConverting ? 'Converting...' : 'Convert'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ConversionDialog;