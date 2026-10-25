// utils/wavEncode.ts
//
// Mono 24-bit PCM WAV from the Record tab's float samples (VoiceRecorder.tsx) - lossless, with its
// length in the header (unlike MediaRecorder's WebM, which ffprobe and the timeline can't size
// without decoding the whole file), and 24-bit so a quietly set level keeps its resolution.

export function encodeWav24(chunks: Float32Array[], sampleRate: number): Uint8Array {
  const frames = chunks.reduce((n, c) => n + c.length, 0);
  const dataBytes = frames * 3;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 3, true); // byte rate
  view.setUint16(32, 3, true); // block align
  view.setUint16(34, 24, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  out.set(encodePcm24(chunks), 44);
  return out;
}

// Just the samples, as the 24-bit little-endian PCM that follows the header - for a file written a
// piece at a time (takeWriter.ts).
export function encodePcm24(chunks: Float32Array[]): Uint8Array {
  const frames = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(frames * 3);
  let at = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const v = Math.max(-1, Math.min(1, chunk[i]));
      const s = Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff);
      out[at++] = s & 0xff;
      out[at++] = (s >> 8) & 0xff;
      out[at++] = (s >> 16) & 0xff;
    }
  }
  return out;
}
