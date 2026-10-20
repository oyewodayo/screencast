// components/video/CaptionOverlayLayer.tsx
//
// Live preview of the editor's burned-in captions over the video picture - the same lines
// (buildCaptionLines) and preset numbers (captions.ts) the export's ASS script is built from, drawn
// with CSS instead of libass. Rendered inside VideoPlayer's `overlay` wrapper, which is already
// positioned on the letterboxed picture, so this just fills it.
//
// Word emphasis needs finer timing than currentOutputTime gives (it's driven by the <video>'s
// ~4Hz timeupdate), so while playing this reads the <video>'s own currentTime every animation
// frame and extrapolates from the last reported output time - only re-rendering when the active
// line or word actually changes.
import React, { useEffect, useRef, useState } from "react";
import { FrameRect } from "../../utils/videoFrameRect";
import { CaptionSettings } from "../../utils/videoEditTypes";
import {
  CAPTION_PRESETS,
  CaptionLine,
  activeWordIndex,
  captionBoxStyle,
  captionFontPx,
  captionLineAt,
  captionRowHeightPx,
  captionWordStyle,
  displayWord,
} from "../../utils/captions";

interface CaptionOverlayLayerProps {
  frameRect: FrameRect;
  lines: CaptionLine[];
  settings: CaptionSettings;
  currentOutputTime: number;
  isPlaying: boolean;
  // Speed of the clip under the playhead - output time runs at source time / speed.
  clipSpeed: number;
}

// How far past the last reported time the per-frame extrapolation may run before it waits for the
// next real update (guards against a stalled/seeking <video> racing the captions ahead).
const MAX_EXTRAPOLATION_SEC = 0.5;

const CaptionOverlayLayer: React.FC<CaptionOverlayLayerProps> = ({ frameRect, lines, settings, currentOutputTime, isPlaying, clipSpeed }) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ out: number; src: number } | null>(null);
  const [cursor, setCursor] = useState<{ lineId: string | null; word: number }>({ lineId: null, word: -1 });

  const findVideo = (): HTMLVideoElement | null =>
    rootRef.current?.closest(".video-container")?.querySelector("video") ?? null;

  const show = (time: number) => {
    const line = captionLineAt(lines, time);
    const next = { lineId: line?.id ?? null, word: line ? activeWordIndex(line, time) : -1 };
    setCursor((prev) => (prev.lineId === next.lineId && prev.word === next.word ? prev : next));
  };

  useEffect(() => {
    const video = findVideo();
    anchorRef.current = video ? { out: currentOutputTime, src: video.currentTime } : null;
    show(currentOutputTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentOutputTime, lines]);

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const video = findVideo();
      const anchor = anchorRef.current;
      if (video && anchor) {
        const ahead = Math.max(0, (video.currentTime - anchor.src) / (clipSpeed || 1));
        show(anchor.out + Math.min(ahead, MAX_EXTRAPOLATION_SEC));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, clipSpeed, lines]);

  const line = cursor.lineId ? lines.find((l) => l.id === cursor.lineId) ?? null : null;
  const fontPx = captionFontPx(settings, frameRect.height);
  const edgeGap = settings.offset * frameRect.height;

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 flex flex-col items-center pointer-events-none"
      style={{
        justifyContent: settings.position === "top" ? "flex-start" : settings.position === "middle" ? "center" : "flex-end",
        paddingTop: settings.position === "top" ? edgeGap : 0,
        paddingBottom: settings.position === "bottom" ? edgeGap : 0,
      }}
    >
      {settings.enabled && line && <CaptionLineView line={line} activeWord={cursor.word} settings={settings} fontPx={fontPx} />}
    </div>
  );
};

// One caption line as the preview draws it - also used by the Shorts previews (ShortsStudio).
export const CaptionLineView: React.FC<{ line: CaptionLine; activeWord: number; settings: CaptionSettings; fontPx: number }> = ({ line, activeWord, settings, fontPx }) => {
  const preset = CAPTION_PRESETS[settings.preset];
  return (
    // Row height includes the box padding, so a line that wraps stacks its per-row boxes
    // (box-decoration-break: clone) edge to edge instead of overlapping.
    <div style={{ maxWidth: "88%", textAlign: "center", fontSize: fontPx, lineHeight: `${captionRowHeightPx(preset, fontPx)}px` }}>
      <span style={captionBoxStyle(preset, fontPx)}>
        {line.words.map((w, i) => {
          const active = i === activeWord;
          const scaled = active && settings.emphasis && preset.emphasisScale !== 1;
          return (
            <React.Fragment key={i}>
              {i > 0 && " "}
              <span
                style={{
                  ...captionWordStyle(preset, settings, active, fontPx),
                  display: scaled ? "inline-block" : undefined,
                  transform: scaled ? `scale(${preset.emphasisScale})` : undefined,
                }}
              >
                {displayWord(w.text, settings)}
              </span>
            </React.Fragment>
          );
        })}
      </span>
    </div>
  );
};

export default CaptionOverlayLayer;
