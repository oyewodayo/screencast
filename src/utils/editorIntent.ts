// utils/editorIntent.ts
//
// What the Video Editor's home asked for when it opened a video from one of its starters ("Vertical
// for TikTok & Reels", "Split screen", "Make Shorts"): held here until the editor has loaded that
// video and knows its frame, then taken - once - by the timeline (VideoTimelineDocker), which sets
// it up: the canvas chosen, the split-screen panel or Shorts opened.
export interface EditorIntent {
  // A canvas preset id (canvasFormats.ts) to start in.
  canvas?: string;
  // Open the split-screen panel.
  split?: boolean;
  // Open Shorts.
  shorts?: boolean;
}

let pending: { path: string; intent: EditorIntent } | null = null;

export const setEditorIntent = (path: string, intent: EditorIntent | undefined) => {
  pending = intent && Object.keys(intent).length > 0 ? { path, intent } : null;
};

// The intent for `path`, if one is waiting - and it's gone after this.
export const takeEditorIntent = (path: string): EditorIntent | null => {
  if (!pending || pending.path !== path) return null;
  const { intent } = pending;
  pending = null;
  return intent;
};
