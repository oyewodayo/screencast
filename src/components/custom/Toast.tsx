// components/custom/Toast.tsx
import React, { useEffect, useState } from "react";
import { IoClose, IoCheckmarkCircle, IoAlertCircle } from "react-icons/io5";

interface ToastProps {
  message: string;
  variant?: "info" | "error";
  durationMs?: number;
  onDismiss: () => void;
}

// A single auto-dismissing toast. Replaces the old plain-text status line that used to sit
// permanently in the docker bar (no background, no dismiss, overlapping whatever content was
// behind it) until the next message overwrote it — this fades in, times out on its own after
// `durationMs`, and can also be closed immediately.
const Toast: React.FC<ToastProps> = ({ message, variant = "info", durationMs = 4500, onDismiss }) => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const showFrame = requestAnimationFrame(() => setVisible(true));
    const hideTimer = setTimeout(onDismiss, durationMs);
    return () => {
      cancelAnimationFrame(showFrame);
      clearTimeout(hideTimer);
    };
    // Re-arms whenever the message text changes (a new message replacing an old one should get
    // its own full duration, not inherit whatever was left on the previous timer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, durationMs]);

  const isError = variant === "error";

  return (
    <div
      className={`flex items-start gap-2.5 max-w-sm px-3.5 py-3 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] ring-1 backdrop-blur-xl transition-all duration-200 ease-out ${
        isError ? "bg-red-50/95 dark:bg-red-500/10 ring-red-200 dark:ring-red-500/30" : "bg-white/95 dark:bg-neutral-800/95 ring-black/[0.06] dark:ring-white/[0.08]"
      } ${visible ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1"}`}
    >
      {isError ? (
        <IoAlertCircle className="text-red-500 shrink-0 mt-0.5" size={18} />
      ) : (
        <IoCheckmarkCircle className="text-emerald-500 shrink-0 mt-0.5" size={18} />
      )}
      <div className={`flex-1 text-sm break-words ${isError ? "text-red-700 dark:text-red-300" : "text-neutral-700 dark:text-neutral-200"}`}>{message}</div>
      <button
        type="button"
        title="Dismiss"
        onClick={onDismiss}
        className={`shrink-0 rounded-full p-0.5 hover:bg-black/5 dark:hover:bg-white/10 ${isError ? "text-red-400" : "text-neutral-400 dark:text-neutral-500"}`}
      >
        <IoClose size={15} />
      </button>
    </div>
  );
};

export default Toast;
