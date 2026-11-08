// components/video/ProjectPrepOverlay.tsx
//
// "Making your video" - shown the moment Create is clicked in the Create a video dialog, until the
// new project's photos are all ready to play. Before this, Create closed the dialog and nothing was
// on screen for a long time; then the editor opened while its photos were still being prepared, so
// the first play stalled and skipped the effects - which reads as "it doesn't work".
//
// Shaped like the editor it turns into: a player area with the first photo softly behind the
// progress, and a timeline of the picked photos in which each one lights up as it becomes ready to
// play - progress you can see, not just a spinner. The editor opens underneath while the photos are
// prepared, and this fades away only when they all are, so the first play is smooth. "Start editing
// now" lets anyone in a hurry go straight in; preparation carries on regardless.
//
// Progress comes from utils/projectPrep.ts, not props, so a per-photo update redraws only this.

import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getPrep, getWarm, isPrepReady, subscribePrep } from "../../utils/projectPrep";

interface ProjectPrepOverlayProps {
  // Everything's ready (after the fade) - or the user chose to start editing now.
  onFinished: () => void;
}

const FADE_MS = 280;
// The most tiles drawn; with more photos the strip shows the first ones (it's an impression of the
// timeline, and every tile has to stay wide enough to read as a photo).
const MAX_TILES = 48;

const ProjectPrepOverlay: React.FC<ProjectPrepOverlayProps> = ({ onFinished }) => {
  const prep = useSyncExternalStore(subscribePrep, getPrep);
  const warm = useSyncExternalStore(subscribePrep, getWarm);
  const [leaving, setLeaving] = useState(false);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  const ready = !!prep && isPrepReady(prep, warm);
  const leave = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => finishedRef.current(), FADE_MS);
  };
  useEffect(() => {
    if (ready) leave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!prep) return null;

  // Once the project is open, the step and count are the photos being made ready to play.
  const warming = !!prep.primaryPath && prep.expectedPhotos > 0;
  const warmMatches = !!warm && warm.primaryPath === prep.primaryPath;
  const done = warming ? (warmMatches ? Math.min(warm!.done, prep.expectedPhotos) : 0) : prep.done;
  const total = warming ? prep.expectedPhotos : prep.total;
  const step = ready ? "Ready" : warming ? "Getting your photos ready to play" : prep.step;
  const fraction = total > 0 ? done / total : null;
  const backdrop = prep.thumbs.find((t): t is string => !!t) ?? null;
  const tiles = prep.thumbs.slice(0, MAX_TILES);
  // A tile is lit once its photo is ready to play (approximately in order - preparation runs in
  // timeline order, two at a time).
  const lit = warming ? done : 0;

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-[#0b0b0c] text-white select-none"
      style={{ opacity: leaving ? 0 : 1, transition: `opacity ${FADE_MS}ms ease-out` }}
      role="status"
      aria-live="polite"
      aria-label={`Making your video: ${step}`}
    >
      <style>{`
        @keyframes prep-shimmer { 0% { background-position: -160% 0; } 100% { background-position: 260% 0; } }
        .prep-shimmer { background-image: linear-gradient(100deg, rgba(255,255,255,0) 30%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0) 70%); background-size: 60% 100%; background-repeat: no-repeat; animation: prep-shimmer 1.6s ease-in-out infinite; }
        @keyframes prep-indeterminate { 0% { transform: translateX(-100%); } 100% { transform: translateX(250%); } }
        .prep-indeterminate { animation: prep-indeterminate 1.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .prep-shimmer, .prep-indeterminate { animation: none; } }
      `}</style>

      {/* The player area: the first photo, softly behind the progress. A filter on a still image is
          drawn once - unlike backdrop-filter, which WebView2 re-blurs every frame under animation. */}
      <div className="relative flex-1 min-h-0 overflow-hidden flex items-center justify-center">
        {backdrop && (
          <img src={backdrop} alt="" draggable={false} className="absolute inset-0 w-full h-full object-cover scale-110 opacity-40" style={{ filter: "blur(28px)" }} />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/50 to-black/80" />

        <div className="relative w-[min(440px,88vw)] rounded-2xl bg-neutral-900/85 ring-1 ring-white/10 shadow-2xl px-7 py-6">
          <p className="text-[12px] uppercase tracking-[0.08em] text-white/50">Making your video</p>
          <h2 className="mt-1 text-[19px] font-semibold truncate" title={prep.name}>
            {prep.name}
          </h2>
          <div className="mt-5 flex items-baseline justify-between gap-3 text-[13.5px]">
            <span className="text-white/85 truncate">{step}</span>
            {total > 0 && !ready && (
              <span className="shrink-0 tabular-nums text-white/55">
                {done} of {total}
              </span>
            )}
          </div>
          <div className="mt-2.5 h-1.5 rounded-full bg-white/10 overflow-hidden">
            {fraction !== null || ready ? (
              <div className="h-full rounded-full bg-blue-500" style={{ width: `${ready ? 100 : Math.max(3, fraction! * 100)}%`, transition: "width 220ms ease-out" }} />
            ) : (
              <div className="prep-indeterminate h-full w-2/5 rounded-full bg-blue-500/80" />
            )}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[12px] leading-snug text-white/45">
              {warming ? "So every effect plays smoothly the first time." : "This only happens once - it's kept for next time."}
            </p>
            {prep.primaryPath && !ready && (
              <button
                type="button"
                onClick={leave}
                className="shrink-0 text-[12.5px] font-medium px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 active:bg-white/20 transition-colors"
              >
                Start editing now
              </button>
            )}
          </div>
        </div>
      </div>

      {/* The timeline, as it will be: one tile per photo, lit as each becomes ready to play. */}
      <div className="shrink-0 h-[118px] border-t border-white/[0.06] bg-[#111113] px-6 py-5">
        <div className="h-full flex gap-1.5 overflow-hidden">
          {tiles.map((thumb, i) => (
            <div key={i} className="relative h-full min-w-[44px] flex-1 max-w-[120px] rounded-md overflow-hidden bg-white/[0.06]">
              {thumb && (
                <img
                  src={thumb}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 w-full h-full object-cover"
                  style={{ opacity: i < lit || ready ? 1 : 0.32, transition: "opacity 260ms ease-out" }}
                />
              )}
              {!(i < lit || ready) && <div className="absolute inset-0 prep-shimmer" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ProjectPrepOverlay;
