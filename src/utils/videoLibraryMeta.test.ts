import { describe, expect, it } from "vitest";
import { hasVideoEdits, summarize } from "./videoLibraryMeta";
import { createEmptyState } from "./videoEditTypes";

describe("videoLibraryMeta watch vs edit detection", () => {
  const path = "C:\\Videos\\Learn PyTorch in 5 Projects – Tutorial [E0bwEAWmVEM].webm";

  it("treats an untouched single-clip default state as NOT edited", () => {
    const empty = createEmptyState(path, 20880); // 5h 48m tutorial simply watched
    expect(hasVideoEdits(empty, path)).toBe(false);
    expect(summarize(empty, path)).toBeNull();
  });

  it("treats trimmed or split videos as edited", () => {
    const trimmed = createEmptyState(path, 120);
    trimmed.clips[0] = { ...trimmed.clips[0], start: 5 };
    expect(hasVideoEdits(trimmed, path)).toBe(true);
    expect(summarize(trimmed, path)).not.toBeNull();

    const split = createEmptyState(path, 120);
    split.clips = [
      { ...split.clips[0], end: 60 },
      { id: "clip-2", sourcePath: path, start: 60, end: 120 },
    ];
    expect(hasVideoEdits(split, path)).toBe(true);
  });

  it("treats overlays, screen styles, speed changes, or captions as edited", () => {
    const withStyle = { ...createEmptyState(path, 60), screenStyle: { background: { kind: "color" as const, color: "#000" }, padding: 0.07, radius: 0.02, shadow: 0.5 } };
    expect(hasVideoEdits(withStyle, path)).toBe(true);

    const spedUp = createEmptyState(path, 60);
    spedUp.clips[0] = { ...spedUp.clips[0], speed: 1.5 };
    expect(hasVideoEdits(spedUp, path)).toBe(true);

    const withChapter = { ...createEmptyState(path, 60), chapters: [{ id: "ch-1", sourcePath: path, sourceTime: 10, label: "Setup" }] };
    expect(hasVideoEdits(withChapter, path)).toBe(true);
  });

  it("always treats .briefvideo project files as editable projects", () => {
    const projectPath = "C:\\Videos\\Projects\\MyProject.briefvideo";
    const emptyProject = createEmptyState(projectPath, 0);
    expect(hasVideoEdits(emptyProject, projectPath)).toBe(true);
  });
});
