// components/docker/CleanupWaveform.tsx
//
// Before/after waveform for NoiseReductionPopover, plus noise-sample picking. The envelopes come
// from the backend (audio_cleanup_waveform, conversion.rs), which runs the clip through the EXACT
// export chain - so the grey area left uncovered by the blue one is precisely what export removes,
// not an approximation of the live preview.
//
// Interaction (all in the clip's source-time axis):
//   click            seek the player there
//   drag             pick that range as the noise sample ("reduce" mode only)
//   "Find quietest"  pick the quietest ~1s automatically from the original envelope
//
// Performance: one backend call per distinct settings combination (debounced while a slider is
// dragged, cached for the session), the canvas only redraws when the data/size changes, and the
// playhead is a CSS-positioned line so playback never repaints the canvas.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IoSyncOutline, IoSearchOutline, IoCloseCircle } from "react-icons/io5";
import { AudioCleanup } from "../../utils/videoEditTypes";

const FLOOR_DB = -60; // bottom of the dB display scale
const FETCH_DEBOUNCE_MS = 400;
const MIN_SAMPLE_SECS = 0.25;
const MAX_SAMPLE_SECS = 10; // matches the backend's MAX_NOISE_SAMPLE_SECS
const AUTO_SAMPLE_SECS = 1;
const CACHE_MAX = 16;

// Session cache of decoded envelopes, keyed by every input that changes the result.
const envelopeCache = new Map<string, Promise<Float32Array>>();

function fetchEnvelope(key: string, args: Record<string, unknown>): Promise<Float32Array> {
  let cached = envelopeCache.get(key);
  if (!cached) {
    cached = invoke<ArrayBuffer>("audio_cleanup_waveform", args).then((buf) => new Float32Array(buf));
    cached.catch(() => envelopeCache.delete(key));
    envelopeCache.set(key, cached);
    if (envelopeCache.size > CACHE_MAX) envelopeCache.delete(envelopeCache.keys().next().value!);
  }
  return cached;
}

const toUnit = (v: number) => {
  const db = 20 * Math.log10(v + 1e-9);
  return Math.max(0, Math.min(1, (db - FLOOR_DB) / -FLOOR_DB));
};

const formatTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

// 10th-percentile level in dB - the noise floor (quiet stretches between speech).
function floorDb(env: Float32Array, channel: 0 | 1): number {
  const vals: number[] = [];
  for (let i = channel; i < env.length; i += 2) vals.push(20 * Math.log10(env[i] + 1e-9));
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.1)] ?? FLOOR_DB;
}

interface CleanupWaveformProps {
  sourcePath: string;
  clipStart: number;
  clipEnd: number;
  strength: number;
  cleanup: AudioCleanup | undefined;
  // Whether dragging picks a noise sample - only "reduce" mode uses one.
  samplingEnabled: boolean;
  onSampleChange: (sample: { start: number; end: number } | undefined) => void;
  playhead?: number; // source seconds, when this clip is the one playing
  onSeek: (sourceTime: number) => void;
}

const CleanupWaveform: React.FC<CleanupWaveformProps> = ({
  sourcePath,
  clipStart,
  clipEnd,
  strength,
  cleanup,
  samplingEnabled,
  onSampleChange,
  playhead,
  onSeek,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [envelope, setEnvelope] = useState<Float32Array | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const dragOriginRef = useRef<{ x: number; t: number } | null>(null);
  const duration = Math.max(0.01, clipEnd - clipStart);
  const sample = cleanup?.noiseSample;

  // Bucket count follows the canvas's device-pixel width - one bucket per physical pixel column.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;
  const buckets = Math.min(1600, Math.max(64, Math.round(width * dpr)));

  // Everything that changes the backend's output. A noise sample only matters to "reduce" mode
  // with the denoiser on (the backend ignores it otherwise), so it's left out of the key then to
  // avoid pointless refetches.
  const requestCleanup = useMemo(() => {
    const usesSample = samplingEnabled && strength > 0;
    return cleanup ? { ...cleanup, noiseSample: usesSample ? cleanup.noiseSample : undefined } : null;
  }, [cleanup, samplingEnabled, strength]);
  const requestKey = JSON.stringify([sourcePath, clipStart.toFixed(3), clipEnd.toFixed(3), strength.toFixed(2), requestCleanup, buckets]);

  useEffect(() => {
    if (!width) return;
    let cancelled = false;
    const args = {
      sourcePath,
      start: clipStart,
      end: clipEnd,
      noiseReduction: strength > 0 ? strength : null,
      audioCleanup: requestCleanup,
      buckets,
    };
    // Cached results show immediately; new combinations wait out the debounce first.
    const run = () => {
      setLoading(true);
      fetchEnvelope(requestKey, args)
        .then((env) => {
          if (cancelled) return;
          setEnvelope(env);
          setError(null);
        })
        .catch((err) => !cancelled && setError(String(err)))
        .finally(() => !cancelled && setLoading(false));
    };
    if (envelopeCache.has(requestKey)) {
      run();
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    const timer = window.setTimeout(run, FETCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // requestKey captures every input above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, width]);

  // Paint: original (grey) under cleaned (blue), mirrored around the centre, dB scale.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !width) return;
    const h = 56;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!envelope) return;
    const W = canvas.width, H = canvas.height, mid = H / 2;
    const n = envelope.length / 2;
    const fill = (channel: 0 | 1, style: string) => {
      ctx.beginPath();
      ctx.moveTo(0, mid);
      for (let x = 0; x < W; x++) ctx.lineTo(x, mid - toUnit(envelope[Math.floor((x / W) * n) * 2 + channel]) * mid);
      for (let x = W - 1; x >= 0; x--) ctx.lineTo(x, mid + toUnit(envelope[Math.floor((x / W) * n) * 2 + channel]) * mid);
      ctx.closePath();
      ctx.fillStyle = style;
      ctx.fill();
    };
    fill(0, "rgba(255,255,255,0.22)");
    fill(1, "rgba(96,165,250,0.9)");
  }, [envelope, width, dpr]);

  const reduction = useMemo(() => (envelope ? floorDb(envelope, 0) - floorDb(envelope, 1) : null), [envelope]);

  const timeAt = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return clipStart + f * duration;
  };

  const commitSample = (a: number, b: number) => {
    let start = Math.min(a, b), end = Math.max(a, b);
    if (end - start < MIN_SAMPLE_SECS) end = Math.min(clipEnd, start + MIN_SAMPLE_SECS);
    if (end - start > MAX_SAMPLE_SECS) end = start + MAX_SAMPLE_SECS;
    onSampleChange({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000 });
  };

  const findQuietest = () => {
    if (!envelope) return;
    const n = envelope.length / 2;
    const win = Math.max(1, Math.round((Math.min(AUTO_SAMPLE_SECS, duration) / duration) * n));
    // Sliding sum of squared original envelope - lowest energy window wins.
    let sum = 0, best = Infinity, bestAt = 0;
    for (let i = 0; i < n; i++) {
      sum += envelope[i * 2] ** 2;
      if (i >= win) sum -= envelope[(i - win) * 2] ** 2;
      if (i >= win - 1 && sum < best) {
        best = sum;
        bestAt = i - win + 1;
      }
    }
    const start = clipStart + (bestAt / n) * duration;
    commitSample(start, start + (win / n) * duration);
  };

  const pct = (t: number) => `${((t - clipStart) / duration) * 100}%`;
  const shownSample = drag ? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) } : samplingEnabled ? sample : undefined;
  const sampleVisible = shownSample && shownSample.end > clipStart && shownSample.start < clipEnd;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="flex items-center gap-2 text-white/45">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-white/25" />Original</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-blue-400" />Cleaned</span>
        </span>
        <span className="flex items-center gap-1 text-white/55 tabular-nums">
          {loading && <IoSyncOutline size={10} className="animate-spin text-blue-300" />}
          {reduction !== null && !loading && (reduction >= 0.5 ? `Noise floor −${reduction.toFixed(0)} dB` : reduction <= -0.5 ? `Floor +${(-reduction).toFixed(0)} dB` : "Floor unchanged")}
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative h-14 rounded-md bg-black/40 ring-1 ring-white/5 overflow-hidden cursor-crosshair select-none touch-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragOriginRef.current = { x: e.clientX, t: timeAt(e.clientX) };
        }}
        onPointerMove={(e) => {
          const origin = dragOriginRef.current;
          if (!origin || !samplingEnabled || Math.abs(e.clientX - origin.x) < 4) return;
          setDrag({ from: origin.t, to: timeAt(e.clientX) });
        }}
        onPointerUp={(e) => {
          const origin = dragOriginRef.current;
          dragOriginRef.current = null;
          if (!origin) return;
          if (drag) commitSample(drag.from, drag.to);
          else onSeek(timeAt(e.clientX));
          setDrag(null);
        }}
        onPointerCancel={() => {
          dragOriginRef.current = null;
          setDrag(null);
        }}
        title={samplingEnabled ? "Click to seek · drag across a noise-only stretch to learn its noise" : "Click to seek"}
      >
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        {!envelope && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-white/40">Analyzing audio…</div>
        )}
        {error && <div className="absolute inset-0 flex items-center justify-center px-2 text-center text-[10px] text-red-300/80">{error}</div>}
        {sampleVisible && (
          <div
            className="absolute top-0 bottom-0 bg-amber-400/20 border-x border-amber-300/80 pointer-events-none"
            style={{ left: pct(Math.max(clipStart, shownSample!.start)), width: `${((Math.min(clipEnd, shownSample!.end) - Math.max(clipStart, shownSample!.start)) / duration) * 100}%` }}
          />
        )}
        {playhead !== undefined && playhead >= clipStart && playhead <= clipEnd && (
          <div className="absolute top-0 bottom-0 w-px bg-white pointer-events-none" style={{ left: pct(playhead) }} />
        )}
      </div>

      {samplingEnabled && (
        <div className="flex items-center justify-between gap-2 text-[10px]">
          {sample ? (
            <span className="flex items-center gap-1 text-amber-200/90 tabular-nums">
              Noise sample {formatTime(sample.start)}–{formatTime(sample.end)}
              <button type="button" title="Clear - go back to automatic noise tracking" onClick={() => onSampleChange(undefined)} className="text-white/40 hover:text-white">
                <IoCloseCircle size={12} />
              </button>
            </span>
          ) : (
            <span className="text-white/40">Drag over a noise-only part, or</span>
          )}
          <button
            type="button"
            onClick={findQuietest}
            disabled={!envelope}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 disabled:opacity-40"
          >
            <IoSearchOutline size={11} />
            Find quietest
          </button>
        </div>
      )}
    </div>
  );
};

export default CleanupWaveform;
