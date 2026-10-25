// Search over a media library by file name, the folders it sits in and the date in its name.
// Queries are split into words that must all match (any order); case, accents and separators are
// ignored, so "image 5", "image_5" and "Image5" find the same file. A date written in a name
// (photo_2026-08-30, IMG-20240512-WA0001) is also found by its month and year: "aug 2026".
// When nothing matches, a typo-tolerant pass (letters in order) runs instead.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DATE_IN_NAME = /(19\d{2}|20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/;

export interface MediaSearchEntry<T> {
  item: T;
  name: string; // folded, separators as spaces
  nameCompact: string; // folded, no separators
  extra: string; // folders, date words, kind
  extraCompact: string;
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const compact = (folded: string) => folded.replace(/ /g, "");

export function buildMediaIndex<T extends { name: string; path: string; video: boolean }>(items: T[]): MediaSearchEntry<T>[] {
  return items.map((item) => {
    const name = fold(item.name);
    // The two folders above the file - "CERN / General Images" - not the whole drive path, which every file shares.
    const folders = item.path.split(/[\\/]/).slice(-3, -1).join(" ");
    const date = DATE_IN_NAME.exec(item.name);
    const dateWords = date ? `${MONTHS[Number(date[2]) - 1]} ${date[1]}` : "";
    const extra = fold(`${folders} ${dateWords} ${item.video ? "video" : "photo image"}`);
    return { item, name, nameCompact: compact(name), extra, extraCompact: compact(extra) };
  });
}

function scoreToken<T>(e: MediaSearchEntry<T>, token: string): number {
  if (e.name.startsWith(token)) return 4;
  if (e.name.includes(` ${token}`)) return 3;
  if (e.name.includes(token) || e.nameCompact.includes(token)) return 2;
  if (e.extra.includes(token) || e.extraCompact.includes(token)) return 1;
  return 0;
}

// Edits (insert, delete, swap two neighbours, replace) between a and b, giving up past max.
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      best = Math.min(best, d);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

// A mistyped word: within one edit of a word in the text (two for longer words), or of the start
// of one ("imgae" finds "image_5"). 0 = no match; closer scores higher.
function typoScore(words: string[], token: string): number {
  if (token.length < 3) return 0;
  const max = token.length >= 7 ? 2 : 1;
  let best = max + 1;
  for (const w of words) {
    best = Math.min(best, editDistance(token, w, max), w.length > token.length ? editDistance(token, w.slice(0, token.length), max) : max + 1);
    if (best === 0) break;
  }
  return best > max ? 0 : 1 / (1 + best);
}

export function searchMedia<T>(index: MediaSearchEntry<T>[], query: string): { items: T[]; fuzzy: boolean } {
  const tokens = fold(query).split(" ").filter(Boolean);
  if (!tokens.length) return { items: index.map((e) => e.item), fuzzy: false };

  const hits: { item: T; score: number; order: number }[] = [];
  index.forEach((e, order) => {
    let score = 0;
    for (const t of tokens) {
      const s = scoreToken(e, t);
      if (!s) return;
      score += s;
    }
    hits.push({ item: e.item, score, order });
  });
  if (hits.length) {
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    return { items: hits.map((h) => h.item), fuzzy: false };
  }

  index.forEach((e, order) => {
    const nameWords = e.name.split(" ");
    const extraWords = e.extra.split(" ");
    let score = 0;
    for (const t of tokens) {
      // Words that already match exactly still count, so only the mistyped one has to be close.
      const s = scoreToken(e, t) || typoScore(nameWords, t) * 2 || typoScore(extraWords, t);
      if (!s) return;
      score += s;
    }
    hits.push({ item: e.item, score, order });
  });
  hits.sort((a, b) => b.score - a.score || a.order - b.order);
  return { items: hits.map((h) => h.item), fuzzy: hits.length > 0 };
}
