// Carries the live recording preview from ffmpeg to the UI entirely in memory.
//
// The preview used to be a JPEG file that ffmpeg rewrote several times a second and the frontend
// polled off disk. That works, but everything about it is a fight with the filesystem: each frame
// is a create-plus-rename (ffmpeg's -atomic_writing, needed so a reader can't catch a half-written
// file), Windows real-time protection opens every one of those creates, the reader and the writer
// contend over the same path, and a recording that ends abnormally strands the file in temp.
// Measured delivery swung between roughly 4 and 12 frames a second across identical runs, which is
// the signature of contention rather than of a pipeline doing steady work.
//
// So there is no file. ffmpeg writes the preview as an MJPEG stream to its own stdout, a reader
// thread here splits that stream into frames, and only the newest complete frame is kept. The UI
// asks for that buffer. Nothing touches the disk, nothing can tear, nothing is left behind, and a
// frame is available the instant ffmpeg emits it.

// The camera-only live preview is built on Windows' recording filter graph (win.rs's
// camera_only_filter_complex); macOS and Linux don't produce the MJPEG stream yet, so nothing there
// calls `pump`. Kept compiled everywhere so the frame splitter's unit tests run on every platform.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::io::Read;
use std::sync::{Arc, Mutex};

/// The newest complete preview frame as `(sequence_number, jpeg_bytes)`, or None before the first
/// one arrives.
///
/// Deliberately a plain `std::sync::Mutex` rather than the async one the rest of `AppState` uses:
/// it is held only long enough to swap a `Vec`, by a blocking reader thread that has no runtime to
/// yield to, so an async mutex would buy nothing and force the reader to be async for no reason.
pub type PreviewFrame = Arc<Mutex<Option<(u32, Vec<u8>)>>>;

// JPEG frame markers. Every frame in an MJPEG stream starts with SOI and ends with EOI, and
// neither sequence can appear in the entropy-coded data in between without being byte-stuffed,
// so scanning for them is a sound way to find frame boundaries.
const SOI: [u8; 2] = [0xFF, 0xD8];
const EOI: [u8; 2] = [0xFF, 0xD9];

// A frame this far past a plausible size means the stream has gone out of sync and the buffer is
// accumulating rather than framing. Rather than grow without limit, drop what's buffered and
// resynchronise on the next SOI.
const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// Reads an MJPEG stream from `source` until it ends, publishing each complete frame into `slot`.
///
/// Intended for a dedicated thread: it blocks on reads and returns only when ffmpeg closes the
/// pipe, which is how a recording ends.
///
/// This must keep draining for as long as ffmpeg is running. The pipe has a finite buffer, and a
/// reader that stops consuming would block ffmpeg's writes - which, because ffmpeg advances all of
/// its outputs together, would stall the actual recording and not merely the preview.
pub fn pump<R: Read>(mut source: R, slot: PreviewFrame) {
    let mut buf: Vec<u8> = Vec::with_capacity(256 * 1024);
    let mut chunk = [0u8; 64 * 1024];
    let mut seq: u32 = 0;
    // Byte offset where we already know no EOI exists for the currently buffered partial frame, so
    // multi-chunk frames don't re-scan from byte 0 on every read().
    let mut eoi_scan_from: usize = 0;

    loop {
        let read = match source.read(&mut chunk) {
            Ok(0) => break,            // ffmpeg closed the pipe: the recording is over
            Ok(n) => n,
            Err(_) => break,           // pipe broken, same thing
        };
        buf.extend_from_slice(&chunk[..read]);

        // Emit every complete frame currently in the buffer, keeping only the last one - if the
        // consumer is slower than ffmpeg, showing it the newest frame is strictly better than
        // working through a backlog of stale ones. Scan using a cursor and compact once per read.
        let mut cursor: usize = 0;
        let mut newest: Option<(usize, usize)> = None;
        loop {
            let Some(rel_start) = find(&buf[cursor..], &SOI) else {
                // No frame start left in the buffer - discard trailing junk.
                cursor = buf.len();
                eoi_scan_from = 0;
                break;
            };
            let start = cursor + rel_start;
            let search_from = (start + 2).max(eoi_scan_from);
            let Some(rel_end) = find(&buf[search_from..], &EOI) else {
                // Frame started but hasn't finished arriving; compact to `start` and resume EOI
                // scan at the tail on the next read (backing up 1 byte in case 0xFF sat at the
                // chunk boundary).
                cursor = start;
                eoi_scan_from = buf.len().saturating_sub(1).saturating_sub(start);
                break;
            };
            let end = search_from + rel_end + 2;
            newest = Some((start, end));
            cursor = end;
            eoi_scan_from = 0;
        }

        if let Some((start, end)) = newest {
            let frame = buf[start..end].to_vec();
            seq = seq.wrapping_add(1).max(1);
            if let Ok(mut guard) = slot.lock() {
                *guard = Some((seq, frame));
            }
        }

        if cursor >= buf.len() {
            buf.clear();
            eoi_scan_from = 0;
        } else if cursor > 0 {
            buf.drain(..cursor);
        }

        if buf.len() > MAX_FRAME_BYTES {
            buf.clear();
            eoi_scan_from = 0;
        }
    }

    // Leave the last frame in place rather than clearing it: stop_recording tears the slot down
    // itself, and blanking the preview the instant ffmpeg exits only makes the UI flicker on the
    // way out.
}

fn find(haystack: &[u8], needle: &[u8; 2]) -> Option<usize> {
    if haystack.len() < 2 {
        return None;
    }
    haystack.windows(2).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jpeg(payload: &[u8]) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(payload);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    #[test]
    fn publishes_a_complete_frame() {
        let slot = PreviewFrame::default();
        let frame = jpeg(b"abc");
        pump(&frame[..], slot.clone());
        assert_eq!(slot.lock().unwrap().as_ref().map(|(_, b)| b.as_slice()), Some(&frame[..]));
    }

    #[test]
    fn keeps_only_the_newest_of_several() {
        let slot = PreviewFrame::default();
        let mut stream = jpeg(b"old");
        stream.extend_from_slice(&jpeg(b"new"));
        pump(&stream[..], slot.clone());
        assert_eq!(slot.lock().unwrap().as_ref().map(|(_, b)| b.as_slice()), Some(&jpeg(b"new")[..]));
    }

    #[test]
    fn ignores_a_trailing_partial_frame() {
        let slot = PreviewFrame::default();
        let mut stream = jpeg(b"whole");
        stream.extend_from_slice(&[0xFF, 0xD8, b'p', b'a', b'r', b't']); // no EOI yet
        pump(&stream[..], slot.clone());
        assert_eq!(slot.lock().unwrap().as_ref().map(|(_, b)| b.as_slice()), Some(&jpeg(b"whole")[..]));
    }

    #[test]
    fn skips_leading_junk_before_the_first_frame() {
        let slot = PreviewFrame::default();
        let mut stream = vec![0x00, 0x11, 0x22];
        stream.extend_from_slice(&jpeg(b"real"));
        pump(&stream[..], slot.clone());
        assert_eq!(slot.lock().unwrap().as_ref().map(|(_, b)| b.as_slice()), Some(&jpeg(b"real")[..]));
    }

    #[test]
    fn empty_stream_leaves_no_frame() {
        let slot = PreviewFrame::default();
        pump(&[][..], slot.clone());
        assert!(slot.lock().unwrap().is_none());
    }
}
