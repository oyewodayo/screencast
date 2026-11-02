import { describe, expect, it } from "vitest";
import { guessRole, MUSIC_BED_EQ, planSoundPro, VOICE_CLEANUP, VOICE_COMPRESSOR, VOICE_EQ, VOICE_NOISE_REDUCTION, type SoundProInput } from "./soundPro";
import type { AudioOverlay, Clip } from "./videoEditTypes";

const clip = (id: string, extra: Partial<Clip> = {}): Clip => ({ id, sourcePath: "talk.mp4", start: 0, end: 10, ...extra });
const track = (id: string, extra: Partial<AudioOverlay> = {}): AudioOverlay => ({
  id,
  src: `${id}.mp3`,
  startTime: 0,
  endTime: 10,
  trimStart: 0,
  sourceDuration: 60,
  volume: 1,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});
const song = (id: string) => track(id, { library: { trackId: id, title: id, artist: "", kind: "music", license: "" } });
const input = (extra: Partial<SoundProInput>): SoundProInput => ({ clips: [], audioOverlays: [], videoAudioMuted: false, videoAudioFx: undefined, master: undefined, loudnessLufs: null, ...extra });

describe("make it sound pro", () => {
  it("treats a plain audio track of your own as the voice - the case that did nothing before", () => {
    const own = track("VID_20260821 - audio");
    expect(guessRole(own)).toBe("voice");
    const plan = planSoundPro(input({ audioOverlays: [own] }), "youtube");
    expect(plan.audioOverlays[0]).toMatchObject({ noiseReduction: VOICE_NOISE_REDUCTION, audioCleanup: VOICE_CLEANUP, fx: { eq: VOICE_EQ, compressor: VOICE_COMPRESSOR } });
    expect(plan.cleanedTrackIds).toEqual([own.id]);
    expect(plan.steps[0]).toMatchObject({ key: "voice", already: false });
  });

  it("cleans the video's sound, ducks a song under it and carves room for the voice", () => {
    const plan = planSoundPro(input({ clips: [clip("a")], audioOverlays: [song("song")] }), "podcast");
    expect(plan.clips[0]).toMatchObject({ noiseReduction: VOICE_NOISE_REDUCTION, audioCleanup: VOICE_CLEANUP });
    expect(plan.videoAudioFx).toMatchObject({ eq: VOICE_EQ, compressor: VOICE_COMPRESSOR });
    expect(plan.audioOverlays[0]).toMatchObject({ duckUnderSpeech: true, fx: { eq: MUSIC_BED_EQ } });
    expect(plan.master?.limiter?.ceilingDb).toBe(-1);
    expect(plan.loudnessLufs).toBe(-16);
    expect(plan.sources.map((s) => [s.name, s.role])).toEqual([
      ["Video sound", "voice"],
      ["song", "music"],
    ]);
  });

  it("follows a role changed by hand", () => {
    const own = track("ambience");
    const plan = planSoundPro(input({ clips: [clip("a")], audioOverlays: [own] }), "youtube", { "src:ambience.mp3": "leave" });
    expect(plan.audioOverlays[0]).toBe(own);
  });

  it("keeps what was already set: its own clean-up, EQ and compressor", () => {
    const own = clip("a", { noiseReduction: 0.3, audioCleanup: { mode: "reduce" } });
    const fx = { eq: { low: 2, mid: 0, midFreq: 1000, midQ: 1, high: 0 } };
    const plan = planSoundPro(input({ clips: [own], videoAudioFx: fx }), "youtube");
    expect(plan.clips[0]).toBe(own);
    expect(plan.videoAudioFx).toEqual({ ...fx, compressor: VOICE_COMPRESSOR });
  });

  it("never touches a sound effect, and ducks nothing with no voice", () => {
    const sfx = track("whoosh", { library: { trackId: "w", title: "Whoosh", artist: "", kind: "sfx", license: "" } });
    const plan = planSoundPro(input({ clips: [clip("a")], audioOverlays: [song("song"), sfx], videoAudioMuted: true }), "youtube");
    expect(plan.audioOverlays[0].duckUnderSpeech).toBeUndefined();
    expect(plan.audioOverlays[1]).toBe(sfx);
  });

  it("has nothing to change on an edit that's already done", () => {
    const done = planSoundPro(input({ clips: [clip("a")], audioOverlays: [song("song")] }), "youtube");
    const again = planSoundPro(input({ clips: done.clips, audioOverlays: done.audioOverlays, videoAudioFx: done.videoAudioFx, master: done.master, loudnessLufs: -14 }), "youtube");
    expect(again.changesEdit).toBe(false);
    expect(again.steps.every((s) => s.already)).toBe(true);
  });
});
