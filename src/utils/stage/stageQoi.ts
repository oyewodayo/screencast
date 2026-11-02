// utils/stage/stageQoi.ts
//
// QOI ("Quite OK Image") encoding of a Stage export frame: premultiplied RGBA as WebGL reads it (rows
// bottom first) in, a straight-alpha, top-first QOI file out - byte for byte what Rust's
// pixel_convert::qoi_from_premultiplied writes. Lossless, decoded by ffmpeg, and on flat motion
// graphics tens of kilobytes a 1080p frame. Run in workers by stageQoiWorker.ts.

export function qoiFromPremultiplied(src: Uint8Array, width: number, height: number): Uint8Array {
  // Worst case: every pixel a 5-byte RGBA op, plus header and end marker.
  const out = new Uint8Array(width * height * 5 + 22);
  const view = new DataView(out.buffer);
  out.set([0x71, 0x6f, 0x69, 0x66]); // "qoif"
  view.setUint32(4, width);
  view.setUint32(8, height);
  out[12] = 4;
  out[13] = 0;
  let o = 14;
  const index = new Uint32Array(64);
  let pr = 0, pg = 0, pb = 0, pa = 255;
  let prev = 0x000000ff;
  let run = 0;
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    let i = (height - 1 - y) * row;
    const end = i + row;
    for (; i < end; i += 4) {
      const a = src[i + 3];
      let r: number, g: number, b: number;
      if (a === 255) {
        r = src[i];
        g = src[i + 1];
        b = src[i + 2];
      } else if (a === 0) {
        r = g = b = 0;
      } else {
        const h = a >> 1;
        r = Math.min(255, ((src[i] * 255 + h) / a) | 0);
        g = Math.min(255, ((src[i + 1] * 255 + h) / a) | 0);
        b = Math.min(255, ((src[i + 2] * 255 + h) / a) | 0);
      }
      const px = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
      if (px === prev) {
        if (++run === 62) {
          out[o++] = 0xc0 | 61;
          run = 0;
        }
        continue;
      }
      if (run > 0) {
        out[o++] = 0xc0 | (run - 1);
        run = 0;
      }
      const slot = (r * 3 + g * 5 + b * 7 + a * 11) % 64;
      if (index[slot] === px) {
        out[o++] = slot;
      } else {
        index[slot] = px;
        if (a === pa) {
          const vr = ((r - pr + 384) % 256) - 128;
          const vg = ((g - pg + 384) % 256) - 128;
          const vb = ((b - pb + 384) % 256) - 128;
          const vgr = vr - vg;
          const vgb = vb - vg;
          if (vr > -3 && vr < 2 && vg > -3 && vg < 2 && vb > -3 && vb < 2) {
            out[o++] = 0x40 | ((vr + 2) << 4) | ((vg + 2) << 2) | (vb + 2);
          } else if (vg > -33 && vg < 32 && vgr > -9 && vgr < 8 && vgb > -9 && vgb < 8) {
            out[o++] = 0x80 | (vg + 32);
            out[o++] = ((vgr + 8) << 4) | (vgb + 8);
          } else {
            out[o++] = 0xfe;
            out[o++] = r;
            out[o++] = g;
            out[o++] = b;
          }
        } else {
          out[o++] = 0xff;
          out[o++] = r;
          out[o++] = g;
          out[o++] = b;
          out[o++] = a;
        }
      }
      prev = px;
      pr = r;
      pg = g;
      pb = b;
      pa = a;
    }
  }
  if (run > 0) out[o++] = 0xc0 | (run - 1);
  out.set([0, 0, 0, 0, 0, 0, 0, 1], o);
  o += 8;
  return out.slice(0, o);
}
