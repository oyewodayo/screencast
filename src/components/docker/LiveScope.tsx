// components/docker/LiveScope.tsx
//
// A channel's waveform, live: while its sound plays, the signal itself scrolls through as an
// oscilloscope trace (read off the channel's analyser - after its effects, so it shows what's
// heard); at rest, the shape of the part that will play (its decoded peaks), so the panel always
// shows the sound it controls. Draws only while playing, on one canvas sized to its box.
import React, { useEffect, useRef, useState } from "react";

interface LiveScopeProps {
  // The channel's analyser - looked up every frame, since a channel is often only routed (and so
  // only gets one) after it starts playing.
  getAnalyser: () => AnalyserNode | null;
  active: boolean;
  // The part's waveform, 0..1 per bucket, shown at rest.
  idlePeaks?: number[] | null;
  // Fraction of the part played - shades the idle waveform up to it.
  progress?: number | null;
  height?: number;
  color?: string;
}

const LiveScope: React.FC<LiveScopeProps> = ({ getAnalyser, active, idlePeaks, progress, height = 44, color = "45,212,191" }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height });
  const getAnalyserRef = useRef(getAnalyser);
  getAnalyserRef.current = getAnalyser;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || size.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { width: w, height: h } = size;
    const mid = h / 2;

    const drawIdle = () => {
      ctx.clearRect(0, 0, w, h);
      if (!idlePeaks || idlePeaks.length === 0) {
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(w, mid);
        ctx.stroke();
        return;
      }
      const bar = w / idlePeaks.length;
      const played = progress == null ? -1 : progress * w;
      idlePeaks.forEach((amp, i) => {
        const x = i * bar;
        const bh = Math.max(1, amp * (h - 4));
        ctx.fillStyle = x < played ? `rgba(${color},0.95)` : `rgba(${color},0.4)`;
        ctx.fillRect(x, mid - bh / 2, Math.max(1, bar - 1), bh);
      });
    };

    if (!active) {
      drawIdle();
      return;
    }

    let samples = new Float32Array(2048);
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const analyser = getAnalyserRef.current();
      if (!analyser) {
        drawIdle();
        return;
      }
      if (samples.length !== analyser.fftSize) samples = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(samples);
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      // The trace, then the same path again wide and faint as its glow.
      ctx.beginPath();
      const step = w / (samples.length - 1);
      for (let i = 0; i < samples.length; i++) {
        const y = mid - Math.max(-1, Math.min(1, samples[i])) * (mid - 2);
        if (i === 0) ctx.moveTo(0, y);
        else ctx.lineTo(i * step, y);
      }
      ctx.lineJoin = "round";
      ctx.strokeStyle = `rgba(${color},0.22)`;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = `rgba(${color},0.95)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [active, size, idlePeaks, progress, color]);

  return <canvas ref={canvasRef} className="block w-full rounded bg-black/40" style={{ height }} />;
};

export default LiveScope;
