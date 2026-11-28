// utils/stage/stageSounds.ts
//
// Beat sound design for Stage scenes: maps each scene/beat's sound choice onto the shared built-in
// SFX library (builtinSfx.ts) and produces standard CutCue[] cues so live preview (CutSoundPlayer)
// and FFmpeg export (cutSoundPieces) play the exact same sounds at the exact same milliseconds.
import { CUT_SOUND_CHOICES, type CutCue } from "../cutSounds";
import { beatStarts } from "./stageEditing";
import type { StageBeatSound, StageScene } from "./stageTypes";

export interface StageBeatSoundOption {
  value: StageBeatSound;
  label: string;
  soundId: string | null;
}

export const STAGE_BEAT_SOUNDS: StageBeatSoundOption[] = [
  { value: "none", label: "None", soundId: null },
  { value: "whoosh", label: "Whoosh", soundId: "builtin:whoosh" },
  { value: "swoosh", label: "Swoosh", soundId: "builtin:swoosh" },
  { value: "swipe", label: "Swipe", soundId: "builtin:swipe" },
  { value: "pop", label: "Pop", soundId: "builtin:pop" },
  { value: "click", label: "Click", soundId: "builtin:click" },
  { value: "sparkle", label: "Sparkle", soundId: "builtin:sparkle" },
  { value: "boom", label: "Boom", soundId: "builtin:boom" },
];

const SOUND_ID_BY_KEY = new Map<StageBeatSound, string | null>(STAGE_BEAT_SOUNDS.map((o) => [o.value, o.soundId]));
const LEAD_BY_ID = new Map<string, number>(CUT_SOUND_CHOICES.map((c) => [c.id, c.lead]));

export function stageSoundId(sound: StageBeatSound | undefined): string | null {
  if (!sound || sound === "none") return null;
  return SOUND_ID_BY_KEY.get(sound) ?? null;
}

// Every beat's sound across all Stage scenes, in output-timeline time order.
// Beat 0 triggers on scene entrance; beats 1+ trigger as each beat starts.
export function stageSoundCues(scenes: readonly StageScene[] | undefined): CutCue[] {
  if (!scenes || scenes.length === 0) return [];
  const cues: CutCue[] = [];
  for (const scene of scenes) {
    const starts = beatStarts(scene);
    for (let i = 0; i < scene.beats.length; i++) {
      const beat = scene.beats[i];
      const chosen = beat.sound ?? scene.beatSound;
      const soundId = stageSoundId(chosen);
      if (!soundId) continue;
      const at = scene.startTime + (starts[i] ?? 0);
      const lead = LEAD_BY_ID.get(soundId) ?? 0;
      cues.push({
        key: `stage:${scene.id}:${beat.id}`,
        soundId,
        at,
        start: at - lead,
      });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
}
