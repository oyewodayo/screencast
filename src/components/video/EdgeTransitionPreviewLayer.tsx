// components/video/EdgeTransitionPreviewLayer.tsx
//
// Live preview of the video's intro and outro (EdgeTransitions, videoEditTypes.ts): a transition in
// from black over its first seconds and out to black over its last. Drawn by the same
// renderTransitionFrame as a cut between clips (TransitionPreviewLayer), with black standing in for
// the other picture - exactly as export draws them (edge_transition_graph, conversion.rs):
//
// - Intro: the outgoing picture is black, animated out over the player.
// - Outro: the outgoing picture is the player's own, copied into a canvas each frame (its effect,
//   grade and CSS look included - paintPlayerPicture), animated out over black.
//
// Progress comes from the timeline's exact output time every animation frame, written straight to
// the DOM - no React state per frame. Outside the two windows the layer is hidden and costs one
// time read per frame.
import React, { useEffect, useRef } from "react";
import { FrameRect } from "../../utils/videoFrameRect";
import { EdgeTransitions, TransitionLook, edgeTransitionWindows } from "../../utils/videoEditTypes";
import { renderTransitionFrame } from "./transitionFrame";
import { isCanvasTransition } from "./transitionCanvas";
import { framePictureContext, paintPlayerPicture } from "./TransitionPreviewLayer";

interface EdgeTransitionPreviewLayerProps {
  frameRect: FrameRect;
  edges: EdgeTransitions;
  // The timeline's length in output seconds.
  totalDuration: number;
  // The playhead in output seconds, frame-exact (Dashboard's getExactOutputTime); null while unknown.
  getOutputTime: () => number | null;
  getVideoElement: () => HTMLVideoElement | null;
}

// Which edge is playing at output time `t`, and how far through it (0..1).
export function edgeAt(edges: EdgeTransitions, total: number, t: number): { edge: "intro" | "outro"; p: number } | null {
  const { intro, outro } = edgeTransitionWindows(edges, total);
  if (intro !== null && t < intro) return { edge: "intro", p: Math.max(0, t / intro) };
  if (outro !== null && t >= total - outro) return { edge: "outro", p: Math.min(1, (t - (total - outro)) / outro) };
  return null;
}

const EdgeTransitionPreviewLayer: React.FC<EdgeTransitionPreviewLayerProps> = ({ frameRect, edges, totalDuration, getOutputTime, getVideoElement }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const moverRef = useRef<HTMLDivElement>(null);
  // Inside the mover: black (intro) or the player's live copy (outro).
  const moverBlackRef = useRef<HTMLDivElement>(null);
  const liveCanvasRef = useRef<HTMLCanvasElement>(null);
  // Under the mover: black - the outro's incoming picture.
  const underRef = useRef<HTMLDivElement>(null);
  const blackRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const pixelCanvasRef = useRef<HTMLCanvasElement>(null);
  const fxCanvasRef = useRef<HTMLCanvasElement>(null);
  // Frame-sized pictures for the transitions that move both (transitionCanvas.ts).
  const playerPicRef = useRef<HTMLCanvasElement | null>(null);
  const blackPicRef = useRef<HTMLCanvasElement | null>(null);

  const containerW = frameRect.width + 2 * frameRect.left;
  const containerH = frameRect.height + 2 * frameRect.top;
  const active = !!(edges.intro || edges.outro);

  useEffect(() => {
    const root = rootRef.current;
    const mover = moverRef.current;
    const moverBlack = moverBlackRef.current;
    const live = liveCanvasRef.current;
    const under = underRef.current;
    const black = blackRef.current;
    const glow = glowRef.current;
    if (!active || !root || !mover || !moverBlack || !live || !under || !black || !glow) return;
    const geometry = { L: frameRect.left, T: frameRect.top, W: frameRect.width, H: frameRect.height, containerW, containerH };
    const dpr = () => window.devicePixelRatio || 1;
    let shown = false;
    const show = (visible: boolean) => {
      if (visible === shown) return;
      shown = visible;
      root.style.display = visible ? "" : "none";
    };
    // The player's picture as shown, into `canvas` - false when there's no frame to copy yet.
    const copyPlayer = (canvas: HTMLCanvasElement): boolean => {
      const video = getVideoElement();
      const ctx = framePictureContext(canvas, frameRect.width, frameRect.height, dpr());
      if (!video || !ctx || video.readyState < 2) return false;
      paintPlayerPicture(ctx, video, root, frameRect);
      return true;
    };
    const blackPicture = () => {
      blackPicRef.current ??= document.createElement("canvas");
      framePictureContext(blackPicRef.current, frameRect.width, frameRect.height, dpr());
      return blackPicRef.current;
    };

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const t = getOutputTime();
      const at = t === null ? null : edgeAt(edges, totalDuration, t);
      const transition = at ? edges[at.edge] : undefined;
      if (!at || !transition) return show(false);
      const outro = at.edge === "outro";
      // Outro: the player's picture leaves over black; intro: black leaves over the player.
      moverBlack.style.display = outro ? "none" : "";
      live.style.display = outro ? "" : "none";
      under.style.display = outro ? "" : "none";
      if (outro && !copyPlayer(live)) return show(false);
      const look: TransitionLook = transition.look ?? {};
      const pictures = isCanvasTransition(transition.type)
        ? () => {
            playerPicRef.current ??= document.createElement("canvas");
            const player = outro ? live : copyPlayer(playerPicRef.current) ? playerPicRef.current : null;
            if (!player) return null;
            return outro ? { old: player, next: blackPicture() } : { old: blackPicture(), next: player };
          }
        : undefined;
      show(true);
      renderTransitionFrame(
        transition.type,
        look,
        at.p,
        { mover, black, glow, pixel: pixelCanvasRef.current, fx: fxCanvasRef.current, source: outro ? live : blackPicture(), pictures },
        geometry
      );
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, edges, totalDuration, frameRect.left, frameRect.top, frameRect.width, frameRect.height, containerW, containerH, getOutputTime, getVideoElement]);

  if (!active) return null;
  const { left: L, top: T, width: W, height: H } = frameRect;
  return (
    <div
      ref={rootRef}
      className="absolute pointer-events-none"
      // The player's whole <video> box, clipped to the picture - the export frame.
      style={{ left: -L, top: -T, width: containerW, height: containerH, display: "none", clipPath: `inset(${T}px ${L}px ${T}px ${L}px)` }}
    >
      <div ref={underRef} className="absolute bg-black" style={{ left: L, top: T, width: W, height: H, display: "none" }} />
      <div ref={moverRef} className="absolute inset-0">
        <div ref={moverBlackRef} className="absolute bg-black" style={{ left: L, top: T, width: W, height: H }} />
        <canvas ref={liveCanvasRef} className="absolute" style={{ left: L, top: T, width: W, height: H, display: "none" }} />
        <canvas ref={pixelCanvasRef} className="absolute" style={{ left: L, top: T, width: W, height: H, imageRendering: "pixelated", display: "none" }} />
      </div>
      <div ref={blackRef} className="absolute bg-black" style={{ left: L, top: T, width: W, height: H, opacity: 0 }} />
      <div ref={glowRef} className="absolute" style={{ left: L, top: T, width: W, height: H, opacity: 0, mixBlendMode: "screen" }} />
      <canvas ref={fxCanvasRef} className="absolute" style={{ left: L, top: T, width: W, height: H, display: "none" }} />
    </div>
  );
};

export default EdgeTransitionPreviewLayer;
