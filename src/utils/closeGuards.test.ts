// utils/closeGuards.test.ts
//
// Releasing the main window to the tray (settings.releaseWindowInTray): it happens only after the
// grace period, only while still hidden, never while a blocker says the page is needed, and the
// close guards run in "release" mode first. Tauri's window/dialog APIs are mocked; timers are fake.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => undefined as unknown);
let visible = true;
let closeHandler: ((event: { preventDefault: () => void }) => Promise<void>) | null = null;
const win = {
  hide: vi.fn(async () => {
    visible = false;
  }),
  show: vi.fn(async () => {
    visible = true;
  }),
  setFocus: vi.fn(async () => {}),
  isVisible: vi.fn(async () => visible),
  destroy: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  onFocusChanged: vi.fn(async () => () => {}),
  onCloseRequested: vi.fn(async (handler: typeof closeHandler) => {
    closeHandler = handler;
    return () => {};
  }),
};
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => win }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true) }));

async function setup(settings: Record<string, unknown>) {
  vi.resetModules();
  vi.stubGlobal("window", { setTimeout, clearTimeout, dispatchEvent: () => true });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  const appSettings = await import("./appSettings");
  appSettings.saveSettings({ ...appSettings.DEFAULT_SETTINGS, ...settings });
  const guards = await import("./closeGuards");
  guards.installCloseGuards();
  return guards;
}

async function clickClose() {
  await closeHandler?.({ preventDefault: () => {} });
}

const released = () => invoke.mock.calls.some(([cmd]) => cmd === "release_main_window");

beforeEach(() => {
  vi.useFakeTimers();
  visible = true;
  closeHandler = null;
  invoke.mockClear();
  win.destroy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("release to the tray", () => {
  it("releases after the grace period, running guards in release mode", async () => {
    const guards = await setup({ closeToTray: true, releaseWindowInTray: true });
    const guard = vi.fn(async () => true);
    guards.addCloseGuard(guard);
    await clickClose();
    expect(visible).toBe(false);
    expect(released()).toBe(false);
    await vi.advanceTimersByTimeAsync(guards.RELEASE_AFTER_MS);
    expect(guard).toHaveBeenCalledWith("release");
    expect(released()).toBe(true);
    expect(win.destroy).not.toHaveBeenCalled();
  });

  it("only hides when the setting is off", async () => {
    const guards = await setup({ closeToTray: true, releaseWindowInTray: false });
    await clickClose();
    await vi.advanceTimersByTimeAsync(guards.RELEASE_AFTER_MS * 3);
    expect(visible).toBe(false);
    expect(released()).toBe(false);
  });

  it("waits while a blocker needs the page, then releases once it clears", async () => {
    const guards = await setup({ closeToTray: true, releaseWindowInTray: true });
    let exporting = true;
    guards.addReleaseBlocker(() => (exporting ? "an export is running" : null));
    vi.spyOn(console, "info").mockImplementation(() => {});
    await clickClose();
    await vi.advanceTimersByTimeAsync(guards.RELEASE_AFTER_MS);
    expect(released()).toBe(false);
    exporting = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(released()).toBe(true);
  });

  it("never releases a window that was opened again", async () => {
    const guards = await setup({ closeToTray: true, releaseWindowInTray: true });
    await clickClose();
    visible = true;
    await vi.advanceTimersByTimeAsync(guards.RELEASE_AFTER_MS);
    expect(released()).toBe(false);
  });

  it("a guard that says no keeps the window and tries again later", async () => {
    const guards = await setup({ closeToTray: true, releaseWindowInTray: true });
    let ok = false;
    guards.addCloseGuard(async () => ok);
    await clickClose();
    await vi.advanceTimersByTimeAsync(guards.RELEASE_AFTER_MS);
    expect(released()).toBe(false);
    ok = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(released()).toBe(true);
  });
});

describe("hiding to the tray", () => {
  it("tells the page to stop playback before the window hides", async () => {
    const guards = await setup({ closeToTray: true, releaseWindowInTray: false });
    const order: string[] = [];
    (globalThis.window as unknown as { dispatchEvent: (e: { type: string }) => boolean }).dispatchEvent = (e) => {
      order.push(`event:${e.type}`);
      return true;
    };
    win.hide.mockImplementationOnce(async () => {
      order.push("hide");
      visible = false;
    });
    await clickClose();
    expect(order).toEqual([`event:${guards.HIDDEN_TO_TRAY_EVENT}`, "hide"]);
  });

  it("does not signal anything when the close button quits instead", async () => {
    const guards = await setup({ closeToTray: false });
    const events: string[] = [];
    (globalThis.window as unknown as { dispatchEvent: (e: { type: string }) => boolean }).dispatchEvent = (e) => {
      events.push(e.type);
      return true;
    };
    await clickClose();
    expect(events).not.toContain(guards.HIDDEN_TO_TRAY_EVENT);
  });
});

describe("quitting", () => {
  it("runs guards in quit mode and destroys the window", async () => {
    const guards = await setup({ closeToTray: false });
    const guard = vi.fn(async () => true);
    guards.addCloseGuard(guard);
    await clickClose();
    expect(guard).toHaveBeenCalledWith("quit");
    expect(win.destroy).toHaveBeenCalled();
  });

  it("a guard that says no keeps the app open", async () => {
    const guards = await setup({ closeToTray: false });
    guards.addCloseGuard(async () => false);
    await clickClose();
    expect(win.destroy).not.toHaveBeenCalled();
  });
});
