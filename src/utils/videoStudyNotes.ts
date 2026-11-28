// utils/videoStudyNotes.ts
//
// Persistent timestamped study notes & captured slide frames for Briefcast's Smart Video Player
// Study Mode. Stored in a `.notes.json` sidecar next to the video (never touching `.edits.json`),
// so studying a lecture never pollutes Video Editor Home's "Continue editing" shelf.
import { invoke } from "@tauri-apps/api/core";
import { formatChapterTimestamp } from "./videoChapters";

export type StudyNoteTag = "note" | "key" | "question" | "todo";

export interface StudyNote {
  id: string;
  /** Video timestamp in seconds. */
  time: number;
  /** User's jotted note text. */
  text: string;
  /** Categorization tag for quick filtering & structured doc export. */
  tag: StudyNoteTag;
  /** Optional caption/transcript quote grabbed from that moment. */
  quote?: string;
  /** Optional captured video frame data URL (compact JPEG ~640px wide). */
  snapshotDataUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface StudyNotesSidecar {
  version: 1;
  autoPauseOnType: boolean;
  notes: StudyNote[];
}

export const STUDY_NOTE_TAGS: {
  id: StudyNoteTag;
  label: string;
  shortLabel: string;
  dotClass: string;
  badgeClass: string;
  emoji: string;
}[] = [
  {
    id: "note",
    label: "Note",
    shortLabel: "Note",
    dotClass: "bg-sky-400",
    badgeClass: "bg-sky-500/20 text-sky-200 ring-sky-400/30",
    emoji: "Note",
  },
  {
    id: "key",
    label: "Key Idea",
    shortLabel: "Key",
    dotClass: "bg-amber-400",
    badgeClass: "bg-amber-500/20 text-amber-200 ring-amber-400/30",
    emoji: "Key Idea",
  },
  {
    id: "question",
    label: "Question",
    shortLabel: "Question",
    dotClass: "bg-violet-400",
    badgeClass: "bg-violet-500/20 text-violet-200 ring-violet-400/30",
    emoji: "Question",
  },
  {
    id: "todo",
    label: "Action",
    shortLabel: "Action",
    dotClass: "bg-emerald-400",
    badgeClass: "bg-emerald-500/20 text-emerald-200 ring-emerald-400/30",
    emoji: "Action",
  },
];

export function tagMeta(tag: StudyNoteTag) {
  return STUDY_NOTE_TAGS.find((t) => t.id === tag) ?? STUDY_NOTE_TAGS[0];
}

export function defaultStudyNotesSidecar(): StudyNotesSidecar {
  return { version: 1, autoPauseOnType: true, notes: [] };
}

export function sortStudyNotes(notes: StudyNote[]): StudyNote[] {
  return [...notes].sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
}

export function parseStudyNotesJson(raw: string | null | undefined): StudyNotesSidecar {
  if (!raw) return defaultStudyNotesSidecar();
  try {
    const parsed = JSON.parse(raw) as Partial<StudyNotesSidecar>;
    const rawNotes = Array.isArray(parsed.notes) ? parsed.notes : [];
    const validTags = new Set<StudyNoteTag>(["note", "key", "question", "todo"]);
    const notes: StudyNote[] = rawNotes
      .filter((n): n is StudyNote => !!n && typeof n.id === "string" && typeof n.time === "number" && Number.isFinite(n.time))
      .map((n) => ({
        id: n.id,
        time: Math.max(0, n.time),
        text: typeof n.text === "string" ? n.text : "",
        tag: validTags.has(n.tag) ? n.tag : "note",
        quote: typeof n.quote === "string" && n.quote.trim() ? n.quote.trim() : undefined,
        snapshotDataUrl: typeof n.snapshotDataUrl === "string" && n.snapshotDataUrl.startsWith("data:image/") ? n.snapshotDataUrl : undefined,
        createdAt: typeof n.createdAt === "number" ? n.createdAt : Date.now(),
        updatedAt: typeof n.updatedAt === "number" ? n.updatedAt : Date.now(),
      }));
    return {
      version: 1,
      autoPauseOnType: typeof parsed.autoPauseOnType === "boolean" ? parsed.autoPauseOnType : true,
      notes: sortStudyNotes(notes),
    };
  } catch {
    return defaultStudyNotesSidecar();
  }
}

export async function loadStudyNotes(videoPath: string): Promise<StudyNotesSidecar> {
  try {
    const raw = await invoke<string | null>("load_video_notes", { videoPath });
    return parseStudyNotesJson(raw);
  } catch {
    return defaultStudyNotesSidecar();
  }
}

export async function saveStudyNotes(videoPath: string, data: StudyNotesSidecar): Promise<void> {
  const payload: StudyNotesSidecar = {
    version: 1,
    autoPauseOnType: data.autoPauseOnType,
    notes: sortStudyNotes(data.notes),
  };
  await invoke("save_video_notes", { videoPath, json: JSON.stringify(payload) });
}

export function filterStudyNotes(
  notes: StudyNote[],
  query: string,
  tagFilter: StudyNoteTag | "all"
): StudyNote[] {
  const q = query.trim().toLowerCase();
  return sortStudyNotes(notes).filter((n) => {
    if (tagFilter !== "all" && n.tag !== tagFilter) return false;
    if (!q) return true;
    const ts = formatChapterTimestamp(n.time);
    return (
      n.text.toLowerCase().includes(q) ||
      (n.quote?.toLowerCase().includes(q) ?? false) ||
      ts.includes(q) ||
      tagMeta(n.tag).label.toLowerCase().includes(q)
    );
  });
}

/**
 * Grabs the live rendered frame from an HTMLVideoElement as a compact JPEG data URL (~640px wide)
 * so slide/diagram captures inside Study Mode are instantaneous (0ms) and lightweight on disk.
 */
export function captureVideoFrameDataUrl(video: HTMLVideoElement, maxWidth = 640, quality = 0.82): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = vw > maxWidth ? maxWidth / vw : 1;
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", quality);
  } catch {
    return null;
  }
}

/**
 * Finds the spoken caption/transcript snippet around `timeSec` so the user can 1-click quote
 * the speaker's exact words into a study note.
 */
export function extractCaptionQuoteAt(
  lines: { start: number; end: number; text: string }[],
  timeSec: number,
  windowSec = 6
): string {
  if (lines.length === 0) return "";
  const active = lines.find((l) => timeSec >= l.start - 0.3 && timeSec <= l.end + 0.6);
  if (active) {
    const idx = lines.indexOf(active);
    const slice = lines.slice(Math.max(0, idx - 1), Math.min(lines.length, idx + 2));
    return slice
      .map((l) => l.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }
  const nearby = lines.filter((l) => l.end >= timeSec - windowSec && l.start <= timeSec + 1);
  return nearby
    .map((l) => l.text.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Converts study notes into clean Markdown suitable for copying to clipboard or embedding into a
 * Briefcast Doc. When `snapshotUrlByNoteId` is provided (from saved doc assets), embeds those
 * persisted asset URLs instead of raw inline data URLs.
 */
export function studyNotesToMarkdown(
  notes: StudyNote[],
  options?: {
    videoTitle?: string;
    includeHeader?: boolean;
    snapshotUrlByNoteId?: Map<string, string>;
  }
): string {
  const sorted = sortStudyNotes(notes);
  if (sorted.length === 0) return "";
  const lines: string[] = [];
  if (options?.includeHeader) {
    lines.push(`# ${options.videoTitle ? `${options.videoTitle} — Study Notes` : "Study Notes"}`);
    lines.push("");
  }
  for (const note of sorted) {
    const ts = formatChapterTimestamp(note.time);
    const meta = tagMeta(note.tag);
    const tagPrefix = note.tag === "note" ? "" : ` [${meta.label}]`;
    const body = note.text.trim();
    if (body) {
      lines.push(`- **${ts}**${tagPrefix} — ${body}`);
    } else {
      lines.push(`- **${ts}**${tagPrefix} — *Captured slide*`);
    }
    if (note.quote) {
      lines.push(`  > "${note.quote}"`);
    }
    const imgSrc = options?.snapshotUrlByNoteId?.get(note.id);
    if (imgSrc) {
      lines.push("");
      lines.push(`![Slide at ${ts}](${imgSrc})`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
