// utils/shortsBuild.ts
//
// Turns a found moment (shortsFinder.ts) into the timeline of a finished short - an ordinary
// VideoEditState, so it exports through exactly the same path as any edit (prepareExport) and
// previews from the same numbers:
//   - the moment's stretch of the CURRENT timeline (clips sliced, each keeping its look);
//   - optionally a teaser line first (a cold open), flashing into the start;
//   - fillers removed and pauses over 0.5 s shortened to 0.25 s (transcriptEdit's own cuts);
//   - captions in a short-form style, a hook title across the top, music that was playing under
//     it carried along.
// Overlays laid out for the wide frame (text, pictures, blur regions, layers) are not carried -
// they'd land in the wrong place in a vertical frame; momentHasHiddenAreas warns when that drops
// a blur or cover.
import type { AudioOverlay, CaptionSettings, CaptionStylePreset, CaptionTrack, Clip, TextOverlay, VideoEditState } from "./videoEditTypes";
import { clipOutputDuration, outputOffsetToSource, sourceToOutputOffset } from "./clipTiming";
import { buildTranscriptTokens, cutsForLongPauses, cutsForTokens, fillerKeys, withDetectedPauses, type ClipCut } from "./transcriptEdit";
import { clipPiece, cutClipRanges, isDetachedAudioOverlay } from "../handlers/videoEditHandlers";
import { defaultCaptionSettings } from "./captions";
import type { ReframeKnot } from "./reframeTrack";
import { TIGHT_KEEP_SEC, TIGHT_MIN_PAUSE_SEC, type ShortMoment } from "./shortsFinder";

export const SHORT_SIZE = { width: 1080, height: 1920 };

export type ShortLayout = "follow" | "whole";

export interface ShortStyle {
  captions: CaptionStylePreset | null; // null = no captions
  title: boolean;
  tighten: boolean;
  teaser: boolean;
  layout: ShortLayout;
}

export const DEFAULT_SHORT_STYLE: ShortStyle = { captions: "outline", title: true, tighten: true, teaser: false, layout: "follow" };

// The caption styles offered for shorts - the bold, word-by-word looks short-form video uses.
export const SHORT_CAPTION_STYLES: CaptionStylePreset[] = ["outline", "pop", "button", "highlight", "headline"];

// Captions for a vertical frame: three words at a time, big, sitting a third of the way up - clear
// of the platform's own buttons and description at the bottom.
export function shortCaptionSettings(preset: CaptionStylePreset): CaptionSettings {
  return { ...defaultCaptionSettings(preset), enabled: true, position: "bottom", offset: 0.27, size: 1.1, maxWordsPerLine: 3 };
}

const totalDuration = (clips: Clip[]) => clips.reduce((sum, c) => sum + clipOutputDuration(c), 0);

// The part of the timeline between two output times, as clips of their own (each keeps its look;
// the first loses any transition in, since nothing comes before it).
export function sliceTimeline(clips: Clip[], start: number, end: number): Clip[] {
  const out: Clip[] = [];
  let at = 0;
  for (const clip of clips) {
    const d = clipOutputDuration(clip);
    const a = Math.max(start, at);
    const b = Math.min(end, at + d);
    if (b - a > 0.05) {
      const s0 = outputOffsetToSource(clip, a - at);
      const s1 = outputOffsetToSource(clip, b - at);
      out.push(clipPiece(clip, s0, s1, { first: a <= at + 1e-6 && out.length > 0 }));
    }
    at += d;
    if (at >= end) break;
  }
  return out;
}

export interface BuiltShort {
  state: VideoEditState;
  // The short before tightening, and the cuts that tightened it - what the reframe analysis runs
  // on (one shot per original clip, not one per removed pause) and remapKnots maps through.
  untightened: Clip[];
  cuts: ClipCut[];
  durationSec: number;
}

export function buildShort(
  base: VideoEditState,
  moment: ShortMoment,
  title: string,
  style: ShortStyle,
  silences: Record<string, { start: number; end: number }[]>
): BuiltShort {
  const main = sliceTimeline(base.clips, moment.start, moment.end);
  let untightened = main;
  if (style.teaser && moment.teaser) {
    const teaser = sliceTimeline(base.clips, moment.teaser.start, moment.teaser.end);
    if (teaser.length > 0 && main.length > 0) {
      // A white flash from the teaser into the start - the cold open's "and here's how we got here".
      untightened = [...teaser, { ...main[0], transitionIn: { type: "fadewhite", duration: 0.2, look: { intensity: 0.85 } } }, ...main.slice(1)];
    }
  }

  let cuts: ClipCut[] = [];
  let clips = untightened;
  if (style.tighten && base.captions) {
    const tokens = withDetectedPauses(buildTranscriptTokens(untightened, base.captions), silences);
    cuts = [...cutsForTokens(tokens, fillerKeys(tokens), untightened), ...cutsForLongPauses(tokens, TIGHT_MIN_PAUSE_SEC, TIGHT_KEEP_SEC)];
    clips = cutClipRanges(untightened, cuts);
  }
  const durationSec = totalDuration(clips);

  const captions: CaptionTrack | null = base.captions && style.captions ? { ...ownWords(base.captions, untightened), settings: shortCaptionSettings(style.captions) } : null;
  const textOverlays: TextOverlay[] = style.title && title.trim() ? [makeTitleOverlay(title.trim(), durationSec)] : [];

  return {
    state: {
      ...base,
      clips,
      textOverlays,
      imageOverlays: [],
      blurOverlays: [],
      pipOverlays: [],
      adjustmentLayers: [],
      chapters: [],
      hiddenVideoTracks: [],
      audioOverlays: carryMusic(base.audioOverlays, moment, totalDuration(untightened) - totalDuration(main), durationSec),
      captions,
      // A wallpaper frame would only shrink a vertical short; the drawn pointer (pointerStyle) and
      // shortcut chips carry over.
      screenStyle: null,
    },
    untightened,
    cuts,
    durationSec,
  };
}

// Only the words that START inside the short's clips (the transcript editor's rule) - recognition
// stretches a word over the pause after it, so the last word before the moment would otherwise
// overlap its start and show in the first caption without being heard.
function ownWords(track: CaptionTrack, clips: Clip[]): CaptionTrack {
  const transcripts: CaptionTrack["transcripts"] = {};
  for (const [path, words] of Object.entries(track.transcripts)) {
    const own = clips.filter((c) => c.sourcePath === path);
    if (own.length) transcripts[path] = words.filter((w) => own.some((c) => w.start >= c.start && w.start < c.end));
  }
  return { ...track, transcripts };
}

// The hook title: white bold text on a dark rounded card across the top of the frame.
export function makeTitleOverlay(text: string, durationSec: number): TextOverlay {
  const now = Date.now();
  const fontSize = 0.034;
  return {
    id: crypto.randomUUID(),
    text,
    color: "#ffffff",
    backgroundColor: "rgba(0,0,0,0.72)",
    boldRuns: [{ start: 0, end: text.length }],
    textAlign: "center",
    cornerStyle: "rounded",
    padding: 0.014,
    x: 0.06,
    y: 0.075,
    width: 0.88,
    height: fontSize * 1.3 * 2,
    fontSize,
    startTime: 0,
    endTime: durationSec,
    createdAt: now,
    updatedAt: now,
  };
}

// Music under the moment comes along, at the same point in the song. It isn't cut with the pauses
// (music plays on), so it just runs to the short's end, fading out.
function carryMusic(overlays: AudioOverlay[], moment: ShortMoment, teaserSec: number, durationSec: number): AudioOverlay[] {
  return overlays
    .filter((o) => !o.muted && !isDetachedAudioOverlay(o) && o.startTime < moment.end && o.endTime > moment.start)
    .map((o) => {
      const skip = Math.max(0, moment.start - o.startTime);
      const startTime = Math.max(0, o.startTime - moment.start) + teaserSec;
      const endTime = Math.min(durationSec, startTime + (o.endTime - o.startTime - skip));
      return { ...o, id: crypto.randomUUID(), startTime, endTime, trimStart: o.trimStart + skip, fadeOutSec: Math.min(1.5, (endTime - startTime) / 4) };
    })
    .filter((o) => o.endTime - o.startTime > 0.5);
}

// Whether a blur region, cover picture or adjustment layer touches the moment - those hide things
// the short won't (it doesn't carry wide-frame overlays).
export function momentHasHiddenAreas(base: VideoEditState, moment: Pick<ShortMoment, "start" | "end">): boolean {
  const touches = (o: { startTime: number; endTime: number }) => o.startTime < moment.end && o.endTime > moment.start;
  return base.blurOverlays.some(touches) || base.imageOverlays.some(touches) || (base.adjustmentLayers ?? []).some(touches);
}

// An output time of the untightened short -> the same moment in the tightened one. A time inside a
// removed stretch lands where that stretch was cut out.
export function tightenedTime(untightened: Clip[], cuts: ClipCut[], t: number): number {
  let u = 0; // untightened clip start
  let out = 0; // tightened clip start
  for (let i = 0; i < untightened.length; i++) {
    const clip = untightened[i];
    const d = clipOutputDuration(clip);
    // This clip's removed ranges, merged, as output offsets within the clip.
    const ranges = cuts
      .filter((c) => c.clipId === clip.id)
      .map((c) => [sourceToOutputOffset(clip, Math.max(clip.start, c.start)), sourceToOutputOffset(clip, Math.min(clip.end, c.end))] as [number, number])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([...r]);
    }
    const removedBefore = (x: number) => merged.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, x) - a), 0);
    if (t < u + d || i === untightened.length - 1) {
      const local = Math.max(0, Math.min(d, t - u));
      return out + local - removedBefore(local);
    }
    out += d - removedBefore(d);
    u += d;
  }
  return Math.max(0, t);
}

// The camera path solved on the untightened short, moved onto the tightened one.
export function remapKnots(knots: ReframeKnot[], untightened: Clip[], cuts: ClipCut[]): ReframeKnot[] {
  if (cuts.length === 0) return knots;
  const out: ReframeKnot[] = [];
  for (const k of knots) {
    const t = tightenedTime(untightened, cuts, k.t);
    const last = out[out.length - 1];
    // Knots that collapse onto one time (their stretch was cut out): the later one wins.
    if (last && t - last.t < 1e-3) out[out.length - 1] = { t: last.t, x: k.x, y: k.y };
    else out.push({ t, x: k.x, y: k.y });
  }
  return out;
}
