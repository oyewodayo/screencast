// utils/videoToDoc.ts
//
// Turns a Briefcast video into a structured, illustrated, linked Briefcast Doc:
//   1. Uses existing timeline captions or automatically transcribes speech offline (Whisper).
//   2. Resolves chapters from timeline markers, player `.chapters.json`, or offline TextTiling.
//   3. Extracts a local extractive Summary and Key Takeaways from the transcript (zero cloud calls).
//   4. Captures keyframe PNG screenshots at each chapter via `extract_frame_still` and stores them
//      inside the doc's own asset folder via `save_doc_image`.
//   5. Writes native Yjs/ProseMirror content and links the doc back to the source video.
import * as Y from "yjs";
import { getSchema } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { prosemirrorToYDoc } from "y-prosemirror";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { buildCaptionLines, defaultCaptionSettings } from "./captions";
import { clipOutputDuration, outputOffsetToSource } from "./clipTiming";
import { markdownToHtml } from "./docFileImport";
import { getDocContentExtensions } from "./docSchemaExtensions";
import { formatChapterTimestamp, stem, STOPWORDS, suggestChapters, tokenize } from "./videoChapters";
import type { CaptionTrack, CaptionWord, Clip } from "./videoEditTypes";
import { loadStudyNotes, studyNotesToMarkdown, type StudyNote } from "./videoStudyNotes";

export const OPEN_BRIEFCAST_DOC_EVENT = "briefcast:open-doc";

export function openBriefcastDoc(docId: string): void {
  window.dispatchEvent(new CustomEvent<{ docId: string }>(OPEN_BRIEFCAST_DOC_EVENT, { detail: { docId } }));
}

export interface VideoTranscriptLine {
  start: number;
  end: number;
  text: string;
}

export interface VideoDocChapter {
  time: number;
  label: string;
}

export interface VideoDocScreenshot {
  chapterIndex: number;
  time: number;
  src: string;
  alt: string;
}

export interface VideoToDocInput {
  fileName: string;
  title?: string;
  durationSec?: number;
  chapters?: VideoDocChapter[];
  lines?: VideoTranscriptLine[];
  watchUrl?: string | null;
  includeTranscript?: boolean;
  screenshots?: VideoDocScreenshot[];
  studyNotes?: StudyNote[];
  studyNoteSnapshotUrls?: Map<string, string>;
  createdAt?: Date;
}

export interface GeneratedVideoDoc {
  title: string;
  markdown: string;
  stats: {
    chapterCount: number;
    wordCount: number;
    durationSec: number;
  };
}

export interface VideoToDocProgress {
  stage: "transcribing" | "downloading-model" | "analyzing" | "screenshots" | "saving";
  label: string;
  percent: number | null;
}

export interface CreateDocFromVideoOptions extends VideoToDocInput {
  clips?: Clip[];
  captions?: CaptionTrack | null;
  sourcePaths?: string[];
  autoTranscribe?: boolean;
  language?: string;
  captureScreenshots?: boolean;
  maxScreenshots?: number;
  signal?: AbortSignal;
  onProgress?: (progress: VideoToDocProgress) => void;
  onTranscriptGenerated?: (language: string, transcripts: Record<string, CaptionWord[]>) => void;
}

// Turns "screen_recording_2026_11_26.mp4" or "product-demo-v2.mp4" into a clean readable title.
export function humanizeVideoTitle(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const rawStem = base.replace(/\.[^.]+$/, "").trim();
  if (!rawStem) return "Video Notes";
  const cleaned = rawStem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

// Merges choppy subtitle lines into readable paragraphs split on natural pauses (>= 2.2s)
// or ~45–65 words at a sentence boundary so the generated document reads like prose, not raw SRT.
export function groupTranscriptIntoParagraphs(lines: VideoTranscriptLine[]): { start: number; text: string }[] {
  const cleaned = lines
    .map((l) => ({ start: l.start, end: l.end, text: l.text.replace(/\s+/g, " ").trim() }))
    .filter((l) => l.text.length > 0);
  if (cleaned.length === 0) return [];

  const paragraphs: { start: number; text: string }[] = [];
  let bufStart = cleaned[0].start;
  let bufParts: string[] = [];
  let bufWords = 0;
  let prevEnd = cleaned[0].end;

  const flush = () => {
    if (bufParts.length === 0) return;
    paragraphs.push({ start: bufStart, text: bufParts.join(" ").replace(/\s+([.,!?;:])/g, "$1") });
    bufParts = [];
    bufWords = 0;
  };

  for (let i = 0; i < cleaned.length; i++) {
    const line = cleaned[i];
    const gap = i > 0 ? line.start - prevEnd : 0;
    const prevText = bufParts[bufParts.length - 1] ?? "";
    const endedSentence = /[.!?]["']?$/.test(prevText);

    if (bufParts.length > 0 && (gap >= 2.2 || (bufWords >= 45 && endedSentence) || bufWords >= 75)) {
      flush();
      bufStart = line.start;
    }

    if (bufParts.length === 0) bufStart = line.start;
    bufParts.push(line.text);
    bufWords += line.text.split(/\s+/).length;
    prevEnd = Math.max(prevEnd, line.end);
  }
  flush();
  return paragraphs;
}

// Local offline extractive summary + key takeaways scored by TF-IDF distinctiveness so the doc
// opens with real insights from what was actually said rather than generic placeholders.
export function extractVideoHighlights(
  paragraphs: { start: number; text: string }[],
  maxTakeaways = 4
): { summary: string; takeaways: string[] } {
  interface SentenceItem {
    index: number;
    start: number;
    text: string;
    tokens: string[];
  }
  const sentences: SentenceItem[] = [];
  for (const p of paragraphs) {
    const rawSentences = p.text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 24);
    const list = rawSentences.length > 0 ? rawSentences : [p.text.trim()];
    for (const s of list) {
      const words = s.split(/\s+/).filter(Boolean);
      if (words.length < 6) continue;
      const tokens = words
        .map((w) => tokenize(w))
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
        .map(stem);
      if (tokens.length < 2) continue;
      sentences.push({ index: sentences.length, start: p.start, text: s, tokens });
    }
  }

  if (sentences.length === 0) {
    const fallback = paragraphs
      .slice(0, 2)
      .map((p) => p.text)
      .join(" ")
      .slice(0, 320);
    return { summary: fallback, takeaways: [] };
  }

  // Document frequency per stem across sentences.
  const df = new Map<string, number>();
  for (const s of sentences) {
    for (const t of new Set(s.tokens)) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const N = sentences.length;

  const scored = sentences.map((s) => {
    const tf = new Map<string, number>();
    for (const t of s.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const [t, count] of tf) {
      const idf = Math.log(1 + N / (df.get(t) ?? 1));
      score += count * idf;
    }
    const wordCount = s.text.split(/\s+/).length;
    // Prefer concise, complete statements (10–28 words).
    const lengthFactor = wordCount >= 10 && wordCount <= 28 ? 1.25 : wordCount > 40 ? 0.7 : 1;
    // Normalize mildly by token count so very long run-ons don't automatically dominate.
    return { ...s, score: (score / Math.sqrt(Math.max(1, s.tokens.length))) * lengthFactor };
  });

  // Summary: opening context + top distinct sentence (in chronological order).
  const summaryCount = Math.min(2, scored.length);
  const topForSummary = [...scored].sort((a, b) => b.score - a.score).slice(0, summaryCount);
  topForSummary.sort((a, b) => a.index - b.index);
  const summary = topForSummary.map((s) => s.text).join(" ");

  // Takeaways: pick top sentences spread across distinct parts of the video.
  const picked: typeof scored = [];
  const bucketCount = Math.max(1, Math.min(maxTakeaways, Math.ceil(scored.length / 2)));
  const bucketSize = Math.max(1, Math.ceil(scored.length / bucketCount));
  for (let b = 0; b < bucketCount; b++) {
    const slice = scored.slice(b * bucketSize, (b + 1) * bucketSize);
    const best = slice.sort((a, b2) => b2.score - a.score)[0];
    if (best && !picked.some((p) => p.text === best.text)) picked.push(best);
  }
  picked.sort((a, b) => a.index - b.index);

  const takeaways = picked.slice(0, maxTakeaways).map((s) => {
    const clean = s.text.length > 180 ? `${s.text.slice(0, 177).trimEnd()}…` : s.text;
    return `**${formatChapterTimestamp(s.start)}** — ${clean}`;
  });

  return { summary, takeaways };
}

// Plans which output timestamps to capture screenshots from (capped so long recordings stay fast).
export function pickScreenshotMoments(
  chapters: VideoDocChapter[],
  durationSec: number,
  maxShots = 8
): { chapterIndex: number; time: number; label: string }[] {
  const safeDur = Math.max(0, durationSec);
  if (chapters.length > 0) {
    const indices: number[] = [];
    if (chapters.length <= maxShots) {
      for (let i = 0; i < chapters.length; i++) indices.push(i);
    } else {
      for (let k = 0; k < maxShots; k++) {
        indices.push(Math.round((k * (chapters.length - 1)) / (maxShots - 1)));
      }
    }
    return [...new Set(indices)].map((idx) => {
      const ch = chapters[idx];
      const next = chapters[idx + 1]?.time ?? safeDur;
      const offset = Math.min(1.5, Math.max(0, (next - ch.time) * 0.25));
      const t = safeDur > 0 ? Math.min(Math.max(0, safeDur - 0.25), ch.time + offset) : Math.max(0, ch.time);
      return { chapterIndex: idx, time: t, label: ch.label.trim() || `Chapter ${idx + 1}` };
    });
  }

  if (safeDur <= 0) return [];
  const count = safeDur < 30 ? 2 : safeDur < 180 ? 4 : Math.min(maxShots, 6);
  const out: { chapterIndex: number; time: number; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const frac = count === 1 ? 0.15 : (i + 0.5) / count;
    const t = Math.max(0, Math.min(safeDur - 0.25, safeDur * frac));
    out.push({ chapterIndex: i, time: t, label: `Moment ${i + 1}` });
  }
  return out;
}

export function buildVideoDocMarkdown(input: VideoToDocInput): GeneratedVideoDoc {
  const title = (input.title?.trim() || humanizeVideoTitle(input.fileName)).slice(0, 140);
  const chapters = [...(input.chapters ?? [])]
    .filter((c) => Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time);
  const lines = [...(input.lines ?? [])]
    .filter((l) => Number.isFinite(l.start) && l.text.trim().length > 0)
    .sort((a, b) => a.start - b.start);
  const includeTranscript = input.includeTranscript !== false;
  const screenshotsByChapter = new Map<number, VideoDocScreenshot>();
  for (const shot of input.screenshots ?? []) {
    screenshotsByChapter.set(shot.chapterIndex, shot);
  }

  const durationSec = Math.max(
    0,
    input.durationSec ??
      Math.max(
        lines.length ? lines[lines.length - 1].end : 0,
        chapters.length ? chapters[chapters.length - 1].time : 0
      )
  );

  const allParagraphs = groupTranscriptIntoParagraphs(lines);
  const highlights = allParagraphs.length > 0 ? extractVideoHighlights(allParagraphs) : null;

  const parts: string[] = [];
  parts.push(`# ${title}`);

  const metaBits: string[] = [];
  const baseName = input.fileName.split(/[\\/]/).pop() ?? input.fileName;
  if (baseName) metaBits.push(`Source: ${baseName}`);
  if (durationSec > 0) metaBits.push(`Duration: ${formatChapterTimestamp(durationSec)}`);
  if (input.createdAt) {
    metaBits.push(input.createdAt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
  }
  if (metaBits.length > 0) {
    parts.push(`*${metaBits.join(" · ")}*`);
  }

  if (input.watchUrl?.trim()) {
    parts.push(`> Watch the video: [${input.watchUrl.trim()}](${input.watchUrl.trim()})`);
  }

  // My Study Notes (if the user took notes in Study Mode, place them front and center!)
  if (input.studyNotes && input.studyNotes.length > 0) {
    const notesMd = studyNotesToMarkdown(input.studyNotes, {
      includeHeader: false,
      snapshotUrlByNoteId: input.studyNoteSnapshotUrls,
    });
    if (notesMd) {
      parts.push("## My Study Notes");
      parts.push(notesMd);
    }
  }

  // Summary section (real extracted summary whenever speech exists)
  if (highlights?.summary) {
    parts.push("## Summary");
    parts.push(highlights.summary);
  }

  // Chapters outline
  if (chapters.length > 0) {
    parts.push("## Chapters");
    parts.push(
      chapters
        .map((c, idx) => `- **${formatChapterTimestamp(c.time)}** — ${c.label.trim() || `Chapter ${idx + 1}`}`)
        .join("\n")
    );
  }

  // Key Takeaways (only included with real extracted insights — never empty dashes)
  if (highlights && highlights.takeaways.length > 0) {
    parts.push("## Key Takeaways");
    parts.push(highlights.takeaways.map((t) => `- ${t}`).join("\n"));
  }

  // Body content:
  // 1) Chapters + Transcript (with optional chapter screenshots)
  // 2) Transcript only (with optional keyframe screenshots)
  // 3) Chapters only (with optional screenshots)
  // 4) Silent visual walkthrough (screenshots at key moments)
  if (chapters.length > 0 && lines.length > 0 && includeTranscript) {
    parts.push("## Walkthrough & Transcript");
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const nextTime = i + 1 < chapters.length ? chapters[i + 1].time : Infinity;
      const chLines = lines.filter((l) => (i === 0 ? l.start < nextTime : l.start >= ch.time && l.start < nextTime));
      const label = ch.label.trim() || `Chapter ${i + 1}`;
      parts.push(`### ${formatChapterTimestamp(ch.time)} — ${label}`);
      const shot = screenshotsByChapter.get(i);
      if (shot) parts.push(`![${shot.alt}](${shot.src})`);
      if (chLines.length > 0) {
        for (const p of groupTranscriptIntoParagraphs(chLines)) {
          parts.push(p.text);
        }
      } else {
        parts.push("*No spoken transcript in this section.*");
      }
    }
  } else if (lines.length > 0 && includeTranscript) {
    parts.push("## Transcript");
    const shots = [...(input.screenshots ?? [])].sort((a, b) => a.time - b.time);
    let nextShotIdx = 0;
    for (const p of allParagraphs) {
      while (nextShotIdx < shots.length && shots[nextShotIdx].time <= p.start + 1) {
        const s = shots[nextShotIdx++];
        parts.push(`![${s.alt}](${s.src})`);
      }
      parts.push(`**${formatChapterTimestamp(p.start)}** ${p.text}`);
    }
  } else if (chapters.length > 0) {
    parts.push("## Visual Walkthrough");
    for (let i = 0; i < chapters.length; i++) {
      const ch = chapters[i];
      const label = ch.label.trim() || `Chapter ${i + 1}`;
      parts.push(`### ${formatChapterTimestamp(ch.time)} — ${label}`);
      const shot = screenshotsByChapter.get(i);
      if (shot) parts.push(`![${shot.alt}](${shot.src})`);
    }
  } else if ((input.screenshots?.length ?? 0) > 0) {
    parts.push("## Visual Walkthrough");
    for (const shot of [...(input.screenshots ?? [])].sort((a, b) => a.time - b.time)) {
      parts.push(`### ${formatChapterTimestamp(shot.time)} — ${shot.alt}`);
      parts.push(`![${shot.alt}](${shot.src})`);
    }
  } else {
    parts.push("## Notes");
    parts.push("*No spoken transcript was detected in this video. Add your notes below.*");
  }

  const markdown = parts.join("\n\n");
  const wordCount = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/[#*_>`[\]()-]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;

  return {
    title,
    markdown,
    stats: {
      chapterCount: chapters.length,
      wordCount,
      durationSec,
    },
  };
}

function sourceMomentForOutputTime(
  clips: Clip[] | undefined,
  fallbackPath: string,
  outputTime: number
): { sourcePath: string; sourceTime: number } {
  if (!clips || clips.length === 0) return { sourcePath: fallbackPath, sourceTime: Math.max(0, outputTime) };
  let at = 0;
  for (const clip of clips) {
    const d = clipOutputDuration(clip);
    if (outputTime < at + d || clip === clips[clips.length - 1]) {
      const local = Math.max(0, Math.min(d, outputTime - at));
      return { sourcePath: clip.sourcePath, sourceTime: outputOffsetToSource(clip, local) };
    }
    at += d;
  }
  return { sourcePath: fallbackPath, sourceTime: Math.max(0, outputTime) };
}

// End-to-end Video -> Briefcast Doc generator:
// transcribes if needed, resolves/detects chapters, captures keyframe screenshots into the doc's
// asset folder, writes rich Yjs/ProseMirror content, and links the doc to the source video.
export async function createDocFromVideo(
  sourceVideoPath: string,
  options: CreateDocFromVideoOptions
): Promise<{ id: string; title: string; wordCount: number; chapterCount: number; screenshotCount: number }> {
  const {
    clips,
    captions: existingCaptions,
    sourcePaths: providedSourcePaths,
    autoTranscribe = true,
    language = "auto",
    captureScreenshots = true,
    maxScreenshots = 8,
    signal,
    onProgress,
    onTranscriptGenerated,
  } = options;

  let lines: VideoTranscriptLine[] = [...(options.lines ?? [])];
  let captionTrack: CaptionTrack | null = existingCaptions ?? null;
  const distinctSources = providedSourcePaths?.length
    ? providedSourcePaths
    : clips?.length
      ? [...new Set(clips.map((c) => c.sourcePath))]
      : [sourceVideoPath];

  // Step 1: Transcribe offline automatically if no transcript lines were supplied yet.
  if (lines.length === 0 && autoTranscribe && distinctSources.length > 0) {
    onProgress?.({ stage: "transcribing", label: "Extracting audio & starting offline speech engine…", percent: null });
    const unlistenProgress = await listen<number>("captions-progress", (event) => {
      onProgress?.({ stage: "transcribing", label: "Transcribing speech offline…", percent: event.payload });
    });
    const unlistenModel = await listen<{ downloaded: number; total: number }>("whisper-model-download", (event) => {
      const { downloaded, total } = event.payload;
      if (downloaded < total && total > 0) {
        onProgress?.({
          stage: "downloading-model",
          label: "Downloading speech model (one time)…",
          percent: (downloaded / total) * 100,
        });
      }
    });
    try {
      const transcripts: Record<string, CaptionWord[]> = {};
      for (let i = 0; i < distinctSources.length; i++) {
        if (signal?.aborted) throw new Error("Cancelled");
        const src = distinctSources[i];
        onProgress?.({
          stage: "transcribing",
          label: distinctSources.length > 1 ? `Transcribing clip ${i + 1} of ${distinctSources.length}…` : "Extracting audio & transcribing offline…",
          percent: null,
        });
        // eslint-disable-next-line no-await-in-loop
        transcripts[src] = await invoke<CaptionWord[]>("generate_caption_words", { inputPath: src, language });
      }
      if (signal?.aborted) throw new Error("Cancelled");
      onTranscriptGenerated?.(language, transcripts);
      captionTrack = {
        language,
        transcripts,
        settings: existingCaptions?.settings ?? defaultCaptionSettings(),
      };
      const effectiveClips: Clip[] =
        clips && clips.length > 0
          ? clips
          : [
              {
                id: "primary",
                sourcePath: sourceVideoPath,
                start: 0,
                end:
                  options.durationSec && options.durationSec > 0
                    ? options.durationSec
                    : Math.max(
                        1,
                        ...Object.values(transcripts)
                          .flat()
                          .map((w) => w.end)
                      ),
              },
            ];
      lines = buildCaptionLines(effectiveClips, captionTrack).map((l) => ({
        start: l.start,
        end: l.end,
        text: l.words.map((w) => w.text).join(" "),
      }));
    } catch (err) {
      if (signal?.aborted) throw new Error("Cancelled");
      const msg = err instanceof Error ? err.message : String(err);
      if (/cancel/i.test(msg)) {
        // User skipped transcription mid-run without cancelling the whole modal — continue with screenshots.
        console.info("Transcription skipped/cancelled; continuing with visual doc.");
      } else {
        console.warn("Offline transcription failed while building video doc:", err);
      }
    } finally {
      unlistenProgress();
      unlistenModel();
    }
  }

  if (signal?.aborted) throw new Error("Cancelled");

  // Step 2: Resolve chapters (placed timeline chapters -> player .chapters.json -> TextTiling suggestChapters).
  onProgress?.({ stage: "analyzing", label: "Organizing chapters & key takeaways…", percent: null });
  let chapters: VideoDocChapter[] = [...(options.chapters ?? [])];
  if (chapters.length === 0) {
    try {
      const json = await invoke<string | null>("load_video_chapters", { videoPath: sourceVideoPath });
      if (json) {
        const parsed = JSON.parse(json) as { time: number; label: string }[];
        chapters = parsed.filter((c) => Number.isFinite(c.time)).map((c) => ({ time: c.time, label: c.label }));
      }
    } catch {
      /* ignore */
    }
  }
  const effectiveDuration =
    options.durationSec && options.durationSec > 0
      ? options.durationSec
      : lines.length > 0
        ? lines[lines.length - 1].end
        : 0;
  if (chapters.length === 0 && captionTrack && effectiveDuration > 0) {
    const effectiveClips: Clip[] =
      clips && clips.length > 0 ? clips : [{ id: "primary", sourcePath: sourceVideoPath, start: 0, end: effectiveDuration }];
    const suggested = suggestChapters(effectiveClips, captionTrack, effectiveDuration);
    if (suggested.length > 0) chapters = suggested;
  }

  // Step 3: Create doc shell so we have a docId to save chapter screenshots into.
  const title = (options.title?.trim() || humanizeVideoTitle(options.fileName)).slice(0, 140);
  const id = crypto.randomUUID();
  await invoke("create_doc", { id, title, bytes: Array.from(Y.encodeStateAsUpdate(new Y.Doc())) });

  try {
    // Step 4: Capture keyframe screenshots for chapters (or evenly spaced moments for silent videos).
    const screenshots: VideoDocScreenshot[] = [];
    if (captureScreenshots && effectiveDuration > 0) {
      const moments = pickScreenshotMoments(chapters, effectiveDuration, maxScreenshots);
      for (let i = 0; i < moments.length; i++) {
        const m = moments[i];
        onProgress?.({
          stage: "screenshots",
          label: `Capturing video screenshots (${i + 1}/${moments.length})…`,
          percent: Math.round(((i + 1) / moments.length) * 100),
        });
        try {
          const { sourcePath, sourceTime } = sourceMomentForOutputTime(clips, sourceVideoPath, m.time);
          // eslint-disable-next-line no-await-in-loop
          const pngPath = await invoke<string>("extract_frame_still", { sourcePath, time: sourceTime });
          // eslint-disable-next-line no-await-in-loop
          const buffer = await invoke<ArrayBuffer>("read_file_bytes", { path: pngPath });
          // eslint-disable-next-line no-await-in-loop
          const savedPath = await invoke<string>("save_doc_image", {
            id,
            assetId: crypto.randomUUID(),
            extension: "png",
            bytes: Array.from(new Uint8Array(buffer)),
          });
          screenshots.push({
            chapterIndex: m.chapterIndex,
            time: m.time,
            src: convertFileSrc(savedPath),
            alt: `${m.label} (${formatChapterTimestamp(m.time)})`,
          });
        } catch (err) {
          console.warn(`Skipping screenshot at ${m.time}s:`, err);
        }
      }
    }

    // Step 4b: Load Study Mode notes (from options or `.notes.json`) & persist any captured slide frames into the doc.
    const studyNotes: StudyNote[] =
      options.studyNotes && options.studyNotes.length > 0
        ? options.studyNotes
        : (await loadStudyNotes(sourceVideoPath)).notes;
    const studyNoteSnapshotUrls = new Map<string, string>();
    for (const note of studyNotes) {
      if (!note.snapshotDataUrl) continue;
      const commaIdx = note.snapshotDataUrl.indexOf(",");
      if (commaIdx < 0) continue;
      try {
        const b64 = note.snapshotDataUrl.slice(commaIdx + 1);
        const binary = atob(b64);
        const bytes = new Array<number>(binary.length);
        for (let k = 0; k < binary.length; k++) bytes[k] = binary.charCodeAt(k);
        // eslint-disable-next-line no-await-in-loop
        const savedPath = await invoke<string>("save_doc_image", {
          id,
          assetId: crypto.randomUUID(),
          extension: "jpg",
          bytes,
        });
        studyNoteSnapshotUrls.set(note.id, convertFileSrc(savedPath));
      } catch (err) {
        console.warn(`Skipping study note snapshot for ${note.id}:`, err);
      }
    }

    // Step 5: Assemble Markdown -> HTML -> ProseMirror -> Yjs & link doc to video.
    onProgress?.({ stage: "saving", label: "Formatting Briefcast Doc…", percent: 100 });
    const generated = buildVideoDocMarkdown({
      ...options,
      title,
      durationSec: effectiveDuration,
      chapters,
      lines,
      screenshots,
      studyNotes,
      studyNoteSnapshotUrls,
      createdAt: options.createdAt ?? new Date(),
    });
    const html = markdownToHtml(generated.markdown);
    const dom = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const schema = getSchema(getDocContentExtensions());
    const node = ProseMirrorDOMParser.fromSchema(schema).parse(dom.body);
    const ydoc = prosemirrorToYDoc(node, "default");
    await invoke("save_doc", { id, bytes: Array.from(Y.encodeStateAsUpdate(ydoc)), title: generated.title });
    await invoke("link_doc_to_file", { id, filePath: sourceVideoPath });
    return {
      id,
      title: generated.title,
      wordCount: generated.stats.wordCount,
      chapterCount: generated.stats.chapterCount,
      screenshotCount: screenshots.length,
    };
  } catch (err) {
    try {
      await invoke("delete_doc", { id });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}
