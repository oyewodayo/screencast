// public/audio-worklets/track-fx-processor.js
//
// One mixer channel's effects for the live preview - EQ, compressor, balance - on the Web Audio
// rendering thread. The export runs the very same stages with ffmpeg (audio_fx_filters,
// conversion.rs), and everything here is a sample-exact port of those filters, so what is heard
// while editing is what the saved video sounds like:
//
//   EQ          lowshelf (t=s, w=1) -> equalizer (t=q) -> highshelf (t=s, w=1): RBJ cookbook
//               biquads (af_biquads.c), direct form I in double precision.
//   Compressor  acompressor (af_sidechaincompress.c): RMS detection averaged across channels, a
//               one-pole attack/release follower, a Hermite-smoothed knee, makeup gain.
//   Balance     pan=stereo|c0=gL*c0|c1=gR*c1 - turns the far side down, never mixes channels.
//
// Settings arrive as {type:'fx', fx} on the port, in the editor's own units (dB, ms - see
// src/utils/audioFx.ts); trackFxResolve below turns them into the filters' parameters with the
// same clamps ffmpeg applies to its options. Input is up-mixed to stereo by the node itself
// (channelCount 2, 'speakers'), so a mono source arrives as L = R - the export up-mixes the same way.
//
// The core (TrackFxCore) has no Web Audio dependency, so tests run it directly against ffmpeg's
// output (src/utils/audioFx.test.ts).

const LOW_SHELF_HZ = 100;
const HIGH_SHELF_HZ = 8000;

// acompressor's option ranges.
const COMP_LIMITS = {
  threshold: [0.000976563, 1],
  ratio: [1, 20],
  attack: [0.01, 2000],
  release: [0.01, 9000],
  makeup: [1, 64],
  knee: [1, 8],
};

const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const dbToLinear = (db) => Math.pow(10, db / 20);

// The editor's settings -> the filters' own parameters (or null for a stage that's off).
function trackFxResolve(fx) {
  const eq = fx && fx.eq;
  const comp = fx && fx.compressor;
  const pan = fx && Number.isFinite(fx.pan) ? Math.max(-1, Math.min(1, fx.pan)) : 0;
  const band = (g) => (Number.isFinite(g) ? Math.max(-24, Math.min(24, g)) : 0);
  return {
    eq: eq
      ? {
          low: band(eq.low),
          mid: band(eq.mid),
          midFreq: Number.isFinite(eq.midFreq) ? Math.max(20, Math.min(20000, eq.midFreq)) : 1000,
          midQ: Number.isFinite(eq.midQ) ? Math.max(0.1, Math.min(10, eq.midQ)) : 1,
          high: band(eq.high),
        }
      : null,
    compressor: comp
      ? {
          threshold: clampTo(dbToLinear(comp.threshold), COMP_LIMITS.threshold),
          ratio: clampTo(comp.ratio, COMP_LIMITS.ratio),
          attack: clampTo(comp.attack, COMP_LIMITS.attack),
          release: clampTo(comp.release, COMP_LIMITS.release),
          makeup: clampTo(dbToLinear(comp.makeup), COMP_LIMITS.makeup),
          knee: clampTo(dbToLinear(comp.knee), COMP_LIMITS.knee),
        }
      : null,
    // Balance gains: the side panned away from is turned down linearly, the other stays at unity.
    gainL: pan > 0 ? 1 - pan : 1,
    gainR: pan < 0 ? 1 + pan : 1,
  };
}

// RBJ cookbook coefficients, normalised by a0 - af_biquads.c's lowshelf/highshelf with width_type
// "s" (slope) and equalizer with width_type "q".
function biquadCoeffs(type, freq, gainDb, width, sampleRate) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === "peaking") {
    const alpha = sin / (2 * width);
    b0 = 1 + alpha * A;
    b1 = -2 * cos;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cos;
    a2 = 1 - alpha / A;
  } else {
    const alpha = (sin / 2) * Math.sqrt((A + 1 / A) * (1 / width - 1) + 2);
    const beta = 2 * Math.sqrt(A);
    if (type === "lowshelf") {
      b0 = A * (A + 1 - (A - 1) * cos + beta * alpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cos);
      b2 = A * (A + 1 - (A - 1) * cos - beta * alpha);
      a0 = A + 1 + (A - 1) * cos + beta * alpha;
      a1 = -2 * (A - 1 + (A + 1) * cos);
      a2 = A + 1 + (A - 1) * cos - beta * alpha;
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + beta * alpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cos);
      b2 = A * (A + 1 + (A - 1) * cos - beta * alpha);
      a0 = A + 1 - (A - 1) * cos + beta * alpha;
      a1 = 2 * (A - 1 - (A + 1) * cos);
      a2 = A + 1 - (A - 1) * cos - beta * alpha;
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// Direct form I, one state per channel.
class Biquad {
  constructor(c) {
    this.c = c;
    this.s = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
  }
  setCoeffs(c) {
    this.c = c;
  }
  run(buf, ch, n) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const s = this.s[ch];
    let [x1, x2, y1, y2] = s;
    for (let i = 0; i < n; i++) {
      const x = buf[i];
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      buf[i] = y;
    }
    s[0] = x1;
    s[1] = x2;
    s[2] = y1;
    s[3] = y2;
  }
}

function hermite(x, x0, x1, p0, p1, m0, m1) {
  const width = x1 - x0;
  const t = (x - x0) / width;
  m0 *= width;
  m1 *= width;
  const t2 = t * t;
  const t3 = t2 * t;
  const ct2 = -3 * p0 - 2 * m0 + 3 * p1 - m1;
  const ct3 = 2 * p0 + m0 - 2 * p1 + m1;
  return ct3 * t3 + ct2 * t2 + m0 * t + p0;
}

// af_sidechaincompress.c's compressor, downward mode, RMS detection, average link, no sidechain.
class Compressor {
  constructor(p, sampleRate) {
    this.slope = 0;
    this.configure(p, sampleRate);
  }
  configure(p, sampleRate) {
    this.p = p;
    this.thres = Math.log(p.threshold);
    const linKneeStart = p.threshold / Math.sqrt(p.knee);
    const linKneeStop = p.threshold * Math.sqrt(p.knee);
    this.adjKneeStart = linKneeStart * linKneeStart;
    this.kneeStart = Math.log(linKneeStart);
    this.kneeStop = Math.log(linKneeStop);
    this.compressedKneeStop = (this.kneeStop - this.thres) / p.ratio + this.thres;
    this.attackCoeff = Math.min(1, 1 / ((p.attack * sampleRate) / 4000));
    this.releaseCoeff = Math.min(1, 1 / ((p.release * sampleRate) / 4000));
  }
  gain(linSlope) {
    const { ratio, knee } = this.p;
    const slope = Math.log(linSlope) * 0.5;
    let gain = (slope - this.thres) / ratio + this.thres;
    if (knee > 1 && slope < this.kneeStop) {
      gain = hermite(slope, this.kneeStart, this.kneeStop, this.kneeStart, this.compressedKneeStop, 1, 1 / ratio);
    }
    return Math.exp(gain - slope);
  }
  run(L, R, n) {
    const makeup = this.p.makeup;
    for (let i = 0; i < n; i++) {
      let abs = (Math.abs(L[i]) + Math.abs(R[i])) / 2;
      abs *= abs;
      this.slope += (abs - this.slope) * (abs > this.slope ? this.attackCoeff : this.releaseCoeff);
      const g = this.slope > 0 && this.slope > this.adjKneeStart ? this.gain(this.slope) : 1;
      L[i] *= g * makeup;
      R[i] *= g * makeup;
    }
  }
}

class TrackFxCore {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.eq = null;
    this.comp = null;
    this.gainL = 1;
    this.gainR = 1;
  }
  setFx(fx) {
    const r = trackFxResolve(fx);
    const sr = this.sampleRate;
    if (r.eq) {
      const coeffs = [
        biquadCoeffs("lowshelf", LOW_SHELF_HZ, r.eq.low, 1, sr),
        biquadCoeffs("peaking", r.eq.midFreq, r.eq.mid, r.eq.midQ, sr),
        biquadCoeffs("highshelf", HIGH_SHELF_HZ, r.eq.high, 1, sr),
      ];
      // Filter state carries over a settings change, as a slider drag shouldn't click.
      if (this.eq) this.eq.forEach((f, i) => f.setCoeffs(coeffs[i]));
      else this.eq = coeffs.map((c) => new Biquad(c));
    } else {
      this.eq = null;
    }
    if (r.compressor) {
      if (this.comp) this.comp.configure(r.compressor, sr);
      else this.comp = new Compressor(r.compressor, sr);
    } else {
      this.comp = null;
    }
    this.gainL = r.gainL;
    this.gainR = r.gainR;
  }
  // Processes one block of stereo samples in place.
  process(L, R, n) {
    if (this.eq) {
      for (const f of this.eq) {
        f.run(L, 0, n);
        f.run(R, 1, n);
      }
    }
    if (this.comp) this.comp.run(L, R, n);
    if (this.gainL !== 1) for (let i = 0; i < n; i++) L[i] *= this.gainL;
    if (this.gainR !== 1) for (let i = 0; i < n; i++) R[i] *= this.gainR;
  }
}

if (typeof registerProcessor === "function") {
  class TrackFxProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.core = new TrackFxCore(sampleRate);
      this.L = new Float64Array(128);
      this.R = new Float64Array(128);
      // Peak level of the last few blocks, posted for the mixer's meters ~30 times a second.
      this.peakL = 0;
      this.peakR = 0;
      this.blocks = 0;
      this.port.onmessage = (e) => {
        if (e.data && e.data.type === "fx") this.core.setFx(e.data.fx);
      };
    }
    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      const n = output[0].length;
      if (this.L.length < n) {
        this.L = new Float64Array(n);
        this.R = new Float64Array(n);
      }
      const inL = input[0];
      const inR = input[1] || input[0];
      for (let i = 0; i < n; i++) {
        this.L[i] = inL ? inL[i] : 0;
        this.R[i] = inR ? inR[i] : 0;
      }
      this.core.process(this.L, this.R, n);
      const outL = output[0];
      const outR = output[1] || output[0];
      for (let i = 0; i < n; i++) {
        outL[i] = this.L[i];
        outR[i] = this.R[i];
        const aL = Math.abs(this.L[i]);
        const aR = Math.abs(this.R[i]);
        if (aL > this.peakL) this.peakL = aL;
        if (aR > this.peakR) this.peakR = aR;
      }
      if (++this.blocks >= 12) {
        this.port.postMessage({ type: "level", l: this.peakL, r: this.peakR });
        this.peakL = 0;
        this.peakR = 0;
        this.blocks = 0;
      }
      return true;
    }
  }
  registerProcessor("track-fx-processor", TrackFxProcessor);
}

if (typeof module !== "undefined") module.exports = { TrackFxCore, trackFxResolve, biquadCoeffs, LOW_SHELF_HZ, HIGH_SHELF_HZ };
