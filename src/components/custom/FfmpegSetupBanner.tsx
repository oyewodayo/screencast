import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { IoCheckmark, IoClose, IoCopyOutline, IoRefresh, IoTerminalOutline, IoWarningOutline } from "react-icons/io5";

export interface FfmpegStatus {
  ok: boolean;
  path: string | null;
  version: string | null;
  problems: string[];
  fix: string | null;
}

interface FfmpegSetupBannerProps {
  onReady?: (version: string | null) => void;
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
const isLinux = typeof navigator !== "undefined" && /Linux/i.test(navigator.platform || navigator.userAgent);

function recommendedCommand(): string | null {
  if (isMac) return "brew install ffmpeg";
  if (isLinux) return "sudo apt install -y ffmpeg";
  return null;
}

/**
 * Guided, non-blocking setup card shown on macOS/Linux when system ffmpeg is missing or older than
 * 5.1. Replaces a raw disappearing error toast with 1-click copyable install commands, an explicit
 * "Check again" button, and automatic re-check whenever the window regains focus.
 */
const FfmpegSetupBanner: React.FC<FfmpegSetupBannerProps> = ({ onReady }) => {
  const [status, setStatus] = useState<FfmpegStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  const runCheck = useCallback(
    async (recheck: boolean, hadProblem: boolean) => {
      setChecking(true);
      try {
        const next = await invoke<FfmpegStatus>("ffmpeg_status", { recheck });
        if (next.ok) {
          setStatus(null);
          if (hadProblem) onReady?.(next.version);
        } else {
          setStatus(next);
        }
      } catch {
        // Non-fatal; never block the workspace.
      } finally {
        setChecking(false);
      }
    },
    [onReady]
  );

  useEffect(() => {
    void runCheck(false, false);
  }, [runCheck]);

  useEffect(() => {
    if (!status || status.ok) return;
    const win = getCurrentWebviewWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (focused) void runCheck(true, true);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [status, runCheck]);

  if (!status || status.ok || dismissed) return null;

  const cmd = recommendedCommand();
  const handleCopy = () => {
    if (!cmd) return;
    void navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="w-[360px] max-w-[92vw] rounded-xl bg-white dark:bg-neutral-900 border border-amber-300/80 dark:border-amber-700/60 shadow-lg p-3.5 text-left space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <IoWarningOutline className="text-amber-500 shrink-0 mt-0.5" size={16} />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100">
              {isMac ? "Install ffmpeg to record & export on Mac" : isLinux ? "Install ffmpeg 5.1+ to record & export" : "ffmpeg setup needed"}
            </p>
            <p className="text-[11px] text-neutral-600 dark:text-neutral-400 mt-0.5 leading-snug">
              {status.problems.join(" ")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="p-0.5 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
        >
          <IoClose size={14} />
        </button>
      </div>

      {cmd && (
        <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 border border-neutral-200/80 dark:border-neutral-700/80">
          <div className="flex items-center gap-1.5 min-w-0">
            <IoTerminalOutline className="text-neutral-400 shrink-0" size={13} />
            <code className="text-[11px] font-mono text-neutral-800 dark:text-neutral-200 truncate">{cmd}</code>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-white dark:bg-neutral-700 text-neutral-700 dark:text-neutral-100 border border-neutral-200 dark:border-neutral-600 hover:border-blue-400 transition-colors cursor-pointer"
          >
            {copied ? <IoCheckmark size={12} className="text-emerald-500" /> : <IoCopyOutline size={12} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      {status.fix && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400 leading-snug">{status.fix}</p>
      )}

      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button
          type="button"
          disabled={checking}
          onClick={() => void runCheck(true, true)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-50 transition-opacity cursor-pointer"
        >
          <IoRefresh size={12} className={checking ? "animate-spin" : ""} />
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
    </div>
  );
};

export default FfmpegSetupBanner;
