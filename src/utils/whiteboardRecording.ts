// utils/whiteboardRecording.ts
//
// Pure helpers for Whiteboard Presentation Recording:
//   - Converts the Whiteboard stage DOM rect + window physical origin into an even-dimensioned
//     `region:x,y,w,h` spec for Briefcast's native GPU capture pipeline.
//   - Sanitizes whiteboard titles into clean recording stems.
//   - Deduplicates rapid slide stepping into clean `.chapters.json` markers.

export interface ScreenCaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  spec: string;
}

export interface RecordedSlideMark {
  time: number;
  label: string;
}

export interface SavedVideoChapter {
  id: string;
  time: number;
  label: string;
}

const MIN_REGION_PX = 64;

/**
 * Converts a DOM element's client rect plus its Tauri window's physical inner position and scale
 * factor into an even-dimensioned screen-space region spec (`region:x,y,w,h`) safe for YUV420
 * hardware video encoders.
 */
export function computeScreenCaptureRegion(
  rect: { left: number; top: number; width: number; height: number },
  windowInnerPos: { x: number; y: number },
  scaleFactor: number
): ScreenCaptureRegion | null {
  const scale = Number.isFinite(scaleFactor) && scaleFactor > 0 ? scaleFactor : 1;
  const x = Math.round(windowInnerPos.x + rect.left * scale);
  const y = Math.round(windowInnerPos.y + rect.top * scale);
  const width = Math.floor(rect.width * scale) & ~1;
  const height = Math.floor(rect.height * scale) & ~1;
  if (width < MIN_REGION_PX || height < MIN_REGION_PX) return null;
  return {
    x,
    y,
    width,
    height,
    spec: `region:${x},${y},${width},${height}`,
  };
}

export function sanitizeRecordingFileName(title: string | null | undefined, fallback = "Whiteboard Presentation"): string {
  const cleaned = (title ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

/**
 * Turns raw slide-visit marks captured during a live presentation into crisp `.chapters.json`
 * chapters: collapses rapid click-throughs (< minDwellSec) and collapses back-to-back duplicate
 * labels while anchoring the opening slide cleanly at 0:00.
 */
export function buildChaptersFromSlideMarks(
  marks: RecordedSlideMark[],
  minDwellSec = 1.5
): SavedVideoChapter[] {
  const valid = marks
    .filter((m) => Number.isFinite(m.time) && m.time >= 0 && m.label.trim().length > 0)
    .map((m) => ({ time: Math.round(m.time * 100) / 100, label: m.label.trim() }))
    .sort((a, b) => a.time - b.time);

  if (valid.length === 0) return [];

  const filtered: RecordedSlideMark[] = [];
  for (let i = 0; i < valid.length; i++) {
    const cur = valid[i];
    const next = valid[i + 1];
    // Skip transient slides stepped over in < minDwellSec (unless it's the final slide).
    if (next && next.time - cur.time < minDwellSec) continue;
    const prev = filtered[filtered.length - 1];
    if (prev && prev.label === cur.label) continue;
    filtered.push(cur);
  }

  if (filtered.length === 0) {
    filtered.push(valid[valid.length - 1]);
  }

  filtered[0] = { ...filtered[0], time: 0 };

  return filtered.map((m, idx) => ({
    id: `wb-slide-${idx + 1}-${Math.round(m.time * 100)}`,
    time: m.time,
    label: m.label,
  }));
}

export function formatRecordingTimer(elapsedMs: number): string {
  const totalSec = Math.max(0, Math.floor(elapsedMs / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
}
