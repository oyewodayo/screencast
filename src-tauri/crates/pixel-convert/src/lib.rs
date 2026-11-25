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

/// Resizes packed 8-bit RGB (`sw` x `sh`) into planar 0..1 floats (`dw` x `dh`, CHW layout) using
/// bilinear sampling in a single pass. Lets live matting run at a fast fixed resolution (e.g.
/// 256px) while keeping the foreground person sharp at full bubble resolution.
pub fn resize_rgb_to_planar(
    rgb: &[u8],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    chw: &mut [f32],
) {
    if sw == dw && sh == dh {
        rgb_to_planar(&rgb[..sw * sh * 3], chw);
        return;
    }
    let plane = dw * dh;
    assert!(
        rgb.len() >= sw * sh * 3 && chw.len() >= plane * 3,
        "buffers too small"
    );
    let (r_out, rest) = chw.split_at_mut(plane);
    let (g_out, b_out) = rest.split_at_mut(plane);
    let x_scale = ((sw as u64) << 16) / dw.max(1) as u64;
    let y_scale = ((sh as u64) << 16) / dh.max(1) as u64;
    let max_x = sw.saturating_sub(1);
    let max_y = sh.saturating_sub(1);
    const INV_255: f32 = 1.0 / 255.0;
    for dy in 0..dh {
        let fy = (dy as u64 * y_scale) as usize;
        let y0 = (fy >> 16).min(max_y);
        let y1 = (y0 + 1).min(max_y);
        let wy = ((fy & 0xFFFF) >> 8) as u32;
        let inv_wy = 256 - wy;
        let row0 = y0 * sw * 3;
        let row1 = y1 * sw * 3;
        let dst_row = dy * dw;
        for dx in 0..dw {
            let fx = (dx as u64 * x_scale) as usize;
            let x0 = (fx >> 16).min(max_x);
            let x1 = (x0 + 1).min(max_x);
            let wx = ((fx & 0xFFFF) >> 8) as u32;
            let inv_wx = 256 - wx;
            let p00 = row0 + x0 * 3;
            let p01 = row0 + x1 * 3;
            let p10 = row1 + x0 * 3;
            let p11 = row1 + x1 * 3;
            let i = dst_row + dx;
            let r_top = rgb[p00] as u32 * inv_wx + rgb[p01] as u32 * wx;
            let r_bot = rgb[p10] as u32 * inv_wx + rgb[p11] as u32 * wx;
            let g_top = rgb[p00 + 1] as u32 * inv_wx + rgb[p01 + 1] as u32 * wx;
            let g_bot = rgb[p10 + 1] as u32 * inv_wx + rgb[p11 + 1] as u32 * wx;
            let b_top = rgb[p00 + 2] as u32 * inv_wx + rgb[p01 + 2] as u32 * wx;
            let b_bot = rgb[p10 + 2] as u32 * inv_wx + rgb[p11 + 2] as u32 * wx;
            r_out[i] = ((r_top * inv_wy + r_bot * wy + 32768) >> 16) as f32 * INV_255;
            g_out[i] = ((g_top * inv_wy + g_bot * wy + 32768) >> 16) as f32 * INV_255;
            b_out[i] = ((b_top * inv_wy + b_bot * wy + 32768) >> 16) as f32 * INV_255;
        }
    }
}

/// Bilinearly resizes a single-channel 0..1 alpha matte (`sw` x `sh`) to (`dw` x `dh`).
pub fn upscale_alpha_bilinear(
    src: &[f32],
    sw: usize,
    sh: usize,
    dst: &mut [f32],
    dw: usize,
    dh: usize,
) {
    assert!(src.len() >= sw * sh && dst.len() >= dw * dh, "buffers too small");
    if sw == dw && sh == dh {
        dst[..dw * dh].copy_from_slice(&src[..sw * sh]);
        return;
    }
    let x_scale = ((sw as u64) << 16) / dw.max(1) as u64;
    let y_scale = ((sh as u64) << 16) / dh.max(1) as u64;
    let max_x = sw.saturating_sub(1);
    let max_y = sh.saturating_sub(1);
    for dy in 0..dh {
        let fy = (dy as u64 * y_scale) as usize;
        let y0 = (fy >> 16).min(max_y);
        let y1 = (y0 + 1).min(max_y);
        let wy = (fy & 0xFFFF) as f32 * (1.0 / 65536.0);
        let inv_wy = 1.0 - wy;
        let row0 = y0 * sw;
        let row1 = y1 * sw;
        let dst_row = dy * dw;
        for dx in 0..dw {
            let fx = (dx as u64 * x_scale) as usize;
            let x0 = (fx >> 16).min(max_x);
            let x1 = (x0 + 1).min(max_x);
            let wx = (fx & 0xFFFF) as f32 * (1.0 / 65536.0);
            let inv_wx = 1.0 - wx;
            let top = src[row0 + x0] * inv_wx + src[row0 + x1] * wx;
            let bot = src[row1 + x0] * inv_wx + src[row1 + x1] * wx;
            dst[dst_row + dx] = top * inv_wy + bot * wy;
        }
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
    for (((&a, fg), bg), dst) in alpha
        .iter()
        .zip(frame.chunks_exact(3))
        .zip(background.chunks_exact(3))
        .zip(out.chunks_exact_mut(3))
    {
        // Fixed-point 0..=256 avoids per-channel float conversions while rounding to nearest.
        let a256 = (a.clamp(0.0, 1.0) * 256.0 + 0.5) as u32;
        if a256 >= 256 {
            dst.copy_from_slice(fg);
        } else if a256 == 0 {
            dst.copy_from_slice(bg);
        } else {
            let inv = 256 - a256;
            dst[0] = ((fg[0] as u32 * a256 + bg[0] as u32 * inv + 128) >> 8) as u8;
            dst[1] = ((fg[1] as u32 * a256 + bg[1] as u32 * inv + 128) >> 8) as u8;
            dst[2] = ((fg[2] as u32 * a256 + bg[2] as u32 * inv + 128) >> 8) as u8;
        }
    }
}

/// A Gaussian-like blur of packed RGB (`w` x `h`) by three box passes of `radius` each way - the
/// live camera's blurred background. `tmp` and `out` are scratch/result buffers the image's size.
pub fn blur_rgb(src: &[u8], w: usize, h: usize, radius: usize, tmp: &mut [u8], out: &mut [u8]) {
    let n = w * h * 3;
    assert!(src.len() >= n && tmp.len() >= n && out.len() >= n, "buffers too small");
    out[..n].copy_from_slice(&src[..n]);
    if radius == 0 || w == 0 || h == 0 {
        return;
    }
    let mut col_sums = vec![0u32; w * 3];
    for _ in 0..3 {
        box_pass_h(out, tmp, w, h, radius);
        box_pass_v(tmp, out, w, h, radius, &mut col_sums);
    }
}

/// Fast live-background blur: downscales 2x (or 4x for large radii), runs three separable box
/// passes on the compact image (cache-resident), and bilinear-upscales back into `out`. Cuts CPU
/// cost 4x-12x on 320x320..480x480 webcam frames with visually smoother bokeh.
pub fn blur_rgb_fast(src: &[u8], w: usize, h: usize, radius: usize, tmp: &mut [u8], out: &mut [u8]) {
    let n = w * h * 3;
    assert!(src.len() >= n && tmp.len() >= n && out.len() >= n, "buffers too small");
    if radius == 0 || w == 0 || h == 0 {
        out[..n].copy_from_slice(&src[..n]);
        return;
    }
    let scale = if radius >= 8 && w >= 64 && h >= 64 {
        4
    } else if radius >= 3 && w >= 32 && h >= 32 {
        2
    } else {
        1
    };
    if scale == 1 {
        blur_rgb(src, w, h, radius, tmp, out);
        return;
    }
    let sw = (w / scale).max(1);
    let sh = (h / scale).max(1);
    let sr = (radius / scale).max(1);
    let small_n = sw * sh * 3;
    // Reuse `tmp` and `out` prefixes as scratch buffers so there are no per-frame image allocations.
    // Downscale src -> out[..small_n] via box averaging.
    let area = (scale * scale) as u32;
    let half = area / 2;
    for sy in 0..sh {
        let y0 = sy * scale;
        for sx in 0..sw {
            let x0 = sx * scale;
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            for dy in 0..scale {
                let row = ((y0 + dy) * w + x0) * 3;
                for dx in 0..scale {
                    let p = row + dx * 3;
                    r += src[p] as u32;
                    g += src[p + 1] as u32;
                    b += src[p + 2] as u32;
                }
            }
            let dst = (sy * sw + sx) * 3;
            out[dst] = ((r + half) / area) as u8;
            out[dst + 1] = ((g + half) / area) as u8;
            out[dst + 2] = ((b + half) / area) as u8;
        }
    }
    let mut col_sums = vec![0u32; sw * 3];
    for _ in 0..3 {
        box_pass_h(&out[..small_n], &mut tmp[..small_n], sw, sh, sr);
        box_pass_v(&tmp[..small_n], &mut out[..small_n], sw, sh, sr, &mut col_sums);
    }
    // Copy blurred small image into tmp[..small_n], then bilinear-upscale into full `out`.
    tmp[..small_n].copy_from_slice(&out[..small_n]);
    upscale_bilinear(&tmp[..small_n], sw, sh, out, w, h);
}

fn upscale_bilinear(src: &[u8], sw: usize, sh: usize, dst: &mut [u8], dw: usize, dh: usize) {
    let x_scale = ((sw as u64) << 16) / dw.max(1) as u64;
    let y_scale = ((sh as u64) << 16) / dh.max(1) as u64;
    let max_x = sw.saturating_sub(1);
    let max_y = sh.saturating_sub(1);
    for dy in 0..dh {
        let fy = (dy as u64 * y_scale) as usize;
        let y0 = (fy >> 16).min(max_y);
        let y1 = (y0 + 1).min(max_y);
        let wy = ((fy & 0xFFFF) >> 8) as u32;
        let inv_wy = 256 - wy;
        let row0 = y0 * sw * 3;
        let row1 = y1 * sw * 3;
        let dst_row = dy * dw * 3;
        for dx in 0..dw {
            let fx = (dx as u64 * x_scale) as usize;
            let x0 = (fx >> 16).min(max_x);
            let x1 = (x0 + 1).min(max_x);
            let wx = ((fx & 0xFFFF) >> 8) as u32;
            let inv_wx = 256 - wx;
            let p00 = row0 + x0 * 3;
            let p01 = row0 + x1 * 3;
            let p10 = row1 + x0 * 3;
            let p11 = row1 + x1 * 3;
            let out_p = dst_row + dx * 3;
            for c in 0..3 {
                let top = src[p00 + c] as u32 * inv_wx + src[p01 + c] as u32 * wx;
                let bot = src[p10 + c] as u32 * inv_wx + src[p11 + c] as u32 * wx;
                dst[out_p + c] = ((top * inv_wy + bot * wy + 32768) >> 16) as u8;
            }
        }
    }
}

// Horizontal box blur: fused across all 3 RGB channels in one pass per row.
fn box_pass_h(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize) {
    let win = (2 * r + 1) as u32;
    let half = win / 2;
    let max_x = (w - 1) as isize;
    for y in 0..h {
        let row = y * w * 3;
        let (mut sr, mut sg, mut sb) = (0u32, 0u32, 0u32);
        for k in -(r as isize)..=(r as isize) {
            let p = row + (k.clamp(0, max_x) as usize) * 3;
            sr += src[p] as u32;
            sg += src[p + 1] as u32;
            sb += src[p + 2] as u32;
        }
        for x in 0..w {
            let out = row + x * 3;
            dst[out] = ((sr + half) / win) as u8;
            dst[out + 1] = ((sg + half) / win) as u8;
            dst[out + 2] = ((sb + half) / win) as u8;
            let add_p = row + ((x as isize + r as isize + 1).clamp(0, max_x) as usize) * 3;
            let sub_p = row + ((x as isize - r as isize).clamp(0, max_x) as usize) * 3;
            sr = sr + src[add_p] as u32 - src[sub_p] as u32;
            sg = sg + src[add_p + 1] as u32 - src[sub_p + 1] as u32;
            sb = sb + src[add_p + 2] as u32 - src[sub_p + 2] as u32;
        }
    }
}

// Vertical box blur: iterates row-major using a running sum buffer across the row, keeping every
// memory access sequential (L1 cache friendly) instead of striding down columns.
fn box_pass_v(src: &[u8], dst: &mut [u8], w: usize, h: usize, r: usize, sums: &mut [u32]) {
    let win = (2 * r + 1) as u32;
    let half = win / 2;
    let row_bytes = w * 3;
    let max_y = (h - 1) as isize;
    sums[..row_bytes].fill(0);
    for k in -(r as isize)..=(r as isize) {
        let row = (k.clamp(0, max_y) as usize) * row_bytes;
        for (s, &v) in sums[..row_bytes].iter_mut().zip(&src[row..row + row_bytes]) {
            *s += v as u32;
        }
    }
    for y in 0..h {
        let out_row = y * row_bytes;
        for (d, &s) in dst[out_row..out_row + row_bytes].iter_mut().zip(&sums[..row_bytes]) {
            *d = ((s + half) / win) as u8;
        }
        let add_row = ((y as isize + r as isize + 1).clamp(0, max_y) as usize) * row_bytes;
        let sub_row = ((y as isize - r as isize).clamp(0, max_y) as usize) * row_bytes;
        for ((s, &a), &b) in sums[..row_bytes]
            .iter_mut()
            .zip(&src[add_row..add_row + row_bytes])
            .zip(&src[sub_row..sub_row + row_bytes])
        {
            *s = *s + a as u32 - b as u32;
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

    #[test]
    fn resizes_rgb_to_planar_and_upscales_alpha() {
        let mut src = vec![0u8; 8 * 8 * 3];
        for px in src.chunks_exact_mut(3) {
            px.copy_from_slice(&[51, 102, 204]);
        }
        let mut chw = vec![0f32; 4 * 4 * 3];
        resize_rgb_to_planar(&src, 8, 8, 4, 4, &mut chw);
        assert!((chw[0] - 51.0 / 255.0).abs() < 0.01);
        assert!((chw[16] - 102.0 / 255.0).abs() < 0.01);
        assert!((chw[32] - 204.0 / 255.0).abs() < 0.01);

        let alpha_small = vec![0.25f32; 4 * 4];
        let mut alpha_big = vec![0f32; 8 * 8];
        upscale_alpha_bilinear(&alpha_small, 4, 4, &mut alpha_big, 8, 8);
        assert!(alpha_big.iter().all(|&a| (a - 0.25).abs() < 1e-5));
    }

    #[test]
    fn fast_blur_smooths_and_preserves_flat_color() {
        let (w, h) = (64usize, 64usize);
        let src = vec![90u8; w * h * 3];
        let (mut tmp, mut out) = (vec![0u8; src.len()], vec![0u8; src.len()]);
        blur_rgb_fast(&src, w, h, 8, &mut tmp, &mut out);
        assert!(out.iter().all(|&v| v.abs_diff(90) <= 1), "flat image should stay flat");
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
