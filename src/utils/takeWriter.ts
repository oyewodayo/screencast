// utils/takeWriter.ts
//
// A take written to disk while it's being recorded (the Record tab, VoiceRecorder.tsx) - never held
// whole in memory, so a five-hour take costs what a five-second one does, and a crash keeps
// everything up to the last second (the file's header is kept valid as it grows - audio_stream.rs).
// Samples are batched to about a second, encoded as 24-bit PCM and appended in order.
//
// TakeTrail: the take's waveform as it's spoken, in at most MAX_BARS bars however long it runs -
// pairs merge when it fills, so drawing it stays as cheap at hour five as at second five.

import { invoke } from "@tauri-apps/api/core";
import { encodePcm24 } from "./wavEncode";

export class TakeWriter {
  private pending: Float32Array[] = [];
  private pendingLength = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly opened: Promise<{ id: number; path: string }>;
  private error: string | null = null;
  samples = 0;

  constructor(
    name: string,
    private readonly sampleRate: number
  ) {
    this.opened = invoke<{ id: number; path: string }>("wav_writer_open", { name, channels: 1, sampleRate, bits: 24 });
    this.opened.catch((e) => (this.error ??= String(e)));
  }

  get failed(): string | null {
    return this.error;
  }

  push(samples: Float32Array) {
    this.pending.push(samples);
    this.pendingLength += samples.length;
    this.samples += samples.length;
    if (this.pendingLength >= this.sampleRate) this.flush();
  }

  private flush() {
    if (this.pendingLength === 0) return;
    const bytes = encodePcm24(this.pending);
    this.pending = [];
    this.pendingLength = 0;
    this.queue = this.queue
      .then(async () => {
        const { id } = await this.opened;
        await invoke("wav_writer_append", bytes, { headers: { "x-writer-id": String(id) } });
      })
      .catch((e) => {
        this.error ??= String(e);
      });
  }

  // Everything written, the file finished - its path.
  async close(): Promise<string> {
    this.flush();
    await this.queue;
    const { id } = await this.opened;
    if (this.error) {
      await invoke("wav_writer_discard", { id }).catch(() => {});
      throw new Error(this.error);
    }
    return invoke<string>("wav_writer_close", { id });
  }

  // Too short to keep, or abandoned: the file goes.
  async discard() {
    this.pending = [];
    this.pendingLength = 0;
    await this.queue.catch(() => {});
    const opened = await this.opened.catch(() => null);
    if (opened) await invoke("wav_writer_discard", { id: opened.id }).catch(() => {});
  }
}

const MAX_BARS = 2048;

export class TakeTrail {
  readonly bars: number[] = [];
  // How many incoming batches each bar covers - doubles each time the bars are halved.
  private perBar = 1;
  private current = 0;
  private filled = 0;

  push(peak: number) {
    if (peak > this.current) this.current = peak;
    if (++this.filled < this.perBar) return;
    this.bars.push(this.current);
    this.current = 0;
    this.filled = 0;
    if (this.bars.length >= MAX_BARS) {
      for (let i = 0; i < MAX_BARS / 2; i++) this.bars[i] = Math.max(this.bars[2 * i], this.bars[2 * i + 1]);
      this.bars.length = MAX_BARS / 2;
      this.perBar *= 2;
    }
  }
}
