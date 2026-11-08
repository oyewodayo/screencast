// utils/screenPolish.ts
//
// The screen-recording polish an export carries (the Screen Style panel): the frame around the
// video (screenStyle.ts), the editor-drawn pointer of each clip (pointerTrack.ts) and the
// keyboard-shortcut chips (keystrokes.ts) - gathered from the timeline into what
// export_trimmed_video takes. The preview draws the same things from the same modules.
import { invoke } from "@tauri-apps/api/core";
import type { Clip, KeepSegment, VideoEditState } from "./videoEditTypes";
import { hasPointerPath, loadPointerRecording, pointerExportLayers, pointerStyleOf, type PointerRecording } from "./pointerTrack";
import { buildKeyChips, keystrokeExportLayer, keystrokeStyleOf } from "./keystrokes";
import { screenStyleForExport } from "./screenStyle";
import { clipOutputDuration } from "./clipTiming";

// Every distinct source's recording (null when it has no pointer/shortcut sidecar).
export async function loadClipRecordings(clips: Clip[]): Promise<Map<string, PointerRecording | null>> {
  const paths = [...new Set(clips.map((c) => c.sourcePath))];
  const recs = await Promise.all(paths.map((p) => loadPointerRecording(p)));
  return new Map(paths.map((p, i) => [p, recs[i]]));
}

// A video file's pixel size, probed once.
const sizes = new Map<string, Promise<{ width: number; height: number } | null>>();
export function sourcePixelSize(path: string): Promise<{ width: number; height: number } | null> {
  let p = sizes.get(path);
  if (!p) {
    p = invoke<Record<string, string>>("get_conversion_info", { inputPath: path })
      .then((info) => {
        const m = /^(\d+)x(\d+)$/.exec(info.resolution ?? "");
        return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
      })
      .catch(() => null);
    sizes.set(path, p);
  }
  return p;
}

// Each segment's pointer layers (segments[i] is clips[i]), for clips of recordings whose pointer the
// editor draws.
export async function withPointerLayers(segments: KeepSegment[], clips: Clip[], state: VideoEditState, recordings: Map<string, PointerRecording | null>): Promise<KeepSegment[]> {
  const style = pointerStyleOf(state.pointerStyle);
  if (!style.show) return segments;
  return Promise.all(
    segments.map(async (segment, i) => {
      const clip = clips[i];
      const rec = clip ? recordings.get(clip.sourcePath) : null;
      if (!clip || !hasPointerPath(rec)) return segment;
      const size = await sourcePixelSize(clip.sourcePath);
      if (!size) return segment;
      // A transition out of this clip plays on past its end (export's tail handle) - covered too.
      const next = clips[i + 1]?.transitionIn;
      const tail = next ? next.duration * 4 + 0.5 : 0;
      const layers = pointerExportLayers(rec, style, { start: clip.start, end: clip.end + tail, mirrored: !!clip.flipHorizontal }, size.width);
      return layers.length > 0 ? { ...segment, pointerLayers: layers } : segment;
    })
  );
}

// The keystroke chips as one sprite track over the final frame, or null.
export function keystrokesForExport(state: VideoEditState, recordings: Map<string, PointerRecording | null>, frame: { width: number; height: number }) {
  const style = keystrokeStyleOf(state.keystrokeStyle);
  if (!style.show) return null;
  const chips = buildKeyChips(state.clips, recordings);
  const total = state.clips.reduce((s, c) => s + clipOutputDuration(c), 0);
  return keystrokeExportLayer(chips, frame.width, frame.height, style, total);
}

// The frame around the edited picture, at the final frame's size, or null.
export async function screenStyleExport(state: VideoEditState, frame: { width: number; height: number } | null) {
  return state.screenStyle && frame ? screenStyleForExport(state.screenStyle, frame.width, frame.height) : null;
}
