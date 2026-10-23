// components/video/AudioOnlyStage.tsx
//
// What the player shows for a project that is only sound: the live waveform of the timeline's mix,
// drawn the same way the player draws an opened audio file (VideoPlayer's visualizer - a red trace
// while playing, a flat line at rest), with the name of the piece under the playhead. It reads the
// mixer's own tap (mixerAnalyser), so it shows what's heard - volume, fades, effects and all.
//
// Preview only: the saved video is the blank screen beneath (blankClipsFor), and the label says so.
import React, { useEffect, useRef, useState } from "react";
import { mixerAnalyser } from "../../utils/mixerGraph";
import { AudioOverlay } from "../../utils/videoEditTypes";
import { fileStem } from "../../utils/audioFx";

interface AudioOnlyStageProps {
  audioOverlays: AudioOverlay[];
  isPlaying: boolean;
  currentOutputTime: number;
}

const TRACE_COLOR = "rgba(239, 68, 68, 0.9)";
const IDLE_COLOR = "rgba(255, 255, 255, 0.35)";

const AudioOnlyStage: React.FC<AudioOnlyStageProps> = ({ audioOverlays, isPlaying, currentOutputTime }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Bumped by the resize observer, so a resize while paused redraws the resting line at the new size.
  const sizeRef = useRef({ width: 0, height: 0 });
  const [sizeVersion, setSizeVersion] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      sizeRef.current = { width, height };
      setSizeVersion((v) => v + 1);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = sizeRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";

    const restingLine = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = IDLE_COLOR;
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();
    };
    if (!isPlaying) {
      restingLine();
      return;
    }

    const analyser = mixerAnalyser();
    const samples = new Float32Array(analyser.fftSize);
    let raf = 0;
    const draw = () => {
      analyser.getFloatTimeDomainData(samples);
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = TRACE_COLOR;
      ctx.beginPath();
      const step = width / (samples.length - 1);
      for (let i = 0; i < samples.length; i++) {
        const y = height / 2 - Math.max(-1, Math.min(1, samples[i])) * (height / 2);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(i * step, y);
      }
      ctx.stroke();
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, sizeVersion]);

  // The piece under the playhead - or, between pieces, the next one to come in (else the first).
  const heard =
    audioOverlays.find((o) => !o.muted && currentOutputTime >= o.startTime && currentOutputTime < o.endTime) ??
    [...audioOverlays].sort((a, b) => a.startTime - b.startTime).find((o) => o.startTime >= currentOutputTime) ??
    audioOverlays[0];
  const title = heard ? heard.library?.title ?? heard.label ?? fileStem(heard.src) : null;
  const artist = heard?.library?.artist;

  return (
    <div className="absolute inset-0 pointer-events-none">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
      {title && (
        <div className="absolute left-0 right-0 bottom-0 px-[4%] pb-[3.5%] flex items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="truncate text-white/85 font-medium" style={{ fontSize: "clamp(12px, 2.2vmin, 22px)" }}>
              {title}
            </div>
            {artist && (
              <div className="truncate text-white/45" style={{ fontSize: "clamp(10px, 1.6vmin, 15px)" }}>
                {artist}
              </div>
            )}
          </div>
          <div className="shrink-0 text-white/35 whitespace-nowrap" style={{ fontSize: "clamp(9px, 1.3vmin, 12px)" }}>
            Saves over a blank screen
          </div>
        </div>
      )}
    </div>
  );
};

export default AudioOnlyStage;
