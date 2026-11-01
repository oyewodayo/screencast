// Which words on screen are secrets. Pure - fed OCR lines (words + boxes) by ocr.rs, tested on
// plain text below.
//
// Three kinds of evidence:
//   - The value itself has a shape nothing else has: provider key prefixes (sk-, AKIA, ghp_...),
//     JWTs, card numbers that pass Luhn, IBANs that pass mod-97, long high-entropy tokens.
//   - A label says what follows ("Password:", "Account number", "API_KEY="). Prose mentions the
//     same words ("forgot your password?"), so a label only counts when it's followed by ':' or
//     '=', ends its line (a form label above its field), or sits on a short form-like line.
//   - The user's own keywords.
// Over-blurring a word is cheap; missing a key is not - when in doubt, blur.
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub struct Word {
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Default)]
pub struct Line {
    pub words: Vec<Word>,
}

#[derive(Debug, Clone, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextRules {
    pub passwords: bool,
    pub keys: bool,
    pub financial: bool,
    pub personal: bool,
    pub keywords: Vec<String>,
}

impl Default for TextRules {
    fn default() -> Self {
        TextRules { passwords: true, keys: true, financial: true, personal: false, keywords: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub label: &'static str,
}

// Labels come in two strengths. Strong ones ("password", "IBAN", "API_KEY") mean what they say
// wherever they appear. Weak ones are everyday words too - "pin this message", "a business
// account", "Swift developer" - so they only count when followed by ':' or '='.
struct Patterns {
    keys: Vec<Regex>,
    // NAME=value / name: value assignments (.env files, YAML, JSON, code).
    assignment: Regex,
    connection_string: Regex,
    password_strong: Regex,
    password_weak: Regex,
    key_strong: Regex,
    key_weak: Regex,
    financial_strong: Regex,
    financial_weak: Regex,
    email: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        keys: [
            r"^sk-(?:ant-|proj-|live-)?[A-Za-z0-9_\-]{16,}$",
            r"^(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}$",
            r"^(?:AKIA|ASIA)[0-9A-Z]{16}$",
            r"^gh[pousr]_[A-Za-z0-9]{30,}$",
            r"^github_pat_[A-Za-z0-9_]{30,}$",
            r"^xox[abprs]-[A-Za-z0-9\-]{10,}$",
            // OCR often reads the capital I of Google's prefix as l, 1 or |.
            r"^A[Il1|]za[0-9A-Za-z_\-]{30,}$",
            r"^glpat-[A-Za-z0-9_\-]{20,}$",
            r"^npm_[A-Za-z0-9]{30,}$",
            r"^eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{4,}$",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("valid key pattern"))
        .collect(),
        // The name may contain spaces: OCR breaks words at underscores (API_KEY reads as "API KEY").
        assignment: Regex::new(r#"^\s*(?:export\s+)?["']?([A-Za-z][A-Za-z0-9_ .\-]{0,60}?)["']?\s*(?::=|=>|[:=])\s*(\S.*)$"#).unwrap(),
        connection_string: Regex::new(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://[^/\s:@]+:[^/\s@]+@").unwrap(),
        password_strong: Regex::new(r"^(?:password|passwd|passcode|passphrase|pwd)$").unwrap(),
        password_weak: Regex::new(r"^(?:pin|otp|pass)$").unwrap(),
        key_strong: Regex::new(r"^(?:apikey|api_key|api-key|access_key|secret_key|private_key|client_secret|auth_token|access_token|refresh_token|[a-z0-9_]*_(?:key|secret|token|password))$").unwrap(),
        key_weak: Regex::new(r"^(?:secret|token|bearer|authorization)$").unwrap(),
        financial_strong: Regex::new(r"^(?:iban|cvv|cvc|bvn|ssn)$").unwrap(),
        financial_weak: Regex::new(r"^(?:acct|account|a/c|routing|swift|bic)$").unwrap(),
        email: Regex::new(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+$").unwrap(),
    })
}

// OCR'd words carry punctuation and quotes from the code or prose around them.
fn clean(s: &str) -> &str {
    s.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '<' | '>'))
}

fn digits_only(s: &str) -> Option<String> {
    let d: String = s.chars().filter(|c| c.is_ascii_digit()).collect();
    if !d.is_empty() && s.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '.') { Some(d) } else { None }
}

pub fn luhn(digits: &str) -> bool {
    let mut sum = 0;
    for (i, c) in digits.chars().rev().enumerate() {
        let Some(mut d) = c.to_digit(10) else { return false };
        if i % 2 == 1 {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
    }
    !digits.is_empty() && sum % 10 == 0
}

pub fn iban_valid(s: &str) -> bool {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_uppercase();
    if s.len() < 15 || s.len() > 34 || !s.chars().all(|c| c.is_ascii_alphanumeric()) {
        return false;
    }
    let b = s.as_bytes();
    if !(b[0].is_ascii_alphabetic() && b[1].is_ascii_alphabetic() && b[2].is_ascii_digit() && b[3].is_ascii_digit()) {
        return false;
    }
    let rearranged = format!("{}{}", &s[4..], &s[..4]);
    let mut rem: u32 = 0;
    for c in rearranged.chars() {
        let v = if c.is_ascii_digit() { c as u32 - '0' as u32 } else { c as u32 - 'A' as u32 + 10 };
        for d in v.to_string().chars() {
            rem = (rem * 10 + d.to_digit(10).unwrap()) % 97;
        }
    }
    rem == 1
}

// Random-looking tokens (keys from providers we don't know by prefix). Mixed case + digits is
// required, which keeps out hex hashes, base-10 ids and ordinary long words.
fn high_entropy(s: &str) -> bool {
    if s.len() < 32 || !s.chars().all(|c| c.is_ascii_alphanumeric() || "+/_=-.".contains(c)) {
        return false;
    }
    let (up, low, dig) = s.chars().fold((false, false, false), |(u, l, d), c| (u || c.is_ascii_uppercase(), l || c.is_ascii_lowercase(), d || c.is_ascii_digit()));
    if !(up && low && dig) {
        return false;
    }
    let mut counts = [0u32; 128];
    for c in s.bytes() {
        counts[(c & 127) as usize] += 1;
    }
    let n = s.len() as f64;
    let entropy: f64 = counts.iter().filter(|&&c| c > 0).map(|&c| {
        let p = c as f64 / n;
        -p * p.log2()
    }).sum();
    entropy >= 4.0
}

// (label, strong).
fn key_label(rules: &TextRules, p: &Patterns, word: &str) -> Option<(&'static str, bool)> {
    let w = word.to_lowercase();
    for (on, strong, weak, label) in [
        (rules.passwords, &p.password_strong, &p.password_weak, "Password"),
        (rules.keys, &p.key_strong, &p.key_weak, "Secret"),
        (rules.financial, &p.financial_strong, &p.financial_weak, "Account number"),
    ] {
        if on && strong.is_match(&w) {
            return Some((label, true));
        }
        if on && weak.is_match(&w) {
            return Some((label, false));
        }
    }
    None
}

// Whether words look like a value someone would hide: a digit or a symbol in them. "hunter2",
// "0123456789", "c0rrect-h0rse" do; "tomorrow" and "message" don't.
fn looks_like_value(words: &[Word]) -> bool {
    words.iter().any(|w| {
        clean(&w.text)
            .trim_end_matches(['.', ',', '!', '?'])
            .chars()
            .any(|c| c.is_ascii_digit() || (!c.is_alphabetic() && !c.is_whitespace()))
    })
}

// Splits an assignment's name into lowercase words: at non-alphanumerics (OCR's spaces, '_', '-',
// '.') and camelCase humps - "OPENAI_API_KEY" and "apiKey" both end in "key".
fn name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut prev_lower = false;
    for c in name.chars() {
        if !c.is_ascii_alphanumeric() {
            if !cur.is_empty() {
                words.push(std::mem::take(&mut cur));
            }
            prev_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && prev_lower && !cur.is_empty() {
            words.push(std::mem::take(&mut cur));
        }
        prev_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        cur.push(c.to_ascii_lowercase());
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words
}

// Whether an assignment's name says its value is secret - judged by its *last* word (so
// "GOOGLE_CLIENT_SECRET" counts and "GH_CLIENT_ID", "Token expiry" don't), skipping environment
// suffixes like "_LIVE". Returns the label.
fn secret_name(rules: &TextRules, name: &str) -> Option<&'static str> {
    const ENV_SUFFIX: [&str; 10] = ["live", "test", "prod", "production", "dev", "staging", "v1", "v2", "b64", "base64"];
    let words = name_words(name);
    let last = words.iter().rev().find(|w| !ENV_SUFFIX.contains(&w.as_str()))?;
    match last.as_str() {
        "password" | "passwd" | "pwd" | "pass" | "passphrase" | "passcode" | "pin" | "otp" if rules.passwords => Some("Password"),
        "key" | "apikey" | "secret" | "token" | "credential" | "credentials" | "auth" | "signature" | "salt" | "dsn" | "privatekey" | "jwt"
            if rules.keys =>
        {
            Some("Secret")
        }
        _ => None,
    }
}

// Two-word labels ("api key", "account number", "card number", "private key", "sort code") - all
// strong: as a phrase they're specific enough.
fn pair_label(rules: &TextRules, a: &str, b: &str) -> Option<&'static str> {
    let pair = format!("{} {}", a.to_lowercase(), b.to_lowercase());
    match pair.as_str() {
        "api key" | "access key" | "secret key" | "private key" | "client secret" | "access token" | "auth token" if rules.keys => Some("Secret"),
        "account number" | "account no" | "card number" | "sort code" | "routing number" | "security code" if rules.financial => Some("Account number"),
        "one-time code" | "verification code" | "security pin" if rules.passwords => Some("Password"),
        _ => None,
    }
}

fn union(words: &[Word]) -> (f32, f32, f32, f32) {
    let x0 = words.iter().map(|w| w.x).fold(f32::MAX, f32::min);
    let y0 = words.iter().map(|w| w.y).fold(f32::MAX, f32::min);
    let x1 = words.iter().map(|w| w.x + w.w).fold(f32::MIN, f32::max);
    let y1 = words.iter().map(|w| w.y + w.h).fold(f32::MIN, f32::max);
    (x0, y0, x1 - x0, y1 - y0)
}

fn hit(words: &[Word], label: &'static str) -> Hit {
    let (x, y, w, h) = union(words);
    Hit { x, y, w, h, label }
}

pub fn find_sensitive(lines: &[Line], rules: &TextRules) -> Vec<Hit> {
    let p = patterns();
    let mut hits = Vec::new();
    let keywords: Vec<String> = rules.keywords.iter().map(|k| k.trim().to_lowercase()).filter(|k| !k.is_empty()).collect();
    let mut in_pem = false;

    for (li, line) in lines.iter().enumerate() {
        let words = &line.words;
        if words.is_empty() {
            continue;
        }
        let text: String = words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" ");

        // PEM private keys: the whole block, BEGIN through END.
        if rules.keys {
            let upper = text.to_uppercase();
            if upper.contains("BEGIN") && upper.contains("PRIVATE KEY") {
                in_pem = true;
            }
            if in_pem {
                hits.push(hit(words, "Private key"));
                if upper.contains("END") && upper.contains("PRIVATE KEY") {
                    in_pem = false;
                }
                continue;
            }
        }

        let mut covered = vec![false; words.len()];
        // Marks words[from..to] - only the runs no earlier rule already claimed, so a key found by
        // its own shape keeps its more specific label.
        let mark = |hits: &mut Vec<Hit>, covered: &mut Vec<bool>, from: usize, to: usize, label: &'static str| {
            let mut k = from;
            while k < to.min(words.len()) {
                if covered[k] {
                    k += 1;
                    continue;
                }
                let start = k;
                while k < to.min(words.len()) && !covered[k] {
                    covered[k] = true;
                    k += 1;
                }
                hits.push(hit(&words[start..k], label));
            }
        };

        // Pass 0: an assignment whose name says secret ("POLAR_ACCESS_TOKEN=...", "apiKey: '...'")
        // covers its value from just after the '=' to the end of the line - however OCR chopped
        // the value into words, and even when the value has no recognizable shape.
        if let Some(caps) = p.assignment.captures(&text) {
            let (name, value) = (caps.get(1).expect("group 1"), caps.get(2).expect("group 2"));
            let has_value = !value.as_str().trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | ';' | ' ')).is_empty();
            if let Some(label) = secret_name(rules, name.as_str()).filter(|_| has_value) {
                // The more specific label when the value is a provider key by its own shape.
                let first = clean(value.as_str().split_whitespace().next().unwrap_or(""));
                let label = if rules.keys && p.keys.iter().any(|re| re.is_match(first)) { "API key" } else { label };
                // Back from a byte offset in the joined line to a word, and a spot inside it.
                let pos = value.start();
                let mut offset = 0usize;
                for (i, w) in words.iter().enumerate() {
                    let end = offset + w.text.len();
                    if pos < end || i + 1 == words.len() {
                        let within = pos.saturating_sub(offset).min(w.text.len());
                        let x = w.x + w.w * within as f32 / w.text.len().max(1) as f32;
                        let (ux, uy, uw, uh) = union(&words[i..]);
                        hits.push(Hit { x, y: uy, w: (ux + uw - x).max(1.0), h: uh, label });
                        for c in covered.iter_mut().skip(i) {
                            *c = true;
                        }
                        break;
                    }
                    offset = end + 1; // the space the words were joined with
                }
            }
        }

        // Pass 0b: a secret *name* whose value OCR didn't return - it drops what it can't read as
        // words, which is exactly what a key looks like ("STRIPE_SECRET", "OPENAI API KEY=").
        // Reported zero-width at the name's end; the OCR thread extends it along the line's ink,
        // and drops it if no value is actually there. Only identifier-like names count, so a
        // chat preview ending in "token" doesn't.
        if !covered.iter().any(|c| *c) && words.len() <= 6 {
            if let Some(last) = words.last() {
                let raw = clean(&last.text);
                let identifier = raw.ends_with('=') || raw.ends_with(':') || name_words(raw).len() >= 2;
                if let Some(label) = secret_name(rules, raw.trim_end_matches(['=', ':'])).filter(|_| identifier) {
                    hits.push(Hit { x: last.x + last.w, y: last.y, w: 0.0, h: last.h, label });
                }
            }
        }

        // Pass 1: words that are secrets by their own shape. KEY=value and key:value inside one
        // word ("OPENAI_API_KEY=sk-...") are judged by the value.
        for j in 0..words.len() {
            let raw = clean(&words[j].text);
            let value = raw.find(['=', ':']).filter(|&i| i > 0).map(|i| raw[i + 1..].trim_matches(|c| c == '"' || c == '\'')).filter(|v| !v.is_empty());
            let candidate = value.unwrap_or(raw);
            if rules.keys && (p.connection_string.is_match(candidate) || p.connection_string.is_match(raw)) {
                mark(&mut hits, &mut covered, j, j + 1, "Connection string");
            } else if rules.keys && p.keys.iter().any(|re| re.is_match(candidate)) {
                mark(&mut hits, &mut covered, j, j + 1, "API key");
            } else if rules.keys && high_entropy(candidate) {
                mark(&mut hits, &mut covered, j, j + 1, "Secret");
            } else if rules.personal && p.email.is_match(raw) {
                mark(&mut hits, &mut covered, j, j + 1, "Email");
            }
        }

        // Pass 2: labels, and what they point at.
        for j in 0..words.len() {
            if covered[j] {
                continue;
            }
            let raw = clean(&words[j].text);
            let (name, value) = match raw.find(['=', ':']) {
                Some(i) if i > 0 => (&raw[..i], Some(raw[i + 1..].trim_matches(|c| c == '"' || c == '\''))),
                _ => (raw, None),
            };

            // A label: two words ("account number:") tried before one, optionally with its ':' or
            // '='. Phrases are always strong; single words may be weak.
            let pair = (j + 1 < words.len())
                .then(|| pair_label(rules, name, clean(&words[j + 1].text).trim_end_matches([':', '='])))
                .flatten();
            let (label, strong, label_end) = match (pair, key_label(rules, p, name.trim_end_matches([':', '=']))) {
                (Some(l), _) => (Some(l), true, j + 2),
                (None, Some((l, strong))) => (Some(l), strong, j + 1),
                (None, None) => (None, false, j + 1),
            };
            if let Some(label) = label {
                let last_label_word = clean(&words[label_end - 1].text);
                let punctuated = last_label_word.ends_with(':') || last_label_word.ends_with('=') || value.is_some()
                    || words.get(label_end).is_some_and(|w| matches!(w.text.as_str(), ":" | "=" | "=>"));
                // A short form-like line ("Password  hunter2"): only for strong labels, and only
                // when what follows actually looks like a value.
                let form_like = strong && words.len() <= 4 && looks_like_value(&words[label_end.min(words.len())..]);
                if value.is_some_and(|v| !v.is_empty()) {
                    // "password:hunter2" - the value shares the label's word.
                    mark(&mut hits, &mut covered, j, label_end.max(j + 1), label);
                    if label_end < words.len() && punctuated {
                        mark(&mut hits, &mut covered, label_end, words.len(), label);
                    }
                } else if label_end < words.len() && (punctuated || form_like) {
                    let start = if matches!(words[label_end].text.as_str(), ":" | "=" | "=>") { label_end + 1 } else { label_end };
                    mark(&mut hits, &mut covered, start, words.len(), label);
                } else if label_end == words.len() && (strong || punctuated) {
                    // A form label on its own line: the field is the next line, just below it - if
                    // that line is short and looks like a value (not a chat preview or a sentence).
                    if let Some(next) = lines.get(li + 1).filter(|n| !n.words.is_empty() && n.words.len() <= 3 && looks_like_value(&n.words)) {
                        let (lx, ly, lw, lh) = union(words);
                        let (nx, ny, _, _) = union(&next.words);
                        if ny - (ly + lh) < lh * 2.0 && (nx - lx).abs() < lw.max(lh * 6.0) {
                            hits.push(hit(&next.words, label));
                        }
                    }
                }
            }
        }

        // Numbers that span several words: cards ("4111 1111 1111 1111") and phone numbers.
        if rules.financial || rules.personal {
            let mut j = 0;
            while j < words.len() {
                let mut digits = String::new();
                let mut k = j;
                let mut best: Option<(usize, &'static str)> = None;
                while k < words.len() {
                    let Some(d) = digits_only(clean(&words[k].text).trim_start_matches('+')) else { break };
                    digits.push_str(&d);
                    k += 1;
                    if rules.financial && (13..=19).contains(&digits.len()) && luhn(&digits) {
                        best = Some((k, "Card number"));
                    } else if rules.personal && best.is_none() && (10..=15).contains(&digits.len()) && clean(&words[j].text).starts_with('+') {
                        best = Some((k, "Phone number"));
                    }
                    if digits.len() > 19 {
                        break;
                    }
                }
                if let Some((end, label)) = best {
                    mark(&mut hits, &mut covered, j, end, label);
                    j = end;
                } else {
                    j += 1;
                }
            }
        }

        // IBANs, usually printed in groups of four.
        if rules.financial {
            for j in 0..words.len() {
                let mut joined = String::new();
                for k in j..words.len().min(j + 9) {
                    joined.push_str(clean(&words[k].text));
                    if joined.len() >= 15 && iban_valid(&joined) {
                        mark(&mut hits, &mut covered, j, k + 1, "IBAN");
                        break;
                    }
                    if joined.len() > 34 {
                        break;
                    }
                }
            }
        }

        // The user's own words and phrases.
        for kw in &keywords {
            let parts: Vec<&str> = kw.split_whitespace().collect();
            for j in 0..words.len() {
                if j + parts.len() > words.len() {
                    break;
                }
                let matched = parts.iter().enumerate().all(|(i, part)| clean(&words[j + i].text).to_lowercase().contains(part));
                if matched {
                    mark(&mut hits, &mut covered, j, j + parts.len(), "Keyword");
                }
            }
        }
    }
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    // Lays text out like OCR would: one line per string, words 10px apart, lines 24px apart.
    fn lines(text: &[&str]) -> Vec<Line> {
        text.iter()
            .enumerate()
            .map(|(i, t)| {
                let mut x = 10.0;
                Line {
                    words: t
                        .split_whitespace()
                        .map(|w| {
                            let word = Word { text: w.to_string(), x, y: 10.0 + i as f32 * 24.0, w: w.len() as f32 * 8.0, h: 16.0 };
                            x += word.w + 10.0;
                            word
                        })
                        .collect(),
                }
            })
            .collect()
    }

    fn labels(text: &[&str], rules: &TextRules) -> Vec<&'static str> {
        find_sensitive(&lines(text), rules).into_iter().map(|h| h.label).collect()
    }

    #[test]
    fn provider_keys() {
        let r = TextRules::default();
        assert_eq!(labels(&["OPENAI_API_KEY=sk-proj-abc123DEF456ghi789JKL"], &r), vec!["API key"]);
        assert_eq!(labels(&["aws_access_key_id = AKIAIOSFODNN7EXAMPLE"], &r), vec!["API key"]);
        assert_eq!(labels(&["token: ghp_1234567890abcdefghijABCDEFGHIJ123456"], &r).first(), Some(&"API key"));
        assert!(labels(&["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N"], &r).contains(&"API key"));
    }

    #[test]
    fn labelled_values() {
        let r = TextRules::default();
        assert_eq!(labels(&["Password: hunter2"], &r), vec!["Password"]);
        assert_eq!(labels(&["Account number: 0123456789"], &r), vec!["Account number"]);
        // A form label above its field.
        assert_eq!(labels(&["Password", "c0rrect-h0rse"], &r), vec!["Password"]);
        assert_eq!(labels(&["Password  hunter2"], &r), vec!["Password"]);
    }

    // What a WhatsApp chat list looks like to OCR: names over short previews. Everyday words that
    // happen to be weak labels must not blur anything.
    #[test]
    fn chat_lists_are_left_alone() {
        let r = TextRules::default();
        assert!(labels(&["Bank Account", "See you tomorrow"], &r).is_empty());
        assert!(labels(&["Pin this message"], &r).is_empty());
        assert!(labels(&["Token", "Hello there"], &r).is_empty());
        assert!(labels(&["Swift developer", "Available"], &r).is_empty());
        assert!(labels(&["Pass me the file"], &r).is_empty());
        // ...while a real labelled value still is.
        assert_eq!(labels(&["PIN: 4821"], &r), vec!["Password"]);
    }

    #[test]
    fn prose_is_left_alone() {
        let r = TextRules::default();
        assert!(labels(&["If you forgot your password we will email a reset link to you today"], &r).is_empty());
        assert!(labels(&["The token expires after one hour unless it is refreshed by the client"], &r).is_empty());
        // A git hash is hex - no mixed case, not a secret.
        assert!(labels(&["commit 3b392ae1f0c9d8e7b6a5f4e3d2c1b0a9f8e7d6c5"], &r).is_empty());
    }

    #[test]
    fn cards_and_ibans() {
        let r = TextRules::default();
        assert_eq!(labels(&["Card 4111 1111 1111 1111 exp 12/29"], &r), vec!["Card number"]);
        assert!(labels(&["Order 4111 1111 1111 1112"], &r).is_empty(), "fails Luhn");
        assert_eq!(labels(&["IBAN GB82 WEST 1234 5698 7654 32"], &r).last(), Some(&"IBAN"));
    }

    #[test]
    fn private_key_block() {
        let r = TextRules::default();
        let got = labels(&["-----BEGIN RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM", "-----END RSA PRIVATE KEY-----", "done"], &r);
        assert_eq!(got, vec!["Private key", "Private key", "Private key"]);
    }

    // Word splits exactly as Windows OCR returned them for a rendered editor (it breaks words at
    // underscores and sometimes drops short pieces).
    #[test]
    fn real_ocr_tokenization() {
        let r = TextRules::default();
        assert_eq!(labels(&["OPENAI API KEY=sk-proj-abc123DEF456ghi789JKL"], &r), vec!["API key"]);
        assert_eq!(labels(&["aws = AKIAIOSFODNN7EXAMPLE"], &r), vec!["API key"]);
        assert_eq!(labels(&["DB PASSWORD=s3cretValue"], &r), vec!["Password"]);
        assert_eq!(labels(&["Pay with 4242 4242 4242 4242 today"], &r), vec!["Card number"]);
    }

    // A .env file as OCR returns it (underscores read as spaces), with made-up values.
    #[test]
    fn env_assignments() {
        let r = TextRules::default();
        let lines = lines(&[
            "POLAR ACCESS TOKEN=polar_oat_fakeFAKEfake0000",
            "GOOGLE CLIENT SECRET=GOCSPX-fakeFAKE-fake",
            "GH CLIENT ID=0v23liFAKEFAKE",
            "CLAUDEAI API KEY=sk-ant-api03-FAKE- FAKEfakeFAKE",
            "OPENAI ORGANIZATION=",
            "DATABASE URL=postgres://app:pa55word@db:5432/app",
            "Keyboard: mechanical",
            "Token expiry: 5 minutes",
            "  apiKey: 'fake-value'",
        ]);
        let got: Vec<(usize, &str)> = find_sensitive(&lines, &r).iter().map(|h| (((h.y - 10.0) / 24.0).round() as usize, h.label)).collect();
        assert_eq!(got, vec![(0, "Secret"), (1, "Secret"), (3, "Secret"), (5, "Connection string"), (8, "Secret")]);
        // The value's blur starts after the '=' and runs to the end of the line, across words.
        let claude = find_sensitive(&lines[3..4], &r);
        let words = &lines[3].words;
        let line_end = words.last().map(|w| w.x + w.w).unwrap();
        assert!(claude[0].x > words[2].x && (claude[0].x + claude[0].w - line_end).abs() < 0.5, "{:?}", claude);
    }

    // What OCR really returned for .env lines whose values it couldn't read.
    #[test]
    fn names_whose_values_ocr_dropped() {
        let r = TextRules::default();
        for line in ["STRIPE_SECRET", "OPENAI API KEY=", "  apiToken:"] {
            let hits = find_sensitive(&lines(&[line]), &r);
            assert_eq!(hits.len(), 1, "{}", line);
            assert_eq!(hits[0].w, 0.0, "zero-width, to be extended along the ink");
        }
        assert!(find_sensitive(&lines(&["Token"]), &r).is_empty());
        assert!(find_sensitive(&lines(&["OPENAI ORGANIZATION="]), &r).is_empty());
    }

    #[test]
    fn categories_and_keywords() {
        let mut r = TextRules { passwords: false, keys: false, financial: false, personal: false, keywords: vec!["Project Falcon".into()] };
        assert!(labels(&["Password: hunter2"], &r).is_empty());
        assert_eq!(labels(&["Kickoff for project falcon tomorrow"], &r), vec!["Keyword"]);
        r.personal = true;
        assert_eq!(labels(&["mail me at jane.doe@example.com"], &r), vec!["Email"]);
    }
}
