// utils/annotationSound.ts
//
// The soft "tap" the annotation overlay makes when the pointer presses down. Synthesised with Web
// Audio rather than shipped as files, so there is nothing to load (a first tap can't arrive late),
// nothing to bundle, and volume is just a gain. One AudioContext is kept for the life of the window.
import type { AnnotationTapSound } from "./annotationStyles";

let audioCtx: AudioContext | null = null;

const getContext = (): AudioContext | null => {
  if (!audioCtx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
};

// Percussive envelope: near-instant attack, exponential decay - what makes a blip read as a tap.
const envelope = (ac: AudioContext, peak: number, duration: number): GainNode => {
  const gain = ac.createGain();
  const t = ac.currentTime;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  gain.connect(ac.destination);
  return gain;
};

const blip = (ac: AudioContext, from: number, to: number, duration: number, peak: number): void => {
  const t = ac.currentTime;
  const osc = ac.createOscillator();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + duration);
  osc.connect(envelope(ac, peak, duration));
  osc.start(t);
  osc.stop(t + duration + 0.02);
};

// volume: 0..1. Peaks are kept low on purpose - this plays under a presenter's voice.
export const playTapSound = (sound: AnnotationTapSound, volume: number): void => {
  if (sound === "off" || volume <= 0) return;
  const ac = getContext();
  if (!ac) return;
  const peak = Math.min(1, volume) * 0.45;

  switch (sound) {
    case "tick":
      blip(ac, 2200, 1500, 0.045, peak * 0.7);
      break;
    case "pop":
      blip(ac, 560, 190, 0.1, peak);
      break;
    case "wood": {
      // A filtered noise burst, like a knuckle on a desk.
      const length = Math.floor(ac.sampleRate * 0.06);
      const buffer = ac.createBuffer(1, length, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource();
      src.buffer = buffer;
      const band = ac.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = 1700;
      band.Q.value = 5;
      src.connect(band);
      band.connect(envelope(ac, peak * 1.6, 0.06));
      src.start();
      break;
    }
  }
};
