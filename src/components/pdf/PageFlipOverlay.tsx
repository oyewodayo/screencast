// components/pdf/PageFlipOverlay.tsx
// Two-page ("book") mode's page-turn animation. PdfAnnotator swaps the real spread to the new
// pages immediately; this overlay sits on top of it for the duration of the turn and fakes the
// physical motion with snapshots, then unmounts to reveal the real (by then rendered) pages:
//
//   forward:  [ old left (cover) ][ leaf: front = old right, back = new left ]  over  new right (under)
//   backward: [ leaf: front = old left, back = new right ][ old right (cover) ]  over  new left (under)
//
// The leaf rotates 180° about the spine, so its back face lands exactly where the new page sits.
// Old pages are snapshotted from the live DOM (so they keep their ink); new pages come from the
// shared render cache (bitmap only - their ink appears when the overlay hands back to the real
// pages a moment later).
import React, { useEffect, useRef } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageRenderCache } from "../../hooks/usePageRenderCache";

export interface FlipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PageFlip {
  id: number;
  direction: 1 | -1;
  spineX: number; // relative to the overlay's positioned ancestor, same space as every rect here
  leaf: { canvas: HTMLCanvasElement; rect: FlipRect };
  cover: { canvas: HTMLCanvasElement; rect: FlipRect } | null;
  // Revealed underneath the leaf as it lifts.
  under: { pageIndex: number; rect: FlipRect } | null;
  // Shown on the leaf's back face once it passes 90°.
  backPageIndex: number | null;
}

const FLIP_DURATION_MS = 720;
const FLIP_EASING = "cubic-bezier(0.45, 0.05, 0.2, 1)";

const rectStyle = (r: FlipRect): React.CSSProperties => ({ position: "absolute", left: r.left, top: r.top, width: r.width, height: r.height });

// Mounts an existing canvas (a snapshot, or a cached page bitmap copy) into a host element,
// stretched to fill it.
const mountCanvas = (host: HTMLElement | null, canvas: HTMLCanvasElement): void => {
  if (!host) return;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.display = "block";
  host.replaceChildren(canvas);
};

const copyCanvas = (src: HTMLCanvasElement): HTMLCanvasElement => {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  out.getContext("2d")?.drawImage(src, 0, 0);
  return out;
};

const PageFlipOverlay: React.FC<{
  flip: PageFlip;
  pdfDoc: PDFDocumentProxy;
  cache: PageRenderCache;
  zoom: number;
  onDone: () => void;
}> = ({ flip, pdfDoc, cache, zoom, onDone }) => {
  const coverHostRef = useRef<HTMLDivElement>(null);
  const underHostRef = useRef<HTMLDivElement>(null);
  const leafRef = useRef<HTMLDivElement>(null);
  const frontHostRef = useRef<HTMLDivElement>(null);
  const backHostRef = useRef<HTMLDivElement>(null);
  const frontShadeRef = useRef<HTMLDivElement>(null);
  const backShadeRef = useRef<HTMLDivElement>(null);
  const underShadeRef = useRef<HTMLDivElement>(null);
  const coverShadeRef = useRef<HTMLDivElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    let cancelled = false;
    mountCanvas(frontHostRef.current, flip.leaf.canvas);
    if (flip.cover) mountCanvas(coverHostRef.current, flip.cover.canvas);

    // The render cache owns its canvases (they're blitted into real pages too), so mount copies.
    if (flip.under) {
      cache
        .getPage(pdfDoc, flip.under.pageIndex, zoom)
        .then(({ canvas }) => !cancelled && mountCanvas(underHostRef.current, copyCanvas(canvas)))
        .catch(() => {});
    }
    if (flip.backPageIndex !== null) {
      cache
        .getPage(pdfDoc, flip.backPageIndex, zoom)
        .then(({ canvas }) => !cancelled && mountCanvas(backHostRef.current, copyCanvas(canvas)))
        .catch(() => {});
    }

    const timing: KeyframeAnimationOptions = { duration: FLIP_DURATION_MS, easing: FLIP_EASING, fill: "forwards" };
    const end = flip.direction > 0 ? -180 : 180;
    const animations: Animation[] = [];
    const leaf = leafRef.current;
    if (leaf) {
      // The slight lift (translateZ) mid-turn is what sells it as paper rather than a rigid card.
      animations.push(
        leaf.animate(
          [
            { transform: "rotateY(0deg) translateZ(0px)" },
            { transform: `rotateY(${end / 2}deg) translateZ(24px)`, offset: 0.5 },
            { transform: `rotateY(${end}deg) translateZ(0px)` },
          ],
          timing
        )
      );
    }
    // Light falls off the leaf as it turns edge-on, then back on as it lands; the page being
    // uncovered and the page about to be covered each pick up the leaf's passing shadow.
    const pulse = (el: HTMLDivElement | null, keyframes: Keyframe[]): void => {
      if (el) animations.push(el.animate(keyframes, timing));
    };
    pulse(frontShadeRef.current, [{ opacity: 0 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0.55 }]);
    pulse(backShadeRef.current, [{ opacity: 0.55 }, { opacity: 0.55, offset: 0.5 }, { opacity: 0 }]);
    pulse(underShadeRef.current, [{ opacity: 0.9 }, { opacity: 0.35, offset: 0.55 }, { opacity: 0 }]);
    pulse(coverShadeRef.current, [{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 0.6, offset: 0.85 }, { opacity: 0 }]);

    const main = animations[0];
    if (main) main.onfinish = () => !cancelled && onDoneRef.current();
    else onDoneRef.current();

    return () => {
      cancelled = true;
      for (const a of animations) a.cancel();
    };
    // One overlay instance per flip (PdfAnnotator keys it by flip.id).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const forward = flip.direction > 0;
  // Spine side of a page, for gradients: the leaf's spine edge is its left edge going forward.
  const spineSide = forward ? "to right" : "to left";
  const awayFromSpine = forward ? "to left" : "to right";
  const leafRect = flip.leaf.rect;
  const originX = flip.spineX - leafRect.left;

  return (
    <div className="absolute inset-0 z-20 pointer-events-none overflow-hidden" style={{ perspective: 2400, perspectiveOrigin: `${flip.spineX}px 50%` }}>
      {flip.under && (
        <div style={rectStyle(flip.under.rect)} className="bg-white shadow-[0_12px_40px_rgba(0,0,0,0.14)]">
          <div ref={underHostRef} className="absolute inset-0" />
          <div
            ref={underShadeRef}
            className="absolute inset-0"
            style={{ opacity: 0.9, background: `linear-gradient(${spineSide}, rgba(0,0,0,0.35), rgba(0,0,0,0.08) 45%, transparent 80%)` }}
          />
        </div>
      )}
      {flip.cover && (
        <div style={rectStyle(flip.cover.rect)} className="bg-white shadow-[0_12px_40px_rgba(0,0,0,0.14)]">
          <div ref={coverHostRef} className="absolute inset-0" />
          <div
            ref={coverShadeRef}
            className="absolute inset-0"
            style={{ opacity: 0, background: `linear-gradient(${awayFromSpine}, rgba(0,0,0,0.3), transparent 70%)` }}
          />
        </div>
      )}
      <div ref={leafRef} style={{ ...rectStyle(leafRect), transformStyle: "preserve-3d", transformOrigin: `${originX}px 50%`, willChange: "transform" }}>
        <div className="absolute inset-0 bg-white" style={{ backfaceVisibility: "hidden", boxShadow: "0 12px 40px rgba(0,0,0,0.18)" }}>
          <div ref={frontHostRef} className="absolute inset-0" />
          {/* The curl's crease: a soft dark band along the spine edge plus an overall dimming. */}
          <div
            ref={frontShadeRef}
            className="absolute inset-0"
            style={{ opacity: 0, background: `linear-gradient(${spineSide}, rgba(0,0,0,0.45), rgba(0,0,0,0.12) 35%, rgba(0,0,0,0.25))` }}
          />
        </div>
        <div className="absolute inset-0 bg-white" style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)", boxShadow: "0 12px 40px rgba(0,0,0,0.18)" }}>
          <div ref={backHostRef} className="absolute inset-0" />
          <div
            ref={backShadeRef}
            className="absolute inset-0"
            style={{ opacity: 0.55, background: `linear-gradient(${awayFromSpine}, rgba(0,0,0,0.45), rgba(0,0,0,0.12) 35%, rgba(0,0,0,0.25))` }}
          />
        </div>
      </div>
    </div>
  );
};

export default PageFlipOverlay;
