// utils/closeGuards.ts
//
// The main window's one close-requested listener. Tauri v2's onCloseRequested destroys the window
// as soon as any one listener returns without preventDefault - so with several listeners (save-on-
// quit, "recording in progress", exports) the first one with nothing to say closed the window while
// another was still saving or asking. Instead every guard registers here and runs in turn, and the
// window is destroyed only once all of them agree.
//
// It is also where the close button hides Briefcast to the tray instead (settings.closeToTray) -
// the window and everything open in it stay alive, so no guard needs to run for that. A real quit
// comes from the tray menu's "Quit Briefcast" (quitApp) or from closeToTray being off.
//
// Releasing the window (settings.releaseWindowInTray): after a minute hidden in the tray, the
// window is destroyed to give back its memory, and Rust rebuilds it when Briefcast is opened again
// (src-tauri/src/services/main_window.rs). Shortcuts, the tray and the phone remote keep working
// without it - recording included. It happens only when nothing needs this page (see
// addReleaseBlocker), after the close guards have run in "release" mode: saves flush, nothing asks.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask } from "@tauri-apps/plugin-dialog";
import { loadSettings, updateSettings } from "./appSettings";

/** Why the window is going away: the user quitting, or a release to the tray (nothing is lost,
 * Briefcast keeps running - a guard should flush, never ask). */
export type CloseReason = "quit" | "release";

// Resolves false to keep the window open (the user said "keep recording", say).
export type CloseGuard = (reason: CloseReason) => boolean | Promise<boolean>;

const guards = new Set<CloseGuard>();

export function addCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

// Returns a reason the page is needed right now (an export running in it, the phone camera being
// captured by it...), or null. Checked before a release; a blocked release just waits.
export type ReleaseBlocker = () => string | null;

const blockers = new Set<ReleaseBlocker>();

export function addReleaseBlocker(blocker: ReleaseBlocker): () => void {
  blockers.add(blocker);
  return () => {
    blockers.delete(blocker);
  };
}

/** How long Briefcast sits in the tray before its window is released - reopening within it is
 * instant, and a quick hide-and-reopen never pays for a rebuild. */
export const RELEASE_AFTER_MS = 60_000;
/** How often a blocked release is tried again while still hidden. */
const RELEASE_RETRY_MS = 30_000;

async function runGuards(reason: CloseReason): Promise<boolean> {
  for (const guard of [...guards]) {
    let ok = true;
    try {
      ok = await guard(reason);
    } catch (err) {
      // A failing guard (a save that errored) must never trap the user in an unclosable app.
      console.error("Close guard failed:", err);
    }
    if (!ok) return false;
  }
  return true;
}

// Set by the tray's Quit for the one close it triggers - cleared again if a guard keeps the
// window open, so the next click on the close button goes back to hiding to the tray.
let quitting = false;

export async function quitApp(): Promise<void> {
  const appWindow = getCurrentWebviewWindow();
  quitting = true;
  // A guard may ask something - the question needs a window to sit on.
  await appWindow.show().catch(() => {});
  await appWindow.setFocus().catch(() => {});
  await appWindow.close();
}

let releaseTimer: number | undefined;

function cancelScheduledRelease(): void {
  window.clearTimeout(releaseTimer);
  releaseTimer = undefined;
}

function scheduleRelease(delayMs: number): void {
  cancelScheduledRelease();
  if (!loadSettings().releaseWindowInTray) return;
  releaseTimer = window.setTimeout(() => void tryRelease(), delayMs);
}

async function tryRelease(): Promise<void> {
  releaseTimer = undefined;
  const appWindow = getCurrentWebviewWindow();
  // Opened again meanwhile, or the setting was turned off.
  if ((await appWindow.isVisible().catch(() => true)) || !loadSettings().releaseWindowInTray) return;
  const blocked = [...blockers].map((b) => b()).find((reason) => reason !== null);
  if (blocked) {
    console.info(`Keeping the window while in the tray: ${blocked}`);
    scheduleRelease(RELEASE_RETRY_MS);
    return;
  }
  if (!(await runGuards("release"))) {
    scheduleRelease(RELEASE_RETRY_MS);
    return;
  }
  // Re-checked: a guard may have taken a while, and the user may have reopened Briefcast.
  if (await appWindow.isVisible().catch(() => true)) return;
  await invoke("release_main_window").catch((err) => console.error("Couldn't release the window:", err));
}

async function hideToTray(): Promise<boolean> {
  const appWindow = getCurrentWebviewWindow();
  const settings = loadSettings();
  if (settings.closeToTray === null) {
    const keep = await ask(
      "Briefcast can keep running in the tray by the clock, so Ctrl+Shift+R still starts a recording. Reopen it any time from the tray icon. You can change this later in Settings.",
      { title: "Keep Briefcast running?", kind: "info", okLabel: "Keep running in tray", cancelLabel: "Quit" }
    );
    updateSettings({ closeToTray: keep });
    if (!keep) return false;
  }
  await appWindow.hide();
  scheduleRelease(RELEASE_AFTER_MS);
  return true;
}

let installed = false;
export function installCloseGuards(): void {
  if (installed) return;
  installed = true;
  const appWindow = getCurrentWebviewWindow();
  // Shown again from the tray: whatever release was pending is off.
  void appWindow.onFocusChanged(({ payload: focused }) => {
    if (focused) cancelScheduledRelease();
  });
  let running = false; // a double-click on the close button runs the guards once
  void appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (running) return;
    running = true;
    try {
      if (!quitting && loadSettings().closeToTray !== false && (await hideToTray())) return;
      if (!(await runGuards("quit"))) {
        quitting = false;
        return;
      }
      await appWindow.destroy();
    } finally {
      running = false;
    }
  });
}
