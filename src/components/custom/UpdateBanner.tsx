// components/custom/UpdateBanner.tsx
import React, { useState } from "react";
import { IoClose, IoArrowDownCircle } from "react-icons/io5";
import type { Update } from "@tauri-apps/plugin-updater";
import { installUpdate } from "../../utils/updater";

interface UpdateBannerProps {
  update: Update;
  // Installing restarts the app, so it's held off while a recording is running.
  isRecording: boolean;
  onDismiss: () => void;
}

// Non-blocking "new version available" card (Dashboard.tsx shows it after the startup check in
// utils/updater.ts). Deliberately not a modal dialog: it must never interrupt a recording or
// steal focus from whatever the user is doing - "Later" just hides it until the next launch.
const UpdateBanner: React.FC<UpdateBannerProps> = ({ update, isRecording, onDismiss }) => {
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleInstall = async () => {
    setError(null);
    setProgress(0);
    try {
      await installUpdate(update, setProgress);
    } catch (err) {
      setProgress(null);
      setError(String(err));
    }
  };

  const installing = progress !== null;

  return (
    <div className="flex items-start gap-2.5 max-w-sm px-3.5 py-3 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] ring-1 backdrop-blur-xl bg-white/95 dark:bg-neutral-800/95 ring-black/[0.06] dark:ring-white/[0.08]">
      <IoArrowDownCircle className="text-blue-500 shrink-0 mt-0.5" size={18} />
      <div className="flex-1 min-w-0 text-[13px] leading-snug text-neutral-800 dark:text-neutral-100">
        <div className="font-medium">Briefcast {update.version} is available</div>
        {error ? (
          <div className="mt-0.5 text-red-600 dark:text-red-400">Update failed: {error}</div>
        ) : installing ? (
          <div className="mt-0.5 text-neutral-500 dark:text-neutral-400">Downloading… {Math.round(progress)}%. Briefcast will restart.</div>
        ) : isRecording ? (
          <div className="mt-0.5 text-neutral-500 dark:text-neutral-400">You can install it once this recording ends.</div>
        ) : (
          <div className="mt-0.5 text-neutral-500 dark:text-neutral-400">Installing restarts Briefcast.</div>
        )}
        {!installing && (
          <div className="mt-2 flex gap-2">
            <button
              className="px-2.5 py-1 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleInstall}
              disabled={isRecording}
            >
              Install and restart
            </button>
            <button
              className="px-2.5 py-1 rounded-md text-xs text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10"
              onClick={onDismiss}
            >
              Later
            </button>
          </div>
        )}
      </div>
      {!installing && (
        <button className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200" onClick={onDismiss} aria-label="Dismiss">
          <IoClose size={16} />
        </button>
      )}
    </div>
  );
};

export default UpdateBanner;
