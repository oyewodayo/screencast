// utils/shortsFinder.ts
//
// "Make it a Short": finds the moments of a long recording that work on their own as a ~45 s
// vertical clip, from the word-timed transcript the Captions tool makes (and, when available, how
// loud the speech is). All local and deterministic - nothing leaves the machine.
//
// The talk is cut into sentences (punctuation from speech recognition, or a pause), every run of
// whole sentences that would last minSec..maxSec once tightened is a candidate, and each is scored
// on what makes a short work - judged the way an editor would:
//   - the opening: a question, a claim ("the biggest mistake...", "here's why..."), a number, "you";
//     not a back-reference ("and", "but", "it", "as I said") that needs the minutes before it;
//   - the ending: a finished sentence followed by a pause, ideally a takeaway ("that's why...");
//     not a thought that carries straight on into the next sentence ("...and", "because");
//   - focus: it keeps coming back to the same distinctive words (one idea, explained);
//   - delivery: words per second, louder-than-usual speech, vivid words; few fillers, no dead air.
// Each feature is standardised across all candidates of this recording (z-scores), so the weights
// mean the same for a slow lecture and a fast vlog. The best non-overlapping ones are returned,
// each with a hook title, the reasons it scored well and an optional teaser line (a cold open).
//
// Pure functions only - ShortsStudio owns transcription, loudness and the UI; shortsBuild.ts turns
// a moment into a timeline.
import type { TranscriptToken } from "./transcriptEdit";
import { normalizeWord } from "./transcriptEdit";
import { STOPWORDS, stem, titleCase, tokenize } from "./videoChapters";

export interface ShortsFinderOptions {
  // Length of the finished short (after pauses are tightened), seconds.
  minSec: number;
  maxSec: number;
  targetSec: number;
  // How many moments to return, best first (the first few are used, the rest are alternatives).
  limit: number;
}

// Most shorts that hold attention land around half a minute; up to a minute is fine for a strong one.
export const DEFAULT_SHORTS_OPTIONS: ShortsFinderOptions = { minSec: 20, maxSec: 60, targetSec: 34, limit: 9 };

export interface ShortMoment {
  // Stable for the same range, so a re-run keeps selections.
  id: string;
  // Output seconds on the timeline the moment was found on.
  start: number;
  end: number;
  // Estimated length once fillers and long pauses are taken out.
  estimatedSec: number;
  score: number;
  // Why it was picked, in words ("Opens with a question").
  reasons: string[];
  title: string;
  // The first sentence - what the viewer hears first.
  opening: string;
  // A short, punchy line from inside the moment to open on before it starts (cold open), or null.
  teaser: { start: number; end: number; text: string } | null;
}

// Loudness of the speech over an output range, in dB relative to the recording's typical speech
// level (0 = usual, +3 = noticeably louder), or null when unknown.
export type LoudnessProbe = (start: number, end: number) => number | null;

interface Sentence {
  first: number; // token indexes, inclusive
  last: number;
  start: number;
  end: number;
  text: string;
  words: string[]; // normalised
  terminal: boolean;
  question: boolean;
  pauseBefore: number;
  pauseAfter: number;
}

const TERMINAL = /[.!?…]["'”’)\]]*$/;
const CLAUSE_END = /[,;:—–-]["'”’)\]]*$/;
// Speech recognition often punctuates thinly - commas where a speaker clearly ended a sentence, no
// "?" on questions - so pauses decide too (the measured silences - withDetectedPauses - since word
// timings stretch over pauses): a sentence ends at a pause this long, punctuated or not...
const SENTENCE_PAUSE_SEC = 0.7;
// ... and a clause at a comma followed by at least this much silence.
const CLAUSE_PAUSE_SEC = 0.3;
// A question by its wording, for when recognition left off the "?".
const QUESTION_START = /^(why|how|what|when|where|who|which|do|does|did|is|are|can|could|should|would|will|have|has|ever|isn'?t|aren'?t|don'?t|doesn'?t)\b/;
const MAX_SENTENCE_WORDS = 45;
// Pauses longer than this are shortened to TIGHT_KEEP_SEC when the short is built (shortsBuild.ts).
export const TIGHT_MIN_PAUSE_SEC = 0.5;
export const TIGHT_KEEP_SEC = 0.25;
// Room kept before the first word and after the last.
export const LEAD_IN_SEC = 0.12;
export const TAIL_OUT_SEC = 0.35;

export function splitSentences(tokens: TranscriptToken[]): Sentence[] {
  // Where sentences end, and the silence after each word.
  const n = tokens.length;
  const pauseAfterTok = tokens.map((_, k) => tokens[k + 1]?.pauseBefore ?? 0);
  // Where speech really resumes after a moved break (output seconds), when the silence was measured.
  const resumeAt: (number | null)[] = tokens.map(() => null);
  const jumpAfter = tokens.map((tok, k) => {
    const next = tokens[k + 1];
    return !!next && (next.sourcePath !== tok.sourcePath || Math.abs(next.sourceStart - tok.sourceEnd) > 2);
  });
  const breakAfter = tokens.map(
    (tok, k) =>
      k === n - 1 ||
      TERMINAL.test(tok.text) ||
      pauseAfterTok[k] >= SENTENCE_PAUSE_SEC ||
      (CLAUSE_END.test(tok.text) && pauseAfterTok[k] >= CLAUSE_PAUSE_SEC) ||
      jumpAfter[k]
  );
  // Word timings drift by a word or two around a pause, so a silence can land just after the first
  // words of the next sentence ("...it usually is, why do | most people fail"). A pause that falls
  // one or two words after a comma or full stop belongs at that punctuation.
  for (let k = 0; k < n - 1; k++) {
    if (jumpAfter[k] || TERMINAL.test(tokens[k].text) || CLAUSE_END.test(tokens[k].text)) continue;
    if (!breakAfter[k] && pauseAfterTok[k] < CLAUSE_PAUSE_SEC) continue;
    for (let j = k - 1; j >= Math.max(0, k - 2); j--) {
      if (breakAfter[j]) break;
      if (TERMINAL.test(tokens[j].text) || CLAUSE_END.test(tokens[j].text)) {
        breakAfter[k] = false;
        breakAfter[j] = true;
        pauseAfterTok[j] = Math.max(pauseAfterTok[j], pauseAfterTok[k]);
        pauseAfterTok[k] = 0;
        const after = tokens[k + 1];
        if (after.pauseRange) resumeAt[j + 1] = after.outputStart - (after.sourceStart - after.pauseRange.end) - 0.05;
        break;
      }
    }
  }

  const sentences: Sentence[] = [];
  let first = 0;
  for (let k = 0; k < n; k++) {
    const tok = tokens[k];
    const next = tokens[k + 1];
    const jump = jumpAfter[k];
    if (!breakAfter[k] && k - first + 1 < MAX_SENTENCE_WORDS) continue;
    const slice = tokens.slice(first, k + 1);
    const text = slice.map((t) => t.text).join(" ").replace(/\s+/g, " ").trim();
    const words = slice.map((t) => normalizeWord(t.text)).filter((w) => w !== "");
    // The recording's last line ends cleanly but gets no extra credit for the silence after it
    // (it's as often "thanks for watching" as a conclusion).
    const pauseAfter = next ? (jump ? 1 : pauseAfterTok[k]) : 0.8;
    const punctuated = TERMINAL.test(tok.text);
    sentences.push({
      first,
      last: k,
      start: Math.max(tokens[first].outputStart, Math.min(resumeAt[first] ?? -Infinity, tokens[first].outputEnd - 0.1)),
      end: tok.outputEnd,
      text,
      words,
      // Finished: a full stop, or a clear pause after it.
      terminal: punctuated || pauseAfter >= SENTENCE_PAUSE_SEC,
      question: /\?["'”’)\]]*$/.test(tok.text) || (!punctuated && words.length >= 3 && words.length <= 14 && QUESTION_START.test(words[0] ?? "")),
      pauseBefore: first > 0 ? pauseAfterTok[first - 1] : tokens[first].pauseBefore,
      pauseAfter,
    });
    first = k + 1;
  }
  return sentences;
}

// ---- What an opening / ending sounds like ------------------------------------------------------

const HOOK_PATTERNS: RegExp[] = [
  /\bhere'?s (the|why|how|what|a|my|one)\b/,
  /\bthe (secret|trick|key|truth|problem|reason|mistake|biggest|best|worst|most|only|real|one thing|hardest|easiest|fastest)\b/,
  /\bmost people\b/,
  /\b(nobody|no one) (tells|talks|knows|realizes|realises)\b/,
  /^(stop|never|don'?t|forget|imagine|look|listen)\b/,
  /\bwhy (do|does|is|are|you|we|most|people|this|it)\b/,
  /\bhow (to|do|does|can|i|you|we)\b/,
  /\bwhat (if|happens|most|nobody|you|really)\b/,
  /\byou (need|should|have to|must|can'?t|won'?t|will never|probably)\b/,
  /\bif you('re| are| want| have)?\b/,
  /\bi (was wrong|learned|realized|realised|discovered|found out|never)\b/,
  /\b(mistakes?|myths?|lies?|wrong|truth)\b/,
  /\b(surprising|surprised|shocking|crazy|insane|incredible|unbelievable|game changer)\b/,
  /\b(\d+|two|three|four|five|six|seven|eight|nine|ten) (things|ways|steps|reasons|tips|mistakes|lessons|rules|signs|tricks)\b/,
  /\bthe (first|last) time\b/,
  /\bchanged? (my|your|the|everything)\b/,
];
const STRONG_CONNECTORS = new Set(["and", "but", "or", "because", "which", "also", "plus", "then", "anyway", "otherwise"]);
const BACK_PRONOUNS = new Set(["it", "it's", "its", "they", "they're", "them", "he", "she", "that", "that's", "those", "these", "there's"]);
const SOFT_OPENERS = new Set(["so", "okay", "ok", "yeah", "right", "well", "um", "uh", "alright"]);
const BACK_REFERENCES = /\b(as i (said|mentioned)|like i (said|mentioned)|i mentioned|we (saw|discussed|talked about) (earlier|before)|earlier|going back to|the previous|last time|as we saw|same thing)\b/;
const CONCLUSIONS: RegExp[] = [
  /\bthat'?s (why|how|what|the point|it|the key|the secret|the trick|all)\b/,
  /\bthe (point|lesson|takeaway|bottom line|key) is\b/,
  /\bwhich means\b/,
  /\bin (short|other words|the end)\b/,
  /\bremember\b/,
  /\band that'?s\b/,
  /\bso (always|never|next time)\b/,
];
// Wrapping up the video, not making a point - a short shouldn't end (or start) on these.
const SIGN_OFF = /\b(thanks? (you )?for (watching|listening)|see you (next|soon|in)|subscribe|that'?s (it|all) for (today|this week|now)|that was (mostly )?it|bye)\b/;
const CONTINUING = new Set(["and", "but", "because", "which", "or", "also", "plus", "then", "cause", "'cause"]);
const VIVID = new Set(
  (
    "amazing incredible crazy insane huge massive love hate wow important critical secret mistake never always best worst biggest " +
    "simple easy hard problem powerful surprising actually literally exactly finally everything nothing perfect terrible beautiful " +
    "brilliant dangerous impossible obvious ridiculous wild magic fail failed win won"
  ).split(" ")
);
const YOU = new Set(["you", "your", "you're", "yourself", "you've", "you'll"]);

const lower = (s: string) => s.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

function openingScore(s: Sentence): { score: number; hook: boolean } {
  const text = lower(s.text);
  let score = 0;
  let hooks = 0;
  for (const re of HOOK_PATTERNS) if (re.test(text)) hooks++;
  score += Math.min(3, hooks) * 0.6;
  if (s.question) score += 1;
  if (/\b\d+\b/.test(text)) score += 0.3;
  if (s.words.some((w) => YOU.has(w))) score += 0.3;
  const w0 = s.words[0] ?? "";
  if (STRONG_CONNECTORS.has(w0)) score -= 0.9;
  else if (BACK_PRONOUNS.has(w0)) score -= 0.5;
  else if (SOFT_OPENERS.has(w0)) score -= 0.15;
  if (BACK_REFERENCES.test(text)) score -= 0.8;
  if (s.words.length < 3) score -= 0.7;
  if (s.words.length > 30) score -= 0.3;
  if (SIGN_OFF.test(text)) score -= 1.2;
  if (s.pauseBefore >= 1) score += 0.3;
  return { score, hook: hooks > 0 || s.question };
}

function endingScore(s: Sentence, next: Sentence | undefined): { score: number; takeaway: boolean } {
  const text = lower(s.text);
  let score = s.terminal ? 0.6 : -0.8;
  if (s.pauseAfter >= 0.8) score += 0.4;
  if (s.pauseAfter >= 1.5) score += 0.2;
  const takeaway = CONCLUSIONS.some((re) => re.test(text));
  if (takeaway) score += 0.5;
  if (s.words.length < 3) score -= 0.3;
  // The thought carries on into the next sentence ("...and", "because") - unless a long pause
  // shows the speaker moved on.
  const n0 = next?.words[0];
  const movedOn = s.pauseAfter >= SENTENCE_PAUSE_SEC;
  if (n0 && CONTINUING.has(n0)) score -= movedOn ? 0.2 : 0.7;
  else if (n0 === "so" && !movedOn) score -= 0.3;
  if (SIGN_OFF.test(text)) score -= 1.2;
  return { score, takeaway };
}

// ---- Scoring -----------------------------------------------------------------------------------

interface Candidate {
  i: number; // first sentence
  j: number; // last sentence
  rawSec: number;
  tightSec: number;
  f: Record<Feature, number>;
  hook: boolean;
  takeaway: boolean;
}

type Feature = "opening" | "ending" | "focus" | "pace" | "loudness" | "vivid" | "you" | "fillers" | "deadAir";
const WEIGHTS: Record<Feature, number> = {
  opening: 1.5,
  ending: 1.2,
  focus: 1.0,
  pace: 0.5,
  loudness: 0.6,
  vivid: 0.4,
  you: 0.3,
  fillers: -0.4,
  deadAir: -0.3,
};
const FEATURES = Object.keys(WEIGHTS) as Feature[];
// The least spread a feature is standardised by, in its own units: a feature that barely varies
// in a recording (everyone at the same pace) must not have its noise blown up into a deciding
// difference. Focus is relative (a fraction of its mean, see below).
const MIN_SD: Record<Feature, number> = {
  opening: 0.25,
  ending: 0.25,
  focus: 0, // 10% of the mean
  pace: 0.15, // words per second
  loudness: 0.75, // dB
  vivid: 0.004, // per word
  you: 0.004,
  fillers: 0.004,
  deadAir: 0.01, // seconds per second
};

// Words too general to name what a moment is about.
const GENERIC = new Set(
  "every single time times thing things people way ways lot lots first last week day days year years today start end part bit kind sort point stuff fact case".split(" ")
);
const contentStem = (text: string): string | null => {
  const raw = tokenize(text);
  return raw && !STOPWORDS.has(raw) && !GENERIC.has(raw) && !/^\d+$/.test(raw) && raw.length > 2 ? stem(raw) : null;
};

export function findShortMoments(tokens: TranscriptToken[], loudness: LoudnessProbe | null, options: Partial<ShortsFinderOptions> = {}): ShortMoment[] {
  const opts = { ...DEFAULT_SHORTS_OPTIONS, ...options };
  const sentences = splitSentences(tokens);
  if (sentences.length === 0) return [];

  // Per-token running sums, so any window's totals are two lookups.
  const n = tokens.length;
  const stems = tokens.map((t) => contentStem(t.text));
  const prefix = (f: (t: TranscriptToken, k: number) => number) => {
    const out = new Float64Array(n + 1);
    tokens.forEach((t, k) => (out[k + 1] = out[k] + f(t, k)));
    return out;
  };
  const fillerSum = prefix((t) => (t.isFiller ? 1 : 0));
  const vividSum = prefix((t) => (VIVID.has(normalizeWord(t.text)) ? 1 : 0));
  const youSum = prefix((t) => (YOU.has(normalizeWord(t.text)) ? 1 : 0));
  // Pauses within a window (the first word's pause is before the window, so sums start at first+1).
  const deadSum = prefix((t) => Math.max(0, t.pauseBefore - 0.7));
  const removedSum = prefix((t) => (t.pauseBefore > TIGHT_MIN_PAUSE_SEC ? t.pauseBefore - TIGHT_KEEP_SEC : 0) + (t.isFiller ? t.outputEnd - t.outputStart : 0));
  const sumOver = (p: Float64Array, a: number, b: number) => p[b + 1] - p[a + 1];

  // How distinctive each word is: inverse document frequency over 30 s blocks of the whole talk.
  const BLOCK_SEC = 30;
  const df = new Map<string, number>();
  const blocks = new Map<number, Set<string>>();
  tokens.forEach((t, k) => {
    const s = stems[k];
    if (!s) return;
    const b = Math.floor(t.outputStart / BLOCK_SEC);
    let set = blocks.get(b);
    if (!set) blocks.set(b, (set = new Set()));
    set.add(s);
  });
  for (const set of blocks.values()) for (const s of set) df.set(s, (df.get(s) ?? 0) + 1);
  const nBlocks = Math.max(1, blocks.size);
  const idf = (s: string) => Math.log((nBlocks + 1) / ((df.get(s) ?? 0) + 0.5));

  const openings = sentences.map(openingScore);
  const endings = sentences.map((s, k) => endingScore(s, sentences[k + 1]));

  const candidates: Candidate[] = [];
  for (let i = 0; i < sentences.length; i++) {
    const tf = new Map<string, number>();
    let content = 0;
    let focusNum = 0;
    for (let j = i; j < sentences.length; j++) {
      const a = sentences[i];
      const b = sentences[j];
      // Grow the window's word counts by sentence j.
      for (let k = b.first; k <= b.last; k++) {
        const s = stems[k];
        if (!s) continue;
        const c = (tf.get(s) ?? 0) + 1;
        tf.set(s, c);
        content++;
        // Every repeat of a word adds its distinctiveness: one idea, explained, keeps its words.
        if (c >= 2) focusNum += idf(s);
      }
      const rawSec = b.end - a.start;
      if (rawSec > opts.maxSec * 2) break;
      const removed = sumOver(removedSum, a.first, b.last);
      const tightSec = rawSec - removed + LEAD_IN_SEC + TAIL_OUT_SEC;
      if (tightSec > opts.maxSec) break;
      if (tightSec < opts.minSec) continue;
      const words = b.last - a.first + 1;
      candidates.push({
        i,
        j,
        rawSec,
        tightSec,
        hook: openings[i].hook,
        takeaway: endings[j].takeaway,
        f: {
          opening: openings[i].score,
          ending: endings[j].score,
          focus: content > 0 ? focusNum / content : 0,
          pace: words / Math.max(1, tightSec),
          loudness: loudness?.(a.start, b.end) ?? 0,
          vivid: sumOver(vividSum, a.first - 1, b.last) / words,
          you: sumOver(youSum, a.first - 1, b.last) / words,
          fillers: sumOver(fillerSum, a.first - 1, b.last) / words,
          deadAir: sumOver(deadSum, a.first, b.last) / Math.max(1, rawSec),
        },
      });
    }
  }
  if (candidates.length === 0) return [];

  // Standardise each feature across this recording's candidates.
  const stats = Object.fromEntries(
    FEATURES.map((f) => {
      const vals = candidates.map((c) => c.f[f]);
      const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((x, y) => x + (y - mean) ** 2, 0) / vals.length);
      const floor = f === "focus" ? Math.abs(mean) * 0.1 : MIN_SD[f];
      return [f, { mean, sd: Math.max(sd, floor, 1e-9) }];
    })
  ) as Record<Feature, { mean: number; sd: number }>;
  const z = (c: Candidate, f: Feature) => (c.f[f] - stats[f].mean) / stats[f].sd;
  // Softly limited, so no one feature can outweigh the rest - but more is still always better.
  const soft = (v: number) => 2.5 * Math.tanh(v / 2.5);
  const scoreOf = (c: Candidate) => FEATURES.reduce((sum, f) => sum + WEIGHTS[f] * soft(z(c, f)), 0) - 0.6 * ((c.tightSec - opts.targetSec) / 15) ** 2;
  const scored = candidates.map((c) => ({ c, score: scoreOf(c) })).sort((x, y) => y.score - x.score);

  // The best ones that don't overlap each other.
  const picked: { c: Candidate; score: number }[] = [];
  for (const s of scored) {
    if (picked.length >= opts.limit) break;
    const a = sentences[s.c.i].start - 2;
    const b = sentences[s.c.j].end + 2;
    if (picked.some((p) => a < sentences[p.c.j].end && sentences[p.c.i].start < b)) continue;
    picked.push(s);
  }

  return picked.map(({ c, score }) => {
    const first = sentences[c.i];
    const last = sentences[c.j];
    const prevTok = tokens[first.first - 1];
    const nextTok = tokens[last.last + 1];
    // Lead in by a little - into the silence before it when there is one (the previous word's end is
    // no guide then: recognition stretches words over the pauses after them).
    const start = first.pauseBefore > 0 ? Math.max(0, first.start - Math.min(LEAD_IN_SEC, first.pauseBefore / 2)) : Math.max(prevTok ? prevTok.outputEnd : 0, first.start - LEAD_IN_SEC, 0);
    const end = Math.min(nextTok ? nextTok.outputStart - 0.05 : Infinity, last.end + TAIL_OUT_SEC);
    const inside = sentences.slice(c.i, c.j + 1);
    const topic = topicPhrase(tokens, stems, first.first, last.last, idf);
    const reasons: string[] = [];
    if (first.question) reasons.push("Opens with a question");
    else if (c.hook) reasons.push(`Strong hook: “${clipWords(first.text, 7)}”`);
    if (c.takeaway) reasons.push("Lands on a takeaway");
    else if (last.terminal && last.pauseAfter >= 0.8) reasons.push("Ends on a complete thought");
    if (z(c, "focus") > 1 && topic?.includes(" ")) reasons.push(`Stays on one idea: ${topic}`);
    if (z(c, "loudness") > 1) reasons.push("Energetic delivery");
    if (z(c, "pace") > 1 && z(c, "deadAir") < 0) reasons.push("Fast-paced, no dead air");
    if (z(c, "vivid") > 1.2) reasons.push("Vivid language");
    return {
      id: `${start.toFixed(2)}-${end.toFixed(2)}`,
      start,
      end,
      estimatedSec: c.tightSec,
      score,
      reasons: reasons.slice(0, 3),
      title: hookTitle(inside, topic),
      opening: first.text,
      teaser: pickTeaser(inside.slice(1), loudness),
    };
  });
}

function clipWords(text: string, n: number): string {
  const words = text.replace(/[.!?…,;:]+$/, "").split(/\s+/);
  return words.length > n ? `${words.slice(0, n).join(" ")}…` : words.join(" ");
}

// The moment's most distinctive repeated phrase (two-word phrases preferred), title-cased.
function topicPhrase(tokens: TranscriptToken[], stems: (string | null)[], a: number, b: number, idf: (s: string) => number): string | null {
  const m = new Map<string, { n: number; text: string; w: number }>();
  const add = (key: string, text: string, w: number) => {
    const e = m.get(key);
    if (e) e.n++;
    else m.set(key, { n: 1, text, w });
  };
  for (let k = a; k <= b; k++) {
    const s = stems[k];
    if (!s) continue;
    const raw = tokenize(tokens[k].text);
    add(s, raw, idf(s));
    const s2 = k < b ? stems[k + 1] : null;
    if (s2) add(`${s} ${s2}`, `${raw} ${tokenize(tokens[k + 1].text)}`, 1.6 * (idf(s) + idf(s2)) / 2);
  }
  let best: { score: number; text: string } | null = null;
  for (const v of m.values()) {
    if (v.n < 2) continue;
    const score = v.n * v.w;
    if (!best || score > best.score) best = { score, text: v.text };
  }
  return best ? titleCase(best.text) : null;
}

// A title for the top of the short: a short question or hook line from its opening, else its topic.
function hookTitle(inside: Sentence[], topic: string | null): string {
  const tidy = (text: string) => {
    let t = text.replace(/\s+/g, " ").trim();
    // Drop throat-clearing at the front ("So, okay, um ...") and a trailing full stop.
    t = t.replace(/^((so|okay|ok|well|um|uh|and|but|right|yeah|alright)[,.]?\s+)+/i, "");
    t = t.replace(/[.…,;:]+$/, "");
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  let best: { score: number; text: string } | null = null;
  inside.slice(0, 4).forEach((s, k) => {
    const words = s.words.length;
    if (words < 3 || words > 12) return;
    const o = openingScore(s);
    if (!o.hook) return;
    const score = o.score + (s.question ? 0.5 : 0) - k * 0.4 - Math.max(0, words - 9) * 0.1;
    let text = tidy(s.text);
    if (s.question && !/\?$/.test(text)) text += "?";
    if (!best || score > best.score) best = { score, text };
  });
  const picked = best as { score: number; text: string } | null;
  if (picked && picked.text.length <= 70) return picked.text;
  // A topic names a moment only when it's a phrase ("Public Speaking"); one word ("Useful") doesn't.
  if (topic && topic.includes(" ")) return topic;
  return clipWords(tidy(inside[0]?.text ?? ""), 8);
}

// A line to open on before the moment starts: short, complete, said with energy or vivid words.
function pickTeaser(sentences: Sentence[], loudness: LoudnessProbe | null): ShortMoment["teaser"] {
  let best: { score: number; s: Sentence } | null = null;
  for (const s of sentences) {
    const dur = s.end - s.start;
    if (dur < 1 || dur > 4.5 || s.words.length < 3 || s.words.length > 14 || !s.terminal) continue;
    const text = lower(s.text);
    let score = openingScore(s).score * 0.5;
    score += s.words.filter((w) => VIVID.has(w)).length * 0.4;
    if (CONCLUSIONS.some((re) => re.test(text))) score += 0.4;
    if (/!/.test(s.text)) score += 0.3;
    score += Math.max(0, Math.min(2, (loudness?.(s.start, s.end) ?? 0) / 3));
    if (!best || score > best.score) best = { score, s };
  }
  const picked = best as { score: number; s: Sentence } | null;
  if (!picked || picked.score < 0.6) return null;
  return { start: Math.max(0, picked.s.start - 0.08), end: picked.s.end + 0.15, text: picked.s.text };
}
