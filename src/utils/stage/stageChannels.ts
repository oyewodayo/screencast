// utils/stage/stageChannels.ts
//
// Values that run with time rather than jumping beat to beat: a clock ticking through the night, a
// battery draining, a counter climbing. A channel is keyframed against the scene's own time; an
// element can follow one directly (a bar's width), show it in its text ("{clock:time}" reads 11:42
// PM), or change when it crosses a threshold (red below 20%, a new message once the clock passes
// 3:10). Those crossings are found once at compile time, so the engine springs into the change at
// the exact moment it happens - the same frame in the preview and the export.
import { KeyframeEasing, easeKeyframe } from "../keyframes";

export interface StageChannelKey {
  t: number;
  value: number;
  // How the value travels from this key to the next.
  easing?: KeyframeEasing;
}

export interface StageChannel {
  id: string;
  name?: string;
  keys: StageChannelKey[];
  // How the editor shows and reads it, and the format live text uses by default.
  format?: StageValueFormat;
}

// int: 42 · pct: 42% · fixed1/fixed2: 42.0 / 42.00 · time: minutes after midnight as 11:42 PM
// (wrapping past midnight) · clock24: 23:42 · duration: seconds as 1:02:03 (or 2:03 under an hour).
export type StageValueFormat = "int" | "pct" | "fixed1" | "fixed2" | "time" | "clock24" | "duration";

const sortedKeys = new WeakMap<StageChannel, StageChannelKey[]>();
const keysOf = (c: StageChannel) => {
  let k = sortedKeys.get(c);
  if (!k) {
    k = c.keys.filter((key) => Number.isFinite(key.t) && Number.isFinite(key.value)).sort((a, b) => a.t - b.t);
    sortedKeys.set(c, k);
  }
  return k;
};

export function channelValue(channel: StageChannel, t: number): number {
  const keys = keysOf(channel);
  if (keys.length === 0) return 0;
  if (t <= keys[0].t) return keys[0].value;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.value;
  let i = 0;
  while (t >= keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const e = easeKeyframe(a.easing ?? "linear", (t - a.t) / Math.max(1e-6, b.t - a.t));
  return a.value + (b.value - a.value) * e;
}

// Whether the value is changing at `t` - what decides if a bound element needs redrawing.
export function channelMoving(channel: StageChannel, t: number): boolean {
  const keys = keysOf(channel);
  for (let i = 0; i + 1 < keys.length; i++) {
    if (t >= keys[i].t && t < keys[i + 1].t) return keys[i].value !== keys[i + 1].value && keys[i].easing !== "hold";
  }
  return false;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatValue(value: number, format: StageValueFormat | undefined): string {
  if (!Number.isFinite(value)) return "";
  switch (format) {
    case "pct":
      return `${Math.round(value)}%`;
    case "fixed1":
      return value.toFixed(1);
    case "fixed2":
      return value.toFixed(2);
    case "time":
    case "clock24": {
      const minutes = ((Math.floor(value) % 1440) + 1440) % 1440;
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      if (format === "clock24") return `${pad2(h)}:${pad2(m)}`;
      return `${h % 12 === 0 ? 12 : h % 12}:${pad2(m)} ${h < 12 ? "AM" : "PM"}`;
    }
    case "duration": {
      const total = Math.max(0, Math.floor(value));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
    }
    default:
      return String(Math.round(value));
  }
}

const TEMPLATE = /\{([A-Za-z0-9_-]+)(?::([a-z0-9]+))?\}/g;

// Whether `text` shows any of these channels' values.
export function hasTemplate(text: string | undefined, channels: Map<string, StageChannel>): boolean {
  if (!text) return false;
  for (const m of text.matchAll(TEMPLATE)) if (channels.has(m[1])) return true;
  return false;
}

// `text` with each {channel} / {channel:format} replaced by its value at `t`; unknown names stay as typed.
export function fillTemplate(text: string, channels: Map<string, StageChannel>, t: number): string {
  return text.replace(TEMPLATE, (whole, id: string, fmt: string | undefined) => {
    const c = channels.get(id);
    // No format named: the value's own (how the editor shows it).
    return c ? formatValue(channelValue(c, t), (fmt as StageValueFormat | undefined) ?? c.format) : whole;
  });
}

// The moments in [from, to] where the channel crosses `threshold` - found by stepping at 1/240s
// and narrowing each crossing down to well under a frame.
export function channelCrossings(channel: StageChannel, threshold: number, from: number, to: number): number[] {
  const out: number[] = [];
  const step = 1 / 240;
  const side = (t: number) => channelValue(channel, t) < threshold;
  let prevT = from;
  let prev = side(from);
  for (let t = from + step; t <= to + step / 2; t += step) {
    const tt = Math.min(t, to);
    const cur = side(tt);
    if (cur !== prev) {
      let lo = prevT;
      let hi = tt;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        if (side(mid) === prev) lo = mid;
        else hi = mid;
      }
      out.push(hi);
      prev = cur;
    }
    prevT = tt;
  }
  return out;
}
