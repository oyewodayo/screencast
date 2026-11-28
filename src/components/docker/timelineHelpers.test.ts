import { describe, expect, it } from "vitest";
import type { PipOverlay } from "../../utils/videoEditTypes";
import {
  SNAP_THRESHOLD_PX,
  formatClipLength,
  formatTimestamp,
  isFullFrameLayer,
  snapToTargets,
} from "./timelineHelpers";

describe("timelineHelpers", () => {
  describe("formatClipLength", () => {
    it("formats sub-10-second clips with one decimal place", () => {
      expect(formatClipLength(0)).toBe("0.0s");
      expect(formatClipLength(4.52)).toBe("4.5s");
      expect(formatClipLength(9.94)).toBe("9.9s");
    });

    it("formats 10–59 second clips as rounded whole seconds", () => {
      expect(formatClipLength(10)).toBe("10s");
      expect(formatClipLength(12.6)).toBe("13s");
      expect(formatClipLength(59.4)).toBe("59s");
    });

    it("formats minute-and-longer clips as m:ss", () => {
      expect(formatClipLength(60)).toBe("1:00");
      expect(formatClipLength(65)).toBe("1:05");
      expect(formatClipLength(125.4)).toBe("2:05");
    });
  });

  describe("formatTimestamp", () => {
    it("formats under-an-hour timestamps as m:ss", () => {
      expect(formatTimestamp(0)).toBe("0:00");
      expect(formatTimestamp(5.9)).toBe("0:05");
      expect(formatTimestamp(245)).toBe("4:05");
      expect(formatTimestamp(3599)).toBe("59:59");
    });

    it("formats hour-or-longer timestamps as h:mm:ss", () => {
      expect(formatTimestamp(3600)).toBe("1:00:00");
      expect(formatTimestamp(3845)).toBe("1:04:05");
      expect(formatTimestamp(36000)).toBe("10:00:00");
    });
  });

  describe("snapToTargets", () => {
    it("snaps to the nearest target strictly within SNAP_THRESHOLD_PX", () => {
      const pxPerSec = 40; // threshold = 8 / 40 = 0.2s
      expect(SNAP_THRESHOLD_PX / pxPerSec).toBeCloseTo(0.2);
      expect(snapToTargets(5.12, [2, 5, 8], pxPerSec)).toBe(5);
      expect(snapToTargets(5.25, [2, 5, 8], pxPerSec)).toBe(5.25);
    });

    it("picks the closest target when multiple targets are within threshold", () => {
      expect(snapToTargets(5.06, [5.0, 5.1], 40)).toBe(5.1);
      expect(snapToTargets(5.03, [5.1, 5.0], 40)).toBe(5.0);
    });
  });

  describe("isFullFrameLayer", () => {
    const baseOverlay = {
      id: "ov-1",
      sourcePath: "/tmp/broll.mp4",
      startTime: 0,
      endTime: 5,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    } as PipOverlay;

    it("returns true for overlays covering the whole frame", () => {
      expect(isFullFrameLayer(baseOverlay)).toBe(true);
      expect(isFullFrameLayer({ ...baseOverlay, x: 0.0005, y: 0.0005, width: 0.9995, height: 0.9995 })).toBe(true);
    });

    it("returns false for inset PiP overlays", () => {
      expect(isFullFrameLayer({ ...baseOverlay, x: 0.1, width: 0.4, height: 0.4 })).toBe(false);
    });
  });
});
