import { useCallback, useEffect, useRef } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getFileExtension } from "../utils/fileCategory";
import { resolveClipPreviewUrl } from "../utils/clipPreviewSource";
import { isImageClipPath, isVideoProjectPath, type VideoProjectFrame } from "../utils/videoEditTypes";

interface UseMediaAssetResolversOptions {
  canvas: { width: number; height: number } | null | undefined;
  canvasBlur: boolean;
}

/**
 * Memoized, cached URL/proxy/thumbnail resolvers for images, HEIC previews, videos, video project
 * canvases, and timeline image-clip proxies. Keeps asset-URL resolution stable across Dashboard
 * state updates so gallery tiles never re-fetch on selection clicks, and invalidates cached video
 * thumbnails when the user sets a custom poster frame.
 */
export function useMediaAssetResolvers({ canvas, canvasBlur }: UseMediaAssetResolversOptions) {
  const previewAssetUrlCacheRef = useRef<Map<string, string>>(new Map());
  const timelineFrameCacheRef = useRef<Map<string, Promise<VideoProjectFrame | null>>>(new Map());

  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const canvasBlurRef = useRef(canvasBlur);
  canvasBlurRef.current = canvasBlur;

  const resolvePreviewAssetUrl = useCallback(async (sourcePath: string, bypassCache = false): Promise<string> => {
    if (!bypassCache) {
      const cached = previewAssetUrlCacheRef.current.get(sourcePath);
      if (cached) return cached;
    }
    const absolutePath = await invoke<string>("convert_file_path_to_url", { filepath: sourcePath });
    const url = convertFileSrc(absolutePath) + (bypassCache ? `?t=${Date.now()}` : "");
    previewAssetUrlCacheRef.current.set(sourcePath, url);
    return url;
  }, []);

  const resolveTimelineFrame = useCallback((primaryPath: string): Promise<VideoProjectFrame | null> => {
    const activeCanvas = canvasRef.current;
    if (activeCanvas) return Promise.resolve({ width: activeCanvas.width, height: activeCanvas.height });
    let pending = timelineFrameCacheRef.current.get(primaryPath);
    if (!pending) {
      pending = (
        isVideoProjectPath(primaryPath)
          ? invoke<VideoProjectFrame>("read_video_project", { projectPath: primaryPath })
          : invoke<Record<string, string>>("get_conversion_info", { inputPath: primaryPath }).then((info) => {
              const match = info.resolution?.match(/^(\d+)x(\d+)$/);
              return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
            })
      ).catch((error) => {
        console.error("Failed to read timeline frame size for", primaryPath, error);
        timelineFrameCacheRef.current.delete(primaryPath);
        return null;
      });
      timelineFrameCacheRef.current.set(primaryPath, pending);
    }
    return pending;
  }, []);

  const resolveImageClipProxyUrl = useCallback(
    async (imagePath: string, primaryPath: string): Promise<string> =>
      resolveClipPreviewUrl(imagePath, await resolveTimelineFrame(primaryPath), canvasBlurRef.current ? "blur" : null),
    [resolveTimelineFrame]
  );

  const resolveProjectCanvasUrl = useCallback(
    async (projectPath: string): Promise<string> => {
      const frame = await resolveTimelineFrame(projectPath);
      if (!frame) throw new Error("This video project couldn't be read");
      const canvasPath = await invoke<string>("get_video_canvas_proxy", { width: frame.width, height: frame.height });
      return resolvePreviewAssetUrl(canvasPath);
    },
    [resolveTimelineFrame, resolvePreviewAssetUrl]
  );

  const resolveImageDisplayUrl = useCallback(
    async (file: { name: string; path: string }): Promise<string> => {
      if (!["heic", "heif"].includes(getFileExtension(file.name))) return resolvePreviewAssetUrl(file.path);
      const previewPath = await invoke<string>("get_heic_preview", { inputPath: file.path });
      return resolvePreviewAssetUrl(previewPath);
    },
    [resolvePreviewAssetUrl]
  );

  const resolveImageThumbnailUrl = useCallback(
    async (file: { name: string; path: string }): Promise<string> => {
      const thumbPath = await invoke<string>("get_image_thumbnail", { inputPath: file.path });
      return resolvePreviewAssetUrl(thumbPath);
    },
    [resolvePreviewAssetUrl]
  );

  const resolveVideoThumbnailUrl = useCallback(
    async (file: { name: string; path: string }, bypassCache = false): Promise<string> => {
      let videoPath = file.path;
      if (isVideoProjectPath(file.path)) {
        const json = await invoke<string | null>("load_video_edit_state", { videoPath: file.path });
        const firstClipPath: unknown = json ? JSON.parse(json)?.clips?.[0]?.sourcePath : undefined;
        if (typeof firstClipPath !== "string") throw new Error("Empty video project - nothing to thumbnail");
        if (isImageClipPath(firstClipPath)) return resolveImageThumbnailUrl({ name: firstClipPath, path: firstClipPath });
        videoPath = firstClipPath;
      }
      const thumbPath = await invoke<string>("get_video_thumbnail", { inputPath: videoPath });
      return resolvePreviewAssetUrl(thumbPath, bypassCache);
    },
    [resolvePreviewAssetUrl, resolveImageThumbnailUrl]
  );

  // Invalidate cached video thumbnail URL when the user sets a new custom poster frame.
  useEffect(() => {
    const unlistenPromise = listen<string>("video-thumbnail-updated", (event) => {
      invoke<string>("get_video_thumbnail", { inputPath: event.payload })
        .then((thumbPath) => previewAssetUrlCacheRef.current.delete(thumbPath))
        .catch((err) => console.error("Failed to invalidate thumbnail cache:", err));
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return {
    resolvePreviewAssetUrl,
    resolveTimelineFrame,
    resolveImageClipProxyUrl,
    resolveProjectCanvasUrl,
    resolveImageDisplayUrl,
    resolveImageThumbnailUrl,
    resolveVideoThumbnailUrl,
  };
}
