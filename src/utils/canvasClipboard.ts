// utils/canvasClipboard.ts
//
// Shared OS-clipboard plumbing for the two canvas editors (whiteboard, mindmap). Copy and paste go
// through the native `copy`/`paste` events rather than a Ctrl+C/Ctrl+V keydown handler, because only
// those events carry clipboardData - a keydown that calls preventDefault() on Ctrl+V suppresses the
// paste event entirely, which is exactly what used to stop a Print Screen capture from pasting.
//
// Copying shapes still keeps the shapes themselves in an in-memory ref (they reference per-document
// assets, so they can't meaningfully leave the app), but the copy event ALSO writes a private marker
// type to the OS clipboard. That marker is what lets one paste handler decide what the user meant:
// if the marker is still there, nothing newer has been copied since and the shapes win; if a
// screenshot or some text has been copied after it, the OS clipboard has replaced the marker and
// that newer content wins - the same "last thing copied is what pastes" rule every other app follows.

export type CanvasPastePayload =
  | { kind: "internal" }
  | { kind: "images"; files: File[] }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export function isTypingInField(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA");
}

// Replaces the OS clipboard contents with this editor's private marker. Call from a `copy` event
// handler, only once the editor has actually copied something.
export function writeInternalMarker(e: ClipboardEvent, markerType: string): void {
  if (!e.clipboardData) return;
  e.clipboardData.setData(markerType, "1");
  e.preventDefault();
}

export function readPastePayload(e: ClipboardEvent, markerType: string): CanvasPastePayload {
  const data = e.clipboardData;
  if (!data) return { kind: "empty" };
  if (Array.from(data.types).includes(markerType)) return { kind: "internal" };
  const files = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((f): f is File => f !== null);
  if (files.length > 0) return { kind: "images", files };
  const text = data.getData("text/plain");
  if (text.trim()) return { kind: "text", text: text.replace(/\r\n/g, "\n").trim() };
  return { kind: "empty" };
}

let measureCtx: CanvasRenderingContext2D | null = null;
// Rough rendered size of a block of plain text, used to give a pasted text node a box that fits it
// instead of a fixed default the user has to resize by hand.
export function measureTextBlock(text: string, fontPx: number, bold = false): { width: number; height: number } {
  const lines = text.split("\n");
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return { width: Math.max(...lines.map((l) => l.length)) * fontPx * 0.6, height: lines.length * fontPx * 1.3 };
  measureCtx.font = `${bold ? "700 " : ""}${fontPx}px system-ui, sans-serif`;
  const width = Math.max(...lines.map((l) => measureCtx!.measureText(l).width));
  return { width, height: lines.length * fontPx * 1.3 };
}
