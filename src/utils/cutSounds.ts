// utils/cutSounds.ts
//
// Sound on every cut: a whoosh, a swoosh, a camera flash... wherever the video switches picture -
// set once for the whole video, not placed piece by piece. Each cut's sound belongs to the cut
// (the clip on its right, as its transition does), so it moves with it through every reorder,
// trim, delete and insert - nothing to line up again. With a transition, the sound matches it
// (autoCutSound: a push whooshes, a flash fires a camera flash, a glitch glitches) unless one is
// picked for that cut; plain cuts get one too unless that's switched off. The video's intro and
// outro get theirs the same way.
//
// cutSoundCues is the one place their timing is worked out - each sound starts `lead` seconds
// ahead of its moment so its peak (a whoosh's middle, a flash's pop) lands on it: the cut itself,
// or the middle of the transition over it. The preview plays the cues (CutSoundPlayer) and the
// export mixes them as ordinary audio (cutSoundOverlays), so both hear the same thing.
import { BUILTIN_SFX_TRACKS, TRANSITION_SOUNDS } from "./builtinSfx";
import { clipOutputDuration } from "./clipTiming";
import { edgeTransitionWindows, type Clip, type EdgeTransitions, type TransitionType } from "./videoEditTypes";

// The video's setting (VideoEditState.cutSounds). Undefined = off.
export interface CutSounds {
  on: boolean;
  // Cuts with no transition get a sound too.
  plainCuts: boolean;
  // 0..1, all cut sounds together - their own mixer channel, under the music's.
  volume: number;
  // Their mixer strip's mute.
  muted?: boolean;
}
export const DEFAULT_CUT_SOUNDS: CutSounds = { on: true, plainCuts: true, volume: 0.8 };

// The mixer channel and the label every cut sound shares.
export const CUT_SOUNDS_CHANNEL = "cutsounds";
export const CUT_SOUNDS_LABEL = "Cut sounds";

// The sounds a cut can have, and how long before its moment each starts (its peak lands on it).
export const CUT_SOUND_CHOICES: { id: string; label: string; lead: number }[] = [
  ...TRANSITION_SOUNDS.filter((s) => s.lead < 1.5),
  { id: "builtin:swipe", label: "Swipe", lead: 0.08 },
  { id: "builtin:pop", label: "Pop", lead: 0 },
  { id: "builtin:click", label: "Click", lead: 0 },
  { id: "builtin:flash", label: "Camera flash", lead: 1.0 },
  { id: "builtin:film-advance", label: "Film advance", lead: 0 },
];
const choiceOf = (id: string) => CUT_SOUND_CHOICES.find((c) => c.id === id);
export const cutSoundLabel = (id: string): string => choiceOf(id)?.label ?? BUILTIN_SFX_TRACKS.find((t) => t.id === id)?.title ?? "Sound";
const leadOf = (id: string): number => choiceOf(id)?.lead ?? 0;
export const cutSoundSeconds = (id: string): number => BUILTIN_SFX_TRACKS.find((t) => t.id === id)?.duration ?? 1;

// The sound a transition makes - what template editors pair with each move. A plain cut swooshes.
export function autoCutSound(type: TransitionType | null): string {
  switch (type) {
    case null:
      return "builtin:swoosh";
    case "push":
    case "slideleft":
    case "slideright":
    case "whip":
    case "cube":
    case "flip":
    case "spin":
    case "colorsweep":
      return "builtin:whoosh";
    case "wipeleft":
    case "wiperight":
    case "slider":
    case "split":
    case "strips":
    case "slice":
    case "pagecurl":
      return "builtin:swipe";
    case "fadewhite":
      return "builtin:flash";
    case "glitch":
    case "pixelize":
      return "builtin:glitch";
    case "lightleak":
    case "beam":
    case "dissolve":
      return "builtin:sparkle";
    case "blocks":
    case "mosaic":
    case "tiles":
      return "builtin:pop";
    case "fadeblack":
      return "builtin:boom";
    default:
      // fade, zooms, circle/iris/bar opens, clock wipe
      return "builtin:swoosh";
  }
}

// One sound on the output timeline.
export interface CutCue {
  // Stable per cut (the incoming clip's id, or the edge) - so the preview keeps scheduling straight.
  key: string;
  soundId: string;
  // Output seconds the sound starts at (negative: it starts before the video - the head is cut off).
  start: number;
  // The moment it's timed to: the cut, or its transition's middle.
  at: number;
}

// The same clamp the transitions use: at most 90% of the clip they play over.
const transitionSeconds = (clip: Clip): number =>
  clip.transitionIn && clip.transitionIn.duration > 0 ? Math.max(0.05, Math.min(clip.transitionIn.duration, clipOutputDuration(clip) * 0.9)) : 0;

// Every cut's sound, in time order. `clips` are the playback clips (their output lengths are the
// timeline's).
export function cutSoundCues(clips: readonly Clip[], edges: EdgeTransitions | undefined, settings: CutSounds | undefined): CutCue[] {
  if (!settings?.on || clips.length === 0) return [];
  const cues: CutCue[] = [];
  const push = (key: string, soundId: string, at: number) => cues.push({ key, soundId, at, start: at - leadOf(soundId) });
  let total = 0;
  const starts: number[] = [];
  for (const clip of clips) {
    starts.push(total);
    total += clipOutputDuration(clip);
  }
  const windows = edgeTransitionWindows(edges, total);
  const edgeSound = (edge: "intro" | "outro") => {
    const own = edges?.sounds?.[edge];
    return own === null ? null : own ?? (edges?.[edge] ? autoCutSound(edges[edge]!.type) : null);
  };
  const intro = edgeSound("intro");
  if (intro && windows.intro !== null) push("intro", intro, windows.intro / 2);
  for (let i = 1; i < clips.length; i++) {
    const clip = clips[i];
    if (clip.cutSound === null) continue;
    const d = transitionSeconds(clip);
    if (!d && !settings.plainCuts && clip.cutSound === undefined) continue;
    push(clip.id, clip.cutSound ?? autoCutSound(d ? clip.transitionIn!.type : null), starts[i] + d / 2);
  }
  const outro = edgeSound("outro");
  if (outro && windows.outro !== null) push("outro", outro, total - windows.outro / 2);
  return cues.sort((a, b) => a.start - b.start);
}

// What a cue plays: its sound's file from `fileOf` (builtinSfxFile), from where in the file (a cue
// starting before the video is cut at 0), on the output timeline - and never past the video's end.
export interface CutSoundPiece {
  key: string;
  sourcePath: string;
  startTime: number;
  endTime: number;
  trimStart: number;
}
export async function cutSoundPieces(cues: readonly CutCue[], total: number, fileOf: (id: string) => Promise<string>): Promise<CutSoundPiece[]> {
  const out: CutSoundPiece[] = [];
  for (const cue of cues) {
    const startTime = Math.max(0, cue.start);
    const endTime = Math.min(total, cue.start + cutSoundSeconds(cue.soundId));
    if (endTime - startTime < 0.02) continue;
    // eslint-disable-next-line no-await-in-loop
    const sourcePath = await fileOf(cue.soundId).catch(() => null);
    if (sourcePath) out.push({ key: cue.key, sourcePath, startTime, endTime, trimStart: startTime - cue.start });
  }
  return out;
}
