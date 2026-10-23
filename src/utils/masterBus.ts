// utils/masterBus.ts
//
// The mix's last stage - everything summed, then a trim and a lookahead limiter - and the loudness
// targets a mix is delivered to. The live preview runs it in an AudioWorklet
// (public/audio-worklets/master-bus-processor.js, wired in mixerGraph.ts), which also meters the
// result to EBU R128 / ITU-R BS.1770 (momentary, short-term, integrated LUFS and true peak); the
// export runs the same trim and an alimiter with the same ceiling/attack/release
// (master_audio_filters, conversion.rs), before any loudness target is applied.

export interface MasterLimiter {
  ceilingDb: number; // -24 .. 0
  releaseMs: number; // 1 .. 2000
}

export interface MasterBus {
  trimDb?: number; // -24 .. 24
  limiter?: MasterLimiter;
}

export const DEFAULT_LIMITER: MasterLimiter = { ceilingDb: -1, releaseMs: 60 };

// Delivery targets - integrated loudness and the true-peak ceiling each one asks for.
export const LOUDNESS_TARGETS: { id: string; label: string; lufs: number; ceilingDb: number; hint: string }[] = [
  { id: "streaming", label: "Streaming", lufs: -14, ceilingDb: -1, hint: "YouTube, Spotify, TikTok, Instagram" },
  { id: "podcast", label: "Podcast", lufs: -16, ceilingDb: -1, hint: "Apple Podcasts, most podcast hosts" },
  { id: "broadcast", label: "Broadcast", lufs: -23, ceilingDb: -1, hint: "EBU R128 - TV and radio" },
];

const near = (a: number | undefined, b: number) => Math.abs((a ?? b) - b) < 1e-6;

export const isNeutralMaster = (m: MasterBus | null | undefined): boolean => !m || (near(m.trimDb, 0) && !m.limiter);

// What export_trimmed_video takes, or null for nothing to do.
export function masterForExport(m: MasterBus | null | undefined): MasterBus | null {
  if (!m || isNeutralMaster(m)) return null;
  return { ...(near(m.trimDb, 0) ? {} : { trimDb: m.trimDb }), ...(m.limiter ? { limiter: m.limiter } : {}) };
}

// A reading off the master meter.
export interface MasterReading {
  momentary: number; // LUFS, -Infinity in silence
  shortTerm: number;
  integrated: number;
  truePeakL: number; // linear
  truePeakR: number;
  gainReductionDb: number; // <= 0
}

export const SILENT_READING: MasterReading = { momentary: -Infinity, shortTerm: -Infinity, integrated: -Infinity, truePeakL: 0, truePeakR: 0, gainReductionDb: 0 };
