// utils/signatureBackground.ts
//
// Lifts a signature off its paper (DocSignatureStudio.tsx's Upload tab): a phone photo or scan of
// ink on paper becomes ink on transparency, ready to sit on a document's signing line.
//
// A flat "make white transparent" key fails on real photos - the paper is grey in one corner,
// shadowed by the phone in another, and warm under room light. So:
//   1. the paper's brightness is estimated locally: a coarse grid of bright percentiles (paper is
//      the brightest thing in any patch), smoothed and interpolated back up - a lighting map
//   2. each pixel's ink amount is how much darker it is than the paper *right there*
//   3. Otsu's method picks the ink/paper split from those amounts; a soft ramp around it keeps
//      anti-aliased stroke edges smooth instead of jagged; `strength` moves the split
//   4. specks (dust, paper grain, JPEG noise) - connected blobs far smaller than the strokes - go
//   5. the result is cropped to the ink
// The ink keeps its own colour (with the paper tint taken out) or is recoloured to a chosen ink.
// Works on ImageData in place of the DOM, so it's unit-testable and runs equally on a preview-size
// and a full-size copy.

export interface LiftAnalysis {
  width: number;
  height: number;
  rgba: Uint8ClampedArray; // the source pixels
  ink: Float32Array; // 0..1 how much darker than the local paper
  paper: Float32Array; // local paper luminance 0..1
  otsu: number; // the automatic split on `ink`
  alreadyTransparent: boolean;
}

export interface LiftOptions {
  strength: number; // 0..1, 0.5 = automatic; higher keeps fainter ink
  color: string | null; // "#rrggbb" to recolour the ink, null keeps its own colour
  despeckle: boolean;
}

const lum = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export function analyze(img: ImageData): LiftAnalysis {
  const { width: w, height: h, data } = img;
  const n = w * h;
  let transparent = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] < 250) transparent++;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    // Transparent pixels count as paper.
    L[i] = lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) * a + (1 - a);
  }

  // 1. Lighting map: 90th-percentile luminance per block, then two box blurs on the grid.
  const block = Math.max(8, Math.round(Math.max(w, h) / 40));
  const gw = Math.ceil(w / block);
  const gh = Math.ceil(h / block);
  let grid = new Float32Array(gw * gh);
  const hist = new Uint32Array(64);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      hist.fill(0);
      let count = 0;
      for (let y = gy * block; y < Math.min(h, (gy + 1) * block); y++)
        for (let x = gx * block; x < Math.min(w, (gx + 1) * block); x++) {
          hist[Math.min(63, Math.floor(L[y * w + x] * 64))]++;
          count++;
        }
      let acc = 0;
      let k = 63;
      for (; k > 0; k--) {
        acc += hist[k];
        if (acc >= count * 0.1) break;
      }
      grid[gy * gw + gx] = (k + 0.5) / 64;
    }
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = gx + dx;
            const y = gy + dy;
            if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
            // A block that's mostly ink reads darker than paper; let brighter neighbours win.
            s += grid[y * gw + x];
            c++;
          }
        next[gy * gw + gx] = Math.max(grid[gy * gw + gx], s / c);
      }
    grid = next;
  }
  const paper = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / block - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / block - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - x0;
      const top = grid[y0 * gw + x0] * (1 - tx) + grid[y0 * gw + x1] * tx;
      const bot = grid[y1 * gw + x0] * (1 - tx) + grid[y1 * gw + x1] * tx;
      paper[y * w + x] = Math.max(0.05, top * (1 - ty) + bot * ty);
    }
  }

  // 2. Ink amount relative to the local paper.
  const ink = new Float32Array(n);
  for (let i = 0; i < n; i++) ink[i] = Math.min(1, Math.max(0, 1 - L[i] / paper[i]));

  // 3. Otsu on the ink amounts (256 bins).
  const bins = new Float64Array(256);
  for (let i = 0; i < n; i++) bins[Math.min(255, Math.floor(ink[i] * 255))]++;
  let sumAll = 0;
  for (let k = 0; k < 256; k++) sumAll += k * bins[k];
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let split = 40;
  for (let k = 0; k < 256; k++) {
    wB += bins[k];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += k * bins[k];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      split = k;
    }
  }
  // Clean scans have almost no paper variance, which can push Otsu very low; keep a floor so
  // paper grain never counts as ink.
  const otsu = Math.max(0.08, Math.min(0.6, split / 255));
  return { width: w, height: h, rgba: data, ink, paper, otsu, alreadyTransparent: transparent > n * 0.05 };
}

const hexRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.replace("#", ""), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

// The lifted signature as RGBA (same size as the analysis) plus the ink's bounding box.
export function lift(a: LiftAnalysis, opts: LiftOptions): { data: Uint8ClampedArray; bounds: { left: number; top: number; right: number; bottom: number } | null } {
  const { width: w, height: h, ink, rgba, paper } = a;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  // strength 0.5 = the automatic split; 1 keeps ink half as dark, 0 needs twice the darkness.
  const t = a.otsu * Math.pow(2, (0.5 - opts.strength) * 2);
  const lo = t * 0.55;
  const hi = t * 1.25;
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v: number;
    if (a.alreadyTransparent) v = rgba[i * 4 + 3] / 255;
    else {
      const x = (ink[i] - lo) / (hi - lo);
      v = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
    }
    alpha[i] = v;
  }

  // 4. Despeckle: drop 8-connected blobs (alpha > 0.35) much smaller than the signature's strokes.
  if (opts.despeckle && !a.alreadyTransparent) {
    const label = new Int32Array(n).fill(-1);
    const sizes: number[] = [];
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (alpha[i] <= 0.35 || label[i] !== -1) continue;
      const id = sizes.length;
      let size = 0;
      stack.push(i);
      label[i] = id;
      while (stack.length) {
        const p = stack.pop() as number;
        size++;
        const px = p % w;
        const py = (p - px) / w;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = px + dx;
            const y = py + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const q = y * w + x;
            if (label[q] === -1 && alpha[q] > 0.35) {
              label[q] = id;
              stack.push(q);
            }
          }
      }
      sizes.push(size);
    }
    const biggest = sizes.reduce((m, s) => Math.max(m, s), 0);
    const minKeep = Math.max(6, Math.min(biggest * 0.02, n * 0.00015));
    for (let i = 0; i < n; i++) {
      const id = label[i];
      if (id >= 0 && sizes[id] < minKeep) alpha[i] = 0;
      // Faint halo pixels next to nothing kept: drop them too (no label = never above 0.35).
      else if (id === -1 && alpha[i] > 0 && alpha[i] < 0.35) {
        const x = i % w;
        const y = (i - x) / w;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1 && !near; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const l = label[yy * w + xx];
            if (l >= 0 && sizes[l] >= minKeep) near = true;
          }
        if (!near) alpha[i] = 0;
      }
    }
  }

  const tint = opts.color ? hexRgb(opts.color) : null;
  let left = w;
  let top = h;
  let right = -1;
  let bottom = -1;
  for (let i = 0; i < n; i++) {
    const av = alpha[i];
    if (av <= 0.02) continue;
    const o = i * 4;
    if (tint) {
      out[o] = tint[0];
      out[o + 1] = tint[1];
      out[o + 2] = tint[2];
    } else {
      // The ink's own colour with the paper's light divided out, then deepened a touch - ink on a
      // photo reads washed out once the bright paper around it is gone.
      const p = Math.max(0.2, paper[i]);
      for (let c = 0; c < 3; c++) out[o + c] = Math.min(255, Math.max(0, (rgba[o + c] / p) * 0.82));
    }
    out[o + 3] = Math.round(av * 255);
    const x = i % w;
    const y = (i - x) / w;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return { data: out, bounds: right < 0 ? null : { left, top, right, bottom } };
}
