import { beforeEach, describe, expect, it } from "vitest";
import { compileStage, sampleStage, sampleStageCamera, stageIsMoving } from "./stageEngine";
import {
  addBeat,
  addElement,
  distributeElements,
  elementInBeat,
  fitElementToStage,
  frameElementCamera,
  isLightStageBackground,
  makeShapeElement,
  makeStageScene,
  resolvedBeatCamera,
  sceneDuration,
  setBeatCamera,
  setBeatSound,
} from "./stageEditing";
import { STAGE_TEMPLATES, applyTemplateToScene, stageBackgroundCss } from "./stageTemplates";
import {
  applyUserSceneTemplate,
  deleteUserSceneTemplate,
  loadUserSceneTemplates,
  saveUserSceneTemplate,
} from "./stageUserTemplates";
import { stageSoundCues } from "./stageSounds";
import { parseOutlineText, sceneFromOutline, sceneFromWhiteboardMindmap } from "./stageImport";
import { STAGE_HEIGHT } from "./stageTypes";
import { createDefaultWhiteboardEdge, createDefaultWhiteboardNode, WHITEBOARD_SCHEMA_VERSION, type WhiteboardDocument } from "../whiteboardTypes";

describe("Stage Pro Upgrades", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => {
          store.set(k, String(v));
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => store.clear(),
      },
    });
  });

  it("builds and compiles all 14 studio & pro templates cleanly for 16:9 and 9:16", () => {
    expect(STAGE_TEMPLATES.length).toBe(14);
    expect(STAGE_TEMPLATES.filter((t) => t.pro).length).toBe(6);
    for (const tpl of STAGE_TEMPLATES) {
      for (const width of [1920, 607.5]) {
        const sc = tpl.build({ width, startTime: 2.5 });
        expect(sc.width).toBe(width);
        expect(sc.height).toBe(STAGE_HEIGHT);
        expect(sc.elements.length).toBeGreaterThan(0);
        expect(sc.beats.length).toBe(tpl.beatCount);
        expect(sceneDuration(sc)).toBeGreaterThan(0.5);
        const compiled = compileStage(sc);
        expect(compiled.duration).toBeCloseTo(sceneDuration(sc), 5);
        const sampled = sampleStage(compiled, 0.5);
        expect(sampled.length).toBeGreaterThan(0);
      }
    }

    const base = makeStageScene({ startTime: 7.25, frameWidth: 1920, frameHeight: 1080 });
    const applied = applyTemplateToScene(base, "kpi-counter");
    expect(applied.id).toBe(base.id);
    expect(applied.startTime).toBe(7.25);
    expect(applied.width).toBe(1920);
    expect(applied.channels?.length).toBe(1);
  });

  it("saves, loads, applies (with fresh IDs & aspect rescale), and deletes custom user templates", () => {
    const base = applyTemplateToScene(
      makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 }),
      "kinetic-intro"
    );
    const saved = saveUserSceneTemplate("My Channel Intro", base);
    expect(saved.length).toBe(1);
    expect(loadUserSceneTemplates()[0].name).toBe("My Channel Intro");

    const verticalTarget = makeStageScene({ startTime: 4, frameWidth: 1080, frameHeight: 1920 });
    const applied = applyUserSceneTemplate(verticalTarget, saved[0]);
    expect(applied.id).toBe(verticalTarget.id);
    expect(applied.startTime).toBe(4);
    expect(applied.width).toBe(verticalTarget.width);
    expect(applied.elements[0].id).not.toBe(base.elements[0].id);
    expect(applied.beats[0].id).not.toBe(base.beats[0].id);

    const afterDelete = deleteUserSceneTemplate(saved[0].id);
    expect(afterDelete.length).toBe(0);
  });

  it("springs virtual camera smoothly between beats and flags stageIsMoving", () => {
    let sc = makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 });
    sc = addBeat(sc, 0, 2).scene;
    sc = addBeat(sc, 1, 2).scene;
    sc = setBeatCamera(sc, 1, { zoom: 1.8, panX: 160, panY: -80, tilt: 4.5 });
    // Beat 2 inherits Beat 1 until explicitly reset
    expect(resolvedBeatCamera(sc, 2).zoom).toBe(1.8);
    // Explicitly resetting Beat 2 returns to neutral 100%
    sc = setBeatCamera(sc, 2, null);
    expect(resolvedBeatCamera(sc, 2)).toEqual({ zoom: 1, panX: 0, panY: 0, tilt: 0 });

    const compiled = compileStage(sc);
    const atBeat0 = sampleStageCamera(compiled, 0.5);
    expect(atBeat0.zoom).toBeCloseTo(1, 3);
    expect(atBeat0.moving).toBe(false);

    // Just before Beat 1 (starts at 3.0s), pending camera move is detected by stageIsMoving
    expect(stageIsMoving(compiled, 2.95, 3.05)).toBe(true);

    // Mid-transition into Beat 1
    const mid = sampleStageCamera(compiled, 3.15);
    expect(mid.moving).toBe(true);
    expect(mid.zoom).toBeGreaterThan(1.05);
    expect(mid.zoom).toBeLessThan(1.85);

    // Settled in Beat 1
    const settled = sampleStageCamera(compiled, 4.8);
    expect(settled.zoom).toBeCloseTo(1.8, 2);
    expect(settled.panX).toBeCloseTo(160, 1);
    expect(settled.panY).toBeCloseTo(-80, 1);
    expect(settled.tilt).toBeCloseTo(4.5, 1);

    // Frame helper centers on an arbitrary rect with sane zoom
    const framed = frameElementCamera(sc, { x: 1200, y: 600, width: 400, height: 200 });
    expect(framed.zoom).toBeGreaterThan(1.2);
    expect(framed.panX).toBe(1400 - sc.width / 2);
    expect(framed.panY).toBe(700 - STAGE_HEIGHT / 2);
  });

  it("classifies light vs dark gradient & solid backgrounds and builds CSS previews", () => {
    expect(isLightStageBackground({ kind: "none" })).toBe(false);
    expect(isLightStageBackground({ kind: "color", color: "#f2f1ee" })).toBe(true);
    expect(isLightStageBackground({ kind: "color", color: "#0f172a" })).toBe(false);
    expect(isLightStageBackground({ kind: "gradient", from: "#f8fafc", to: "#e2e8f0" })).toBe(true);
    expect(isLightStageBackground({ kind: "gradient", from: "#0f172a", to: "#134e4a" })).toBe(false);
    expect(stageBackgroundCss({ kind: "gradient", from: "#111111", to: "#222222", radial: true })).toContain("radial-gradient");

    // Animated gradient motion, drifting grid/dots, and film grain trigger stageIsMoving for continuous frames
    const staticScene = makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 });
    expect(stageIsMoving(compileStage(staticScene), 2.5)).toBe(false);
    const animGrad = { ...staticScene, background: { kind: "gradient" as const, from: "#0f172a", to: "#134e4a", motion: 0.4 } };
    expect(stageIsMoving(compileStage(animGrad), 2.5)).toBe(true);
    const driftGrid = { ...staticScene, background: { kind: "color" as const, color: "#0f172a", pattern: "grid" as const, patternDrift: 24 } };
    expect(stageIsMoving(compileStage(driftGrid), 2.5)).toBe(true);
    const grainy = { ...staticScene, background: { kind: "color" as const, color: "#0f172a", grain: 0.25 } };
    expect(stageIsMoving(compileStage(grainy), 2.5)).toBe(true);
  });

  it("produces sorted CutCues for beat SFX respecting defaults and per-beat overrides", () => {
    let sc = makeStageScene({ startTime: 5, frameWidth: 1920, frameHeight: 1080 });
    sc = { ...sc, beatSound: "pop" };
    sc = addBeat(sc, 0, 2).scene;
    sc = addBeat(sc, 1, 2).scene;
    sc = setBeatSound(sc, 1, "none"); // silence beat 1
    sc = setBeatSound(sc, 2, "whoosh"); // override beat 2

    const cues = stageSoundCues([sc]);
    expect(cues.length).toBe(2);
    expect(cues[0].soundId).toBe("builtin:pop");
    expect(cues[0].at).toBeCloseTo(5, 4);
    expect(cues[1].soundId).toBe("builtin:whoosh");
    expect(cues[1].at).toBeCloseTo(10, 4);
    expect(cues[1].start).toBeLessThan(cues[1].at); // whoosh has lead time
  });

  it("imports Markdown outlines and Whiteboard Mind Maps into multi-beat animated scenes", () => {
    const parsed = parseOutlineText("# Launch Plan\n- Build core engine\n- Add templates\n- Ship v0.1.8");
    expect(parsed.title).toBe("Launch Plan");
    expect(parsed.bullets).toEqual(["Build core engine", "Add templates", "Ship v0.1.8"]);

    const outlineScene = sceneFromOutline(parsed.title, parsed.bullets, { width: 1920, startTime: 0 });
    expect(outlineScene.beats.length).toBe(5); // title + 3 bullets + summary
    expect(compileStage(outlineScene).tracks.length).toBe(outlineScene.elements.length);

    const root = { ...createDefaultWhiteboardNode("n-root", "mindmapTopic", 400, 300), text: "Briefcast Architecture" };
    const b1 = { ...createDefaultWhiteboardNode("n-1", "mindmapSubtopic", 700, 200), text: "Video Engine" };
    const b2 = { ...createDefaultWhiteboardNode("n-2", "mindmapSubtopic", 700, 420), text: "Docs & Whiteboard" };
    const sub = { ...createDefaultWhiteboardNode("n-1a", "mindmapSubtopic", 960, 200), text: "60fps WebGL" };
    const e1 = createDefaultWhiteboardEdge("e-1", { nodeId: root.id, anchor: "auto" }, { nodeId: b1.id, anchor: "auto" });
    const e2 = createDefaultWhiteboardEdge("e-2", { nodeId: root.id, anchor: "auto" }, { nodeId: b2.id, anchor: "auto" });
    const e3 = createDefaultWhiteboardEdge("e-3", { nodeId: b1.id, anchor: "auto" }, { nodeId: sub.id, anchor: "auto" });
    const wb: WhiteboardDocument = {
      version: WHITEBOARD_SCHEMA_VERSION,
      id: "wb-1",
      name: "Architecture Map",
      showGrid: true,
      snapToGrid: true,
      createdAt: "",
      updatedAt: "",
      activePageId: "p1",
      pages: [{ id: "p1", name: "Page 1", nodes: [root, b1, b2, sub], edges: [e1, e2, e3] }],
    };
    const mmScene = sceneFromWhiteboardMindmap(wb, { width: 1920, startTime: 1 });
    expect(mmScene.beats.length).toBe(4); // root + 2 branches + overview
    expect(mmScene.elements.filter((el) => el.kind === "connector").length).toBe(2);
    expect(compileStage(mmScene).duration).toBeGreaterThan(6);
  });

  it("evenly distributes elements and fits an element cleanly to stage", () => {
    let sc = makeStageScene({ startTime: 0, frameWidth: 1920, frameHeight: 1080 });
    const a = makeShapeElement({ x: 100, y: 400, width: 100, height: 100 });
    const b = makeShapeElement({ x: 250, y: 400, width: 100, height: 100 });
    const c = makeShapeElement({ x: 900, y: 400, width: 100, height: 100 });
    sc = addElement(addElement(addElement(sc, 0, a), 0, b), 0, c);
    sc = distributeElements(sc, 0, "x");
    // Span from 100 to 1000 (900px) with 3 boxes of 100px => gap = 300px => middle box at x = 500
    expect(elementInBeat(sc, 0, b.id)?.x).toBe(500);

    sc = fitElementToStage(sc, 0, a.id, 90);
    const fitted = elementInBeat(sc, 0, a.id)!;
    expect(fitted.height).toBe(900);
    expect(fitted.width).toBe(900);
    expect(fitted.y).toBe(90);
    expect(fitted.x).toBe(Math.round((1920 - 900) / 2));
  });
});
