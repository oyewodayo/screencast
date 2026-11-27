// hooks/useWhiteboardPresentationRecorder.ts
//
// Native GPU-accelerated Whiteboard Presentation recorder:
//   - Captures ONLY the clean Whiteboard stage rect (`region:x,y,w,h`) via Briefcast's existing
//     Rust GPU capture + hardware encoder pipeline (zero MediaRecorder / zero JS frame copying).
//   - Tracks every Containment Frame stepped through during the presentation and writes
//     `.chapters.json` automatically alongside the finished `.mp4`.
//   - Auto-links the resulting video back to the source Whiteboard in ItemLinks.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { loadSettings } from "../utils/appSettings";
import { fileRef } from "../utils/itemLinks";
import {
  clearActiveRecordingSession,
  getActiveRecordingSession,
  setActiveRecordingSession,
  updateActiveRecordingSession,
  useActiveRecordingSession,
} from "../utils/activeRecordingCoordinator";
import {
  buildChaptersFromSlideMarks,
  computeScreenCaptureRegion,
  sanitizeRecordingFileName,
  type RecordedSlideMark,
} from "../utils/whiteboardRecording";

export type PresentationRecordStatus = "idle" | "starting" | "recording" | "paused" | "stopping";

export interface UseWhiteboardPresentationRecorderOptions {
  whiteboardId: string;
  whiteboardTitle: string;
  presentMode: boolean;
  onLinked?: () => void;
}

export function useWhiteboardPresentationRecorder({
  whiteboardId,
  whiteboardTitle,
  presentMode,
  onLinked,
}: UseWhiteboardPresentationRecorderOptions) {
  const [status, setStatus] = useState<PresentationRecordStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [micDevices, setMicDevices] = useState<string[]>([]);
  const [selectedMic, setSelectedMic] = useState<string>("");
  const [includeSystemAudio, setIncludeSystemAudio] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [chapterCount, setChapterCount] = useState(0);

  const startedAtRef = useRef<number | null>(null);
  const pausedAccumulatedRef = useRef<number>(0);
  const pauseStartedAtRef = useRef<number | null>(null);
  const slideMarksRef = useRef<RecordedSlideMark[]>([]);
  const statusRef = useRef<PresentationRecordStatus>("idle");
  statusRef.current = status;
  const activeSession = useActiveRecordingSession();
  const externalRecordingActive = !!activeSession && activeSession.owner !== "whiteboard";
  const stopRef = useRef<() => Promise<void>>(async () => {});
  const pauseRef = useRef<() => Promise<void>>(async () => {});
  const resumeRef = useRef<() => Promise<void>>(async () => {});

  // Enumerate connected microphones once whenever Presentation Mode opens.
  useEffect(() => {
    if (!presentMode) return;
    let cancelled = false;
    void invoke<[string[], string[]]>("get_connected_devices")
      .then(([, audio]) => {
        if (cancelled) return;
        const clean = (audio ?? []).filter(Boolean);
        setMicDevices(clean);
        setSelectedMic((prev) => (prev && clean.includes(prev) ? prev : clean[0] ?? ""));
      })
      .catch(() => {
        if (!cancelled) setMicDevices([]);
      });
    return () => {
      cancelled = true;
    };
  }, [presentMode]);

  const currentElapsedMs = useCallback((): number => {
    if (startedAtRef.current === null) return 0;
    const now = pauseStartedAtRef.current ?? Date.now();
    return Math.max(0, now - startedAtRef.current - pausedAccumulatedRef.current);
  }, []);

  // Tick live timer cleanly while actively recording.
  useEffect(() => {
    if (status !== "recording") return;
    const id = window.setInterval(() => {
      setElapsedMs(currentElapsedMs());
    }, 250);
    return () => window.clearInterval(id);
  }, [status, currentElapsedMs]);

  const recordSlideVisit = useCallback(
    (label: string) => {
      if (statusRef.current !== "recording" && statusRef.current !== "paused") return;
      const clean = label.trim();
      if (!clean) return;
      const elapsedSec = currentElapsedMs() / 1000;
      slideMarksRef.current.push({ time: elapsedSec, label: clean });
      setChapterCount(buildChaptersFromSlideMarks(slideMarksRef.current).length);
    },
    [currentElapsedMs]
  );

  const start = useCallback(
    async (stageEl: HTMLElement | null, initialSlideLabel: string) => {
      if (statusRef.current !== "idle") return;
      const existing = getActiveRecordingSession();
      if (existing) {
        setError("Another recording is already in progress — stop it before starting a new one.");
        return;
      }
      if (!stageEl) {
        setError("Could not measure the whiteboard stage.");
        return;
      }
      setError(null);
      setStatus("starting");

      try {
        const win = getCurrentWindow();
        const [innerPos, scaleFactor] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
        const rect = stageEl.getBoundingClientRect();
        const region = computeScreenCaptureRegion(rect, innerPos, scaleFactor);
        if (!region) {
          setError("Whiteboard stage is too small to record.");
          setStatus("idle");
          return;
        }

        const prefs = loadSettings();
        const hasMic = selectedMic.trim().length > 0;
        const formData = {
          file_name: sanitizeRecordingFileName(whiteboardTitle),
          file_ext: "mp4",
          record_type: hasMic ? "sa" : "s",
          audio_device: hasMic ? selectedMic : "",
          video_devices: [] as string[],
          screen_size: region.spec,
          overlay_shape: "rounded",
          overlay_position: "bottom-right",
          overlay_size: "medium",
          overlay_border: prefs.cameraBorder,
          overlay_border_color: prefs.cameraBorderColor,
          window_title: "",
          window_title_bar: false,
          capture_cursor: true,
          include_system_audio: includeSystemAudio,
          separate_webcam_capture: false,
          camera_effect: null,
          track_clicks: false,
          track_pointer: false,
          track_keys: false,
          mute_notifications: prefs.muteNotificationsWhileRecording,
          resolution_width: null,
          framerate: 30,
          enhance_audio: prefs.autoEnhanceAudio,
        };

        const startSound = new Audio("/sounds/icq-modern-notification-sound.mp3");
        startSound.play().catch(() => {});

        await invoke<string>("start_recording", { formData });

        const now = Date.now();
        startedAtRef.current = now;
        pausedAccumulatedRef.current = 0;
        pauseStartedAtRef.current = null;
        slideMarksRef.current = initialSlideLabel.trim() ? [{ time: 0, label: initialSlideLabel.trim() }] : [];
        setChapterCount(slideMarksRef.current.length);
        setElapsedMs(0);
        setStatus("recording");
        setActiveRecordingSession({
          owner: "whiteboard",
          startedAt: now,
          isPaused: false,
          pauseStartedAt: null,
          pausedAccumulatedMs: 0,
          stop: () => stopRef.current(),
          pause: () => pauseRef.current(),
          resume: () => resumeRef.current(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus("idle");
      }
    },
    [selectedMic, includeSystemAudio, whiteboardTitle]
  );

  const pause = useCallback(async () => {
    if (statusRef.current !== "recording") return;
    try {
      await invoke("pause_recording");
      const now = Date.now();
      pauseStartedAtRef.current = now;
      setElapsedMs(currentElapsedMs());
      setStatus("paused");
      updateActiveRecordingSession("whiteboard", {
        isPaused: true,
        pauseStartedAt: now,
        pausedAccumulatedMs: pausedAccumulatedRef.current,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [currentElapsedMs]);

  const resume = useCallback(async () => {
    if (statusRef.current !== "paused") return;
    try {
      await invoke("resume_recording");
      if (pauseStartedAtRef.current !== null) {
        pausedAccumulatedRef.current += Date.now() - pauseStartedAtRef.current;
        pauseStartedAtRef.current = null;
      }
      setStatus("recording");
      updateActiveRecordingSession("whiteboard", {
        isPaused: false,
        pauseStartedAt: null,
        pausedAccumulatedMs: pausedAccumulatedRef.current,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const stop = useCallback(async () => {
    if (statusRef.current !== "recording" && statusRef.current !== "paused") return;
    setStatus("stopping");
    setError(null);
    const marksSnapshot = [...slideMarksRef.current];

    const stopSound = new Audio("/sounds/option-3.mp3");
    stopSound.play().catch(() => {});

    try {
      const savedPath = await invoke<string>("stop_recording");
      const chapters = buildChaptersFromSlideMarks(marksSnapshot);
      if (savedPath && chapters.length > 0) {
        await invoke("save_video_chapters", {
          videoPath: savedPath,
          json: JSON.stringify(chapters),
        }).catch((err) => console.warn("Failed to write presentation slide chapters:", err));
      }
      if (savedPath && whiteboardId) {
        await invoke("add_link", {
          a: { kind: "whiteboard", id: whiteboardId },
          b: fileRef(savedPath),
        }).catch((err) => console.warn("Failed to link recording to whiteboard:", err));
        onLinked?.();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("No recording in progress")) {
        setError(`Failed to finish recording: ${msg}`);
      }
    } finally {
      startedAtRef.current = null;
      pausedAccumulatedRef.current = 0;
      pauseStartedAtRef.current = null;
      slideMarksRef.current = [];
      setChapterCount(0);
      setElapsedMs(0);
      setStatus("idle");
      clearActiveRecordingSession("whiteboard");
    }
  }, [whiteboardId, onLinked]);

  stopRef.current = stop;
  pauseRef.current = pause;
  resumeRef.current = resume;

  // Safety guard: never leave an active recording running if the whiteboard unmounts.
  useEffect(() => {
    return () => {
      if (statusRef.current === "recording" || statusRef.current === "paused") {
        clearActiveRecordingSession("whiteboard");
        void invoke("stop_recording").catch(() => {});
      }
    };
  }, []);

  return {
    status,
    isActive: status === "recording" || status === "paused",
    externalRecordingActive,
    stopExternalRecording: () => {
      const active = getActiveRecordingSession();
      if (active && active.owner !== "whiteboard") {
        void active.stop();
      }
    },
    elapsedMs,
    micDevices,
    selectedMic,
    setSelectedMic,
    includeSystemAudio,
    setIncludeSystemAudio,
    error,
    clearError: () => setError(null),
    chapterCount,
    start,
    pause,
    resume,
    stop,
    recordSlideVisit,
  };
}
