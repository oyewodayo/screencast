// Covers utils/videoStyleTemplates.ts.
import { describe, expect, it } from "vitest";
import {
  STYLE_TEMPLATES,
  buildStyledProject,
  coverCrop,
  musicStartFor,
  planShots,
  sceneCells,
  shotBoundaries,
  styleTemplate,
  suggestTemplateTracks,
  templateOptions,
} from "./videoStyleTemplates";
import { titleStyle } from "./titleStyles";
import { stageCanDraw } from "../components/video/stageTransitions";
import type { MusicTrack } from "./musicLibrary";

const frame = { width: 1080, height: 1920 };
const photos = (n: number) => Array.from({ length: n }, (_, i) => `p${i}.jpg`);
// 120 BPM from 0s to 120s.
const beats = Array.from({ length: 241 }, (_, i) => i * 0.5);
const song = { path: "song.m4a", sourceDuration: 120, bpm: 120, beats, label: "Song" };
const total = (s: { clips: { start: number; end: number }[] }) => s.clips.reduce((sum, c) => sum + (c.end - c.start), 0);

describe("planShots", () => {
  it("groups a scene's photos into one shot at its place, two cuts long", () => {
    const t = styleTemplate("event-recap")!; // a 2x2 grid at shot 5
    const shots = planShots(photos(12), t, true, 2);
    expect(shots.map((s) => s.photos.length)).toEqual([1, 1, 1, 1, 1, 4, 1, 1, 1]);
    expect(shots[5].scene?.kind).toBe("grid");
    expect(shots[5].beats).toBe(4);
  });
  it("leaves a scene out when it would leave no photo after it", () => {
    const shots = planShots(photos(8), styleTemplate("event-recap")!, true, 2);
    expect(shots.every((s) => !s.scene)).toBe(true);
  });
  it("leaves scenes out when they're switched off", () => {
    expect(planShots(photos(12), styleTemplate("event-recap")!, false, 2)).toHaveLength(12);
  });
});

describe("shotBoundaries", () => {
  it("lands every cut on a beat, carrying on at the song's pace past its last beat", () => {
    const shots = [{ photos: ["a"], scene: null, beats: 2 }, { photos: ["b"], scene: null, beats: 4 }, { photos: ["c"], scene: null, beats: 2 }];
    expect(shotBoundaries(shots, [0, 0.5, 1, 1.5, 2], 0.5)).toEqual([0, 1, 3, 4]);
    expect(shotBoundaries(shots, null, 0.8).map((x) => +x.toFixed(6))).toEqual([0, 1.6, 4.8, 6.4]);
  });
});

describe("buildStyledProject", () => {
  it("cuts every shot on the song's beats from a beat at its best part", () => {
    const t = styleTemplate("event-recap")!;
    const state = buildStyledProject(photos(6), frame, { ...templateOptions(t), music: { ...song, highlightStart: 10.2 } });
    // Two beats at 120 BPM = 1s a photo.
    expect(state.clips.map((c) => c.end - c.start)).toEqual([1, 1, 1, 1, 1, 1]);
    const [music] = state.audioOverlays;
    expect(beats).toContain(music.trimStart);
    expect(music.trimStart).toBeGreaterThanOrEqual(10.2);
    expect(music.endTime).toBeCloseTo(6);
  });

  it("lays a collage scene out as cropped photo cells over a backdrop, holding for two cuts", () => {
    const t = styleTemplate("event-recap")!;
    const state = buildStyledProject(photos(12), frame, { ...templateOptions(t), music: song }, { aspectOf: () => 4 / 3 });
    expect(state.clips).toHaveLength(9);
    expect(state.clips[5].end - state.clips[5].start).toBe(2);
    expect(state.clips[5].kenBurns).toBeUndefined();
    const cells = state.imageOverlays.filter((o) => o.src && !o.asset);
    expect(cells.map((c) => c.src)).toEqual(["p5.jpg", "p6.jpg", "p7.jpg", "p8.jpg"]);
    // Tall cells cut from wide photos: the sides are cropped away.
    expect(cells[0].cropWidth).toBeLessThan(1);
    expect(cells[0].cropHeight).toBe(1);
    expect(cells.every((c) => c.startTime >= 5 && c.endTime === 7)).toBe(true);
    expect(state.adjustmentLayers).toHaveLength(1);
    expect(state.adjustmentLayers[0]).toMatchObject({ fill: "#ffffff", startTime: 5, endTime: 7 });
  });

  it("puts each caption card on its shot, lines stacked in their looks with their animations", () => {
    const t = styleTemplate("event-recap")!;
    const state = buildStyledProject(photos(6), frame, { ...templateOptions(t), texts: { ...templateOptions(t).texts, h1: "EVERY SUMMER" }, music: song });
    const opening = state.textOverlays.filter((o) => o.startTime === 0);
    expect(opening.map((o) => o.text)).toEqual(["EVERY SUMMER"]);
    expect(opening[0]).toMatchObject({ fontFamily: "anton", animation: "typewriter", glow: { color: "#22d3ee" } });
    const sub = state.textOverlays.find((o) => o.text === "We Gather!")!;
    expect(sub.startTime).toBeCloseTo(0.55);
    expect(sub.y).toBeGreaterThan(opening[0].y);
    // The finale sits on the last shot, to the very end.
    const finale = state.textOverlays.find((o) => o.text === "ARE YOU READY?")!;
    expect(finale.startTime).toBe(5);
    expect(finale.endTime).toBe(6);
  });

  it("never lays a caption over a collage", () => {
    const t = styleTemplate("new-collection")!; // the title card spans two shots; a framed trio is shot 1
    const state = buildStyledProject(photos(12), frame, { ...templateOptions(t), music: song });
    const title = state.textOverlays.find((o) => o.text === "New Collection")!;
    const trio = state.adjustmentLayers[0];
    expect(title.endTime).toBeLessThanOrEqual(trio.startTime);
  });

  it("leaves a caption out when its words are cleared", () => {
    const t = styleTemplate("memories")!;
    const state = buildStyledProject(photos(5), frame, { ...templateOptions(t), texts: { title: " ", sub: "", end: "Forever" }, music: null });
    expect(state.textOverlays.map((o) => o.text)).toEqual(["Forever"]);
  });

  it("puts the template's clip effects on its plain shots in turn, and leaves them off when effects are off", () => {
    const t = styleTemplate("promo")!;
    const state = buildStyledProject(photos(5), frame, { ...templateOptions(t), music: null });
    expect(state.clips.map((c) => c.fx?.kind ?? null)).toEqual(["rgbsplit", "huecycle", null, "echo", "rgbsplit"]);
    const off = buildStyledProject(photos(5), frame, { ...templateOptions(t), overlays: false, music: null });
    expect(off.clips.every((c) => !c.fx)).toBe(true);
  });

  it("covers the whole video with the template's frame overlays", () => {
    const t = styleTemplate("film-strip")!;
    const state = buildStyledProject(photos(4), frame, { ...templateOptions(t), music: null });
    const length = total(state);
    const frames = state.imageOverlays.filter((o) => o.asset?.kind === "filmstrip" || o.asset?.kind === "grain");
    expect(frames).toHaveLength(2);
    expect(frames.every((o) => o.startTime === 0 && o.endTime === length && o.width === 1)).toBe(true);
  });

  it("makes a lower third an element carrying both lines", () => {
    const t = styleTemplate("lecture-teaser")!;
    const state = buildStyledProject(photos(6), frame, { ...templateOptions(t), music: null });
    const third = state.imageOverlays.find((o) => o.asset?.kind === "lower-third");
    expect(third?.asset?.text).toBe("Diffusion Models, Explained");
    expect(third?.asset?.subtext).toBe("Speaker · Department");
  });

  it("shrinks a line that won't fit across the frame", () => {
    const t = styleTemplate("event-recap")!;
    const measure = (text: string, _style: string, px: number) => text.length * px * 0.6;
    const wide = buildStyledProject(photos(6), { width: 1920, height: 1080 }, { ...templateOptions(t), music: null }, { measure });
    const tall = buildStyledProject(photos(6), frame, { ...templateOptions(t), texts: { ...templateOptions(t).texts, h1: "A MUCH LONGER OPENING HEADLINE" }, music: null }, { measure });
    const h = (s: typeof wide) => s.textOverlays[0];
    expect(h(tall).fontSize * 1920).toBeLessThan(0.15 * 1080);
    expect(h(wide).fontSize * 1080).toBeCloseTo(0.15 * 1080);
  });
});

describe("sceneCells / coverCrop", () => {
  it("keeps a grid's cells inside the frame without overlapping", () => {
    for (const aspect of [9 / 16, 1, 16 / 9]) {
      const cells = sceneCells({ kind: "grid", at: 0, backdrop: "#000" }, aspect);
      for (const c of cells) {
        expect(c.x).toBeGreaterThan(0);
        expect(c.x + c.w).toBeLessThan(1);
        expect(c.y + c.h).toBeLessThan(1);
      }
      expect(cells[0].x + cells[0].w).toBeLessThan(cells[1].x);
    }
  });
  it("crops the sides of a wide picture for a tall box, and the top and bottom of a tall one", () => {
    expect(coverCrop(2, 1)).toEqual({ cropX: 0.25, cropY: 0, cropWidth: 0.5, cropHeight: 1 });
    expect(coverCrop(0.5, 1)).toEqual({ cropX: 0, cropY: 0.25, cropWidth: 1, cropHeight: 0.5 });
  });
});

describe("musicStartFor", () => {
  it("starts on a beat at the best part when the rest of the song is long enough", () => {
    expect(musicStartFor({ sourceDuration: 60, beats, highlightStart: 20.1 }, 10)).toBe(20.5);
  });
  it("starts earlier when the best part leaves too little song", () => {
    expect(musicStartFor({ sourceDuration: 60, beats, highlightStart: 55 }, 20)).toBe(40);
  });
});

describe("suggestTemplateTracks", () => {
  const track = (id: string, energy: number, moods: string[]): MusicTrack =>
    ({ id, title: id, artist: "x", kind: "music", moods, tags: [], energy, duration: 120, peaks: [], file: { url: "", size: 0, sha256: "" }, license: { name: "CC0" } }) as MusicTrack;
  it("ranks songs of the template's energy and mood first", () => {
    const tracks = [track("calm", 1, ["calm"]), track("hype", 5, ["energetic"]), track("mid", 3, [])];
    expect(suggestTemplateTracks(tracks, styleTemplate("promo")!.music, 10)[0].id).toBe("hype");
    expect(suggestTemplateTracks(tracks, styleTemplate("memories")!.music, 10)[0].id).toBe("calm");
  });
});

describe("every template", () => {
  it("uses only looks that exist, transitions the stage can draw and words it defines", () => {
    for (const t of STYLE_TEMPLATES) {
      const slots = new Set(t.texts.map((x) => x.id));
      const lines = [...t.captions.flatMap((c) => c.lines), ...t.scenes.flatMap((s) => (s.kind === "panels" ? s.words : []))];
      expect(lines.filter((l) => !titleStyle(l.style)).map((l) => l.style)).toEqual([]);
      expect(lines.filter((l) => !slots.has(l.slot)).map((l) => l.slot)).toEqual([]);
      expect(titleStyle(t.cardStyle)).not.toBeNull();
      expect(t.transitions.filter((x) => !stageCanDraw(x))).toEqual([]);
    }
  });
});
