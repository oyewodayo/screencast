import { describe, expect, it } from "vitest";
import { ASSET_CATALOG, ASSET_FPS, LOOP_PERIOD_SEC, assetFrameKey, entranceSeconds, makeAsset } from "./videoAssets";

const keysFor = (asset: ReturnType<typeof makeAsset>, duration: number) => {
  const total = Math.ceil(duration * ASSET_FPS);
  return Array.from({ length: total }, (_, k) => assetFrameKey(asset, k, total, duration));
};

describe("assetFrameKey", () => {
  it("collapses a still shape's middle to one frame", () => {
    const asset = { ...makeAsset("rectangle"), loop: "none" as const };
    const keys = keysFor(asset, 10);
    const entering = Math.ceil(entranceSeconds(asset, 10) * ASSET_FPS);
    expect(new Set(keys).size).toBe(entering * 2 + 1);
  });

  it("repeats a looping element every loop period, however long it runs", () => {
    const asset = { ...makeAsset("star"), loop: "pulse" as const };
    const short = new Set(keysFor(asset, 12)).size;
    const long = new Set(keysFor(asset, 120)).size;
    expect(long).toBe(short);
    expect(long).toBeLessThanOrEqual(LOOP_PERIOD_SEC * ASSET_FPS + 2 * Math.ceil(entranceSeconds(asset, 12) * ASSET_FPS));
  });

  it("renders every frame of a timed element", () => {
    const keys = keysFor(makeAsset("countdown"), 3);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("has no exit frames when exit is off", () => {
    const asset = { ...makeAsset("circle"), loop: "none" as const, exit: false };
    const keys = keysFor(asset, 5);
    expect(keys[keys.length - 1]).toBe("still");
  });

  it("renders a timer once per displayed second", () => {
    const asset = { ...makeAsset("timer"), entrance: "none" as const };
    expect(new Set(keysFor(asset, 10)).size).toBe(10);
  });

  it("gives every catalog entry defaults", () => {
    for (const entry of ASSET_CATALOG) expect(makeAsset(entry.kind).kind).toBe(entry.kind);
  });
});
