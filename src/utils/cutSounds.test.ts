// Sound on every cut (cutSounds.ts): which cuts get a sound, which sound, and when it plays.
import { describe, expect, it } from "vitest";
import { DEFAULT_CUT_SOUNDS, autoCutSound, cutSoundCues, cutSoundPieces } from "./cutSounds";
import { clipPiece } from "../handlers/videoEditHandlers";
import type { Clip } from "./videoEditTypes";

const clip = (id: string, seconds: number, extra: Partial<Clip> = {}): Clip => ({ id, sourcePath: `${id}.jpg`, start: 0, end: seconds, ...extra });
const push = (duration: number) => ({ type: "push" as const, duration });

describe("cutSoundCues", () => {
  it("is nothing while switched off", () => {
    expect(cutSoundCues([clip("a", 2), clip("b", 2)], undefined, undefined)).toEqual([]);
    expect(cutSoundCues([clip("a", 2), clip("b", 2)], undefined, { ...DEFAULT_CUT_SOUNDS, on: false })).toEqual([]);
  });

  it("puts a transition's matching sound with its peak on the transition's middle", () => {
    const [cue] = cutSoundCues([clip("a", 3), clip("b", 3, { transitionIn: push(0.6) })], undefined, DEFAULT_CUT_SOUNDS);
    expect(cue.soundId).toBe("builtin:whoosh");
    expect(cue.at).toBeCloseTo(3.3);
    expect(cue.start).toBeCloseTo(3.3 - 0.34); // the whoosh's lead
  });

  it("gives plain cuts a swoosh on the cut - unless plain cuts are left out", () => {
    const clips = [clip("a", 2), clip("b", 2), clip("c", 2, { transitionIn: push(0.4) })];
    expect(cutSoundCues(clips, undefined, DEFAULT_CUT_SOUNDS).map((c) => [c.key, c.soundId, c.at])).toEqual([
      ["b", "builtin:swoosh", 2],
      ["c", "builtin:whoosh", 4.2],
    ]);
    expect(cutSoundCues(clips, undefined, { ...DEFAULT_CUT_SOUNDS, plainCuts: false }).map((c) => c.key)).toEqual(["c"]);
  });

  it("honours a cut's own pick, or none, over the automatic one", () => {
    const clips = [clip("a", 2), clip("b", 2, { cutSound: "builtin:flash" }), clip("c", 2, { transitionIn: push(0.4), cutSound: null })];
    const cues = cutSoundCues(clips, undefined, { ...DEFAULT_CUT_SOUNDS, plainCuts: false });
    expect(cues.map((c) => [c.key, c.soundId])).toEqual([["b", "builtin:flash"]]);
    // The camera flash charges for a second and fires on the cut.
    expect(cues[0].start).toBeCloseTo(1);
  });

  it("moves with its cut when the clips are reordered", () => {
    const a = clip("a", 1);
    const b = clip("b", 2, { transitionIn: push(0.4) });
    const c = clip("c", 3);
    expect(cutSoundCues([a, b, c], undefined, DEFAULT_CUT_SOUNDS).find((x) => x.key === "b")?.at).toBeCloseTo(1.2);
    expect(cutSoundCues([c, a, b], undefined, DEFAULT_CUT_SOUNDS).find((x) => x.key === "b")?.at).toBeCloseTo(4.2);
  });

  it("sounds the intro and outro by their transitions, at their middles", () => {
    const edges = { intro: { type: "fadewhite" as const, duration: 1 }, outro: { type: "glitch" as const, duration: 1 } };
    const cues = cutSoundCues([clip("a", 10)], edges, DEFAULT_CUT_SOUNDS);
    expect(cues.map((c) => [c.key, c.soundId, c.at])).toEqual([
      ["intro", "builtin:flash", 0.5],
      ["outro", "builtin:glitch", 9.5],
    ]);
    expect(cutSoundCues([clip("a", 10)], { ...edges, sounds: { intro: null } }, DEFAULT_CUT_SOUNDS).map((c) => c.key)).toEqual(["outro"]);
  });

  it("keeps the sound on the first piece of a split clip only", () => {
    const b = clip("b", 4, { transitionIn: push(0.4), cutSound: "builtin:pop" });
    expect(clipPiece(b, 0, 2, { first: true }).cutSound).toBe("builtin:pop");
    expect("cutSound" in clipPiece(b, 2, 4, { first: false })).toBe(false);
  });
});

describe("cutSoundPieces", () => {
  it("cuts a sound that starts before the video at 0, and never runs past the end", async () => {
    const pieces = await cutSoundPieces(
      [
        { key: "intro", soundId: "builtin:whoosh", start: -0.2, at: 0.14 },
        { key: "outro", soundId: "builtin:whoosh", start: 9.7, at: 10.04 },
      ],
      10,
      async (id) => `/sfx/${id}.wav`
    );
    expect(pieces[0]).toMatchObject({ startTime: 0, trimStart: 0.2, endTime: 0.6000000000000001 });
    expect(pieces[1].endTime).toBe(10);
    expect(pieces[1].trimStart).toBe(0);
  });
});

describe("autoCutSound", () => {
  it("pairs each kind of move with its sound", () => {
    expect(autoCutSound("glitch")).toBe("builtin:glitch");
    expect(autoCutSound("pagecurl")).toBe("builtin:swipe");
    expect(autoCutSound("zoomin")).toBe("builtin:swoosh");
    expect(autoCutSound(null)).toBe("builtin:swoosh");
  });
});
