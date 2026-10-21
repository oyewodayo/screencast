// utils/textReveal.ts
//
// Title animations that work letter by letter or word by word - typewriter, word-by-word, rise,
// scatter, blur-in, drop, spread, wave - rather than moving the whole box like fade/slide/pop do. One timing model shared by the live
// preview (VideoOverlayLayer's RevealText, per-character <span>s) and export
// (renderTextOverlayToPng drawing per character, sent as a frame sequence), so the title types
// on exactly the same way on screen and in the file.
//
// Text keeps its layout throughout: hidden characters still take their space, so nothing reflows
// as the line fills in.
import type { OverlayAnimation } from "./videoEditTypes";

export type TextReveal = "typewriter" | "words" | "rise" | "scatter" | "blur" | "drop" | "spread" | "wave";

const TEXT_REVEALS = new Set<string>(["typewriter", "words", "rise", "scatter", "blur", "drop", "spread", "wave"]);
export const isTextReveal = (animation: OverlayAnimation | undefined): animation is TextReveal => !!animation && TEXT_REVEALS.has(animation);

// How a title leaves: fade out, play its reveal backwards (un-type), or just cut at its end.
export type TextRevealExit = "fade" | "reverse" | "none";

// The reveal's controls (TextOverlay.reveal). Every field is optional - undefined is the default.
export interface TextRevealSettings {
  // Typewriter only: type a letter at a time or a whole word at a time. Default "letter".
  unit?: "letter" | "word";
  // Pace multiplier - 2 reveals twice as fast. Default 1.
  speed?: number;
  // Seconds into the overlay before the reveal starts. Default 0.
  delay?: number;
  // Typewriter only: show the typing caret. Default true.
  caret?: boolean;
  // Typewriter only: keep the caret blinking after the text has finished typing. Default false.
  caretHold?: boolean;
  // Default "fade".
  exit?: TextRevealExit;
  // Typewriter only: an uneven, human typing rhythm instead of a metronome. Default false.
  humanize?: boolean;
  // Typewriter only. Default "bar".
  caretStyle?: CaretStyle;
  // Words / rise / blur: where letters come in from. Default "below".
  from?: "below" | "above";
  // An accent line that draws itself under the title as it reveals, in this colour.
  underline?: string;
}

export type CaretStyle = "bar" | "block" | "underscore";

export const TEXT_REVEAL_SPEED_MIN = 0.25;
export const TEXT_REVEAL_SPEED_MAX = 4;
export const TEXT_REVEAL_EXIT_SEC = 0.35;
const WORD_IN_SEC = 0.35;
const CHAR_IN_SEC = 0.45;
const CARET_BLINK_SEC = 1;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  return 1 + (c1 + 1) * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const easeOutBounce = (t: number) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

const speedOf = (settings?: TextRevealSettings) => Math.max(TEXT_REVEAL_SPEED_MIN, Math.min(TEXT_REVEAL_SPEED_MAX, settings?.speed ?? 1));
const delayOf = (settings: TextRevealSettings | undefined, duration: number) => Math.max(0, Math.min(settings?.delay ?? 0, duration * 0.9));

// Word index for every character; whitespace belongs to the word before it.
function wordIndexes(text: string): { wordOf: number[]; words: number; wordEnds: number[] } {
  const wordOf: number[] = new Array(text.length);
  const wordEnds: number[] = [];
  let w = -1;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text[i]);
    if (!space && !inWord) w += 1;
    if (!space) wordEnds[w] = i + 1;
    inWord = !space;
    wordOf[i] = Math.max(0, w);
  }
  return { wordOf, words: Math.max(1, w + 1), wordEnds };
}

// The reveal's natural length at speed 1 - scales with the text.
function naturalSeconds(text: string, kind: TextReveal, settings?: TextRevealSettings): number {
  const chars = text.length;
  const { words } = wordIndexes(text);
  if (kind === "typewriter") return settings?.unit === "word" ? Math.max(0.3, words * 0.22) : Math.max(0.4, chars * 0.045);
  if (kind === "words") return Math.max(0.4, (words - 1) * 0.14 + WORD_IN_SEC);
  if (kind === "spread") return 0.9;
  if (kind === "scatter") return Math.max(0.7, chars * 0.025 + 0.55);
  if (kind === "drop") return Math.max(0.7, chars * 0.04 + 0.6);
  return Math.max(0.5, chars * 0.03 + CHAR_IN_SEC);
}

// Seconds the exit takes.
function exitSeconds(text: string, kind: TextReveal, duration: number, settings?: TextRevealSettings): number {
  const exit = settings?.exit ?? "fade";
  if (exit === "none") return 0;
  if (exit === "fade") return Math.min(TEXT_REVEAL_EXIT_SEC, duration * 0.25);
  // Un-typing runs faster than typing, and never takes more than 30% of the overlay.
  return Math.min((naturalSeconds(text, kind, settings) / speedOf(settings)) * 0.6, duration * 0.3);
}

// How long the text takes to fully appear: the pace you set, squeezed only if the overlay is too
// short for it - always leaving a quarter of the time between delay and exit to read the result.
export function textRevealSeconds(text: string, kind: TextReveal, duration: number, settings?: TextRevealSettings): number {
  const room = (duration - delayOf(settings, duration) - exitSeconds(text, kind, duration, settings)) * 0.75;
  return Math.max(0.1, Math.min(naturalSeconds(text, kind, settings) / speedOf(settings), room));
}

export interface CharState {
  opacity: number;
  // Vertical offset in em (positive = lower).
  dy: number;
  // Horizontal offset in em (positive = right). Undefined = 0.
  dx?: number;
  // Blur radius in em. Undefined = sharp.
  blur?: number;
}

export interface TextRevealState {
  char: (index: number) => CharState;
  // Typewriter caret sits just before this character index (text.length = after the last), or null.
  caretAt: number | null;
  // Exit fade multiplier for the whole title.
  fade: number;
  // Looks exactly like the finished title - nothing is moving.
  settled: boolean;
  // How much of the accent underline is drawn (0..1); 0 without one.
  underline: number;
  // A typewriter caret blinking after typing: true/false for its on/off phase, else null.
  blink: boolean | null;
}

// Deterministic pseudo-random in [0,1).
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// Letters shown at `progress` (0..1) with an uneven typing rhythm: each keystroke gets its own
// length (some quick, the odd hesitation), normalised so typing still ends right on time.
const humanCache = new Map<number, number[]>();
function humanShown(n: number, progress: number): number {
  if (progress >= 1) return n;
  let ends = humanCache.get(n);
  if (!ends) {
    const gaps = Array.from({ length: n }, (_, i) => 0.55 + hash(i * 3.3) * 0.9 + (hash(i * 7.1) > 0.9 ? 1.6 : 0));
    const total = gaps.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    ends = gaps.map((g) => (acc += g) / total);
    humanCache.set(n, ends);
    if (humanCache.size > 64) humanCache.delete(humanCache.keys().next().value!);
  }
  let shown = 0;
  while (shown < n && ends[shown] <= progress) shown++;
  return shown;
}

// The reveal's own picture at `p` seconds into revealing (p >= reveal = fully shown).
function revealAt(text: string, kind: TextReveal, p: number, reveal: number, settings?: TextRevealSettings): Pick<TextRevealState, "char" | "caretAt"> {
  const n = text.length;
  const dir = settings?.from === "above" ? -1 : 1;
  if (kind === "typewriter") {
    let shown: number;
    if (p >= reveal) shown = n;
    else if (settings?.unit === "word") {
      const { words, wordEnds } = wordIndexes(text);
      const k = Math.floor(clamp01(p / reveal) * words);
      shown = k <= 0 ? 0 : wordEnds[k - 1] ?? n;
    } else if (settings?.humanize) shown = humanShown(n, clamp01(p / reveal));
    else shown = Math.floor(clamp01(p / reveal) * n);
    return { char: (i) => ({ opacity: i < shown ? 1 : 0, dy: 0 }), caretAt: settings?.caret === false || p >= reveal ? null : shown };
  }

  if (kind === "words") {
    const { wordOf, words } = wordIndexes(text);
    const inSec = Math.min(WORD_IN_SEC, reveal);
    const stagger = words > 1 ? Math.max(0, reveal - inSec) / (words - 1) : 0;
    return {
      char: (i) => {
        const local = clamp01((p - wordOf[i] * stagger) / inSec);
        return { opacity: easeOutCubic(local), dy: (1 - easeOutCubic(local)) * 0.55 * dir };
      },
      caretAt: null,
    };
  }

  if (kind === "spread") {
    // The letters start pulled apart about the middle, soft, and close up into the word.
    const e = easeOutCubic(clamp01(p / reveal));
    const mid = (n - 1) / 2;
    return { char: (i) => ({ opacity: e, dy: 0, dx: (i - mid) * 0.6 * (1 - e), blur: 0.15 * (1 - e) }), caretAt: null };
  }

  if (kind === "scatter") {
    // Letters fly in from all around in a random order and settle into place.
    const inSec = Math.min(0.5, reveal);
    const spread = Math.max(0, reveal - inSec);
    return {
      char: (i) => {
        const local = clamp01((p - hash(i * 2.9) * spread) / inSec);
        const e = easeOutCubic(local);
        const a = hash(i * 3.1 + 7) * Math.PI * 2;
        return { opacity: clamp01(local * 3), dx: Math.cos(a) * 1.2 * (1 - e), dy: Math.sin(a) * 1.2 * (1 - e) };
      },
      caretAt: null,
    };
  }

  const inSec = Math.min(kind === "drop" ? 0.6 : CHAR_IN_SEC, reveal);
  const stagger = n > 1 ? Math.max(0, reveal - inSec) / (n - 1) : 0;
  return {
    char: (i) => {
      const local = clamp01((p - i * stagger) / inSec);
      switch (kind) {
        case "blur": {
          // Each letter rises a little out of a blur.
          const e = easeOutCubic(local);
          return { opacity: e, dy: (1 - e) * 0.35 * dir, blur: (1 - e) * 0.25 };
        }
        case "drop":
          // Falls from above and bounces to rest.
          return { opacity: clamp01(local * 4), dy: -(1 - easeOutBounce(local)) * 1.0 };
        case "wave":
          // Hops up and lands, one after another.
          return { opacity: clamp01(local * 3), dy: -Math.sin(Math.PI * local) * 0.45 };
        default:
          return { opacity: clamp01(local * 2.5), dy: local >= 1 ? 0 : (1 - easeOutBack(local)) * 0.8 * dir };
      }
    },
    caretAt: null,
  };
}

// The title's state `t` seconds into an overlay `duration` long.
export function textRevealState(text: string, kind: TextReveal, t: number, duration: number, settings?: TextRevealSettings): TextRevealState {
  const reveal = textRevealSeconds(text, kind, duration, settings);
  const delay = delayOf(settings, duration);
  const exit = settings?.exit ?? "fade";
  const exitLen = exitSeconds(text, kind, duration, settings);
  const local = t - delay;
  const leaving = exitLen > 0 && t > duration - exitLen;

  // Un-typing: the reveal played backwards over the exit window.
  const p = leaving && exit === "reverse" ? reveal * clamp01((duration - t) / exitLen) : local;
  const picture = revealAt(text, kind, p, reveal, settings);
  const fade = leaving && exit === "fade" ? clamp01((duration - t) / exitLen) : 1;

  // A held caret blinks on after typing finishes.
  let caretAt = picture.caretAt;
  const holding = kind === "typewriter" && settings?.caretHold && settings?.caret !== false && local >= reveal && !leaving;
  if (holding) caretAt = local % CARET_BLINK_SEC < CARET_BLINK_SEC / 2 ? text.length : null;

  // The underline sweeps in alongside the reveal (a beat behind), and back out on an un-type.
  const underline = settings?.underline ? easeOutCubic(clamp01((p - reveal * 0.25) / Math.max(0.2, reveal * 0.75))) : 0;

  return {
    ...picture,
    caretAt,
    fade,
    settled: local >= reveal && !leaving && !holding,
    underline,
    blink: holding ? caretAt !== null : null,
  };
}

// Export frame identity for a settled-or-blinking frame (see renderTextRevealFrames): frames with
// equal keys look the same.
export function textRevealFrameKey(state: TextRevealState, k: number): string {
  if (state.settled) return "still";
  if (state.blink !== null) return state.blink ? "caret-on" : "caret-off";
  return `f${k}`;
}
