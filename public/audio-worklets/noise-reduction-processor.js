// public/audio-worklets/noise-reduction-processor.js
//
// Real-time spectral-subtraction noise reduction, running on the dedicated Web Audio rendering
// thread (never the main/UI thread - an AudioWorkletProcessor's process() is called by the audio
// engine itself, so heavy per-block math here can never hang the app or block other interaction,
// unlike a main-thread ScriptProcessorNode). Same algorithm FAMILY as conversion.rs's export-side
// `afftdn` filter (both are FFT magnitude-domain noise-profile subtraction) so the live preview and
// the exported file are perceptually consistent, even though this is a simplified single-window
// OLA version rather than afftdn's own fuller implementation - a browser-realtime denoiser and an
// offline ffmpeg filter were never going to be bit-identical, but they should sound like the same
// *idea*, not two unrelated effects.
//
// Loaded via audioContext.audioWorklet.addModule('/audio-worklets/noise-reduction-processor.js')
// from VideoPlayer.tsx's own noise-reduction effect - plain JS (not compiled from the app's own
// TS), since Vite has no AudioWorklet-aware bundling here and importing a worklet module needs a
// stable, directly-fetchable URL rather than a bundled chunk.
//
// ---- STFT/OLA shape ------------------------------------------------------------------------
// FFT size N=1024, hop=512 (exactly 50% overlap) - a single Hann window applied only at analysis
// time (not again at synthesis) is the simplest scheme that satisfies the constant-overlap-add
// (COLA) condition at 50% hop with NO extra normalization constant needed: shifted copies of a
// Hann window at half-window spacing sum to exactly 1 by construction, so overlap-adding the
// (unwindowed-at-synthesis) inverse-FFT frames reconstructs unity gain on their own.
//
// Each input channel gets its OWN independent analysis/OLA state (see makeChannelState) - stereo
// content keeps its own left/right noise profile and phase rather than being collapsed to mono,
// which an earlier version of this file did by only ever reading input channel 0.
//
// ---- Calibration ----------------------------------------------------------------------------
// The very first time `strength` becomes > 0 for a given clip, every channel spends
// CALIBRATION_HOPS worth of audio (~500ms) just passing audio through UNCHANGED while it averages
// its own magnitude spectrum into a noise profile - posts {type:'calibrating'}/{type:'calibrated'}
// (from channel 0 only, as a single representative status - every channel processes the same
// number of hops per unit time, so they finish within a hop of each other regardless) for
// VideoPlayer.tsx to surface as the popover's spinner. A `{type:'recalibrate'}` message (sent
// whenever the active clip/source changes) clears every channel's stored profile and restarts
// this phase - a noise profile learned from one clip's own background hum is meaningless applied
// to a different clip's audio.

const FFT_SIZE = 1024;
const HOP_SIZE = FFT_SIZE / 2;
const CALIBRATION_HOPS = 40; // ~465ms at 44.1kHz (40 * 512 / 44100)
// Spectral floor - never subtract so much of a bin that it drops below this fraction of its own
// original magnitude. A floor of 0 (subtract everything the profile says is noise) produces the
// classic "musical noise" (isolated random bins left at silence, sizzling artifact) spectral
// subtraction is notorious for; keeping a small floor of the original signal in every bin trades a
// little residual noise for avoiding that far-worse-sounding artifact.
const SPECTRAL_FLOOR_RATIO = 0.1;

// ---- Compact iterative radix-2 Cooley-Tukey FFT, in place on parallel real/imag arrays --------
// (length must be a power of two - always true here, FFT_SIZE is fixed). `sign` -1 for forward,
// +1 for inverse; inverse does NOT divide by N here since bit-for-bit round-trip scale doesn't
// matter for this use (magnitude gets rescaled by the noise-profile subtraction anyway, and OLA
// unity gain only depends on the Hann-window sum identity, not on FFT normalization convention) -
// simplest to just fold that division into the fixed 1/N the OLA math already needs nowhere else.
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
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wI;
        const nextIm = curRe * wI + curIm * wRe;
        curRe = nextRe; curIm = nextIm;
      }
    }
  }
}

// Periodic Hann (denominator N, NOT N-1 as the "symmetric" window used for FIR design/spectral
// display would use) - this specific variant is what makes shifted copies of the window at 50%
// hop spacing sum to exactly 1 everywhere (the standard COLA identity 50%-overlap phase-vocoder
// OLA relies on). The symmetric form is a few percent off flat, which reconstructs as an audible
// periodic amplitude ripple - a well-known STFT gotcha, not a rounding-error-scale difference.
function makeHann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// Hard cap on outFifo's length - see its own doc comment at the push site in processHop for why
// this exists: it turns "the output side isn't draining as fast as hops are produced" from an
// unbounded, ever-worsening queue (which is what actually caused a real 40-minute app hang on a
// 6-minute source clip - a channel whose outFifo nothing was ever draining just grew for the
// entire playback) into, at worst, a dropped few milliseconds of audio.
const MAX_FIFO_SAMPLES = HOP_SIZE * 4;

function makeChannelState() {
  return {
    inBuf: new Float32Array(FFT_SIZE), // most recent FFT_SIZE input samples for this channel
    pendingIn: [], // samples accumulated since the last hop boundary (< HOP_SIZE)
    outFifo: [], // finished output samples awaiting delivery to process()
    outAccum: new Float32Array(FFT_SIZE), // OLA accumulator, shifted by HOP_SIZE each hop
    noiseProfile: null, // Float32Array(FFT_SIZE/2+1) once calibrated
    calibrationSum: new Float64Array(FFT_SIZE / 2 + 1),
    calibrationHopsSeen: 0,
    calibrating: false,
    // Scratch buffers reused across every hop rather than freshly allocated each time (an earlier
    // version did `new Float32Array(...)` for each of these 4 buffers on every single hop - at
    // ~86 hops/sec/channel that's real, continuous GC pressure that scales with how long a clip
    // has been playing, not just a one-time cost - over a 6-minute clip that's tens of thousands
    // of short-lived allocations. Preallocating once per channel and overwriting in place removes
    // that scaling entirely.
    re: new Float32Array(FFT_SIZE),
    im: new Float32Array(FFT_SIZE),
    mag: new Float32Array(FFT_SIZE / 2 + 1),
    phase: new Float32Array(FFT_SIZE / 2 + 1),
  };
}

class NoiseReductionProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    // k-rate: sampled once per 128-sample render quantum, not per-sample - strength changes don't
    // need per-sample precision, and this.port already handles the (much rarer) profile resets.
    return [{ name: "strength", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }

  constructor() {
    super();
    this.hann = makeHann(FFT_SIZE);
    this.channels = null; // lazily sized to the actual input channel count on the first process()
    this.port.onmessage = (e) => {
      if (e.data?.type === "recalibrate" && this.channels) {
        this.channels = this.channels.map(() => makeChannelState());
      }
    };
  }

  // One hop's worth (HOP_SIZE samples) has just been appended to state.inBuf (which always holds
  // the newest FFT_SIZE samples for this one channel) - run the analysis/(optional subtraction)/
  // synthesis step and push HOP_SIZE freshly-finalized samples onto state.outFifo. Always runs the
  // full FFT/IFFT/OLA round trip regardless of `strength` (deliberately NOT short-circuited to a
  // raw passthrough when off) - a fixed, constant algorithmic latency regardless of strength is
  // what lets the user drag the strength slider between 0 and nonzero in real time with no audible
  // timing jump; a cheaper bypass path would either double-count or skip a whole hop's worth of
  // audio the instant the pipeline switched, which is a far worse artifact than the negligible
  // extra CPU cost of an always-on 1024-point FFT running ~86 times/sec per channel.
  processHop(state, strength, isReportingChannel) {
    const N = FFT_SIZE;
    const { re, im, mag, phase } = state; // preallocated scratch buffers - see makeChannelState
    im.fill(0);
    for (let i = 0; i < N; i++) re[i] = state.inBuf[i] * this.hann[i];

    fft(re, im, -1);

    const half = N / 2;
    for (let k = 0; k <= half; k++) {
      mag[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    if (strength > 0 && !state.noiseProfile) {
      // Calibration phase: average this hop's magnitude into the running profile. `mag` is left
      // unmodified below (pure passthrough through the FFT/IFFT round trip) so nothing sounds
      // different while the profile is being learned.
      if (!state.calibrating) {
        state.calibrating = true;
        if (isReportingChannel) this.port.postMessage({ type: "calibrating" });
      }
      for (let k = 0; k <= half; k++) state.calibrationSum[k] += mag[k];
      state.calibrationHopsSeen++;
      if (state.calibrationHopsSeen >= CALIBRATION_HOPS) {
        state.noiseProfile = new Float32Array(half + 1);
        for (let k = 0; k <= half; k++) state.noiseProfile[k] = state.calibrationSum[k] / state.calibrationHopsSeen;
        state.calibrating = false;
        if (isReportingChannel) this.port.postMessage({ type: "calibrated" });
      }
    } else if (strength > 0 && state.noiseProfile) {
      for (let k = 0; k <= half; k++) {
        const reduced = mag[k] - strength * state.noiseProfile[k];
        mag[k] = Math.max(reduced, mag[k] * SPECTRAL_FLOOR_RATIO);
      }
    }
    // else strength <= 0: mag is left unmodified - pure passthrough through the same FFT/IFFT
    // round trip every other branch already uses, for the constant-latency reason above.

    for (let k = 0; k <= half; k++) {
      const m = mag[k];
      re[k] = m * Math.cos(phase[k]);
      im[k] = m * Math.sin(phase[k]);
      if (k > 0 && k < half) {
        // Hermitian symmetry - a real-valued time-domain signal's spectrum is conjugate-
        // symmetric, so the upper half is fully determined by the lower half already computed
        // above rather than an independent measurement of its own.
        re[N - k] = re[k];
        im[N - k] = -im[k];
      }
    }

    fft(re, im, 1);
    // Inverse-FFT scale (1/N) folded in here rather than inside fft() itself - see fft()'s own
    // doc comment for why.
    for (let i = 0; i < N; i++) state.outAccum[i] += re[i] / N;

    for (let i = 0; i < HOP_SIZE; i++) state.outFifo.push(state.outAccum[i]);
    // Defensive cap - see MAX_FIFO_SAMPLES's own doc comment. Drops the OLDEST excess samples
    // (the ones process() should already have consumed by now if the output side were keeping
    // up), never the ones just produced.
    if (state.outFifo.length > MAX_FIFO_SAMPLES) state.outFifo.splice(0, state.outFifo.length - MAX_FIFO_SAMPLES);
    // Slide the accumulator down by one hop: what's left (the upper half, still awaiting the NEXT
    // hop's overlap contribution) moves to the front; the newly-exposed tail is zeroed ready to
    // receive that next hop's own contribution.
    state.outAccum.copyWithin(0, HOP_SIZE);
    state.outAccum.fill(0, HOP_SIZE);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;
    const strength = parameters.strength[0];

    if (!this.channels) this.channels = input.map(() => makeChannelState());

    for (let c = 0; c < input.length; c++) {
      const inCh = input[c];
      const state = this.channels[c];
      if (!inCh || !state) continue;
      for (let i = 0; i < inCh.length; i++) {
        state.pendingIn.push(inCh[i]);
        if (state.pendingIn.length === HOP_SIZE) {
          state.inBuf.copyWithin(0, HOP_SIZE);
          for (let j = 0; j < HOP_SIZE; j++) state.inBuf[FFT_SIZE - HOP_SIZE + j] = state.pendingIn[j];
          state.pendingIn.length = 0;
          this.processHop(state, strength, c === 0);
        }
      }
    }

    for (let c = 0; c < output.length; c++) {
      const channel = output[c];
      // A channel count mismatch between input and output (shouldn't normally happen for this
      // node's own 1-in/1-out wiring) just outputs silence on the extra channel rather than
      // indexing into another channel's state.
      const state = this.channels[c];
      for (let i = 0; i < channel.length; i++) {
        channel[i] = state && state.outFifo.length > 0 ? state.outFifo.shift() : 0;
      }
    }
    return true;
  }
}

registerProcessor("noise-reduction-processor", NoiseReductionProcessor);
