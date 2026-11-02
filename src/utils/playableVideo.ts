// utils/playableVideo.ts
//
// Videos the webview can't show. Two kinds:
// - ones <video> refuses outright (.avi - no container support) - it fires "error";
// - ones it plays with no picture: iPhone/HEVC .MOV and .mp4 (no HEVC decoder in WebView2 without
//   a paid Store extension). Chromium silently drops the video track it can't decode and keeps
//   the audio, so there's no error at all - just sound over black, metadata loaded with a 0x0
//   frame. That's what isPictureless detects.
// Both get the same cure: get_playable_preview (conversion.rs) makes an H.264 copy once, cached
// on disk by path+mtime. getPlayableUrl shares one request per file across the player, the
// timeline filmstrip and inserted clips, which all hit the same file at the same moment.
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

// Metadata is in but there's no picture - the silent HEVC case above. (An audio-only file in a
// video container looks the same; converting it just fails and playback carries on as audio.)
export const isPictureless = (video: HTMLVideoElement): boolean => video.readyState >= 1 && video.videoWidth === 0 && video.videoHeight === 0;

const pending = new Map<string, Promise<string>>();

export const getPlayableUrl = (sourcePath: string): Promise<string> => {
  let p = pending.get(sourcePath);
  if (!p) {
    p = invoke<string>("get_playable_preview", { inputPath: sourcePath }).then((path) => convertFileSrc(path));
    p.catch(() => pending.delete(sourcePath)); // a later attempt may succeed (e.g. after a Convert)
    pending.set(sourcePath, p);
  }
  return p;
};
