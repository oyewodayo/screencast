// utils/appSettings.ts
//
// App-wide preferences, persisted in localStorage (WebView2 persists this across app restarts
// same as a browser profile would). Deliberately not routed through a Rust command — this is
// small, non-sensitive UI preference data with no need for filesystem placement or the
// asset-scope concerns that apply to actual recording/annotation files.

export interface AppSettings {
  defaultRecordType: string;
  defaultFileExt: string;
  defaultFileNamePrefix: string;
  pdfDefaultZoom: number;
  pdfDefaultTool: "pen" | "highlighter" | "eraser" | "none";
  pdfDefaultPenColor: string;
  pdfDefaultHighlighterColor: string;
  pdfDefaultStrokeWidth: number;
  // "system" follows the OS light/dark preference; "light"/"dark" pin it explicitly.
  theme: "light" | "dark" | "system";
  // Days a deleted file sits in the trash before purge_expired_trash removes it for good, run
  // once on app launch. 0 (or negative) means "never auto-purge — keep until Empty Trash".
  trashRetentionDays: number;
  // Global on/off switch for the system-wide stylus annotation overlay (see
  // AnnotationOverlayWindow.tsx) — when false, Dashboard never creates the overlay window or
  // registers its hotkey at all.
  enableAnnotationTool: boolean;
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
  pdfDefaultTool: "pen",
  pdfDefaultPenColor: "#1a1a1a",
  pdfDefaultHighlighterColor: "#ffd43b",
  pdfDefaultStrokeWidth: 4,
  theme: "system",
  trashRetentionDays: 30,
  // The overlay this drives now stays hidden except for the brief, user-initiated span while
  // draw mode is actually on (see ensure_annotation_overlay/toggleAnnotationDrawMode) - a hidden
  // window can't block input no matter what, which is what makes it safe to default to on rather
  // than requiring an opt-in visit to Settings.
  enableAnnotationTool: true,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch (err) {
    console.error("Failed to load settings, using defaults:", err);
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
