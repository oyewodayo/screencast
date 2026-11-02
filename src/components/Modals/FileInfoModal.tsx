// components/Modals/FileInfoModal.tsx
//
// The sidebar file menu's "Info" panel: everything known about one file, for every file type.
// The data comes from the get_file_info command (src-tauri/src/commands/file_info.rs) -
// filesystem dates/attributes, ffprobe's view of media files, and EXIF for photos - plus, for
// PDFs, the document's own info dictionary read here through pdf.js (already loaded for the PDF
// viewer, so there's no reason to teach the backend to parse PDFs too).
//
// Sections only render when they have something to say, so an mp3 doesn't show an empty
// "Camera" block and a txt file doesn't show "Dimensions".

import { useEffect, useMemo, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { getDocument, PDFDateString } from "pdfjs-dist";
import {
    IoClose,
    IoInformationCircleOutline,
    IoCopyOutline,
    IoCheckmark,
    IoFolderOpenOutline,
    IoLocationOutline,
    IoOpenOutline,
    IoVideocam,
    IoMusicalNotes,
    IoImage,
    IoDocumentText,
    IoGridOutline,
} from "react-icons/io5";
import { ensureWorkerConfigured } from "../../hooks/usePdfDocument";
import { formatFileSize } from "../../utils/Formater";
import { getFileCategory } from "../../utils/fileCategory";

interface GeoPoint {
    lat: number;
    lon: number;
    altitude: number | null;
}

interface VideoStreamInfo {
    codec: string | null;
    codecLong: string | null;
    profile: string | null;
    width: number | null;
    height: number | null;
    displayAspectRatio: string | null;
    frameRate: number | null;
    bitRate: number | null;
    pixelFormat: string | null;
    colorSpace: string | null;
    rotation: number | null;
    frameCount: number | null;
}

interface AudioStreamInfo {
    codec: string | null;
    codecLong: string | null;
    sampleRate: number | null;
    channels: number | null;
    channelLayout: string | null;
    bitRate: number | null;
    language: string | null;
}

interface MediaInfo {
    formatName: string | null;
    formatLongName: string | null;
    durationSecs: number | null;
    bitRate: number | null;
    creationTime: string | null;
    location: GeoPoint | null;
    video: VideoStreamInfo | null;
    audio: AudioStreamInfo[];
    subtitleCount: number;
    tags: [string, string][];
}

interface ExifInfo {
    dateTaken: string | null;
    dateDigitized: string | null;
    make: string | null;
    model: string | null;
    lens: string | null;
    software: string | null;
    artist: string | null;
    copyright: string | null;
    exposureTime: string | null;
    fNumber: string | null;
    iso: string | null;
    focalLength: string | null;
    focalLength35mm: string | null;
    flash: string | null;
    whiteBalance: string | null;
    exposureProgram: string | null;
    meteringMode: string | null;
    orientation: string | null;
    pixelWidth: number | null;
    pixelHeight: number | null;
    xResolution: string | null;
    yResolution: string | null;
    colorSpace: string | null;
    location: GeoPoint | null;
}

interface FileInfo {
    name: string;
    path: string;
    folder: string;
    extension: string;
    sizeBytes: number;
    createdMs: number | null;
    modifiedMs: number | null;
    accessedMs: number | null;
    readOnly: boolean;
    hidden: boolean;
    media: MediaInfo | null;
    exif: ExifInfo | null;
    text: { lines: number; words: number; characters: number } | null;
    embedded: EmbeddedScan;
    folderStats: { files: number; folders: number; newestModifiedMs: number | null } | null;
}

interface EmbeddedItem {
    label: string;
    detail: string;
    notable: boolean;
}

interface EmbeddedScan {
    items: EmbeddedItem[];
    checks: string[];
}

interface PdfInfo {
    pages: number;
    pageSize: string | null;
    title: string | null;
    author: string | null;
    subject: string | null;
    keywords: string | null;
    creator: string | null;
    producer: string | null;
    version: string | null;
    created: Date | null;
    modified: Date | null;
    encrypted: boolean;
    attachments: string[];
    hasJavaScript: boolean;
}

type Row = { label: string; value: string; notable?: boolean };
type Section = { title: string; rows: Row[]; footnote?: string };

const EMBEDDED_TITLE = "Embedded & hidden data";

// Items kept in Briefcast's own stores rather than at a path the caller holds - resolved by the
// backend's get_library_item_info. Boards/docs/whiteboards/mindmaps are folders; trash is a file.
export type LibraryItemKind = "board" | "doc" | "whiteboard" | "mindmap" | "trash";

const ITEM_KIND_LABELS: Record<LibraryItemKind, string> = {
    board: "Board",
    doc: "Document",
    whiteboard: "Whiteboard",
    mindmap: "Mindmap",
    trash: "File in Trash",
};

interface FileInfoModalProps {
    // Exactly one of filePath / item. fileName is the display name either way (a board's title, a
    // trashed file's original name).
    filePath?: string;
    item?: { kind: LibraryItemKind; id: string };
    fileName: string;
    onClose: () => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" });
const formatDate = (d: Date | null | undefined) => (d && !isNaN(d.getTime()) ? dateFormat.format(d) : null);

// EXIF dates ("2024-10-08 17:10:00") carry no time zone - they're the camera's wall clock, so
// they're read as local time rather than UTC.
const parseExifDate = (raw: string | null): Date | null => {
    const m = raw?.match(/^(\d{4})[-:](\d{2})[-:](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
};

const formatDuration = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const ss = s.toFixed(2).padStart(5, "0");
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

const formatBitRate = (bps: number) =>
    bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(2)} Mbps` : `${Math.round(bps / 1000)} kbps`;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const aspectRatio = (w: number, h: number) => {
    const g = gcd(w, h);
    const [rw, rh] = [w / g, h / g];
    // Odd sizes (1366×768) reduce to unhelpful ratios like 683:384 - show the decimal instead.
    return rw <= 32 && rh <= 32 ? `${rw}:${rh}` : `${(w / h).toFixed(2)}:1`;
};

const toDms = (deg: number, pos: string, neg: string) => {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const mFloat = (abs - d) * 60;
    const m = Math.floor(mFloat);
    const s = ((mFloat - m) * 60).toFixed(1);
    return `${d}° ${m}′ ${s}″ ${deg >= 0 ? pos : neg}`;
};

const channelLabel = (a: AudioStreamInfo) => {
    if (a.channelLayout) return a.channelLayout.charAt(0).toUpperCase() + a.channelLayout.slice(1);
    if (a.channels === 1) return "Mono";
    if (a.channels === 2) return "Stereo";
    return a.channels ? `${a.channels} channels` : null;
};

async function readPdfInfo(path: string): Promise<PdfInfo> {
    ensureWorkerConfigured();
    const task = getDocument({ url: convertFileSrc(path) });
    const doc = await task.promise;
    try {
        const info = (await doc.getMetadata()).info as unknown as Record<string, unknown>;
        const str = (k: string) => {
            const v = info?.[k];
            return typeof v === "string" && v.trim() ? v.trim() : null;
        };
        const pdfDate = (k: string) => {
            const raw = str(k);
            return raw ? PDFDateString.toDateObject(raw) : null;
        };
        // Files embedded in the PDF itself (not visible on any page) and scripts that run on open/
        // interaction - both common carriers for anything a PDF is hiding.
        const attachments = await doc
            .getAttachments()
            .then((a) =>
                Array.from(a?.entries() ?? []).map(
                    ([key, f]) => `${f.filename || key}${f.content ? ` (${formatFileSize(f.content.length)})` : ""}`,
                ),
            )
            .catch(() => [] as string[]);
        const hasJavaScript = await doc
            .getJSActions()
            .then((js: unknown) => Boolean(js && Object.keys(js as object).length))
            .catch(() => false);
        let pageSize: string | null = null;
        try {
            const page = await doc.getPage(1);
            const { width, height } = page.getViewport({ scale: 1 });
            // Viewport units are PDF points (1/72 in).
            const mm = (pt: number) => Math.round((pt / 72) * 25.4);
            const inches = (pt: number) => (pt / 72).toFixed(2);
            pageSize = `${mm(width)} × ${mm(height)} mm (${inches(width)} × ${inches(height)} in)`;
        } catch {
            /* page size is a nicety - the rest still stands */
        }
        return {
            pages: doc.numPages,
            pageSize,
            title: str("Title"),
            author: str("Author"),
            subject: str("Subject"),
            keywords: str("Keywords"),
            creator: str("Creator"),
            producer: str("Producer"),
            version: str("PDFFormatVersion"),
            created: pdfDate("CreationDate"),
            modified: pdfDate("ModDate"),
            encrypted: Boolean(info?.IsEncrypted),
            attachments,
            hasJavaScript,
        };
    } finally {
        void task.destroy();
    }
}

function buildFolderSections(info: FileInfo, displayName: string, kindLabel: string): Section[] {
    const stats = info.folderStats!;
    const date = (ms: number | null) => formatDate(ms !== null ? new Date(ms) : null) ?? "Unknown";
    return [
        {
            title: "General",
            rows: [
                { label: "Name", value: displayName },
                { label: "Type", value: kindLabel },
                { label: "Size on disk", value: `${formatFileSize(info.sizeBytes)} (${info.sizeBytes.toLocaleString()} bytes)` },
                { label: "Stored in", value: info.path },
            ],
        },
        {
            title: "Dates",
            rows: [
                { label: "Created", value: date(info.createdMs) },
                { label: "Last changed", value: date(stats.newestModifiedMs ?? info.modifiedMs) },
            ],
        },
        {
            title: "Contents",
            rows: [
                { label: "Files", value: stats.files.toLocaleString() },
                ...(stats.folders ? [{ label: "Subfolders", value: stats.folders.toLocaleString() }] : []),
            ],
        },
    ];
}

function buildSections(
    info: FileInfo,
    pdf: PdfInfo | null,
    displayName: string,
    kindLabel: string | null,
): { sections: Section[]; location: GeoPoint | null } {
    if (info.folderStats) return { sections: buildFolderSections(info, displayName, kindLabel ?? "Folder"), location: null };
    const category = getFileCategory(displayName);
    const { media, exif } = info;
    const video = media?.video ?? null;
    const isImage = category === "image";
    const push = (rows: Row[], label: string, value: string | number | null | undefined) => {
        if (value !== null && value !== undefined && value !== "") rows.push({ label, value: String(value) });
    };

    const sections: Section[] = [];

    // General
    const general: Row[] = [];
    push(general, "Name", displayName);
    if (kindLabel) push(general, "Status", kindLabel);
    // ffprobe names still-image demuxers after its internals ("piped png sequence") - only
    // worth showing for real containers.
    const containerName = media?.formatLongName && !/pipe|sequence|image2/i.test(media.formatLongName) ? media.formatLongName : null;
    const typeLabel = [info.extension.toUpperCase(), containerName].filter(Boolean).join(" — ");
    push(general, "Type", typeLabel || "Unknown");
    push(general, "Size", `${formatFileSize(info.sizeBytes)} (${info.sizeBytes.toLocaleString()} bytes)`);
    push(general, "Folder", info.folder);
    const attrs = [info.readOnly && "Read-only", info.hidden && "Hidden"].filter(Boolean).join(", ");
    push(general, "Attributes", attrs || "Normal");
    sections.push({ title: "General", rows: general });

    // Dates - "captured" is whatever the content itself claims, which survives copies and moves
    // (the filesystem's "created" is reset by both).
    const dates: Row[] = [];
    const captured =
        parseExifDate(exif?.dateTaken ?? null) ??
        (media?.creationTime ? new Date(media.creationTime) : null) ??
        pdf?.created ??
        null;
    push(dates, isImage ? "Date taken" : category === "pdf" ? "Authored" : "Captured", formatDate(captured));
    const digitized = parseExifDate(exif?.dateDigitized ?? null);
    if (digitized && digitized.getTime() !== captured?.getTime()) push(dates, "Digitized", formatDate(digitized));
    push(dates, "Document modified", formatDate(pdf?.modified));
    push(dates, "File created", formatDate(info.createdMs !== null ? new Date(info.createdMs) : null));
    push(dates, "File modified", formatDate(info.modifiedMs !== null ? new Date(info.modifiedMs) : null));
    push(dates, "Last opened", formatDate(info.accessedMs !== null ? new Date(info.accessedMs) : null));
    if (dates.length) sections.push({ title: "Dates", rows: dates });

    // Location
    const location = exif?.location ?? media?.location ?? null;
    if (location) {
        const rows: Row[] = [];
        push(rows, "Latitude", `${toDms(location.lat, "N", "S")}  (${location.lat.toFixed(6)})`);
        push(rows, "Longitude", `${toDms(location.lon, "E", "W")}  (${location.lon.toFixed(6)})`);
        if (location.altitude !== null) push(rows, "Altitude", `${location.altitude.toFixed(1)} m`);
        sections.push({ title: "Location captured", rows });
    } else if (isImage || category === "video") {
        sections.push({ title: "Location captured", rows: [{ label: "Location", value: "Not recorded in this file" }] });
    }

    // Dimensions
    const dims: Row[] = [];
    let width = video?.width ?? null;
    let height = video?.height ?? null;
    // HEIC is stored as a grid of tiles - ffprobe's stream size is one tile, EXIF has the image's.
    if ((info.extension === "heic" || info.extension === "heif" || !width) && exif?.pixelWidth && exif.pixelHeight) {
        width = exif.pixelWidth;
        height = exif.pixelHeight;
    }
    if (width && height) {
        const rotated = video?.rotation && Math.abs(video.rotation) % 180 === 90;
        const [dw, dh] = rotated ? [height, width] : [width, height];
        push(dims, "Dimensions", `${dw} × ${dh} px${rotated ? ` (stored ${width} × ${height}, rotated ${Math.abs(video!.rotation!)}°)` : ""}`);
        push(dims, "Aspect ratio", video?.displayAspectRatio && !rotated ? video.displayAspectRatio : aspectRatio(dw, dh));
        if (isImage) push(dims, "Megapixels", `${((dw * dh) / 1_000_000).toFixed(1)} MP`);
        if (dh >= 2160 && !isImage) push(dims, "Resolution class", dh >= 4320 ? "8K" : "4K UHD");
        else if (dh >= 1080 && !isImage) push(dims, "Resolution class", dh >= 1440 ? "QHD (1440p)" : "Full HD (1080p)");
        else if (dh >= 720 && !isImage) push(dims, "Resolution class", "HD (720p)");
    }
    if (exif?.xResolution) push(dims, "Print resolution", `${exif.xResolution}${exif.yResolution && exif.yResolution !== exif.xResolution ? ` × ${exif.yResolution}` : ""}`);
    push(dims, "Orientation", exif?.orientation);
    // ffprobe's color_space for stills is its internal plane order ("gbr"), not a real profile.
    push(dims, "Color space", exif?.colorSpace);
    if (isImage) push(dims, "Pixel format", video?.pixelFormat);
    if (isImage && video?.codecLong) push(dims, "Encoding", video.codecLong);
    if (dims.length) sections.push({ title: isImage ? "Image" : "Dimensions", rows: dims });

    // Video
    if (video && !isImage) {
        const rows: Row[] = [];
        if (media?.durationSecs) push(rows, "Duration", formatDuration(media.durationSecs));
        push(rows, "Codec", [video.codecLong ?? video.codec, video.profile && `(${video.profile})`].filter(Boolean).join(" "));
        if (video.frameRate) push(rows, "Frame rate", `${+video.frameRate.toFixed(3)} fps`);
        if (video.bitRate) push(rows, "Video bit rate", formatBitRate(video.bitRate));
        if (media?.bitRate) push(rows, "Overall bit rate", formatBitRate(media.bitRate));
        push(rows, "Pixel format", video.pixelFormat);
        push(rows, "Color space", video.colorSpace);
        if (video.frameCount) push(rows, "Frames", video.frameCount.toLocaleString());
        if (media && media.subtitleCount > 0) push(rows, "Subtitle tracks", media.subtitleCount);
        push(rows, "Container", media?.formatName);
        sections.push({ title: "Video", rows });
    }

    // Audio
    if (media && media.audio.length > 0) {
        media.audio.forEach((a, i) => {
            const rows: Row[] = [];
            if (!video && i === 0 && media.durationSecs) push(rows, "Duration", formatDuration(media.durationSecs));
            push(rows, "Codec", a.codecLong ?? a.codec);
            if (a.sampleRate) push(rows, "Sample rate", `${(a.sampleRate / 1000).toLocaleString()} kHz`);
            push(rows, "Channels", channelLabel(a));
            if (a.bitRate) push(rows, "Bit rate", formatBitRate(a.bitRate));
            else if (!video && media.bitRate) push(rows, "Bit rate", formatBitRate(media.bitRate));
            push(rows, "Language", a.language);
            sections.push({ title: media.audio.length > 1 ? `Audio track ${i + 1}` : "Audio", rows });
        });
    } else if (category === "video" && media) {
        sections.push({ title: "Audio", rows: [{ label: "Audio", value: "No audio track" }] });
    }

    // Camera
    if (exif) {
        const rows: Row[] = [];
        push(rows, "Camera", [exif.make, exif.model && !exif.model.startsWith(exif.make ?? "\u0000") ? exif.model : null].filter(Boolean).join(" ") || exif.model);
        push(rows, "Lens", exif.lens);
        push(rows, "Exposure", exif.exposureTime);
        push(rows, "Aperture", exif.fNumber);
        push(rows, "ISO", exif.iso);
        push(rows, "Focal length", [exif.focalLength, exif.focalLength35mm && `(${exif.focalLength35mm} in 35mm)`].filter(Boolean).join(" "));
        push(rows, "Flash", exif.flash);
        push(rows, "White balance", exif.whiteBalance);
        push(rows, "Exposure program", exif.exposureProgram);
        push(rows, "Metering", exif.meteringMode);
        push(rows, "Software", exif.software);
        push(rows, "Artist", exif.artist);
        push(rows, "Copyright", exif.copyright);
        if (rows.length) sections.push({ title: "Camera", rows });
    }

    // PDF
    if (pdf) {
        const rows: Row[] = [];
        push(rows, "Pages", pdf.pages);
        push(rows, "Page size", pdf.pageSize);
        push(rows, "Title", pdf.title);
        push(rows, "Author", pdf.author);
        push(rows, "Subject", pdf.subject);
        push(rows, "Keywords", pdf.keywords);
        push(rows, "Created with", pdf.creator);
        push(rows, "Producer", pdf.producer);
        push(rows, "PDF version", pdf.version);
        push(rows, "Encrypted", pdf.encrypted ? "Yes" : "No");
        sections.push({ title: "Document", rows });
    }

    // Text
    if (info.text) {
        sections.push({
            title: "Content",
            rows: [
                { label: "Lines", value: info.text.lines.toLocaleString() },
                { label: "Words", value: info.text.words.toLocaleString() },
                { label: "Characters", value: info.text.characters.toLocaleString() },
            ],
        });
    }

    // Embedded & hidden data - everything beyond the visible content: appended bytes, hidden text,
    // extra images, attachments, pixel-level anomalies (see commands/embedded_scan.rs).
    const embeddedRows: Row[] = info.embedded.items.map((i) => ({ label: i.label, value: i.detail, notable: i.notable }));
    pdf?.attachments.forEach((a) => embeddedRows.push({ label: "Attached file", value: a, notable: true }));
    if (pdf?.hasJavaScript) {
        embeddedRows.push({ label: "JavaScript", value: "The PDF contains scripts that can run when it's opened or used", notable: true });
    }
    // Notable findings first, so the things worth reading aren't buried under ICC profiles.
    embeddedRows.sort((a, b) => Number(!!b.notable) - Number(!!a.notable));
    const checks = [...info.embedded.checks, ...(pdf ? ["PDF attachments & scripts"] : [])];
    if (embeddedRows.length === 0) {
        embeddedRows.push({ label: "Result", value: checks.length ? "Nothing hidden found" : "No checks available for this file type" });
    }
    sections.push({
        title: EMBEDDED_TITLE,
        rows: embeddedRows,
        footnote: checks.length ? `Checked: ${checks.join(", ")}.` : undefined,
    });

    // Whatever else the container carries (title, artist, album, encoder, device make/model...).
    if (media && media.tags.length > 0) {
        sections.push({
            title: "Embedded metadata",
            rows: media.tags.map(([k, v]) => ({ label: k.replace(/_/g, " "), value: v })),
        });
    }

    return { sections, location };
}

const CATEGORY_ICONS = {
    video: <IoVideocam size={18} className="text-purple-500" />,
    audio: <IoMusicalNotes size={18} className="text-pink-500" />,
    image: <IoImage size={18} className="text-green-500" />,
    pdf: <IoDocumentText size={18} className="text-red-500" />,
    document: <IoDocumentText size={18} className="text-blue-500" />,
};

const FileInfoModal = ({ filePath, item, fileName, onClose }: FileInfoModalProps) => {
    const [info, setInfo] = useState<FileInfo | null>(null);
    const [pdf, setPdf] = useState<PdfInfo | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setInfo(null);
        setPdf(null);
        setError(null);
        const request = item
            ? invoke<FileInfo>("get_library_item_info", { kind: item.kind, id: item.id })
            : invoke<FileInfo>("get_file_info", { path: filePath });
        request
            .then((result) => {
                if (cancelled) return;
                setInfo(result);
                // From the resolved path, so a trashed PDF works the same as a live one.
                if (!result.folderStats && getFileCategory(fileName) === "pdf") {
                    readPdfInfo(result.path)
                        .then((pdfInfo) => {
                            if (!cancelled) setPdf(pdfInfo);
                        })
                        .catch((e) => console.warn("Could not read PDF metadata:", e));
                }
            })
            .catch((e) => {
                if (!cancelled) setError(String(e));
            });
        return () => {
            cancelled = true;
        };
    }, [filePath, item?.kind, item?.id, fileName]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const kindLabel = item ? ITEM_KIND_LABELS[item.kind] : null;
    const built = useMemo(
        () => (info ? buildSections(info, pdf, fileName, kindLabel) : null),
        [info, pdf, fileName, kindLabel],
    );

    const handleCopy = async () => {
        if (!built) return;
        const text = built.sections
            .map((s) => `${s.title}\n${s.rows.map((r) => `  ${r.label}: ${r.value}`).join("\n")}`)
            .join("\n\n");
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
        } catch {
            /* clipboard unavailable - everything is selectable on screen anyway */
        }
    };

    const openMap = (p: GeoPoint) =>
        void openExternal(`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=16/${p.lat}/${p.lon}`).catch((e) =>
            console.error("Failed to open map:", e),
        );

    return (
        <div
            className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/30 backdrop-blur-sm"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="w-[560px] max-w-[calc(100vw-32px)] max-h-[85vh] flex flex-col rounded-2xl bg-white dark:bg-neutral-900 shadow-[0_16px_48px_rgba(0,0,0,0.2)] ring-1 ring-black/[0.06] dark:ring-white/[0.08] overflow-hidden">
                <div className="flex items-center gap-2.5 px-5 py-4 border-b border-neutral-200 dark:border-neutral-800">
                    <IoInformationCircleOutline className="shrink-0 text-neutral-500 dark:text-neutral-400" size={18} />
                    <h2 className="text-[15px] font-semibold text-neutral-900 dark:text-neutral-100">File info</h2>
                    <div className="ml-auto flex items-center gap-1">
                        <button
                            type="button"
                            onClick={handleCopy}
                            disabled={!built}
                            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
                            title="Copy all details"
                        >
                            {copied ? <IoCheckmark size={14} className="text-green-600" /> : <IoCopyOutline size={14} />}
                            {copied ? "Copied" : "Copy"}
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                            title="Close"
                        >
                            <IoClose size={18} />
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-3 px-5 py-3.5 bg-neutral-50 dark:bg-neutral-800/40 border-b border-neutral-200 dark:border-neutral-800">
                    <div className="shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-white dark:bg-neutral-800 ring-1 ring-black/[0.06] dark:ring-white/[0.08]">
                        {item && item.kind !== "trash" ? (
                            <IoGridOutline size={18} className="text-violet-500" />
                        ) : (
                            CATEGORY_ICONS[getFileCategory(fileName) ?? "document"]
                        )}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate" title={fileName}>
                            {fileName}
                        </div>
                        <div className="text-xs text-neutral-500 dark:text-neutral-400">
                            {info ? formatFileSize(info.sizeBytes) : "Reading…"}
                            {info?.media?.durationSecs ? ` · ${formatDuration(info.media.durationSecs).replace(/\.\d+$/, "")}` : ""}
                        </div>
                    </div>
                    <button
                        type="button"
                        disabled={!info}
                        onClick={() => info && void invoke("open_file_from_directory", { filepath: info.path }).catch((e) => console.error(e))}
                        className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200/70 dark:hover:bg-neutral-700"
                        title="Show in folder"
                    >
                        <IoFolderOpenOutline size={14} />
                        Show in folder
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto px-5 py-4 select-text">
                    {error && (
                        <div className="rounded-lg bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 text-sm px-3 py-2">
                            Could not read file info: {error}
                        </div>
                    )}
                    {!info && !error && (
                        <div className="space-y-2 animate-pulse">
                            {Array.from({ length: 8 }).map((_, i) => (
                                <div key={i} className="h-4 rounded bg-neutral-100 dark:bg-neutral-800" style={{ width: `${60 + ((i * 37) % 35)}%` }} />
                            ))}
                        </div>
                    )}
                    {built?.sections.map((section) => (
                        <section key={section.title} className="mb-5 last:mb-0">
                            <div className="flex items-center gap-2 mb-1.5">
                                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                                    {section.title}
                                </h3>
                                {section.title === EMBEDDED_TITLE && section.rows.some((r) => r.notable) && (
                                    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                                        {section.rows.filter((r) => r.notable).length} to review
                                    </span>
                                )}
                                {section.title === "Location captured" && built.location && (
                                    <button
                                        type="button"
                                        onClick={() => openMap(built.location!)}
                                        className="ml-auto flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                                    >
                                        <IoLocationOutline size={13} />
                                        Open in map
                                        <IoOpenOutline size={11} />
                                    </button>
                                )}
                            </div>
                            <dl className="rounded-xl ring-1 ring-neutral-200 dark:ring-neutral-800 divide-y divide-neutral-100 dark:divide-neutral-800">
                                {section.rows.map((row, i) => (
                                    <div key={`${row.label}-${i}`} className="grid grid-cols-[150px_1fr] gap-3 px-3 py-2 text-[13px]">
                                        <dt className="flex items-start gap-1.5 text-neutral-500 dark:text-neutral-400">
                                            {row.notable && <span className="mt-[7px] shrink-0 w-1.5 h-1.5 rounded-full bg-amber-500" />}
                                            <span>{row.label}</span>
                                        </dt>
                                        <dd className="text-neutral-900 dark:text-neutral-100 break-words min-w-0">{row.value}</dd>
                                    </div>
                                ))}
                            </dl>
                            {section.footnote && (
                                <p className="mt-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">{section.footnote}</p>
                            )}
                        </section>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default FileInfoModal;
