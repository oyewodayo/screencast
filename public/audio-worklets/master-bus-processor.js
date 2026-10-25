// public/audio-worklets/master-bus-processor.js
//
// The master bus of the live preview: every channel of the mixer is summed into it (mixerGraph.ts),
// and it does what the last stage of the export does (master_audio_filters, conversion.rs):
//
//   Trim      one gain for the whole mix, in dB.
//   Limiter   a stereo-linked lookahead peak limiter - 5 ms lookahead (alimiter's attack=5 on export),
//             release in ms, ceiling in dB. Gain is the windowed minimum of what each sample needs,
//             released exponentially and box-smoothed over the lookahead, so it is already down when a
//             peak arrives and never overshoots the ceiling. The export runs ffmpeg's alimiter at 4x
//             the sample rate with the same ceiling, attack and release: the same job and the same
//             settings, not a sample-exact twin like the channel effects.
//
// and measures the result the way a delivery spec does (ITU-R BS.1770-4 / EBU R128):
//
//   Momentary   K-weighted loudness over the last 400 ms, short-term over 3 s (LUFS).
//   Integrated  400 ms blocks every 100 ms, gated at -70 LUFS and then 10 LU under their own
//               loudness - since the last reset.
//   True peak   4x oversampled (windowed-sinc interpolation), per channel, in dBTP.
//
// Settings arrive on the port as {type:'master', trimDb, limiter: {ceilingDb, releaseMs} | null};
// {type:'reset'} starts the integrated measurement over. Readings go out ~20 times a second as
// {type:'meter', ...}. MasterBusCore has no Web Audio dependency, so tests run it directly
// (src/utils/masterBus.test.ts).

const LOOKAHEAD_SEC = 0.005;
const HOP_SEC = 0.1;
const MOMENTARY_HOPS = 4;
const SHORT_TERM_HOPS = 30;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = 10;
const TP_TAPS = 12;
const TP_PHASES = [0.25, 0.5, 0.75];

const dbToLin = (db) => Math.pow(10, db / 20);
const powerToLufs = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);

// BS.1770's K-weighting at any sample rate: a high shelf (the head) then a high-pass (RLB curve).
function kWeightingCoeffs(fs) {
  let K = Math.tan((Math.PI * 1681.974450955533) / fs);
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let Q = 0.7071752369554196;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  K = Math.tan((Math.PI * 38.13547087602444) / fs);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, highpass];
}

class Biquad {
  constructor(c) {
    this.c = c;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  step(x) {
    const { b0, b1, b2, a1, a2 } = this.c;
    const y = b0 * x + b1 * this.x1 + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

// Hann-windowed sinc taps for reading the signal between samples, one set per fractional position.
function truePeakTaps() {
  const half = TP_TAPS / 2;
  return TP_PHASES.map((f) => {
    const taps = new Float64Array(TP_TAPS);
    for (let k = 0; k < TP_TAPS; k++) {
      const d = k - (half - 1) - f; // distance from the in-between point, in samples
      const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / half);
      taps[k] = sinc * w;
    }
    return taps;
  });
}

class MasterBusCore {
  constructor(fs) {
    this.fs = fs;
    this.trim = 1;
    this.limiter = null;
    // Limiter state.
    this.W = Math.max(1, Math.round(LOOKAHEAD_SEC * fs));
    this.delayL = new Float64Array(this.W);
    this.delayR = new Float64Array(this.W);
    this.delayAt = 0;
    this.minVal = new Float64Array(this.W + 2);
    this.minIdx = new Float64Array(this.W + 2);
    this.minHead = 0;
    this.minTail = 0;
    this.sampleIndex = 0;
    this.env = 1;
    this.box = new Float64Array(this.W).fill(1);
    this.boxAt = 0;
    this.boxSum = this.W;
    this.minGain = 1; // lowest gain since the last reading
    // Meter state.
    const [shelf, hp] = kWeightingCoeffs(fs);
    this.kL = [new Biquad(shelf), new Biquad(hp)];
    this.kR = [new Biquad(shelf), new Biquad(hp)];
    this.hopLength = Math.round(HOP_SEC * fs);
    this.hopFill = 0;
    this.hopSum = 0;
    this.hops = new Float64Array(SHORT_TERM_HOPS); // mean-square power of each 100 ms hop
    this.hopCount = 0;
    this.blocks = []; // power of every 400 ms block, for the integrated reading
    // The three tap sets back to back, and the most an interpolated point can exceed its window's
    // loudest sample by - so a window that can't beat the held peak skips the interpolation.
    const sets = truePeakTaps();
    this.tpTaps = new Float64Array(TP_TAPS * sets.length);
    sets.forEach((taps, p) => this.tpTaps.set(taps, p * TP_TAPS));
    this.tpGain = Math.max(...sets.map((taps) => taps.reduce((sum, t) => sum + Math.abs(t), 0)));
    // History written twice (at i and i + TP_TAPS), so the last TP_TAPS samples always sit in one
    // unbroken run - no wrap-around in the inner loop.
    this.histL = new Float64Array(TP_TAPS * 2);
    this.histR = new Float64Array(TP_TAPS * 2);
    this.histAt = 0;
    this.tpL = 0;
    this.tpR = 0;
    this.readings = 0;
    this.lastIntegrated = -Infinity;
    this.blocksAtIntegrated = 0;
  }

  setMaster(settings) {
    const trimDb = Number.isFinite(settings && settings.trimDb) ? Math.max(-24, Math.min(24, settings.trimDb)) : 0;
    this.trim = dbToLin(trimDb);
    const lim = settings && settings.limiter;
    if (lim) {
      const ceilingDb = Number.isFinite(lim.ceilingDb) ? Math.max(-24, Math.min(0, lim.ceilingDb)) : -1;
      const releaseMs = Number.isFinite(lim.releaseMs) ? Math.max(1, Math.min(2000, lim.releaseMs)) : 50;
      this.limiter = { ceiling: dbToLin(ceilingDb), rel: 1 - Math.exp(-1 / ((releaseMs / 1000) * this.fs)) };
    } else {
      this.limiter = null;
    }
  }

  // A fresh measurement - the hops too, or the first blocks after it would still carry what
  // played before.
  resetLoudness() {
    this.blocks = [];
    this.hops.fill(0);
    this.hopCount = 0;
    this.hopFill = 0;
    this.hopSum = 0;
    this.readings = 0;
  }

  // The gain this sample may have: the lowest any sample in the lookahead window needs.
  limitGain(peak) {
    const lim = this.limiter;
    const need = peak > lim.ceiling ? lim.ceiling / peak : 1;
    const i = this.sampleIndex++;
    const cap = this.minVal.length;
    // Sliding-window minimum (monotonic deque) over the last W+1 samples.
    while (this.minTail !== this.minHead && this.minVal[(this.minTail - 1 + cap) % cap] >= need) this.minTail = (this.minTail - 1 + cap) % cap;
    this.minVal[this.minTail] = need;
    this.minIdx[this.minTail] = i;
    this.minTail = (this.minTail + 1) % cap;
    while (this.minIdx[this.minHead] <= i - this.W - 1) this.minHead = (this.minHead + 1) % cap;
    const gmin = this.minVal[this.minHead];
    this.env = gmin < this.env ? gmin : this.env + (gmin - this.env) * lim.rel;
    this.boxSum += this.env - this.box[this.boxAt];
    this.box[this.boxAt] = this.env;
    this.boxAt = (this.boxAt + 1) % this.W;
    return Math.min(1, this.boxSum / this.W);
  }

  process(L, R, n) {
    const trim = this.trim;
    for (let i = 0; i < n; i++) {
      let l = L[i] * trim;
      let r = R[i] * trim;
      if (this.limiter) {
        const g = this.limitGain(Math.max(Math.abs(l), Math.abs(r)));
        const at = this.delayAt;
        const dl = this.delayL[at];
        const dr = this.delayR[at];
        this.delayL[at] = l;
        this.delayR[at] = r;
        this.delayAt = (at + 1) % this.W;
        l = dl * g;
        r = dr * g;
        if (g < this.minGain) this.minGain = g;
      }
      L[i] = l;
      R[i] = r;
      this.measure(l, r);
    }
  }

  measure(l, r) {
    // True peak: the sample itself and three points between it and the one before.
    const hL = this.histL;
    const hR = this.histR;
    const h = this.histAt;
    hL[h] = hL[h + TP_TAPS] = l;
    hR[h] = hR[h + TP_TAPS] = r;
    this.histAt = h + 1 === TP_TAPS ? 0 : h + 1;
    const start = this.histAt; // oldest of the last TP_TAPS samples
    let pl = Math.abs(l);
    let pr = Math.abs(r);
    if (pl > this.tpL) this.tpL = pl;
    if (pr > this.tpR) this.tpR = pr;
    let windowMax = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      const a = Math.abs(hL[start + k]);
      const b = Math.abs(hR[start + k]);
      if (a > windowMax) windowMax = a;
      if (b > windowMax) windowMax = b;
    }
    if (windowMax * this.tpGain > Math.min(this.tpL, this.tpR)) {
      const taps = this.tpTaps;
      for (let o = 0; o < taps.length; o += TP_TAPS) {
        let yl = 0;
        let yr = 0;
        for (let k = 0; k < TP_TAPS; k++) {
          const t = taps[o + k];
          yl += hL[start + k] * t;
          yr += hR[start + k] * t;
        }
        if (yl < 0) yl = -yl;
        if (yr < 0) yr = -yr;
        if (yl > pl) pl = yl;
        if (yr > pr) pr = yr;
      }
      if (pl > this.tpL) this.tpL = pl;
      if (pr > this.tpR) this.tpR = pr;
    }

    // Loudness: K-weighted energy per 100 ms hop.
    const kl = this.kL[1].step(this.kL[0].step(l));
    const kr = this.kR[1].step(this.kR[0].step(r));
    this.hopSum += kl * kl + kr * kr;
    if (++this.hopFill >= this.hopLength) {
      this.hops[this.hopCount % SHORT_TERM_HOPS] = this.hopSum / this.hopLength;
      this.hopCount++;
      this.hopFill = 0;
      this.hopSum = 0;
      if (this.hopCount >= MOMENTARY_HOPS) this.blocks.push(this.windowPower(MOMENTARY_HOPS));
    }
  }

  windowPower(hops) {
    const count = Math.min(hops, this.hopCount);
    if (count === 0) return 0;
    let sum = 0;
    for (let i = 1; i <= count; i++) sum += this.hops[(this.hopCount - i) % SHORT_TERM_HOPS];
    return sum / count;
  }

  // Gated in the power domain - the same comparisons as in LUFS, without a log per block.
  integrated() {
    const absoluteGate = Math.pow(10, (ABSOLUTE_GATE_LUFS + 0.691) / 10);
    let sum = 0;
    let count = 0;
    for (const p of this.blocks) {
      if (p > absoluteGate) {
        sum += p;
        count++;
      }
    }
    if (count === 0) return -Infinity;
    const gate = Math.max(absoluteGate, (sum / count) * Math.pow(10, -RELATIVE_GATE_LU / 10));
    sum = 0;
    count = 0;
    for (const p of this.blocks) {
      if (p > gate) {
        sum += p;
        count++;
      }
    }
    return count === 0 ? -Infinity : powerToLufs(sum / count);
  }

  // What the meters show, and the start of the next reading period for the peak holds.
  reading() {
    // The integrated reading only moves slowly - worked out every fifth time, or right after a reset.
    if (this.readings++ % 5 === 0 || this.blocks.length < this.blocksAtIntegrated) {
      this.lastIntegrated = this.integrated();
      this.blocksAtIntegrated = this.blocks.length;
    }
    const out = {
      m: powerToLufs(this.windowPower(MOMENTARY_HOPS)),
      s: powerToLufs(this.windowPower(SHORT_TERM_HOPS)),
      i: this.lastIntegrated,
      tpL: this.tpL,
      tpR: this.tpR,
      gr: this.minGain,
    };
    this.tpL = 0;
    this.tpR = 0;
    this.minGain = 1;
    return out;
  }
}

if (typeof registerProcessor === "function") {
  class MasterBusProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.core = new MasterBusCore(sampleRate);
      this.L = new Float64Array(128);
      this.R = new Float64Array(128);
      this.sinceReading = 0;
      this.readingEvery = Math.round(sampleRate / 20);
      this.port.onmessage = (e) => {
        if (!e.data) return;
        if (e.data.type === "master") this.core.setMaster(e.data);
        else if (e.data.type === "reset") this.core.resetLoudness();
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
      }
      this.sinceReading += n;
      if (this.sinceReading >= this.readingEvery) {
        this.sinceReading = 0;
        this.port.postMessage({ type: "meter", ...this.core.reading() });
      }
      return true;
    }
  }
  registerProcessor("master-bus-processor", MasterBusProcessor);
}

if (typeof module !== "undefined") module.exports = { MasterBusCore, kWeightingCoeffs, LOOKAHEAD_SEC };
