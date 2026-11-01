// Finding WhatsApp's panes in a picture of its window. Pure, so it's tested on synthetic layouts
// below; win.rs feeds it PrintWindow captures (the window's own pixels - never our blur).
//
// WhatsApp (classic and the current WhatsApp.Root app alike) is: an icon rail on the left, the
// chat list, a 1px divider, then the open conversation - a header strip (avatar + contact name on
// the left, call/search icons on the right) above the wallpaper and messages. Every boundary we
// need is a long straight edge; text, avatars and the doodle wallpaper never line up that well.
use image::RgbaImage;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChatListEdges {
    // Right edge of the icon rail on the far left, when there is one.
    pub rail: Option<u32>,
    // Right edge of the chat list (the divider line itself included).
    pub divider: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WhatsAppEdges {
    pub chat: ChatListEdges,
    // Bottom of the title bar (top of the conversation header).
    pub title_bottom: Option<u32>,
    // Bottom of the conversation header (top of the messages).
    pub header_bottom: Option<u32>,
    // Right end of the avatar + name in the header.
    pub contact_right: Option<u32>,
}

// A vertical edge that runs through at least this share of the window's height is a pane border.
const MIN_SCORE: f64 = 0.7;
// Same for a horizontal edge across the conversation pane.
const MIN_ROW_SCORE: f64 = 0.6;

// Average colour of img[x0..x1, y0..y1] (clipped to the image), sampled sparsely - the frost tint
// for a blur over that area, so it reads as softened content rather than a grey slab, and all but
// disappears over plain backgrounds.
pub fn average_rgb(img: &RgbaImage, x0: i32, y0: i32, x1: i32, y1: i32) -> Option<(u8, u8, u8)> {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let (x0, y0, x1, y1) = (x0.clamp(0, w), y0.clamp(0, h), x1.clamp(0, w), y1.clamp(0, h));
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    let step = (((x1 - x0) * (y1 - y0)) as f64 / 4096.0).sqrt().max(1.0) as usize;
    let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
    for y in (y0..y1).step_by(step) {
        for x in (x0..x1).step_by(step) {
            let p = img.get_pixel(x as u32, y as u32).0;
            r += p[0] as u64;
            g += p[1] as u64;
            b += p[2] as u64;
            n += 1;
        }
    }
    (n > 0).then(|| ((r / n) as u8, (g / n) as u8, (b / n) as u8))
}

fn lum(img: &RgbaImage, x: u32, y: u32) -> i32 {
    let p = img.get_pixel(x, y).0;
    (p[0] as i32 * 299 + p[1] as i32 * 587 + p[2] as i32 * 114) / 1000
}

pub fn detect_chat_list(img: &RgbaImage, scale: f64) -> Option<ChatListEdges> {
    let (w, h) = img.dimensions();
    if w < 400 || h < 300 {
        return None;
    }
    // Below the title bar/header, above the bottom edge; every other row is plenty.
    let (y0, y1) = (h * 15 / 100, h * 95 / 100);
    let rows = ((y1 - y0) / 2).max(1) as f64;
    let limit = w * 3 / 4;
    let mut scores = vec![0f64; limit as usize];
    for x in 1..limit {
        let mut hits = 0u32;
        let mut y = y0;
        while y < y1 {
            if (lum(img, x, y) - lum(img, x - 1, y)).abs() >= 4 {
                hits += 1;
            }
            y += 2;
        }
        scores[x as usize] = hits as f64 / rows;
    }
    // Group neighbouring edge columns (a 1px line is two edges) into one candidate each:
    // (rightmost column of the group, best score in it).
    let mut cands: Vec<(u32, f64)> = Vec::new();
    for x in 1..limit {
        let s = scores[x as usize];
        if s < MIN_SCORE {
            continue;
        }
        match cands.last_mut() {
            Some(last) if x - last.0 <= 3 => {
                last.0 = x;
                last.1 = last.1.max(s);
            }
            _ => cands.push((x, s)),
        }
    }
    let px = |css: f64| (css * scale).round() as u32;
    let rail = cands.iter().find(|c| c.0 >= px(30.0) && c.0 <= px(110.0)).map(|c| c.0);
    let min_div = (rail.unwrap_or(0) + px(220.0)).max(w * 15 / 100);
    let max_div = w * 72 / 100;
    let divider = cands
        .iter()
        .filter(|c| c.0 >= min_div && c.0 <= max_div)
        .fold(None::<(u32, f64)>, |best, c| match best {
            Some(b) if b.1 >= c.1 => Some(b),
            _ => Some(*c),
        })?
        .0;
    Some(ChatListEdges { rail, divider: divider + 1 })
}

pub fn detect_whatsapp(img: &RgbaImage, scale: f64) -> Option<WhatsAppEdges> {
    let chat = detect_chat_list(img, scale)?;
    let (w, h) = img.dimensions();
    let px = |css: f64| (css * scale).round() as u32;
    let mut edges = WhatsAppEdges { chat, title_bottom: None, header_bottom: None, contact_right: None };
    let (x0, x1) = (chat.divider + px(8.0), w.saturating_sub(px(8.0)));
    if x1 <= x0 + px(120.0) {
        return Some(edges);
    }

    // Horizontal edges across the conversation pane's top: the title bar's bottom, then the
    // header's. Each edge is reported as the first row of the region below it.
    let cols = ((x1 - x0) / 2).max(1) as f64;
    let mut rows: Vec<u32> = Vec::new();
    for y in px(12.0)..px(200.0).min(h / 2) {
        let mut hits = 0u32;
        let mut x = x0;
        while x < x1 {
            if (lum(img, x, y) - lum(img, x, y - 1)).abs() >= 4 {
                hits += 1;
            }
            x += 2;
        }
        if hits as f64 / cols >= MIN_ROW_SCORE {
            match rows.last_mut() {
                Some(last) if y - *last <= 2 => *last = y,
                _ => rows.push(y),
            }
        }
    }
    let title = rows.iter().copied().find(|&y| y >= px(20.0) && y <= px(70.0));
    let header_from = title.unwrap_or(px(30.0)) + px(40.0);
    let header = rows.iter().copied().find(|&y| y >= header_from && y <= header_from + px(80.0));
    edges.title_bottom = title;
    edges.header_bottom = header;

    // The avatar and name: content columns in the header strip, starting next to the divider and
    // continuing while the gaps stay word-sized - the call/search icons are a long gap away.
    if let (Some(t), Some(b)) = (title, header) {
        let (sy0, sy1) = (t + px(6.0), b.saturating_sub(px(6.0)));
        if sy1 > sy0 {
            let mut hist = [0u32; 256];
            for y in (sy0..sy1).step_by(2) {
                for x in (x0..x1).step_by(3) {
                    hist[lum(img, x, y).clamp(0, 255) as usize] += 1;
                }
            }
            let bg = hist.iter().enumerate().max_by_key(|(_, c)| **c).map(|(v, _)| v as i32).unwrap_or(255);
            let content = |x: u32| (sy0..sy1).step_by(2).any(|y| (lum(img, x, y) - bg).abs() > 24);
            let (mut first, mut last, mut gap) = (None::<u32>, 0u32, 0u32);
            for x in chat.divider + px(4.0)..x1 {
                if content(x) {
                    if first.is_none() && x > chat.divider + px(90.0) {
                        break;
                    }
                    first.get_or_insert(x);
                    last = x;
                    gap = 0;
                } else if first.is_some() {
                    gap += 1;
                    if gap > px(40.0) {
                        break;
                    }
                }
            }
            if first.is_some() {
                let cap = chat.divider + (w - chat.divider) * 6 / 10;
                edges.contact_right = Some((last + px(16.0)).min(cap));
            }
        }
    }
    Some(edges)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn fill(img: &mut RgbaImage, x0: u32, x1: u32, y0: u32, y1: u32, v: u8) {
        for y in y0..y1.min(img.height()) {
            for x in x0..x1.min(img.width()) {
                img.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
    }

    struct Truth {
        rail: u32,
        divider: u32,
        title: u32,
        header: u32,
        name_end: u32,
    }

    // A WhatsApp-like window at `scale`: icon rail, chat list with rows of avatars and text,
    // a 1px divider, then the conversation - title bar, a header with avatar + name on the left and
    // icons on the right, and a noisy wallpaper with message bubbles.
    fn whatsapp_like(w: u32, h: u32, scale: f64, divider_css: f64) -> (RgbaImage, Truth) {
        let s = |v: f64| (v * scale).round() as u32;
        let mut img = RgbaImage::new(w, h);
        let rail = s(64.0);
        let divider = s(divider_css);
        let (title, header) = (s(38.0), s(102.0));
        fill(&mut img, 0, rail, 0, h, 38);
        fill(&mut img, rail, divider, 0, h, 26);
        fill(&mut img, divider, divider + 1, 0, h, 60);
        let mut seed = 7u32;
        for y in header..h {
            for x in divider + 1..w {
                seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
                let v = 14 + ((seed >> 16) % 9) as u8;
                img.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        fill(&mut img, divider + 1, w, 0, title, 50);
        fill(&mut img, divider + 1, w, title, header, 32);
        // Header: avatar, a name with letter gaps, and icons far right.
        fill(&mut img, divider + s(16.0), divider + s(56.0), title + s(12.0), title + s(52.0), 140);
        let mut x = divider + s(72.0);
        for _ in 0..9 {
            fill(&mut img, x, x + s(8.0), title + s(24.0), title + s(40.0), 230);
            x += s(10.0);
        }
        let name_end = x - s(2.0);
        for i in 0..4u32 {
            let ix = w - s(40.0) - i * s(56.0);
            fill(&mut img, ix - s(20.0), ix, title + s(22.0), title + s(42.0), 220);
        }
        // Chat rows: an avatar and two lines of "text" per 72px row, ragged widths.
        let mut y = s(110.0);
        let mut n = 0u32;
        while y + s(60.0) < h {
            fill(&mut img, rail + s(16.0), rail + s(64.0), y, y + s(48.0), 120);
            let text_w = s(120.0) + (n * 37 % 140) * scale as u32;
            for dy in [s(8.0), s(30.0)] {
                fill(&mut img, rail + s(80.0), (rail + s(80.0) + text_w).min(divider - s(8.0)), y + dy, y + dy + 1, 200);
            }
            y += s(72.0);
            n += 1;
        }
        // Bubbles in the conversation.
        for i in 0..6u32 {
            let by = s(140.0) + i * s(90.0);
            let bx = divider + s(40.0) + (i % 2) * s(200.0);
            fill(&mut img, bx, bx + s(260.0), by, by + s(50.0), 70);
        }
        (img, Truth { rail, divider, title, header, name_end })
    }

    fn near(a: u32, b: u32, tol: u32) -> bool {
        a.abs_diff(b) <= tol
    }

    #[test]
    fn finds_rail_and_divider_at_100_percent() {
        let (img, t) = whatsapp_like(1280, 800, 1.0, 470.0);
        let e = detect_chat_list(&img, 1.0).expect("detected");
        assert_eq!(e.rail, Some(t.rail));
        assert!(near(e.divider, t.divider + 1, 1), "{:?} vs {}", e, t.divider);
    }

    #[test]
    fn finds_divider_at_250_percent() {
        let (img, t) = whatsapp_like(3200, 2000, 2.5, 470.0);
        let e = detect_chat_list(&img, 2.5).expect("detected");
        assert!(near(e.divider, t.divider + 1, 1), "{:?} vs {}", e, t.divider);
    }

    #[test]
    fn follows_a_dragged_pane() {
        let (img, t) = whatsapp_like(1600, 900, 1.0, 640.0);
        let e = detect_chat_list(&img, 1.0).expect("detected");
        assert!(near(e.divider, t.divider + 1, 1));
    }

    #[test]
    fn finds_header_and_contact() {
        for (w, h, scale) in [(1280, 800, 1.0), (3840, 2160, 2.5)] {
            let (img, t) = whatsapp_like(w, h, scale, 470.0);
            let e = detect_whatsapp(&img, scale).expect("detected");
            let tol = (2.0 * scale) as u32;
            assert!(e.title_bottom.is_some_and(|y| near(y, t.title, tol)), "title {:?} vs {}", e.title_bottom, t.title);
            assert!(e.header_bottom.is_some_and(|y| near(y, t.header, tol)), "header {:?} vs {}", e.header_bottom, t.header);
            // The name's end plus padding - and well short of the icons on the right.
            let right = e.contact_right.expect("contact found");
            assert!(right >= t.name_end && right <= t.name_end + (24.0 * scale) as u32, "contact {} vs name end {}", right, t.name_end);
        }
    }

    #[test]
    fn nothing_on_a_plain_window() {
        let mut img = RgbaImage::new(1200, 800);
        fill(&mut img, 0, 1200, 0, 800, 30);
        assert_eq!(detect_chat_list(&img, 1.0), None);
    }
}
