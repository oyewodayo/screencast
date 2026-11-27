// services/presentationRecorder.ts
//
// Clean-feed native GPU recorder for Briefcast's Live Multi-Camera Display (PresentationWindow).
// Captures the live display's monitor framebuffer (`monitor:<id>`) directly on the GPU via
// Briefcast's existing Rust recording pipeline — never contending with PresentationWindow's
// exclusive USB/HDMI webcam handles — while syncing seamlessly with activeRecordingCoordinator.ts
// and auto-writing camera/layout cut chapters to `.chapters.json` on Stop.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadSettings } from "../utils/appSettings";
import {
  clearActiveRecordingSession,
  getActiveRecordingSession,
  setActiveRecordingSession,
  updateActiveRecordingSession,
} from "../utils/activeRecordingCoordinator";
import {
  buildChaptersFromSlideMarks,
  type RecordedSlideMark,
} from "../utils/whiteboardRecording";
import {
  cameraDisplayName,
  getPresentationState,
  liveCamera,
  startPresentation,
  subscribePresentation,
  type PresentationState,
} from "./presentation";

export type LiveDisplayRecordStatus = "idle" | "starting" | "recording" | "paused" | "stopping";

export interface LiveDisplayRecorderSnapshot {
  status: LiveDisplayRecordStatus;
  elapsedMs: number;
  micDevices: string[];
  selectedMic: string;
  includeSystemAudio: boolean;
  framerate: 30 | 60;
  chapterCount: number;
  error: string | null;
}

interface MonitorGeometry {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  is_primary: boolean;
}

let snap: LiveDisplayRecorderSnapshot = {
  status: "idle",
  elapsedMs: 0,
  micDevices: [],
  selectedMic: "",
  includeSystemAudio: false,
  framerate: 30,
  chapterCount: 0,
  error: null,
};

let startedAt: number | null = null;
let pausedAccumulatedMs = 0;
let pauseStartedAt: number | null = null;
let cutMarks: RecordedSlideMark[] = [];
let lastCueKey = "";
let timerId: number | null = null;
let unsubscribePres: (() => void) | null = null;
let devicesLoaded = false;

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function setSnap(patch: Partial<LiveDisplayRecorderSnapshot>) {
  snap = { ...snap, ...patch };
  emit();
}

function currentElapsedMs(): number {
  if (startedAt === null) return 0;
  const now = pauseStartedAt ?? Date.now();
  return Math.max(0, now - startedAt - pausedAccumulatedMs);
}

function cueLabelFor(st: PresentationState): { key: string; label: string } {
  const live = liveCamera(st);
  if (st.layout === "grid") {
    return { key: `grid:${st.cameras.length - st.hidden.length}`, label: "All cameras (Grid)" };
  }
  const camName = live ? cameraDisplayName(live) : "Camera";
  if (st.layout === "spotlight") {
    return { key: `spotlight:${live ?? ""}`, label: `Spotlight — ${camName}` };
  }
  return { key: `single:${live ?? ""}`, label: camName };
}

function startTimer() {
  stopTimer();
  timerId = window.setInterval(() => {
    setSnap({ elapsedMs: currentElapsedMs() });
  }, 250);
}

function stopTimer() {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

function detachPresentationWatcher() {
  unsubscribePres?.();
  unsubscribePres = null;
}

function attachPresentationWatcher() {
  detachPresentationWatcher();
  unsubscribePres = subscribePresentation((nextState) => {
    if (snap.status !== "recording" && snap.status !== "paused") return;
    if (!nextState.active) {
      // The live display was closed (Esc / Stop display) — finish and save cleanly.
      void stopLiveDisplayRecording();
      return;
    }
    const cue = cueLabelFor(nextState);
    if (cue.key !== lastCueKey) {
      lastCueKey = cue.key;
      cutMarks.push({ time: currentElapsedMs() / 1000, label: cue.label });
      setSnap({ chapterCount: buildChaptersFromSlideMarks(cutMarks, 2.0).length });
    }
  });
}

export async function refreshLiveDisplayMics(force = false): Promise<void> {
  if (devicesLoaded && !force) return;
  try {
    const [, audio] = await invoke<[string[], string[]]>("get_connected_devices");
    const clean = (audio ?? []).filter(Boolean);
    devicesLoaded = true;
    setSnap({
      micDevices: clean,
      selectedMic: snap.selectedMic && clean.includes(snap.selectedMic) ? snap.selectedMic : clean[0] ?? "",
    });
  } catch {
    setSnap({ micDevices: [] });
  }
}

export function setLiveDisplayMic(mic: string): void {
  setSnap({ selectedMic: mic });
}

export function setLiveDisplaySystemAudio(on: boolean): void {
  setSnap({ includeSystemAudio: on });
}

export function setLiveDisplayFramerate(fps: 30 | 60): void {
  setSnap({ framerate: fps });
}

export function clearLiveDisplayRecordError(): void {
  setSnap({ error: null });
}

export function markLiveDisplayChapter(label?: string): void {
  if (snap.status !== "recording" && snap.status !== "paused") return;
  const elapsedSec = currentElapsedMs() / 1000;
  const text = label?.trim() || `Marker ${cutMarks.length + 1} (${cueLabelFor(getPresentationState()).label})`;
  cutMarks.push({ time: elapsedSec, label: text });
  setSnap({ chapterCount: buildChaptersFromSlideMarks(cutMarks, 2.0).length });
}

export async function startLiveDisplayRecording(): Promise<void> {
  if (snap.status !== "idle") return;
  const existing = getActiveRecordingSession();
  if (existing) {
    setSnap({ error: "Another recording is already in progress — stop it before starting a new one." });
    return;
  }

  setSnap({ status: "starting", error: null });

  try {
    // Ensure the live display window is actually showing fullscreen before we grab its monitor.
    if (!getPresentationState().active) {
      await startPresentation();
      await new Promise((r) => window.setTimeout(r, 280));
    }

    const st = getPresentationState();
    const monitors = await invoke<MonitorGeometry[]>("get_monitors");
    const targetMonitor = monitors.find((m) => m.id === st.monitorId) ?? monitors[monitors.length - 1];
    if (!targetMonitor) {
      setSnap({ status: "idle", error: "No target display found to record." });
      return;
    }

    const prefs = loadSettings();
    const hasMic = snap.selectedMic.trim().length > 0;
    const dateStamp = new Date().toLocaleDateString().replace(/\//g, "_");
    const formData = {
      file_name: `Live_Display_${dateStamp}`,
      file_ext: "mp4",
      record_type: hasMic ? "sa" : "s",
      audio_device: hasMic ? snap.selectedMic : "",
      video_devices: [] as string[],
      screen_size: `monitor:${targetMonitor.id}`,
      overlay_shape: "rounded",
      overlay_position: "bottom-right",
      overlay_size: "medium",
      overlay_border: prefs.cameraBorder,
      overlay_border_color: prefs.cameraBorderColor,
      window_title: "",
      window_title_bar: false,
      capture_cursor: false,
      include_system_audio: snap.includeSystemAudio,
      separate_webcam_capture: false,
      camera_effect: null,
      track_clicks: false,
      track_pointer: false,
      track_keys: false,
      mute_notifications: prefs.muteNotificationsWhileRecording,
      resolution_width: null,
      framerate: snap.framerate,
      enhance_audio: prefs.autoEnhanceAudio,
    };

    const startSound = new Audio("/sounds/icq-modern-notification-sound.mp3");
    startSound.play().catch(() => {});

    await invoke<string>("start_recording", { formData });

    const now = Date.now();
    startedAt = now;
    pausedAccumulatedMs = 0;
    pauseStartedAt = null;
    const initialCue = cueLabelFor(getPresentationState());
    lastCueKey = initialCue.key;
    cutMarks = [{ time: 0, label: initialCue.label }];

    setSnap({
      status: "recording",
      elapsedMs: 0,
      chapterCount: 1,
      error: null,
    });
    startTimer();
    attachPresentationWatcher();

    setActiveRecordingSession({
      owner: "presentation",
      startedAt: now,
      isPaused: false,
      pauseStartedAt: null,
      pausedAccumulatedMs: 0,
      stop: stopLiveDisplayRecording,
      pause: pauseLiveDisplayRecording,
      resume: resumeLiveDisplayRecording,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setSnap({ status: "idle", error: msg });
  }
}

export async function pauseLiveDisplayRecording(): Promise<void> {
  if (snap.status !== "recording") return;
  try {
    await invoke("pause_recording");
    const now = Date.now();
    pauseStartedAt = now;
    stopTimer();
    setSnap({ status: "paused", elapsedMs: currentElapsedMs() });
    updateActiveRecordingSession("presentation", {
      isPaused: true,
      pauseStartedAt: now,
      pausedAccumulatedMs,
    });
  } catch (err) {
    setSnap({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function resumeLiveDisplayRecording(): Promise<void> {
  if (snap.status !== "paused") return;
  try {
    await invoke("resume_recording");
    if (pauseStartedAt !== null) {
      pausedAccumulatedMs += Date.now() - pauseStartedAt;
      pauseStartedAt = null;
    }
    setSnap({ status: "recording" });
    startTimer();
    updateActiveRecordingSession("presentation", {
      isPaused: false,
      pauseStartedAt: null,
      pausedAccumulatedMs,
    });
  } catch (err) {
    setSnap({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function stopLiveDisplayRecording(): Promise<void> {
  if (snap.status !== "recording" && snap.status !== "paused") return;
  setSnap({ status: "stopping", error: null });
  stopTimer();
  detachPresentationWatcher();
  const marksSnapshot = [...cutMarks];

  const stopSound = new Audio("/sounds/option-3.mp3");
  stopSound.play().catch(() => {});

  try {
    const savedPath = await invoke<string>("stop_recording");
    const chapters = buildChaptersFromSlideMarks(marksSnapshot, 2.0);
    if (savedPath && chapters.length > 0) {
      await invoke("save_video_chapters", {
        videoPath: savedPath,
        json: JSON.stringify(chapters),
      }).catch((err) => console.warn("Failed to write live display chapters:", err));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("No recording in progress")) {
      setSnap({ error: `Failed to finish recording: ${msg}` });
    }
  } finally {
    startedAt = null;
    pausedAccumulatedMs = 0;
    pauseStartedAt = null;
    cutMarks = [];
    lastCueKey = "";
    setSnap({ status: "idle", elapsedMs: 0, chapterCount: 0 });
    clearActiveRecordingSession("presentation");
  }
}

export function getLiveDisplayRecorderSnapshot(): LiveDisplayRecorderSnapshot {
  return snap;
}

export function subscribeLiveDisplayRecorder(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLiveDisplayRecorder(): LiveDisplayRecorderSnapshot {
  return useSyncExternalStore(
    subscribeLiveDisplayRecorder,
    getLiveDisplayRecorderSnapshot,
    getLiveDisplayRecorderSnapshot
  );
}
