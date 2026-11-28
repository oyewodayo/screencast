// Pure timeline layout constants, formatting, snapping, and session caches extracted from VideoTimelineDocker.tsx.
import type { PipOverlay } from "../../utils/videoEditTypes";
import type { ClipEffectBadge } from "../../utils/videoColorFilters";

// Clip effect badges (clipEffectBadges), coloured by kind.
export const BADGE_TONES: Record<ClipEffectBadge["tone"], string> = {
  look: "bg-amber-400/90 text-black",
  fx: "bg-fuchsia-500/90 text-white",
  motion: "bg-sky-500/90 text-white",
  time: "bg-orange-500/90 text-white",
  frame: "bg-black/75 text-teal-300",
  sound: "bg-red-600/90 text-white",
};

// A video-track layer covering the whole frame - B-roll rather than a picture-in-picture.
export const isFullFrameLayer = (o: PipOverlay) => o.x <= 0.001 && o.y <= 0.001 && o.width >= 0.999 && o.height >= 0.999;

export const MIN_PX_PER_SEC = 8;
export const AUDIO_ROW_HEIGHT = 32; // px - one row of the audio lane; overlapping audio stacks into more rows
export const AUTOMATION_ROW_HEIGHT = 112; // px - the row of a piece whose volume line is open
export const AUTOMATION_HEADER_PX = 16;
export const MAX_PX_PER_SEC = 200;
export const DEFAULT_PX_PER_SEC = 40;
export const THUMB_TILE_HEIGHT = 52; // px - filmstrip tile height inside the h-16 clip track
// Filmstrip frame cache density: one captured frame every FRAME_CACHE_STEP_SEC of source time,
// capped at MAX_CACHED_FRAMES (the step widens for long videos). Tiles pick their nearest cached
// frame, so this is what bounds how short a shot can be and still show up on the strip.
export const FRAME_CACHE_STEP_SEC = 0.5;
export const MAX_CACHED_FRAMES = 120;
export const THUMB_CAPTURE_HEIGHT = 80; // px - frames are downscaled at capture; tiles never draw larger
// On a long video those 120 are minutes apart, so the tiles in view also ask for their own frame
// (a frame inside each tile's own stretch of source) - kept up to this many, oldest dropped first.
export const MAX_DETAIL_FRAMES = 240;


export const NICE_TICK_INTERVALS = [1, 2, 3, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600]; // seconds
export const MIN_TICK_SPACING_PX = 70;
export const MIN_CLIP_LENGTH = 0.05;
export const MIN_OVERLAY_DURATION = 0.1; // matches videoEditHandlers.ts's own MIN_OVERLAY_DURATION

// The clip lane's look. A hairline gap between clips (half each side), and a trim handle's invisible
// grab area - wider than what's drawn, so grabbing an edge stays easy without a thick bar on every cut.
export const CLIP_GAP = 2;
export const HANDLE_GRAB_PX = 10;
// Handles show on the clip's hover, their own hover, or the selected clip (data-on) - and never while a
// clip is being dragged. A grip: a slim white pill. A bracket: the selected clip's yellow edge, with
// two notches to read as something to pull.
export const TIMELINE_LANE_CSS = `
.tl-lane .tl-h { opacity: 0; transition: opacity 120ms ease-out; }
.tl-lane .tl-clip:hover + .tl-h, .tl-lane .tl-clip:hover + .tl-h + .tl-h, .tl-lane .tl-h:hover, .tl-lane .tl-h[data-on="true"] { opacity: 1; }
.tl-lane.tl-lane-dragging .tl-h { opacity: 0 !important; }
.tl-grip { width: 3px; height: 45%; border-radius: 9999px; background: rgba(255,255,255,0.92); box-shadow: 0 0 0 1px rgba(0,0,0,0.35); }
.tl-h:hover .tl-grip { height: 60%; }
.tl-bracket { position: relative; width: 7px; height: 100%; background: #fbbf24; }
.tl-bracket-start { border-radius: 6px 0 0 6px; }
.tl-bracket-end { border-radius: 0 6px 6px 0; }
.tl-bracket::before, .tl-bracket::after { content: ""; position: absolute; left: 50%; width: 1px; height: 22%; background: rgba(0,0,0,0.55); transform: translateX(-50%); }
.tl-bracket::before { top: 28%; }
.tl-bracket::after { bottom: 28%; }
.tl-fade-knob { opacity: 0; transition: opacity 120ms ease-out, transform 120ms ease-out; }
.tl-fade-knob:hover { transform: scale(1.25); }
.tl-clip:hover .tl-fade-knob, .tl-fade-knob[data-on="true"] { opacity: 1; }
.tl-lane.tl-lane-dragging .tl-fade-knob { opacity: 0 !important; }
`;
// "4.5s", or "1:05" from a minute up - the selected clip's length on its corner.
export const formatClipLength = (seconds: number): string => {
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.round(seconds - m * 60)).padStart(2, "0")}`;
};
// How close (in on-screen pixels, not seconds - so the snap "feels" equally sticky regardless of
// zoom level) a dragged overlay edge/position needs to land next to a snap target before it's
// pulled onto it exactly. Applied to the RAW (pre-clamp) candidate value in every overlay drag/
// resize handler below, so a snap can never itself push a value out of its own valid bounds - the
// existing min/max clamp right after always runs on the (possibly snapped) result.
export const SNAP_THRESHOLD_PX = 8;

// Pulls `value` onto whichever entry in `targets` is within SNAP_THRESHOLD_PX of it, if any -
// otherwise returns `value` unchanged. Shared by every overlay drag/resize handler (text/image/
// blur/audio) so dragging or retiming any of them snaps to the same landmarks: the playhead and
// every clip boundary (see overlaySnapTargets below). Ties broken by whichever target is nearest,
// not by array order.
export function snapToTargets(value: number, targets: number[], pxPerSec: number): number {
  const thresholdSec = SNAP_THRESHOLD_PX / pxPerSec;
  let best = value;
  let bestDist = thresholdSec;
  for (const target of targets) {
    const dist = Math.abs(value - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = target;
    }
  }
  return best;
}
// Generous tolerance on the "still inside the tracked clip" check in the live-preview tracking
// effect below - seeking to an arbitrary time doesn't always land exactly there (keyframe-
// interval snapping, decoder rounding), so a strict [start,end) check evaluated on the very first
// tick after a seek could look like we'd already left the clip we just jumped to, and cascade
// straight past it to the *next* one - which is exactly what "played the first clip then skipped
// straight to the third" was: the seek to clip 2 landed a hair outside its stored [start,end), so
// that effect immediately advanced again before clip 2 ever got a chance to play. Also used by
// handleTransportPlayClick to decide "are we sitting at the very end of the sequence".
export const SEEK_TOLERANCE_SEC = 0.25;
// How close to a clip's end playback counts as having finished it - a little under a frame, so a
// file whose real length rounds a hair short of the clip's stored end still moves on.
export const CLIP_END_EPSILON_SEC = 0.05;
// The per-frame boundary check crosses within half a frame of the cut.
export const FRAME_BOUNDARY_SEC = 0.012;
// How far an audio overlay may drift from the picture while playing before it's re-seeked.
export const AUDIO_DRIFT_TOLERANCE_SEC = 0.3;
// After re-seeking an audio overlay, how long to let it rebuffer before judging its drift again -
// and the jump (a scrub, not drift) that's corrected even inside that window.
export const AUDIO_SEEK_SETTLE_MS = 1000;
export const AUDIO_JUMP_SEC = 1;

// Module-level (not a useRef) so it survives this component unmounting - which happens every time
// the tools/timeline panel is closed (BottomDocker swaps back to the recording docker) and
// reopened, not just when a different file is opened. A useRef here was the original bug: it
// reset to null on every one of those remounts, so the bootstrap effect below saw "never
// bootstrapped" and force-seeked back to clip 0 every single time the panel was reopened, even on
// a video that was already mid-playback - the "opening the timeline restarts the video" report.
// Keyed by file path so switching files still bootstraps normally; a small, session-lifetime
// cache (a few bytes per file ever opened) is an acceptable tradeoff for not needing to lift this
// state through Dashboard/BottomDocker just to keep it alive across the panel toggle.
export const bootstrappedClipIdByFile = new Map<string, string>();
// Called whenever a file is (re)opened for playback: the player starts over on the file's own
// picture (a project's blank canvas), so "already playing from its first clip" no longer holds and
// the timeline must put playback on the first clip again when it next mounts. Without this, a
// project opened a second time in a session played its black canvas under a full timeline.
export const forgetTimelineBootstrap = (path: string): void => {
  bootstrappedClipIdByFile.delete(path);
};

// Where the playhead was when this file's timeline last went away (the editor closed, or the video
// left for a linked document, a folder, home), so coming back with the editor open lands there
// rather than on the first clip. Kept with the player's saved position at that moment: if the
// video played on afterwards with the editor closed, that newer position wins and this is dropped.
export const leftAtByFile = new Map<string, { outputTime: number; playerAt: number | undefined }>();

// The track area's height, set by dragging the divider between the player and the timeline (the
// panel's top edge) - null is automatic: as tall as its lanes, up to TRACK_AUTO_MAX_PX, then it
// scrolls. Kept across launches.
export const TRACK_HEIGHT_KEY = "briefcast.timelineTrackHeight.v1";
export const TRACK_AUTO_MAX_PX = 236;
// The track-button column's own height (eye, lock, sound, play, more, cover): the column is
// pinned beside the lanes rather than in the row's flow, so the lanes alone set the row's height
// - a measured, stretching column used to fight the divider - and never go shorter than it.
export const TRACK_MIN_PX = 168;
// The picture keeps at least this much of the window above the timeline.
export const PLAYER_MIN_PX = 240;
export const readTrackHeight = (): number | null => {
  try {
    const v = Number(localStorage.getItem(TRACK_HEIGHT_KEY));
    return Number.isFinite(v) && v >= TRACK_MIN_PX ? v : null;
  } catch {
    return null;
  }
};
export const saveTrackHeight = (h: number | null) => {
  try {
    if (h === null) localStorage.removeItem(TRACK_HEIGHT_KEY);
    else localStorage.setItem(TRACK_HEIGHT_KEY, String(Math.round(h)));
  } catch {
    /* preference only */
  }
};

// "4:05", or "1:04:05" past the hour - a timeline can run for a day or more.
export const formatTimestamp = (totalSeconds: number): string => {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return hours > 0 ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}` : `${minutes}:${seconds.toString().padStart(2, "0")}`;
};

