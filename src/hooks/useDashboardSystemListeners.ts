import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate } from "../utils/updater";
import { HIDDEN_TO_TRAY_EVENT } from "../utils/closeGuards";
import { stopAllPlayback } from "../utils/previewHead";
import type { VideoPlayerHandle } from "../components/VideoPlayer";

export type RAMInfo = [number, number];

interface UseDashboardSystemListenersOptions {
  videoPlayerRef: React.RefObject<VideoPlayerHandle | null>;
  onOpenConversionFile: (file: { path: string; name: string }) => void;
  onOpenRecordingPlayback: (path: string, name: string) => void | Promise<void>;
}

/**
 * Owns app-shell system integrations for Dashboard: initial RAM readout, delayed background update
 * check, pausing all media when hidden to tray, and handling "Convert format" / "Play" requests
 * emitted by the separate recording-completed popup window.
 */
export function useDashboardSystemListeners({
  videoPlayerRef,
  onOpenConversionFile,
  onOpenRecordingPlayback,
}: UseDashboardSystemListenersOptions) {
  const [ramInfo, setRamInfo] = useState<RAMInfo | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  const callbacksRef = useRef({ onOpenConversionFile, onOpenRecordingPlayback });
  callbacksRef.current = { onOpenConversionFile, onOpenRecordingPlayback };

  useEffect(() => {
    invoke<RAMInfo>("get_ram_info").then(setRamInfo).catch(console.error);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void checkForUpdate().then((update) => {
        if (update) setPendingUpdate(update);
      });
    }, 15_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const stopPlayback = () => {
      if (videoPlayerRef.current?.getPlaybackState()?.paused === false) videoPlayerRef.current.togglePlay();
      stopAllPlayback();
      document.querySelectorAll<HTMLMediaElement>("video, audio").forEach((el) => {
        if (!el.paused && !el.srcObject) el.pause();
      });
    };
    window.addEventListener(HIDDEN_TO_TRAY_EVENT, stopPlayback);
    return () => window.removeEventListener(HIDDEN_TO_TRAY_EVENT, stopPlayback);
  }, [videoPlayerRef]);

  useEffect(() => {
    const unlistenConvert = listen<string>("open-conversion-dialog", (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() || path;
      callbacksRef.current.onOpenConversionFile({ path, name });
    });
    const unlistenPlay = listen<string>("open-recording-playback", async (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() || path;
      const appWindow = getCurrentWebviewWindow();
      await appWindow.show().catch(() => {});
      await appWindow.unminimize().catch(() => {});
      await appWindow.setFocus().catch(() => {});
      await callbacksRef.current.onOpenRecordingPlayback(path, name);
    });
    return () => {
      unlistenConvert.then((fn) => fn());
      unlistenPlay.then((fn) => fn());
    };
  }, []);

  return { ramInfo, pendingUpdate, setPendingUpdate };
}
