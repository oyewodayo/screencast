import { describe, expect, it } from "vitest";
import { makeStageScene } from "./stage/stageEditing";
import { inlineSceneOutputStart, insertInlineSceneClip, syncInlineScenes } from "./inlineSceneTimeline";
import type { Clip } from "./videoEditTypes";

function makeMedia(id: string, dur: number): Clip {
  return { id, sourcePath: "/video.mp4", start: 0, end: dur };
}

function makeScenePair(id: string, startTime = 0) {
  const scene = makeStageScene({ startTime, frameWidth: 1920, frameHeight: 1080 });
  const clip: Clip = {
    id,
    sourcePath: "/blank.png",
    start: 0,
    end: 3,
    muted: true,
    sceneId: scene.id,
  };
  return { scene, clip };
}

describe("inlineSceneTimeline", () => {
  it("places a scene before media when playhead is at start (0s)", () => {
    const media = makeMedia("m1", 20);
    const { scene, clip } = makeScenePair("s1");
    const inserted = insertInlineSceneClip([media], 0, clip, () => "split");
    const synced = syncInlineScenes(inserted.clips, [scene]);

    expect(synced.clips.map((c) => c.id)).toEqual(["s1", "m1"]);
    expect(synced.scenes[0].startTime).toBe(0);
    expect(inlineSceneOutputStart(synced.clips, scene.id)).toBe(0);
  });

  it("places a scene after media when playhead is near the end", () => {
    const media = makeMedia("m1", 20);
    const { scene, clip } = makeScenePair("s1");
    const inserted = insertInlineSceneClip([media], 19.8, clip, () => "split");
    const synced = syncInlineScenes(inserted.clips, [scene]);

    expect(synced.clips.map((c) => c.id)).toEqual(["m1", "s1"]);
    expect(synced.scenes[0].startTime).toBe(20);
  });

  it("splits a media clip when inserting a scene in the middle", () => {
    const media = makeMedia("m1", 20);
    const { scene, clip } = makeScenePair("s1");
    const inserted = insertInlineSceneClip([media], 8, clip, () => "m1-b");
    const synced = syncInlineScenes(inserted.clips, [scene]);

    expect(synced.clips.map((c) => c.id)).toEqual(["m1", "s1", "m1-b"]);
    expect(synced.clips[0].end).toBeCloseTo(8, 3);
    expect(synced.clips[2].start).toBeCloseTo(8, 3);
    expect(synced.scenes[0].startTime).toBeCloseTo(8, 3);
  });

  it("updates scene startTime automatically when reordered after media", () => {
    const media = makeMedia("m1", 15);
    const { scene, clip } = makeScenePair("s1", 0);
    const reordered = [media, clip];
    const synced = syncInlineScenes(reordered, [scene]);

    expect(synced.scenes[0].startTime).toBe(15);
    expect(synced.clips[1].end).toBe(3);
  });

  it("leaves overlay scenes (not linked to any clip) untouched", () => {
    const media = makeMedia("m1", 15);
    const overlayScene = makeStageScene({ startTime: 5, frameWidth: 1920, frameHeight: 1080 });
    const synced = syncInlineScenes([media], [overlayScene]);

    expect(synced.scenes[0].startTime).toBe(5);
    expect(inlineSceneOutputStart(synced.clips, overlayScene.id)).toBeNull();
  });
});
