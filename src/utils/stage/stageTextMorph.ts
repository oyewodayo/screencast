// utils/stage/stageTextMorph.ts
//
// Which letters of a text are "the same letters" from one beat to the next, so a change of wording
// morphs instead of cutting: words the two texts share keep their identity and glide to where they
// sit now, words that are new arrive, words that are gone leave. "Lid closed." becoming "Lid
// closed. Still running." keeps "Lid closed." still while "Still running." writes on beside it.
//
// Words are matched whole (a longest common subsequence of the two word lists, so a repeated word
// pairs with the right one); a glyph is a grapheme - an emoji, or a letter with its accents, counts
// as one, never split into the code units JavaScript strings index by.

// Intl.Segmenter (Chromium and Node both have it; this project's TypeScript lib predates its types).
type GraphemeSegmenter = { segment(text: string): Iterable<{ segment: string }> };
const SegmenterCtor = (Intl as unknown as { Segmenter?: new (locale: undefined, options: { granularity: "grapheme" }) => GraphemeSegmenter }).Segmenter;
const segmenter = SegmenterCtor ? new SegmenterCtor(undefined, { granularity: "grapheme" }) : null;

// Splitting is slow and the same few texts are split over and over while a scene compiles.
const graphemeCache = new Map<string, string[]>();
const GRAPHEME_CACHE_MAX = 4096;

export function graphemes(text: string): string[] {
  const hit = graphemeCache.get(text);
  if (hit) return hit;
  const out = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
  if (graphemeCache.size >= GRAPHEME_CACHE_MAX) graphemeCache.clear();
  graphemeCache.set(text, out);
  return out;
}

// Where each grapheme starts in the string's code units - colour runs index code units.
export function graphemeOffsets(gs: string[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const g of gs) {
    out.push(at);
    at += g.length;
  }
  return out;
}

export interface Token {
  // Grapheme range [start, end).
  start: number;
  end: number;
  text: string;
}

// Runs of non-space graphemes - words, with their punctuation attached.
export function tokenize(gs: string[]): Token[] {
  const tokens: Token[] = [];
  let start = -1;
  for (let i = 0; i <= gs.length; i++) {
    const space = i === gs.length || /^\s+$/u.test(gs[i]);
    if (!space && start < 0) start = i;
    if (space && start >= 0) {
      tokens.push({ start, end: i, text: gs.slice(start, i).join("") });
      start = -1;
    }
  }
  return tokens;
}

// Pairs [i in a, j in b] of equal words, in order - a longest common subsequence.
export function matchTokens(a: Token[], b: Token[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const len: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i][j] = a[i].text === b[j].text ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (len[i + 1][j] >= len[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

export interface GlyphAssignment {
  // Per text, an id for each of its graphemes (spaces get none - they're never drawn).
  ids: (string | null)[][];
  // Per text, for each word: whether it's new in that text (wasn't in the one before).
  fresh: boolean[][];
  tokens: Token[][];
}

// Ids for the letters of a sequence of texts such that a letter keeps its id for as long as its word
// survives from one text to the next. A word that comes back after being dropped takes back the ids
// it had (oldest first) - it looks the same as a new word once it has faded out, slides back if it
// hadn't yet, and keeps a text whose wording alternates from piling up letters.
export function assignGlyphIds(texts: string[]): GlyphAssignment {
  const ids: (string | null)[][] = [];
  const fresh: boolean[][] = [];
  const tokens: Token[][] = [];
  let prevTokens: Token[] = [];
  let prevIds: (string | null)[] = [];
  // Dropped words' ids, by word.
  const retired = new Map<string, string[][]>();
  texts.forEach((text, k) => {
    const gs = graphemes(text);
    const toks = tokenize(gs);
    const own: (string | null)[] = new Array(gs.length).fill(null);
    const isFresh = toks.map(() => true);
    const matched = matchTokens(prevTokens, toks);
    const pairs = new Map(matched.map(([i, j]) => [j, i]));
    // Words of the previous text that this one dropped.
    const kept = new Set(matched.map(([i]) => i));
    prevTokens.forEach((tok, i) => {
      if (kept.has(i)) return;
      const list = retired.get(tok.text) ?? [];
      list.push(prevIds.slice(tok.start, tok.end) as string[]);
      retired.set(tok.text, list);
    });
    toks.forEach((tok, j) => {
      const from = pairs.get(j);
      const revived = from === undefined ? retired.get(tok.text)?.shift() : undefined;
      for (let g = tok.start; g < tok.end; g++) {
        own[g] = from !== undefined ? prevIds[prevTokens[from].start + (g - tok.start)] : revived ? revived[g - tok.start] : `${k}:${j}:${g - tok.start}`;
      }
      if (from !== undefined) isFresh[j] = false;
    });
    ids.push(own);
    fresh.push(isFresh);
    tokens.push(toks);
    prevTokens = toks;
    prevIds = own;
  });
  return { ids, fresh, tokens };
}
