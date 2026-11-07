// utils/recordingCountdown.ts
//
// The optional "3, 2, 1" before a recording starts (Settings > Recording). Timed in Rust
// (src-tauri/src/services/countdown.rs) so a recording started with no main window - from the
// shortcut, tray or phone remote while Briefcast sits in the tray - gets the same countdown; this
// is the main window's client for it. The countdown runs in its own small always-on-top window
// (components/CountdownOverlay.tsx), because the main window is often behind the app being
// recorded, and before start_recording, so none of it ends up in the video.
//
// Cancelling - a click on the countdown, or pressing Record again while it runs - resolves the
// countdown as cancelled.

import { invoke } from "@tauri-apps/api/core";

export const COUNTDOWN_TICK_EVENT = "recording-countdown-tick";
export const COUNTDOWN_CANCEL_EVENT = "recording-countdown-cancel";

export interface CountdownTick {
  // Seconds left; 0 means the countdown is over (finished or cancelled) and the window is hiding.
  remaining: number;
  total: number;
}

// Synchronous for the Record button's "press again cancels" check. Only this window starts a
// countdown while it exists (Rust runs one itself only when there is no main window), so a local
// flag is exact.
let running = false;

export function isCountdownRunning(): boolean {
  return running;
}

export function cancelCountdown(): void {
  invoke("cancel_recording_countdown").catch((err) => console.error("Couldn't cancel the countdown:", err));
}

// Resolves true when the countdown ran to the end (start recording), false when it was cancelled.
// A countdown that can't run never blocks the recording.
export async function runRecordingCountdown(seconds: number): Promise<boolean> {
  if (running) return false;
  running = true;
  try {
    return await invoke<boolean>("run_recording_countdown", { seconds: Math.max(1, Math.round(seconds)) });
  } catch (err) {
    console.error("Recording countdown unavailable:", err);
    return true;
  } finally {
    running = false;
  }
}
