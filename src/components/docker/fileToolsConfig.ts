// components/docker/fileToolsConfig.ts
import { FileCategory } from "../../utils/fileCategory";

// One entry per category, describing what FileToolsDocker's category-specific corner should say.
// Growing a category from "here's some info + convert/rename/delete" into real editing controls
// (trim, speed, extract audio, crop, ...) means adding that UI inside FileToolsDocker's render —
// this config only covers the heading/blurb, so it stays a one-line change as the real tools grow.
export interface FileToolsCopy {
  heading: string;
  blurb: string;
}

export const FILE_TOOLS_COPY: Record<FileCategory, FileToolsCopy> = {
  video: { heading: "Video tools", blurb: "More editing tools (trim, speed, extract audio) are coming here." },
  audio: { heading: "Audio tools", blurb: "More editing tools (trim, fade, normalize) are coming here." },
  image: { heading: "Image tools", blurb: "More editing tools (crop, rotate, resize) are coming here." },
  pdf: { heading: "PDF tools", blurb: "Use the pen, highlighter, text, and outline tools in the toolbar above." },
};
