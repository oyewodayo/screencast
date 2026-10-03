// utils/dictationText.ts
//
// The "smart" half of Docs dictation: turns one raw whisper transcript chunk into editor
// operations. Pure functions only (no editor/DOM access) so the rules are unit-testable - see
// dictationText.test.ts. useDocDictation.ts feeds every chunk through parseDictation() and then
// fitToContext() against the text already sitting before the insertion point.
//
// Three jobs:
//   1. Drop whisper's non-speech output - bracketed tags ("[BLANK_AUDIO]", "(music)") and the
//      handful of phrases the model is known to hallucinate on near-silence.
//   2. Spoken commands - "new paragraph", "comma", "scratch that", "bullet list", ... (English
//      only; in any other language the words pass through as text).
//   3. Joining chunks seamlessly - each chunk is transcribed on its own, so whisper treats it as a
//      fresh sentence (leading capital, trailing period). fitToContext() fixes spacing and the
//      leading capital against what precedes it.

export type DictationOp =
  | { kind: "text"; text: string }
  | { kind: "lineBreak" }
  | { kind: "paragraph" }
  | { kind: "bulletList" }
  | { kind: "orderedList" }
  | { kind: "heading"; level: 1 | 2 | 3 }
  | { kind: "normalText" }
  | { kind: "scratch" }
  | { kind: "undo" }
  | { kind: "stop" };

// Whole-chunk outputs whisper produces on silence/breathing/keyboard noise rather than speech.
const HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you for watching",
  "thanks for watching",
  "thank you so much for watching",
  "please subscribe",
  "bye",
  "okay",
  "so",
  "uh",
  "um",
  "hmm",
  "mm",
  "...",
]);

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripNonSpeech(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:[^)]*\b(?:music|applause|laughter|laughs|silence|noise|inaudible|blank_audio|coughs?|sighs?|breathing)\b[^)]*)\)/gi, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/[♪♫]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function isLikelyHallucination(text: string, speechMs: number): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return true;
  // Only short bursts get this treatment - "thank you" after five seconds of real speech is
  // genuinely what was said.
  return speechMs < 1500 && HALLUCINATIONS.has(norm);
}

// Whole-chunk commands: only recognised when the utterance is nothing but the command (so a
// sentence that merely mentions "bullet list" isn't hijacked).
const WHOLE_CHUNK_COMMANDS: [RegExp, DictationOp][] = [
  [/^(scratch that|delete that|delete last|remove that)$/, { kind: "scratch" }],
  [/^(undo|undo that)$/, { kind: "undo" }],
  [/^(stop dictation|stop listening|stop dictating|end dictation)$/, { kind: "stop" }],
  [/^(bullet list|bulleted list|start bullet list|bullet point|bullet points|new bullet)$/, { kind: "bulletList" }],
  [/^(numbered list|number list|start numbered list|ordered list)$/, { kind: "orderedList" }],
  [/^(heading|heading one|heading 1|title)$/, { kind: "heading", level: 1 }],
  [/^(heading two|heading 2|subheading|sub heading)$/, { kind: "heading", level: 2 }],
  [/^(heading three|heading 3)$/, { kind: "heading", level: 3 }],
  [/^(normal text|body text|plain text)$/, { kind: "normalText" }],
];

// Inline structure commands, split out of the running text. Whisper tends to wrap them in its own
// punctuation ("Done, new paragraph. Next item"), which the surrounding marks soak up - except a
// sentence-ending mark before the command, which belongs to the preceding sentence.
const BREAK_RE = /[,;:]?\s*\b(new paragraph|next paragraph|new line|next line|newline)\b[,.;:!?]?/gi;

// Spoken punctuation. `always` entries are unambiguous enough to convert anywhere; the others
// ("period", "colon", "dash") are real words, so they only convert at the end of the chunk or of a
// clause whisper already punctuated.
const PUNCTUATION: { words: string; mark: string; always: boolean; attach: "left" | "right" | "both" }[] = [
  { words: "question mark", mark: "?", always: true, attach: "left" },
  { words: "exclamation (?:mark|point)", mark: "!", always: true, attach: "left" },
  { words: "comma", mark: ",", always: true, attach: "left" },
  { words: "semicolon|semi colon", mark: ";", always: true, attach: "left" },
  { words: "ellipsis|dot dot dot", mark: "…", always: true, attach: "left" },
  { words: "open (?:quote|quotes|quotation mark)", mark: "“", always: true, attach: "right" },
  { words: "(?:close|end|unquote) ?(?:quote|quotes|quotation mark)?", mark: "”", always: false, attach: "left" },
  { words: "open (?:paren|parenthesis|bracket)", mark: "(", always: true, attach: "right" },
  { words: "close (?:paren|parenthesis|bracket)", mark: ")", always: true, attach: "left" },
  { words: "period|full stop", mark: ".", always: false, attach: "left" },
  { words: "colon", mark: ":", always: false, attach: "left" },
  { words: "em dash|long dash", mark: " — ", always: true, attach: "both" },
];

function applySpokenPunctuation(text: string): string {
  let out = text;
  for (const { words, mark, always, attach } of PUNCTUATION) {
    // Swallow whisper's own punctuation around the spoken word: "Hello, comma, world" -> "Hello, world".
    const lookahead = always ? "" : "(?=\\s*$|\\s*[.,;:!?])";
    const re = new RegExp(`[,.;:]?\\s*\\b(?:${words})\\b[,.;:]?${lookahead}`, "gi");
    out = out.replace(re, () => (attach === "left" ? `${mark}\u0000` : attach === "right" ? `\u0000${mark}` : mark));
  }
  return out
    .replace(/\s*\u0000([“(])/g, " $1") // opening marks: space before, none after
    .replace(/([“(])\s+/g, "$1")
    .replace(/\s*([?!,;:.…”)])\u0000/g, "$1") // closing marks hug the preceding word
    .replace(/\u0000/g, "")
    .replace(/\.{3,}/g, "…")
    .replace(/([?!,;:.…])(?=[^\s\d.…"'”)\]}])/g, "$1 ")
    .replace(/([.?!])[.]+/g, "$1")
    .replace(/,([.?!;:])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

// Normalises a chunk and splits it into ops. `commands: false` (non-English dictation) still
// splits on whisper's own line breaks but treats every word as text.
export function parseDictation(raw: string, { commands }: { commands: boolean }): DictationOp[] {
  const cleaned = stripNonSpeech(raw);
  if (!cleaned) return [];

  if (commands) {
    const whole = normalizeForMatch(cleaned);
    for (const [re, op] of WHOLE_CHUNK_COMMANDS) {
      if (re.test(whole)) return [op];
    }
  }

  const ops: DictationOp[] = [];
  const pushText = (segment: string) => {
    const text = (commands ? applySpokenPunctuation(segment) : segment).replace(/\s+/g, " ").trim();
    if (text) ops.push({ kind: "text", text });
  };

  // Whisper's own newlines separate its segments, not intended paragraphs - join them as a space.
  const flat = cleaned.replace(/\n+/g, " ");
  if (!commands) {
    pushText(flat);
    return ops;
  }

  let last = 0;
  for (const match of flat.matchAll(BREAK_RE)) {
    pushText(flat.slice(last, match.index));
    const word = match[1].toLowerCase();
    ops.push(word.includes("paragraph") ? { kind: "paragraph" } : { kind: "lineBreak" });
    last = (match.index ?? 0) + match[0].length;
  }
  pushText(flat.slice(last));
  return ops;
}

// Words whisper capitalises only because it thinks a chunk is a new sentence - safe to lowercase
// when the chunk actually continues one. Deliberately function words only: anything that could be
// a name stays as whisper wrote it.
const LOWERCASABLE = new Set(
  (
    "a an and are as at be because but by can could did do does for from had has have he her his how if in into is it its " +
    "just let like maybe more most my no not now of on or our out she should so some than that the their them then there " +
    "these they this those to too up was we were what when where which while who why will with would yeah yes you your also " +
    "after again all any before both each even here only other over same such through under until very well"
  ).split(" ")
);

// Adjusts one text op for the characters immediately before the insertion point (same block).
// `before` is "" at the start of a block.
export function fitToContext(text: string, before: string): string {
  if (!text) return text;
  const trimmedBefore = before.replace(/\s+$/, "");
  const sentenceStart = trimmedBefore === "" || /[.!?…:]["”')\]]*$/.test(trimmedBefore);
  let out = text;

  const first = out.match(/^([\p{L}']+)/u)?.[1] ?? "";
  if (sentenceStart) {
    out = out.charAt(0).toLocaleUpperCase() + out.slice(1);
  } else if (/^[\p{Lu}][\p{Ll}']*$/u.test(first) && LOWERCASABLE.has(first.toLowerCase())) {
    out = first.toLowerCase() + out.slice(first.length);
  }

  // Leading space unless we're at block start, after whitespace/opening bracket, or the chunk
  // begins with closing punctuation.
  const needsSpace = before !== "" && !/[\s(\[{“"'\-—/]$/.test(before) && !/^[.,;:!?…)\]}”]/.test(out);
  return needsSpace ? ` ${out}` : out;
}

// Whisper ends nearly every chunk with "." even when the speaker only paused mid-sentence. When
// the next chunk then starts with a lowercasable word, that period was wrong - this returns how
// many characters to strip from the end of `before` (0 or 1).
export function trailingPeriodToDrop(before: string, nextText: string): number {
  if (!/[\p{L}\p{N}]\.$/u.test(before)) return 0;
  // Abbreviations ("e.g.", "Dr.", "U.S.") keep their period.
  if (/(?:\b\p{L}\.){2,}$|\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc|Inc|Ltd|Jr|Sr)\.$/u.test(before)) return 0;
  const first = nextText.trim().match(/^([\p{L}']+)/u)?.[1] ?? "";
  if (!first || first === "I" || first.startsWith("I'")) return 0;
  // Only conjunction-ish continuations - "We" after a period is usually a genuine new sentence.
  return CONTINUATIONS.has(first.toLowerCase()) ? 1 : 0;
}

const CONTINUATIONS = new Set(["and", "but", "or", "because", "which", "than", "to", "of", "with", "for", "while", "whereas", "unless"]);

// Short context for whisper's --prompt: the tail of the text before the cursor, plus the title.
// Biases spelling of names/jargon already in the doc and tells the model the chunk is a
// continuation rather than a new document.
export function buildWhisperPrompt(title: string, precedingText: string): string {
  const tail = precedingText.replace(/\s+/g, " ").trim().slice(-600);
  const cleanTitle = title.trim();
  const parts = [];
  if (cleanTitle && !tail.includes(cleanTitle)) parts.push(`${cleanTitle}.`);
  if (tail) parts.push(tail);
  return parts.join(" ").trim();
}
