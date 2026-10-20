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

use std::io::Read;
use std::sync::{Arc, Mutex};

/// The newest complete preview frame, or None before the first one arrives.
///
/// Deliberately a plain `std::sync::Mutex` rather than the async one the rest of `AppState` uses:
/// it is held only long enough to swap a `Vec`, by a blocking reader thread that has no runtime to
/// yield to, so an async mutex would buy nothing and force the reader to be async for no reason.
pub type PreviewFrame = Arc<Mutex<Option<Vec<u8>>>>;

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

    loop {
        let read = match source.read(&mut chunk) {
            Ok(0) => break,            // ffmpeg closed the pipe: the recording is over
            Ok(n) => n,
            Err(_) => break,           // pipe broken, same thing
        };
        buf.extend_from_slice(&chunk[..read]);

        // Emit every complete frame currently in the buffer, keeping only the last one - if the
        // consumer is slower than ffmpeg, showing it the newest frame is strictly better than
        // working through a backlog of stale ones.
        let mut newest: Option<Vec<u8>> = None;
        loop {
            let Some(start) = find(&buf, &SOI) else {
                // No frame start in hand at all - anything buffered is leading junk.
                buf.clear();
                break;
            };
            let Some(rel_end) = find(&buf[start + 2..], &EOI) else {
                // Frame started but hasn't finished arriving; drop what precedes it and wait.
                if start > 0 {
                    buf.drain(..start);
                }
                break;
            };
            let end = start + 2 + rel_end + 2;
            newest = Some(buf[start..end].to_vec());
            buf.drain(..end);
        }

        if buf.len() > MAX_FRAME_BYTES {
            buf.clear();
        }

        if let Some(frame) = newest {
            if let Ok(mut guard) = slot.lock() {
                *guard = Some(frame);
            }
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
        assert_eq!(slot.lock().unwrap().as_deref(), Some(&frame[..]));
    }

    #[test]
    fn keeps_only_the_newest_of_several() {
        let slot = PreviewFrame::default();
        let mut stream = jpeg(b"old");
        stream.extend_from_slice(&jpeg(b"new"));
        pump(&stream[..], slot.clone());
        assert_eq!(slot.lock().unwrap().as_deref(), Some(&jpeg(b"new")[..]));
    }

    #[test]
    fn ignores_a_trailing_partial_frame() {
        let slot = PreviewFrame::default();
        let mut stream = jpeg(b"whole");
        stream.extend_from_slice(&[0xFF, 0xD8, b'p', b'a', b'r', b't']); // no EOI yet
        pump(&stream[..], slot.clone());
        assert_eq!(slot.lock().unwrap().as_deref(), Some(&jpeg(b"whole")[..]));
    }

    #[test]
    fn skips_leading_junk_before_the_first_frame() {
        let slot = PreviewFrame::default();
        let mut stream = vec![0x00, 0x11, 0x22];
        stream.extend_from_slice(&jpeg(b"real"));
        pump(&stream[..], slot.clone());
        assert_eq!(slot.lock().unwrap().as_deref(), Some(&jpeg(b"real")[..]));
    }

    #[test]
    fn empty_stream_leaves_no_frame() {
        let slot = PreviewFrame::default();
        pump(&[][..], slot.clone());
        assert!(slot.lock().unwrap().is_none());
    }
}
