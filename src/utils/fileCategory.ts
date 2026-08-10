// utils/fileCategory.ts
//
// Single source of truth for "what kind of file is this" by extension. Shared by the sidebar's
// per-type tabs/filtering (Dashboard.tsx) and the conversion dialog's format list
// (ConversionDialog.tsx) so the two can never drift out of sync the way they used to — the
// dialog previously only checked "is this an image", and treated literally everything else
// (audio, PDF) as video, offering MP4/MOV/MKV/AVI/WebM output for files that aren't video at all.

export type FileCategory = "video" | "audio" | "image" | "pdf" | "document";

export const FILE_CATEGORY_EXTENSIONS: Record<FileCategory, string[]> = {
  video: ["mp4", "mov", "avi", "mkv", "webm", "wmv"],
  audio: ["mp3", "wav", "aac", "flac", "ogg", "m4a"],
  image: ["jpg", "jpeg", "png", "gif", "bmp", "tiff"],
  pdf: ["pdf"],
  // What Docs' export feature (DocsEditor.tsx's Export menu) writes into the Briefcast root -
  // docx/md/txt have no inline previewer (unlike pdf/image/video), so Dashboard.tsx falls back to
  // an "open with default app" panel for this category instead of rendering one.
  document: ["docx", "md", "txt"],
};

export const getFileExtension = (fileName: string): string => fileName.split(".").pop()?.toLowerCase() ?? "";

export const getFileCategory = (fileName: string): FileCategory | null => {
  const ext = getFileExtension(fileName);
  const match = (Object.entries(FILE_CATEGORY_EXTENSIONS) as [FileCategory, string[]][]).find(([, exts]) => exts.includes(ext));
  return match ? match[0] : null;
};

// PDFs have no ffmpeg-backed conversion path (there's nothing to transcode them to), so "Convert"
// only ever makes sense for the three media categories. Both Dashboard.tsx (to decide whether to
// show the "Convert" menu item at all) and ConversionDialog.tsx (to pick a format list/profile)
// key off this same check, so a category can't show the option in one place but not the other.
export const CONVERTIBLE_CATEGORIES: readonly FileCategory[] = ["video", "audio", "image"];

export const isConvertibleCategory = (category: FileCategory | null): category is "video" | "audio" | "image" =>
  category !== null && (CONVERTIBLE_CATEGORIES as readonly FileCategory[]).includes(category);
