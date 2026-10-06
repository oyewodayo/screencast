// utils/recordingCountdown.ts
//
// The optional "3, 2, 1" before a recording starts (Settings > Recording). It runs in its own small
// always-on-top window (the "countdown-overlay" window, components/CountdownOverlay.tsx) rather
// than inside the main window, because the main window is often behind the app being recorded -
// and it runs before start_recording, so none of it ends up in the video.
//
// This side owns the timing; the window only draws the number it's sent. Cancelling - a click on the
// countdown, or pressing Record again while it runs - resolves the countdown as cancelled.

import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, primaryMonitor } from "@tauri-apps/api/window";
import { PhysicalPosition } from "@tauri-apps/api/dpi";

const LABEL = "countdown-overlay";
const SIZE = 220;

export const COUNTDOWN_TICK_EVENT = "recording-countdown-tick";
export const COUNTDOWN_CANCEL_EVENT = "recording-countdown-cancel";

export interface CountdownTick {
  // Seconds left; 0 means the countdown is over (finished or cancelled) and the window is hiding.
  remaining: number;
  total: number;
}

let cancelRunning: (() => void) | null = null;

// True while a countdown is on screen - a second Record press should cancel it rather than start a
// second one.
export function isCountdownRunning(): boolean {
  return cancelRunning !== null;
}

export function cancelCountdown(): void {
  cancelRunning?.();
}

async function countdownWindow(): Promise<WebviewWindow> {
  const existing = await WebviewWindow.getByLabel(LABEL);
  if (existing) return existing;
  // Normally built at startup (tauri.conf.json); this covers a build without that entry.
  const created = new WebviewWindow(LABEL, {
    url: "/countdown",
    width: SIZE,
    height: SIZE,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    decorations: false,
    transparent: true,
    shadow: false,
    visible: false,
    focus: false,
  });
  await new Promise<void>((resolve, reject) => {
    void created.once("tauri://created", () => resolve());
    void created.once("tauri://error", (e) => reject(e));
  });
  return created;
}

// Resolves true when the countdown ran to the end (start recording), false when it was cancelled.
export async function runRecordingCountdown(seconds: number): Promise<boolean> {
  if (cancelRunning) return false;
  const total = Math.max(1, Math.round(seconds));

  let cancelled = false;
  let wake: (() => void) | null = null;
  cancelRunning = () => {
    cancelled = true;
    wake?.();
  };
  const unlistenCancel = await listen(COUNTDOWN_CANCEL_EVENT, () => cancelRunning?.());

  let win: WebviewWindow | null = null;
  try {
    win = await countdownWindow();
    // Centred on the monitor Briefcast's main window is on - placed by hand because the window
    // capability allows set-position but not center().
    const monitor = (await currentMonitor()) ?? (await primaryMonitor());
    if (monitor) {
      const side = Math.round(SIZE * monitor.scaleFactor);
      await win.setPosition(
        new PhysicalPosition(
          monitor.position.x + Math.round((monitor.size.width - side) / 2),
          monitor.position.y + Math.round((monitor.size.height - side) / 2)
        )
      );
    }
    await win.show();
    for (let remaining = total; remaining > 0 && !cancelled; remaining--) {
      await emit(COUNTDOWN_TICK_EVENT, { remaining, total } satisfies CountdownTick);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 1000);
      });
      wake = null;
    }
  } catch (err) {
    // A countdown that can't be shown must never block the recording itself.
    console.error("Recording countdown unavailable:", err);
  } finally {
    unlistenCancel();
    cancelRunning = null;
    await emit(COUNTDOWN_TICK_EVENT, { remaining: 0, total } satisfies CountdownTick).catch(() => {});
    await win?.hide().catch(() => {});
  }
  return !cancelled;
}
