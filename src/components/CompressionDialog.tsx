// src/components/CompressionDialog.tsx
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  IoContractOutline,
  IoCheckmarkCircleOutline,
  IoAlertCircleOutline,
  IoOptionsOutline,
  IoRemoveOutline,
  IoExpandOutline,
  IoClose,
} from "react-icons/io5";
import { getFileCategory } from "../utils/fileCategory";

export interface CompressionResult {
  outputPath: string;
  newFileName: string;
  originalSize: number;
  compressedSize: number;
}

interface ConversionProgress {
  input_path: string;
  output_path: string;
  progress: number;
  status: "starting" | "processing" | "completed" | "failed";
  message: string;
}

export type CompressionLevel = "balanced" | "high" | "light";

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes <= 0) return "0 B";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export const useMediaCompression = () => {
  const [compressionProgress, setCompressionProgress] = useState<ConversionProgress | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    const setupListener = async () => {
      unlistenFn = await listen<ConversionProgress>("conversion-progress", (event) => {
        setCompressionProgress(event.payload);
        if (event.payload.status === "completed" || event.payload.status === "failed") {
          setIsCompressing(false);
        }
      });
    };
    void setupListener();
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const compressFile = async (params: {
    inputPath: string;
    quality?: CompressionLevel;
    resolution?: string;
    maxDimension?: number;
    outputFormat?: string;
    outputPath?: string;
    preserveOriginal: boolean;
  }): Promise<CompressionResult> => {
    setIsCompressing(true);
    setCompressionProgress(null);
    try {
      const result = await invoke<CompressionResult>("compress_file", {
        inputPath: params.inputPath,
        quality: params.quality ?? "balanced",
        resolution: params.resolution ?? null,
        maxDimension: params.maxDimension ?? null,
        outputFormat: params.outputFormat ?? null,
        outputPath: params.outputPath ?? null,
        preserveOriginal: params.preserveOriginal,
      });
      return result;
    } catch (err) {
      setIsCompressing(false);
      throw err;
    }
  };

  const cancelCompression = async () => {
    try {
      await invoke("cancel_conversion");
      setIsCompressing(false);
      setCompressionProgress(null);
    } catch (err) {
      console.error("Failed to cancel compression:", err);
    }
  };

  return {
    compressFile,
    cancelCompression,
    compressionProgress,
    isCompressing,
  };
};

interface CompressionDialogProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
  onCompressed: (newPath: string, newFileName: string) => void;
}

const CompressionDialog: React.FC<CompressionDialogProps> = ({
  filePath,
  fileName,
  onClose,
  onCompressed,
}) => {
  const { compressFile, cancelCompression, compressionProgress, isCompressing } = useMediaCompression();
  const category = getFileCategory(fileName);

  const [quality, setQuality] = useState<CompressionLevel>("balanced");
  const [resolution, setResolution] = useState<string>("original");
  const [maxDimension, setMaxDimension] = useState<string>("original");
  const [outputFormat, setOutputFormat] = useState<string>("same");
  const [preserveOriginal, setPreserveOriginal] = useState<boolean>(true);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [originalSizeBytes, setOriginalSizeBytes] = useState<number | null>(null);
  const [completedResult, setCompletedResult] = useState<CompressionResult | null>(null);
  const [error, setError] = useState<string>("");
  const [isMinimized, setIsMinimized] = useState<boolean>(false);

  useEffect(() => {
    // Probe original file size
    invoke<{ size?: number }>("get_file_info", { path: filePath })
      .then((info) => {
        if (info && typeof info.size === "number") {
          setOriginalSizeBytes(info.size);
        }
      })
      .catch(() => {
        // Fallback: file info not available or non-critical
      });
  }, [filePath]);

  const handleCompress = async () => {
    setError("");
    try {
      const dimensionNum = maxDimension !== "original" ? parseInt(maxDimension, 10) : undefined;
      const fmt = outputFormat !== "same" ? outputFormat : undefined;
      const res = resolution !== "original" ? resolution : undefined;

      const result = await compressFile({
        inputPath: filePath,
        quality,
        resolution: res,
        maxDimension: dimensionNum,
        outputFormat: fmt,
        preserveOriginal,
      });

      setCompletedResult(result);
    } catch (err: any) {
      console.error("Compression failed:", err);
      setError(typeof err === "string" ? err : err?.message || String(err));
    }
  };

  const handleCancelOrClose = async () => {
    if (isCompressing) {
      await cancelCompression();
    }
    if (completedResult) {
      onCompressed(completedResult.outputPath, completedResult.newFileName);
    } else {
      onClose();
    }
  };

  const categoryTitle =
    category === "video"
      ? "Compress Video"
      : category === "image"
      ? "Compress Image"
      : category === "audio"
      ? "Compress Audio"
      : "Compress File";

  if (isMinimized) {
    return (
      <div
        className="fixed bottom-14 right-6 z-50 animate-in slide-in-from-bottom-5 fade-in duration-200 select-none pointer-events-auto"
        role="region"
        aria-label="Background Compression"
      >
        <div className="bg-white/95 dark:bg-neutral-900/95 text-neutral-900 dark:text-neutral-100 w-80 max-w-[calc(100vw-3rem)] p-3 rounded-2xl shadow-2xl border border-neutral-200/90 dark:border-neutral-700/90 backdrop-blur-md ring-1 ring-black/5 flex flex-col gap-2">
          {/* Header row */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                  completedResult
                    ? "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    : error
                    ? "bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400"
                    : "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                }`}
              >
                {completedResult ? (
                  <IoCheckmarkCircleOutline size={16} />
                ) : error ? (
                  <IoAlertCircleOutline size={16} />
                ) : (
                  <IoContractOutline size={15} className="animate-pulse" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold truncate max-w-[145px]">{fileName}</span>
                  {isCompressing && compressionProgress && (
                    <span className="text-[11px] font-bold text-blue-600 dark:text-blue-400">
                      {Math.round(compressionProgress.progress)}%
                    </span>
                  )}
                  {completedResult && (
                    <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                      Done
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-neutral-500 dark:text-neutral-400 truncate">
                  {completedResult
                    ? `Saved ${formatBytes(completedResult.originalSize - completedResult.compressedSize)}`
                    : error
                    ? "Compression failed"
                    : compressionProgress?.message || "Compressing in background…"}
                </p>
              </div>
            </div>

            {/* Header controls: Expand & Cancel/Close */}
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setIsMinimized(false)}
                title="Expand compression dialog"
                className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                <IoExpandOutline size={13} />
              </button>
              <button
                type="button"
                onClick={handleCancelOrClose}
                title={completedResult ? "Done" : isCompressing ? "Cancel compression" : "Close"}
                className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                <IoClose size={15} />
              </button>
            </div>
          </div>

          {/* Progress bar while compressing */}
          {isCompressing && compressionProgress && (
            <div className="w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-1.5 overflow-hidden">
              <div
                className="h-1.5 rounded-full bg-gradient-to-r from-blue-600 to-indigo-500 transition-all duration-300"
                style={{ width: `${Math.min(100, Math.max(0, compressionProgress.progress))}%` }}
              />
            </div>
          )}

          {/* Completed action row */}
          {completedResult && (
            <div className="flex items-center justify-between pt-1 border-t border-neutral-100 dark:border-neutral-800 text-xs">
              <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
                {Math.round(((completedResult.originalSize - completedResult.compressedSize) / completedResult.originalSize) * 100)}% smaller
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onCompressed(completedResult.outputPath, completedResult.newFileName)}
                  className="px-2.5 py-1 text-xs font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 shadow-sm transition-all"
                >
                  Open File
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-2 py-1 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          if (isCompressing) {
            setIsMinimized(true);
          } else {
            handleCancelOrClose();
          }
        }
      }}
    >
      <div className="bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 p-6 rounded-2xl shadow-2xl max-w-lg w-full border border-neutral-200 dark:border-neutral-800 transition-all animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400 shrink-0">
              <IoContractOutline size={22} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-lg font-semibold leading-tight">{categoryTitle}</h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5">
                {fileName}
                {originalSizeBytes !== null && (
                  <span className="ml-2 font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 px-1.5 py-0.5 rounded text-[11px]">
                    {formatBytes(originalSizeBytes)}
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setIsMinimized(true)}
              title="Minimize to background"
              className="w-8 h-8 flex items-center justify-center rounded-xl text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <IoRemoveOutline size={18} />
            </button>
            <button
              type="button"
              onClick={handleCancelOrClose}
              title={completedResult ? "Done" : isCompressing ? "Cancel" : "Close"}
              className="w-8 h-8 flex items-center justify-center rounded-xl text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            >
              <IoClose size={18} />
            </button>
          </div>
        </div>

        {/* Completion Success Banner */}
        {completedResult && (
          <div className="mb-5 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/20 text-emerald-900 dark:text-emerald-300">
            <div className="flex items-center gap-2 font-semibold text-sm mb-1.5">
              <IoCheckmarkCircleOutline size={18} className="text-emerald-600 dark:text-emerald-400" />
              <span>Compression Complete!</span>
            </div>
            <div className="text-xs text-emerald-800/90 dark:text-emerald-300/90 flex flex-wrap gap-x-4 gap-y-1">
              <span>Original: <strong>{formatBytes(completedResult.originalSize)}</strong></span>
              <span>→</span>
              <span>Compressed: <strong>{formatBytes(completedResult.compressedSize)}</strong></span>
              {completedResult.originalSize > completedResult.compressedSize && (
                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                  (Saved {formatBytes(completedResult.originalSize - completedResult.compressedSize)},{" "}
                  {Math.round(((completedResult.originalSize - completedResult.compressedSize) / completedResult.originalSize) * 100)}% smaller)
                </span>
              )}
            </div>
          </div>
        )}

        {/* Options (Hidden while completed) */}
        {!completedResult && (
          <div className="space-y-4 mb-5">
            {/* Compression Preset Selection */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
                Compression Level
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  disabled={isCompressing}
                  onClick={() => setQuality("balanced")}
                  className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all ${
                    quality === "balanced"
                      ? "border-blue-500 bg-blue-50/60 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium shadow-sm"
                      : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 text-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  <span className="text-sm font-semibold">Balanced</span>
                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">Recommended</span>
                  <span className="text-[10px] text-blue-600/80 dark:text-blue-400/80 mt-1">~50-70% cut</span>
                </button>

                <button
                  type="button"
                  disabled={isCompressing}
                  onClick={() => setQuality("high")}
                  className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all ${
                    quality === "high"
                      ? "border-blue-500 bg-blue-50/60 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium shadow-sm"
                      : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 text-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  <span className="text-sm font-semibold">Small File</span>
                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">Max Savings</span>
                  <span className="text-[10px] text-blue-600/80 dark:text-blue-400/80 mt-1">~75-85% cut</span>
                </button>

                <button
                  type="button"
                  disabled={isCompressing}
                  onClick={() => setQuality("light")}
                  className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all ${
                    quality === "light"
                      ? "border-blue-500 bg-blue-50/60 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium shadow-sm"
                      : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 text-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  <span className="text-sm font-semibold">High Quality</span>
                  <span className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">Near Lossless</span>
                  <span className="text-[10px] text-blue-600/80 dark:text-blue-400/80 mt-1">~30-50% cut</span>
                </button>
              </div>
            </div>

            {/* Advanced Settings Toggle */}
            {(category === "video" || category === "image" || category === "audio") && (
              <div>
                <button
                  type="button"
                  disabled={isCompressing}
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                >
                  <IoOptionsOutline size={14} />
                  <span>{showAdvanced ? "Hide Advanced Options" : "Show Advanced Options"}</span>
                </button>

                {showAdvanced && (
                  <div className="mt-2.5 p-3 rounded-xl bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-800 space-y-3">
                    {/* Video Resolution */}
                    {category === "video" && (
                      <div>
                        <label className="block text-xs font-medium mb-1 text-neutral-700 dark:text-neutral-300">
                          Target Resolution
                        </label>
                        <select
                          value={resolution}
                          onChange={(e) => setResolution(e.target.value)}
                          disabled={isCompressing}
                          className="w-full text-xs border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="original">Keep Original Resolution</option>
                          <option value="1080p">Scale to 1080p (Full HD)</option>
                          <option value="720p">Scale to 720p (HD)</option>
                          <option value="480p">Scale to 480p (Compact)</option>
                        </select>
                      </div>
                    )}

                    {/* Image Max Dimension */}
                    {category === "image" && (
                      <div>
                        <label className="block text-xs font-medium mb-1 text-neutral-700 dark:text-neutral-300">
                          Maximum Dimension
                        </label>
                        <select
                          value={maxDimension}
                          onChange={(e) => setMaxDimension(e.target.value)}
                          disabled={isCompressing}
                          className="w-full text-xs border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="original">Keep Original Dimensions</option>
                          <option value="1920">Max 1920px (Full HD)</option>
                          <option value="1280">Max 1280px (HD)</option>
                          <option value="800">Max 800px (Web/Email)</option>
                        </select>
                      </div>
                    )}

                    {/* Image Output Format Override */}
                    {category === "image" && (
                      <div>
                        <label className="block text-xs font-medium mb-1 text-neutral-700 dark:text-neutral-300">
                          Output Format
                        </label>
                        <select
                          value={outputFormat}
                          onChange={(e) => setOutputFormat(e.target.value)}
                          disabled={isCompressing}
                          className="w-full text-xs border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="same">Keep Current Format</option>
                          <option value="webp">WebP (Most Efficient / Smallest)</option>
                          <option value="jpg">JPEG / JPG</option>
                          <option value="png">PNG</option>
                        </select>
                      </div>
                    )}

                    {/* Video Output Format Override */}
                    {category === "video" && (
                      <div>
                        <label className="block text-xs font-medium mb-1 text-neutral-700 dark:text-neutral-300">
                          Container Format
                        </label>
                        <select
                          value={outputFormat}
                          onChange={(e) => setOutputFormat(e.target.value)}
                          disabled={isCompressing}
                          className="w-full text-xs border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        >
                          <option value="same">Keep Current Format</option>
                          <option value="mp4">MP4 (Universal)</option>
                          <option value="webm">WebM</option>
                          <option value="mov">MOV</option>
                          <option value="mkv">MKV</option>
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Keep Original File Checkbox */}
            <label className="flex items-center gap-2.5 text-xs text-neutral-700 dark:text-neutral-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={preserveOriginal}
                onChange={(e) => setPreserveOriginal(e.target.checked)}
                disabled={isCompressing}
                className="w-4 h-4 rounded text-blue-600 focus:ring-blue-500 dark:bg-neutral-800 border-neutral-300 dark:border-neutral-700"
              />
              <span>Keep original file in library</span>
            </label>
          </div>
        )}

        {/* Compression Progress Bar */}
        {compressionProgress && (
          <div className="mb-4 p-3 rounded-xl bg-blue-50/50 dark:bg-blue-500/5 border border-blue-100 dark:border-blue-500/20">
            <div className="flex justify-between text-xs font-medium mb-1.5">
              <span className="capitalize text-blue-700 dark:text-blue-300">
                {compressionProgress.status === "completed"
                  ? "Completed"
                  : compressionProgress.status === "failed"
                  ? "Failed"
                  : "Compressing..."}
              </span>
              <span className="text-neutral-600 dark:text-neutral-400 font-semibold">
                {Math.round(compressionProgress.progress)}%
              </span>
            </div>
            <div className="w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  compressionProgress.status === "failed"
                    ? "bg-red-600"
                    : compressionProgress.status === "completed"
                    ? "bg-emerald-600"
                    : "bg-blue-600 bg-gradient-to-r from-blue-600 to-indigo-500"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, compressionProgress.progress))}%` }}
              />
            </div>
            <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-1 truncate">
              {compressionProgress.message}
            </p>
          </div>
        )}

        {/* Error Alert */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-xl text-xs text-red-700 dark:text-red-400 flex items-start gap-2">
            <IoAlertCircleOutline size={16} className="shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
          </div>
        )}

        {/* Action Buttons */}
        <div className="flex items-center justify-between pt-2 border-t border-neutral-100 dark:border-neutral-800">
          <div>
            {isCompressing && (
              <button
                type="button"
                onClick={() => setIsMinimized(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-neutral-700 dark:text-neutral-200 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded-xl transition-colors cursor-pointer select-none active:scale-95"
              >
                <IoRemoveOutline size={15} />
                <span>Minimize to Background</span>
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCancelOrClose}
              className="px-4 py-2 text-xs font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-xl transition-colors cursor-pointer"
            >
              {completedResult ? "Done" : isCompressing ? "Cancel" : "Close"}
            </button>
            {!completedResult && (
              <button
                type="button"
                onClick={handleCompress}
                disabled={isCompressing}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-blue-600 text-white rounded-xl disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 shadow-sm transition-all cursor-pointer"
              >
                {isCompressing ? (
                  <>
                    <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Compressing...</span>
                  </>
                ) : (
                  <>
                    <IoContractOutline size={14} />
                    <span>Compress Now</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default CompressionDialog;
