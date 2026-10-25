// Runs under vitest's `node` environment (vitest.config.ts), which has no localStorage - a Map-backed
// one is stubbed onto globalThis before each test.
import { beforeEach, describe, expect, it } from "vitest";
import { forgetFile, getArrivals, getRecentPaths, recordFileArrived, recordFileOpened, repathFile } from "./homeScreenFiles";

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
});

describe("recordFileArrived", () => {
  it("puts an arrival at the top of the recent list, tagged with its phone", () => {
    recordFileOpened("/work.mp4");
    const { recent, arrivals } = recordFileArrived("/From phone/IMG_1.jpg", "Android phone", "b1", 1000);
    expect(recent).toEqual(["/From phone/IMG_1.jpg", "/work.mp4"]);
    expect(arrivals["/From phone/IMG_1.jpg"]).toEqual({ from: "Android phone", at: 1000, batch: "b1", count: 1 });
  });

  it("keeps one row per batch: the newest file stands for the rest", () => {
    recordFileOpened("/a.mp4");
    recordFileOpened("/b.mp4");
    for (let i = 1; i <= 12; i++) recordFileArrived(`/From phone/IMG_${i}.jpg`, "Pixel", "share-1", i);
    expect(getRecentPaths()).toEqual(["/From phone/IMG_12.jpg", "/b.mp4", "/a.mp4"]);
    const arrivals = getArrivals();
    expect(Object.keys(arrivals)).toEqual(["/From phone/IMG_12.jpg"]);
    expect(arrivals["/From phone/IMG_12.jpg"].count).toBe(12);
  });

  it("gives separate batches separate rows", () => {
    recordFileArrived("/From phone/a.jpg", "Pixel", "b1");
    recordFileArrived("/From phone/b.jpg", "Pixel", "b1");
    recordFileArrived("/From phone/c.mp4", "iPhone", "b2");
    expect(getRecentPaths()).toEqual(["/From phone/c.mp4", "/From phone/b.jpg"]);
    expect(getArrivals()["/From phone/b.jpg"].count).toBe(2);
    expect(getArrivals()["/From phone/c.mp4"]).toMatchObject({ from: "iPhone", count: 1 });
  });

  it("follows the file through a rename and forgets it once deleted", () => {
    recordFileArrived("/From phone/a.jpg", "Pixel", "b1");
    repathFile("/From phone/a.jpg", "/Pictures/a.jpg");
    expect(getArrivals()["/Pictures/a.jpg"]?.from).toBe("Pixel");
    expect(getArrivals()["/From phone/a.jpg"]).toBeUndefined();
    forgetFile("/Pictures/a.jpg");
    expect(getArrivals()).toEqual({});
  });
});
