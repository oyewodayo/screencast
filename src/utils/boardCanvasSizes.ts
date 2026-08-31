// utils/boardCanvasSizes.ts
//
// Named canvas-size presets - the pixel dimensions social platforms actually crop/display at, so
// picking "Instagram Story" instead of typing 1080x1920 by hand also means the export comes out at
// a size that platform won't silently recompress or letterbox. Grouped by shape (Square & Feed /
// Story & Reel / Web & Print) since that's how a user actually decides which one they want - "I need
// something tall" narrows the list faster than an alphabetical platform-name list would. Used both
// by BoardEditor.tsx's in-editor "Size" toolbar menu (setCanvasSize on an existing board) and
// BoardHome.tsx's "New board" popover (baked into the freshly-created board's initial canvasWidth/
// canvasHeight, paired with a BoardTemplate's own background/padding choice).
export interface BoardSizePreset {
  id: string;
  label: string;
  width: number;
  height: number;
  group: "Square & Feed" | "Story & Reel" | "Web & Print";
}

export const BOARD_SIZE_PRESETS: BoardSizePreset[] = [
  { id: "ig-post", label: "Instagram Post", width: 1080, height: 1080, group: "Square & Feed" },
  { id: "ig-portrait", label: "Instagram Portrait", width: 1080, height: 1350, group: "Square & Feed" },
  { id: "fb-post", label: "Facebook Post", width: 1200, height: 630, group: "Square & Feed" },

  { id: "ig-story", label: "Instagram Story / Reel", width: 1080, height: 1920, group: "Story & Reel" },
  { id: "tiktok", label: "TikTok Video", width: 1080, height: 1920, group: "Story & Reel" },
  { id: "pinterest-pin", label: "Pinterest Pin", width: 1000, height: 1500, group: "Story & Reel" },

  { id: "twitter-post", label: "X (Twitter) Post", width: 1600, height: 900, group: "Web & Print" },
  { id: "linkedin-post", label: "LinkedIn Post", width: 1200, height: 627, group: "Web & Print" },
  { id: "fb-cover", label: "Facebook Cover", width: 1640, height: 856, group: "Web & Print" },
  { id: "youtube-thumb", label: "YouTube Thumbnail", width: 1280, height: 720, group: "Web & Print" },
  { id: "a4-print", label: "A4 Print (150dpi)", width: 1240, height: 1754, group: "Web & Print" },
];

export const BOARD_SIZE_PRESET_GROUPS: BoardSizePreset["group"][] = ["Square & Feed", "Story & Reel", "Web & Print"];
