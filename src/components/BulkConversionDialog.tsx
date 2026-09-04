// components/BulkConversionDialog.tsx
//
// Multi-file counterpart to ConversionDialog.tsx - same format picker/preserve-original checkbox,
// but drives convert_* through every selected file one at a time instead of requiring the user to
// reopen the single-file dialog per file. Sequential (not parallel) because the backend's
// ConversionState tracks exactly one active ffmpeg process app-wide (see conversion.rs's
// ConversionState/cancel_conversion) - running these concurrently would have later invokes
// clobber the process handle earlier ones need for cancel.
import { useRef, useState } from "react";
import { getFileCategory, isConvertibleCategory } from "../utils/fileCategory";
import { CONVERSION_PROFILES, useMediaConversion } from "./ConversionDialog";
import { IoCheckmarkCircle, IoCloseCircle, IoEllipseOutline, IoSyncOutline } from "react-icons/io5";

interface BulkFile {
  path: string;
  name: string;
}

type PerFileStatus = "pending" | "converting" | "done" | "error";

// Rounds to whole seconds before splitting into h/m/s - the per-file timeline list already shows
// sub-second granularity isn't meaningful here (network-free, local disk conversion), and "in 47s"
// reads better than "in 46.8s".
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

interface PerFileResult {
  status: PerFileStatus;
  newPath?: string;
  newName?: string;
  error?: string;
}

export interface BulkConversionSummary {
  // Keyed by original path so the caller can update its file list / selection without re-deriving
  // which entries changed.
  converted: { oldPath: string; newPath: string; newName: string }[];
  failedCount: number;
}

const BulkConversionDialog: React.FC<{
  files: BulkFile[];
  onClose: () => void;
  onDone: (summary: BulkConversionSummary) => void;
}> = ({ files, onClose, onDone }) => {
  const { convertImage, convertVideo, convertAudio, convertToMp4, cancelConversion, conversionProgress, isConverting } =
    useMediaConversion();

  // All selected files always share one category - Dashboard.tsx clears the selection whenever
  // the sidebar tab (Video/Audio/Image/...) changes, so a mixed-category selection can't happen.
  const category = getFileCategory(files[0]?.name ?? "");
  const profile = isConvertibleCategory(category) ? CONVERSION_PROFILES[category] : null;

  const [selectedFormat, setSelectedFormat] = useState<string>(profile?.defaultFormat ?? "");
  const [preserveOriginal, setPreserveOriginal] = useState<boolean>(false);
  const [phase, setPhase] = useState<"configuring" | "converting" | "done">("configuring");
  const [results, setResults] = useState<Record<string, PerFileResult>>({});
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const startTimeRef = useRef<number>(0);

  // Checked between files in the loop below - cancelConversion() only kills whatever ffmpeg
  // process is running *right now*, it can't reach into an in-flight `await` and stop the loop
  // from moving on to the next file.
  const cancelRequestedRef = useRef(false);

  const runAll = async () => {
    if (!profile || !category) return;
    cancelRequestedRef.current = false;
    setPhase("converting");
    setDurationMs(null);
    startTimeRef.current = Date.now();
    setResults(Object.fromEntries(files.map((f) => [f.path, { status: "pending" as PerFileStatus }])));

    for (let i = 0; i < files.length; i++) {
      if (cancelRequestedRef.current) break;
      const file = files[i];
      setCurrentIndex(i);
      setResults((prev) => ({ ...prev, [file.path]: { status: "converting" } }));

      try {
        let newPath: string;
        if (category === "image") {
          newPath = await convertImage(file.path, selectedFormat, undefined, preserveOriginal);
        } else if (category === "audio") {
          newPath = await convertAudio(file.path, selectedFormat, undefined, preserveOriginal);
        } else if (selectedFormat === "mp4") {
          newPath = await convertToMp4(file.path, undefined, preserveOriginal);
        } else {
          newPath = await convertVideo(file.path, selectedFormat, undefined, preserveOriginal);
        }
        const newName = newPath.split(/[\\/]/).pop() ?? file.name.replace(/\.[^/.]+$/, `.${selectedFormat}`);
        setResults((prev) => ({ ...prev, [file.path]: { status: "done", newPath, newName } }));
      } catch (err) {
        setResults((prev) => ({ ...prev, [file.path]: { status: "error", error: String(err) } }));
      }
    }

    setCurrentIndex(-1);
    setDurationMs(Date.now() - startTimeRef.current);
    setPhase("done");
  };

  const handleCancel = async () => {
    if (phase === "converting") {
      cancelRequestedRef.current = true;
      await cancelConversion();
      return;
    }
    onClose();
  };

  const handleFinish = () => {
    const converted: BulkConversionSummary["converted"] = [];
    let failedCount = 0;
    for (const file of files) {
      const result = results[file.path];
      if (result?.status === "done" && result.newPath && result.newName) {
        converted.push({ oldPath: file.path, newPath: result.newPath, newName: result.newName });
      } else if (result?.status === "error") {
        failedCount++;
      }
    }
    onDone({ converted, failedCount });
  };

  if (!profile || !category) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div className="bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 p-6 rounded-lg max-w-md w-full">
          <h3 className="text-lg font-semibold mb-4">Can't Convert These Files</h3>
          <p className="text-sm text-gray-600 dark:text-neutral-400 mb-4">None of the selected files are a type Briefcast can convert.</p>
          <div className="flex justify-end">
            <button onClick={onClose} className="px-4 py-2 text-gray-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded">
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const doneCount = Object.values(results).filter((r) => r.status === "done").length;
  const errorCount = Object.values(results).filter((r) => r.status === "error").length;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 p-6 rounded-lg max-w-md w-full">
        <h3 className="text-lg font-semibold mb-4">
          {profile.dialogTitle} ({files.length} file{files.length === 1 ? "" : "s"})
        </h3>

        {phase === "configuring" && (
          <div className="mb-4">
            <div className="mb-3">
              <label className="block text-sm font-medium mb-1">Output Format</label>
              <select
                value={selectedFormat}
                onChange={(e) => setSelectedFormat(e.target.value)}
                className="w-full border border-gray-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 rounded px-3 py-2"
              >
                {profile.formats.map((fmt) => (
                  <option key={fmt.value} value={fmt.value}>
                    {fmt.label}
                  </option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={preserveOriginal}
                onChange={(e) => setPreserveOriginal(e.target.checked)}
                className="rounded"
              />
              <span>Keep original files</span>
            </label>
          </div>
        )}

        {phase !== "configuring" && (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span>
                {phase === "converting"
                  ? `Converting ${currentIndex + 1} of ${files.length}...`
                  : `Done - ${doneCount} converted${errorCount > 0 ? `, ${errorCount} failed` : ""}${durationMs !== null ? ` in ${formatDuration(durationMs)}` : ""}`}
              </span>
              <span>
                {doneCount + errorCount}/{files.length}
              </span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-neutral-700 rounded-full h-2 mb-3">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${errorCount > 0 && phase === "done" ? "bg-amber-500" : "bg-blue-600"}`}
                style={{ width: `${((doneCount + errorCount) / files.length) * 100}%` }}
              />
            </div>
            {conversionProgress && phase === "converting" && (
              <p className="text-xs text-gray-500 dark:text-neutral-400 mb-3">{conversionProgress.message}</p>
            )}
            <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-neutral-700 rounded divide-y divide-gray-100 dark:divide-neutral-800">
              {files.map((file) => {
                const status = results[file.path]?.status ?? "pending";
                return (
                  <div key={file.path} className="px-3 py-1.5 text-xs">
                    <div className="flex items-center gap-2">
                      {status === "done" && <IoCheckmarkCircle className="text-green-600 shrink-0" size={14} />}
                      {status === "error" && <IoCloseCircle className="text-red-600 shrink-0" size={14} />}
                      {status === "converting" && <IoSyncOutline className="text-blue-600 shrink-0 animate-spin" size={14} />}
                      {status === "pending" && <IoEllipseOutline className="text-neutral-300 dark:text-neutral-600 shrink-0" size={14} />}
                      <span className="truncate flex-1" title={file.name}>
                        {file.name}
                      </span>
                      {status === "error" && <span className="text-red-500 shrink-0">failed</span>}
                    </div>
                    {status === "error" && results[file.path]?.error && (
                      <p className="mt-0.5 pl-[22px] text-[11px] text-red-500/80 break-words">{results[file.path]?.error}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          {phase !== "done" && (
            <button onClick={handleCancel} className="px-4 py-2 text-gray-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded">
              {phase === "converting" ? "Cancel" : "Close"}
            </button>
          )}
          {phase === "configuring" && (
            <button onClick={runAll} disabled={isConverting} className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50 hover:bg-blue-700">
              Convert All
            </button>
          )}
          {phase === "done" && (
            <button onClick={handleFinish} className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default BulkConversionDialog;
