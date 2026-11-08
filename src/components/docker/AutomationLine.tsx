// components/docker/AutomationLine.tsx
//
// An audio piece's volume automation drawn over its waveform on the timeline (audioAutomation.ts).
// At rest it's a thin amber line, just to show the ride is there. Opened for editing (the row grows
// to give it room) it becomes the surface you draw on, the way a DAW's automation lane works:
//
//   click on (or right by) the line         adds a point there, already held to drag - a click
//                                          away from the line does nothing, so a stray click
//                                          never bends it
//   drag a point                           moves it in time and level, never past its neighbours;
//                                          Shift holds its time and moves only the level
//   double-click / Alt-click a point       removes it
//
// The level under the pointer is read out in dB while dragging, and a dashed line marks unity
// (0 dB). Edits stay local while the pointer is down and are committed once on release - one undo
// step per gesture, and the 5,000-line timeline above doesn't re-render on every pixel.
import React, { useEffect, useRef, useState } from "react";
import { AudioOverlay } from "../../utils/videoEditTypes";
import { addGainPoint, dbToFraction, fractionToDb, gainDbAt, moveGainPoint, removeGainPoint, type GainPoint } from "../../utils/audioAutomation";

const POINT_HIT_PX = 7;
// How close to the line a click has to land to add a point.
const LINE_HIT_PX = 10;

interface AutomationLineProps {
  overlay: AudioOverlay;
  widthPx: number;
  heightPx: number;
  pxPerSec: number;
  // The part of the piece (its own px) to draw - the surface spans just that, since a piece of a long
  // timeline can be millions of px wide; everything inside is still laid out in the piece's px.
  visible: [number, number];
  // The timeline's playhead (output seconds) - a dot rides the line under it, reading out the level.
  playhead: number;
  playing: boolean;
  // The player's exact time while playing - read every frame, so the dot glides rather than steps.
  getExactTime?: () => number | null;
  editable: boolean;
  onChange: (points: GainPoint[]) => void;
}

const formatDb = (db: number) => (db <= -59.95 ? "-∞ dB" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`);

const AutomationLine: React.FC<AutomationLineProps> = ({ overlay, widthPx, heightPx, pxPerSec, playhead: reportedHead, playing, getExactTime, editable, onChange, visible: shown }) => {
  const vFrom = Math.max(0, shown[0]);
  const vWidth = Math.max(1, Math.min(widthPx, shown[1]) - vFrom);
  const [exactHead, setExactHead] = useState<number | null>(null);
  useEffect(() => {
    if (!playing || !getExactTime) {
      setExactHead(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      setExactHead(getExactTime());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, getExactTime]);
  const playhead = exactHead ?? reportedHead;
  const [draft, setDraft] = useState<GainPoint[] | null>(null);
  const [drag, setDrag] = useState<{ index: number; pointerId: number; fixedAt: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const surfaceRef = useRef<SVGSVGElement>(null);
  const points = draft ?? overlay.gain ?? [];
  const length = overlay.endTime - overlay.startTime;

  // Abandon an in-progress edit if the piece itself changes underneath it (undo, another edit).
  useEffect(() => {
    setDraft(null);
    setDrag(null);
  }, [overlay.gain]);

  const PAD = 3;
  const usable = Math.max(1, heightPx - PAD * 2);
  const xOf = (at: number) => (at - overlay.trimStart) * pxPerSec;
  const yOf = (db: number) => PAD + (1 - dbToFraction(db)) * usable;
  const atOf = (x: number) => overlay.trimStart + Math.max(0, Math.min(length, x / pxPerSec));
  const dbOf = (y: number) => fractionToDb(1 - (y - PAD) / usable);

  // The line across the whole piece: flat from its left edge to the first point, through every
  // point, flat on to its right edge.
  const visible = points.filter((p) => p.at >= overlay.trimStart && p.at <= overlay.trimStart + length);
  const path = [
    [0, yOf(gainDbAt(points, overlay.trimStart))],
    ...visible.map((p) => [xOf(p.at), yOf(p.db)]),
    [widthPx, yOf(gainDbAt(points, overlay.trimStart + length))],
  ]
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");

  const local = (e: React.PointerEvent | React.MouseEvent) => {
    const r = surfaceRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + vFrom, y: e.clientY - r.top };
  };
  const pointAt = (x: number, y: number) =>
    points.findIndex((p) => Math.hypot(xOf(p.at) - x, yOf(p.db) - y) <= POINT_HIT_PX);
  const nearLine = (x: number, y: number) => Math.abs(yOf(gainDbAt(points, atOf(x))) - y) <= LINE_HIT_PX;
  // What a click here would do - shown as the cursor.
  const [aim, setAim] = useState<"point" | "line" | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const { x, y } = local(e);
    const hit = pointAt(x, y);
    if (hit !== -1 && e.altKey) {
      const next = removeGainPoint(points, hit);
      setDraft(null);
      onChange(next);
      return;
    }
    if (hit === -1 && !nearLine(x, y)) return;
    let list = points;
    let index = hit;
    if (index === -1) {
      // On the line itself - so the new point sits exactly on it, not wherever the pointer was.
      const at = atOf(x);
      ({ points: list, index } = addGainPoint(points, at, gainDbAt(points, at)));
      setDraft(list);
    }
    surfaceRef.current?.setPointerCapture(e.pointerId);
    setDrag({ index, pointerId: e.pointerId, fixedAt: list[index].at });
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!editable) return;
    const { x, y } = local(e);
    if (!drag) {
      const hit = pointAt(x, y);
      setHover(hit);
      setAim(hit !== -1 ? "point" : nearLine(x, y) ? "line" : null);
      return;
    }
    e.stopPropagation();
    const at = e.shiftKey ? drag.fixedAt : atOf(x);
    setDraft(moveGainPoint(points, drag.index, at, dbOf(y)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    e.stopPropagation();
    surfaceRef.current?.releasePointerCapture(drag.pointerId);
    setDrag(null);
    if (draft) onChange(draft);
  };

  const held = drag ? points[drag.index] : hover !== null && hover >= 0 ? points[hover] : null;
  // Where the playhead crosses the line - shown whenever it's inside the piece.
  const rideX = (playhead - overlay.startTime) * pxPerSec;
  const rideDb = gainDbAt(points, overlay.trimStart + (playhead - overlay.startTime));
  const riding = playhead >= overlay.startTime && playhead <= overlay.endTime && !drag;

  return (
    <svg
      ref={surfaceRef}
      width={vWidth}
      height={heightPx}
      style={{ left: vFrom }}
      className={`absolute bottom-0 ${!editable ? "pointer-events-none" : drag || aim === "point" ? "cursor-grab" : aim === "line" ? "cursor-copy" : "cursor-default"}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        if (drag) return;
        setHover(null);
        setAim(null);
      }}
      onDoubleClick={(e) => {
        if (!editable) return;
        e.stopPropagation();
        const r = surfaceRef.current!.getBoundingClientRect();
        const hit = pointAt(e.clientX - r.left + vFrom, e.clientY - r.top);
        if (hit !== -1) onChange(removeGainPoint(overlay.gain ?? [], hit));
      }}
    >
      <g transform={`translate(${-vFrom},0)`}>
      {editable && (
        <>
          <rect x={0} y={0} width={widthPx} height={heightPx} fill="rgba(10,10,10,0.35)" />
          <line x1={0} x2={widthPx} y1={yOf(0)} y2={yOf(0)} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 4" />
          <text x={4} y={yOf(0) - 3} fill="rgba(255,255,255,0.45)" fontSize={9}>
            0 dB
          </text>
        </>
      )}
      <path d={path} fill="none" stroke="rgb(251,191,36)" strokeWidth={editable ? 2 : 1.25} strokeOpacity={editable ? 1 : 0.85} strokeLinejoin="round" />
      {editable &&
        visible.map((p) => {
          const i = points.indexOf(p);
          const active = drag?.index === i || hover === i;
          return <circle key={i} cx={xOf(p.at)} cy={yOf(p.db)} r={active ? 5 : 3.5} fill={active ? "rgb(253,224,71)" : "rgb(251,191,36)"} stroke="rgba(0,0,0,0.6)" strokeWidth={1} />;
        })}
      {riding && (
        <g pointerEvents="none">
          <circle cx={rideX} cy={yOf(rideDb)} r={editable ? 7 : 4} fill="rgba(253,224,71,0.25)" className={playing ? "animate-pulse" : undefined} />
          <circle cx={rideX} cy={yOf(rideDb)} r={editable ? 3.5 : 2.25} fill="rgb(254,240,138)" stroke="rgba(0,0,0,0.7)" strokeWidth={1} />
          {editable && !held && (
            <g transform={`translate(${Math.min(widthPx - 54, Math.max(2, rideX + 9))},${Math.max(12, Math.min(heightPx - 4, yOf(rideDb) - 9))})`}>
              <rect x={-3} y={-10} width={54} height={14} rx={3} fill="rgba(0,0,0,0.75)" />
              <text x={2} y={0} fill="rgb(254,240,138)" fontSize={10} fontFamily="ui-monospace, monospace">
                {formatDb(rideDb)}
              </text>
            </g>
          )}
        </g>
      )}
      {editable && held && (
        <g transform={`translate(${Math.min(widthPx - 52, Math.max(2, xOf(held.at) + 8))},${Math.max(12, Math.min(heightPx - 4, yOf(held.db) - 8))})`}>
          <rect x={-3} y={-10} width={52} height={14} rx={3} fill="rgba(0,0,0,0.8)" />
          <text x={2} y={0} fill="white" fontSize={10} fontFamily="ui-monospace, monospace">
            {formatDb(held.db)}
          </text>
        </g>
      )}
          </g>
    </svg>
  );
};

export default AutomationLine;
