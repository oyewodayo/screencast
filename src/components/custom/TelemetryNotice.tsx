// components/custom/TelemetryNotice.tsx
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IoShieldCheckmarkOutline } from "react-icons/io5";

interface TelemetrySettings {
  enabled: boolean;
  available: boolean;
  noticeSeen: boolean;
}

// One-time card telling a new user that anonymous usage statistics and crash reports are on, with
// a one-click way to turn them off (src-tauri/src/services/telemetry.rs). Same corner stack and
// look as UpdateBanner. Only shown in builds that actually have telemetry keys - a dev or source
// build sends nothing, so there's nothing to disclose - and never again once either button is
// pressed (the choice is stored next to the switch itself, not in browser storage).
const TelemetryNotice: React.FC = () => {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    invoke<TelemetrySettings>("get_telemetry_settings")
      .then((s) => setVisible(s.available && s.enabled && !s.noticeSeen))
      .catch(() => {});
  }, []);

  const close = async (turnOff: boolean) => {
    setVisible(false);
    try {
      if (turnOff) await invoke("set_telemetry_enabled", { enabled: false });
      await invoke("dismiss_telemetry_notice");
    } catch (err) {
      console.error("Failed to save telemetry choice:", err);
    }
  };

  if (!visible) return null;

  return (
    <div className="flex items-start gap-2.5 max-w-sm px-3.5 py-3 rounded-xl shadow-[0_8px_24px_rgba(0,0,0,0.18)] ring-1 backdrop-blur-xl bg-white/95 dark:bg-neutral-800/95 ring-black/[0.06] dark:ring-white/[0.08]">
      <IoShieldCheckmarkOutline className="text-blue-500 shrink-0 mt-0.5" size={18} />
      <div className="flex-1 min-w-0 text-[13px] leading-snug text-neutral-800 dark:text-neutral-100">
        <div className="font-medium">Help improve Briefcast</div>
        <div className="mt-0.5 text-neutral-500 dark:text-neutral-400">
          Briefcast sends anonymous usage statistics and crash reports. Never your files, file names, recordings or
          anything you type. You can change this any time in Settings → Privacy.
        </div>
        <div className="mt-2 flex gap-2">
          <button
            className="px-2.5 py-1 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700"
            onClick={() => close(false)}
          >
            OK
          </button>
          <button
            className="px-2.5 py-1 rounded-md text-xs text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => close(true)}
          >
            Turn off
          </button>
        </div>
      </div>
    </div>
  );
};

export default TelemetryNotice;
