// Text → phonemes for the AI voice (services/tts.rs). Kokoro speaks phonemes, not letters, so what
// the voice gets right or wrong is decided here: how "2024" or "$5.50" is said, whether "read" is
// red or reed, how a name nobody put in a dictionary is sounded out.
//
//   1. normalize   numbers, money, percentages, ordinals, times, years, abbreviations, symbols ->
//                  the words a person would say.
//   2. phonemize   each word through the lexicon (Kokoro's own gold + silver dictionaries from the
//                  misaki project - about 180k words, already in Kokoro's phoneme alphabet), then
//                  what the dictionary lacks: possessives / plurals / -ed / -ing / -ly stems,
//                  compounds split into two known words ("screencast" = "screen" + "cast"),
//                  acronyms spelled letter by letter, and last of all spelling rules.
//   3. chunk       split at sentence ends (and at clauses when a sentence is too long for the model's
//                  510-token window), each with the pause that follows it.
//
// Pure functions over a loaded Lexicon, so everything here is unit-tested without the model.
use std::collections::HashMap;

use crate::services::tts_vocab::token_id;

// Kokoro accepts 510 tokens; stay well under so the voice never gets a window it handles badly
// (very long inputs speed up and flatten).
pub const MAX_CHUNK_TOKENS: usize = 300;

pub struct Lexicon {
    gold: HashMap<String, String>,
    silver: HashMap<String, String>,
}

impl Lexicon {
    // misaki's dictionary files: word -> phonemes, or word -> { DEFAULT: phonemes, <POS>: phonemes }.
    // Without a part-of-speech tagger the DEFAULT reading is the one used.
    pub fn parse(gold_json: &str, silver_json: &str) -> Result<Lexicon, String> {
        Ok(Lexicon { gold: parse_dictionary(gold_json)?, silver: parse_dictionary(silver_json)? })
    }

    fn get(&self, word: &str) -> Option<&str> {
        self.gold.get(word).or_else(|| self.silver.get(word)).map(|s| s.as_str())
    }

    // Lower-case lookup, then a capitalised one (proper names are stored capitalised).
    fn get_loose(&self, word: &str) -> Option<&str> {
        if let Some(p) = self.get(word) {
            return Some(p);
        }
        let lower = word.to_lowercase();
        if let Some(p) = self.get(&lower) {
            return Some(p);
        }
        let mut chars = lower.chars();
        let first = chars.next()?;
        let cap: String = first.to_uppercase().chain(chars).collect();
        self.get(&cap)
    }

    #[cfg(test)]
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Lexicon {
        Lexicon { gold: pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), silver: HashMap::new() }
    }
}

fn parse_dictionary(json: &str) -> Result<HashMap<String, String>, String> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("Pronunciation dictionary is unreadable: {}", e))?;
    let object = value.as_object().ok_or("Pronunciation dictionary has the wrong shape.")?;
    let mut out = HashMap::with_capacity(object.len());
    for (word, entry) in object {
        let phonemes = match entry {
            serde_json::Value::String(s) => Some(s.as_str()),
            serde_json::Value::Object(by_pos) => by_pos
                .get("DEFAULT")
                .and_then(|v| v.as_str())
                .or_else(|| by_pos.values().find_map(|v| v.as_str())),
            _ => None,
        };
        if let Some(p) = phonemes {
            out.insert(word.clone(), p.to_string());
        }
    }
    Ok(out)
}

// One piece of speech for one model run: phonemes ready for the tokenizer, and the silence that
// follows it on the finished recording.
#[derive(Debug, Clone, PartialEq)]
pub struct Chunk {
    pub phonemes: String,
    pub pause_after: f32,
}

// Pause lengths in seconds at the "natural" setting; the caller scales them.
const PAUSE_SENTENCE: f32 = 0.30;
const PAUSE_QUESTION: f32 = 0.34;
const PAUSE_ELLIPSIS: f32 = 0.50;
const PAUSE_PARAGRAPH: f32 = 0.70;
const PAUSE_CLAUSE: f32 = 0.14;

pub fn speech_chunks(text: &str, lex: &Lexicon) -> Vec<Chunk> {
    let mut chunks: Vec<Chunk> = Vec::new();
    for paragraph in text.split('\n') {
        let normalized = normalize(paragraph);
        if normalized.trim().is_empty() {
            continue;
        }
        let phonemes = phonemize(&normalized, lex);
        let before = chunks.len();
        for (sentence, end) in split_sentences(&phonemes) {
            let pause = match end {
                '?' => PAUSE_QUESTION,
                '…' => PAUSE_ELLIPSIS,
                _ => PAUSE_SENTENCE,
            };
            let parts = split_long(&sentence);
            let last = parts.len().saturating_sub(1);
            for (i, part) in parts.into_iter().enumerate() {
                chunks.push(Chunk { phonemes: part, pause_after: if i == last { pause } else { PAUSE_CLAUSE } });
            }
        }
        if chunks.len() > before {
            if let Some(last) = chunks.last_mut() {
                last.pause_after = PAUSE_PARAGRAPH;
            }
        }
    }
    if let Some(last) = chunks.last_mut() {
        last.pause_after = 0.0;
    }
    chunks
}

// Phoneme string -> (sentence, its final punctuation mark). A sentence keeps its own ending so the
// model can hear a question or a statement.
fn split_sentences(phonemes: &str) -> Vec<(String, char)> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = phonemes.chars().peekable();
    while let Some(c) = chars.next() {
        current.push(c);
        if matches!(c, '.' | '!' | '?' | '…') {
            let mut end = c;
            while let Some(&n) = chars.peek() {
                if matches!(n, '.' | '!' | '?' | '…') {
                    current.push(n);
                    if n == '…' || (n == '.' && end == '.') {
                        end = '…';
                    }
                    chars.next();
                } else {
                    break;
                }
            }
            let text = current.trim().to_string();
            if has_speech(&text) {
                out.push((text, end));
            }
            current.clear();
        }
    }
    let rest = current.trim().to_string();
    if has_speech(&rest) {
        out.push((rest, '.'));
    }
    out
}

fn has_speech(s: &str) -> bool {
    s.chars().any(|c| !c.is_whitespace() && !matches!(c, '.' | '!' | '?' | '…' | ',' | ';' | ':' | '—'))
}

// A sentence longer than the window is cut at its last clause boundary that fits - never inside a
// word - falling back to a space.
fn split_long(sentence: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest: Vec<char> = sentence.chars().collect();
    while rest.len() > MAX_CHUNK_TOKENS {
        let window = &rest[..MAX_CHUNK_TOKENS];
        let cut = window
            .iter()
            .rposition(|c| matches!(c, ',' | ';' | ':' | '—'))
            .filter(|&i| i > MAX_CHUNK_TOKENS / 3)
            .or_else(|| window.iter().rposition(|c| *c == ' '))
            .map(|i| i + 1)
            .unwrap_or(MAX_CHUNK_TOKENS);
        let head: String = rest[..cut].iter().collect();
        out.push(head.trim().to_string());
        rest = rest[cut..].iter().skip_while(|c| c.is_whitespace()).copied().collect();
    }
    let tail: String = rest.iter().collect();
    if !tail.trim().is_empty() {
        out.push(tail.trim().to_string());
    }
    out
}

// ---- Normalization ------------------------------------------------------------------------------

const ONES: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS: [&str; 10] = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES: [&str; 5] = ["", " thousand", " million", " billion", " trillion"];

pub fn number_to_words(n: u64) -> String {
    if n < 20 {
        return ONES[n as usize].to_string();
    }
    if n < 100 {
        let (t, o) = ((n / 10) as usize, (n % 10) as usize);
        return if o == 0 { TENS[t].to_string() } else { format!("{} {}", TENS[t], ONES[o]) };
    }
    if n < 1000 {
        let rest = n % 100;
        let head = format!("{} hundred", ONES[(n / 100) as usize]);
        return if rest == 0 { head } else { format!("{} {}", head, number_to_words(rest)) };
    }
    let mut groups = Vec::new();
    let mut rest = n;
    while rest > 0 {
        groups.push(rest % 1000);
        rest /= 1000;
    }
    if groups.len() > SCALES.len() {
        return n.to_string().chars().map(|c| ONES[c.to_digit(10).unwrap_or(0) as usize]).collect::<Vec<_>>().join(" ");
    }
    let mut parts = Vec::new();
    for (i, g) in groups.iter().enumerate().rev() {
        if *g > 0 {
            parts.push(format!("{}{}", number_to_words(*g), SCALES[i]));
        }
    }
    parts.join(" ")
}

fn digits_to_words(digits: &str) -> String {
    digits.chars().filter_map(|c| c.to_digit(10)).map(|d| ONES[d as usize]).collect::<Vec<_>>().join(" ")
}

fn ordinal_word(word: &str) -> String {
    // "twenty one" -> "twenty first": only the last word changes.
    let (head, last) = match word.rsplit_once(' ') {
        Some((h, l)) => (format!("{} ", h), l),
        None => (String::new(), word),
    };
    let ordinal = match last {
        "one" => "first".to_string(),
        "two" => "second".to_string(),
        "three" => "third".to_string(),
        "five" => "fifth".to_string(),
        "eight" => "eighth".to_string(),
        "nine" => "ninth".to_string(),
        "twelve" => "twelfth".to_string(),
        w if w.ends_with('y') => format!("{}ieth", &w[..w.len() - 1]),
        w => format!("{}th", w),
    };
    format!("{}{}", head, ordinal)
}

// 1984 -> "nineteen eighty four", 2005 -> "two thousand five", 1900 -> "nineteen hundred".
fn year_to_words(y: u64) -> String {
    if (2000..2010).contains(&y) {
        return if y == 2000 { "two thousand".to_string() } else { format!("two thousand {}", number_to_words(y - 2000)) };
    }
    let (hi, lo) = (y / 100, y % 100);
    match lo {
        0 => format!("{} hundred", number_to_words(hi)),
        1..=9 => format!("{} oh {}", number_to_words(hi), number_to_words(lo)),
        _ => format!("{} {}", number_to_words(hi), number_to_words(lo)),
    }
}

fn is_year(n: u64, digits: usize) -> bool {
    digits == 4 && ((1100..=1999).contains(&n) || (2000..=2099).contains(&n)) && n % 1000 != 0
}

// Spoken form of a decimal number written with optional thousands commas ("1,234.5").
fn decimal_to_words(raw: &str) -> Option<String> {
    let clean = raw.replace(',', "");
    let (int_part, frac) = match clean.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (clean.as_str(), None),
    };
    if int_part.is_empty() || !int_part.chars().all(|c| c.is_ascii_digit()) || int_part.len() > 15 {
        return None;
    }
    let mut words = number_to_words(int_part.parse().ok()?);
    if let Some(f) = frac {
        if !f.is_empty() {
            if !f.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            words = format!("{} point {}", words, digits_to_words(f));
        }
    }
    Some(words)
}

const ABBREVIATIONS: &[(&str, &str)] = &[
    ("mr.", "mister"),
    ("mrs.", "missus"),
    ("ms.", "miz"),
    ("dr.", "doctor"),
    ("prof.", "professor"),
    ("sr.", "senior"),
    ("jr.", "junior"),
    ("st.", "saint"),
    ("vs.", "versus"),
    ("vs", "versus"),
    ("approx.", "approximately"),
    ("e.g.", "for example,"),
    ("i.e.", "that is,"),
    ("a.m.", "A M"),
    ("p.m.", "P M"),
    ("w/", "with"),
    ("w/o", "without"),
    ("govt.", "government"),
    ("dept.", "department"),
    ("inc.", "incorporated"),
    ("ltd.", "limited"),
    ("no.", "number"),
];

const UNITS: &[(&str, &str)] = &[
    ("km", "kilometers"),
    ("m", "meters"),
    ("cm", "centimeters"),
    ("mm", "millimeters"),
    ("kg", "kilograms"),
    ("g", "grams"),
    ("mg", "milligrams"),
    ("lb", "pounds"),
    ("lbs", "pounds"),
    ("kb", "kilobytes"),
    ("mb", "megabytes"),
    ("gb", "gigabytes"),
    ("tb", "terabytes"),
    ("hz", "hertz"),
    ("khz", "kilohertz"),
    ("mhz", "megahertz"),
    ("ghz", "gigahertz"),
    ("ms", "milliseconds"),
    ("s", "seconds"),
    ("min", "minutes"),
    ("hr", "hours"),
    ("fps", "frames per second"),
    ("px", "pixels"),
    ("k", "thousand"),
    ("m+", "million"),
    ("x", "times"),
];

fn currency(symbol: char) -> Option<(&'static str, &'static str)> {
    match symbol {
        '$' => Some(("dollar", "cent")),
        '£' => Some(("pound", "penny")),
        '€' => Some(("euro", "cent")),
        _ => None,
    }
}

fn plural(word: &str, n: u64) -> String {
    if n == 1 {
        word.to_string()
    } else if word == "penny" {
        "pence".to_string()
    } else {
        format!("{}s", word)
    }
}

fn is_numeric_core(s: &str) -> bool {
    !s.is_empty() && s.chars().next().is_some_and(|c| c.is_ascii_digit()) && s.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '.') && !s.ends_with(',') && !s.ends_with('.')
}

// One whitespace-separated atom: leading and trailing punctuation set aside, the core expanded.
fn normalize_atom(atom: &str) -> String {
    // Abbreviations first - their own period belongs to them. "etc." keeps it: it usually ends a sentence.
    let trimmed_lead = atom.trim_start_matches(|c: char| matches!(c, '(' | '"' | '“' | '\''));
    let lead = &atom[..atom.len() - trimmed_lead.len()];
    let lower_trim = trimmed_lead.to_lowercase();
    let (body_for_abbr, tail_punct) = {
        let t = lower_trim.trim_end_matches(|c: char| matches!(c, ',' | ';' | ':' | '!' | '?' | ')' | '"' | '”'));
        (t.to_string(), lower_trim[t.len()..].to_string())
    };
    if body_for_abbr == "etc." {
        return format!("{}et cetera.{}", lead, tail_punct);
    }
    if let Some((_, full)) = ABBREVIATIONS.iter().find(|(a, _)| *a == body_for_abbr) {
        return format!("{}{}{}", lead, full, tail_punct);
    }

    // Split trailing punctuation off the atom (keeping '%' with the number).
    let core_end = trimmed_lead.trim_end_matches(|c: char| matches!(c, ',' | ';' | ':' | '!' | '?' | '.' | ')' | '"' | '”' | '\'' | '…'));
    let trail = &trimmed_lead[core_end.len()..];
    let core = core_end;
    let body = match expand_core(core) {
        Some(words) => words,
        None => return format!("{}{}", lead, trimmed_lead),
    };
    format!("{}{}{}", lead, body, trail)
}

fn expand_core(core: &str) -> Option<String> {
    let mut chars = core.chars();
    let first = chars.next()?;

    // Money: $5, $5.50, £1,200, $3M, $2bn.
    if let Some((major, minor)) = currency(first) {
        let rest = &core[first.len_utf8()..];
        let split = rest.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(rest.len());
        let (num, suffix) = rest.split_at(split);
        if is_numeric_core(num) {
            let scale = match suffix.to_lowercase().as_str() {
                "" => None,
                "k" => Some("thousand"),
                "m" | "mm" => Some("million"),
                "b" | "bn" => Some("billion"),
                _ => return None,
            };
            let clean = num.replace(',', "");
            if let Some(scale) = scale {
                return Some(format!("{} {} {}s", decimal_to_words(num)?, scale, major));
            }
            let (whole, cents) = match clean.split_once('.') {
                Some((w, c)) => (w.to_string(), Some(c.to_string())),
                None => (clean.clone(), None),
            };
            let whole_n: u64 = whole.parse().ok()?;
            let mut out = format!("{} {}", number_to_words(whole_n), plural(major, whole_n));
            if let Some(c) = cents {
                let c2: String = format!("{:0<2}", c).chars().take(2).collect();
                let cn: u64 = c2.parse().ok()?;
                if cn > 0 {
                    out = format!("{} and {} {}", out, number_to_words(cn), plural(if major == "pound" { "penny" } else { "cent" }, cn));
                }
            }
            return Some(out);
        }
        return None;
    }
    if !first.is_ascii_digit() {
        return match core {
            "&" => Some("and".into()),
            "+" => Some("plus".into()),
            "=" => Some("equals".into()),
            "@" => Some("at".into()),
            "/" => Some(" ".into()),
            "-" | "–" => Some(String::new()),
            "—" => Some("—".into()),
            _ if core.starts_with('#') && core[1..].chars().next().is_some_and(|c| c.is_ascii_digit()) => Some(format!("number {}", expand_core(&core[1..])?)),
            _ if core.starts_with('-') && core[1..].chars().next().is_some_and(|c| c.is_ascii_digit()) => Some(format!("minus {}", expand_core(&core[1..])?)),
            _ => None,
        };
    }

    // From here the core starts with a digit.
    if let Some(num) = core.strip_suffix('%') {
        return Some(format!("{} percent", expand_core(num)?));
    }
    // Ranges "10-20", "1999-2004".
    if let Some((a, b)) = core.split_once('-').or_else(|| core.split_once('–')) {
        if is_numeric_core(a) && is_numeric_core(b) {
            return Some(format!("{} to {}", expand_core(a)?, expand_core(b)?));
        }
    }
    // Times "3:30", "10:05".
    if let Some((h, m)) = core.split_once(':') {
        if h.len() <= 2 && m.len() == 2 && h.chars().all(|c| c.is_ascii_digit()) && m.chars().all(|c| c.is_ascii_digit()) {
            let (hn, mn): (u64, u64) = (h.parse().ok()?, m.parse().ok()?);
            if hn <= 24 && mn < 60 {
                return Some(match mn {
                    0 => number_to_words(hn),
                    1..=9 => format!("{} oh {}", number_to_words(hn), number_to_words(mn)),
                    _ => format!("{} {}", number_to_words(hn), number_to_words(mn)),
                });
            }
        }
    }
    // Number + letters: ordinals (3rd), units (5km), "3x".
    let split = core.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(core.len());
    let (num, suffix) = core.split_at(split);
    if !is_numeric_core(num) {
        return None;
    }
    if suffix.is_empty() {
        let plain = num.replace(',', "");
        if !num.contains(',') && !num.contains('.') {
            let n: u64 = plain.parse().ok()?;
            if is_year(n, plain.len()) {
                return Some(year_to_words(n));
            }
            // Leading zeros ("007") and long digit strings read digit by digit.
            if (plain.len() > 1 && plain.starts_with('0')) || plain.len() > 15 {
                return Some(digits_to_words(&plain));
            }
        }
        return decimal_to_words(num);
    }
    let lower = suffix.to_lowercase();
    if matches!(lower.as_str(), "st" | "nd" | "rd" | "th") {
        let n: u64 = num.replace(',', "").parse().ok()?;
        return Some(ordinal_word(&number_to_words(n)));
    }
    if let Some((_, unit)) = UNITS.iter().find(|(u, _)| *u == lower) {
        return Some(format!("{} {}", decimal_to_words(num)?, unit));
    }
    None
}

pub fn normalize(text: &str) -> String {
    let text = text.replace(['’', '‘'], "'").replace("...", "…").replace("\u{a0}", " ");
    // Dashes between words become a spoken pause; between digits they're ranges (handled per atom).
    let text = text.replace(" – ", " — ").replace(" - ", " — ").replace("--", "—");
    let mut out = Vec::new();
    for atom in text.split_whitespace() {
        // "and/or", "24/7": a slash between letters or digits is a gap, not a symbol.
        if atom.len() > 1 && atom.contains('/') && !atom.starts_with("http") {
            let pieces: Vec<String> = atom.split('/').filter(|p| !p.is_empty()).map(normalize_atom).collect();
            out.push(pieces.join(" "));
            continue;
        }
        out.push(normalize_atom(atom));
    }
    out.join(" ").split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---- Phonemes -----------------------------------------------------------------------------------

const VOWEL_SOUNDS: &str = "AIOWYæɑɔəɛɜɪʊʌiuɚɐᵻ";
const SIBILANTS: &str = "szʃʒʧʤ";
const VOICELESS: &str = "ptkfθ";

fn last_sound(phonemes: &str) -> Option<char> {
    phonemes.chars().rev().find(|c| !matches!(c, 'ˈ' | 'ˌ'))
}

fn starts_with_vowel(phonemes: &str) -> bool {
    phonemes.chars().find(|c| !matches!(c, 'ˈ' | 'ˌ')).is_some_and(|c| VOWEL_SOUNDS.contains(c))
}

fn plural_suffix(stem: &str) -> &'static str {
    match last_sound(stem) {
        Some(c) if SIBILANTS.contains(c) => "ᵻz",
        Some(c) if VOICELESS.contains(c) => "s",
        _ => "z",
    }
}

fn past_suffix(stem: &str) -> &'static str {
    match last_sound(stem) {
        Some('t') | Some('d') => "ᵻd",
        Some(c) if VOICELESS.contains(c) || c == 's' || c == 'ʃ' || c == 'ʧ' => "t",
        _ => "d",
    }
}

// Text of one paragraph -> its phoneme string, punctuation kept where Kokoro uses it.
pub fn phonemize(text: &str, lex: &Lexicon) -> String {
    #[derive(Debug)]
    enum Item {
        Word(String),
        Punct(char),
    }
    let mut items: Vec<Item> = Vec::new();
    let mut word = String::new();
    let chars: Vec<char> = text.chars().collect();
    let flush = |word: &mut String, items: &mut Vec<Item>| {
        let w = word.trim_matches(|c| c == '\'' || c == '-').to_string();
        if !w.is_empty() {
            items.push(Item::Word(w));
        }
        word.clear();
    };
    for (i, &c) in chars.iter().enumerate() {
        let next_alpha = chars.get(i + 1).is_some_and(|n| n.is_alphanumeric());
        let prev_alpha = i > 0 && chars[i - 1].is_alphanumeric();
        if c.is_alphanumeric() {
            word.push(c);
        } else if c == '\'' && prev_alpha && next_alpha {
            word.push(c);
        } else if c == '\'' && prev_alpha && !next_alpha && word.to_lowercase().ends_with('s') {
            word.push(c); // plural possessive: "teachers'"
        } else if c == '-' && prev_alpha && next_alpha {
            flush(&mut word, &mut items); // "well-known": two words
        } else {
            flush(&mut word, &mut items);
            match c {
                ',' | ';' | ':' | '.' | '!' | '?' | '…' | '—' => items.push(Item::Punct(c)),
                '(' | ')' => items.push(Item::Punct(',')),
                _ => {}
            }
        }
    }
    flush(&mut word, &mut items);

    // Words to phonemes, with the two that depend on what follows.
    let mut pieces: Vec<(Option<String>, Option<char>)> = Vec::new(); // (word phonemes, punctuation)
    for item in &items {
        match item {
            Item::Word(w) => pieces.push((Some(word_phonemes(w, lex)), None)),
            Item::Punct(p) => pieces.push((None, Some(*p))),
        }
    }
    let spoken: Vec<usize> = (0..pieces.len()).filter(|&i| pieces[i].0.is_some()).collect();
    for (n, &i) in spoken.iter().enumerate() {
        let raw = match &items[i] {
            Item::Word(w) => w.to_lowercase(),
            _ => continue,
        };
        let next = spoken.get(n + 1).and_then(|&j| pieces[j].0.as_deref());
        // Only when nothing (punctuation) sits between the two words.
        let adjacent = spoken.get(n + 1).is_some_and(|&j| j == i + 1);
        let before_vowel = adjacent && next.is_some_and(starts_with_vowel);
        match raw.as_str() {
            "the" => pieces[i].0 = Some(if before_vowel { "ði" } else { "ðə" }.to_string()),
            "a" => pieces[i].0 = Some("ɐ".to_string()),
            "an" => pieces[i].0 = Some("ɐn".to_string()),
            _ => {}
        }
    }

    let mut out = String::new();
    for (word, punct) in pieces {
        if let Some(w) = word {
            if !out.is_empty() && !out.ends_with(' ') && !out.ends_with('—') {
                out.push(' ');
            }
            out.push_str(&w);
        } else if let Some(p) = punct {
            // Punctuation hugs the word before it; an em dash gets spaces around it.
            if p == '—' {
                out.push_str(" —");
            } else {
                out.push(p);
            }
        }
    }
    // Only symbols Kokoro knows - anything else (stray letters from a dictionary) would be dropped
    // by the tokenizer anyway, but cleaning here keeps lengths honest.
    out.chars().filter(|&c| token_id(c).is_some()).collect()
}

fn letter_names(word: &str, lex: &Lexicon) -> String {
    word.chars()
        .filter(|c| c.is_ascii_alphabetic())
        .map(|c| lex.get(&c.to_ascii_uppercase().to_string()).map(|s| s.to_string()).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_all_caps(word: &str) -> bool {
    word.chars().any(|c| c.is_alphabetic()) && word.chars().all(|c| !c.is_lowercase())
}

fn word_phonemes(word: &str, lex: &Lexicon) -> String {
    // Digits that survive normalization ("a1b2") are read as numbers.
    if word.chars().any(|c| c.is_ascii_digit()) {
        let mut parts = Vec::new();
        let mut run = String::new();
        let mut alpha = String::new();
        for c in word.chars() {
            if c.is_ascii_digit() {
                if !alpha.is_empty() {
                    parts.push(word_phonemes(&std::mem::take(&mut alpha), lex));
                }
                run.push(c);
            } else {
                if !run.is_empty() {
                    parts.push(phonemize(&number_to_words(run.parse().unwrap_or(0)), lex));
                    run.clear();
                }
                alpha.push(c);
            }
        }
        if !run.is_empty() {
            parts.push(phonemize(&number_to_words(run.parse().unwrap_or(0)), lex));
        }
        if !alpha.is_empty() {
            parts.push(word_phonemes(&alpha, lex));
        }
        return parts.join(" ");
    }

    // Shouted or acronym words: the exact entry ("NASA", "AI"), then the ordinary word, then letters.
    if is_all_caps(word) && word.chars().count() > 1 {
        if let Some(p) = lex.get(word) {
            return p.to_string();
        }
        if let Some(p) = lex.get(&word.to_lowercase()) {
            return p.to_string();
        }
        if word.chars().count() <= 5 {
            return letter_names(word, lex);
        }
    }
    if let Some(p) = lex.get_loose(word) {
        return p.to_string();
    }
    if let Some(p) = derived_word(word, lex) {
        return p;
    }
    if let Some(p) = compound_word(word, lex) {
        return p;
    }
    if word.chars().count() == 1 {
        return letter_names(word, lex);
    }
    spell_out(&word.to_lowercase())
}

// A known stem plus an ending: plurals, possessives, -ed, -ing, -ly, -er, -ness, -ment.
fn derived_word(word: &str, lex: &Lexicon) -> Option<String> {
    let w = word.to_lowercase();
    let stem_phonemes = |stem: &str| lex.get_loose(stem).map(|s| s.to_string());
    let with = |stem: &str, suffix: &dyn Fn(&str) -> String| stem_phonemes(stem).map(|p| format!("{}{}", p, suffix(&p)));

    if let Some(stem) = w.strip_suffix("'s") {
        return with(stem, &|p| plural_suffix(p).to_string()).or_else(|| word_phonemes_stem(stem, lex).map(|p| format!("{}{}", p, plural_suffix(&p))));
    }
    if let Some(stem) = w.strip_suffix('\'') {
        return stem_phonemes(stem);
    }
    let n = w.chars().count();
    if n > 3 {
        if let Some(stem) = w.strip_suffix("ies") {
            if let Some(r) = with(&format!("{}y", stem), &|_| "z".to_string()) {
                return Some(r); // "babies": the stem "baby" already ends in the right vowel
            }
        }
        if let Some(stem) = w.strip_suffix("es") {
            if let Some(r) = with(stem, &|p| plural_suffix(p).to_string()) {
                return Some(r);
            }
        }
        if let Some(stem) = w.strip_suffix('s') {
            if !stem.ends_with('s') {
                if let Some(r) = with(stem, &|p| plural_suffix(p).to_string()) {
                    return Some(r);
                }
            }
        }
        if let Some(stem) = w.strip_suffix("ied") {
            if let Some(r) = with(&format!("{}y", stem), &|_| "d".to_string()) {
                return Some(r);
            }
        }
        if let Some(stem) = w.strip_suffix("ed") {
            for candidate in candidate_stems(stem) {
                if let Some(r) = with(&candidate, &|p| past_suffix(p).to_string()) {
                    return Some(r);
                }
            }
        }
        if let Some(stem) = w.strip_suffix("ing") {
            for candidate in candidate_stems(stem) {
                if let Some(r) = with(&candidate, &|_| "ɪŋ".to_string()) {
                    return Some(r);
                }
            }
        }
        if let Some(stem) = w.strip_suffix("ly") {
            if let Some(r) = with(stem, &|_| "li".to_string()) {
                return Some(r);
            }
        }
        if let Some(stem) = w.strip_suffix("er") {
            for candidate in candidate_stems(stem) {
                if let Some(r) = with(&candidate, &|_| "ɚ".to_string()) {
                    return Some(r);
                }
            }
        }
        if let Some(stem) = w.strip_suffix("ness") {
            if let Some(r) = with(stem, &|_| "nᵻs".to_string()) {
                return Some(r);
            }
        }
        if let Some(stem) = w.strip_suffix("ment") {
            if let Some(r) = with(stem, &|_| "mᵊnt".to_string()) {
                return Some(r);
            }
        }
    }
    None
}

fn word_phonemes_stem(stem: &str, lex: &Lexicon) -> Option<String> {
    lex.get_loose(stem).map(|s| s.to_string()).or_else(|| compound_word(stem, lex))
}

// "stopp" -> ["stopp", "stop", "stoppe"], "mak" -> ["mak", "make"]: the spellings a stem can have
// before -ed / -ing / -er (doubled consonant dropped, silent e restored).
fn candidate_stems(stem: &str) -> Vec<String> {
    let mut out = vec![stem.to_string()];
    let chars: Vec<char> = stem.chars().collect();
    if chars.len() >= 3 && chars[chars.len() - 1] == chars[chars.len() - 2] {
        out.push(chars[..chars.len() - 1].iter().collect());
    }
    out.push(format!("{}e", stem));
    out
}

// Two known words run together. The longest-shortest split wins; the second part's main stress
// becomes a secondary one, as in a real compound.
fn compound_word(word: &str, lex: &Lexicon) -> Option<String> {
    let w = word.to_lowercase();
    let chars: Vec<char> = w.chars().collect();
    if chars.len() < 6 {
        return None;
    }
    let mut best: Option<(usize, String)> = None;
    for cut in 3..=chars.len() - 3 {
        let (left, right): (String, String) = (chars[..cut].iter().collect(), chars[cut..].iter().collect());
        if let (Some(l), Some(r)) = (lex.get(&left), lex.get(&right)) {
            let score = cut.min(chars.len() - cut);
            if best.as_ref().map_or(true, |(s, _)| score > *s) {
                best = Some((score, format!("{}{}", l, r.replacen('ˈ', "ˌ", 1))));
            }
        }
    }
    best.map(|(_, p)| p)
}

// Last resort: English spelling rules, good enough to make an unknown name or term sound
// plausible. Stress goes on the first vowel.
pub fn spell_out(word: &str) -> String {
    let w: Vec<char> = word.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    let n = w.len();
    let is_vowel = |c: char| matches!(c, 'a' | 'e' | 'i' | 'o' | 'u');
    let at = |i: usize| -> Option<char> { w.get(i).copied() };
    let starts = |i: usize, s: &str| -> bool { s.chars().enumerate().all(|(k, c)| at(i + k) == Some(c)) };
    let mut segments: Vec<(String, bool)> = Vec::new();
    let mut i = 0;
    while i < n {
        let c = w[i];
        // Consonant and vowel groups, longest first. (Pattern, phonemes, letters used, vowel?)
        let table: &[(&str, &str, bool)] = &[
            ("tch", "ʧ", false),
            ("dge", "ʤ", false),
            ("igh", "I", true),
            ("tion", "ʃᵊn", false),
            ("sion", "ʒᵊn", false),
            ("ture", "ʧɚ", false),
            ("ph", "f", false),
            ("sh", "ʃ", false),
            ("ch", "ʧ", false),
            ("th", "θ", false),
            ("ck", "k", false),
            ("ng", "ŋ", false),
            ("nk", "ŋk", false),
            ("wh", "w", false),
            ("qu", "kw", false),
            ("gh", "", false),
            ("ee", "i", true),
            ("ea", "i", true),
            ("ai", "A", true),
            ("ay", "A", true),
            ("oa", "O", true),
            ("ou", "W", true),
            ("oi", "Y", true),
            ("oy", "Y", true),
            ("oo", "u", true),
            ("au", "ɔ", true),
            ("aw", "ɔ", true),
            ("ew", "ju", true),
            ("ue", "u", true),
            ("ie", "i", true),
            ("ei", "A", true),
            ("ey", "i", true),
            ("ui", "u", true),
            ("ar", "ɑɹ", true),
            ("or", "ɔɹ", true),
            ("er", "ɚ", true),
            ("ir", "ɚ", true),
            ("ur", "ɚ", true),
            ("ll", "l", false),
            ("ss", "s", false),
            ("tt", "t", false),
            ("ff", "f", false),
            ("dd", "d", false),
            ("nn", "n", false),
            ("mm", "m", false),
            ("pp", "p", false),
            ("rr", "ɹ", false),
            ("bb", "b", false),
            ("gg", "ɡ", false),
            ("zz", "z", false),
            ("cc", "k", false),
        ];
        // Word-initial silent letters.
        if i == 0 && (starts(0, "kn") || starts(0, "gn")) {
            segments.push(("n".into(), false));
            i += 2;
            continue;
        }
        if i == 0 && starts(0, "wr") {
            segments.push(("ɹ".into(), false));
            i += 2;
            continue;
        }
        if starts(i, "mb") && i + 2 == n {
            segments.push(("m".into(), false));
            i += 2;
            continue;
        }
        // "ow" is O at the end of a word ("snow"), W elsewhere ("town").
        if starts(i, "ow") {
            segments.push((if i + 2 == n { "O" } else { "W" }.into(), true));
            i += 2;
            continue;
        }
        // A vowel, a consonant, then a silent e: the vowel says its own name ("make", "tune").
        if is_vowel(c) && c != 'e' && at(i + 1).is_some_and(|d| !is_vowel(d)) && at(i + 2) == Some('e') && (i + 3 == n || (i + 4 == n && matches!(at(i + 3), Some('s' | 'd' | 'r')))) {
            let long = match c {
                'a' => "A",
                'i' => "I",
                'o' => "O",
                _ => "ju",
            };
            segments.push((long.into(), true));
            segments.push((phoneme_for_consonant(at(i + 1).unwrap_or('x'), at(i + 2)), false));
            i += 3;
            continue;
        }
        if let Some((pattern, phonemes, vowel)) = table.iter().find(|(p, _, _)| starts(i, p)) {
            if !phonemes.is_empty() {
                segments.push((phonemes.to_string(), *vowel));
            }
            i += pattern.len();
            continue;
        }
        // Word-final "le" after a consonant: "table" -> "ᵊl". Final silent e.
        if c == 'l' && at(i + 1) == Some('e') && i + 2 == n && i > 0 && !is_vowel(w[i - 1]) {
            segments.push(("ᵊl".into(), true));
            i += 2;
            continue;
        }
        if c == 'e' && i + 1 == n && i > 1 && !is_vowel(w[i - 1]) {
            i += 1;
            continue;
        }
        match c {
            'a' => segments.push(("æ".into(), true)),
            'e' => segments.push(("ɛ".into(), true)),
            'i' => segments.push(("ɪ".into(), true)),
            'o' => segments.push(("ɑ".into(), true)),
            'u' => segments.push(("ʌ".into(), true)),
            'y' => {
                if i == 0 {
                    segments.push(("j".into(), false));
                } else if i + 1 == n {
                    segments.push((if segments.iter().filter(|s| s.1).count() >= 1 { "i" } else { "I" }.into(), true));
                } else {
                    segments.push(("ɪ".into(), true));
                }
            }
            's' if i > 0 && at(i + 1).is_some_and(is_vowel) && is_vowel(w[i - 1]) => segments.push(("z".into(), false)),
            _ => segments.push((phoneme_for_consonant(c, at(i + 1)), false)),
        }
        i += 1;
    }
    // Primary stress right before the first vowel sound.
    let mut out = String::new();
    let mut stressed = false;
    for (p, vowel) in &segments {
        if *vowel && !stressed {
            out.push('ˈ');
            stressed = true;
        }
        out.push_str(p);
    }
    out
}

fn phoneme_for_consonant(c: char, next: Option<char>) -> String {
    let soft = next.is_some_and(|n| matches!(n, 'e' | 'i' | 'y'));
    match c {
        'c' => if soft { "s" } else { "k" }.into(),
        'g' => if soft { "ʤ" } else { "ɡ" }.into(),
        'j' => "ʤ".into(),
        'q' => "k".into(),
        'r' => "ɹ".into(),
        'x' => "ks".into(),
        'h' => "h".into(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lex() -> Lexicon {
        Lexicon::from_pairs(&[
            ("the", "ði"),
            ("hello", "həlˈO"),
            ("world", "wˈɜɹld"),
            ("screen", "skɹˈin"),
            ("cast", "kˈæst"),
            ("cat", "kˈæt"),
            ("stop", "stˈɑp"),
            ("walk", "wˈɔk"),
            ("make", "mˈAk"),
            ("A", "ˈA"),
            ("B", "bˈi"),
            ("I", "ˈI"),
            ("M", "ˈɛm"),
            ("P", "pˈi"),
            ("AI", "ˈAˌI"),
        ])
    }

    #[test]
    fn numbers_are_spoken() {
        assert_eq!(number_to_words(0), "zero");
        assert_eq!(number_to_words(21), "twenty one");
        assert_eq!(number_to_words(105), "one hundred five");
        assert_eq!(number_to_words(1_234), "one thousand two hundred thirty four");
        assert_eq!(number_to_words(2_000_000), "two million");
        assert_eq!(number_to_words(1_000_001), "one million one");
    }

    #[test]
    fn normalization_reads_like_a_person() {
        assert_eq!(normalize("It cost $5.50 today."), "It cost five dollars and fifty cents today.");
        assert_eq!(normalize("Only $1."), "Only one dollar.");
        assert_eq!(normalize("Growth was 12.5%!"), "Growth was twelve point five percent!");
        assert_eq!(normalize("the 3rd of May"), "the third of May");
        assert_eq!(normalize("the 21st"), "the twenty first");
        assert_eq!(normalize("In 1984 and 2005."), "In nineteen eighty four and two thousand five.");
        assert_eq!(normalize("Meet at 3:30"), "Meet at three thirty");
        assert_eq!(normalize("Call at 10:05"), "Call at ten oh five");
        assert_eq!(normalize("Mr. Smith vs. Dr. Jones"), "mister Smith versus doctor Jones");
        assert_eq!(normalize("pages 10-20"), "pages ten to twenty");
        assert_eq!(normalize("a 5km run, 10GB"), "a five kilometers run, ten gigabytes");
        assert_eq!(normalize("Salt & pepper"), "Salt and pepper");
        assert_eq!(normalize("We have 1,500 users"), "We have one thousand five hundred users");
        assert_eq!(normalize("It’s “fine”"), "It's “fine”");
        assert_eq!(normalize("code 007"), "code zero zero seven");
    }

    #[test]
    fn dictionary_words_keep_their_pronunciation() {
        let l = lex();
        assert_eq!(phonemize("Hello world.", &l), "həlˈO wˈɜɹld.");
        // "the" before a vowel sound is "thee".
        assert_eq!(phonemize("the world", &l), "ðə wˈɜɹld");
        assert_eq!(phonemize("the AI", &l), "ði ˈAˌI");
    }

    #[test]
    fn endings_are_added_to_known_stems() {
        let l = lex();
        assert_eq!(phonemize("cats", &l), "kˈæts");
        assert_eq!(phonemize("walked", &l), "wˈɔkt");
        assert_eq!(phonemize("stopped", &l), "stˈɑpt");
        assert_eq!(phonemize("stopping", &l), "stˈɑpɪŋ");
        assert_eq!(phonemize("making", &l), "mˈAkɪŋ");
        assert_eq!(phonemize("the cat's", &l), "ðə kˈæts");
    }

    #[test]
    fn unknown_compounds_and_acronyms() {
        let l = lex();
        assert_eq!(phonemize("screencast", &l), "skɹˈinkˌæst");
        // Short unknown capitals are spelled.
        assert_eq!(phonemize("PAB", &l), "pˈi ˈA bˈi");
    }

    #[test]
    fn spelling_rules_give_something_pronounceable() {
        let s = spell_out("zorbak");
        assert!(s.starts_with("zˈɔɹ") && s.contains('b') && s.contains('k'), "{s}");
        assert!(spell_out("make").contains("ˈA"));
        assert!(spell_out("phone").starts_with('f'));
        // Every symbol it makes is one Kokoro knows.
        for w in ["briefcast", "xylophone", "knight", "quickly", "table", "schmidt", "yellow"] {
            assert!(spell_out(w).chars().all(|c| token_id(c).is_some()), "{w}: {}", spell_out(w));
        }
    }

    #[test]
    fn text_is_cut_into_sentences_with_pauses() {
        let l = lex();
        let chunks = speech_chunks("Hello world. Hello?\n\nHello world!", &l);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].pause_after, PAUSE_SENTENCE);
        assert_eq!(chunks[1].pause_after, PAUSE_PARAGRAPH);
        assert!(chunks[1].phonemes.ends_with('?'));
        assert_eq!(chunks[2].pause_after, 0.0);
    }

    #[test]
    fn long_sentences_are_cut_at_clauses_inside_the_window() {
        let l = lex();
        let text = vec!["hello world,"; 80].join(" ");
        let chunks = speech_chunks(&text, &l);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|c| c.phonemes.chars().count() <= MAX_CHUNK_TOKENS), "{:?}", chunks.iter().map(|c| c.phonemes.chars().count()).collect::<Vec<_>>());
        assert!(chunks.iter().all(|c| !c.phonemes.is_empty()));
    }

    #[test]
    fn silence_and_symbols_make_no_speech() {
        let l = lex();
        assert!(speech_chunks("...  !? ", &l).is_empty());
        assert!(speech_chunks("", &l).is_empty());
    }

    // Against the real dictionaries when a copy is at hand: BRIEFCAST_TTS_DICT=<folder with us_gold.json, us_silver.json>.
    #[test]
    fn real_dictionary_reads_a_script() {
        let Ok(dir) = std::env::var("BRIEFCAST_TTS_DICT") else { return };
        let read = |n: &str| std::fs::read_to_string(std::path::Path::new(&dir).join(n)).unwrap();
        let l = Lexicon::parse(&read("us_gold.json"), &read("us_silver.json")).unwrap();
        let chunks = speech_chunks("Welcome to Briefcast. In 2024 we shipped 3 new features, and it's the best release yet!", &l);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(c.phonemes.chars().all(|ch| token_id(ch).is_some()));
            println!("{}", c.phonemes);
        }
    }
}
