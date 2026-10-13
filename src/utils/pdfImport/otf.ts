// utils/pdfImport/otf.ts
//
// A small OpenType reader for the fonts pdf.js extracts from a PDF (always converted to OpenType,
// usually CFF-flavoured "OTTO"): the PostScript name (to know a font is LMRoman10-Bold or CMMI9),
// the character map and advance widths (to place every character of a text run exactly), and real
// glyph bounding boxes from the CFF outlines (to know how tall a summation sign or a radical
// actually is). The PDF importer's layout and equation reconstruction run on these numbers, so they
// come from the font itself rather than guesses from the font size.

export interface GlyphBox {
  // In font units; y up.
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

export interface OtfFont {
  postscriptName: string;
  familyName: string;
  unitsPerEm: number;
  ascender: number;
  descender: number;
  glyphId(codePoint: number): number;
  // Every glyph reachable through the character map (size variants of TeX's delimiters included).
  glyphIds(): number[];
  advance(gid: number): number;
  box(gid: number): GlyphBox | null;
  // The glyph's own name in the font program ("summationdisplay", "parenleftbig") - what a glyph is
  // when the PDF's text layer can't say (TeX's extension fonts often have no Unicode mapping).
  glyphName(gid: number): string | null;
}

class Reader {
  constructor(
    public dv: DataView,
    public bytes: Uint8Array
  ) {}
  u8(o: number) {
    return this.dv.getUint8(o);
  }
  u16(o: number) {
    return this.dv.getUint16(o);
  }
  i16(o: number) {
    return this.dv.getInt16(o);
  }
  u32(o: number) {
    return this.dv.getUint32(o);
  }
}

function tableDirectory(r: Reader): Map<string, { off: number; len: number }> {
  const n = r.u16(4);
  const out = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < n; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(r.u8(rec), r.u8(rec + 1), r.u8(rec + 2), r.u8(rec + 3));
    out.set(tag, { off: r.u32(rec + 8), len: r.u32(rec + 12) });
  }
  return out;
}

function readNames(r: Reader, off: number): Map<number, string> {
  const count = r.u16(off + 2);
  const strOff = off + r.u16(off + 4);
  const names = new Map<number, string>();
  for (let j = 0; j < count; j++) {
    const rec = off + 6 + j * 12;
    const platform = r.u16(rec);
    const nameId = r.u16(rec + 6);
    const len = r.u16(rec + 8);
    const o = strOff + r.u16(rec + 10);
    if (names.has(nameId)) continue;
    let s = "";
    if (platform === 3 || platform === 0) for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(r.u16(o + k));
    else for (let k = 0; k < len; k++) s += String.fromCharCode(r.u8(o + k));
    names.set(nameId, s);
  }
  return names;
}

function readCmap(r: Reader, off: number): Map<number, number> {
  const map = new Map<number, number>();
  const num = r.u16(off + 2);
  // Prefer Unicode subtables; format 12 (full range) beats format 4 (BMP).
  const subtables: { format: number; at: number }[] = [];
  for (let i = 0; i < num; i++) {
    const platform = r.u16(off + 4 + i * 8);
    const encoding = r.u16(off + 4 + i * 8 + 2);
    const at = off + r.u32(off + 4 + i * 8 + 4);
    if (platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10 || encoding === 0))) subtables.push({ format: r.u16(at), at });
  }
  subtables.sort((a, b) => (a.format === 12 ? -1 : 0) - (b.format === 12 ? -1 : 0));
  for (const { format, at } of subtables) {
    if (format === 4) {
      const segX2 = r.u16(at + 6);
      const ends = at + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const rangeOffsets = deltas + segX2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = r.u16(ends + s * 2);
        const start = r.u16(starts + s * 2);
        const delta = r.i16(deltas + s * 2);
        const ro = r.u16(rangeOffsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let gid: number;
          if (ro === 0) gid = (c + delta) & 0xffff;
          else {
            const addr = rangeOffsets + s * 2 + ro + (c - start) * 2;
            const g = r.u16(addr);
            gid = g === 0 ? 0 : (g + delta) & 0xffff;
          }
          if (gid && !map.has(c)) map.set(c, gid);
        }
      }
    } else if (format === 12) {
      const groups = r.u32(at + 12);
      for (let g = 0; g < groups; g++) {
        const rec = at + 16 + g * 12;
        const start = r.u32(rec);
        const end = r.u32(rec + 4);
        const gid0 = r.u32(rec + 8);
        for (let c = start; c <= end; c++) if (!map.has(c)) map.set(c, gid0 + c - start);
      }
    }
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// CFF

interface CffIndex {
  count: number;
  item(i: number): [number, number]; // [start, end) absolute offsets
  end: number;
}

function readIndex(r: Reader, off: number): CffIndex {
  const count = r.u16(off);
  if (count === 0) return { count: 0, item: () => [0, 0], end: off + 2 };
  const offSize = r.u8(off + 2);
  const offAt = (i: number) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = v * 256 + r.u8(off + 3 + i * offSize + k);
    return v;
  };
  const dataBase = off + 3 + (count + 1) * offSize - 1;
  return { count, item: (i) => [dataBase + offAt(i), dataBase + offAt(i + 1)], end: dataBase + offAt(count) };
}

function readDict(r: Reader, start: number, end: number): Map<number, number[]> {
  const dict = new Map<number, number[]>();
  let operands: number[] = [];
  let i = start;
  while (i < end) {
    const b0 = r.u8(i);
    if (b0 <= 21) {
      let op = b0;
      i++;
      if (b0 === 12) op = 1200 + r.u8(i++);
      dict.set(op, operands);
      operands = [];
    } else if (b0 === 28) {
      operands.push(r.i16(i + 1));
      i += 3;
    } else if (b0 === 29) {
      operands.push(r.dv.getInt32(i + 1));
      i += 5;
    } else if (b0 === 30) {
      // real number, nibble-encoded
      let s = "";
      i++;
      for (;;) {
        const b = r.u8(i++);
        const nibbles = [b >> 4, b & 15];
        let done = false;
        for (const n of nibbles) {
          if (n === 15) {
            done = true;
            break;
          }
          s += n < 10 ? String(n) : n === 10 ? "." : n === 11 ? "E" : n === 12 ? "E-" : n === 14 ? "-" : "";
        }
        if (done) break;
      }
      operands.push(parseFloat(s));
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      i++;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + r.u8(i + 1) + 108);
      i += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - r.u8(i + 1) - 108);
      i += 2;
    } else i++;
  }
  return dict;
}

function subrBias(count: number): number {
  return count < 1240 ? 107 : count < 33900 ? 1131 : 32768;
}

interface CffFont {
  charStrings: CffIndex;
  globalSubrs: CffIndex;
  localSubrs: (gid: number) => CffIndex;
  glyphName: (gid: number) => string | null;
}

// CFF charset: glyph id -> string id; ids from 391 name the font's own strings (TeX's glyph names
// are all there). Formats 0 (one SID per glyph), 1 and 2 (ranges). Predefined charsets and the
// standard strings below 391 aren't needed for maths and give null.
function readCharsetNames(r: Reader, cffOff: number, charsetOff: number | undefined, nGlyphs: number, strings: CffIndex): (gid: number) => string | null {
  if (charsetOff === undefined || charsetOff <= 2) return () => null;
  const sids = new Array<number>(nGlyphs).fill(0);
  const at = cffOff + charsetOff;
  const format = r.u8(at);
  // The spec leaves .notdef (glyph 0) out of the charset; some writers (pdf.js's Type 1 -> CFF
  // conversion among them) include it with string id 0, which shifts every name by one otherwise.
  let gid = r.u16(at + 1) === 0 ? 0 : 1;
  let p = at + 1;
  if (format === 0) {
    for (; gid < nGlyphs; gid++, p += 2) sids[gid] = r.u16(p);
  } else if (format === 1 || format === 2) {
    while (gid < nGlyphs) {
      const first = r.u16(p);
      const nLeft = format === 1 ? r.u8(p + 2) : r.u16(p + 2);
      p += format === 1 ? 3 : 4;
      for (let k = 0; k <= nLeft && gid < nGlyphs; k++) sids[gid++] = first + k;
    }
  }
  const decoder = new TextDecoder("latin1");
  return (g: number) => {
    const sid = sids[g];
    if (!sid || sid < 391 || sid - 391 >= strings.count) return null;
    const [a, b] = strings.item(sid - 391);
    return decoder.decode(r.bytes.subarray(a, b));
  };
}

function readCff(r: Reader, off: number): CffFont | null {
  const hdrSize = r.u8(off + 2);
  const nameIndex = readIndex(r, off + hdrSize);
  const topIndex = readIndex(r, nameIndex.end);
  const stringIndex = readIndex(r, topIndex.end);
  const globalSubrs = readIndex(r, stringIndex.end);
  if (topIndex.count === 0) return null;
  const [ts, te] = topIndex.item(0);
  const top = readDict(r, ts, te);
  const csOff = top.get(17)?.[0];
  if (csOff === undefined) return null;
  const charStrings = readIndex(r, off + csOff);
  const glyphName = readCharsetNames(r, off, top.get(15)?.[0], charStrings.count, stringIndex);
  const privSubrs = (priv: number[] | undefined): CffIndex => {
    if (!priv || priv.length < 2) return { count: 0, item: () => [0, 0], end: 0 };
    const [size, pOff] = priv;
    const pd = readDict(r, off + pOff, off + pOff + size);
    const subrs = pd.get(19)?.[0];
    return subrs === undefined ? { count: 0, item: () => [0, 0], end: 0 } : readIndex(r, off + pOff + subrs);
  };
  const fdArrayOff = top.get(1236)?.[0];
  if (fdArrayOff !== undefined) {
    // CID-keyed: each glyph's local subrs come from its font dict.
    const fdArray = readIndex(r, off + fdArrayOff);
    const fdSubrs: CffIndex[] = [];
    for (let k = 0; k < fdArray.count; k++) {
      const [a, b] = fdArray.item(k);
      fdSubrs.push(privSubrs(readDict(r, a, b).get(18)));
    }
    const fdSelectOff = top.get(1237)?.[0];
    const fdOf = (gid: number): number => {
      if (fdSelectOff === undefined) return 0;
      const at = off + fdSelectOff;
      const format = r.u8(at);
      if (format === 0) return r.u8(at + 1 + gid);
      if (format === 3) {
        const nRanges = r.u16(at + 1);
        for (let k = 0; k < nRanges; k++) {
          const first = r.u16(at + 3 + k * 3);
          const next = r.u16(at + 3 + (k + 1) * 3);
          if (gid >= first && gid < next) return r.u8(at + 3 + k * 3 + 2);
        }
      }
      return 0;
    };
    return { charStrings, globalSubrs, localSubrs: (gid) => fdSubrs[fdOf(gid)] ?? fdSubrs[0], glyphName };
  }
  const local = privSubrs(top.get(18));
  return { charStrings, globalSubrs, localSubrs: () => local, glyphName };
}

// Type 2 charstring interpreter that only tracks the outline's bounding box.
function charStringBox(r: Reader, cff: CffFont, gid: number): GlyphBox | null {
  if (gid >= cff.charStrings.count) return null;
  let x = 0;
  let y = 0;
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  let stack: number[] = [];
  let nStems = 0;
  let haveWidth = false;
  let open = false;
  const local = cff.localSubrs(gid);
  const lBias = subrBias(local.count);
  const gBias = subrBias(cff.globalSubrs.count);
  const point = (px: number, py: number) => {
    if (px < xMin) xMin = px;
    if (px > xMax) xMax = px;
    if (py < yMin) yMin = py;
    if (py > yMax) yMax = py;
  };
  const curve = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
    const x0 = x;
    const y0 = y;
    // Exact extremes would need roots; sampling the cubic is within a fraction of a unit here.
    for (let k = 1; k <= 8; k++) {
      const t = k / 8;
      const mt = 1 - t;
      point(mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3, mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3);
    }
    x = x3;
    y = y3;
  };
  const moveTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    open = true;
    point(x, y);
  };
  const lineTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    point(x, y);
  };
  const takeWidth = (expectedArgs: number, even: boolean) => {
    if (haveWidth) return;
    haveWidth = true;
    if (even ? stack.length % 2 === 1 : stack.length > expectedArgs) stack.shift();
  };
  let depth = 0;
  const run = (start: number, end: number): boolean => {
    if (++depth > 12) return false;
    let i = start;
    while (i < end) {
      const b0 = r.u8(i);
      if (b0 >= 32 || b0 === 28) {
        if (b0 === 28) {
          stack.push(r.i16(i + 1));
          i += 3;
        } else if (b0 <= 246) {
          stack.push(b0 - 139);
          i++;
        } else if (b0 <= 250) {
          stack.push((b0 - 247) * 256 + r.u8(i + 1) + 108);
          i += 2;
        } else if (b0 <= 254) {
          stack.push(-(b0 - 251) * 256 - r.u8(i + 1) - 108);
          i += 2;
        } else {
          stack.push(r.dv.getInt32(i + 1) / 65536);
          i += 5;
        }
        continue;
      }
      i++;
      switch (b0) {
        case 1: // hstem
        case 3: // vstem
        case 18: // hstemhm
        case 23: // vstemhm
          takeWidth(0, true);
          nStems += stack.length >> 1;
          stack = [];
          break;
        case 19: // hintmask
        case 20: // cntrmask
          takeWidth(0, true);
          nStems += stack.length >> 1;
          stack = [];
          i += (nStems + 7) >> 3;
          break;
        case 21: // rmoveto
          takeWidth(2, false);
          moveTo(x + stack[0], y + stack[1]);
          stack = [];
          break;
        case 22: // hmoveto
          takeWidth(1, false);
          moveTo(x + stack[0], y);
          stack = [];
          break;
        case 4: // vmoveto
          takeWidth(1, false);
          moveTo(x, y + stack[0]);
          stack = [];
          break;
        case 5: // rlineto
          for (let k = 0; k + 1 < stack.length; k += 2) lineTo(x + stack[k], y + stack[k + 1]);
          stack = [];
          break;
        case 6: // hlineto
        case 7: {
          // vlineto
          let horizontal = b0 === 6;
          for (const d of stack) {
            if (horizontal) lineTo(x + d, y);
            else lineTo(x, y + d);
            horizontal = !horizontal;
          }
          stack = [];
          break;
        }
        case 8: // rrcurveto
          for (let k = 0; k + 5 < stack.length; k += 6) {
            const x1 = x + stack[k];
            const y1 = y + stack[k + 1];
            const x2 = x1 + stack[k + 2];
            const y2 = y1 + stack[k + 3];
            curve(x1, y1, x2, y2, x2 + stack[k + 4], y2 + stack[k + 5]);
          }
          stack = [];
          break;
        case 24: {
          // rcurveline
          let k = 0;
          for (; k + 5 < stack.length - 2; k += 6) {
            const x1 = x + stack[k];
            const y1 = y + stack[k + 1];
            const x2 = x1 + stack[k + 2];
            const y2 = y1 + stack[k + 3];
            curve(x1, y1, x2, y2, x2 + stack[k + 4], y2 + stack[k + 5]);
          }
          lineTo(x + stack[k], y + stack[k + 1]);
          stack = [];
          break;
        }
        case 25: {
          // rlinecurve
          let k = 0;
          for (; k + 1 < stack.length - 6; k += 2) lineTo(x + stack[k], y + stack[k + 1]);
          const x1 = x + stack[k];
          const y1 = y + stack[k + 1];
          const x2 = x1 + stack[k + 2];
          const y2 = y1 + stack[k + 3];
          curve(x1, y1, x2, y2, x2 + stack[k + 4], y2 + stack[k + 5]);
          stack = [];
          break;
        }
        case 26: {
          // vvcurveto
          let k = 0;
          let dx1 = 0;
          if (stack.length % 4 === 1) dx1 = stack[k++];
          for (; k + 3 < stack.length; k += 4) {
            const x1 = x + dx1;
            const y1 = y + stack[k];
            const x2 = x1 + stack[k + 1];
            const y2 = y1 + stack[k + 2];
            curve(x1, y1, x2, y2, x2, y2 + stack[k + 3]);
            dx1 = 0;
          }
          stack = [];
          break;
        }
        case 27: {
          // hhcurveto
          let k = 0;
          let dy1 = 0;
          if (stack.length % 4 === 1) dy1 = stack[k++];
          for (; k + 3 < stack.length; k += 4) {
            const x1 = x + stack[k];
            const y1 = y + dy1;
            const x2 = x1 + stack[k + 1];
            const y2 = y1 + stack[k + 2];
            curve(x1, y1, x2, y2, x2 + stack[k + 3], y2);
            dy1 = 0;
          }
          stack = [];
          break;
        }
        case 30: // vhcurveto
        case 31: {
          // hvcurveto
          let horizontal = b0 === 31;
          let k = 0;
          while (k + 3 < stack.length) {
            const last = stack.length - k === 5;
            if (horizontal) {
              const x1 = x + stack[k];
              const y1 = y;
              const x2 = x1 + stack[k + 1];
              const y2 = y1 + stack[k + 2];
              const y3 = y2 + stack[k + 3];
              const x3 = x2 + (last ? stack[k + 4] : 0);
              curve(x1, y1, x2, y2, x3, y3);
            } else {
              const x1 = x;
              const y1 = y + stack[k];
              const x2 = x1 + stack[k + 1];
              const y2 = y1 + stack[k + 2];
              const x3 = x2 + stack[k + 3];
              const y3 = y2 + (last ? stack[k + 4] : 0);
              curve(x1, y1, x2, y2, x3, y3);
            }
            k += last ? 5 : 4;
            horizontal = !horizontal;
          }
          stack = [];
          break;
        }
        case 10: {
          // callsubr
          const n = stack.pop()! + lBias;
          if (n < 0 || n >= local.count) return false;
          const [a, b] = local.item(n);
          if (!run(a, b)) return false;
          break;
        }
        case 29: {
          // callgsubr
          const n = stack.pop()! + gBias;
          if (n < 0 || n >= cff.globalSubrs.count) return false;
          const [a, b] = cff.globalSubrs.item(n);
          if (!run(a, b)) return false;
          break;
        }
        case 11: // return
          depth--;
          return true;
        case 14: // endchar
          takeWidth(0, false);
          depth = -100;
          return true;
        case 12: {
          // escape: flex ops and arithmetic; flex draws two curves
          const b1 = r.u8(i++);
          const s = stack;
          if (b1 === 35) {
            curve(x + s[0], y + s[1], x + s[0] + s[2], y + s[1] + s[3], x + s[0] + s[2] + s[4], y + s[1] + s[3] + s[5]);
            curve(x + s[6], y + s[7], x + s[6] + s[8], y + s[7] + s[9], x + s[6] + s[8] + s[10], y + s[7] + s[9] + s[11]);
          } else if (b1 === 34) {
            const y0 = y;
            curve(x + s[0], y, x + s[0] + s[1], y + s[2], x + s[0] + s[1] + s[3], y + s[2]);
            curve(x + s[4], y, x + s[4] + s[5], y0, x + s[4] + s[5] + s[6], y0);
          } else if (b1 === 36) {
            const y0 = y;
            curve(x + s[0], y + s[1], x + s[0] + s[2], y + s[1] + s[3], x + s[0] + s[2] + s[4], y + s[1] + s[3]);
            curve(x + s[5], y, x + s[5] + s[6], y + s[7], x + s[5] + s[6] + s[8], y0);
          } else if (b1 === 37) {
            const sx = x;
            const sy = y;
            const x1 = x + s[0];
            const y1 = y + s[1];
            const x2 = x1 + s[2];
            const y2 = y1 + s[3];
            const x3 = x2 + s[4];
            const y3 = y2 + s[5];
            curve(x1, y1, x2, y2, x3, y3);
            const x4 = x + s[6];
            const y4 = y + s[7];
            const x5 = x4 + s[8];
            const y5 = y4 + s[9];
            const dx = x5 - sx;
            const dy = y5 - sy;
            if (Math.abs(dx) > Math.abs(dy)) curve(x4, y4, x5, y5, x5 + s[10], sy);
            else curve(x4, y4, x5, y5, sx, y5 + s[10]);
          }
          stack = [];
          break;
        }
        default:
          stack = [];
      }
      if (depth < 0) return true;
    }
    depth--;
    return true;
  };
  const [a, b] = cff.charStrings.item(gid);
  run(a, b);
  if (!open || !Number.isFinite(xMin)) return null;
  return { xMin, yMin, xMax, yMax };
}

export function readOtf(bytes: Uint8Array): OtfFont | null {
  try {
    const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes);
    const tables = tableDirectory(r);
    const head = tables.get("head");
    const hhea = tables.get("hhea");
    const hmtx = tables.get("hmtx");
    const cmapT = tables.get("cmap");
    if (!head || !hhea || !hmtx || !cmapT) return null;
    const unitsPerEm = r.u16(head.off + 18) || 1000;
    const ascender = r.i16(hhea.off + 4);
    const descender = r.i16(hhea.off + 6);
    const numberOfHMetrics = r.u16(hhea.off + 34);
    const names = tables.get("name") ? readNames(r, tables.get("name")!.off) : new Map<number, string>();
    const cmap = readCmap(r, cmapT.off);
    const cffT = tables.get("CFF ");
    const cff = cffT ? readCff(r, cffT.off) : null;
    const glyf = tables.get("glyf");
    const loca = tables.get("loca");
    const longLoca = r.i16(head.off + 50) === 1;
    const boxCache = new Map<number, GlyphBox | null>();
    const ps = (names.get(6) ?? names.get(4) ?? "").replace(/^[A-Z]{6}\+/, "");
    return {
      postscriptName: ps,
      familyName: names.get(1) ?? ps,
      unitsPerEm,
      ascender,
      descender,
      glyphId: (cp) => cmap.get(cp) ?? 0,
      glyphIds: () => [...new Set(cmap.values())],
      advance: (gid) => {
        const idx = Math.min(gid, numberOfHMetrics - 1);
        return r.u16(hmtx.off + idx * 4);
      },
      box: (gid) => {
        if (boxCache.has(gid)) return boxCache.get(gid)!;
        let box: GlyphBox | null = null;
        if (cff) box = charStringBox(r, cff, gid);
        else if (glyf && loca) {
          const at = longLoca ? r.u32(loca.off + gid * 4) : r.u16(loca.off + gid * 2) * 2;
          const next = longLoca ? r.u32(loca.off + gid * 4 + 4) : r.u16(loca.off + gid * 2 + 2) * 2;
          if (next > at) box = { xMin: r.i16(glyf.off + at + 2), yMin: r.i16(glyf.off + at + 4), xMax: r.i16(glyf.off + at + 6), yMax: r.i16(glyf.off + at + 8) };
        }
        boxCache.set(gid, box);
        return box;
      },
      glyphName: (gid) => (cff ? cff.glyphName(gid) : null),
    };
  } catch {
    return null;
  }
}
