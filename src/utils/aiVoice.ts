// The AI voice (components/docker/AiVoicePanel.tsx; engine in src-tauri/src/services/tts.rs).
// Wrappers for its commands, what each voice is like, and the small pure helpers the panel uses.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface VoiceMeta {
  id: string;
  name: string;
  // "Female" / "Male" and the accent - what a person picks a voice by.
  gender: "Female" | "Male";
  accent: "American" | "British";
  // A few words on what it sounds like.
  feel: string;
  recommended?: boolean;
}

// Mirrors the voices services/tts.rs offers (it refuses an id it doesn't know).
export const VOICES: VoiceMeta[] = [
  { id: "af_heart", name: "Heart", gender: "Female", accent: "American", feel: "Warm and expressive", recommended: true },
  { id: "af_bella", name: "Bella", gender: "Female", accent: "American", feel: "Bright and upbeat" },
  { id: "af_nicole", name: "Nicole", gender: "Female", accent: "American", feel: "Soft and close" },
  { id: "af_aoede", name: "Aoede", gender: "Female", accent: "American", feel: "Smooth and clear" },
  { id: "af_kore", name: "Kore", gender: "Female", accent: "American", feel: "Calm and steady" },
  { id: "af_sarah", name: "Sarah", gender: "Female", accent: "American", feel: "Friendly, conversational" },
  { id: "af_nova", name: "Nova", gender: "Female", accent: "American", feel: "Crisp and modern" },
  { id: "am_michael", name: "Michael", gender: "Male", accent: "American", feel: "Confident narrator" },
  { id: "am_fenrir", name: "Fenrir", gender: "Male", accent: "American", feel: "Deep and grounded" },
  { id: "am_puck", name: "Puck", gender: "Male", accent: "American", feel: "Light and lively" },
  { id: "bf_emma", name: "Emma", gender: "Female", accent: "British", feel: "Polished and clear" },
  { id: "bf_isabella", name: "Isabella", gender: "Female", accent: "British", feel: "Warm and measured" },
  { id: "bm_george", name: "George", gender: "Male", accent: "British", feel: "Classic narrator" },
  { id: "bm_fable", name: "Fable", gender: "Male", accent: "British", feel: "Storyteller" },
];

export type TtsStatus = { state: "ready" | "needs-download" | "unsupported"; downloadMb: number };
export interface SpokenFile {
  path: string;
  seconds: number;
  cached: boolean;
}

export const ttsStatus = () => invoke<TtsStatus>("tts_status");
export const downloadTts = () => invoke<void>("download_tts");
export const cancelTtsDownload = () => invoke<void>("cancel_tts_download");
export const ttsSynthesize = (text: string, voice: string, speed: number, pause: number) => invoke<SpokenFile>("tts_synthesize", { text, voice, speed, pause });
export const cancelTts = () => invoke<void>("cancel_tts");
export const ttsPreview = (voice: string) => invoke<string>("tts_preview", { voice });
export const ttsRelease = () => invoke<void>("tts_release");

export const onTtsDownload = (cb: (p: { downloaded: number; total: number }) => void) => listen<{ downloaded: number; total: number }>("tts-download", (e) => cb(e.payload));
export const onTtsProgress = (cb: (p: { done: number; total: number }) => void) => listen<{ done: number; total: number }>("tts-progress", (e) => cb(e.payload));

export const isCancelled = (err: unknown) => /cancel/i.test(err instanceof Error ? err.message : String(err));

// How the gaps between sentences are set. The number scales the silence the engine puts between them.
export const PAUSE_STYLES = [
  { id: "brisk", label: "Brisk", value: 0.6, hint: "Short gaps - energetic, ad or social style" },
  { id: "natural", label: "Natural", value: 1, hint: "How a person reads aloud" },
  { id: "measured", label: "Measured", value: 1.6, hint: "Long gaps - lectures and documentary narration" },
] as const;
export type PauseStyleId = (typeof PAUSE_STYLES)[number]["id"];

export const MIN_SPEED = 0.7;
export const MAX_SPEED = 1.3;

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

// A reading estimate shown before generating: the voice reads about 2.6 words a second at its own
// pace, plus the gaps after sentences. Within a few seconds of the real thing - it only sets expectations.
export function estimateSeconds(text: string, speed: number, pause: number): number {
  const words = wordCount(text);
  if (words === 0) return 0;
  const sentences = (text.match(/[.!?…]+(\s|$)/g) ?? []).length + (text.match(/\n+/g) ?? []).length;
  const speech = words / 2.6 / speed;
  const gaps = (sentences * 0.3 * pause) / speed;
  return speech + gaps;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export interface VoicePrefs {
  voice: string;
  speed: number;
  pause: PauseStyleId;
  text: string;
}
const PREFS_KEY = "briefcast.aiVoice";
const DEFAULT_PREFS: VoicePrefs = { voice: "af_heart", speed: 1, pause: "natural", text: "" };

export function readVoicePrefs(): VoicePrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
    return {
      voice: VOICES.some((v) => v.id === saved.voice) ? saved.voice : DEFAULT_PREFS.voice,
      speed: typeof saved.speed === "number" ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, saved.speed)) : DEFAULT_PREFS.speed,
      pause: PAUSE_STYLES.some((p) => p.id === saved.pause) ? saved.pause : DEFAULT_PREFS.pause,
      text: typeof saved.text === "string" ? saved.text : "",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writeVoicePrefs(prefs: VoicePrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full quota: the panel works the same, it just forgets.
  }
}
