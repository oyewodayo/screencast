// utils/videoChapters.ts
//
// Chapters of an edited video. Each one is anchored to a moment of a SOURCE file (VideoChapter,
// videoEditTypes.ts) - like caption words - so it stays on the same shot as clips are trimmed,
// split and reordered; this maps them onto the output timeline for the timeline markers, the
// export (MP4 chapter atoms + the .chapters.json the player reads) and YouTube's description.
//
// suggestChapters proposes chapters from the transcript with TextTiling (Hearst, 1997): the words
// are cut into blocks, neighbouring stretches of blocks are compared by the vocabulary they share,
// and the deepest dips in that similarity - where the talk moves on to something else - become
// boundaries, nudged onto the longest pause nearby. Each chapter is titled with its most
// distinctive phrase (TF-IDF against the other chapters). All local, nothing leaves the machine.

import type { CaptionTrack, Clip, VideoChapter } from "./videoEditTypes";
import { buildCaptionLines, CaptionLineWord } from "./captions";
import { clipOutputDuration, outputOffsetToSource, sourceToOutputOffset } from "./clipTiming";

export interface OutputChapter {
  id: string;
  time: number; // output seconds
  label: string;
}

// Output seconds where the chapter's source moment plays - the first place it does - or null when
// it's been cut out.
export function chapterOutputTime(clips: Clip[], chapter: Pick<VideoChapter, "sourcePath" | "sourceTime">): number | null {
  let at = 0;
  for (const clip of clips) {
    if (clip.sourcePath === chapter.sourcePath && chapter.sourceTime >= clip.start - 1e-6 && chapter.sourceTime < clip.end) {
      return at + sourceToOutputOffset(clip, Math.max(clip.start, chapter.sourceTime));
    }
    at += clipOutputDuration(clip);
  }
  return null;
}

// A chapter anchored at output time `time` (the clip playing there, at that moment of its source).
export function chapterAtOutputTime(clips: Clip[], time: number, label: string): VideoChapter | null {
  let at = 0;
  for (const clip of clips) {
    const d = clipOutputDuration(clip);
    if (time < at + d || clip === clips[clips.length - 1]) {
      const local = Math.max(0, Math.min(d, time - at));
      return { id: crypto.randomUUID(), sourcePath: clip.sourcePath, sourceTime: outputOffsetToSource(clip, local), label };
    }
    at += d;
  }
  return null;
}

// The chapters that survive the edit, on the output timeline, in order.
export function outputChapters(clips: Clip[], chapters: VideoChapter[]): OutputChapter[] {
  return chapters
    .map((c) => ({ id: c.id, label: c.label.trim(), time: chapterOutputTime(clips, c) }))
    .filter((c): c is OutputChapter => c.time !== null)
    .sort((a, b) => a.time - b.time);
}

// What export embeds: surviving chapters, a second or more apart, the first moved to 0:00.
export function chaptersForExport(clips: Clip[], chapters: VideoChapter[]): { time: number; label: string }[] {
  const out: { time: number; label: string }[] = [];
  for (const c of outputChapters(clips, chapters)) {
    if (out.length && c.time - out[out.length - 1].time < 1) continue;
    out.push({ time: Math.round(c.time * 1000) / 1000, label: c.label || `Chapter ${out.length + 1}` });
  }
  if (out.length) out[0].time = 0;
  return out;
}

export function formatChapterTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

// YouTube turns timestamps in the description into chapters when: the first is 0:00, there are
// at least three, and each lasts at least 10 seconds. Returns the lines to put in the description,
// or why they won't become chapters.
export const YOUTUBE_MIN_CHAPTER_SEC = 10;
export function youtubeChapterLines(chapters: { time: number; label: string }[], durationSec: number): { lines: string[]; problem: string | null } {
  const sorted = [...chapters].sort((a, b) => a.time - b.time);
  const kept: { time: number; label: string }[] = [];
  for (const c of sorted) {
    const prev = kept[kept.length - 1];
    if (prev && c.time - prev.time < YOUTUBE_MIN_CHAPTER_SEC) continue;
    kept.push({ ...c });
  }
  if (kept.length && kept[0].time > 0.5) kept.unshift({ time: 0, label: "Intro" });
  if (kept.length) kept[0].time = 0;
  // The last chapter needs its 10 seconds too.
  while (kept.length > 1 && durationSec - kept[kept.length - 1].time < YOUTUBE_MIN_CHAPTER_SEC) kept.pop();
  const lines = kept.map((c) => `${formatChapterTimestamp(c.time)} ${c.label.replace(/\s+/g, " ").trim() || "Chapter"}`);
  if (kept.length === 0) return { lines, problem: null };
  if (kept.length < 3) return { lines, problem: "YouTube needs at least 3 chapters, each 10 seconds or longer" };
  return { lines, problem: null };
}

// ---- Suggestions from the transcript ---------------------------------------------------------

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are aren't as at be because been before being below between both but by can can't " +
    "cannot could couldn't did didn't do does doesn't doing don't down during each few for from further get got gonna had hadn't has hasn't have " +
    "haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its " +
    "itself just know kind let let's like lot me more most mustn't my myself no nor not now of off oh ok okay on once one only or other ought our " +
    "ours ourselves out over own really right same say says see so some something such than that that's the their theirs them themselves then there " +
    "there's these they they'd they'll they're they've thing things think this those through to too um uh under until up us very want was wasn't way " +
    "we we'd we'll we're we've well were weren't what what's when when's where where's which while who who's whom why why's will with won't would " +
    "wouldn't yeah yes you you'd you'll you're you've your yours yourself yourselves going go look looking actually basically just thing stuff mean"
  ).split(" ")
);

const tokenize = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}' -]/gu, "").replace(/^'+|'+$/g, "");

// A light stem, so "model", "models" and "modeling" count as one word.
function stem(word: string): string {
  if (word.length <= 4) return word;
  for (const suffix of ["ations", "ation", "ings", "ing", "edly", "ed", "ies", "es", "ly", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return suffix === "ies" ? word.slice(0, -3) + "y" : word.slice(0, -suffix.length);
  }
  return word;
}

interface TimedToken {
  start: number;
  end: number;
  raw: string;
  stem: string | null; // null for a stopword
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

export interface ChapterSuggestion {
  time: number; // output seconds
  label: string;
}

// Chapters for the edited timeline from its captions' words. Empty when there's too little speech.
export function suggestChapters(clips: Clip[], captions: CaptionTrack | null, durationSec: number): ChapterSuggestion[] {
  if (!captions) return [];
  const words: CaptionLineWord[] = buildCaptionLines(clips, { ...captions, settings: { ...captions.settings, enabled: true } }).flatMap((l) => l.words);
  const tokens: TimedToken[] = words
    .map((w) => {
      const raw = tokenize(w.text);
      return { start: w.start, end: w.end, raw, stem: raw && !STOPWORDS.has(raw) && !/^\d+$/.test(raw) ? stem(raw) : null };
    })
    .filter((t) => t.raw.length > 0);
  const content = tokens.filter((t) => t.stem);
  if (content.length < 60 || durationSec < 60) return [];

  // Blocks of BLOCK content words; similarity across each gap between blocks, WINDOW blocks a side.
  const BLOCK = 20;
  const WINDOW = 5;
  const blocks: { start: number; terms: Map<string, number> }[] = [];
  for (let i = 0; i < content.length; i += BLOCK) {
    const terms = new Map<string, number>();
    for (const t of content.slice(i, i + BLOCK)) terms.set(t.stem!, (terms.get(t.stem!) ?? 0) + 1);
    blocks.push({ start: content[i].start, terms });
  }
  if (blocks.length < 4) return [];
  const sum = (from: number, to: number) => {
    const m = new Map<string, number>();
    for (let i = Math.max(0, from); i < Math.min(blocks.length, to); i++) for (const [k, v] of blocks[i].terms) m.set(k, (m.get(k) ?? 0) + v);
    return m;
  };
  // gap g sits between block g-1 and block g.
  const sims: number[] = [];
  for (let g = 1; g < blocks.length; g++) sims.push(cosine(sum(g - WINDOW, g), sum(g, g + WINDOW)));
  // Light smoothing, then depth: how far the similarity climbs back up on each side.
  const smooth = sims.map((_, i) => (sims[Math.max(0, i - 1)] + 2 * sims[i] + sims[Math.min(sims.length - 1, i + 1)]) / 4);
  const depth = smooth.map((s, i) => {
    let l = s;
    for (let j = i - 1; j >= 0 && smooth[j] >= l; j--) l = smooth[j];
    let r = s;
    for (let j = i + 1; j < smooth.length && smooth[j] >= r; j++) r = smooth[j];
    return l - s + (r - s);
  });

  // Pauses: the silence before each word, to land boundaries on the longest one nearby.
  const pauseBefore = tokens.map((t, i) => (i === 0 ? 0 : t.start - tokens[i - 1].end));
  const target = Math.max(2, Math.min(11, Math.round(durationSec / 150)));
  const minSpacing = Math.max(30, durationSec / (target * 2.2));
  const mean = depth.reduce((a, b) => a + b, 0) / depth.length;
  const sd = Math.sqrt(depth.reduce((a, b) => a + (b - mean) ** 2, 0) / depth.length);
  const candidates = depth
    .map((d, i) => ({ d, time: blocks[i + 1].start }))
    .filter((c) => c.d > mean - sd / 2)
    .sort((a, b) => b.d - a.d);
  const cuts: number[] = [];
  for (const c of candidates) {
    if (cuts.length >= target) break;
    // Snap to the start of the word after the longest pause within 8 s.
    let best = c.time;
    let bestPause = -1;
    tokens.forEach((t, i) => {
      if (Math.abs(t.start - c.time) <= 8 && pauseBefore[i] > bestPause) {
        bestPause = pauseBefore[i];
        best = t.start;
      }
    });
    const time = Math.max(0, best - Math.min(0.3, bestPause / 2));
    if (time < minSpacing * 0.6 || durationSec - time < minSpacing * 0.6) continue;
    if (cuts.some((x) => Math.abs(x - time) < minSpacing)) continue;
    cuts.push(time);
  }
  const starts = [0, ...cuts.sort((a, b) => a - b)];

  // Titles: each chapter's most distinctive phrase (bigrams preferred), never repeated.
  const segments = starts.map((s, i) => tokens.filter((t) => t.start >= s && t.start < (starts[i + 1] ?? Infinity)));
  const phrases = (seg: TimedToken[]) => {
    const m = new Map<string, { n: number; text: string }>();
    const add = (key: string, text: string, w: number) => {
      const e = m.get(key);
      if (e) e.n += w;
      else m.set(key, { n: w, text });
    };
    for (let i = 0; i < seg.length; i++) {
      if (seg[i].stem && seg[i].raw.length > 3) add(seg[i].stem!, seg[i].raw, 1);
      if (i + 1 < seg.length && seg[i].stem && seg[i + 1].stem) add(`${seg[i].stem} ${seg[i + 1].stem}`, `${seg[i].raw} ${seg[i + 1].raw}`, 1.6);
    }
    return m;
  };
  const perSegment = segments.map(phrases);
  const docFreq = new Map<string, number>();
  for (const m of perSegment) for (const k of m.keys()) docFreq.set(k, (docFreq.get(k) ?? 0) + 1);
  const used = new Set<string>();
  return starts.map((time, i) => {
    const scored = [...perSegment[i].entries()]
      .filter(([, v]) => v.n >= 2)
      .map(([k, v]) => ({ k, text: v.text, score: v.n * Math.log(1 + segments.length / (docFreq.get(k) ?? 1)) }))
      .sort((a, b) => b.score - a.score);
    const pick = scored.find((p) => !used.has(p.k) && ![...used].some((u) => u.includes(p.k) || p.k.includes(u)));
    let label = pick ? titleCase(pick.text) : `Part ${i + 1}`;
    if (pick) used.add(pick.k);
    if (i === 0 && (starts[1] ?? durationSec) < 40) label = "Intro";
    return { time, label };
  });
}
