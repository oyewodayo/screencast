// utils/transcriptEdit.ts
//
// Edit by transcript: the timeline's speech as a list of words, where deleting words cuts them out
// of the video. Built on the same word-timed transcripts the Captions tool generates
// (CaptionTrack.transcripts, one per SOURCE file, in that file's own seconds), so nothing here
// re-transcribes - and because a cut is just a change to the clips, the words (and captions)
// still left on the timeline re-derive themselves from the new clips automatically.
//
// Pure functions only - the panel (TranscriptEditorPanel) owns selection and UI, the store applies
// the resulting cuts as one undoable step (useVideoEditStore's cutClipRanges).
import { CaptionTrack, Clip } from "./videoEditTypes";
import { clipOutputDuration, sourceToOutputOffset } from "./clipTiming";

export interface TranscriptToken {
  // Stable for as long as the clip and word exist - selection is kept by key across re-renders.
  key: string;
  clipId: string;
  clipIndex: number;
  sourcePath: string;
  // Index into CaptionTrack.transcripts[sourcePath].
  wordIndex: number;
  text: string;
  sourceStart: number;
  sourceEnd: number;
  outputStart: number;
  outputEnd: number;
  // Silence before this word since the previous word in the same clip (source seconds; 0 for a
  // clip's first word). Word gaps at first; withDetectedPauses replaces them with the real
  // silences measured in the audio, since speech recognition stretches words across pauses.
  pauseBefore: number;
  // The silent stretch itself (source seconds) when it was measured - what shortening cuts into.
  pauseRange?: { start: number; end: number };
  isFiller: boolean;
  // The same word said twice in a row ("the the") - this is the first of the pair, the one to drop.
  isRepeat: boolean;
}

// Hesitation sounds, matched on the whole word with punctuation stripped. Deliberately narrow:
// "like" or "so" are filler only sometimes, and removing a real word is worse than keeping a filler.
const FILLER_WORDS = new Set(["um", "umm", "uh", "uhh", "uhm", "erm", "er", "ah", "ahh", "eh", "hmm", "hm", "mm", "mhm", "mmm"]);

export const normalizeWord = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

export const isFillerWord = (text: string): boolean => FILLER_WORDS.has(normalizeWord(text));

// Two identical words within this gap count as a stutter/repeat rather than deliberate emphasis.
const REPEAT_MAX_GAP_SEC = 0.6;

// Every transcript word that's still on the timeline, in playback order. A word belongs to the clip
// its START falls inside, so a word straddling a cut is never shown twice or lost - and a recording's
// last word, which speech recognition often times as running past the end of the file, still shows.
export function buildTranscriptTokens(clips: Clip[], track: CaptionTrack | null): TranscriptToken[] {
  if (!track) return [];
  const tokens: TranscriptToken[] = [];
  let offset = 0;
  clips.forEach((clip, clipIndex) => {
    const words = track.transcripts[clip.sourcePath] ?? [];
    let previous: TranscriptToken | null = null;
    words.forEach((word, wordIndex) => {
      if (word.start < clip.start || word.start >= clip.end) return;
      const sourceStart = Math.max(clip.start, word.start);
      const sourceEnd = Math.min(clip.end, word.end);
      const token: TranscriptToken = {
        key: `${clip.id}:${wordIndex}`,
        clipId: clip.id,
        clipIndex,
        sourcePath: clip.sourcePath,
        wordIndex,
        text: word.text.trim(),
        sourceStart,
        sourceEnd,
        outputStart: offset + sourceToOutputOffset(clip, sourceStart),
        outputEnd: offset + sourceToOutputOffset(clip, sourceEnd),
        pauseBefore: previous ? Math.max(0, sourceStart - previous.sourceEnd) : 0,
        isFiller: isFillerWord(word.text),
        isRepeat: false,
      };
      if (
        previous &&
        normalizeWord(previous.text) !== "" &&
        normalizeWord(previous.text) === normalizeWord(token.text) &&
        token.pauseBefore <= REPEAT_MAX_GAP_SEC
      ) {
        previous.isRepeat = true;
      }
      if (token.text !== "") tokens.push(token);
      previous = token;
    });
    offset += clipOutputDuration(clip);
  });
  return tokens;
}

export interface ClipCut {
  clipId: string;
  start: number; // source seconds
  end: number;
}

// How far before a word a cut starts, so its first sound isn't clipped off (word timings from
// speech recognition land a little late more often than early).
const CUT_LEAD_SEC = 0.04;
// How much of a trailing silence to keep after the last word before a cut, when the cut runs to a
// clip's end.
const CUT_TAIL_SEC = 0.12;
// A cut that gets this close to a clip's own start or end just runs to it - otherwise deleting a
// clip's first or last words leaves a sliver of silence behind as a clip of its own.
const SNAP_TO_EDGE_SEC = 0.5;

// The source ranges that remove `selected` tokens. Consecutive selected words become one cut,
// which also takes the pause after them, up to just before the next kept word - so the remaining
// speech joins naturally ("we [um, so] went" -> "we went"), the way an editor would cut by hand.
export function cutsForTokens(tokens: TranscriptToken[], selectedKeys: Set<string>, clips: Clip[]): ClipCut[] {
  const clipById = new Map(clips.map((c) => [c.id, c]));
  const cuts: ClipCut[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!selectedKeys.has(tokens[i].key)) {
      i++;
      continue;
    }
    // A run of selected words, within one clip.
    let j = i;
    while (j + 1 < tokens.length && selectedKeys.has(tokens[j + 1].key) && tokens[j + 1].clipId === tokens[i].clipId) j++;
    const first = tokens[i];
    const last = tokens[j];
    const clip = clipById.get(first.clipId);
    if (clip) {
      const prev = i > 0 && tokens[i - 1].clipId === first.clipId ? tokens[i - 1] : null;
      const next = j + 1 < tokens.length && tokens[j + 1].clipId === first.clipId ? tokens[j + 1] : null;
      let start = Math.max(prev ? prev.sourceEnd : clip.start, first.sourceStart - CUT_LEAD_SEC);
      let end = next ? Math.max(start, next.sourceStart - CUT_LEAD_SEC) : Math.min(clip.end, last.sourceEnd + CUT_TAIL_SEC);
      if (!prev && start - clip.start < SNAP_TO_EDGE_SEC) start = clip.start;
      if (!next && clip.end - end < SNAP_TO_EDGE_SEC) end = clip.end;
      if (end > start) cuts.push({ clipId: clip.id, start, end });
    }
    i = j + 1;
  }
  return cuts;
}

// Replaces word-gap pauses with the silences actually measured in the audio (detect_silence, per
// source file): a silence counts as the pause before the first word that starts after its
// midpoint - so each silence belongs to exactly one word, never two. Speech recognition tends to
// stretch a word over the pause after it, so word gaps alone badly undercount pauses - a 2.5s
// silence can show as a 0.2s gap.
export function withDetectedPauses(tokens: TranscriptToken[], silences: Record<string, { start: number; end: number }[]>): TranscriptToken[] {
  return tokens.map((token, i) => {
    const prev = i > 0 ? tokens[i - 1] : null;
    const ranges = silences[token.sourcePath];
    if (!prev || prev.clipId !== token.clipId || !ranges) return token;
    let best: { start: number; end: number } | null = null;
    for (const r of ranges) {
      const mid = (r.start + r.end) / 2;
      if (mid < prev.sourceStart || mid >= token.sourceStart) continue;
      // Never past this word's own start: with voice detection on, word STARTS are reliable even
      // where ends aren't, so this keeps a measured "silence" that's really quiet speech from
      // eating into the next word.
      const start = Math.max(r.start, prev.sourceStart);
      const end = Math.min(r.end, token.sourceStart);
      if (end > start && (!best || end - start > best.end - best.start)) best = { start, end };
    }
    if (!best || best.end - best.start <= token.pauseBefore) return token;
    return { ...token, pauseBefore: best.end - best.start, pauseRange: best };
  });
}

// Every pause before a word longer than `minPause`, shortened to `keep` seconds (half kept at each
// side) - "tighten the pacing" in one click. Uses the measured silence when there is one, else
// the gap between the two words' timings.
export function cutsForLongPauses(tokens: TranscriptToken[], minPause: number, keep: number): ClipCut[] {
  const cuts: ClipCut[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    const token = tokens[i];
    if (prev.clipId !== token.clipId || token.pauseBefore <= minPause) continue;
    const range = token.pauseRange ?? { start: prev.sourceEnd, end: token.sourceStart };
    const start = range.start + keep / 2;
    const end = range.end - keep / 2;
    if (end > start) cuts.push({ clipId: token.clipId, start, end });
  }
  return cuts;
}

// The tokens a one-click cleanup would remove.
export const fillerKeys = (tokens: TranscriptToken[]): Set<string> => new Set(tokens.filter((t) => t.isFiller).map((t) => t.key));
export const repeatKeys = (tokens: TranscriptToken[]): Set<string> => new Set(tokens.filter((t) => t.isRepeat).map((t) => t.key));

// Total output seconds a set of cuts removes, for "removes 12.4s" labels.
export function cutsDuration(cuts: ClipCut[], clips: Clip[]): number {
  const clipById = new Map(clips.map((c) => [c.id, c]));
  return cuts.reduce((sum, c) => {
    const clip = clipById.get(c.clipId);
    return sum + (clip ? sourceToOutputOffset(clip, c.end) - sourceToOutputOffset(clip, c.start) : c.end - c.start);
  }, 0);
}
