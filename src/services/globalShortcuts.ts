// services/globalShortcuts.ts
//
// System-wide shortcuts are registered by Rust (src-tauri/src/services/shortcuts.rs), not here:
// a registration made from a page died with the page, and after a reload it pointed at the dead
// page's callback. Pages only *listen*: every press arrives as a `global-shortcut` event naming
// its action, and each page acts on the actions it owns. Subscribing and unsubscribing can never
// drop a registration, so React effects here need none of the old ordering care.
//
// The groups that follow app state (a recording, the live display) are switched from here; the
// always-on and annotation groups are managed by Rust itself (the latter follows the settings file).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ShortcutAction =
  | "record-toggle"
  | "panel-buttons-toggle"
  | "snip"
  | "annotation-toggle"
  | "blur-window"
  | "overlay-toggle"
  | "view-switch"
  | `presentation-cut-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | "presentation-all"
  | "presentation-layout";

/** Groups a page may switch. "always" and "annotation" are owned by Rust. */
export type SwitchableShortcutGroup = "recording" | "view-switch" | "presentation";

export interface ShortcutFailure {
  action: ShortcutAction;
  accelerator: string;
  reason: string;
}

/**
 * Calls `handler` for every shortcut press. Returns an unsubscribe function usable directly as a
 * React effect cleanup - it also covers the case where the effect is torn down before `listen`
 * has resolved (StrictMode's mount -> unmount -> mount).
 */
export function onGlobalShortcut(handler: (action: ShortcutAction) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen<{ action: ShortcutAction }>("global-shortcut", (event) => handler(event.payload.action)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Switches a state-driven group on or off. Idempotent on the Rust side. */
export async function setShortcutGroup(group: SwitchableShortcutGroup, active: boolean): Promise<void> {
  try {
    await invoke("set_shortcut_group", { group, active });
  } catch (err) {
    console.error(`Couldn't switch the ${group} shortcuts ${active ? "on" : "off"}:`, err);
  }
}

/** "CommandOrControl+Shift+R" -> "Ctrl+Shift+R" (Cmd on macOS). */
export function shortcutLabel(accelerator: string): string {
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  return accelerator.replace("CommandOrControl", mac ? "Cmd" : "Ctrl");
}

/**
 * Tells the user about shortcuts another app holds - both those that already failed before this
 * page loaded and any that fail later (e.g. turning the annotation tool on in Settings).
 */
export function onShortcutFailures(report: (failures: ShortcutFailure[]) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void invoke<ShortcutFailure[]>("shortcut_failures")
    .then((existing) => {
      if (!disposed && existing.length > 0) report(existing);
    })
    .catch((err) => console.error("Couldn't read shortcut failures:", err));
  void listen<ShortcutFailure>("global-shortcut-failed", (event) => report([event.payload])).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** One sentence for the error banner. */
export function describeShortcutFailures(failures: ShortcutFailure[]): string {
  const keys = failures.map((f) => shortcutLabel(f.accelerator)).join(", ");
  return failures.length === 1
    ? `Couldn't register the shortcut ${keys} - another app may already be using it.`
    : `Couldn't register the shortcuts ${keys} - other apps may already be using them.`;
}
