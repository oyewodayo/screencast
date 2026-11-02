// utils/audition.ts
//
// The mixer's play: the audio pieces selected on the timeline, played on their own - not the
// timeline (its playhead and picture stay put) - so what's being mixed can be heard by itself.
//
// One clock runs across the selection, from the first piece's start to the last one's end; each
// piece plays exactly where it sits on the timeline relative to the others, so a shorter one simply
// stops at its end while the rest carry on, and a gap is just silence. Every piece plays through the
// mixer (its EQ, compressor and balance, then the master bus - so the meters and scopes move) with
// its volume, fades and volume line, and honours the strips' mute and solo. A yellow line rides each
// piece's track (previewHead.ts); dragging any of them, or clicking a track, scrubs them all.
//
// Edges handled: everything is read live every frame (a level, a trim, a mute, a cleaned file, a
// piece deleted mid-play); players are made just before a piece starts and let go after it ends,
// since WebView2 only keeps a few media decoders going at once; a player that falls behind (a slow
// start, a stalled decode) is put back in step; the end holds the lines there, and play again starts
// over; another player starting (the timeline, a panel's preview) stops it.

import { convertFileSrc } from "@tauri-apps/api/core";
import type { AudioFx } from "./audioFx";
import { dbToGain, gainDbAt, hasAutomation, type GainPoint } from "./audioAutomation";
import { fadeLevel, NO_FADES, type PieceFades } from "./audioJoins";
import { resumeMixer, setElementGain, syncElementFx } from "./mixerGraph";
import { claimPlayback, registerPlayback, setPreviewHead } from "./previewHead";

export interface AuditionPiece {
  id: string;
  // The file it plays now (its cleaned one, or the original while "hold" is held).
  src: string;
  startTime: number;
  endTime: number;
  trimStart: number;
  volume: number;
  // Its fades as played - its own and its joins' (audioJoins.ts).
  fades?: PieceFades;
  gain?: GainPoint[];
  fx?: AudioFx;
  // Muted, or silenced by another strip's solo.
  silenced: boolean;
}

export interface AuditionState {
  playing: boolean;
  time: number; // seconds from the selection's start
  from: number; // where the selection starts on the timeline
  length: number;
}

// A piece's player is made this long before it's due, so it's ready to start on time.
const PREPARE_SEC = 1.5;
// How far a playing piece may drift from the clock before it's put back.
const DRIFT_SEC = 0.12;
const RESEEK_SETTLE_MS = 400;

interface Player {
  el: HTMLAudioElement;
  src: string;
  seekedAt: number;
}

export class Audition {
  private time = 0;
  private playing = false;
  private startedAt = 0;
  private raf = 0;
  private lastPublished = 0;
  private readonly players = new Map<string, Player>();
  private readonly unregister: () => void;
  private disposed = false;

  constructor(
    private readonly ids: string[],
    private readonly getPieces: () => AuditionPiece[],
    private readonly onState: (state: AuditionState) => void
  ) {
    this.unregister = registerPlayback("audition", () => this.pause());
    this.tick();
  }

  private pieces(): AuditionPiece[] {
    return this.getPieces().filter((p) => this.ids.includes(p.id));
  }

  private span(pieces: AuditionPiece[]) {
    if (pieces.length === 0) return { from: 0, length: 0 };
    const from = Math.min(...pieces.map((p) => p.startTime));
    return { from, length: Math.max(...pieces.map((p) => p.endTime)) - from };
  }

  get isPlaying() {
    return this.playing;
  }

  play() {
    if (this.disposed) return;
    const { length } = this.span(this.pieces());
    if (length <= 0) return;
    // At the end, play again starts over.
    if (this.time >= length - 0.02) this.time = 0;
    claimPlayback("audition");
    resumeMixer();
    this.playing = true;
    this.startedAt = performance.now() - this.time * 1000;
    this.players.forEach((p) => (p.seekedAt = 0));
    this.schedule();
    this.publish(true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.players.forEach((p) => p.el.pause());
    this.tick();
    this.publish(true);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  // To `time` seconds from the selection's start - every piece follows.
  seek(time: number) {
    const { length } = this.span(this.pieces());
    this.time = Math.max(0, Math.min(length, time));
    if (this.playing) this.startedAt = performance.now() - this.time * 1000;
    // Every playing piece re-placed on the next frame.
    this.players.forEach((p) => {
      p.seekedAt = 0;
      p.el.pause();
    });
    this.tick();
    this.publish(true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.players.forEach((_, id) => this.release(id));
    this.ids.forEach((id) => setPreviewHead(id, null));
    this.unregister();
  }

  private schedule() {
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.playing || this.disposed) return;
      this.tick();
      this.publish(false);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private publish(now: boolean) {
    const t = performance.now();
    if (!now && t - this.lastPublished < 100) return;
    this.lastPublished = t;
    const { from, length } = this.span(this.pieces());
    this.onState({ playing: this.playing, time: Math.min(this.time, length), from, length });
  }

  private release(id: string) {
    const player = this.players.get(id);
    if (!player) return;
    player.el.pause();
    // Lets go of the decoder at once rather than whenever it's collected.
    player.el.removeAttribute("src");
    player.el.load();
    this.players.delete(id);
  }

  private player(piece: AuditionPiece): Player {
    let player = this.players.get(piece.id);
    if (player && player.src !== piece.src) {
      this.release(piece.id);
      player = undefined;
    }
    if (!player) {
      const el = new Audio();
      // Lets Web Audio read its samples (the mixer) - asset:// answers CORS.
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.src = convertFileSrc(piece.src);
      player = { el, src: piece.src, seekedAt: 0 };
      this.players.set(piece.id, player);
    }
    return player;
  }

  private tick() {
    if (this.disposed) return;
    const pieces = this.pieces();
    const { from, length } = this.span(pieces);
    if (this.playing) {
      this.time = (performance.now() - this.startedAt) / 1000;
      if (this.time >= length) {
        // The last piece is done: hold the lines at the end.
        this.time = length;
        this.playing = false;
        this.players.forEach((p) => p.el.pause());
        this.publish(true);
      }
    }
    // Pieces no longer in the edit (deleted mid-play) let go of.
    for (const id of [...this.players.keys()]) if (!pieces.some((p) => p.id === id)) this.release(id);
    for (const id of this.ids) if (!pieces.some((p) => p.id === id)) setPreviewHead(id, null);
    const leader = pieces.reduce<AuditionPiece | null>((a, p) => (!a || p.startTime < a.startTime ? p : a), null);
    const now = performance.now();
    for (const piece of pieces) {
      const offset = piece.startTime - from;
      const length = piece.endTime - piece.startTime;
      const local = this.time - offset;
      const inside = this.playing && local >= 0 && local < length;
      setPreviewHead(piece.id, {
        at: piece.trimStart + Math.max(0, Math.min(length, local)),
        playing: inside,
        visible: true,
        leads: piece === leader,
        seek: (sourceTime) => this.seek(offset + (sourceTime - piece.trimStart)),
      });
      const due = this.playing && local > -PREPARE_SEC && local < length;
      if (!due) {
        this.release(piece.id);
        continue;
      }
      const player = this.player(piece);
      const el = player.el;
      // Its mixer channel: effects, meters, the master bus.
      syncElementFx(el, `audition:${piece.id}`, piece.fx, true);
      const desired = piece.trimStart + Math.max(0, local);
      if (!inside) {
        // Waiting to come in: parked on its first sample, so it starts on time.
        if (!el.paused) el.pause();
        if (Math.abs(el.currentTime - piece.trimStart) > 0.05) el.currentTime = piece.trimStart;
        continue;
      }
      if (el.paused) {
        el.currentTime = desired;
        player.seekedAt = now;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - desired) > DRIFT_SEC && now - player.seekedAt > RESEEK_SETTLE_MS && !el.seeking) {
        el.currentTime = desired;
        player.seekedAt = now;
      }
      // Its level: volume, fades in and out, mute/solo - and its volume line, smoothly once it's
      // routed (folded into the volume, up to unity, until then).
      const envelope = fadeLevel(piece.fades ?? NO_FADES, local, length);
      const base = piece.silenced ? 0 : piece.volume * Math.max(0, Math.min(1, envelope));
      const gainAt = hasAutomation(piece) ? (t: number) => dbToGain(gainDbAt(piece.gain, t)) : null;
      if (setElementGain(el, gainAt) || !gainAt) el.volume = Math.max(0, Math.min(1, base));
      else el.volume = Math.max(0, Math.min(1, base * gainAt(el.currentTime)));
    }
  }
}
