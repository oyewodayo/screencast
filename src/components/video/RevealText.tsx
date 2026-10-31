// components/video/RevealText.tsx
//
// A text overlay's words with a letter-by-letter / word-by-word reveal (textReveal.ts) playing on
// them, for the live preview. Redraws on every animation frame from `getTime` (the player's own
// clock - the overlay layer's currentOutputTime updates far too rarely for typing to look smooth),
// but only while something is actually changing. The exit fade covers the whole box, background
// included, so it's handed to the parent as a --reveal-fade CSS variable it multiplies into its
// opacity. The accent underline hangs just below the box, where export draws it too.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { TextOverlay } from "../../utils/videoEditTypes";
import { renderFormattedSegments } from "../../utils/textFormatting";
import { TextReveal, textRevealState } from "../../utils/textReveal";

interface RevealTextProps {
  overlay: TextOverlay;
  kind: TextReveal;
  paddingPx: number;
  // Left/right padding when it differs from paddingPx (TextOverlay.paddingX).
  paddingXPx?: number;
  // Seconds into the overlay's life right now.
  getTime: () => number;
}

const RevealText: React.FC<RevealTextProps> = ({ overlay, kind, paddingPx, paddingXPx, getTime }) => {
  const duration = overlay.endTime - overlay.startTime;
  const settings = overlay.reveal;
  const [t, setT] = useState(() => getTime());
  const getTimeRef = useRef(getTime);
  getTimeRef.current = getTime;
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Two moments with the same key look identical - no re-render between them.
    const keyOf = (time: number) => {
      const s = textRevealState(overlay.text, kind, time, duration, settings);
      return s.settled ? "still" : s.blink !== null ? `blink${s.blink}` : `t${time}`;
    };
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = Math.round(getTimeRef.current() * 60) / 60;
      setT((prev) => (prev === now || keyOf(prev) === keyOf(now) ? prev : now));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [overlay.text, kind, duration, settings]);

  const state = textRevealState(overlay.text, kind, t, duration, settings);

  useLayoutEffect(() => {
    spanRef.current?.parentElement?.style.setProperty("--reveal-fade", String(state.fade));
  });
  useEffect(() => {
    const parent = spanRef.current?.parentElement;
    return () => {
      parent?.style.removeProperty("--reveal-fade");
    };
  }, []);

  return (
    <span ref={spanRef}>
      {renderFormattedSegments(overlay.text, overlay.colorRuns ?? [], overlay.boldRuns ?? [], overlay.italicRuns ?? [], overlay.color, {
        charStyle: (i) => {
          const c = state.char(i);
          // Offsets move the letter without touching the line's layout (relative positioning on
          // the inline span); a blur is a filter on it - both as export draws them.
          const style: React.CSSProperties = { opacity: c.opacity };
          if (c.dy || c.dx) Object.assign(style, { position: "relative", top: `${c.dy}em`, left: `${c.dx ?? 0}em` });
          if (c.blur && c.blur > 0.001) style.filter = `blur(${c.blur}em)`;
          return style;
        },
        caretAt: state.caretAt,
        caretStyle: settings?.caretStyle ?? "bar",
      })}
      {settings?.underline && state.underline > 0 && (
        <span
          className="absolute pointer-events-none"
          style={{
            left: paddingXPx ?? paddingPx,
            right: paddingXPx ?? paddingPx,
            top: "calc(100% + 0.08em)",
            height: "0.09em",
            background: settings.underline,
            transform: `scaleX(${state.underline})`,
            transformOrigin: "left center",
            borderRadius: "0.05em",
          }}
        />
      )}
    </span>
  );
};

export default RevealText;
