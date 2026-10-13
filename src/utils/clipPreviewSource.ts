// utils/clipPreviewSource.ts
//
// The one answer to "what does the preview player load for this clip's source file" - shared by
// the main player's cross-clip seeks (Dashboard's handleSeekActiveFile), the transition preview's
// frozen outgoing frame (TransitionPreviewLayer) and the clip viewer popup (ClipViewerModal), so
// all three always show exactly the same picture for the same clip:
//   - a video plays from its own file (asset URL);
//   - an image plays from its still-video proxy, already letterboxed into the timeline's frame
//     (see get_image_clip_proxy, conversion.rs, for why images preview as video).
// Cached as promises per source+frame, so concurrent callers share one proxy encode.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { VideoProjectFrame, isImageClipPath } from "./videoEditTypes";

// Used when the timeline's frame size can't be read - the same fallback export uses for an image
// timeline with no known size (export_trimmed_video).
export const FALLBACK_PREVIEW_FRAME: VideoProjectFrame = { width: 1920, height: 1080 };

const assetUrlCache = new Map<string, Promise<string>>();
const proxyUrlCache = new Map<string, Promise<string>>();

function cached(cache: Map<string, Promise<string>>, key: string, load: () => Promise<string>): Promise<string> {
  let pending = cache.get(key);
  if (!pending) {
    pending = load();
    pending.catch(() => cache.delete(key)); // a failure isn't remembered - the next ask retries
    cache.set(key, pending);
  }
  return pending;
}

// Plain asset URL for any file on disk.
export function resolveAssetUrl(path: string): Promise<string> {
  return cached(assetUrlCache, path, async () => convertFileSrc(await invoke<string>("convert_file_path_to_url", { filepath: path })));
}

export function resolveClipPreviewUrl(sourcePath: string, frame: VideoProjectFrame | null): Promise<string> {
  if (!isImageClipPath(sourcePath)) return resolveAssetUrl(sourcePath);
  const { width, height } = frame ?? FALLBACK_PREVIEW_FRAME;
  return cached(proxyUrlCache, `${sourcePath}|${width}x${height}`, async () => {
    const proxyPath = await invoke<string>("get_image_clip_proxy", { imagePath: sourcePath, frameWidth: width, frameHeight: height });
    return resolveAssetUrl(proxyPath);
  });
}
