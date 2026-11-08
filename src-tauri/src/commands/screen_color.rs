// commands/screen_color.rs
//
// The colour picker's eyedropper: the pixels around the mouse pointer, read from the screen as
// it's showing. It reads through the desktop DC, whose pixels are already composited, so
// GPU-drawn windows (this app's own WebView, the video in it) come back as seen, not black - the
// same source snip.rs grabs the desktop from. A small square comes back, not one pixel, so the
// picker can show a magnified loupe around the exact pixel it will pick (the centre one).

#[derive(serde::Serialize)]
pub struct ScreenSample {
    // Side of the square in pixels (2 * radius + 1).
    pub size: u32,
    // size x size pixels, row by row, RGB.
    pub rgb: Vec<u8>,
}

#[tauri::command(async)]
pub fn sample_screen_at_cursor(radius: u32) -> Result<ScreenSample, String> {
    let _serial = crate::services::responsiveness::serial();
    platform::sample(radius.min(32))
}

#[cfg(windows)]
mod platform {
    use super::ScreenSample;
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    pub fn sample(radius: u32) -> Result<ScreenSample, String> {
        let size = (radius * 2 + 1) as i32;
        unsafe {
            // Physical pixels, whatever the display scaling - so the pick is the exact pixel under
            // the pointer on any monitor.
            let mut at = POINT::default();
            GetCursorPos(&mut at).map_err(|e| format!("Couldn't read the pointer position: {}", e))?;

            let screen = GetDC(HWND(0));
            if screen.is_invalid() {
                return Err("Failed to get the screen".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, size, size);
            let old = SelectObject(mem, bitmap);
            // Plain SRCCOPY - CAPTUREBLT makes the pointer flicker while it's sampled every frame.
            let blit = BitBlt(mem, 0, 0, size, size, screen, at.x - radius as i32, at.y - radius as i32, SRCCOPY);

            let mut bmi = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size,
                    biHeight: -size, // top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bgra = vec![0u8; (size * size * 4) as usize];
            let lines = GetDIBits(mem, bitmap, 0, size as u32, Some(bgra.as_mut_ptr() as *mut _), &mut bmi, DIB_RGB_COLORS);

            SelectObject(mem, old);
            let _ = DeleteObject(bitmap);
            let _ = DeleteDC(mem);
            ReleaseDC(HWND(0), screen);

            blit.map_err(|e| format!("Screen read failed: {}", e))?;
            if lines == 0 {
                return Err("Screen read failed: no pixels returned".into());
            }
            let rgb = bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
            Ok(ScreenSample { size: size as u32, rgb })
        }
    }
}

// Linux (X11 / XWayland): the same square around the pointer, read from the root window. A pure
// Wayland desktop doesn't let a program read the screen, and reading X11's root there would come
// back black - so that case says so instead of returning a wrong colour.
#[cfg(target_os = "linux")]
mod platform {
    use super::ScreenSample;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat};

    pub fn sample(radius: u32) -> Result<ScreenSample, String> {
        if std::env::var("XDG_SESSION_TYPE").map(|t| t == "wayland").unwrap_or(false) {
            return Err("Picking a colour from the screen isn't possible on a Wayland session - sign in with an X11 session to use it".into());
        }
        let (conn, screen_num) = x11rb::connect(None).map_err(|e| format!("Couldn't reach the display: {e}"))?;
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let pointer = conn
            .query_pointer(root)
            .map_err(|e| format!("Couldn't read the pointer position: {e}"))?
            .reply()
            .map_err(|e| format!("Couldn't read the pointer position: {e}"))?;
        let size = (radius * 2 + 1) as i32;
        let (x0, y0) = (pointer.root_x as i32 - radius as i32, pointer.root_y as i32 - radius as i32);
        // Only the part inside the screen can be read; the rest of the square stays black, as it does
        // on Windows.
        let (sw, sh) = (screen.width_in_pixels as i32, screen.height_in_pixels as i32);
        let (gx, gy) = (x0.max(0), y0.max(0));
        let (gw, gh) = ((x0 + size).min(sw) - gx, (y0 + size).min(sh) - gy);
        let mut rgb = vec![0u8; (size * size * 3) as usize];
        if gw > 0 && gh > 0 {
            let image = conn
                .get_image(ImageFormat::Z_PIXMAP, root, gx as i16, gy as i16, gw as u16, gh as u16, !0)
                .map_err(|e| format!("Screen read failed: {e}"))?
                .reply()
                .map_err(|e| match e {
                    // XWayland (a Wayland desktop's X11 layer) has no readable root window: the standard
                    // screenshot tools get the same error. Say what that means, not the protocol's words.
                    x11rb::errors::ReplyError::X11Error(ref x) if x.error_kind == x11rb::protocol::ErrorKind::Match => {
                        "Picking a colour from the screen isn't possible here: this display doesn't let a program read the screen (it looks like a Wayland desktop) - sign in with an X11 session to use it".to_string()
                    }
                    other => format!("Screen read failed: {other}"),
                })?;
            let bpp = conn.setup().pixmap_formats.iter().find(|f| f.depth == image.depth).map(|f| f.bits_per_pixel).unwrap_or(0);
            if bpp != 32 && bpp != 24 {
                return Err(format!("Screen read failed: this display uses {bpp} bits per pixel"));
            }
            let msb_first = conn.setup().image_byte_order == x11rb::protocol::xproto::ImageOrder::MSB_FIRST;
            paste(&image.data, (bpp / 8) as usize, msb_first, (gw as usize, gh as usize), ((gx - x0) as usize, (gy - y0) as usize), size as usize, &mut rgb);
        }
        Ok(ScreenSample { size: size as u32, rgb })
    }

    // Rows of 24/32-bit pixels (little-endian B, G, R[, unused] - or the reverse on a big-endian
    // server) into the square's RGB at (at.0, at.1).
    pub(super) fn paste(data: &[u8], bytes: usize, msb_first: bool, (w, h): (usize, usize), at: (usize, usize), size: usize, rgb: &mut [u8]) {
        let stride = data.len() / h.max(1);
        for row in 0..h {
            for col in 0..w {
                let px = &data[row * stride + col * bytes..row * stride + col * bytes + bytes];
                // 32-bit pixels carry an unused byte: first on a big-endian server, last otherwise.
                let (r, g, b) = match (bytes, msb_first) {
                    (4, false) | (3, false) => (px[2], px[1], px[0]),
                    (4, true) => (px[1], px[2], px[3]),
                    _ => (px[0], px[1], px[2]),
                };
                let out = ((at.1 + row) * size + at.0 + col) * 3;
                rgb[out..out + 3].copy_from_slice(&[r, g, b]);
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::{paste, sample};
        use std::process::Command;

        // Needs an X server ($DISPLAY) and xsetroot / xdotool: paints the root a known colour, puts the
        // pointer on it and reads the colour back - the centre of the square is the pixel under it.
        // Run with `cargo test --lib reads_the_colour -- --ignored`.
        #[test]
        #[ignore]
        fn reads_the_colour_under_the_pointer_from_a_real_x_server() {
            assert!(Command::new("xsetroot").args(["-solid", "#336699"]).status().unwrap().success());
            assert!(Command::new("xdotool").args(["mousemove", "200", "150"]).status().unwrap().success());
            let got = sample(2).expect("the screen reads");
            assert_eq!(got.size, 5);
            let centre = (2 * 5 + 2) * 3;
            assert_eq!(&got.rgb[centre..centre + 3], &[0x33, 0x66, 0x99]);
            // At the screen's corner the square is clipped and the rest stays black.
            assert!(Command::new("xdotool").args(["mousemove", "0", "0"]).status().unwrap().success());
            let corner = sample(2).expect("the corner reads");
            assert_eq!(&corner.rgb[0..3], &[0, 0, 0], "outside the screen is black");
            let centre = (2 * 5 + 2) * 3;
            assert_eq!(&corner.rgb[centre..centre + 3], &[0x33, 0x66, 0x99], "the pixel under the pointer is still read");
        }

        #[test]
        fn pixels_come_out_as_rgb_whatever_the_servers_byte_order() {
            // Two pixels of B, G, R, unused (little-endian 32-bit): red then blue.
            let mut rgb = vec![0u8; 3 * 3 * 3];
            paste(&[0, 0, 255, 0, 255, 0, 0, 0], 4, false, (2, 1), (1, 1), 3, &mut rgb);
            assert_eq!(&rgb[(1 * 3 + 1) * 3..(1 * 3 + 1) * 3 + 6], &[255, 0, 0, 0, 0, 255]);
            assert_eq!(&rgb[0..3], &[0, 0, 0], "the rest of the square stays black");
            // The same pixels on a big-endian server: unused, R, G, B.
            let mut be = vec![0u8; 2 * 1 * 3];
            paste(&[0, 255, 0, 0, 0, 0, 255, 0], 4, true, (2, 1), (0, 0), 2, &mut be);
            assert_eq!(&be[0..6], &[255, 0, 0, 0, 255, 0]);
        }
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod platform {
    use super::ScreenSample;

    pub fn sample(_radius: u32) -> Result<ScreenSample, String> {
        Err("Picking a colour from the screen isn't available on macOS yet".into())
    }
}
