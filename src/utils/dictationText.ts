// utils/dictationText.ts
//
// The "smart" half of Docs dictation: turns one raw whisper transcript chunk into editor
// operations. Pure functions only (no editor/DOM access) so the rules are unit-testable - see
// dictationText.test.ts. useDocDictation.ts feeds every chunk through parseDictation() and then
// fitToContext() against the text already sitting before the insertion point.
//
// Four jobs:
//   1. Drop whisper's non-speech output - bracketed tags ("[BLANK_AUDIO]", "(music)"), known
//      silence/YouTube hallucinations, repetition loops, and screen-text echoes where whisper
//      regurgitates the document title or prompt on silence.
//   2. Spoken commands - structure ("new paragraph", "next bullet", "heading 1 Project Plan"),
//      inline editing ("bold that", "highlight that", "delete last word", "redo"), tables
//      ("insert 3 by 2 table", "next cell", "next row"), checklists ("checklist", "check that"),
//      and alignment ("align center") (English only; in other languages words pass through as text).
//   3. Smart auto-formatting - spoken email addresses ("john at gmail dot com" -> "john@gmail.com"),
//      scientific/typographic symbols ("plus or minus" -> "±", "degrees celsius" -> "°C"),
//      and hesitation filler/stutter cleanup ("um", "uh", "the the" -> "the").
//   4. Joining chunks seamlessly - each chunk is transcribed on its own, so whisper treats it as a
//      fresh sentence (leading capital, trailing period). fitToContext() fixes spacing and the
//      leading capital against what precedes it.

export type DictationFormatKind =
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "code"
  | "highlight"
  | "uppercase"
  | "lowercase"
  | "titlecase";

export type DictationAlignKind = "left" | "center" | "right" | "justify";

export type DictationOp =
  | { kind: "text"; text: string }
  | { kind: "lineBreak" }
  | { kind: "paragraph" }
  | { kind: "bulletList" }
  | { kind: "orderedList" }
  | { kind: "taskList" }
  | { kind: "checkItem"; checked?: boolean }
  | { kind: "listItem" }
  | { kind: "heading"; level: 1 | 2 | 3 }
  | { kind: "normalText" }
  | { kind: "blockquote" }
  | { kind: "horizontalRule" }
  | { kind: "pageBreak" }
  | { kind: "insertTable"; rows: number; cols: number }
  | { kind: "tableNav"; direction: "next" | "prev" | "row" }
  | { kind: "formatLast"; format: DictationFormatKind; color?: string }
  | { kind: "align"; alignment: DictationAlignKind }
  | { kind: "deleteWord"; count?: number }
  | { kind: "deleteSentence" }
  | { kind: "scratch" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "stop" };

export interface HallucinationContext {
  title?: string;
  precedingText?: string;
}

// Whole-chunk outputs whisper produces on silence/breathing/keyboard noise rather than speech.
const HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you for watching",
  "thanks for watching",
  "thank you so much for watching",
  "thanks for listening",
  "thank you for listening",
  "thank you very much",
  "please subscribe",
  "like and subscribe",
  "subscribe to my channel",
  "don't forget to subscribe",
  "see you in the next video",
  "see you next time",
  "bye",
  "bye bye",
  "goodbye",
  "okay",
  "so",
  "uh",
  "um",
  "uh huh",
  "mm hmm",
  "hmm",
  "mm",
  "ah",
  "oh",
  "eh",
  "erm",
  "shh",
  "...",
]);

// Substring patterns that are almost exclusively training-set subtitle watermarks on silence.
const WATERMARK_HALLUCINATION_RE =
  /\b(?:subtitles? by|transcribed by|captioned by|amara\.org|all rights reserved|copyright \d{4}|thank you for watching|thanks for watching|please subscribe and like)\b/i;

const SPOKEN_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  to: 2,
  too: 2,
  three: 3,
  four: 4,
  for: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseSpokenCount(raw: string | undefined, fallback: number, min = 1, max = 12): number {
  if (!raw) return fallback;
  const clean = raw.trim().toLowerCase();
  const num = SPOKEN_NUMBERS[clean] ?? Number.parseInt(clean, 10);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

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
    .replace(/\((?:[^)]*\b(?:music|applause|laughter|laughs|silence|noise|inaudible|blank_audio|coughs?|sighs?|breathing|clears throat|sniffs?|gasps?|groans?|beeps?|bell|typing|clicking)\b[^)]*)\)/gi, " ")
    .replace(/\*[^*]*\*/g, " ")
    .replace(/[♪♫♬]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

// Detects when whisper gets stuck in a decoding loop repeating the same word or short phrase
// 3+ times in a row ("the the the", "let's stand up on play let's stand up on play ...").
function hasRepetitionLoop(norm: string): boolean {
  const words = norm.split(" ").filter(Boolean);
  if (words.length < 3) return false;
  // Single-word 4x repetition ("you you you you") or 3x for non-trivial words.
  for (let i = 0; i <= words.length - 3; i++) {
    if (words[i] === words[i + 1] && words[i] === words[i + 2]) {
      if (words.length === 3 || words[i + 3] === words[i] || words[i].length > 2) return true;
    }
  }
  // Phrase of 2..6 words repeated 3+ times consecutively.
  for (let len = 2; len <= 6 && len * 3 <= words.length; len++) {
    for (let start = 0; start <= words.length - len * 3; start++) {
      const p1 = words.slice(start, start + len).join(" ");
      const p2 = words.slice(start + len, start + len * 2).join(" ");
      const p3 = words.slice(start + len * 2, start + len * 3).join(" ");
      if (p1 === p2 && p2 === p3) return true;
    }
  }
  return false;
}

// Detects when whisper regurgitates the document title or text already on the screen (passed via
// --prompt) during silence or low-level room noise.
export function isScreenEcho(text: string, title: string, precedingText: string, speechMs = 1000): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return true;

  // Never treat a recognised voice command as a screen echo.
  if (WHOLE_CHUNK_COMMANDS.some(([re]) => re.test(norm))) return false;

  const normTitle = normalizeForMatch(title);
  if (normTitle && normTitle.length >= 4) {
    if (norm === normTitle) return true;
    // Whisper frequently echoes the title followed by a short 1-4 word hallucinated tail on room noise.
    if (speechMs < 2600 && norm.startsWith(normTitle)) {
      const restWords = norm.slice(normTitle.length).trim().split(" ").filter(Boolean);
      if (restWords.length <= 4) return true;
    }
  }

  const normPreceding = normalizeForMatch(precedingText.slice(-500));
  if (!normPreceding) return false;

  const words = norm.split(" ").filter(Boolean);
  // Exact suffix repeat of what was just typed on the screen.
  if (normPreceding.endsWith(norm)) {
    if (words.length >= 2 || (words.length === 1 && norm.length >= 5 && speechMs < 1800)) {
      return true;
    }
  }

  // Substring echo from the prompt tail on short/medium noise bursts.
  if (speechMs < 2500 && words.length >= 3 && normPreceding.includes(norm)) {
    return true;
  }

  return false;
}

export function isLikelyHallucination(text: string, speechMs: number, context?: HallucinationContext): boolean {
  const norm = normalizeForMatch(text);
  if (!norm) return true;
  if (WATERMARK_HALLUCINATION_RE.test(text)) return true;
  if (hasRepetitionLoop(norm)) return true;
  // Only short bursts get this treatment - "thank you" after five seconds of real speech is
  // genuinely what was said.
  if (speechMs < 1500 && HALLUCINATIONS.has(norm)) return true;
  if (context && isScreenEcho(text, context.title ?? "", context.precedingText ?? "", speechMs)) {
    return true;
  }
  return false;
}

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "#fef08a",
  green: "#bbf7d0",
  blue: "#bfdbfe",
  pink: "#fbcfe8",
  orange: "#fed7aa",
  purple: "#e9d5ff",
};

// Whole-chunk commands: recognised when the entire utterance is the command.
const WHOLE_CHUNK_COMMANDS: [RegExp, DictationOp][] = [
  [/^(scratch that|delete that|delete last|remove that|clear that)$/, { kind: "scratch" }],
  [/^(undo|undo that|undo last)$/, { kind: "undo" }],
  [/^(redo|redo that|redo last)$/, { kind: "redo" }],
  [/^(stop dictation|stop listening|stop dictating|end dictation|pause dictation)$/, { kind: "stop" }],
  [/^(bullet list|bulleted list|start bullet list|bullet point|bullet points|new bullet)$/, { kind: "bulletList" }],
  [/^(numbered list|number list|start numbered list|ordered list)$/, { kind: "orderedList" }],
  [/^(checklist|check list|task list|todo list|to do list|start checklist|start task list)$/, { kind: "taskList" }],
  [/^(check that|check item|mark done|mark as done|complete task|complete item)$/, { kind: "checkItem", checked: true }],
  [/^(uncheck that|uncheck item|mark undone|mark as undone)$/, { kind: "checkItem", checked: false }],
  [/^(next item|next bullet|next point|new item|next task)$/, { kind: "listItem" }],
  [/^(heading|heading one|heading 1|title)$/, { kind: "heading", level: 1 }],
  [/^(heading two|heading 2|subheading|sub heading|subtitle)$/, { kind: "heading", level: 2 }],
  [/^(heading three|heading 3|section heading)$/, { kind: "heading", level: 3 }],
  [/^(normal text|body text|plain text|regular text)$/, { kind: "normalText" }],
  [/^(blockquote|block quote|quote block|start quote)$/, { kind: "blockquote" }],
  [/^(horizontal line|horizontal rule|insert divider|section divider|insert line)$/, { kind: "horizontalRule" }],
  [/^(insert page break|page break|new page)$/, { kind: "pageBreak" }],
  [/^(next cell|next column|tab cell)$/, { kind: "tableNav", direction: "next" }],
  [/^(previous cell|previous column|prev cell|back cell)$/, { kind: "tableNav", direction: "prev" }],
  [/^(next row|new row)$/, { kind: "tableNav", direction: "row" }],
  [/^(bold that|make that bold|bold last|bold it)$/, { kind: "formatLast", format: "bold" }],
  [/^(italicize that|italicise that|make that italic|italics that|italic that)$/, { kind: "formatLast", format: "italic" }],
  [/^(underline that|make that underlined|underline it)$/, { kind: "formatLast", format: "underline" }],
  [/^(strikethrough that|strike that|strike through that|cross that out)$/, { kind: "formatLast", format: "strike" }],
  [/^(code that|format as code|inline code that)$/, { kind: "formatLast", format: "code" }],
  [/^(highlight that|highlight it|mark that)$/, { kind: "formatLast", format: "highlight", color: HIGHLIGHT_COLORS.yellow }],
  [/^(uppercase that|all caps that|make that uppercase|make that all caps)$/, { kind: "formatLast", format: "uppercase" }],
  [/^(lowercase that|make that lowercase|all lowercase that)$/, { kind: "formatLast", format: "lowercase" }],
  [/^(capitalize that|title case that|make that title case)$/, { kind: "formatLast", format: "titlecase" }],
  [/^(align left|left align|align to the left)$/, { kind: "align", alignment: "left" }],
  [/^(align center|align centre|center that|centre that|center align|centre align)$/, { kind: "align", alignment: "center" }],
  [/^(align right|right align|align to the right)$/, { kind: "align", alignment: "right" }],
  [/^(justify that|justify text|align justify)$/, { kind: "align", alignment: "justify" }],
  [/^(delete last word|scratch last word|remove last word)$/, { kind: "deleteWord", count: 1 }],
  [/^(delete last sentence|scratch last sentence|remove last sentence|clear line|delete line)$/, { kind: "deleteSentence" }],
  [/^(insert table|create table|add table|new table)$/, { kind: "insertTable", rows: 3, cols: 3 }],
];

// Parameterised whole-chunk commands ("insert a 4 by 3 table", "highlight that green", "delete last 3 words").
function matchParameterizedCommand(norm: string): DictationOp | null {
  const tableMatch = norm.match(
    /^(?:insert|create|add|make)\s+(?:a\s+)?(?:table\s+)?(\d+|one|two|to|too|three|four|for|five|six|seven|eight|nine|ten)\s*(?:rows?\s*)?(?:by|x|times)\s*(\d+|one|two|to|too|three|four|for|five|six|seven|eight|nine|ten)(?:\s*columns?)?(?:\s*table)?$/
  );
  if (tableMatch) {
    return {
      kind: "insertTable",
      rows: parseSpokenCount(tableMatch[1], 3, 1, 20),
      cols: parseSpokenCount(tableMatch[2], 3, 1, 12),
    };
  }

  const highlightMatch = norm.match(/^(?:highlight|mark)\s+(?:that|it)\s+(yellow|green|blue|pink|orange|purple)$/);
  if (highlightMatch) {
    return {
      kind: "formatLast",
      format: "highlight",
      color: HIGHLIGHT_COLORS[highlightMatch[1]] ?? HIGHLIGHT_COLORS.yellow,
    };
  }

  const deleteWordsMatch = norm.match(
    /^(?:delete|scratch|remove)\s+(?:the\s+)?last\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+words?$/
  );
  if (deleteWordsMatch) {
    return {
      kind: "deleteWord",
      count: parseSpokenCount(deleteWordsMatch[1], 1, 1, 20),
    };
  }

  return null;
}

// Prefix block commands at the start of an utterance: "Heading 1 Project Overview" or
// "Subheading Methodology" sets the block type and then types the remaining text.
const PREFIX_BLOCK_PATTERNS: { re: RegExp; op: DictationOp }[] = [
  { re: /^(?:heading\s*(?:one|1)|main\s+heading)\s*[,:.\-]?\s+(.+)$/i, op: { kind: "heading", level: 1 } },
  { re: /^(?:heading\s*(?:two|2)|subheading|sub\s+heading)\s*[,:.\-]?\s+(.+)$/i, op: { kind: "heading", level: 2 } },
  { re: /^(?:heading\s*(?:three|3)|section\s+heading)\s*[,:.\-]?\s+(.+)$/i, op: { kind: "heading", level: 3 } },
  { re: /^(?:bullet\s+list|start\s+bullet\s+list)\s*[,:.\-]?\s+(.+)$/i, op: { kind: "bulletList" } },
  { re: /^(?:numbered\s+list|ordered\s+list|start\s+numbered\s+list)\s*[,:.\-]?\s+(.+)$/i, op: { kind: "orderedList" } },
  { re: /^(?:checklist|task\s+list|todo\s+list|to\s+do\s+list)\s*[,:.\-]?\s+(.+)$/i, op: { kind: "taskList" } },
  { re: /^(?:blockquote|block\s+quote|quote\s+block)\s*[,:.\-]?\s+(.+)$/i, op: { kind: "blockquote" } },
];

// Inline structure & navigation commands that can appear mid-utterance without requiring a pause.
// Whisper tends to wrap them in its own punctuation ("Done, new paragraph. Next item"), which the
// surrounding marks soak up - except a sentence-ending mark before the command, which belongs to
// the preceding sentence.
const INLINE_COMMAND_RE =
  /[,;:]?\s*\b(new paragraph|next paragraph|new line|next line|newline|next bullet|new bullet|next item|next cell|next column|previous cell|next row|bold that|make that bold|italicize that|italicise that|make that italic|underline that|strikethrough that|highlight that|check that|uncheck that|scratch that|delete that|undo that|redo that|horizontal line|horizontal rule|insert divider|insert page break|stop dictation|stop listening)\b[,.;:!?]?/gi;

function inlineCommandToOp(phrase: string): DictationOp {
  const lower = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  if (lower.includes("paragraph")) return { kind: "paragraph" };
  if (lower === "new line" || lower === "next line" || lower === "newline") return { kind: "lineBreak" };
  if (lower === "next bullet" || lower === "new bullet" || lower === "next item") return { kind: "listItem" };
  if (lower === "next cell" || lower === "next column") return { kind: "tableNav", direction: "next" };
  if (lower === "previous cell") return { kind: "tableNav", direction: "prev" };
  if (lower === "next row") return { kind: "tableNav", direction: "row" };
  if (lower === "bold that" || lower === "make that bold") return { kind: "formatLast", format: "bold" };
  if (lower === "italicize that" || lower === "italicise that" || lower === "make that italic") {
    return { kind: "formatLast", format: "italic" };
  }
  if (lower === "underline that") return { kind: "formatLast", format: "underline" };
  if (lower === "strikethrough that") return { kind: "formatLast", format: "strike" };
  if (lower === "highlight that") return { kind: "formatLast", format: "highlight", color: HIGHLIGHT_COLORS.yellow };
  if (lower === "check that") return { kind: "checkItem", checked: true };
  if (lower === "uncheck that") return { kind: "checkItem", checked: false };
  if (lower === "scratch that" || lower === "delete that") return { kind: "scratch" };
  if (lower === "undo that") return { kind: "undo" };
  if (lower === "redo that") return { kind: "redo" };
  if (lower === "horizontal line" || lower === "horizontal rule" || lower === "insert divider") {
    return { kind: "horizontalRule" };
  }
  if (lower === "insert page break") return { kind: "pageBreak" };
  if (lower === "stop dictation" || lower === "stop listening") return { kind: "stop" };
  return { kind: "lineBreak" };
}

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
  { words: "open square bracket", mark: "[", always: true, attach: "right" },
  { words: "close square bracket", mark: "]", always: true, attach: "left" },
  { words: "period|full stop", mark: ".", always: false, attach: "left" },
  { words: "colon", mark: ":", always: false, attach: "left" },
  { words: "em dash|long dash", mark: " — ", always: true, attach: "both" },
];

// Smart auto-formatting for spoken emails, domains, scientific symbols, and hesitation fillers.
const EMAIL_SPOKEN_RE =
  /\b([a-z0-9][\w.-]*?)(?:\s+(?:dot|point)\s+([a-z0-9][\w.-]*?))*\s+at\s+([a-z0-9][\w-]*?)\s+(?:dot|point)\s+(com|org|net|edu|gov|io|co|ch|uk|ng|de|fr|ca|ai|dev|app)(?:\s+(?:dot|point)\s+([a-z]{2,3}))?\b/gi;

const SPOKEN_SYMBOLS: [RegExp, string][] = [
  [/\bdegrees?\s+celsius\b/gi, "°C"],
  [/\bdegrees?\s+fahrenheit\b/gi, "°F"],
  [/\bplus\s+or\s+minus\b/gi, "±"],
  [/\bgreater\s+than\s+or\s+equal\s+to\b/gi, "≥"],
  [/\bless\s+than\s+or\s+equal\s+to\b/gi, "≤"],
  [/\bapproximately\s+equal\s+to\b/gi, "≈"],
  [/\bnot\s+equal\s+to\b/gi, "≠"],
  [/\bright\s+arrow\b/gi, "→"],
  [/\bleft\s+arrow\b/gi, "←"],
  [/\bcopyright\s+symbol\b/gi, "©"],
  [/\btrademark\s+symbol\b/gi, "™"],
  [/\bregistered\s+trademark\b/gi, "®"],
];

// Function words where an immediate spoken stutter ("the the", "we we") is unintentional.
const STUTTER_WORDS_RE =
  /\b(the|a|an|and|or|but|in|on|at|to|for|of|with|by|is|are|was|were|be|we|they|it|this|that|can|will)\s+\1\b/gi;

function applySmartFormatting(text: string): string {
  let out = text;

  // Strip standalone hesitation fillers ("um", "uh", "erm") without touching real words.
  out = out.replace(/(?:^|[,;]\s*|\s+)\b(?:um+|uh+|erm)\b[,;.]?(?=\s|$)/gi, " ");

  // Collapse immediate accidental function-word stutters ("the the" -> "the").
  out = out.replace(STUTTER_WORDS_RE, "$1");

  // Spoken email addresses: "oakinojo at gmail dot com" -> "oakinojo@gmail.com",
  // "temidayo dot solomon at cern dot ch" -> "temidayo.solomon@cern.ch".
  out = out.replace(EMAIL_SPOKEN_RE, (fullMatch) => {
    const parts = fullMatch.split(/\s+at\s+/i);
    if (parts.length !== 2) return fullMatch;
    const local = parts[0]
      .replace(/\s+(?:dot|point)\s+/gi, ".")
      .replace(/\s+/g, "")
      .toLowerCase();
    const domain = parts[1]
      .replace(/\s+(?:dot|point)\s+/gi, ".")
      .replace(/\s+/g, "")
      .toLowerCase();
    return `${local}@${domain}`;
  });

  // Spoken symbols and scientific units.
  for (const [re, symbol] of SPOKEN_SYMBOLS) {
    out = out.replace(re, symbol);
  }
  // Attach °C / °F directly to a preceding number ("25 °C" -> "25°C").
  out = out.replace(/(\d)\s+(°[CF])\b/g, "$1$2");

  // Dynamic spoken date token ("insert today's date").
  out = out.replace(/\binsert\s+today'?s\s+date\b/gi, () =>
    new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
  );

  return out;
}

function applySpokenPunctuation(text: string): string {
  let out = applySmartFormatting(text);
  for (const { words, mark, always, attach } of PUNCTUATION) {
    // Swallow whisper's own punctuation around the spoken word: "Hello, comma, world" -> "Hello, world".
    const lookahead = always ? "" : "(?=\\s*$|\\s*[.,;:!?])";
    const re = new RegExp(`[,.;:]?\\s*\\b(?:${words})\\b[,.;:]?${lookahead}`, "gi");
    out = out.replace(re, () => (attach === "left" ? `${mark}\u0000` : attach === "right" ? `\u0000${mark}` : mark));
  }
  return out
    .replace(/\s*\u0000([“(\[])/g, " $1") // opening marks: space before, none after
    .replace(/([“(\[])\s+/g, "$1")
    .replace(/\s*([?!,;:.…”)\]])\u0000/g, "$1") // closing marks hug the preceding word
    .replace(/\u0000/g, "")
    .replace(/\.{3,}/g, "…")
    .replace(/([?!,;:.…])(?=[^\s\d.…"'”)\]}])/g, (_m, mark, offset, str) => {
      // Keep dots inside email addresses, domains, and abbreviations intact.
      if (mark === ".") {
        const prev = str.slice(0, offset);
        const next = str.slice(offset + 1);
        if (/[a-z0-9_]$/i.test(prev) && /^[a-z0-9_]/i.test(next)) {
          return mark;
        }
      }
      return `${mark} `;
    })
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
    const paramOp = matchParameterizedCommand(whole);
    if (paramOp) return [paramOp];
  }

  const ops: DictationOp[] = [];
  const pushText = (segment: string) => {
    const trimmed = segment.trim();
    if (!trimmed) return;
    if (commands) {
      const segNorm = normalizeForMatch(trimmed);
      for (const [re, op] of WHOLE_CHUNK_COMMANDS) {
        if (re.test(segNorm)) {
          ops.push(op);
          return;
        }
      }
      const paramOp = matchParameterizedCommand(segNorm);
      if (paramOp) {
        ops.push(paramOp);
        return;
      }
      for (const { re, op } of PREFIX_BLOCK_PATTERNS) {
        const m = trimmed.match(re);
        if (m && m[1]) {
          ops.push(op);
          const rest = applySpokenPunctuation(m[1]).replace(/\s+/g, " ").trim();
          if (rest) ops.push({ kind: "text", text: rest });
          return;
        }
      }
    }
    const text = (commands ? applySpokenPunctuation(trimmed) : trimmed).replace(/\s+/g, " ").trim();
    if (text) ops.push({ kind: "text", text });
  };

  // Whisper's own newlines separate its segments, not intended paragraphs - join them as a space.
  const flat = cleaned.replace(/\n+/g, " ");
  if (!commands) {
    pushText(flat);
    return ops;
  }

  let last = 0;
  for (const match of flat.matchAll(INLINE_COMMAND_RE)) {
    pushText(flat.slice(last, match.index));
    ops.push(inlineCommandToOp(match[1]));
    last = (match.index ?? 0) + match[0].length;
  }
  pushText(flat.slice(last));
  return ops;
}

// Human-readable badge label for non-text voice commands so the editor can show a live confirmation pill.
export function describeDictationOp(op: DictationOp): string | null {
  switch (op.kind) {
    case "text":
      return null;
    case "lineBreak":
      return "↵ New line";
    case "paragraph":
      return "¶ New paragraph";
    case "bulletList":
      return "• Bullet list";
    case "orderedList":
      return "1. Numbered list";
    case "taskList":
      return "☑ Checklist";
    case "checkItem":
      return op.checked === false ? "☐ Unchecked" : "☑ Checked";
    case "listItem":
      return "• Next item";
    case "heading":
      return `H${op.level} Heading ${op.level}`;
    case "normalText":
      return "¶ Normal text";
    case "blockquote":
      return "❝ Quote block";
    case "horizontalRule":
      return "― Divider";
    case "pageBreak":
      return "⤓ Page break";
    case "insertTable":
      return `⊞ ${op.rows}×${op.cols} Table`;
    case "tableNav":
      return op.direction === "row" ? "↵ Next row" : op.direction === "prev" ? "← Prev cell" : "→ Next cell";
    case "formatLast":
      switch (op.format) {
        case "bold":
          return "B Bolded";
        case "italic":
          return "I Italicized";
        case "underline":
          return "U Underlined";
        case "strike":
          return "S Strikethrough";
        case "code":
          return "</> Code";
        case "highlight":
          return "✦ Highlighted";
        case "uppercase":
          return "AA Uppercase";
        case "lowercase":
          return "aa Lowercase";
        case "titlecase":
          return "Aa Title Case";
      }
      return null;
    case "align":
      return `≡ Align ${op.alignment}`;
    case "deleteWord":
      return op.count && op.count > 1 ? `⌫ Deleted ${op.count} words` : "⌫ Deleted word";
    case "deleteSentence":
      return "⌫ Deleted sentence";
    case "scratch":
      return "⌫ Scratched";
    case "undo":
      return "↶ Undone";
    case "redo":
      return "↷ Redone";
    case "stop":
      return "■ Dictation stopped";
  }
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
  // Conjunctions and prepositions that continue a clause after a brief breathing pause.
  return CONTINUATIONS.has(first.toLowerCase()) ? 1 : 0;
}

const CONTINUATIONS = new Set([
  "and",
  "but",
  "or",
  "because",
  "which",
  "than",
  "to",
  "of",
  "with",
  "for",
  "while",
  "whereas",
  "unless",
  "from",
  "into",
  "onto",
  "through",
  "without",
  "between",
  "among",
  "during",
  "including",
  "although",
  "though",
  "since",
  "until",
  "whether",
  "where",
  "when",
  "that",
  "who",
  "whom",
  "whose",
]);

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
