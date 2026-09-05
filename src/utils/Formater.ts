export function formatFileName(name: string, maxLength: number = 22): string {
  const icon: string = getFileIcon(name);
  return `${icon} ${truncateFileName(name, maxLength)}`;
}

// Same truncation as formatFileName, minus the emoji - for anywhere a real icon or thumbnail
// element already sits next to the name (the sidebar file row, the image gallery's caption, the
// "Now open" banner), where formatFileName's emoji would just be a second, redundant icon.
export function truncateFileName(name: string, maxLength: number = 22): string {
  if (name.length <= maxLength) return name;

  const parts: string[] = name.split('.');
  const hasExtension: boolean = parts.length > 1;
  const extension: string = hasExtension ? `.${parts.pop()}` : '';
  const baseName: string = parts.join('.');
  const truncatedBase: string = baseName.substring(0, maxLength - extension.length - 3) + '..';

  return `${truncatedBase}${extension}`;
}



// Human-readable file size for a gallery tile's size label (e.g. "4.2 MB") - binary (1024-based)
// units to match what Windows/macOS file managers already show for the same file.
export function formatFileSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exponent);
  return `${exponent === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

export const getFileIcon = (filename: string) => {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (["jpg", "jpeg", "png", "gif", "bmp", "tiff", "webp", "heic", "heif"].includes(ext)) return "🖼️";
  if (["mp3", "wav", "aac", "flac", "ogg", "m4a"].includes(ext)) return "🎵";
  if (["mp4", "mov", "avi", "mkv", "webm", "wmv"].includes(ext)) return "🎬";
  return "📄";
};

