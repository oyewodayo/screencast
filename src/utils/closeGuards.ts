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
// comes from the tray menu's "Quit Briefcast" (beginQuit) or from closeToTray being off.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ask } from "@tauri-apps/plugin-dialog";
import { loadSettings, saveSettings } from "./appSettings";

// Resolves false to keep the window open (the user said "keep recording", say).
export type CloseGuard = () => boolean | Promise<boolean>;

const guards = new Set<CloseGuard>();

export function addCloseGuard(guard: CloseGuard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
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

async function hideToTray(): Promise<boolean> {
  const appWindow = getCurrentWebviewWindow();
  const settings = loadSettings();
  if (settings.closeToTray === null) {
    const keep = await ask(
      "Briefcast can keep running in the tray by the clock, so Ctrl+Shift+R still starts a recording. Reopen it any time from the tray icon. You can change this later in Settings.",
      { title: "Keep Briefcast running?", kind: "info", okLabel: "Keep running in tray", cancelLabel: "Quit" }
    );
    saveSettings({ ...loadSettings(), closeToTray: keep });
    if (!keep) return false;
  }
  await appWindow.hide();
  return true;
}

let installed = false;
export function installCloseGuards(): void {
  if (installed) return;
  installed = true;
  const appWindow = getCurrentWebviewWindow();
  let running = false; // a double-click on the close button runs the guards once
  void appWindow.onCloseRequested(async (event) => {
    event.preventDefault();
    if (running) return;
    running = true;
    try {
      if (!quitting && loadSettings().closeToTray !== false && (await hideToTray())) return;
      for (const guard of [...guards]) {
        let ok = true;
        try {
          ok = await guard();
        } catch (err) {
          // A failing guard (a save that errored) must never trap the user in an unclosable app.
          console.error("Close guard failed:", err);
        }
        if (!ok) {
          quitting = false;
          return;
        }
      }
      await appWindow.destroy();
    } finally {
      running = false;
    }
  });
}
