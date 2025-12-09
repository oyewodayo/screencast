export function formatFileName(name: string, maxLength: number = 22): string {
  const parts: string[] = name.split('.');
  const hasExtension: boolean = parts.length > 1;
  const icon: string = hasExtension ? getFileIcon(name) : "📄";
  
  if (name.length <= maxLength) {
    return `${icon} ${name}`;
  }
  
  const extension: string = hasExtension ? `.${parts.pop()}` : '';
  const baseName: string = parts.join('.');
  const truncatedBase: string = baseName.substring(0, maxLength - extension.length - 3) + '..';
  
  return `${icon} ${truncatedBase}${extension}`;
}



export const getFileIcon = (filename: string) => {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  if (["jpg", "jpeg", "png", "gif", "bmp", "tiff", "webp"].includes(ext)) return "🖼️";
  if (["mp3", "wav", "aac", "flac", "ogg", "m4a"].includes(ext)) return "🎵";
  if (["mp4", "mov", "avi", "mkv", "webm", "wmv"].includes(ext)) return "🎬";
  return "📄";
};

