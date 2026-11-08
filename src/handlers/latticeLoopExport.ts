// handlers/latticeLoopExport.ts
//
// Exports a "latticeGauge" node's auto-rotation as a seamless looping MP4 or GIF. Frames are
// rendered OFFLINE through the widget's own LatticeLoopRenderer (LatticeGaugeWidget.tsx) - each one
// at an exact loop phase, not screen-captured in real time - so the result has a perfectly even
// frame rate regardless of how busy the machine is (a screen recording may be running alongside),
// renders faster than real time, and the last frame flows back into the first with no visible seam:
// the rotation covers exactly one full cycle across the clip.
//
// MP4 goes through WebCodecs' VideoEncoder (hardware H.264 where available) and mp4-muxer; GIF
// through gifenc with a fresh 256-color palette per frame, which matters here - the lattice's teal
// links and red spheres shift in shading as they turn, and one shared palette bands visibly.
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { latticeLoopRenderers } from "../components/whiteboard/LatticeGaugeWidget";

export type LatticeLoopFormat = "mp4" | "gif";

export interface LatticeLoopOptions {
  format: LatticeLoopFormat;
  seconds: number;
  width: number;
  height: number;
  fps: number;
  background: string;
  // The caption card to burn into every frame, or null for none - the live widget draws it as a
  // DOM overlay the WebGL canvas doesn't contain.
  caption: { title: string; body: string } | null;
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// The caption card, drawn to match the widget's own overlay: a translucent white card in the
// bottom-left with a teal monospace heading and a gray body, scaled with the output size.
function drawCaption(ctx: CanvasRenderingContext2D, caption: { title: string; body: string }, width: number, height: number) {
  const scale = Math.max(1, Math.min(width, height) / 300);
  const titleSize = 10 * scale;
  const bodySize = 9.5 * scale;
  const pad = 7 * scale;
  const lineGap = 4 * scale;
  const bodyLines = caption.body ? caption.body.split("\n") : [];
  ctx.save();
  ctx.font = `600 ${titleSize}px ui-monospace, Consolas, monospace`;
  const titleW = caption.title ? ctx.measureText(caption.title).width : 0;
  ctx.font = `${bodySize}px ui-monospace, Consolas, monospace`;
  const bodyW = Math.max(0, ...bodyLines.map((l) => ctx.measureText(l).width));
  const boxW = Math.min(width * 0.9, Math.max(titleW, bodyW) + pad * 2);
  const boxH = pad * 2 + (caption.title ? titleSize : 0) + bodyLines.length * (bodySize + lineGap) + (caption.title && bodyLines.length ? lineGap : 0);
  const x = 8 * scale;
  const y = height - 8 * scale - boxH;
  ctx.fillStyle = "rgba(255,255,255,0.82)";
  ctx.beginPath();
  ctx.roundRect(x, y, boxW, boxH, 4 * scale);
  ctx.fill();
  ctx.textBaseline = "top";
  let cy = y + pad;
  if (caption.title) {
    ctx.font = `600 ${titleSize}px ui-monospace, Consolas, monospace`;
    ctx.fillStyle = "#0d9488";
    ctx.fillText(caption.title, x + pad, cy, boxW - pad * 2);
    cy += titleSize + lineGap;
  }
  ctx.font = `${bodySize}px ui-monospace, Consolas, monospace`;
  ctx.fillStyle = "#4b5563";
  for (const line of bodyLines) {
    ctx.fillText(line, x + pad, cy, boxW - pad * 2);
    cy += bodySize + lineGap;
  }
  ctx.restore();
}

// The first H.264 profile/level this machine's encoder accepts at this size - High 4.0 covers
// 1080p; Main and Baseline are fallbacks for encoders without High profile support.
async function pickAvcConfig(width: number, height: number, fps: number): Promise<VideoEncoderConfig> {
  const bitrate = Math.round(width * height * fps * 0.12);
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e028"]) {
    const config: VideoEncoderConfig = { codec, width, height, bitrate, framerate: fps };
    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported) return config;
  }
  throw new Error("This device can't encode H.264 video - try GIF instead.");
}

export async function exportLatticeLoop(nodeId: string, opts: LatticeLoopOptions, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const source = latticeLoopRenderers.get(nodeId);
  if (!source) throw new Error("The lattice isn't on screen - open its page and try again.");
  // H.264 needs even dimensions.
  const width = Math.max(16, Math.round(opts.width / 2) * 2);
  const height = Math.max(16, Math.round(opts.height / 2) * 2);
  const frameCount = Math.max(2, Math.round(opts.seconds * opts.fps));

  const composite = document.createElement("canvas");
  composite.width = width;
  composite.height = height;
  const ctx = composite.getContext("2d", { willReadFrequently: opts.format === "gif" });
  if (!ctx) throw new Error("Couldn't create a drawing surface for the export.");

  const drawFrame = (i: number) => {
    const phase = i / frameCount; // never reaches 1 - frame `frameCount` would duplicate frame 0
    const gl = source.frame(phase, i / opts.fps);
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(gl, 0, 0, width, height);
    if (opts.caption) drawCaption(ctx, opts.caption, width, height);
  };

  source.begin(width, height);
  try {
    if (opts.format === "gif") {
      const gif = GIFEncoder();
      // GIF delays are in centiseconds; gifenc takes milliseconds and rounds.
      const delay = 1000 / opts.fps;
      for (let i = 0; i < frameCount; i++) {
        if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
        drawFrame(i);
        const rgba = ctx.getImageData(0, 0, width, height).data;
        const palette = quantize(rgba, 256);
        gif.writeFrame(applyPalette(rgba, palette), width, height, { palette, delay, repeat: 0 });
        onProgress?.((i + 1) / frameCount);
        await yieldToUi();
      }
      gif.finish();
      return gif.bytes();
    }

    if (typeof VideoEncoder === "undefined") throw new Error("Video encoding isn't available here - try GIF instead.");
    const config = await pickAvcConfig(width, height, opts.fps);
    const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width, height, frameRate: opts.fps }, fastStart: "in-memory" });
    let encodeError: unknown = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => {
        encodeError = e;
      },
    });
    encoder.configure(config);
    const frameDuration = 1_000_000 / opts.fps;
    for (let i = 0; i < frameCount; i++) {
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (encodeError) throw encodeError;
      drawFrame(i);
      const frame = new VideoFrame(composite, { timestamp: Math.round(i * frameDuration), duration: Math.round(frameDuration) });
      encoder.encode(frame, { keyFrame: i % (opts.fps * 2) === 0 });
      frame.close();
      // Backpressure - don't let hundreds of frames pile up in the encoder's queue.
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4));
      onProgress?.((i + 1) / frameCount);
      await yieldToUi();
    }
    await encoder.flush();
    encoder.close();
    if (encodeError) throw encodeError;
    muxer.finalize();
    return new Uint8Array(muxer.target.buffer);
  } finally {
    source.end();
  }
}
