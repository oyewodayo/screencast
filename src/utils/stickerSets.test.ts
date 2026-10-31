import { describe, expect, it } from "vitest";
import { ASSET_CATALOG, ASSET_FPS, assetFrameKey, makeAsset } from "./videoAssets";
import { STICKER_ICONS, STICKER_KINDS, checklistItems, isStickerKind, searchIcons } from "./stickerAssets";
import { searchEmoji } from "./stickerEmoji";
import { STICKER_PRESETS, STICKER_SETS, placeStickerSet } from "./stickerSets";

describe("stickers", () => {
  it("every sticker kind is in the element catalog, under Stickers", () => {
    for (const kind of STICKER_KINDS) expect(ASSET_CATALOG.find((e) => e.kind === kind)?.category).toBe("Stickers");
  });

  it("presets are all stickers", () => {
    for (const p of STICKER_PRESETS) expect(isStickerKind(p.asset.kind)).toBe(true);
  });

  it("a stat renders every frame while it counts, then one still", () => {
    const asset = { ...makeAsset("stat"), loop: "none" as const, exit: false };
    const total = 6 * ASSET_FPS;
    const keys = Array.from({ length: total }, (_, k) => assetFrameKey(asset, k, total, 6));
    const counting = keys.slice(0, Math.round(2.2 * ASSET_FPS));
    expect(new Set(counting).size).toBe(counting.length);
    expect(new Set(keys.slice(Math.round(2.5 * ASSET_FPS)))).toEqual(new Set(["still"]));
  });
});

describe("icons, emoji and checklists", () => {
  it("finds icons by name, group and keyword", () => {
    expect(searchIcons("money").map((i) => i.value)).toContain("dollar");
    expect(searchIcons("launch").map((i) => i.value)).toContain("rocket");
    expect(searchIcons("zzzz")).toEqual([]);
    expect(new Set(STICKER_ICONS.map((i) => i.value)).size).toBe(STICKER_ICONS.length);
  });

  it("finds emoji by words, once each", () => {
    const fire = searchEmoji("fire");
    expect(fire[0].char).toBe("🔥");
    expect(new Set(fire.map((e) => e.char)).size).toBe(fire.length);
  });

  it("splits checklist items at semicolons, at most six", () => {
    expect(checklistItems(" Plan ; Record;;Edit ")).toEqual(["Plan", "Record", "Edit"]);
    expect(checklistItems("a;b;c;d;e;f;g")).toHaveLength(6);
  });
});

describe("placeStickerSet", () => {
  it("puts a chip that follows another just after it", () => {
    const set = STICKER_SETS.find((s) => s.id === "live")!;
    const [live, viewers] = placeStickerSet(set, 16 / 9, 0, 10);
    expect(viewers.x).toBeCloseTo(live.x + live.width + 0.012, 5);
  });

  for (const [name, aspect] of [["16:9", 16 / 9], ["9:16", 9 / 16], ["1:1", 1]] as const) {
    it(`keeps every piece of every set on a ${name} frame`, () => {
      for (const set of STICKER_SETS) {
        for (const o of placeStickerSet(set, aspect, 2, 30)) {
          expect(o.x).toBeGreaterThanOrEqual(0);
          expect(o.y).toBeGreaterThanOrEqual(0);
          expect(o.x + o.width).toBeLessThanOrEqual(1.0001);
          expect(o.y + o.height).toBeLessThanOrEqual(1.0001);
        }
      }
    });
  }

  it("times pieces in one after another and clips the set to the timeline", () => {
    const set = STICKER_SETS.find((s) => s.id === "stat")!;
    const placed = placeStickerSet(set, 16 / 9, 10, 13);
    expect(placed.map((o) => o.startTime)).toEqual([10, 10.3, 12.3]);
    for (const o of placed) expect(o.endTime).toBe(13);
  });
});
