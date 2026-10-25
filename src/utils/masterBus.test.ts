import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNeutralMaster, masterForExport } from "./masterBus";

// The preview's master worklet core, loaded the way the browser does (a plain script) - so the code
// under test is the code that plays.
type Core = {
  process: (l: Float64Array, r: Float64Array, n: number) => void;
  setMaster: (m: unknown) => void;
  reading: () => { m: number; s: number; i: number; tpL: number; tpR: number; gr: number };
  resetLoudness: () => void;
};
const worklet = (() => {
  const module = { exports: {} as Record<string, unknown> };
  new Function("module", readFileSync(join(__dirname, "../../public/audio-worklets/master-bus-processor.js"), "utf8"))(module);
  return module.exports as { MasterBusCore: new (sr: number) => Core };
})();

const SR = 48000;

function run(core: Core, l: Float64Array, r: Float64Array) {
  for (let i = 0; i < l.length; i += 128) core.process(l.subarray(i, i + 128), r.subarray(i, i + 128), Math.min(128, l.length - i));
}

const sine = (seconds: number, freq: number, amp: number, phase = 0) => {
  const out = new Float64Array(SR * seconds);
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return out;
};

describe("master bus loudness (BS.1770)", () => {
  it("reads a 1 kHz tone at -20 dBFS in both channels as -20 LUFS", () => {
    // The standard's own calibration point: K-weighting's +0.691 dB at 1 kHz cancels its -0.691 offset.
    const core = new worklet.MasterBusCore(SR);
    const tone = sine(5, 997, Math.pow(10, -20 / 20));
    run(core, Float64Array.from(tone), Float64Array.from(tone));
    const r = core.reading();
    expect(r.m).toBeCloseTo(-20, 1);
    expect(r.s).toBeCloseTo(-20, 1);
    expect(r.i).toBeCloseTo(-20, 1);
  });

  it("gates silence out of the integrated reading", () => {
    const core = new worklet.MasterBusCore(SR);
    const tone = sine(3, 997, Math.pow(10, -23 / 20));
    const silence = new Float64Array(SR * 6);
    const both = new Float64Array(tone.length + silence.length);
    both.set(tone);
    both.set(silence, tone.length);
    run(core, Float64Array.from(both), Float64Array.from(both));
    expect(core.reading().i).toBeCloseTo(-23, 0);
  });

  it("starts the integrated reading over on reset", () => {
    const core = new worklet.MasterBusCore(SR);
    run(core, sine(2, 997, 0.5), sine(2, 997, 0.5));
    core.resetLoudness();
    const quiet = sine(2, 997, Math.pow(10, -30 / 20));
    run(core, Float64Array.from(quiet), Float64Array.from(quiet));
    expect(core.reading().i).toBeCloseTo(-30, 0);
  });
});

describe("master bus true peak", () => {
  it("finds the peak between samples that a sample-peak meter misses", () => {
    // fs/4 with a 45-degree phase: every sample lands at 0.707 of the real crest.
    const core = new worklet.MasterBusCore(SR);
    const l = sine(1, SR / 4, 1, Math.PI / 4);
    const samplePeak = l.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    run(core, Float64Array.from(l), Float64Array.from(l));
    const r = core.reading();
    expect(samplePeak).toBeLessThan(0.72);
    expect(r.tpL).toBeGreaterThan(0.95);
  });
});

describe("master bus limiter", () => {
  it("holds a hot mix under its ceiling and reports the gain it took", () => {
    const core = new worklet.MasterBusCore(SR);
    core.setMaster({ trimDb: 6, limiter: { ceilingDb: -1, releaseMs: 60 } });
    const l = Float64Array.from(sine(2, 220, 0.9));
    const r = Float64Array.from(sine(2, 330, 0.9));
    run(core, l, r);
    const ceiling = Math.pow(10, -1 / 20);
    let peak = 0;
    for (let i = 0; i < l.length; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
    expect(peak).toBeLessThanOrEqual(ceiling + 1e-9);
    expect(peak).toBeGreaterThan(ceiling * 0.9);
    expect(core.reading().gr).toBeLessThan(0.6);
  });

  it("passes a mix under the ceiling untouched, 5 ms late", () => {
    const core = new worklet.MasterBusCore(SR);
    core.setMaster({ limiter: { ceilingDb: -1, releaseMs: 60 } });
    const src = sine(1, 440, 0.3);
    const l = Float64Array.from(src);
    const r = Float64Array.from(src);
    run(core, l, r);
    const lag = Math.round(0.005 * SR);
    for (let i = lag + 10; i < l.length; i += 997) expect(l[i]).toBeCloseTo(src[i - lag], 9);
  });
});

describe("master bus settings", () => {
  it("is neutral with no trim and no limiter, and exports nothing then", () => {
    expect(isNeutralMaster(undefined)).toBe(true);
    expect(isNeutralMaster({ trimDb: 0 })).toBe(true);
    expect(masterForExport({ trimDb: 0 })).toBeNull();
    expect(masterForExport({ trimDb: -2, limiter: { ceilingDb: -1, releaseMs: 60 } })).toEqual({ trimDb: -2, limiter: { ceilingDb: -1, releaseMs: 60 } });
  });
});
