import { describe, expect, it } from "vitest";
import { encodeWav24 } from "./wavEncode";

describe("24-bit WAV", () => {
  it("writes a header that states its own length and format", () => {
    const wav = encodeWav24([new Float32Array([0, 0.5]), new Float32Array([-1])], 48000);
    const view = new DataView(wav.buffer);
    const text = (at: number) => String.fromCharCode(...wav.slice(at, at + 4));
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(24);
    expect(view.getUint32(40, true)).toBe(9); // 3 frames x 3 bytes
    expect(wav.length).toBe(44 + 9);
  });

  it("stores samples as signed 24-bit little-endian, clipped to full scale", () => {
    const wav = encodeWav24([new Float32Array([0.5, -1, 2])], 48000);
    const sample = (i: number) => {
      const at = 44 + i * 3;
      const v = wav[at] | (wav[at + 1] << 8) | (wav[at + 2] << 16);
      return v & 0x800000 ? v - 0x1000000 : v;
    };
    expect(sample(0)).toBe(Math.round(0.5 * 0x7fffff));
    expect(sample(1)).toBe(-0x800000);
    expect(sample(2)).toBe(0x7fffff);
  });
});
