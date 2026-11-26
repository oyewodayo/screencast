import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate } from "../utils/updater";
import { HIDDEN_TO_TRAY_EVENT } from "../utils/closeGuards";
import { stopAllPlayback } from "../utils/previewHead";
import type { EditorIntent } from "../utils/editorIntent";
import { OPEN_BRIEFCAST_DOC_EVENT } from "../utils/videoToDoc";
import type { VideoPlayerHandle } from "../components/VideoPlayer";

export type RAMInfo = [number, number];

interface UseDashboardSystemListenersOptions {
  videoPlayerRef: React.RefObject<VideoPlayerHandle | null>;
  onOpenConversionFile: (file: { path: string; name: string }) => void;
  onOpenRecordingPlayback: (path: string, name: string) => void | Promise<void>;
  onOpenRecordingEditor: (file: { path: string; name: string }, intent?: EditorIntent) => void | Promise<void>;
  onOpenRecordingNotes: (file: { path: string; name: string }) => void | Promise<void>;
  onOpenBriefcastDoc: (docId: string) => void | Promise<void>;
}

/**
 * Owns app-shell system integrations for Dashboard: initial RAM readout, delayed background update
 * check, pausing all media when hidden to tray, handling post-recording popup actions (Convert,
 * Play, Open in Editor with Studio Polish/Captions, Create Notes Doc), and opening newly generated
 * Briefcast Docs.
 */
export function useDashboardSystemListeners({
  videoPlayerRef,
  onOpenConversionFile,
  onOpenRecordingPlayback,
  onOpenRecordingEditor,
  onOpenRecordingNotes,
  onOpenBriefcastDoc,
}: UseDashboardSystemListenersOptions) {
  const [ramInfo, setRamInfo] = useState<RAMInfo | null>(null);
  const [pendingUpdate, setPendingUpdate] = useState<Update | null>(null);

  const callbacksRef = useRef({
    onOpenConversionFile,
    onOpenRecordingPlayback,
    onOpenRecordingEditor,
    onOpenRecordingNotes,
    onOpenBriefcastDoc,
  });
  callbacksRef.current = {
    onOpenConversionFile,
    onOpenRecordingPlayback,
    onOpenRecordingEditor,
    onOpenRecordingNotes,
    onOpenBriefcastDoc,
  };

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
    const focusMainWindow = async () => {
      const appWindow = getCurrentWebviewWindow();
      await appWindow.show().catch(() => {});
      await appWindow.unminimize().catch(() => {});
      await appWindow.setFocus().catch(() => {});
    };

    const unlistenConvert = listen<string>("open-conversion-dialog", (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() || path;
      callbacksRef.current.onOpenConversionFile({ path, name });
    });
    const unlistenPlay = listen<string>("open-recording-playback", async (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() || path;
      await focusMainWindow();
      await callbacksRef.current.onOpenRecordingPlayback(path, name);
    });
    const unlistenEditor = listen<{ path: string; intent?: EditorIntent }>("open-recording-editor", async (event) => {
      const { path, intent } = event.payload;
      const name = path.split(/[\\/]/).pop() || path;
      await focusMainWindow();
      await callbacksRef.current.onOpenRecordingEditor({ path, name }, intent);
    });
    const unlistenNotes = listen<string>("open-recording-notes", async (event) => {
      const path = event.payload;
      const name = path.split(/[\\/]/).pop() || path;
      await focusMainWindow();
      await callbacksRef.current.onOpenRecordingNotes({ path, name });
    });
    const onOpenDoc = (event: Event) => {
      const docId = (event as CustomEvent<{ docId?: string }>).detail?.docId;
      if (docId) void callbacksRef.current.onOpenBriefcastDoc(docId);
    };
    window.addEventListener(OPEN_BRIEFCAST_DOC_EVENT, onOpenDoc);
    return () => {
      unlistenConvert.then((fn) => fn());
      unlistenPlay.then((fn) => fn());
      unlistenEditor.then((fn) => fn());
      unlistenNotes.then((fn) => fn());
      window.removeEventListener(OPEN_BRIEFCAST_DOC_EVENT, onOpenDoc);
    };
  }, []);

  return { ramInfo, pendingUpdate, setPendingUpdate };
}
