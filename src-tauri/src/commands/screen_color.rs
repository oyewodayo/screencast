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

#[tauri::command]
pub fn sample_screen_at_cursor(radius: u32) -> Result<ScreenSample, String> {
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

#[cfg(not(windows))]
mod platform {
    use super::ScreenSample;

    pub fn sample(_radius: u32) -> Result<ScreenSample, String> {
        Err("Picking a colour from the screen is only available on Windows".into())
    }
}
