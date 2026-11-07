// utils/appSettings.ts
//
// App-wide preferences. The source of truth is settings.json in the app config directory, owned by
// src-tauri/src/services/settings_store.rs, so the Rust side can read them with no window alive
// (global shortcuts, the tray, the phone remote). This module keeps a synchronous in-memory copy:
// `loadSettings()` is called from render paths and initial-state initialisers all over the app, and
// none of them can await. `initSettings()` fills that copy before the first render (main.tsx), and
// the `settings-changed` event keeps it current when another window saves.
//
// The old home was localStorage under "briefcast.settings.v1". It is read once, to migrate an
// existing install into the file, and never written again.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AnnotationFade, AnnotationPointer, AnnotationStyle, AnnotationTapSound } from "./annotationStyles";

export interface AppSettings {
  defaultRecordType: string;
  defaultFileExt: string;
  defaultFileNamePrefix: string;
  pdfDefaultZoom: number;
  // On: a PDF opens fitted to the window (and stays fitted until zoomed by hand); off: it opens
  // at pdfDefaultZoom.
  pdfFitOnOpen: boolean;
  // How a two-page spread changes: "flip" animates a book page turning, "instant" just swaps -
  // the calmer choice for presenting.
  pdfPageTurn: "flip" | "instant";
  pdfDefaultTool: "pen" | "highlighter" | "eraser" | "none";
  pdfDefaultPenColor: string;
  pdfDefaultHighlighterColor: string;
  pdfDefaultStrokeWidth: number;
  // "system" follows the OS light/dark preference; "light"/"dark" pin it explicitly.
  theme: "light" | "dark" | "system";
  // The "Nothing playing yet" home screen's backdrop (Dashboard.tsx) - "graph" is the decorative
  // glow + faint line-grid look, "plain" is just the flat themed background with no decoration.
  homeBackgroundStyle: "graph" | "plain";
  // Days a deleted file sits in the trash before purge_expired_trash removes it for good, run
  // once on app launch. 0 (or negative) means "never auto-purge — keep until Empty Trash".
  trashRetentionDays: number;
  // Global on/off switch for the system-wide stylus annotation overlay (see
  // AnnotationOverlayWindow.tsx) — when false, Dashboard never creates the overlay window or
  // registers its hotkey at all.
  enableAnnotationTool: boolean;
  // The overlay's ink (see utils/annotationStyles.ts) - re-read by the overlay every time draw mode
  // turns on, so a change here applies from the next Ctrl+Shift+D without a restart. Colour and
  // style can also be switched from the overlay's own toolbar mid-presentation; that's temporary.
  annotationColor: string;
  annotationWidth: number;
  annotationStyle: AnnotationStyle;
  annotationFade: AnnotationFade;
  annotationShadow: boolean;
  // Off hides the overlay's floating toolbar so drawing looks like it comes from nowhere while
  // presenting - its keyboard shortcuts (Esc, Backspace, 1-8, P/M/N/L) still work.
  annotationShowToolbar: boolean;
  // The cursor stand-in shown while drawing (see AnnotationPointer.tsx). "custom" uses
  // annotationPointerImage, a downscaled PNG data URL - empty falls back to the hand.
  annotationPointer: AnnotationPointer;
  annotationPointerImage: string;
  // Expanding ring where each press lands, and the synthesised tap that goes with it (volume 0-1).
  annotationTapRipple: boolean;
  annotationTapSound: AnnotationTapSound;
  annotationSoundVolume: number;
  // Privacy blur (services/screen_blur.rs). Strength 0-100 on top of Windows' own backdrop blur
  // (already unreadable at 0). The WhatsApp rule blurs its chat list by itself - "recording" only
  // while Briefcast records, so everyday WhatsApp use isn't blurred.
  annotationBlurStrength: number;
  annotationAutoBlurWhatsApp: "off" | "recording" | "always";
  // Which parts of WhatsApp that rule covers - the chat list and the open chat's name + photo by
  // default; the messages too if asked.
  annotationBlurWhatsAppParts: { chatList: boolean; contact: boolean; messages: boolean };
  // Sensitive text found on screen with Windows' OCR (services/screen_blur/sensitive.rs). Same
  // off/while recording/always choice; categories plus the user's own comma-separated keywords.
  annotationAutoBlurText: "off" | "recording" | "always";
  annotationBlurTextRules: { passwords: boolean; keys: boolean; financial: boolean; personal: boolean };
  annotationBlurKeywords: string;
  // Whether the full recording setup panel (file name/type/recording options/audio+video
  // device pickers/Screenshot/Start Recording) still appears in the bottom docker. Its fields
  // now live here in Settings as defaults regardless of this - turning it off just also stops
  // showing the panel itself, leaving the ActiveRecordingState shortcut icons as the only way
  // to start a recording from the docker.
  showRecordingDocker: boolean;
  // Whether the screenshot/screen-webcam-mic/record-button cluster at the bottom-right of
  // ActiveRecordingState is visible - unlike showRecordingDocker above, this is meant to be
  // flipped mid-session (Ctrl+Shift+B, see Dashboard.tsx's PANEL_BUTTONS_TOGGLE_SHORTCUT) so
  // it can be hidden right before presenting/recording a screen that includes this app's own
  // window, without those controls ending up baked into the video.
  showRecordingPanelButtons: boolean;
  // The bottom docker's last row - date/time, CPU RAM, OS and the "Request feature / Report a bug"
  // link. Purely informational, so it can be hidden to give the player that extra strip of height.
  showDockerStatusBar: boolean;
  // The "Recording started - saved to <path>" toast (plus its shortcut hints). Off by default: the
  // overlay and the bottom-bar timer already say a recording is running, and the path is shown by
  // the completion window when it's actually there to open.
  notifyOnRecordingStart: boolean;
  // A "3, 2, 1" shown in the middle of the screen between pressing Record and capture starting - time
  // to switch to the window being recorded and get ready. See utils/recordingCountdown.ts.
  recordingCountdownEnabled: boolean;
  recordingCountdownSeconds: number;
  // Windows toast pop-ups (WhatsApp, mail...) are switched off while a recording runs, so they
  // don't end up in the video, and put back when it stops. See services/quiet_notifications.rs.
  muteNotificationsWhileRecording: boolean;
  defaultAudioDevice: string;
  defaultVideoDevices: string[];
  defaultIncludeSystemAudio: boolean;
  // Max output width / target capture fps for the screen-capture record types - null means "let
  // the backend use its own default" (1920px, 60fps for sva/30fps for sa+s - see
  // FormData.resolution_width/framerate's own doc comments, src-tauri/src/commands/recording.rs).
  // Same "untouched setting changes nothing" reasoning as every other default here.
  defaultResolutionWidth: number | null;
  defaultFramerate: number | null;
  // Studio cleanup of every recording's audio once it stops - noise removal, levelling, ducking
  // system audio under the voice, loudness to -16 LUFS (see src-tauri/src/services/
  // audio_enhance.rs). On by default; off keeps the audio exactly as captured (still in sync).
  autoEnhanceAudio: boolean;
  // Webcam bubble border ("none" | "thin" | "medium" | "thick") and its "#rrggbb" colour, chosen
  // in the Screen Options modal and remembered between recordings.
  cameraBorder: string;
  cameraBorderColor: string;
  // Live background behind the person in the webcam bubble while recording (camera_effects.rs) -
  // off unless picked in the Screen Options modal; remembered between recordings.
  cameraBackground: CameraBackgroundPref;
  // Draw the mouse pointer into screen recordings and screenshots (Screen Options -> Options).
  captureCursor: boolean;
  // A window capture includes the window's title bar and frame; off records just its content.
  windowTitleBar: boolean;
  // "Editable pointer": screen recordings leave the pointer out of the picture and record its path,
  // clicks and looks beside it, for the editor to draw smoothed / enlarged / with click ripples
  // (Screen Style). Windows only.
  editablePointer: boolean;
  // "Record shortcuts": keyboard shortcuts (never typing) recorded for the editor's key chips.
  recordShortcuts: boolean;
  // The window's close button: true hides Briefcast to the tray (shortcuts keep working), false
  // quits. null = not decided yet - the first close asks (see closeGuards.ts).
  closeToTray: boolean | null;
  // After a minute in the tray, release the window to give back its memory (roughly 150-300 MB);
  // it is rebuilt when Briefcast is opened again, in a second or two. Shortcuts, the tray, the
  // phone remote and recording all work without it (closeGuards.ts, services/main_window.rs).
  // Off by default until the saving is measured against the reopen cost.
  releaseWindowInTray: boolean;
  // The rest of "my current setup" - what the record shortcut, the tray and the phone remote start
  // with. Persisted (rather than living only in Dashboard state) because Rust builds that start
  // request itself, with no window alive (services/recording_setup.rs). Changed from the bottom
  // bar and the Screen Options modal; remembered between launches.
  cameraOverlayShape: string;
  cameraOverlayPosition: string;
  cameraOverlaySize: string;
  separateWebcamCapture: boolean;
  trackClicks: boolean;
}

export interface CameraBackgroundPref {
  kind: "off" | "blur" | "color" | "image";
  amount: number;
  color: string;
  imagePath: string | null;
}

const STORAGE_KEY = "briefcast.settings.v1";

export const DEFAULT_SETTINGS: AppSettings = {
  defaultRecordType: "sva",
  // mp4/h264 is the one container+codec combo every WebView2/Chromium <video> element decodes
  // natively with hardware acceleration - .avi (the old default) has no WebView2 container
  // support at all regardless of the codec inside it (see get_playable_preview's doc comment in
  // src-tauri/src/commands/conversion.rs), so every fresh install used to force a full blocking
  // re-encode on the very first playback of the very first recording it ever made.
  defaultFileExt: "mp4",
  defaultFileNamePrefix: "Recording",
  pdfDefaultZoom: 1.25,
  pdfFitOnOpen: true,
  pdfPageTurn: "flip",
  pdfDefaultTool: "pen",
  pdfDefaultPenColor: "#1a1a1a",
  pdfDefaultHighlighterColor: "#ffd43b",
  pdfDefaultStrokeWidth: 4,
  theme: "system",
  homeBackgroundStyle: "graph",
  trashRetentionDays: 30,
  // The overlay this drives now stays hidden except for the brief, user-initiated span while
  // draw mode is actually on (see Dashboard.tsx's toggleAnnotationDrawMode) - a hidden
  // window can't block input no matter what, which is what makes it safe to default to on rather
  // than requiring an opt-in visit to Settings.
  enableAnnotationTool: true,
  annotationColor: "#ef4444",
  annotationWidth: 6,
  annotationStyle: "pen",
  annotationFade: "normal",
  annotationShadow: false,
  annotationShowToolbar: true,
  annotationPointer: "hand",
  annotationPointerImage: "",
  annotationTapRipple: true,
  annotationTapSound: "pop",
  annotationSoundVolume: 0.5,
  annotationBlurStrength: 50,
  annotationAutoBlurWhatsApp: "recording",
  annotationBlurWhatsAppParts: { chatList: true, contact: true, messages: false },
  annotationAutoBlurText: "recording",
  annotationBlurTextRules: { passwords: true, keys: true, financial: true, personal: false },
  annotationBlurKeywords: "",
  // Off by default - the bottom-right shortcut icons (see ActiveRecordingState.tsx) are the
  // primary way to start a recording now; the full panel is an opt-in for anyone who wants it.
  showRecordingDocker: false,
  showRecordingPanelButtons: true,
  showDockerStatusBar: true,
  notifyOnRecordingStart: false,
  recordingCountdownEnabled: false,
  recordingCountdownSeconds: 3,
  muteNotificationsWhileRecording: true,
  defaultAudioDevice: "",
  defaultVideoDevices: [],
  defaultIncludeSystemAudio: false,
  defaultResolutionWidth: null,
  defaultFramerate: null,
  autoEnhanceAudio: true,
  cameraBorder: "none",
  cameraBorderColor: "#ffffff",
  cameraBackground: { kind: "off", amount: 0.6, color: "#0f172a", imagePath: null },
  captureCursor: true,
  windowTitleBar: false,
  editablePointer: false,
  recordShortcuts: false,
  closeToTray: null,
  releaseWindowInTray: false,
  cameraOverlayShape: "rounded",
  cameraOverlayPosition: "bottom_right",
  cameraOverlaySize: "small",
  separateWebcamCapture: false,
  trackClicks: false,
};

// One-time correction for installs whose settings were saved back when "avi" was still the coded
// default (see defaultFileExt's own doc comment above for why that was a real problem - no
// WebView2 container support at all, forcing a blocking re-encode on the very first playback of
// the very first recording). Without this, such an install carries "avi" forward as an explicit
// stored choice forever, even after the coded default moved to mp4 - merging saved-over-defaults
// in loadSettings below always lets an explicit stored value win. Gated on its own one-time flag
// (rather than correcting "avi" -> "mp4" unconditionally on every load) so a user who deliberately
// re-selects avi in Settings AFTER this fix ships has that choice actually stick, instead of it
// silently reverting to mp4 on the next launch.
const AVI_DEFAULT_MIGRATION_KEY = "briefcast.settings.aviDefaultMigrated.v1";

function readLegacyLocalStorage(): AppSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const merged: AppSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    if (merged.defaultFileExt === "avi" && !localStorage.getItem(AVI_DEFAULT_MIGRATION_KEY)) {
      merged.defaultFileExt = DEFAULT_SETTINGS.defaultFileExt;
      try {
        localStorage.setItem(AVI_DEFAULT_MIGRATION_KEY, "1");
      } catch {
        // Best-effort - the in-memory correction above still applies either way.
      }
    }
    return merged;
  } catch (err) {
    console.error("Failed to read the legacy settings, using defaults:", err);
    return null;
  }
}

// The in-memory copy every synchronous reader sees. null until initSettings() has run.
let cache: AppSettings | null = null;
// Set once Rust has answered. When it never does (a plain browser tab, unit tests), saves stay
// in memory plus localStorage, which is exactly how this module behaved before the file existed.
let backendAvailable = false;

export const SETTINGS_CHANGED_DOM_EVENT = "briefcast:settings-changed";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function adopt(next: AppSettings): void {
  cache = next;
  window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_DOM_EVENT, { detail: next }));
}

// Saves are coalesced: a burst (a slider, several toggles in one handler) sends only the newest
// object, in order, instead of racing several IPC calls against each other.
let pendingWrite: AppSettings | null = null;
let writing = false;

async function flushWrites(): Promise<void> {
  if (writing) return;
  writing = true;
  try {
    while (pendingWrite) {
      const next = pendingWrite;
      pendingWrite = null;
      try {
        await invoke("set_settings", { settings: next });
      } catch (err) {
        console.error("Failed to save settings:", err);
      }
    }
  } finally {
    writing = false;
  }
}

/**
 * Loads settings from Rust, migrating the legacy localStorage copy on first run, and starts
 * following changes made in other windows. Call once, before the first render, in every window.
 * Never rejects: on any failure the app starts on whatever it can read.
 */
export async function initSettings(): Promise<void> {
  if (!isTauri()) {
    cache = readLegacyLocalStorage() ?? { ...DEFAULT_SETTINGS };
    return;
  }
  try {
    const stored = await invoke<Partial<AppSettings> | null>("get_settings");
    backendAvailable = true;
    if (stored) {
      cache = { ...DEFAULT_SETTINGS, ...stored };
    } else {
      // First launch on the file-backed store: carry the user's existing choices over.
      const legacy = readLegacyLocalStorage();
      cache = legacy ?? { ...DEFAULT_SETTINGS };
      if (legacy) {
        pendingWrite = cache;
        void flushWrites();
      }
    }
    await listen<Partial<AppSettings>>("settings-changed", (event) => {
      const next = { ...DEFAULT_SETTINGS, ...event.payload };
      // Our own save echoes back through here; nothing to do if it matches what we hold.
      if (cache && JSON.stringify(next) === JSON.stringify(cache)) return;
      adopt(next);
    });
  } catch (err) {
    console.error("Failed to load settings from the backend, falling back to local storage:", err);
    backendAvailable = false;
    cache = readLegacyLocalStorage() ?? { ...DEFAULT_SETTINGS };
  }
}

export function loadSettings(): AppSettings {
  // Before initSettings() (tests, a module that runs at import time) read the legacy copy rather
  // than hand back defaults that would then be saved over the user's real choices.
  if (!cache) cache = readLegacyLocalStorage() ?? { ...DEFAULT_SETTINGS };
  return { ...cache };
}

/**
 * Merges `patch` into the current settings and saves, but only when something actually changed -
 * so write-through effects can call it on every render-driven change without a disk write each
 * time. Returns whether a save happened.
 */
export function updateSettings(patch: Partial<AppSettings>): boolean {
  const current = loadSettings();
  const changed = (Object.keys(patch) as (keyof AppSettings)[]).some(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(patch[key]),
  );
  if (changed) saveSettings({ ...current, ...patch });
  return changed;
}

export function saveSettings(settings: AppSettings): void {
  cache = { ...settings };
  if (backendAvailable) {
    pendingWrite = cache;
    void flushWrites();
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    console.error("Failed to save settings:", err);
  }
}
