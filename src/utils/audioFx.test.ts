import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audioChannelKey, compressorCurveDb, eqResponseDb, fxForExport, HIGH_SHELF_HZ, isNeutralFx, LOW_SHELF_HZ, tidyFx, type AudioFx } from "./audioFx";

// The preview's worklet core, loaded the way the browser does (a plain script) - so the code under
// test is the code that plays.
type Core = { process: (l: Float64Array, r: Float64Array, n: number) => void; setFx: (fx: AudioFx) => void };
const worklet = (() => {
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", readFileSync(join(__dirname, "../../public/audio-worklets/track-fx-processor.js"), "utf8"))(module);
  return module.exports as { TrackFxCore: new (sr: number) => Core; LOW_SHELF_HZ: number; HIGH_SHELF_HZ: number };
})();

const SR = 48000;

function run(fx: AudioFx, l: Float64Array, r: Float64Array) {
  const core = new worklet.TrackFxCore(SR);
  core.setFx(fx);
  const L = Float64Array.from(l);
  const R = Float64Array.from(r);
  for (let i = 0; i < L.length; i += 128) core.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i));
  return [L, R];
}

// Deterministic test programme: tones and noise, quiet then loud then pumping.
function programme(seconds: number) {
  const n = SR * seconds;
  const l = new Float64Array(n);
  const r = new Float64Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = t < 0.5 ? 0.05 : t < 1 ? 0.8 : 0.4 * (1 + Math.sin(2 * Math.PI * 3 * t));
    l[i] = env * (0.5 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * rnd() + 0.2 * Math.sin(2 * Math.PI * 6000 * t));
    r[i] = env * (0.4 * Math.sin(2 * Math.PI * 330 * t) + 0.3 * rnd());
  }
  return [l, r];
}

const SAMPLE_FX: AudioFx = {
  eq: { low: -3, mid: 4, midFreq: 2500, midQ: 1.2, high: -6 },
  compressor: { threshold: -28, ratio: 4, attack: 10, release: 200, makeup: 8, knee: 6 },
  pan: 0.35,
};

describe("audio effects", () => {
  it("shares its shelf frequencies with the worklet", () => {
    expect(worklet.LOW_SHELF_HZ).toBe(LOW_SHELF_HZ);
    expect(worklet.HIGH_SHELF_HZ).toBe(HIGH_SHELF_HZ);
  });

  it("treats flat settings as no effect", () => {
    expect(isNeutralFx(undefined)).toBe(true);
    expect(isNeutralFx({ eq: { low: 0, mid: 0, high: 0, midFreq: 400, midQ: 2 }, pan: 0 })).toBe(true);
    expect(isNeutralFx({ pan: 0.2 })).toBe(false);
    expect(fxForExport({ eq: { low: 0, mid: 0, high: 0, midFreq: 400, midQ: 2 }, pan: -0.5 })).toEqual({ pan: -0.5 });
    expect(tidyFx({ pan: 0 })).toBeUndefined();
  });

  it("draws the curve the worklet plays", () => {
    const eq = SAMPLE_FX.eq!;
    for (const f of [60, 1000, 2500, 12000]) {
      const n = SR;
      const tone = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR));
      const [out] = run({ eq }, tone, tone);
      // Steady-state amplitude over the second half (from the RMS - a 12 kHz tone has only four
      // samples a cycle, which rarely land on its peak).
      let sum = 0;
      for (let i = n / 2; i < n; i++) sum += out[i] * out[i];
      const amplitude = Math.sqrt((2 * sum) / (n / 2));
      expect(20 * Math.log10(amplitude)).toBeCloseTo(eqResponseDb(eq, [f])[0], 1);
    }
  });

  it("compresses loud passages and leaves quiet ones", () => {
    const c = SAMPLE_FX.compressor!;
    expect(compressorCurveDb(c, -60)).toBeCloseTo(-60 + c.makeup, 6);
    // Well above the knee: 4:1 above the threshold.
    expect(compressorCurveDb(c, 0)).toBeCloseTo(c.threshold + (0 - c.threshold) / 4 + c.makeup, 6);
  });

  it("pans by turning the far side down", () => {
    const one = new Float64Array(256).fill(0.5);
    const [l, r] = run({ pan: 0.4 }, one, one);
    expect(l[100]).toBeCloseTo(0.3, 12);
    expect(r[100]).toBeCloseTo(0.5, 12);
  });

  it("groups pieces of one track into a mixer channel", () => {
    expect(audioChannelKey({ label: "Music", src: "a.mp3" })).toBe(audioChannelKey({ label: "Music", src: "b.mp3" }));
    expect(audioChannelKey({ src: "a.mp3" })).not.toBe(audioChannelKey({ src: "b.mp3" }));
  });

  // The export runs ffmpeg's filters (services/audio_fx.rs builds this same chain); the preview runs
  // the worklet. They must agree sample for sample. Needs the bundled ffmpeg (src-tauri/binaries).
  const ffmpeg = join(__dirname, "../../src-tauri/binaries/ffmpeg/ffmpeg.exe");
  it.skipIf(!existsSync(ffmpeg))("matches ffmpeg's filters", () => {
    const dir = mkdtempSync(join(tmpdir(), "briefcast-fx-"));
    try {
      const [l, r] = programme(2);
      const n = l.length;
      const inter = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        inter[2 * i] = l[i];
        inter[2 * i + 1] = r[i];
      }
      writeFileSync(join(dir, "in.f32"), Buffer.from(inter.buffer));
      const { eq, compressor: c } = SAMPLE_FX;
      const lin = (db: number) => Math.pow(10, db / 20);
      const chain = [
        `lowshelf=f=${LOW_SHELF_HZ}:g=${eq!.low}:t=s:w=1:r=f64`,
        `equalizer=f=${eq!.midFreq}:t=q:w=${eq!.midQ}:g=${eq!.mid}:r=f64`,
        `highshelf=f=${HIGH_SHELF_HZ}:g=${eq!.high}:t=s:w=1:r=f64`,
        `acompressor=threshold=${lin(c!.threshold)}:ratio=${c!.ratio}:attack=${c!.attack}:release=${c!.release}:makeup=${lin(c!.makeup)}:knee=${lin(c!.knee)}`,
        `pan=stereo|c0=${1 - SAMPLE_FX.pan!}*c0|c1=1*c1`,
      ].join(",");
      const raw = ["-f", "f32le", "-ar", String(SR), "-ac", "2"];
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...raw, "-i", join(dir, "in.f32"), "-af", chain, ...raw, join(dir, "out.f32")]);
      const out = new Float32Array(readFileSync(join(dir, "out.f32")).buffer.slice(0));
      // The input as ffmpeg read it (float32).
      const [L, R] = run(SAMPLE_FX, Float64Array.from(l, (v) => Math.fround(v)), Float64Array.from(r, (v) => Math.fround(v)));
      let err = 0;
      for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(out[2 * i] - L[i]), Math.abs(out[2 * i + 1] - R[i]));
      expect(err).toBeLessThan(1e-6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
