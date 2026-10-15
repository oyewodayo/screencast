// components/video/ImageRevealWrap.tsx
//
// Plays a picture overlay's reveal (imageReveal.ts) in the live preview: wraps the picture in a
// div whose mask / blur / scale / opacity follow the reveal every animation frame, plus a light
// streak masked to the picture's own alpha (so a logo's shine follows the logo, not its box).
// Styles are written straight to the DOM from the player's clock - no React re-render per frame -
// and nothing is written while the picture is settled and no shine is due.
import React, { useEffect, useRef } from "react";
import { ImageRevealSettings, imageRevealState, wipeMaskCss } from "../../utils/imageReveal";

interface ImageRevealWrapProps {
  settings: ImageRevealSettings;
  duration: number;
  widthPx: number;
  heightPx: number;
  // The picture's displayable URL - masks the shine to its shape. Omit for a cropped picture.
  maskSrc?: string;
  borderRadius?: number;
  // Seconds into the overlay's life right now.
  getTime: () => number;
  children: React.ReactNode;
}

const ImageRevealWrap: React.FC<ImageRevealWrapProps> = ({ settings, duration, widthPx, heightPx, maskSrc, borderRadius, getTime, children }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const shineRef = useRef<HTMLDivElement>(null);
  const getTimeRef = useRef(getTime);
  getTimeRef.current = getTime;

  useEffect(() => {
    const wrap = wrapRef.current;
    const shine = shineRef.current;
    if (!wrap || !shine) return;
    let raf = 0;
    let lastKey = "";
    const L = Math.hypot(widthPx, heightPx);
    // CSS angle whose gradient line runs along the box diagonal from its top-left corner - the
    // same axis export's streak uses.
    const shineAngle = (Math.atan2(widthPx, -heightPx) * 180) / Math.PI;
    const color = settings.shineColor ?? "#ffffff";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const state = imageRevealState(settings, getTimeRef.current(), duration);
      if (state.key === lastKey && state.key === "still") return;
      lastKey = state.key;
      const mask = wipeMaskCss(settings.direction, state.wipe, state.soft, widthPx, heightPx);
      wrap.style.setProperty("mask-image", mask ?? "");
      wrap.style.setProperty("-webkit-mask-image", mask ?? "");
      wrap.style.opacity = String(state.opacity);
      wrap.style.filter = state.blur > 0 ? `blur(${state.blur * Math.min(widthPx, heightPx)}px)` : "";
      wrap.style.transform = state.scale !== 1 ? `scale(${state.scale})` : "";
      if (state.shine === null) shine.style.display = "none";
      else {
        const band = 0.22 * L;
        const at = -band + (L + 2 * band) * state.shine;
        shine.style.display = "block";
        shine.style.background = `linear-gradient(${shineAngle}deg, transparent ${at - band}px, ${color}d9 ${at}px, transparent ${at + band}px)`;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [settings, duration, widthPx, heightPx]);

  const shineMask: React.CSSProperties = maskSrc
    ? { maskImage: `url("${maskSrc}")`, WebkitMaskImage: `url("${maskSrc}")`, maskSize: "contain", WebkitMaskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat", maskPosition: "center", WebkitMaskPosition: "center" }
    : { borderRadius, overflow: "hidden" };

  return (
    <div ref={wrapRef} className="absolute inset-0 pointer-events-none" style={{ borderRadius }}>
      {children}
      <div ref={shineRef} className="absolute inset-0" style={{ display: "none", ...shineMask }} />
    </div>
  );
};

export default ImageRevealWrap;
