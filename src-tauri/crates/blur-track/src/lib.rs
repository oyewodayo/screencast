//! Frame maths for the sensitive-text blur: keeping each blur glued to the text it hides while the
//! window scrolls, between OCR passes.
//!
//! OCR takes a few hundred milliseconds; a scroll moves text every frame. So each blur is tracked
//! on a small (quarter-resolution) grey copy of every captured frame: the rows under it are reduced
//! to one number each (a row signature - the sum of the pixels across the blur's columns), and the
//! vertical offset where the old signatures line up with the new ones is how far that text moved.
//! Text lines give signatures plenty of shape; matching a stretch of them with surrounding context
//! (not just the blurred line) is what keeps near-identical lines - a .env file - from aliasing.

/// A greyscale frame, row-major, tightly packed.
#[derive(Clone)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u8>,
}

impl Gray {
    /// From BGRA rows `pitch` bytes apart (a mapped GPU texture).
    pub fn from_bgra(data: &[u8], w: usize, h: usize, pitch: usize) -> Gray {
        let mut px = Vec::with_capacity(w * h);
        for y in 0..h {
            let row = &data[y * pitch..y * pitch + w * 4];
            px.extend(row.chunks_exact(4).map(|p| ((p[2] as u32 * 77 + p[1] as u32 * 150 + p[0] as u32 * 29) >> 8) as u8));
        }
        Gray { w, h, px }
    }

    pub fn same_as(&self, other: &Gray) -> bool {
        self.w == other.w && self.h == other.h && self.px == other.px
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Shift {
    /// The text is where it was.
    Still,
    /// The text moved this many rows (positive = down).
    Moved(i32),
    /// Can't tell: featureless, or the content was replaced rather than moved.
    Unknown,
}

fn signature(g: &Gray, x0: usize, x1: usize, rows: std::ops::Range<usize>) -> Vec<i32> {
    rows.map(|y| g.px[y * g.w + x0..y * g.w + x1].iter().map(|&v| v as i32).sum()).collect()
}

/// How far the content in columns x0..x1, rows y0..y1 of `prev` moved vertically in `cur`, looking
/// up to `max_shift` rows either way.
pub fn vertical_shift(prev: &Gray, cur: &Gray, x0: usize, x1: usize, y0: usize, y1: usize, max_shift: usize) -> Shift {
    if prev.w != cur.w || prev.h != cur.h {
        return Shift::Unknown;
    }
    let (w, h) = (prev.w, prev.h);
    let (x0, x1) = (x0.min(w), x1.min(w));
    let (y0, y1) = (y0.min(h), y1.min(h));
    if x1 < x0 + 4 || y1 <= y0 {
        return Shift::Unknown;
    }
    // The blurred rows plus generous context above and below.
    let context = (y1 - y0) * 3 + 8;
    let (t0, t1) = (y0.saturating_sub(context), (y1 + context).min(h));
    let template = signature(prev, x0, x1, t0..t1);
    let texture: i64 = template.windows(2).map(|p| (p[1] - p[0]).abs() as i64).sum();
    if texture < ((x1 - x0) * (t1 - t0)) as i64 / 2 {
        return Shift::Unknown;
    }
    let (s0, s1) = (t0.saturating_sub(max_shift), (t1 + max_shift).min(h));
    let search = signature(cur, x0, x1, s0..s1);
    let sad = |d: i64| -> Option<f64> {
        let (mut total, mut n) = (0i64, 0usize);
        for (i, &v) in template.iter().enumerate() {
            let y = (t0 + i) as i64 + d;
            if y < s0 as i64 || y >= s1 as i64 {
                continue;
            }
            total += (v - search[(y - s0 as i64) as usize]).abs() as i64;
            n += 1;
        }
        // Too little overlap to judge (the text is scrolling off the edge).
        (n * 10 >= template.len() * 6).then(|| total as f64 / n as f64)
    };
    let still = sad(0).unwrap_or(f64::MAX);
    // Identical (or near enough: anti-aliasing noise, a blinking caret elsewhere on the line).
    if still <= (x1 - x0) as f64 * 1.5 {
        return Shift::Still;
    }
    let scores: Vec<(i64, f64)> = (-(max_shift as i64)..=max_shift as i64).filter_map(|d| sad(d).map(|s| (d, s))).collect();
    let Some(&best) = scores.iter().min_by(|a, b| a.1.total_cmp(&b.1)) else { return Shift::Unknown };
    // The runner-up away from the winner's own neighbourhood. Lines of text repeat at a fixed
    // pitch, so a lucky alignment of *different* content can score well too; a real move is a
    // clear winner, at least twice as good as any other offset.
    let runner_up = scores.iter().filter(|(d, _)| (d - best.0).abs() > 2).map(|(_, s)| *s).fold(f64::MAX, f64::min);
    if best.0 != 0 && best.1 < still * 0.35 && best.1 * 2.0 <= runner_up { Shift::Moved(best.0 as i32) } else { Shift::Unknown }
}

/// What changed between two frames: the bounding box of pixels that differ by more than a little
/// (anti-aliasing noise doesn't count), and how many. None when nothing did.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Change {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
    pub pixels: usize,
}

impl Change {
    /// A blinking text caret: a sliver at most `max_w` wide. Typing changes more than that (the
    /// glyph plus the caret's old and new spots), so it never looks like one.
    pub fn is_caret(&self, max_w: usize) -> bool {
        self.x1 - self.x0 <= max_w
    }
}

pub fn change(a: &Gray, b: &Gray) -> Option<Change> {
    if a.w != b.w || a.h != b.h {
        return Some(Change { x0: 0, y0: 0, x1: b.w, y1: b.h, pixels: b.w * b.h });
    }
    let (mut x0, mut y0, mut x1, mut y1, mut pixels) = (usize::MAX, usize::MAX, 0, 0, 0);
    for y in 0..a.h {
        let (ra, rb) = (&a.px[y * a.w..(y + 1) * a.w], &b.px[y * b.w..(y + 1) * b.w]);
        for x in 0..a.w {
            if (ra[x] as i32 - rb[x] as i32).abs() > 12 {
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x + 1);
                y1 = y1.max(y + 1);
                pixels += 1;
            }
        }
    }
    (pixels > 0).then_some(Change { x0, y0, x1, y1, pixels })
}

/// Where text actually is, from the pixels alone: "ink" is anything well away from the window's
/// background colour. Windows' OCR silently drops what it can't read as words - and a secret is
/// exactly that - so the ink is what tells how far a value really runs, and which lines of a
/// secrets file OCR never returned at all.
pub struct InkMap {
    pub w: usize,
    pub h: usize,
    ink: Vec<bool>,
}

impl InkMap {
    /// From a tightly packed BGRA image. The background is the most common grey level.
    pub fn new(bgra: &[u8], w: usize, h: usize) -> InkMap {
        let lum: Vec<u8> = bgra.chunks_exact(4).map(|p| ((p[2] as u32 * 77 + p[1] as u32 * 150 + p[0] as u32 * 29) >> 8) as u8).collect();
        let mut hist = [0u32; 256];
        for v in lum.iter().step_by(7) {
            hist[*v as usize] += 1;
        }
        let bg = hist.iter().enumerate().max_by_key(|(_, c)| **c).map(|(v, _)| v as i32).unwrap_or(255);
        InkMap { w, h, ink: lum.iter().map(|&v| (v as i32 - bg).abs() > 48).collect() }
    }

    fn column_has_ink(&self, x: usize, y0: usize, y1: usize) -> bool {
        (y0..y1.min(self.h)).any(|y| self.ink[y * self.w + x])
    }

    /// The end (exclusive) of the ink on rows y0..y1, starting at column `from` and allowing gaps
    /// of up to `max_gap` columns (spaces between words). None if there's no ink at all.
    pub fn ink_end(&self, y0: usize, y1: usize, from: usize, max_gap: usize) -> Option<usize> {
        let (mut last, mut gap) = (None, 0);
        for x in from.min(self.w)..self.w {
            if self.column_has_ink(x, y0, y1) {
                last = Some(x + 1);
                gap = 0;
            } else if last.is_some() || x > from + max_gap {
                gap += 1;
                if gap > max_gap {
                    break;
                }
            }
        }
        last
    }

    /// Bands of rows that hold text: runs of rows with ink, between `min_h` and `max_h` tall.
    pub fn text_bands(&self, min_h: usize, max_h: usize) -> Vec<(usize, usize)> {
        let rows: Vec<bool> = (0..self.h).map(|y| self.ink[y * self.w..(y + 1) * self.w].iter().filter(|&&i| i).count() >= 2).collect();
        let mut bands = Vec::new();
        let mut y = 0;
        while y < self.h {
            if !rows[y] {
                y += 1;
                continue;
            }
            let start = y;
            while y < self.h && rows[y] {
                y += 1;
            }
            if (min_h..=max_h).contains(&(y - start)) {
                bands.push((start, y));
            }
        }
        bands
    }

    /// Runs of ink across rows y0..y1 that `covered` (columns OCR returned words for) doesn't
    /// account for, merging gaps up to `max_gap` and keeping runs at least `min_w` wide.
    pub fn unread_runs(&self, y0: usize, y1: usize, covered: &[bool], max_gap: usize, min_w: usize) -> Vec<(usize, usize)> {
        let mut runs: Vec<(usize, usize)> = Vec::new();
        let mut current: Option<(usize, usize)> = None;
        for x in 0..self.w {
            if !covered.get(x).copied().unwrap_or(false) && self.column_has_ink(x, y0, y1) {
                current = match current {
                    Some((s, e)) if x <= e + max_gap => Some((s, x + 1)),
                    Some(run) => {
                        runs.push(run);
                        Some((x, x + 1))
                    }
                    None => Some((x, x + 1)),
                };
            }
        }
        runs.extend(current);
        runs.retain(|(s, e)| e - s >= min_w);
        runs
    }
}

/// Average colour (r, g, b) of a region of a tightly packed BGRA image.
pub fn average_bgra(data: &[u8], w: usize, h: usize, x0: i64, y0: i64, x1: i64, y1: i64) -> Option<(u8, u8, u8)> {
    let (x0, y0) = (x0.clamp(0, w as i64) as usize, y0.clamp(0, h as i64) as usize);
    let (x1, y1) = (x1.clamp(0, w as i64) as usize, y1.clamp(0, h as i64) as usize);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let step = (((x1 - x0) * (y1 - y0)) as f64 / 4096.0).sqrt().max(1.0) as usize;
    let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
    for y in (y0..y1).step_by(step) {
        for x in (x0..x1).step_by(step) {
            let i = (y * w + x) * 4;
            b += data[i] as u64;
            g += data[i + 1] as u64;
            r += data[i + 2] as u64;
            n += 1;
        }
    }
    (n > 0).then(|| ((r / n) as u8, (g / n) as u8, (b / n) as u8))
}

#[cfg(test)]
mod tests {
    use super::*;

    // An editor-like frame: a line-number gutter, then lines of "text" (runs of dark pixels with
    // ragged lengths) every 6 rows, starting `scroll` rows up.
    fn editor(w: usize, h: usize, scroll: usize, seed: u32) -> Gray {
        let mut px = vec![30u8; w * h];
        for y in 0..h {
            let line = (y + scroll) / 6;
            let in_text = (y + scroll) % 6 < 3;
            for x in 0..w {
                if x < 12 {
                    px[y * w + x] = 60;
                    continue;
                }
                let len = 20 + ((line as u32).wrapping_mul(2654435761).wrapping_add(seed) % 140) as usize;
                if in_text && x - 12 < len && ((x + line) % 5 != 0) {
                    px[y * w + x] = 210;
                }
            }
        }
        Gray { w, h, px }
    }

    #[test]
    fn still_when_nothing_moved() {
        let a = editor(240, 135, 0, 1);
        assert_eq!(vertical_shift(&a, &a.clone(), 12, 200, 60, 66, 40), Shift::Still);
    }

    #[test]
    fn follows_a_scroll_both_ways() {
        let a = editor(240, 135, 30, 1);
        // Scrolled down by 7 rows: content moves up.
        let b = editor(240, 135, 37, 1);
        assert_eq!(vertical_shift(&a, &b, 12, 200, 60, 66, 40), Shift::Moved(-7));
        // Scrolled up by 11 rows: content moves down.
        let c = editor(240, 135, 19, 1);
        assert_eq!(vertical_shift(&a, &c, 12, 200, 60, 66, 40), Shift::Moved(11));
    }

    #[test]
    fn unknown_when_content_is_replaced() {
        let a = editor(240, 135, 0, 1);
        let b = editor(240, 135, 0, 99);
        assert_eq!(vertical_shift(&a, &b, 12, 200, 60, 66, 40), Shift::Unknown);
    }

    #[test]
    fn caret_blinks_are_slivers() {
        let a = editor(240, 135, 0, 1);
        let mut b = a.clone();
        assert_eq!(change(&a, &b), None);
        // A caret: 1px wide, a line tall.
        for y in 60..66 {
            b.px[y * b.w + 100] = 255;
        }
        assert!(change(&a, &b).is_some_and(|c| c.is_caret(2)));
        // Typing a character: a glyph's worth of pixels plus the caret one step on.
        for y in 60..66 {
            for x in 100..104 {
                b.px[y * b.w + x] = 255;
            }
        }
        assert!(change(&a, &b).is_some_and(|c| !c.is_caret(2)));
    }

    // A light editor with two text lines: "NAME=" + a long value, and a short comment.
    fn page() -> (Vec<u8>, usize, usize) {
        let (w, h) = (400, 60);
        let mut img = vec![250u8; w * h * 4];
        let mut ink = |x0: usize, x1: usize, y0: usize, y1: usize| {
            for y in y0..y1 {
                for x in x0..x1 {
                    if x % 7 != 0 {
                        let i = (y * w + x) * 4;
                        img[i..i + 3].copy_from_slice(&[30, 30, 30]);
                    }
                }
            }
        };
        ink(10, 60, 10, 22); // NAME=
        ink(60, 300, 10, 22); // the value OCR can't read
        ink(10, 90, 36, 48); // a comment
        (img, w, h)
    }

    #[test]
    fn ink_shows_where_a_value_ends() {
        let (img, w, h) = page();
        let map = InkMap::new(&img, w, h);
        assert_eq!(map.ink_end(10, 22, 60, 24), Some(300));
        // Nothing to the right of the comment.
        assert_eq!(map.ink_end(36, 48, 95, 24), None);
    }

    #[test]
    fn unread_ink_is_found() {
        let (img, w, h) = page();
        let map = InkMap::new(&img, w, h);
        assert_eq!(map.text_bands(6, 40), vec![(10, 22), (36, 48)]);
        // OCR returned only "NAME=" on line one and all of line two.
        let mut covered = vec![false; w];
        covered[10..60].iter_mut().for_each(|c| *c = true);
        assert_eq!(map.unread_runs(10, 22, &covered, 12, 24), vec![(60, 300)]);
        covered[10..90].iter_mut().for_each(|c| *c = true);
        assert!(map.unread_runs(36, 48, &covered, 12, 24).is_empty());
    }

    #[test]
    fn average_colour() {
        let mut img = vec![0u8; 8 * 8 * 4];
        for p in img.chunks_exact_mut(4) {
            p.copy_from_slice(&[10, 20, 30, 255]);
        }
        assert_eq!(average_bgra(&img, 8, 8, 0, 0, 8, 8), Some((30, 20, 10)));
        assert_eq!(average_bgra(&img, 8, 8, 9, 9, 12, 12), None);
    }
}
