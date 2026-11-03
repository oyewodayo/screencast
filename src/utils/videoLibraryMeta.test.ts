import { describe, expect, it } from "vitest";
import { describeEdit, exportBase, exportLabel, exportsOf, isExportName } from "./videoLibraryMeta";

describe("video library details", () => {
  it("finds a video's exports, newest first", () => {
    const files = [
      { path: "C:/v/Demo.mp4", size: 1, modified: 1 },
      { path: "C:/v/Demo (edited).mp4", size: 1, modified: 5 },
      { path: "C:/v/Demo (share-ready) (2).mp4", size: 1, modified: 9 },
      { path: "C:/v/Demo two (edited).mp4", size: 1, modified: 7 },
    ];
    expect(exportsOf("C:/v/Demo.mp4", files).map((f) => f.path)).toEqual(["C:/v/Demo (share-ready) (2).mp4", "C:/v/Demo (edited).mp4"]);
    expect(isExportName("C:/v/Demo (edited).mp4")).toBe(true);
    expect(isExportName("C:/v/Demo.mp4")).toBe(false);
  });

  it("names what an edit holds, most telling first", () => {
    const parts = describeEdit({ outputDuration: 60, sourceDuration: 90, clips: 3, splitScreens: 1, titles: 1, layers: 0, captions: true, canvasLabel: null, canvasAspect: null, updatedAt: null });
    expect(parts).toEqual(["1 split screen", "3 clips", "1 title", "captions"]);
  });

  it("groups a video with its exports wherever they sit, and names each", () => {
    expect(exportBase("C:/lib/Exports/Demo - v2.mp4")).toBe(exportBase("C:/lib/recordings/Demo.mp4"));
    expect(exportBase("C:/lib/Demo (edited) (edited).mp4")).toBe("demo");
    expect(isExportName("C:/lib/Exports/Anything.mp4")).toBe(true);
    expect(exportLabel("C:/lib/Exports/Demo - v12.mp4")).toBe("v12");
    expect(exportLabel("C:/lib/Demo (share-ready).mp4")).toBe("share-ready");
    expect(exportLabel("C:/lib/Demo (edited).mp4")).toBe("edited");
  });
});
