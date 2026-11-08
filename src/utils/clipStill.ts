// utils/clipStill.ts
//
// Small 16:9 stills of a clip at a moment of its source - what the effect pickers' live tiles
// (TransitionGrid, EffectPreviewGrids) play their effects on, so a tile shows the user's own
// footage. Plus two drawn stand-in pictures for before a still is captured, or when it can't be.
import { convertFileSrc } from "@tauri-apps/api/core";
import { isImageClipPath } from "./videoEditTypes";
import { getPlayableUrl, isPictureless } from "./playableVideo";
import { resolveAssetUrl } from "./clipPreviewSource";

// Tile stills: 16:9, small - a tile is ~100px wide.
export const STILL_W = 256;
export const STILL_H = 144;

// Draws `source` (natural size sw x sh) to cover a STILL_W x STILL_H canvas, centre-cropped.
function coverStill(source: CanvasImageSource, sw: number, sh: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = STILL_W;
  canvas.height = STILL_H;
  const ctx = canvas.getContext("2d")!;
  const scale = Math.max(STILL_W / sw, STILL_H / sh);
  const w = sw * scale;
  const h = sh * scale;
  ctx.drawImage(source, (STILL_W - w) / 2, (STILL_H - h) / 2, w, h);
  return canvas.toDataURL("image/jpeg", 0.85);
}

const stillCache = new Map<string, Promise<string>>();

// A clip's picture at `time` (source seconds) as a tile-sized data URL.
export function clipStill(sourcePath: string, time: number): Promise<string> {
  const key = `${sourcePath}|${time.toFixed(2)}`;
  let pending = stillCache.get(key);
  if (pending) return pending;
  pending = isImageClipPath(sourcePath)
    ? resolveAssetUrl(sourcePath).then(
        (url) =>
          new Promise<string>((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(coverStill(img, img.naturalWidth, img.naturalHeight));
            img.onerror = () => reject(new Error("Couldn't load the image"));
            img.src = url;
          })
      )
    : new Promise<string>((resolve, reject) => {
        const video = document.createElement("video");
        video.muted = true;
        video.preload = "auto";
        video.crossOrigin = "anonymous";
        const timer = setTimeout(() => finish(new Error("Timed out")), 15000);
        const finish = (error?: Error, still?: string) => {
          clearTimeout(timer);
          video.removeAttribute("src");
          video.load();
          if (error) reject(error);
          else resolve(still!);
        };
        // A file the webview can't show is captured from its playable copy instead (once).
        let swapped = false;
        const usePlayableCopy = () => {
          if (swapped) return finish(new Error("Couldn't load the clip"));
          swapped = true;
          getPlayableUrl(sourcePath)
            .then((url) => {
              video.src = url;
            })
            .catch((err) => finish(err));
        };
        video.addEventListener("error", usePlayableCopy);
        video.addEventListener("loadedmetadata", () => {
          if (isPictureless(video)) return usePlayableCopy();
          video.currentTime = Math.max(0, Math.min(time, video.duration - 0.05));
        });
        video.addEventListener("seeked", () => {
          try {
            finish(undefined, coverStill(video, video.videoWidth, video.videoHeight));
          } catch (err) {
            finish(err as Error);
          }
        });
        video.src = convertFileSrc(sourcePath);
      });
  pending.catch(() => stillCache.delete(key));
  stillCache.set(key, pending);
  return pending;
}

// Stand-ins until the real frames arrive (or when there are none): a warm sunset, a cool night.
let placeholders: [string, string] | null = null;
export function placeholderStills(): [string, string] {
  if (placeholders) return placeholders;
  const paint = (sky: [string, string], sun: string, sunY: number, hills: string[]) => {
    const canvas = document.createElement("canvas");
    canvas.width = STILL_W;
    canvas.height = STILL_H;
    const ctx = canvas.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 0, STILL_H);
    g.addColorStop(0, sky[0]);
    g.addColorStop(1, sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, STILL_W, STILL_H);
    ctx.fillStyle = sun;
    ctx.beginPath();
    ctx.arc(STILL_W * 0.68, STILL_H * sunY, STILL_H * 0.16, 0, Math.PI * 2);
    ctx.fill();
    hills.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      const base = STILL_H * (0.62 + i * 0.13);
      ctx.moveTo(0, STILL_H);
      for (let x = 0; x <= STILL_W; x += 8) ctx.lineTo(x, base - Math.sin(x / (40 + i * 25) + i * 2) * STILL_H * 0.08);
      ctx.lineTo(STILL_W, STILL_H);
      ctx.fill();
    });
    return canvas.toDataURL("image/jpeg", 0.9);
  };
  placeholders = [
    paint(["#ff9a5a", "#ffd27a"], "#fff4d6", 0.42, ["#c2554a", "#7a2e3b"]),
    paint(["#0f2a5a", "#3d6fb6"], "#e8f1ff", 0.3, ["#1f4f7a", "#0b2340"]),
  ];
  return placeholders;
}
