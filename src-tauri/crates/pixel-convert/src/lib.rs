//! Per-frame pixel shuffles for background removal (src/commands/background_removal.rs): packed
//! RGB bytes into the planar float tensor the matting network reads, and its planar foreground and
//! alpha back into packed RGBA bytes for the encoder. Its own crate so it's built optimised even in
//! `tauri dev` (profile.dev.package."*" covers dependencies only) - unoptimised, these two loops cost
//! more per frame than the network itself.

/// Packed 8-bit RGB (`rgb`, 3 bytes a pixel) into planar 0..1 floats (`chw`: all R, then G, then B).
pub fn rgb_to_planar(rgb: &[u8], chw: &mut [f32]) {
    let plane = rgb.len() / 3;
    assert!(chw.len() >= plane * 3, "planar buffer too small");
    let (r, rest) = chw.split_at_mut(plane);
    let (g, b) = rest.split_at_mut(plane);
    for (i, px) in rgb.chunks_exact(3).enumerate() {
        r[i] = px[0] as f32 * (1.0 / 255.0);
        g[i] = px[1] as f32 * (1.0 / 255.0);
        b[i] = px[2] as f32 * (1.0 / 255.0);
    }
}

/// Planar 0..1 foreground colour (`fgr`: R plane, G plane, B plane) and alpha (`pha`) into packed
/// 8-bit RGBA, rounded and clamped.
pub fn planar_to_rgba(fgr: &[f32], pha: &[f32], rgba: &mut [u8]) {
    let plane = pha.len();
    assert!(fgr.len() >= plane * 3 && rgba.len() >= plane * 4, "buffers too small");
    let to8 = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    let (r, rest) = fgr.split_at(plane);
    let (g, b) = rest.split_at(plane);
    for (i, out) in rgba.chunks_exact_mut(4).take(plane).enumerate() {
        out[0] = to8(r[i]);
        out[1] = to8(g[i]);
        out[2] = to8(b[i]);
        out[3] = to8(pha[i]);
    }
}

/// Packed RGB `frame` over `background` by `alpha` (0..1 a pixel): the person stays, what's behind
/// them becomes the background. All three images the same size.
pub fn composite_over(frame: &[u8], alpha: &[f32], background: &[u8], out: &mut [u8]) {
    let plane = alpha.len();
    assert!(frame.len() >= plane * 3 && background.len() >= plane * 3 && out.len() >= plane * 3, "buffers too small");
    for (i, &a) in alpha.iter().enumerate() {
        let a = a.clamp(0.0, 1.0);
        let k = i * 3;
        for c in 0..3 {
            let v = frame[k + c] as f32 * a + background[k + c] as f32 * (1.0 - a);
            out[k + c] = (v + 0.5) as u8;
        }
    }
}

/// A Gaussian-like blur of packed RGB (`w` x `h`) by three box passes of `radius` each way - the
/// live camera's blurred background. `tmp` and `out` are scratch/result buffers the image's size.
pub fn blur_rgb(src: &[u8], w: usize, h: usize, radius: usize, tmp: &mut [u8], out: &mut [u8]) {
    let n = w * h * 3;
    assert!(src.len() >= n && tmp.len() >= n && out.len() >= n, "buffers too small");
    out[..n].copy_from_slice(&src[..n]);
    if radius == 0 {
        return;
    }
    for _ in 0..3 {
        box_pass(out, tmp, w, h, radius, true);
        box_pass(tmp, out, w, h, radius, false);
    }
}

// One box blur along rows (`horizontal`) or columns, edges clamped, running sums.
fn box_pass(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, horizontal: bool) {
    let (len, lines) = if horizontal { (w, h) } else { (h, w) };
    let idx = |line: usize, i: usize| if horizontal { (line * w + i) * 3 } else { (i * w + line) * 3 };
    let win = (2 * r + 1) as u32;
    for line in 0..lines {
        for c in 0..3 {
            let at = |i: isize| src[idx(line, i.clamp(0, len as isize - 1) as usize) + c] as u32;
            let mut sum: u32 = (-(r as isize)..=r as isize).map(at).sum();
            for i in 0..len {
                dst[idx(line, i) + c] = ((sum + win / 2) / win) as u8;
                sum += at(i as isize + r as isize + 1);
                sum -= at(i as isize - r as isize);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_frame() {
        let rgb = [0u8, 128, 255, 10, 20, 30];
        let mut chw = [0f32; 6];
        rgb_to_planar(&rgb, &mut chw);
        let want = [0.0, 10.0 / 255.0, 128.0 / 255.0, 20.0 / 255.0, 1.0, 30.0 / 255.0];
        assert!(chw.iter().zip(want).all(|(a, b)| (a - b).abs() < 1e-6), "{chw:?}");
        let mut rgba = [0u8; 8];
        planar_to_rgba(&chw, &[1.0, -0.2], &mut rgba);
        assert_eq!(rgba, [0, 128, 255, 255, 10, 20, 30, 0]);
    }

    #[test]
    fn composites_and_blurs() {
        let frame = [200u8, 100, 50, 200, 100, 50];
        let bg = [0u8, 0, 0, 100, 100, 100];
        let mut out = [0u8; 6];
        composite_over(&frame, &[1.0, 0.25], &bg, &mut out);
        assert_eq!(out, [200, 100, 50, 125, 100, 88]);
        // A single bright pixel spreads out but keeps its total (away from the edges).
        let (w, h) = (9usize, 1usize);
        let mut src = vec![0u8; w * h * 3];
        src[4 * 3] = 255;
        let (mut tmp, mut blurred) = (vec![0u8; src.len()], vec![0u8; src.len()]);
        blur_rgb(&src, w, h, 1, &mut tmp, &mut blurred);
        assert!(blurred[4 * 3] < 255 && blurred[3 * 3] > 0 && blurred[5 * 3] > 0);
        let total: u32 = (0..w).map(|i| blurred[i * 3] as u32).sum();
        assert!((total as i32 - 255).abs() <= 6, "{total}");
    }
}

/// Premultiplied RGBA (`src`, `width` x `height`, rows bottom first when `bottom_up`) to straight
/// RGBA top first in `out`, rounded to nearest: c * 255 / a. Opaque and empty pixels - nearly all of
/// a motion-graphics frame - pass straight through. (Stage scene export, commands/stage_render.rs.)
pub fn unpremultiply_flip(src: &[u8], width: usize, height: usize, bottom_up: bool, out: &mut [u8]) {
    let row = width * 4;
    for (y, dst) in out.chunks_exact_mut(row).take(height).enumerate() {
        let from = if bottom_up { (height - 1 - y) * row } else { y * row };
        for (s, o) in src[from..from + row].chunks_exact(4).zip(dst.chunks_exact_mut(4)) {
            let a = s[3] as u32;
            if a == 255 {
                o.copy_from_slice(s);
            } else if a == 0 {
                o.copy_from_slice(&[0, 0, 0, 0]);
            } else {
                for c in 0..3 {
                    o[c] = ((s[c] as u32 * 255 + a / 2) / a).min(255) as u8;
                }
                o[3] = s[3];
            }
        }
    }
}

/// A Stage frame straight to a QOI file in one pass: premultiplied RGBA (`src`, rows bottom first
/// when `bottom_up`) un-premultiplied (as `unpremultiply_flip`) and encoded as QOI - lossless,
/// decoded by ffmpeg's image2 demuxer, and on flat motion graphics many times faster than PNG and
/// about as small. Replaces whatever `out` held.
pub fn qoi_from_premultiplied(src: &[u8], width: usize, height: usize, bottom_up: bool, out: &mut Vec<u8>) {
    out.clear();
    out.reserve(width * height / 4 + 22);
    out.extend_from_slice(b"qoif");
    out.extend_from_slice(&(width as u32).to_be_bytes());
    out.extend_from_slice(&(height as u32).to_be_bytes());
    out.push(4); // RGBA
    out.push(0); // sRGB colour, linear alpha
    let mut index = [[0u8; 4]; 64];
    let mut prev = [0u8, 0, 0, 255];
    let mut run: u8 = 0;
    let row = width * 4;
    for y in 0..height {
        let from = if bottom_up { (height - 1 - y) * row } else { y * row };
        for s in src[from..from + row].chunks_exact(4) {
            let a = s[3];
            let px = match a {
                255 => [s[0], s[1], s[2], 255],
                0 => [0, 0, 0, 0],
                _ => {
                    let a32 = a as u32;
                    let un = |c: u8| ((c as u32 * 255 + a32 / 2) / a32).min(255) as u8;
                    [un(s[0]), un(s[1]), un(s[2]), a]
                }
            };
            if px == prev {
                run += 1;
                if run == 62 {
                    out.push(0xc0 | (run - 1));
                    run = 0;
                }
                continue;
            }
            if run > 0 {
                out.push(0xc0 | (run - 1));
                run = 0;
            }
            let slot = (px[0] as usize * 3 + px[1] as usize * 5 + px[2] as usize * 7 + px[3] as usize * 11) % 64;
            if index[slot] == px {
                out.push(slot as u8);
            } else {
                index[slot] = px;
                if px[3] == prev[3] {
                    let vr = px[0].wrapping_sub(prev[0]) as i8;
                    let vg = px[1].wrapping_sub(prev[1]) as i8;
                    let vb = px[2].wrapping_sub(prev[2]) as i8;
                    let vg_r = vr.wrapping_sub(vg);
                    let vg_b = vb.wrapping_sub(vg);
                    if (-2..=1).contains(&vr) && (-2..=1).contains(&vg) && (-2..=1).contains(&vb) {
                        out.push(0x40 | (((vr + 2) as u8) << 4) | (((vg + 2) as u8) << 2) | ((vb + 2) as u8));
                    } else if (-32..=31).contains(&vg) && (-8..=7).contains(&vg_r) && (-8..=7).contains(&vg_b) {
                        out.push(0x80 | ((vg + 32) as u8));
                        out.push((((vg_r + 8) as u8) << 4) | ((vg_b + 8) as u8));
                    } else {
                        out.extend_from_slice(&[0xfe, px[0], px[1], px[2]]);
                    }
                } else {
                    out.extend_from_slice(&[0xff, px[0], px[1], px[2], px[3]]);
                }
            }
            prev = px;
        }
    }
    if run > 0 {
        out.push(0xc0 | (run - 1));
    }
    out.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 1]);
}
