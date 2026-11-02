// Covers utils/playbackResume.ts — the resume-position and last-opened-per-category store behind
// "leave a video and come back where you stopped" / "clicking a sidebar tab reopens its last file".
//
// The suite runs under vitest's `node` environment (vitest.config.ts), which has no localStorage,
// so one is stubbed onto globalThis below. The module caches both maps in module scope on first
// touch, so every test re-imports it via vi.resetModules() to get a clean instance rather than
// inheriting the previous test's cache.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

function installStorageStub(seed: Record<string, string> = {}): Record<string, string> {
  const store: Record<string, string> = { ...seed };
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      Object.keys(store).forEach((key) => delete store[key]);
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };
  return store;
}

type Module = typeof import("./playbackResume");

async function freshModule(seed?: Record<string, string>): Promise<{ mod: Module; store: Record<string, string> }> {
  const store = installStorageStub(seed);
  vi.resetModules();
  const mod = await import("./playbackResume");
  return { mod, store };
}

const POSITIONS_KEY = "briefcast.playbackPositions.v1";
const LAST_OPENED_KEY = "briefcast.lastOpenedByCategory.v1";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("playback positions", () => {
  it("resumes a position that is far enough in to be worth resuming", async () => {
    const { mod } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/talk.mp4", 124.5);
    expect(mod.getResumeTime("C:/lib/talk.mp4")).toBe(124.5);
  });

  it("reports nothing for a file that has never been played", async () => {
    const { mod } = await freshModule();
    expect(mod.getResumeTime("C:/lib/never-opened.mp4")).toBeUndefined();
  });

  // A couple of seconds in reads as "start over" to anyone watching, so it isn't stored - and it
  // actively clears an older position, since going back to the start is a deliberate act.
  it("ignores a position inside the opening seconds, and clears any earlier one", async () => {
    const { mod } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/talk.mp4", 300);
    mod.recordPlaybackPosition("C:/lib/talk.mp4", 1.2);
    expect(mod.getResumeTime("C:/lib/talk.mp4")).toBeUndefined();
  });

  it("ignores a NaN or negative time without disturbing the stored position", async () => {
    const { mod } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/talk.mp4", 90);
    mod.recordPlaybackPosition("C:/lib/talk.mp4", Number.NaN);
    mod.recordPlaybackPosition("C:/lib/talk.mp4", -4);
    expect(mod.getResumeTime("C:/lib/talk.mp4")).toBe(90);
  });

  it("forgets a file's position once it has played to the end", async () => {
    const { mod } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/talk.mp4", 900);
    mod.clearPlaybackPosition("C:/lib/talk.mp4");
    expect(mod.getResumeTime("C:/lib/talk.mp4")).toBeUndefined();
  });

  it("tracks each file independently", async () => {
    const { mod } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/a.mp4", 30);
    mod.recordPlaybackPosition("C:/lib/b.mp3", 600);
    expect(mod.getResumeTime("C:/lib/a.mp4")).toBe(30);
    expect(mod.getResumeTime("C:/lib/b.mp3")).toBe(600);
  });
});

describe("position persistence", () => {
  // The write-behind buffer is the whole reason ~4 ticks/sec don't hammer localStorage, so the
  // "not written yet, but already readable" window is deliberate and worth pinning down.
  it("keeps a just-recorded position readable before it is flushed", async () => {
    const { mod, store } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/talk.mp4", 42);
    expect(store[POSITIONS_KEY]).toBeUndefined();
    expect(mod.getResumeTime("C:/lib/talk.mp4")).toBe(42);
  });

  it("writes positions out once the flush timer fires", async () => {
    const { mod, store } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/talk.mp4", 42);
    vi.advanceTimersByTime(3000);
    expect(JSON.parse(store[POSITIONS_KEY])["C:/lib/talk.mp4"].time).toBe(42);
  });

  it("writes positions out immediately when flushed by hand", async () => {
    const { mod, store } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/talk.mp4", 42);
    mod.flushPlaybackPositions();
    expect(JSON.parse(store[POSITIONS_KEY])["C:/lib/talk.mp4"].time).toBe(42);
  });

  it("reads positions written by a previous session", async () => {
    const seeded = JSON.stringify({ "C:/lib/talk.mp4": { time: 77, savedAt: 1 } });
    const { mod } = await freshModule({ [POSITIONS_KEY]: seeded });
    expect(mod.getResumeTime("C:/lib/talk.mp4")).toBe(77);
  });

  it("starts clean rather than throwing when the stored positions are corrupt", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { mod } = await freshModule({ [POSITIONS_KEY]: "{not json" });
    expect(mod.getResumeTime("C:/lib/talk.mp4")).toBeUndefined();
    consoleError.mockRestore();
  });

  it("caps the stored positions, dropping the least recently saved first", async () => {
    const { mod, store } = await freshModule();
    // 201 files, each saved a tick apart so the eviction order is unambiguous.
    for (let i = 0; i < 201; i++) {
      vi.setSystemTime(new Date(1_000_000 + i * 1000));
      mod.recordPlaybackPosition(`C:/lib/file-${i}.mp4`, 60);
    }
    mod.flushPlaybackPositions();
    const stored = JSON.parse(store[POSITIONS_KEY]);
    expect(Object.keys(stored)).toHaveLength(200);
    expect(stored["C:/lib/file-0.mp4"]).toBeUndefined();
    expect(stored["C:/lib/file-200.mp4"]).toBeDefined();
  });
});

describe("last-opened file per category", () => {
  it("reports nothing for a category nothing has been opened under", async () => {
    const { mod } = await freshModule();
    expect(mod.getLastOpenedFile("video")).toBeNull();
  });

  it("remembers the most recent file per category, independently", async () => {
    const { mod } = await freshModule();
    mod.recordLastOpenedFile("video", { path: "C:/lib/a.mp4", name: "a.mp4" });
    mod.recordLastOpenedFile("audio", { path: "C:/lib/b.mp3", name: "b.mp3" });
    mod.recordLastOpenedFile("video", { path: "C:/lib/c.mp4", name: "c.mp4" });
    expect(mod.getLastOpenedFile("video")).toEqual({ path: "C:/lib/c.mp4", name: "c.mp4" });
    expect(mod.getLastOpenedFile("audio")).toEqual({ path: "C:/lib/b.mp3", name: "b.mp3" });
  });

  it("persists straight away, without waiting for a flush", async () => {
    const { mod, store } = await freshModule();
    mod.recordLastOpenedFile("pdf", { path: "C:/lib/paper.pdf", name: "paper.pdf" });
    expect(JSON.parse(store[LAST_OPENED_KEY]).pdf.name).toBe("paper.pdf");
  });

  it("forgets a category's entry on request", async () => {
    const { mod } = await freshModule();
    mod.recordLastOpenedFile("image", { path: "C:/lib/shot.png", name: "shot.png" });
    mod.forgetLastOpenedFile("image");
    expect(mod.getLastOpenedFile("image")).toBeNull();
  });
});

describe("path lifecycle", () => {
  it("carries a resume position across a rename", async () => {
    const { mod } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/old.mp4", 55);
    mod.repathPlaybackState("C:/lib/old.mp4", "C:/lib/new.mp4");
    expect(mod.getResumeTime("C:/lib/old.mp4")).toBeUndefined();
    expect(mod.getResumeTime("C:/lib/new.mp4")).toBe(55);
  });

  it("repoints a last-opened entry at the new path, taking the new name with it", async () => {
    const { mod } = await freshModule();
    mod.recordLastOpenedFile("video", { path: "C:/lib/old.mp4", name: "old.mp4" });
    mod.repathPlaybackState("C:/lib/old.mp4", "C:/lib/sub/new.mp4");
    expect(mod.getLastOpenedFile("video")).toEqual({ path: "C:/lib/sub/new.mp4", name: "new.mp4" });
  });

  it("leaves unrelated entries alone when repathing", async () => {
    const { mod } = await freshModule();
    mod.recordLastOpenedFile("audio", { path: "C:/lib/song.mp3", name: "song.mp3" });
    mod.recordPlaybackPosition("C:/lib/song.mp3", 20);
    mod.repathPlaybackState("C:/lib/old.mp4", "C:/lib/new.mp4");
    expect(mod.getLastOpenedFile("audio")).toEqual({ path: "C:/lib/song.mp3", name: "song.mp3" });
    expect(mod.getResumeTime("C:/lib/song.mp3")).toBe(20);
  });

  it("drops both the position and the last-opened entry when a file is deleted", async () => {
    const { mod } = await freshModule();
    mod.recordPlaybackPosition("C:/lib/gone.mp4", 61);
    mod.recordLastOpenedFile("video", { path: "C:/lib/gone.mp4", name: "gone.mp4" });
    mod.forgetPlaybackState("C:/lib/gone.mp4");
    expect(mod.getResumeTime("C:/lib/gone.mp4")).toBeUndefined();
    expect(mod.getLastOpenedFile("video")).toBeNull();
  });
});
