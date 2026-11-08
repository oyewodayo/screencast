// utils/libraryEntries.ts
//
// The library as the sidebar and the pages around it see it: a file entry, a trashed item, the
// sidebar's tabs and which of them have a folder gallery. Shared by Dashboard and the components
// split out of it (components/sidebar), so none of them reaches into another for a type.
import type { FileCategory } from "./fileCategory";

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  // ms since epoch, when the listing knows it.
  modified?: number;
}

export interface TrashEntry {
  trashed_name: string;
  name: string;
  original_path: string;
  deleted_at: number; // unix seconds
}

export type SidebarTab = FileCategory | "trash";

// Categories with a folder-click grid view (ImageFolderGallery/VideoFolderGallery/
// PdfFolderGallery/DocumentFolderGallery) - audio doesn't have one yet. Centralized so adding a
// category's gallery later is a one-line change here instead of hunting down every
// activeFileCategory === "x" || activeFileCategory === "y" check this gates.
export const GALLERY_CATEGORIES: readonly SidebarTab[] = ["image", "video", "pdf", "document"];

export const formatDeletedAt = (unixSeconds: number): string => {
  const diffDays = Math.floor((Date.now() - unixSeconds * 1000) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "1 day ago";
  return `${diffDays} days ago`;
};
