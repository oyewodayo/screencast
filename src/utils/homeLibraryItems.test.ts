import { describe, expect, it } from "vitest";
import { buildHomeItems, relativeTime } from "./homeLibraryItems";

const T = Date.parse("2026-10-11T12:00:00Z");
const files = [
  { path: "/a.mp4", name: "a.mp4", modified: T - 10_000 },
  { path: "/b.mp4", name: "b.mp4", modified: T - 90_000 },
  { path: "/c.png", name: "c.png", modified: T - 5_000 },
];
const base = { files, pinnedPaths: [], recentPaths: [], openedAt: {}, docs: [], whiteboards: [], mindmaps: [] };

describe("buildHomeItems", () => {
  it("merges documents, whiteboards and mind maps with files, newest first", () => {
    const items = buildHomeItems({
      ...base,
      docs: [{ id: "d1", name: "Proposal", updated_at: new Date(T - 1_000).toISOString() }],
      whiteboards: [{ id: "w1", name: "Flow", updated_at: new Date(T - 60_000).toISOString() }],
      mindmaps: [{ id: "m1", name: "", updated_at: new Date(T - 7_000).toISOString() }],
    });
    expect(items.map((i) => i.key)).toEqual(["doc:d1", "/c.png", "mindmap:m1", "/a.mp4", "whiteboard:w1", "/b.mp4"]);
    expect(items.find((i) => i.kind === "mindmap")!.name).toBe("Untitled");
  });

  it("keeps pinned files on top and ranks opened items by when they were opened", () => {
    const items = buildHomeItems({
      ...base,
      pinnedPaths: ["/b.mp4"],
      recentPaths: ["/a.mp4", "/b.mp4"],
      openedAt: { "/a.mp4": T, "whiteboard:w1": T + 1 },
      whiteboards: [{ id: "w1", name: "Flow", updated_at: new Date(T - 600_000).toISOString() }],
    });
    // c.png was never opened, so once there's open history it doesn't compete.
    expect(items.map((i) => i.key)).toEqual(["/b.mp4", "whiteboard:w1", "/a.mp4"]);
    expect(items[0].pinned).toBe(true);
  });

  it("caps the list", () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, name: `Doc ${i}`, updated_at: new Date(T - i).toISOString() }));
    expect(buildHomeItems({ ...base, docs, limit: 5 })).toHaveLength(5);
  });
});

describe("relativeTime", () => {
  it("reads naturally", () => {
    expect(relativeTime(T - 20_000, T)).toBe("just now");
    expect(relativeTime(T - 5 * 60_000, T)).toBe("5m ago");
    expect(relativeTime(T - 3 * 3_600_000, T)).toBe("3h ago");
    expect(relativeTime(T - 2 * 86_400_000, T)).toBe("2d ago");
    expect(relativeTime(0, T)).toBe("");
  });
});
