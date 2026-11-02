import { describe, expect, it } from "vitest";
import { addGainPoint, automationForExport, AUTOMATION_MAX_DB, AUTOMATION_MIN_DB, dbToFraction, fractionToDb, gainDbAt, hasAutomation, moveGainPoint, removeGainPoint } from "./audioAutomation";

describe("volume automation curve", () => {
  const pts = [
    { at: 10, db: -6 },
    { at: 12, db: 0 },
    { at: 14, db: -60 },
  ];

  it("is unity with no points", () => {
    expect(gainDbAt(undefined, 3)).toBe(0);
    expect(gainDbAt([], 3)).toBe(0);
  });

  it("holds flat beyond the ends and runs straight in dB between points", () => {
    expect(gainDbAt(pts, 0)).toBe(-6);
    expect(gainDbAt(pts, 11)).toBeCloseTo(-3, 9);
    expect(gainDbAt(pts, 13)).toBeCloseTo(-30, 9);
    expect(gainDbAt(pts, 99)).toBe(-60);
  });

  it("maps levels onto the lane and back", () => {
    expect(dbToFraction(AUTOMATION_MAX_DB)).toBeCloseTo(1, 9);
    expect(dbToFraction(AUTOMATION_MIN_DB)).toBe(0);
    expect(dbToFraction(0)).toBeGreaterThan(0.75);
    for (const db of [-40, -12, -3, 0, 4]) expect(fractionToDb(dbToFraction(db))).toBeCloseTo(db, 6);
  });

  it("keeps points in time order and never lets one pass a neighbour", () => {
    const { points, index } = addGainPoint(pts, 11, 3);
    expect(index).toBe(1);
    expect(points.map((p) => p.at)).toEqual([10, 11, 12, 14]);
    const moved = moveGainPoint(points, 1, 50, 99);
    expect(moved[1].at).toBeLessThan(12);
    expect(moved[1].db).toBe(AUTOMATION_MAX_DB);
    expect(removeGainPoint(points, 1)).toEqual(pts);
  });

  it("counts only a line that changes something", () => {
    expect(hasAutomation({ gain: [{ at: 1, db: 0 }] })).toBe(false);
    expect(hasAutomation({ gain: pts })).toBe(true);
  });
});

describe("automation for the export", () => {
  it("moves the points into the piece's own time and keeps one either side of what plays", () => {
    const gain = [
      { at: 1, db: -20 },
      { at: 5, db: -10 },
      { at: 12, db: 0 },
      { at: 20, db: -6 },
      { at: 30, db: 3 },
    ];
    // Plays the song from 10 s to 18 s.
    const out = automationForExport({ gain, trimStart: 10, startTime: 40, endTime: 48 });
    expect(out).toEqual([
      [-5, -10],
      [2, 0],
      [10, -6],
    ]);
  });

  it("is nothing when there's no ride", () => {
    expect(automationForExport({ gain: undefined, trimStart: 0, startTime: 0, endTime: 5 })).toBeNull();
    expect(automationForExport({ gain: [{ at: 1, db: 0 }], trimStart: 0, startTime: 0, endTime: 5 })).toBeNull();
  });
});
