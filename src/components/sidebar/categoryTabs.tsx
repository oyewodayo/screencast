// components/sidebar/categoryTabs.tsx
//
// The sidebar's file-category tabs, each with its icon - also the icon a file row of that kind
// shows (Dashboard's categoryIcon).
import React from "react";
import { IoDocumentText, IoImage, IoMusicalNotes, IoVideocam } from "react-icons/io5";
import { MdOutlineDescription } from "react-icons/md";
import type { FileCategory } from "../../utils/fileCategory";

export const FILE_CATEGORY_TABS: { category: FileCategory; label: string; icon: React.ReactNode }[] = [
  { category: "video", label: "Video", icon: <IoVideocam size={18} /> },
  { category: "audio", label: "Audio", icon: <IoMusicalNotes size={18} /> },
  { category: "image", label: "Image", icon: <IoImage size={18} /> },
  { category: "pdf", label: "Pdf", icon: <IoDocumentText size={18} /> },
  { category: "document", label: "Documents", icon: <MdOutlineDescription size={18} /> },
];
