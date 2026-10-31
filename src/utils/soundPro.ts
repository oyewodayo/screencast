// utils/soundPro.ts
//
// "Make it sound pro" - one click that does what a sound engineer does first to a voice-and-music
// edit, with the tools already in the editor, set to be heard:
//
// - Every sound gets a role - voice, music, or leave alone - guessed (a library song, a detached
//   Music track or anything with a tempo is music; a detached Voice, a recorded take, the video's own
//   sound and any other track of your own are voice) and shown, so a wrong guess is one tap to fix.
// - The voice: noise removed (RNNoise voice isolation - hiss, hum, fans, traffic gone, not just
//   lowered), rumble cut, levelled so quiet and loud passages sit together, then the "Clear voice" EQ
//   (presence, less boom) and the "Podcast" compressor (close, steady, radio-style). Whatever was
//   already set on a source - its own clean-up, EQ or compressor - is kept as it was.
// - The music: dips under the voice wherever someone speaks, with the "Music under voice" EQ carving
//   room where speech sits - only when there's a voice; sound effects are never touched.
// - The mix: the master limiter on (peaks under -1 dBTP) and the loudness for where it's going.
// - Every join already crossfades, click-free (audioJoins.ts).
//
// planSoundPro works it out without touching anything - applied as one undo step, so Before/After is
// an undo and a redo.

import type { AudioCleanup, AudioOverlay, Clip } from "./videoEditTypes";
import { hasAudioCleanup, isImageClipPath } from "./videoEditTypes";
import { isSpeechOverlay } from "./musicDucking";
import { DEFAULT_LIMITER, type MasterBus } from "./masterBus";
import { audioChannelKey, audioChannelName, COMPRESSOR_PRESETS, EQ_PRESETS, isFlatEq, type AudioFx } from "./audioFx";
import { VIDEO_CHANNEL } from "./mixerState";

export type SoundDestination = "youtube" | "podcast" | "broadcast";

export const SOUND_DESTINATIONS: Record<SoundDestination, { lufs: number; label: string; hint: string }> = {
  youtube: { lufs: -14, label: "YouTube", hint: "YouTube, Spotify and most streaming" },
  podcast: { lufs: -16, label: "Podcast", hint: "Podcasts, Apple" },
  broadcast: { lufs: -23, label: "Broadcast", hint: "TV and radio (EBU R128)" },
};

export type SoundRole = "voice" | "music" | "leave";


export const VOICE_NOISE_REDUCTION = 1;
export const VOICE_CLEANUP: AudioCleanup = { mode: "remove", lowCut: true, level: true };
const preset = <T extends { id: string }>(list: T[], id: string): T => list.find((p) => p.id === id) ?? list[0];
export const VOICE_EQ = preset(EQ_PRESETS, "voice").eq;
export const MUSIC_BED_EQ = preset(EQ_PRESETS, "music-bed").eq;
export const VOICE_COMPRESSOR = preset(COMPRESSOR_PRESETS, "podcast").comp;

export interface SoundProInput {
  clips: Clip[];
  audioOverlays: AudioOverlay[];
  videoAudioMuted: boolean;
  videoAudioFx: AudioFx | undefined;
  master: MasterBus | undefined;
  loudnessLufs: number | null;
}

export interface SoundSource {
  key: string; // mixer channel key
  name: string;
  role: SoundRole;
}

export interface SoundProStep {
  key: "voice" | "music" | "limiter" | "loudness" | "joins";
  text: string;
  // Already so before this ran - shown, but nothing was changed for it.
  already: boolean;
}

export interface SoundProPlan {
  clips: Clip[];
  audioOverlays: AudioOverlay[];
  videoAudioFx: AudioFx | undefined;
  master: MasterBus | undefined;
  loudnessLufs: number;
  sources: SoundSource[];
  steps: SoundProStep[];
  // Voice tracks it sets cleaning - each renders a cleaned copy before it plays cleaned.
  cleanedTrackIds: string[];
  // Anything to apply at all (besides the loudness target, which isn't part of the edit).
  changesEdit: boolean;
}

// A clip whose own sound plays in the mix.
const soundingClip = (c: Clip, videoAudioMuted: boolean) => !videoAudioMuted && !c.muted && !isImageClipPath(c.sourcePath);

// What a track most likely is.
export function guessRole(o: AudioOverlay): SoundRole {
  if (o.library?.kind === "sfx") return "leave";
  if (isSpeechOverlay(o)) return "voice";
  if (o.library || (o.detached && /music/i.test(o.label ?? "")) || (o.bpm ?? 0) > 0) return "music";
  return "voice";
}

// The voice's EQ and compressor, over whatever wasn't already set.
const voiceFx = (fx: AudioFx | undefined): AudioFx => ({ ...fx, eq: fx?.eq && !isFlatEq(fx.eq) ? fx.eq : VOICE_EQ, compressor: fx?.compressor ?? VOICE_COMPRESSOR });
const musicFx = (fx: AudioFx | undefined): AudioFx => ({ ...fx, eq: fx?.eq && !isFlatEq(fx.eq) ? fx.eq : MUSIC_BED_EQ });
const sameFx = (a: AudioFx | undefined, b: AudioFx) => JSON.stringify(a ?? {}) === JSON.stringify(b);

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// `roles` overrides the guesses, by channel key.
export function planSoundPro(input: SoundProInput, destination: SoundDestination, roles: Record<string, SoundRole> = {}): SoundProPlan {
  const now = Date.now();
  const steps: SoundProStep[] = [];

  // Every source and its role.
  const sources: SoundSource[] = [];
  const videoSounds = input.clips.some((c) => soundingClip(c, input.videoAudioMuted));
  if (videoSounds) sources.push({ key: VIDEO_CHANNEL, name: "Video sound", role: roles[VIDEO_CHANNEL] ?? "voice" });
  for (const o of input.audioOverlays) {
    if (o.muted) continue;
    const key = audioChannelKey(o);
    if (!sources.some((s) => s.key === key)) sources.push({ key, name: audioChannelName(o), role: roles[key] ?? guessRole(o) });
  }
  const roleOf = (key: string) => sources.find((s) => s.key === key)?.role ?? "leave";
  const voices = sources.filter((s) => s.role === "voice");
  const music = sources.filter((s) => s.role === "music");

  // The voice.
  let voiceChanged = 0;
  const cleanedTrackIds: string[] = [];
  let clips = input.clips;
  let videoAudioFx = input.videoAudioFx;
  if (roleOf(VIDEO_CHANNEL) === "voice") {
    let any = false;
    clips = input.clips.map((c) => {
      if (!soundingClip(c, input.videoAudioMuted) || hasAudioCleanup(c)) return c;
      any = true;
      return { ...c, noiseReduction: VOICE_NOISE_REDUCTION, audioCleanup: { ...c.audioCleanup, ...VOICE_CLEANUP } };
    });
    const fx = voiceFx(input.videoAudioFx);
    if (!sameFx(input.videoAudioFx, fx)) {
      videoAudioFx = fx;
      any = true;
    }
    if (any) voiceChanged++;
  }
  const touched = new Set<string>();
  let audioOverlays = input.audioOverlays.map((o) => {
    if (o.muted || roleOf(audioChannelKey(o)) !== "voice") return o;
    const fx = voiceFx(o.fx);
    const clean = !hasAudioCleanup(o);
    if (!clean && sameFx(o.fx, fx)) return o;
    touched.add(audioChannelKey(o));
    if (clean) cleanedTrackIds.push(o.id);
    return { ...o, ...(clean ? { noiseReduction: VOICE_NOISE_REDUCTION, audioCleanup: { ...o.audioCleanup, ...VOICE_CLEANUP } } : {}), fx, updatedAt: now };
  });
  voiceChanged += touched.size;
  if (voices.length > 0) {
    steps.push({
      key: "voice",
      text: voiceChanged > 0 ? `Voice: noise removed, levelled, clear and close - ${plural(voices.length, "source")}` : "Voice already cleaned",
      already: voiceChanged === 0,
    });
  }

  // The music.
  let musicChanged = 0;
  if (voices.length > 0 && music.length > 0) {
    const changed = new Set<string>();
    audioOverlays = audioOverlays.map((o) => {
      if (o.muted || roleOf(audioChannelKey(o)) !== "music") return o;
      const fx = musicFx(o.fx);
      if (o.duckUnderSpeech && sameFx(o.fx, fx)) return o;
      changed.add(audioChannelKey(o));
      return { ...o, duckUnderSpeech: true, fx, updatedAt: now };
    });
    musicChanged = changed.size;
    steps.push({ key: "music", text: musicChanged > 0 ? `Music dips under the voice - ${plural(music.length, "track")}` : "Music already dips under the voice", already: musicChanged === 0 });
  }

  // The master.
  const hasLimiter = !!input.master?.limiter;
  const master = hasLimiter ? input.master : { ...input.master, limiter: DEFAULT_LIMITER };
  steps.push({ key: "limiter", text: `Peaks held under ${(master?.limiter ?? DEFAULT_LIMITER).ceilingDb} dB - no clipping`, already: hasLimiter });
  const target = SOUND_DESTINATIONS[destination];
  steps.push({ key: "loudness", text: `Saved at ${target.lufs} LUFS for ${target.label}`, already: input.loudnessLufs === target.lufs });
  if (input.audioOverlays.length > 1) steps.push({ key: "joins", text: "Every join crossfades - no clicks", already: true });

  return {
    clips,
    audioOverlays,
    videoAudioFx,
    master,
    loudnessLufs: target.lufs,
    sources,
    steps,
    cleanedTrackIds,
    changesEdit: voiceChanged > 0 || musicChanged > 0 || !hasLimiter,
  };
}
