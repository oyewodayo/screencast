// The "Embedded & hidden data" section of the file Info panel (commands/file_info.rs): anything a
// file carries beyond its visible content. Three kinds of finding:
//
// - structure: walks the file's own container format (JPEG segments, PNG chunks, GIF blocks,
//   ISO-BMFF boxes, RIFF, ZIP central directory, PDF tail) and reports metadata blocks, text
//   chunks, unrecognised/private sections, and - most importantly - bytes appended after the
//   format's own end marker, which every viewer silently ignores and is the classic way to smuggle
//   a ZIP/RAR inside an innocent-looking image;
// - identity: the file's magic bytes vs its extension (a ".jpg" that is really a PNG or an .exe);
// - pixels: a chi-square test on the least-significant bits of lossless images (Westfeld &
//   Pfitzmann's attack on sequential LSB embedding). It is statistical, so it's reported as
//   "possible", never as proof - and it can't see anything in JPEG, whose LSBs don't survive
//   compression (JPEG stego lives in DCT coefficients, out of scope here).
//
// Everything is bounded: whole-file reads only for images/ZIPs under MAX_FULL_READ, seeks for
// video containers, and the pixel test is skipped past MAX_LSB_PIXELS.
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const MAX_FULL_READ: u64 = 300 * 1024 * 1024;
const MAX_LSB_PIXELS: u64 = 40_000_000;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedItem {
    pub label: String,
    pub detail: String,
    // true = worth the user's attention (appended data, hidden text, unknown sections, pixel
    // anomaly); false = ordinary metadata most files of this type carry (ICC profile, XMP...).
    pub notable: bool,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedScan {
    pub items: Vec<EmbeddedItem>,
    // What was actually examined, so "nothing found" is honest about its own coverage.
    pub checks: Vec<String>,
}

impl EmbeddedScan {
    fn add(&mut self, label: impl Into<String>, detail: impl Into<String>, notable: bool) {
        self.items.push(EmbeddedItem { label: label.into(), detail: detail.into(), notable });
    }
    fn checked(&mut self, what: &str) {
        self.checks.push(what.to_string());
    }
}

pub fn scan(path: &Path, ext: &str, size: u64) -> EmbeddedScan {
    let mut out = EmbeddedScan::default();
    let Ok(mut file) = File::open(path) else { return out };

    let mut head = [0u8; 16];
    let head_len = file.read(&mut head).unwrap_or(0);
    let head = &head[..head_len];
    check_identity(&mut out, ext, head);

    let whole = |file: &mut File| -> Option<Vec<u8>> {
        if size > MAX_FULL_READ {
            return None;
        }
        let mut buf = Vec::with_capacity(size as usize);
        file.seek(SeekFrom::Start(0)).ok()?;
        file.read_to_end(&mut buf).ok()?;
        Some(buf)
    };

    match sniff(head) {
        Some("jpeg") => {
            if let Some(bytes) = whole(&mut file) {
                scan_jpeg(&mut out, &bytes);
                scan_exif_thumbnail(&mut out, &bytes);
            }
        }
        Some("png") => {
            if let Some(bytes) = whole(&mut file) {
                scan_png(&mut out, &bytes);
                scan_exif_thumbnail(&mut out, &bytes);
                scan_lsb(&mut out, &bytes);
            }
        }
        Some("gif") => {
            if let Some(bytes) = whole(&mut file) {
                scan_gif(&mut out, &bytes);
            }
        }
        Some("bmp") => {
            if let Some(bytes) = whole(&mut file) {
                scan_bmp(&mut out, &bytes);
                scan_lsb(&mut out, &bytes);
            }
        }
        Some("tiff") => {
            if let Some(bytes) = whole(&mut file) {
                out.checked("TIFF pixels");
                scan_lsb(&mut out, &bytes);
            }
        }
        Some("riff") => scan_riff(&mut out, head, size),
        Some("isobmff") => scan_isobmff(&mut out, &mut file, size),
        Some("zip") => {
            if let Some(bytes) = whole(&mut file) {
                scan_zip(&mut out, &bytes);
            }
        }
        Some("pdf") => scan_pdf_tail(&mut out, &mut file, size),
        _ => {}
    }

    if matches!(ext, "txt" | "md") {
        if let Some(bytes) = whole(&mut file) {
            scan_text(&mut out, &bytes);
        }
    }
    out
}

// --- identity --------------------------------------------------------------------------------

fn sniff(head: &[u8]) -> Option<&'static str> {
    let starts = |sig: &[u8]| head.starts_with(sig);
    Some(if starts(&[0xFF, 0xD8, 0xFF]) {
        "jpeg"
    } else if starts(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if starts(b"GIF87a") || starts(b"GIF89a") {
        "gif"
    } else if starts(b"BM") {
        "bmp"
    } else if starts(b"II*\0") || starts(b"MM\0*") {
        "tiff"
    } else if starts(b"RIFF") {
        "riff"
    } else if head.len() >= 8 && &head[4..8] == b"ftyp" {
        "isobmff"
    } else if starts(&[0x1A, 0x45, 0xDF, 0xA3]) {
        "matroska"
    } else if starts(b"%PDF") {
        "pdf"
    } else if starts(b"PK\x03\x04") {
        "zip"
    } else if starts(b"fLaC") {
        "flac"
    } else if starts(b"OggS") {
        "ogg"
    } else if starts(b"ID3") || (head.len() >= 2 && head[0] == 0xFF && head[1] & 0xE0 == 0xE0) {
        "mp3"
    } else if starts(&[0x30, 0x26, 0xB2, 0x75]) {
        "asf"
    } else if starts(b"MZ") {
        "exe"
    } else if starts(b"Rar!") {
        "rar"
    } else if starts(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) {
        "7z"
    } else {
        return None;
    })
}

fn describe_kind(kind: &str) -> &'static str {
    match kind {
        "jpeg" => "a JPEG image",
        "png" => "a PNG image",
        "gif" => "a GIF image",
        "bmp" => "a BMP image",
        "tiff" => "a TIFF image",
        "riff" => "a RIFF file (WebP/AVI/WAV)",
        "isobmff" => "an MP4/MOV/HEIC container",
        "matroska" => "a Matroska/WebM video",
        "pdf" => "a PDF document",
        "zip" => "a ZIP archive",
        "flac" => "a FLAC audio file",
        "ogg" => "an Ogg file",
        "mp3" => "an MP3 audio file",
        "asf" => "a Windows Media file",
        "exe" => "a Windows executable",
        "rar" => "a RAR archive",
        "7z" => "a 7-Zip archive",
        _ => "an unknown format",
    }
}

fn check_identity(out: &mut EmbeddedScan, ext: &str, head: &[u8]) {
    let expected: &[&str] = match ext {
        "jpg" | "jpeg" => &["jpeg"],
        "png" => &["png"],
        "gif" => &["gif"],
        "bmp" => &["bmp"],
        "tiff" | "tif" => &["tiff"],
        "webp" | "avi" | "wav" => &["riff"],
        "mp4" | "mov" | "m4a" | "m4v" | "heic" | "heif" => &["isobmff"],
        "mkv" | "webm" => &["matroska"],
        "pdf" => &["pdf"],
        "docx" => &["zip"],
        "flac" => &["flac"],
        "ogg" => &["ogg"],
        "mp3" => &["mp3"],
        "wmv" => &["asf"],
        _ => return,
    };
    out.checked("file signature vs extension");
    match sniff(head) {
        Some(kind) if !expected.contains(&kind) => out.add(
            "Disguised file type",
            format!("The content is {}, not the .{} its name says", describe_kind(kind), ext),
            true,
        ),
        // aac/wav-less raw formats etc. never reach here; an unrecognised header on a format
        // whose signature we know is itself suspicious.
        None => out.add(
            "Unrecognised file header",
            format!("The first bytes don't match any known .{} signature", ext),
            true,
        ),
        _ => {}
    }
}

// Bytes after a format's own end marker: size, and what they look like.
fn report_trailing(out: &mut EmbeddedScan, trailing: &[u8], context: &str) {
    // Some writers pad with zeros or a newline - not worth flagging.
    if trailing.iter().all(|b| *b == 0 || b.is_ascii_whitespace()) {
        return;
    }
    let what = match sniff(trailing) {
        Some(kind) => format!(", starting with {}", describe_kind(kind)),
        None if trailing.iter().take(256).all(|b| b.is_ascii_graphic() || b.is_ascii_whitespace()) => {
            format!(": \"{}\"", preview_text(trailing, 120))
        }
        None => String::new(),
    };
    out.add(
        "Data appended after end of file",
        format!("{} hidden after the {}{} - viewers ignore it", human_size(trailing.len() as u64), context, what),
        true,
    );
}

fn human_size(bytes: u64) -> String {
    match bytes {
        b if b >= 1024 * 1024 => format!("{:.1} MB", b as f64 / (1024.0 * 1024.0)),
        b if b >= 1024 => format!("{:.1} KB", b as f64 / 1024.0),
        b => format!("{} bytes", b),
    }
}

fn preview_text(bytes: &[u8], max_chars: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let clean: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if clean.chars().count() > max_chars {
        format!("{}…", clean.chars().take(max_chars).collect::<String>())
    } else {
        clean
    }
}

fn be16(b: &[u8], i: usize) -> Option<usize> {
    Some(u16::from_be_bytes(b.get(i..i + 2)?.try_into().ok()?) as usize)
}
fn be32(b: &[u8], i: usize) -> Option<u64> {
    Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?) as u64)
}
fn le16(b: &[u8], i: usize) -> Option<usize> {
    Some(u16::from_le_bytes(b.get(i..i + 2)?.try_into().ok()?) as usize)
}
fn le32(b: &[u8], i: usize) -> Option<u64> {
    Some(u32::from_le_bytes(b.get(i..i + 4)?.try_into().ok()?) as u64)
}

// --- JPEG ------------------------------------------------------------------------------------

fn scan_jpeg(out: &mut EmbeddedScan, b: &[u8]) {
    out.checked("JPEG segments");
    let mut i = 2;
    let mut has_mpf = false;
    let mut eoi_end = None;
    while i + 1 < b.len() {
        if b[i] != 0xFF {
            out.add("Corrupt segment layout", format!("Unexpected bytes at offset {}", i), true);
            return;
        }
        let marker = b[i + 1];
        if marker == 0xFF {
            i += 1; // fill byte
            continue;
        }
        if marker == 0xD9 {
            eoi_end = Some(i + 2);
            break;
        }
        if (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let Some(len) = be16(b, i + 2) else { return };
        let seg_start = i + 4;
        let seg_end = (i + 2 + len).min(b.len());
        let data = &b[seg_start.min(seg_end)..seg_end];
        let has = |sig: &[u8]| data.starts_with(sig);
        match marker {
            0xE0 if has(b"JFIF") || has(b"JFXX") => {}
            0xE1 if has(b"Exif\0") => out.add("EXIF block", human_size(len as u64), false),
            0xE1 if has(b"http://ns.adobe.com/xap/1.0/") => {
                out.add("XMP metadata", human_size(len as u64), false);
                scan_xmp(out, data);
            }
            0xE1 if has(b"http://ns.adobe.com/xmp/extension/") => {
                out.add("Extended XMP", format!("{} chunk (large XMP payload split across segments)", human_size(len as u64)), true);
                scan_xmp(out, data);
            }
            0xE2 if has(b"ICC_PROFILE\0") => out.add("ICC color profile", human_size(len as u64), false),
            0xE2 if has(b"MPF\0") => {
                has_mpf = true;
                out.add(
                    "Multi-picture format (MPF)",
                    "The file holds more than one image (e.g. a depth map, HDR gain map or preview)",
                    true,
                );
            }
            0xEB if has(b"JP") => out.add(
                "Content Credentials (C2PA / JUMBF)",
                format!("{} provenance manifest - may record the editing or AI tool that produced this image", human_size(len as u64)),
                true,
            ),
            0xED if has(b"Photoshop 3.0") => out.add("Photoshop / IPTC block", human_size(len as u64), false),
            0xEE if has(b"Adobe") => {}
            0xE0..=0xEF => out.add(
                format!("Unrecognised APP{} segment", marker - 0xE0),
                format!("{} with identifier \"{}\"", human_size(len as u64), preview_text(&data[..data.len().min(24)], 24)),
                true,
            ),
            0xFE => out.add("Comment", format!("\"{}\"", preview_text(data, 300)), true),
            _ => {}
        }
        i += 2 + len;
        if marker == 0xDA {
            // Entropy-coded scan: runs until the next real marker (FF followed by non-zero,
            // non-RST byte).
            while i + 1 < b.len() {
                if b[i] == 0xFF && b[i + 1] != 0x00 && !(0xD0..=0xD7).contains(&b[i + 1]) {
                    break;
                }
                i += 1;
            }
        }
    }
    let Some(end) = eoi_end else {
        out.add("Missing end-of-image marker", "The file is truncated or not a well-formed JPEG", true);
        return;
    };
    let trailing = &b[end..];
    if trailing.is_empty() {
        return;
    }
    if has_mpf && trailing.starts_with(&[0xFF, 0xD8]) {
        let images = trailing.windows(4).filter(|w| w[0] == 0xFF && w[1] == 0xD8 && w[2] == 0xFF && (w[3] & 0xF0) == 0xE0).count();
        out.add(
            "Additional embedded images",
            format!("{} after the main image ({} image{} declared by MPF)", human_size(trailing.len() as u64), images.max(1), if images > 1 { "s" } else { "" }),
            true,
        );
    } else {
        report_trailing(out, trailing, "JPEG end marker");
    }
}

// Things phones/editors tuck inside XMP that aren't just text: Google's portrait-mode depth map
// and original photo (GDepth/GImage), Apple/Adobe HDR gain maps, AI-generation markers.
fn scan_xmp(out: &mut EmbeddedScan, data: &[u8]) {
    let xmp = String::from_utf8_lossy(data);
    if xmp.contains("GDepth:Data") {
        out.add("Hidden depth map", "Portrait-mode depth image stored inside XMP (GDepth)", true);
    }
    if xmp.contains("GImage:Data") {
        out.add("Hidden original image", "A second, unedited copy stored inside XMP (GImage)", true);
    }
    if xmp.contains("hdrgm:") || xmp.contains("apdi:") {
        out.add("HDR gain map", "Extra brightness map for HDR displays", false);
    }
    if xmp.contains("trainedAlgorithmicMedia") || xmp.contains("compositeWithTrainedAlgorithmicMedia") {
        out.add("AI-generated marker", "XMP declares this image as (partly) produced by a generative AI model", true);
    }
}

fn scan_exif_thumbnail(out: &mut EmbeddedScan, bytes: &[u8]) {
    use exif::{In, Tag};
    let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes)) else { return };
    if let Some(len) = exif
        .get_field(Tag::JPEGInterchangeFormatLength, In::THUMBNAIL)
        .and_then(|f| f.value.get_uint(0))
    {
        out.add(
            "Embedded thumbnail",
            format!("{} preview image inside EXIF - may still show the original if the photo was cropped or edited", human_size(len as u64)),
            false,
        );
    }
    if let Some(f) = exif.get_field(Tag::MakerNote, In::PRIMARY) {
        if let exif::Value::Undefined(v, _) = &f.value {
            out.add("Camera maker notes", format!("{} of proprietary manufacturer data", human_size(v.len() as u64)), false);
        }
    }
    if let Some(f) = exif.get_field(Tag::UserComment, In::PRIMARY) {
        if let exif::Value::Undefined(v, _) = &f.value {
            // First 8 bytes are the character-code header ("ASCII\0\0\0", "UNICODE\0").
            let text = preview_text(v.get(8..).unwrap_or(&[]), 300);
            if !text.trim().is_empty() {
                out.add("EXIF user comment", format!("\"{}\"", text), true);
            }
        }
    }
    if let Some(f) = exif.get_field(Tag::ImageDescription, In::PRIMARY) {
        let text = f.display_value().to_string();
        let text = text.trim_matches('"').trim();
        if !text.is_empty() {
            out.add("EXIF description", format!("\"{}\"", preview_text(text.as_bytes(), 300)), true);
        }
    }
}

// --- PNG -------------------------------------------------------------------------------------

const PNG_KNOWN: &[&[u8; 4]] = &[
    b"IHDR", b"PLTE", b"IDAT", b"IEND", b"tRNS", b"cHRM", b"gAMA", b"sBIT", b"sRGB", b"cICP", b"mDCv",
    b"mDCV", b"cLLi", b"cLLI", b"bKGD", b"hIST", b"pHYs", b"sPLT", b"tIME", b"acTL", b"fcTL", b"fdAT",
    b"oFFs", b"pCAL", b"sCAL", b"sTER", b"gIFg", b"gIFx", b"dSIG", b"iDOT", b"vpAg", b"caBX",
];

fn scan_png(out: &mut EmbeddedScan, b: &[u8]) {
    out.checked("PNG chunks");
    let mut i = 8;
    while i + 8 <= b.len() {
        let Some(len) = be32(b, i) else { return };
        let ty: [u8; 4] = b[i + 4..i + 8].try_into().unwrap();
        let data_start = i + 8;
        let data_end = (data_start as u64 + len).min(b.len() as u64) as usize;
        let data = &b[data_start..data_end];
        let ty_str = String::from_utf8_lossy(&ty).into_owned();
        match &ty {
            b"tEXt" => {
                let (key, val) = split_nul(data);
                text_chunk(out, &key, &String::from_utf8_lossy(val));
            }
            b"iTXt" => {
                let (key, rest) = split_nul(data);
                let compressed = rest.first().copied().unwrap_or(0) == 1;
                // compression flag, method, language\0, translated keyword\0, text
                let rest = rest.get(2..).unwrap_or(&[]);
                let (_, rest) = split_nul(rest);
                let (_, text) = split_nul(rest);
                if key == "XML:com.adobe.xmp" {
                    out.add("XMP metadata", human_size(len), false);
                    scan_xmp(out, text);
                } else if compressed {
                    out.add(format!("Compressed text \"{}\"", key), human_size(len), true);
                } else {
                    text_chunk(out, &key, &String::from_utf8_lossy(text));
                }
            }
            b"zTXt" => {
                let (key, _) = split_nul(data);
                out.add(format!("Compressed text \"{}\"", key), human_size(len), true);
            }
            b"eXIf" => out.add("EXIF block", human_size(len), false),
            b"iCCP" => out.add("ICC color profile", human_size(len), false),
            b"caBX" => out.add(
                "Content Credentials (C2PA)",
                format!("{} provenance manifest - may record the editing or AI tool that produced this image", human_size(len)),
                true,
            ),
            _ if PNG_KNOWN.contains(&&ty) => {}
            _ => out.add(
                format!("Unknown chunk \"{}\"", ty_str),
                format!("{}{}", human_size(len), if ty[1].is_ascii_lowercase() { " (private, application-specific)" } else { "" }),
                true,
            ),
        }
        i = data_end + 4; // + CRC
        if &ty == b"IEND" {
            if i < b.len() {
                report_trailing(out, &b[i..], "PNG end chunk");
            }
            return;
        }
    }
    out.add("Missing end chunk", "The file is truncated or not a well-formed PNG", true);
}

fn split_nul(b: &[u8]) -> (String, &[u8]) {
    match b.iter().position(|c| *c == 0) {
        Some(p) => (String::from_utf8_lossy(&b[..p]).into_owned(), &b[p + 1..]),
        None => (String::from_utf8_lossy(b).into_owned(), &[]),
    }
}

fn text_chunk(out: &mut EmbeddedScan, key: &str, value: &str) {
    // Stable Diffusion UIs (A1111, ComfyUI...) store the full generation prompt/workflow here.
    let lower = key.to_lowercase();
    let ai = matches!(lower.as_str(), "parameters" | "prompt" | "workflow" | "invokeai_metadata" | "sd-metadata" | "dream");
    let routine = matches!(lower.as_str(), "software" | "creation time" | "date:create" | "date:modify" | "date:timestamp");
    out.add(
        if ai { format!("AI generation data \"{}\"", key) } else { format!("Text \"{}\"", key) },
        format!("\"{}\"", preview_text(value.as_bytes(), 400)),
        !routine,
    );
}

// --- GIF -------------------------------------------------------------------------------------

fn scan_gif(out: &mut EmbeddedScan, b: &[u8]) {
    out.checked("GIF blocks");
    let Some(flags) = b.get(10) else { return };
    let mut i = 13;
    if flags & 0x80 != 0 {
        i += 3 * (1 << ((flags & 0x07) + 1));
    }
    let skip_sub_blocks = |mut i: usize, collect: &mut Vec<u8>| -> Option<usize> {
        loop {
            let n = *b.get(i)? as usize;
            i += 1;
            if n == 0 {
                return Some(i);
            }
            collect.extend_from_slice(b.get(i..i + n)?);
            i += n;
        }
    };
    let mut frames = 0;
    while let Some(&tag) = b.get(i) {
        match tag {
            0x21 => {
                let Some(&label) = b.get(i + 1) else { return };
                let mut data = Vec::new();
                let Some(next) = skip_sub_blocks(i + 2, &mut data) else { return };
                match label {
                    0xFE => out.add("Comment", format!("\"{}\"", preview_text(&data, 300)), true),
                    0xFF => {
                        let id = preview_text(data.get(..11).unwrap_or(&data), 11);
                        if !id.starts_with("NETSCAPE") && !id.starts_with("ANIMEXTS") {
                            let label = if id.starts_with("XMP") { "XMP metadata" } else if id.starts_with("ICCRGB") { "ICC color profile" } else { "" };
                            if label.is_empty() {
                                out.add(format!("Application block \"{}\"", id), human_size(data.len() as u64), true);
                            } else {
                                out.add(label, human_size(data.len() as u64), false);
                            }
                        }
                    }
                    0x01 => out.add("Plain-text block", format!("\"{}\"", preview_text(data.get(12..).unwrap_or(&[]), 200)), true),
                    _ => {}
                }
                i = next;
            }
            0x2C => {
                frames += 1;
                let Some(&f) = b.get(i + 9) else { return };
                i += 10;
                if f & 0x80 != 0 {
                    i += 3 * (1 << ((f & 0x07) + 1));
                }
                let mut sink = Vec::new();
                let Some(next) = skip_sub_blocks(i + 1, &mut sink) else { return };
                i = next;
            }
            0x3B => {
                if frames > 1 {
                    out.add("Animation", format!("{} frames", frames), false);
                }
                if i + 1 < b.len() {
                    report_trailing(out, &b[i + 1..], "GIF trailer");
                }
                return;
            }
            _ => {
                out.add("Corrupt block layout", format!("Unexpected byte at offset {}", i), true);
                return;
            }
        }
    }
}

// --- BMP / RIFF ------------------------------------------------------------------------------

fn scan_bmp(out: &mut EmbeddedScan, b: &[u8]) {
    out.checked("BMP size header");
    if let Some(declared) = le32(b, 2) {
        if (declared as usize) < b.len() && declared > 0 {
            report_trailing(out, &b[declared as usize..], "BMP's declared size");
        }
    }
}

fn scan_riff(out: &mut EmbeddedScan, head: &[u8], size: u64) {
    out.checked("RIFF size header");
    if let Some(declared) = le32(head, 4) {
        let end = declared + 8 + (declared & 1);
        if end < size {
            out.add(
                "Data appended after end of file",
                format!("{} beyond the RIFF container's declared size - viewers ignore it", human_size(size - end)),
                true,
            );
        }
    }
}

// --- ISO BMFF (mp4/mov/m4a/heic) -------------------------------------------------------------

fn scan_isobmff(out: &mut EmbeddedScan, file: &mut File, size: u64) {
    out.checked("MP4/MOV top-level boxes");
    const KNOWN: &[&[u8; 4]] = &[
        b"ftyp", b"moov", b"mdat", b"free", b"skip", b"wide", b"uuid", b"meta", b"pdin", b"moof", b"mfra",
        b"styp", b"sidx", b"ssix", b"emsg", b"prft", b"udta", b"pnot", b"junk", b"PICT", b"idat", b"iinf",
    ];
    let mut pos = 0u64;
    let mut header = [0u8; 16];
    while pos < size {
        if file.seek(SeekFrom::Start(pos)).is_err() || file.read_exact(&mut header[..8]).is_err() {
            break;
        }
        let mut box_len = be32(&header, 0).unwrap_or(0);
        let ty: [u8; 4] = header[4..8].try_into().unwrap();
        if box_len == 1 {
            if file.read_exact(&mut header[8..16]).is_err() {
                break;
            }
            box_len = u64::from_be_bytes(header[8..16].try_into().unwrap());
        } else if box_len == 0 {
            box_len = size - pos; // runs to end of file
        }
        let printable = ty.iter().all(|c| c.is_ascii_graphic() || *c == b' ');
        if box_len < 8 || !printable || pos + box_len > size {
            // Not a box at all - whatever is here was appended to a complete file.
            let mut tail = vec![0u8; ((size - pos).min(512)) as usize];
            let _ = file.seek(SeekFrom::Start(pos));
            let _ = file.read_exact(&mut tail);
            if pos + box_len > size && printable && box_len >= 8 {
                out.add("Truncated box", format!("\"{}\" box claims more bytes than the file has", String::from_utf8_lossy(&ty)), true);
            } else {
                let what = sniff(&tail).map(|k| format!(", starting with {}", describe_kind(k))).unwrap_or_default();
                out.add(
                    "Data appended after end of file",
                    format!("{} after the last MP4 box{} - players ignore it", human_size(size - pos), what),
                    true,
                );
            }
            return;
        }
        if &ty == b"uuid" {
            out.add("Vendor (uuid) box", format!("{} of vendor-specific data (e.g. XMP, 360° or camera metadata)", human_size(box_len)), false);
        } else if !KNOWN.contains(&&ty) {
            out.add(format!("Unknown box \"{}\"", String::from_utf8_lossy(&ty)), human_size(box_len), true);
        }
        pos += box_len;
    }
}

// --- ZIP (docx) ------------------------------------------------------------------------------

fn scan_zip(out: &mut EmbeddedScan, b: &[u8]) {
    out.checked("ZIP entries");
    // End-of-central-directory record: within the last 64 KB + 22 (max comment length).
    let search_from = b.len().saturating_sub(65_557);
    let Some(eocd) = (search_from..b.len().saturating_sub(21)).rev().find(|&i| b[i..i + 4] == *b"PK\x05\x06") else {
        out.add("Damaged archive", "No ZIP central directory found", true);
        return;
    };
    let (Some(count), Some(cd_offset), Some(comment_len)) = (le16(b, eocd + 10), le32(b, eocd + 16), le16(b, eocd + 20)) else { return };
    let end = eocd + 22 + comment_len;
    if comment_len > 0 {
        out.add("Archive comment", format!("\"{}\"", preview_text(&b[eocd + 22..end.min(b.len())], 300)), true);
    }
    if end < b.len() {
        report_trailing(out, &b[end..], "ZIP end record");
    }
    let mut media = 0;
    let mut i = cd_offset as usize;
    for _ in 0..count {
        if b.get(i..i + 4) != Some(b"PK\x01\x02") {
            break;
        }
        let (Some(name_len), Some(extra_len), Some(cmt_len), Some(usize_)) =
            (le16(b, i + 28), le16(b, i + 30), le16(b, i + 32), le32(b, i + 24))
        else {
            break;
        };
        let name = String::from_utf8_lossy(b.get(i + 46..i + 46 + name_len).unwrap_or(&[])).into_owned();
        let lower = name.to_lowercase();
        if lower.ends_with("vbaproject.bin") {
            out.add("Macros (VBA)", format!("{} - macro code can run when the document is opened", name), true);
        } else if lower.contains("/embeddings/") {
            out.add("Embedded object", format!("{} ({})", name.rsplit('/').next().unwrap_or(&name), human_size(usize_)), true);
        } else if lower.contains("/media/") {
            media += 1;
        } else if lower.contains("activex") {
            out.add("ActiveX control", name, true);
        } else if !(lower.ends_with(".rels") || lower.ends_with(".xml")) {
            out.add("Unexpected archive entry", format!("{} ({})", name, human_size(usize_)), true);
        }
        i += 46 + name_len + extra_len + cmt_len;
    }
    if media > 0 {
        out.add("Embedded media", format!("{} image/media file{}", media, if media == 1 { "" } else { "s" }), false);
    }
}

// --- PDF -------------------------------------------------------------------------------------

// Attachments and JavaScript are read on the frontend by pdf.js; only the tail is checked here.
fn scan_pdf_tail(out: &mut EmbeddedScan, file: &mut File, size: u64) {
    out.checked("PDF end marker");
    let tail_len = size.min(64 * 1024);
    let mut tail = vec![0u8; tail_len as usize];
    if file.seek(SeekFrom::Start(size - tail_len)).is_err() || file.read_exact(&mut tail).is_err() {
        return;
    }
    match tail.windows(5).rposition(|w| w == b"%%EOF") {
        Some(p) => {
            let after = &tail[p + 5..];
            if !after.is_empty() {
                report_trailing(out, after, "PDF's %%EOF marker");
            }
        }
        None => out.add(
            "Data appended after end of file",
            "No %%EOF marker in the last 64 KB - something large was likely appended to the PDF",
            true,
        ),
    }
}

// --- text ------------------------------------------------------------------------------------

fn scan_text(out: &mut EmbeddedScan, b: &[u8]) {
    out.checked("text encoding");
    let nul = b.iter().filter(|c| **c == 0).count();
    if nul > 0 {
        out.add("Binary data in text file", format!("{} NUL bytes - not plain text", nul), true);
    }
    let text = String::from_utf8_lossy(b);
    // Zero-width characters are a known way to watermark or hide messages in plain text.
    let hidden = text.chars().filter(|c| matches!(*c, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}' | '\u{E0000}'..='\u{E007F}')).count();
    let hidden = if text.starts_with('\u{FEFF}') { hidden - 1 } else { hidden };
    if hidden > 0 {
        out.add("Invisible characters", format!("{} zero-width/tag characters - can encode a hidden message or watermark", hidden), true);
    }
}

// --- LSB pixel test --------------------------------------------------------------------------

fn scan_lsb(out: &mut EmbeddedScan, bytes: &[u8]) {
    use image::{DynamicImage, ImageReader};
    let Ok(reader) = ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format() else { return };
    let Ok((w, h)) = reader.into_dimensions() else { return };
    if (w as u64) * (h as u64) > MAX_LSB_PIXELS {
        out.checked("pixels (skipped: image too large)");
        return;
    }
    let Ok(img) = image::load_from_memory(bytes) else { return };
    // 16-bit and float images: LSB embedding works differently there; only test 8-bit.
    let samples: Vec<u8> = match img {
        DynamicImage::ImageLuma8(i) => i.into_raw(),
        DynamicImage::ImageRgb8(i) => i.into_raw(),
        DynamicImage::ImageRgba8(i) => i.pixels().flat_map(|p| [p[0], p[1], p[2]]).collect(),
        DynamicImage::ImageLumaA8(i) => i.pixels().map(|p| p[0]).collect(),
        _ => {
            out.checked("pixels (skipped: not 8-bit)");
            return;
        }
    };
    out.checked("pixel least-significant bits (chi-square)");
    // Sequential embedding fills the image from the top, so the first slice is where the
    // statistic is strongest; testing the whole image too catches spread-out embedding.
    let first = &samples[..samples.len() / 10];
    let p_first = chi_square_lsb(first);
    let p_all = chi_square_lsb(&samples);
    let suspicious = |p: Option<f64>| p.is_some_and(|p| p > 0.99);
    if suspicious(p_first) || suspicious(p_all) {
        let where_ = if suspicious(p_all) { "throughout the image" } else { "in the top part of the image" };
        out.add(
            "Possible hidden data in pixels",
            format!(
                "The lowest bit of the pixel values looks randomised {} - typical of LSB steganography. Statistical test (p = {:.3}); can be a false positive on noisy or synthetic images.",
                where_,
                p_first.unwrap_or(0.0).max(p_all.unwrap_or(0.0))
            ),
            true,
        );
    } else if p_first.is_none() && p_all.is_none() {
        out.checked("(pixel test inconclusive: too few distinct colors)");
    }
}

// Westfeld-Pfitzmann: LSB embedding equalises the counts of each value pair (2k, 2k+1). Returns
// the probability that the observed pair counts came from that equalised distribution - near 1
// means "embedded", near 0 means "natural". None when there aren't enough populated pairs.
fn chi_square_lsb(samples: &[u8]) -> Option<f64> {
    let mut hist = [0u64; 256];
    for s in samples {
        hist[*s as usize] += 1;
    }
    let mut chi = 0.0;
    let mut pairs = 0;
    for k in 0..128 {
        let (a, b) = (hist[2 * k] as f64, hist[2 * k + 1] as f64);
        let expected = (a + b) / 2.0;
        // The test is only valid for cells with a reasonable expected count.
        if expected < 5.0 {
            continue;
        }
        chi += (a - expected).powi(2) / expected;
        pairs += 1;
    }
    if pairs < 30 {
        return None;
    }
    let df = (pairs - 1) as f64;
    Some(1.0 - regularized_gamma_p(df / 2.0, chi / 2.0))
}

fn ln_gamma(x: f64) -> f64 {
    // Lanczos approximation (g = 7, n = 9).
    const C: [f64; 9] = [
        0.999_999_999_999_809_9, 676.520_368_121_885_1, -1_259.139_216_722_402_8, 771.323_428_777_653_1,
        -176.615_029_162_140_6, 12.507_343_278_686_905, -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6,
        1.505_632_735_149_311_6e-7,
    ];
    let x = x - 1.0;
    let mut a = C[0];
    let t = x + 7.5;
    for (i, c) in C.iter().enumerate().skip(1) {
        a += c / (x + i as f64);
    }
    0.5 * (2.0 * std::f64::consts::PI).ln() + (x + 0.5) * t.ln() - t + a.ln()
}

fn regularized_gamma_p(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x < a + 1.0 {
        // Series expansion.
        let (mut sum, mut term, mut n) = (1.0 / a, 1.0 / a, a);
        for _ in 0..1000 {
            n += 1.0;
            term *= x / n;
            sum += term;
            if term.abs() < sum.abs() * 1e-12 {
                break;
            }
        }
        (sum.ln() - x + a * x.ln() - ln_gamma(a)).exp()
    } else {
        // Continued fraction (Lentz) for Q, then P = 1 - Q.
        let tiny = 1e-300;
        let mut b = x + 1.0 - a;
        let mut c = 1.0 / tiny;
        let mut d = 1.0 / b;
        let mut h = d;
        for i in 1..1000 {
            let an = -(i as f64) * (i as f64 - a);
            b += 2.0;
            d = an * d + b;
            if d.abs() < tiny {
                d = tiny;
            }
            c = b + an / c;
            if c.abs() < tiny {
                c = tiny;
            }
            d = 1.0 / d;
            let delta = d * c;
            h *= delta;
            if (delta - 1.0).abs() < 1e-12 {
                break;
            }
        }
        1.0 - (-x + a * x.ln() - ln_gamma(a)).exp() * h
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_zip_appended_to_png_and_text_chunk() {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        let chunk = |ty: &[u8], data: &[u8]| {
            let mut c = (data.len() as u32).to_be_bytes().to_vec();
            c.extend_from_slice(ty);
            c.extend_from_slice(data);
            c.extend_from_slice(&[0, 0, 0, 0]);
            c
        };
        png.extend(chunk(b"IHDR", &[0; 13]));
        png.extend(chunk(b"tEXt", b"parameters\0a cat in space"));
        png.extend(chunk(b"IEND", &[]));
        png.extend_from_slice(b"PK\x03\x04secret");
        let mut out = EmbeddedScan::default();
        scan_png(&mut out, &png);
        assert!(out.items.iter().any(|i| i.label.starts_with("AI generation data") && i.detail.contains("a cat in space")));
        assert!(out.items.iter().any(|i| i.label == "Data appended after end of file" && i.detail.contains("ZIP")));
    }

    #[test]
    fn flags_disguised_extension() {
        let mut out = EmbeddedScan::default();
        check_identity(&mut out, "jpg", b"\x89PNG\r\n\x1a\n");
        assert_eq!(out.items[0].label, "Disguised file type");
    }

    #[test]
    fn chi_square_separates_embedded_from_natural() {
        // "Natural": strongly unequal pair counts (only even values mostly).
        let natural: Vec<u8> = (0..200_000u32).map(|i| ((i * 7919) % 200) as u8 & 0xFE).collect();
        assert!(chi_square_lsb(&natural).map_or(true, |p| p < 0.01));
        // "Embedded": pair counts equalised by random LSBs.
        let mut seed = 12345u64;
        let embedded: Vec<u8> = (0..200_000u32)
            .map(|i| {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                (((i * 7919) % 200) as u8 & 0xFE) | ((seed >> 33) as u8 & 1)
            })
            .collect();
        assert!(chi_square_lsb(&embedded).unwrap() > 0.99);
    }

    #[test]
    fn gamma_p_matches_known_values() {
        // P(1, x) = 1 - e^-x
        assert!((regularized_gamma_p(1.0, 2.0) - (1.0 - (-2.0f64).exp())).abs() < 1e-9);
        assert!((regularized_gamma_p(5.0, 30.0) - 1.0).abs() < 1e-7);
    }
}
