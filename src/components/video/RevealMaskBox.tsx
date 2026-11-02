// components/video/RevealMaskBox.tsx
//
// A layer box whose mask opens over time (layerMask.ts reveals): its children show through the
// mask's shape picture, placed where the mask box is at the player's exact time every frame - the
// same coverage export draws (drawRevealCoverage / moving_mask_chain).
import React, { useEffect, useMemo, useRef } from "react";
import { revealMaskCss, revealMaskPicture, type LayerMask } from "../../utils/layerMask";

interface Props {
  mask: LayerMask;
  widthPx: number;
  heightPx: number;
  // The layer's time on screen, and the seconds into it now.
  span: number;
  getTime: () => number;
  // The layer's own shape (a picture's rounding is clipped separately; a PiP's circle is not).
  shapeUrl?: string | null;
  className?: string;
  children: React.ReactNode;
}

const RevealMaskBox: React.FC<Props> = ({ mask, widthPx, heightPx, span, getTime, shapeUrl = null, className, children }) => {
  const maskKey = JSON.stringify(mask);
  const pic = useMemo(
    () => (widthPx >= 1 && heightPx >= 1 ? revealMaskPicture(mask, widthPx, heightPx, false) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maskKey, Math.round(widthPx), Math.round(heightPx)]
  );
  const ref = useRef<HTMLDivElement>(null);
  const cssAt = (local: number) => (pic ? revealMaskCss(mask, pic, shapeUrl, local, span, widthPx, heightPx) : null);
  const cssRef = useRef(cssAt);
  cssRef.current = cssAt;
  const timeRef = useRef(getTime);
  timeRef.current = getTime;
  useEffect(() => {
    if (!pic) return;
    let raf = 0;
    let last = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const css = cssRef.current(timeRef.current());
      if (!css || !ref.current || css.maskPosition + css.maskSize === last) return;
      last = css.maskPosition + css.maskSize;
      const style = ref.current.style as unknown as Record<string, string>;
      style.maskPosition = style.webkitMaskPosition = css.maskPosition;
      style.maskSize = style.webkitMaskSize = css.maskSize;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pic]);
  return (
    <div ref={ref} className={className ?? "absolute inset-0 pointer-events-none"} style={(cssAt(getTime()) ?? {}) as React.CSSProperties}>
      {children}
    </div>
  );
};

export default RevealMaskBox;
