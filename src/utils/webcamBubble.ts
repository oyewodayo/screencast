// utils/webcamBubble.ts
//
// Where a webcam bubble sits in a screen recording that baked it in - so its background can be
// fixed afterwards (the person cut out of just that part of the picture, with a new background
// behind them inside the bubble).
//
// New recordings save how the bubble was set up (<name>.bubble.json, recording.rs
// write_bubble_sidecar); bubbleRegion recomputes its box from that with the very maths the recorder
// placed it with (overlay_pixel_dimensions / border_px / overlay_position_expr), as fractions of the
// frame - so it holds at any size the recording was scaled to. Older recordings start from where a
// default bubble would be, and the user fits the outline to theirs.
import { invoke } from "@tauri-apps/api/core";
import type { PipShape } from "./videoEditTypes";

export interface BubbleSettings {
  shape: string;
  position: string;
  size: string;
  border: string;
  cameraCount: number;
}

// The camera picture inside the bubble (border excluded), in fractions of the frame, and its shape.
export interface BubbleRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  shape: PipShape;
  // "rounded": the corner radius as a fraction of the box's height.
  cornerRadius?: number;
}

const even = (v: number) => Math.max(2, Math.trunc(Math.round(v) / 2) * 2);

const BUBBLE_FRACTION: Record<string, number> = { xs: 0.1, small: 0.14, medium: 0.18, large: 0.24, xl: 0.3 };

function borderPx(border: string, w: number): number {
  switch (border) {
    case "thin":
      return even(Math.max(w * 0.003, 2));
    case "medium":
      return even(Math.max(w * 0.006, 4));
    case "thick":
      return even(Math.max(w * 0.011, 6));
    default:
      return 0;
  }
}

// The `index`th camera's picture box in a W x H recording.
export function bubbleRegion(s: BubbleSettings, W: number, H: number, index = 0): BubbleRegion {
  const side = even(W * (BUBBLE_FRACTION[s.size] ?? 0.14));
  const shaped = s.shape === "circle" || s.shape === "rounded";
  const [pw, ph] = shaped ? [side, side] : [side, even((side * 3) / 4)];
  const border = borderPx(s.border, W);
  const [bw, bh] = [pw + 2 * border, ph + 2 * border];
  const margin = even(W * 0.025);
  const gap = even(W * 0.012);
  const count = Math.max(1, s.cameraCount || 1);
  const step = index * (bw + gap);
  const anchors: Record<string, [string, string]> = {
    top_left: ["left", "top"],
    top_center: ["center", "top"],
    top_right: ["right", "top"],
    center_left: ["left", "middle"],
    center: ["center", "middle"],
    center_right: ["right", "middle"],
    bottom_left: ["left", "bottom"],
    bottom_center: ["center", "bottom"],
  };
  const [hx, vy] = anchors[s.position] ?? ["right", "bottom"];
  const total = count * bw + (count - 1) * gap;
  // ffmpeg's overlay rounds its position expressions down.
  const x = hx === "left" ? margin + step : hx === "center" ? Math.floor((W - total) / 2) + step : W - bw - margin - step;
  const y = vy === "top" ? margin : vy === "middle" ? Math.floor((H - bh) / 2) : H - bh - margin;
  const shape: PipShape = s.shape === "circle" ? "circle" : s.shape === "rounded" ? "rounded" : "rectangle";
  return {
    x: (x + border) / W,
    y: (y + border) / H,
    width: pw / W,
    height: ph / H,
    shape,
    ...(shape === "rounded" ? { cornerRadius: Math.max(4, Math.trunc(pw / 8)) / ph } : {}),
  };
}

// Where a default bubble (small circle, bottom right) would be - the starting outline for a
// recording that didn't save its own.
export const defaultBubbleRegion = (W: number, H: number): BubbleRegion =>
  bubbleRegion({ shape: "circle", position: "bottom_right", size: "small", border: "none", cameraCount: 1 }, W, H);

export async function loadBubbleSettings(videoPath: string): Promise<BubbleSettings | null> {
  try {
    const json = await invoke<string | null>("load_bubble_sidecar", { videoPath });
    return json ? (JSON.parse(json) as BubbleSettings) : null;
  } catch {
    return null;
  }
}
