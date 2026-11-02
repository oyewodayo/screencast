// public/audio-worklets/noise-reduction-processor.js
//
// Real-time noise reduction for the live preview, running on the dedicated Web Audio rendering
// thread (an AudioWorkletProcessor's process() is called by the audio engine itself, so the FFT
// work here can never block the UI). Two processors live in this one module:
//
//   noise-reduction-processor - "Reduce" mode: STFT spectral noise suppression. Same algorithm
//     family as the export's `afftdn` filter (conversion.rs) so preview and export sound like the
//     same idea, without being bit-identical.
//   noise-gate-processor      - the optional gate stage, mirroring the export's `agate`.
//   leveler-processor         - loudness levelling, standing in for the export's
//     `speechnorm` + `loudnorm` (a slow speech-gated AGC plus a peak limiter).
//
// "Remove" mode (voice isolation) is not here - VideoPlayer.tsx runs RNNoise for that via
// @sapphi-red/web-noise-suppressor, matching the export's `arnndn`.
//
// Loaded via audioContext.audioWorklet.addModule('/audio-worklets/noise-reduction-processor.js')
// - plain JS, not compiled from the app's TS, since importing a worklet needs a stable URL.
//
// ---- STFT/OLA shape ------------------------------------------------------------------------
// FFT size N=1024, hop=512 (50% overlap), periodic Hann applied at analysis only: shifted copies
// at half-window spacing sum to exactly 1, so overlap-adding the unwindowed inverse frames
// reconstructs unity gain with no extra normalization. Each input channel keeps its own state.
//
// ---- Noise estimate -------------------------------------------------------------------------
// No calibration step needed: every bin continuously tracks the minimum of its smoothed power
// (minimum statistics, simplified to Doblinger-style continuous tracking - follows the floor down
// instantly, creeps back up slowly so speech never gets mistaken for noise), times a bias factor
// since a minimum underestimates the mean noise level. That adapts on its own to fans/AC/traffic
// that change over the clip. `{type:'profile', pcm}` replaces the tracker with a fixed profile
// averaged over a noise-only stretch the user picked on the waveform (mono Float32Array at the
// context rate, decoded by the backend) - same FFT/window/hop as the processing itself, so the
// profile is in exactly the units processHop compares against. `{type:'reset'}` drops both (sent
// when the active clip changes).
//
// ---- Suppression rule -----------------------------------------------------------------------
// Wiener gain with the decision-directed a-priori SNR estimate (Ephraim & Malah) instead of plain
// magnitude subtraction - the DD smoothing is what keeps the residual from turning into "musical
// noise" (random sizzling bins), which is what limited how hard the old subtraction could push.
// `strength` scales both the over-subtraction factor and how deep the gain floor goes (up to
// -40dB), and gains are smoothed across neighbouring bins for the same reason.

const FFT_SIZE = 1024;
const HOP_SIZE = FFT_SIZE / 2;
const BINS = FFT_SIZE / 2 + 1;
const POWER_SMOOTHING = 0.8; // per-hop smoothing of each bin's power before minimum tracking
const NOISE_RISE_PER_HOP = 1.004; // ~1.5dB/s upward creep of the tracked floor
const MIN_STATS_BIAS = 1.8; // minimum-of-smoothed-power -> mean noise power
const DD_ALPHA = 0.97;

// ---- Iterative radix-2 Cooley-Tukey FFT, in place on parallel real/imag arrays ----------------
// `sign` -1 forward, +1 inverse; the inverse's 1/N is applied by the caller.
function fft(re, im, sign) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wRe = Math.cos(ang), wI = Math.sin(ang);
    const halfLen = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < halfLen; k++) {
        const a = i + k, b = a + halfLen;
        const vRe = re[b] * curRe - im[b] * curIm;
        const vIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - vRe; im[b] = im[a] - vIm;
        re[a] += vRe; im[a] += vIm;
        const nextRe = curRe * wRe - curIm * wI;
        curIm = curRe * wI + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// Periodic Hann (denominator N) - the variant whose 50%-hop copies sum to exactly 1.
function makeHann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// Fixed-capacity sample FIFO - typed ring buffer, so process() never shifts a JS array per sample.
// Overflow drops the oldest samples (bounded latency rather than an ever-growing queue if the
// output side ever stops draining).
class Fifo {
  constructor(capacity) {
    this.buf = new Float32Array(capacity);
    this.read = 0;
    this.size = 0;
  }
  push(x) {
    const cap = this.buf.length;
    if (this.size === cap) {
      this.read = (this.read + 1) % cap;
      this.size--;
    }
    this.buf[(this.read + this.size) % cap] = x;
    this.size++;
  }
  shift() {
    if (this.size === 0) return 0;
    const x = this.buf[this.read];
    this.read = (this.read + 1) % this.buf.length;
    this.size--;
    return x;
  }
}

function makeChannelState() {
  return {
    inBuf: new Float32Array(FFT_SIZE), // newest FFT_SIZE input samples
    pending: 0, // samples received since the last hop boundary
    outFifo: new Fifo(HOP_SIZE * 4),
    outAccum: new Float32Array(FFT_SIZE), // OLA accumulator
    smoothedPower: null, // Float32Array(BINS), lazily seeded from the first frame
    trackedNoise: null, // Float32Array(BINS)
    learnedNoise: null, // Float32Array(BINS) once a {type:'profile'} arrives
    prevCleanPower: new Float32Array(BINS), // |G·X|² of the previous hop, for the DD estimate
    re: new Float32Array(FFT_SIZE),
    im: new Float32Array(FFT_SIZE),
    power: new Float32Array(BINS),
    gain: new Float32Array(BINS),
    smoothGain: new Float32Array(BINS),
  };
}

class NoiseReductionProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "strength", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.hann = makeHann(FFT_SIZE);
    this.channels = null; // sized to the actual input channel count on the first process()
    // A profile can arrive before the first process() call sizes this.channels - kept here and
    // applied to every channel as soon as they exist.
    this.pendingProfile = null;
    this.port.onmessage = (e) => {
      const type = e.data?.type;
      if (type === "reset") {
        this.pendingProfile = null;
        for (const ch of this.channels ?? []) {
          ch.trackedNoise = null;
          ch.smoothedPower = null;
          ch.learnedNoise = null;
          ch.prevCleanPower.fill(0);
        }
      } else if (type === "profile") {
        this.pendingProfile = e.data.pcm ? this.profileFromPcm(e.data.pcm) : null;
        this.applyPendingProfile();
        this.port.postMessage({ type: "calibrated" });
      }
    };
  }

  // Average power spectrum of `pcm` with the same Hann/FFT_SIZE/HOP_SIZE framing processHop uses.
  // Runs once per pick on the audio thread - a 10s sample is ~940 FFTs, a few milliseconds.
  profileFromPcm(pcm) {
    const re = new Float32Array(FFT_SIZE), im = new Float32Array(FFT_SIZE);
    const sum = new Float64Array(BINS);
    let frames = 0;
    for (let off = 0; off + FFT_SIZE <= pcm.length; off += HOP_SIZE) {
      for (let i = 0; i < FFT_SIZE; i++) {
        re[i] = pcm[off + i] * this.hann[i];
        im[i] = 0;
      }
      fft(re, im, -1);
      for (let k = 0; k < BINS; k++) sum[k] += re[k] * re[k] + im[k] * im[k];
      frames++;
    }
    if (frames === 0) return null;
    const profile = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) profile[k] = sum[k] / frames;
    return profile;
  }

  applyPendingProfile() {
    if (!this.channels) return;
    for (const ch of this.channels) {
      ch.learnedNoise = this.pendingProfile ? Float32Array.from(this.pendingProfile) : null;
      ch.prevCleanPower.fill(0);
    }
  }

  processHop(state, strength) {
    const N = FFT_SIZE;
    const { re, im, power, gain, smoothGain } = state;
    for (let i = 0; i < N; i++) {
      re[i] = state.inBuf[i] * this.hann[i];
      im[i] = 0;
    }
    fft(re, im, -1);

    for (let k = 0; k < BINS; k++) power[k] = re[k] * re[k] + im[k] * im[k];

    // Continuous noise-floor tracking (always running, even at strength 0, so turning the effect
    // on mid-playback already has a warm estimate).
    if (!state.smoothedPower) {
      state.smoothedPower = Float32Array.from(power);
      state.trackedNoise = Float32Array.from(power);
    } else {
      const sp = state.smoothedPower, tn = state.trackedNoise;
      for (let k = 0; k < BINS; k++) {
        sp[k] = POWER_SMOOTHING * sp[k] + (1 - POWER_SMOOTHING) * power[k];
        tn[k] = sp[k] < tn[k] ? sp[k] : tn[k] * NOISE_RISE_PER_HOP;
      }
    }

    if (strength > 0) {
      const noise = state.learnedNoise;
      const tracked = state.trackedNoise;
      const overSubtract = 1 + 2.5 * strength;
      const floor = Math.pow(10, (-(10 + 30 * strength)) / 20); // -10dB .. -40dB
      for (let k = 0; k < BINS; k++) {
        const n = (noise ? noise[k] : tracked[k] * MIN_STATS_BIAS) * overSubtract + 1e-12;
        const post = power[k] / n; // a-posteriori SNR
        const prior = DD_ALPHA * (state.prevCleanPower[k] / n) + (1 - DD_ALPHA) * Math.max(post - 1, 0);
        gain[k] = prior / (1 + prior);
      }
      // 3-tap smoothing across frequency, then the floor.
      for (let k = 0; k < BINS; k++) {
        const a = gain[k > 0 ? k - 1 : k], b = gain[k], c = gain[k < BINS - 1 ? k + 1 : k];
        const g = 0.25 * a + 0.5 * b + 0.25 * c;
        smoothGain[k] = g > floor ? g : floor;
      }
    } else {
      smoothGain.fill(1);
    }

    for (let k = 0; k < BINS; k++) {
      const g = smoothGain[k];
      re[k] *= g;
      im[k] *= g;
      state.prevCleanPower[k] = power[k] * g * g;
      if (k > 0 && k < BINS - 1) {
        // Hermitian symmetry for a real-valued output.
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }

    fft(re, im, 1);
    for (let i = 0; i < N; i++) state.outAccum[i] += re[i] / N;
    for (let i = 0; i < HOP_SIZE; i++) state.outFifo.push(state.outAccum[i]);
    state.outAccum.copyWithin(0, HOP_SIZE);
    state.outAccum.fill(0, HOP_SIZE);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const strength = parameters.strength[0];

    if (!this.channels || this.channels.length !== input.length) {
      this.channels = input.map(() => makeChannelState());
      if (this.pendingProfile) this.applyPendingProfile();
    }

    for (let c = 0; c < input.length; c++) {
      const inCh = input[c];
      const state = this.channels[c];
      for (let i = 0; i < inCh.length; i++) {
        state.inBuf[FFT_SIZE - HOP_SIZE + state.pending] = inCh[i];
        if (++state.pending === HOP_SIZE) {
          state.pending = 0;
          this.processHop(state, strength);
          // Slide the window by one hop, ready for the next HOP_SIZE samples.
          state.inBuf.copyWithin(0, HOP_SIZE);
        }
      }
    }

    for (let c = 0; c < output.length; c++) {
      const channel = output[c];
      const state = this.channels[c] ?? this.channels[0];
      for (let i = 0; i < channel.length; i++) channel[i] = state.outFifo.shift();
    }
    return true;
  }
}

// Downward expander matching the export's `agate=threshold=0.015:ratio=3:attack=5:release=250:
// range=0.06`: below the threshold the signal is turned down (to at most -24dB), above it it's
// untouched. One shared envelope across channels so stereo images don't wobble.
class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "enabled", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.envelope = 0;
    this.gain = 1;
    const sr = sampleRate;
    this.envCoef = Math.exp(-1 / (0.01 * sr)); // 10ms level detector
    this.attackCoef = Math.exp(-1 / (0.005 * sr));
    this.releaseCoef = Math.exp(-1 / (0.25 * sr));
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const enabled = parameters.enabled[0] > 0.5;
    const frames = input[0].length;
    const THRESHOLD = 0.015, RATIO = 3, RANGE = 0.06;

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < input.length; c++) {
        const v = Math.abs(input[c][i]);
        if (v > peak) peak = v;
      }
      this.envelope = peak > this.envelope ? peak : this.envCoef * this.envelope + (1 - this.envCoef) * peak;

      let target = 1;
      if (enabled && this.envelope < THRESHOLD) {
        // Expander curve: every dB below the threshold becomes RATIO dB, clamped at RANGE.
        const below = this.envelope / THRESHOLD;
        target = Math.max(RANGE, Math.pow(below, RATIO - 1));
      }
      const coef = target > this.gain ? this.attackCoef : this.releaseCoef;
      this.gain = coef * this.gain + (1 - coef) * target;

      for (let c = 0; c < output.length; c++) {
        const src = input[c] ?? input[0];
        output[c][i] = src[i] * this.gain;
      }
    }
    return true;
  }
}

// Loudness levelling for the live preview. The export uses speechnorm + loudnorm (-16 LUFS); this
// approximates the same result in real time without loudnorm's 3s look-ahead:
//   1. 300ms RMS level detector, gated - frames quieter than -50dBFS don't move the gain, so
//      pauses and leftover noise are never pumped up.
//   2. Gain chases TARGET_DB in the dB domain, clamped to [MIN_GAIN_DB, MAX_GAIN_DB]; it comes
//      down faster (0.4s) than it goes up (1.5s) so a loud speaker is tamed promptly but a quiet
//      one is lifted without breathing.
//   3. Peak limiter at -1.5dBFS (instant attack, 80ms release) plus a soft clip as a final net,
//      matching loudnorm's TP=-1.5.
// One shared envelope/gain across channels so the stereo image doesn't wander.
class LevelerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "enabled", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.meanSquare = 0;
    this.gainDb = 0;
    this.limitGain = 1;
    this.rmsCoef = Math.exp(-1 / (0.3 * sr));
    this.downCoef = Math.exp(-1 / (0.4 * sr));
    this.upCoef = Math.exp(-1 / (1.5 * sr));
    this.limitRelease = Math.exp(-1 / (0.08 * sr));
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const enabled = parameters.enabled[0] > 0.5;
    const frames = input[0].length;
    const TARGET_DB = -20, GATE_DB = -50, MIN_GAIN_DB = -12, MAX_GAIN_DB = 15, CEILING = 0.84; // -1.5dBFS

    for (let i = 0; i < frames; i++) {
      let sq = 0, peakIn = 0;
      for (let c = 0; c < input.length; c++) {
        const v = input[c][i];
        sq += v * v;
        const a = v < 0 ? -v : v;
        if (a > peakIn) peakIn = a;
      }
      this.meanSquare = this.rmsCoef * this.meanSquare + (1 - this.rmsCoef) * (sq / input.length);

      // The level is always tracked (so switching on mid-play starts from a warm estimate), but
      // the gain only follows it while enabled; when off it glides back to unity, never jumps.
      let targetGainDb = 0;
      if (enabled) {
        const levelDb = 10 * Math.log10(this.meanSquare + 1e-12);
        targetGainDb = levelDb < GATE_DB ? this.gainDb : Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, TARGET_DB - levelDb));
      }
      const coef = targetGainDb < this.gainDb ? this.downCoef : this.upCoef;
      this.gainDb = coef * this.gainDb + (1 - coef) * targetGainDb;
      const gain = Math.pow(10, this.gainDb / 20);

      const peakOut = peakIn * gain * this.limitGain;
      if (enabled && peakOut > CEILING) this.limitGain = CEILING / (peakIn * gain);
      else this.limitGain = this.limitRelease * this.limitGain + (1 - this.limitRelease);

      const g = gain * this.limitGain;
      for (let c = 0; c < output.length; c++) {
        const src = input[c] ?? input[0];
        let y = src[i] * g;
        if (enabled && (y > CEILING || y < -CEILING)) y = Math.tanh(y / CEILING) * CEILING;
        output[c][i] = y;
      }
    }
    return true;
  }
}

registerProcessor("noise-reduction-processor", NoiseReductionProcessor);
registerProcessor("leveler-processor", LevelerProcessor);
registerProcessor("noise-gate-processor", NoiseGateProcessor);
