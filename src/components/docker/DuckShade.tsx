// components/docker/DuckShade.tsx
//
// Music ducking, seen: over a ducked track's chip, the stretches where it dips under someone
// speaking - shaded from the top down to the level it's taken to, with the attack and release ramps
// - so where the music gives way to the voice is visible before pressing play. Drawn from the very
// curve the preview plays and the export renders (duckGainAt), only across the part of the chip in
// view, so an hour of speech on a long timeline costs no more than a screen of it.

import React, { useMemo } from "react";
import { DUCK_ATTACK_SEC, DUCK_RELEASE_SEC, duckGainAt, type TimeRange } from "../../utils/musicDucking";

// The depth the shade's full height stands for - deeper dips reach the bottom.
const SHADE_DB = 24;

interface DuckShadeProps {
  ranges: TimeRange[]; // speech on the output timeline, sorted and merged
  startTime: number; // the chip's span on the output timeline
  endTime: number;
  level: number; // the track's duck level (0..1)
  pxPerSec: number;
  widthPx: number;
  heightPx: number;
  visible: [number, number]; // chip-local px in view
}

const depth = (g: number) => Math.max(0, Math.min(1, -20 * Math.log10(Math.max(g, 1e-6)) / SHADE_DB));

const DuckShade: React.FC<DuckShadeProps> = ({ ranges, startTime, endTime, level, pxPerSec, widthPx, heightPx, visible }) => {
  const path = useMemo(() => {
    const x0 = Math.max(0, visible[0]);
    const x1 = Math.min(widthPx, visible[1]);
    if (x1 <= x0) return null;
    const t0 = startTime + x0 / pxPerSec;
    const t1 = Math.min(endTime, startTime + x1 / pxPerSec);
    // The curve's corners - every ramp's ends - plus the window's edges; the curve is straight
    // between them (sampled per pixel where they'd crowd closer than that anyway).
    const times: number[] = [t0, t1];
    for (const [s, e] of ranges) {
      if (e + DUCK_RELEASE_SEC < t0) continue;
      if (s - DUCK_ATTACK_SEC > t1) break;
      for (const t of [s - DUCK_ATTACK_SEC, s, e, e + DUCK_RELEASE_SEC]) if (t > t0 && t < t1) times.push(t);
    }
    if (times.length > (x1 - x0) / 2) {
      times.length = 0;
      for (let x = x0; x <= x1; x += 2) times.push(startTime + x / pxPerSec);
    }
    times.sort((a, b) => a - b);
    const points = times.map((t) => [(t - startTime) * pxPerSec, depth(duckGainAt(ranges, t, level)) * heightPx] as const);
    if (!points.some(([, y]) => y > 0.5)) return null;
    const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    return { line, area: `${line}L${points[points.length - 1][0].toFixed(1)},0L${points[0][0].toFixed(1)},0Z` };
  }, [ranges, startTime, endTime, level, pxPerSec, widthPx, heightPx, visible[0], visible[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!path) return null;
  return (
    <svg className="absolute left-0 top-0 pointer-events-none" width={widthPx} height={heightPx} style={{ overflow: "visible" }}>
      <title>{`Ducks ${Math.round(-20 * Math.log10(level))} dB under the voice here`}</title>
      <path d={path.area} fill="rgba(0,0,0,0.38)" />
      <path d={path.line} fill="none" stroke="rgba(252,211,77,0.75)" strokeWidth={1} />
    </svg>
  );
};

export default DuckShade;
