// utils/stage/stageImages.ts
//
// Pictures in Stage scenes (image elements: logos, product shots, screenshots), decoded once and
// shared by every renderer - the editor's canvas and the export's. A scene's pictures are loaded
// before it's compiled (stageLive.whenCompiled, stageExport), like its fonts, so a frame never draws
// a picture that isn't there yet. A local file goes through the asset protocol, with crossOrigin set
// - without it the picture would taint the canvas and WebGL would refuse it.
import { convertFileSrc } from "@tauri-apps/api/core";
import type { StageScene } from "./stageTypes";

export interface StageImage {
  source: HTMLImageElement;
  width: number;
  height: number;
}

const loaded = new Map<string, StageImage>();
const pending = new Map<string, Promise<StageImage | null>>();

// A URL the webview can load: a web/data/blob URL as it is, a file path through the asset protocol.
export function stageImageUrl(src: string): string {
  return /^(https?:|data:|blob:|asset:)/i.test(src) ? src : convertFileSrc(src);
}

export function stageImage(src: string | undefined): StageImage | undefined {
  return src ? loaded.get(src) : undefined;
}

export function loadStageImage(src: string): Promise<StageImage | null> {
  const ready = loaded.get(src);
  if (ready) return Promise.resolve(ready);
  let p = pending.get(src);
  if (!p) {
    p = new Promise<StageImage | null>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => {
        void img
          .decode()
          .catch(() => undefined)
          .then(() => {
            const out = { source: img, width: img.naturalWidth, height: img.naturalHeight };
            loaded.set(src, out);
            resolve(out);
          });
      };
      // A missing picture draws as its box's fill - the scene still plays and exports.
      img.onerror = () => resolve(null);
      img.src = stageImageUrl(src);
    }).finally(() => pending.delete(src));
    pending.set(src, p);
  }
  return p;
}

export async function loadStageImages(scene: StageScene): Promise<void> {
  await Promise.all(scene.elements.filter((e) => e.kind === "image" && e.image?.src).map((e) => loadStageImage(e.image!.src)));
}
