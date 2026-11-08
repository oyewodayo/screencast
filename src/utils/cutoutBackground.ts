// utils/cutoutBackground.ts
//
// What shows behind a person cut out of a video (PipOverlay.cutout): nothing (see-through - the
// screen behind a separately recorded webcam), the original picture blurred (a bokeh look), a solid
// colour, or a picture. It's drawn inside the layer, under the person, so the layer's shape, mask
// and border cut both together.
//
// The preview and export draw it the same way: the blurred original is fitted to the box made
// `blurMargin` larger on every side, blurred by `blurSigma`, and shown through the box - so its edges
// stay full rather than fading out - and a picture covers the box (cover fit, centred).
import { invoke } from "@tauri-apps/api/core";
import type { ClipCrop } from "./videoEditTypes";
import type { CameraBackgroundPref } from "./appSettings";

export type CutoutBackground = { kind: "blur"; amount: number } | { kind: "color"; color: string } | { kind: "image"; path: string };

export const BLUR_DEFAULT = 0.5;

// Swatches offered first - studio greys, brand-ish colours and soft gradients' end colours.
export const BACKGROUND_SWATCHES = ["#0f172a", "#f8fafc", "#e2e8f0", "#1e3a8a", "#0e7490", "#047857", "#7c3aed", "#be185d", "#f59e0b", "#00b140"];

// The blur's Gaussian sigma for a box `heightPx` tall: `amount` (0..1) of 6% of the box's height.
export const blurSigma = (amount: number, heightPx: number): number => Math.max(0, Math.min(1, amount)) * 0.06 * heightPx;

// How far past the box the blurred picture reaches on every side - three sigmas, past which a
// Gaussian has nothing left to pull in.
export const blurMargin = (sigma: number): number => Math.ceil(3 * sigma);

// Where to draw `src` (its own srcW x srcH, the `crop` part of it) so it covers a w x h box -
// centred, scaled up as little as possible.
export function coverRect(w: number, h: number, srcW: number, srcH: number, crop?: ClipCrop) {
  const c = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const cw = c.width * srcW;
  const ch = c.height * srcH;
  const scale = Math.max(w / cw, h / ch);
  return { scale, left: (w - cw * scale) / 2 - c.x * srcW * scale, top: (h - ch * scale) / 2 - c.y * srcH * scale, width: srcW * scale, height: srcH * scale };
}

// The live camera background the user records with, as a cut-out background - so a separately
// recorded webcam gets the same look in the editor. None for "off" (or a picture not picked yet).
export function cutoutBackgroundFromPref(pref: CameraBackgroundPref | undefined): CutoutBackground | undefined {
  if (!pref || pref.kind === "off") return undefined;
  if (pref.kind === "blur") return { kind: "blur", amount: pref.amount };
  if (pref.kind === "color") return { kind: "color", color: pref.color };
  return pref.imagePath ? { kind: "image", path: pref.imagePath } : undefined;
}

// What export_trimmed_video takes (CutoutBackgroundSpec, conversion.rs) for a box of wPx x hPx
// output pixels; `sourceCrop` is the part of the source the blurred original shows.
export async function cutoutBackgroundForExport(bg: CutoutBackground | undefined, wPx: number, hPx: number, sourceCrop: ClipCrop | undefined) {
  if (!bg) return null;
  if (bg.kind === "color") return { kind: "color", color: bg.color };
  if (bg.kind === "blur") {
    const sigma = blurSigma(bg.amount, hPx);
    return { kind: "blur", blurSigma: sigma, blurMargin: blurMargin(sigma), sourceCrop: sourceCrop ?? null };
  }
  const image = await renderCoverPicture(bg.path, wPx, hPx);
  return image ? { kind: "image", imageBase64: image } : null;
}

// The picture cover-fitted to the box, as a PNG data URL - what the preview's object-fit: cover
// shows. Read as a data URL (read_image_data_url) so the canvas isn't tainted.
async function renderCoverPicture(path: string, w: number, h: number): Promise<string | null> {
  try {
    const dataUrl = await invoke<string>("read_image_data_url", { path });
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("unreadable picture"));
      img.src = dataUrl;
    });
    const c = document.createElement("canvas");
    c.width = Math.max(2, Math.round(w));
    c.height = Math.max(2, Math.round(h));
    const r = coverRect(c.width, c.height, img.naturalWidth, img.naturalHeight);
    c.getContext("2d")!.drawImage(img, r.left, r.top, r.width, r.height);
    return c.toDataURL("image/png");
  } catch (err) {
    console.error("Couldn't prepare the background picture for export:", err);
    return null;
  }
}
