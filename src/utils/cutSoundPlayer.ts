// utils/cutSoundPlayer.ts
//
// Plays the cut sounds (cutSounds.ts) in the editor's preview. A video can have dozens of cuts, so
// rather than an <audio> element per sound (each a media decoder - WebView2 runs only a few), every
// sound is decoded once into an AudioBuffer and the cues are scheduled sample-accurately on one
// AudioContext: when playback starts, every cue still to come is queued at its time; a seek or the
// picture drifting from the audio clock re-queues them from where playback really is (check()).
import { convertFileSrc } from "@tauri-apps/api/core";
import { builtinSfxFile } from "./builtinSfx";
import type { CutCue } from "./cutSounds";

// How far the audio clock may wander from the picture before the cues still to come are re-queued
// (the ones already sounding play on - stopping one mid-way would click).
const RESYNC_SEC = 0.12;
// A jump this big is a seek: everything is re-queued from the new place, playing sounds included.
const SEEK_SEC = 0.6;
// Scheduling slack, so the first cue isn't asked to start in the past.
const START_SLACK_SEC = 0.03;

export class CutSoundPlayer {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private ready = new Map<string, AudioBuffer>();
  // Every queued sound and when it starts on the audio clock.
  private sources: { src: AudioBufferSourceNode; startsAt: number; key: string }[] = [];
  // Where the queue was laid out from: this audio-clock time was this output time.
  private anchor: { ctx: number; out: number; cues: readonly CutCue[] } | null = null;
  private volume = 1;
  // Checks in a row that found the picture off the audio clock - one alone is ignored: the player
  // reports a hop for a frame as it hands over from one clip to the next, and acting on that would
  // re-queue (or restart) sounds for nothing. A real seek or drift is still there next time.
  private offChecks = 0;

  private context(): { ctx: AudioContext; out: GainNode } {
    if (!this.ctx || !this.out) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
      this.out = this.ctx.createGain();
      this.out.gain.value = this.volume;
      this.out.connect(this.ctx.destination);
    }
    return { ctx: this.ctx, out: this.out };
  }

  // Decodes a sound once (its file is made on first use - builtinSfxFile).
  private load(id: string): Promise<AudioBuffer | null> {
    let pending = this.buffers.get(id);
    if (!pending) {
      const { ctx } = this.context();
      pending = builtinSfxFile(id)
        .then((path) => fetch(convertFileSrc(path)))
        .then((r) => r.arrayBuffer())
        .then((bytes) => ctx.decodeAudioData(bytes))
        .then((buffer) => {
          this.ready.set(id, buffer);
          return buffer;
        })
        .catch((err) => {
          console.warn("Cut sound couldn't load:", id, err);
          this.buffers.delete(id);
          return null;
        });
      this.buffers.set(id, pending);
    }
    return pending;
  }

  // Gets every sound in `cues` ready, so the first play has nothing to wait for.
  preload(cues: readonly CutCue[]): void {
    for (const id of new Set(cues.map((c) => c.soundId))) void this.load(id);
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
  }

  // Queues every cue still to come, from output time `now`. `keepSounding`: sounds already under way
  // play on, and only the ones not started yet are laid out again.
  play(cues: readonly CutCue[], now: number, keepSounding = false): void {
    const sounding = keepSounding ? this.stopUnstarted() : (this.stop(), new Set<string>());
    const { ctx } = this.context();
    if (ctx.state === "suspended") void ctx.resume();
    const t0 = ctx.currentTime + START_SLACK_SEC;
    this.anchor = { ctx: t0, out: now, cues };
    const anchor = this.anchor;
    for (const cue of cues) {
      if (sounding.has(cue.key)) continue;
      const buffer = this.ready.get(cue.soundId);
      if (!buffer) {
        // Not decoded yet: queued once it is, if playback hasn't moved on past it by then.
        void this.load(cue.soundId).then((b) => b && this.anchor === anchor && this.queue(cue, b, anchor));
        continue;
      }
      this.queue(cue, buffer, anchor);
    }
  }

  private queue(cue: CutCue, buffer: AudioBuffer, anchor: { ctx: number; out: number }): void {
    const { ctx, out } = this.context();
    // When the cue starts on the audio clock; one already under way (or starting before the video)
    // joins part way through, from the earliest moment it can still be scheduled.
    const at = anchor.ctx + (cue.start - anchor.out);
    const offset = Math.max(0, Math.max(ctx.currentTime, anchor.ctx) - at);
    if (offset >= buffer.duration) return; // already over
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(out);
    src.start(at + offset, offset);
    const entry = { src, startsAt: at + offset, key: cue.key };
    src.onended = () => {
      const i = this.sources.indexOf(entry);
      if (i >= 0) this.sources.splice(i, 1);
    };
    this.sources.push(entry);
  }

  // Cancels the queued sounds that haven't started yet; returns the cues still sounding.
  private stopUnstarted(): Set<string> {
    const now = this.ctx?.currentTime ?? 0;
    const sounding = new Set<string>();
    this.sources = this.sources.filter((entry) => {
      if (entry.startsAt <= now + 0.005) {
        sounding.add(entry.key);
        return true;
      }
      entry.src.onended = null;
      try {
        entry.src.stop();
      } catch {
        // never started
      }
      entry.src.disconnect();
      return false;
    });
    return sounding;
  }

  // While playing: re-queues from `now` if the picture has jumped (a seek) or drifted from the audio
  // clock, or the cues changed.
  check(cues: readonly CutCue[], now: number): void {
    if (!this.anchor || !this.ctx) return this.play(cues, now);
    if (cues !== this.anchor.cues) return this.play(cues, now, true);
    const drift = Math.abs(this.anchor.out + (this.ctx.currentTime - this.anchor.ctx) - now);
    if (drift <= RESYNC_SEC) {
      this.offChecks = 0;
      return;
    }
    if (++this.offChecks < 2) return;
    this.offChecks = 0;
    this.play(cues, now, drift <= SEEK_SEC);
  }

  stop(): void {
    this.anchor = null;
    this.offChecks = 0;
    for (const { src } of this.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // never started - nothing to stop
      }
      src.disconnect();
    }
    this.sources = [];
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
    this.out = null;
    this.buffers.clear();
    this.ready.clear();
  }
}
