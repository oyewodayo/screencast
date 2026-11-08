// utils/appSettings.test.ts
//
// The settings cache in front of Rust's settings.json (src-tauri/src/services/settings_store.rs):
// first-run migration from the old localStorage key, the non-Tauri fallback, write coalescing and
// updateSettings' no-op guard. The Tauri API is mocked and `window`/`localStorage` are stubbed, since
// this suite runs in plain Node (see vitest.config.ts). Each test re-imports the module so its
// module-level cache starts empty.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const listen = vi.fn(async () => () => {});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

let storage: MemoryStorage;

function stubEnvironment({ tauri }: { tauri: boolean }) {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  const win: Record<string, unknown> = { dispatchEvent: () => true };
  if (tauri) win.__TAURI_INTERNALS__ = {};
  vi.stubGlobal("window", win);
  vi.stubGlobal("CustomEvent", class { constructor(public type: string, public init?: unknown) {} });
}

async function freshModule() {
  vi.resetModules();
  return import("./appSettings");
}

// Lets the module's fire-and-forget write loop run to completion.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invoke.mockReset();
  listen.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("initSettings", () => {
  it("outside Tauri, reads the legacy localStorage copy and never calls Rust", async () => {
    stubEnvironment({ tauri: false });
    storage.setItem("briefcast.settings.v1", JSON.stringify({ theme: "dark" }));
    const m = await freshModule();
    await m.initSettings();
    expect(m.loadSettings().theme).toBe("dark");
    expect(m.loadSettings().defaultFileExt).toBe(m.DEFAULT_SETTINGS.defaultFileExt);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the file's settings, merged over defaults, when Rust has them", async () => {
    stubEnvironment({ tauri: true });
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_settings" ? { theme: "light" } : undefined));
    const m = await freshModule();
    await m.initSettings();
    expect(m.loadSettings().theme).toBe("light");
    expect(m.loadSettings().trashRetentionDays).toBe(m.DEFAULT_SETTINGS.trashRetentionDays);
    expect(invoke).not.toHaveBeenCalledWith("set_settings", expect.anything());
  });

  it("migrates the legacy copy into the file on first run", async () => {
    stubEnvironment({ tauri: true });
    storage.setItem("briefcast.settings.v1", JSON.stringify({ theme: "dark", trashRetentionDays: 7 }));
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_settings" ? null : undefined));
    const m = await freshModule();
    await m.initSettings();
    await settle();
    const write = invoke.mock.calls.find(([cmd]) => cmd === "set_settings");
    expect(write?.[1].settings).toMatchObject({ theme: "dark", trashRetentionDays: 7 });
  });

  it("applies the one-time avi -> mp4 correction while migrating", async () => {
    stubEnvironment({ tauri: false });
    storage.setItem("briefcast.settings.v1", JSON.stringify({ defaultFileExt: "avi" }));
    const m = await freshModule();
    await m.initSettings();
    expect(m.loadSettings().defaultFileExt).toBe("mp4");
    expect(storage.getItem("briefcast.settings.aviDefaultMigrated.v1")).toBe("1");
  });

  it("falls back to local storage if Rust cannot be reached", async () => {
    stubEnvironment({ tauri: true });
    storage.setItem("briefcast.settings.v1", JSON.stringify({ theme: "dark" }));
    invoke.mockRejectedValue(new Error("no backend"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const m = await freshModule();
    await m.initSettings();
    expect(m.loadSettings().theme).toBe("dark");
  });
});

describe("saving", () => {
  async function initialisedWithBackend() {
    stubEnvironment({ tauri: true });
    invoke.mockImplementation(async (cmd: string) => (cmd === "get_settings" ? {} : undefined));
    const m = await freshModule();
    await m.initSettings();
    invoke.mockClear();
    return m;
  }

  it("coalesces a burst of saves and always ends on the newest", async () => {
    const m = await initialisedWithBackend();
    for (const days of [1, 2, 3, 4, 5]) m.saveSettings({ ...m.loadSettings(), trashRetentionDays: days });
    const writes = () => invoke.mock.calls.filter(([cmd]) => cmd === "set_settings");
    const lastWrite = () => {
      const all = writes();
      return all[all.length - 1]?.[1].settings.trashRetentionDays;
    };
    await vi.waitFor(() => expect(lastWrite()).toBe(5));
    await settle();
    expect(writes().length).toBeLessThan(5);
    expect(m.loadSettings().trashRetentionDays).toBe(5);
  });

  it("updateSettings writes only when a value actually changes", async () => {
    const m = await initialisedWithBackend();
    expect(m.updateSettings({ theme: m.loadSettings().theme })).toBe(false);
    expect(m.updateSettings({ defaultVideoDevices: [...m.loadSettings().defaultVideoDevices] })).toBe(false);
    expect(m.updateSettings({ theme: "dark" })).toBe(true);
    await settle();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "set_settings")).toHaveLength(1);
  });

  it("loadSettings hands out copies, so a caller can't mutate the cache", async () => {
    const m = await initialisedWithBackend();
    const copy = m.loadSettings();
    copy.theme = "dark";
    expect(m.loadSettings().theme).toBe(m.DEFAULT_SETTINGS.theme);
  });
});
