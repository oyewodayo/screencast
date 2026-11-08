// utils/spriteTrack.ts
//
// A layer that's a handful of small pictures shown one after another at changing places - the
// pointer (a few cursor looks at a few sub-pixel phases), its click ripples (one ring animation),
// the keyboard-shortcut chips. The editor paints every distinct picture once, with the same code
// the preview paints with, and export_trimmed_video (SpriteTrack, conversion.rs) shows them:
// an ffconcat list of the pictures (each held until the next run) overlaid at a position that is a
// piecewise-constant expression of time. Nothing is rendered per frame, however long the video.
//
// Runs change only on cell boundaries the caller picks between frames (half a cell before each
// sample), so a frame never sits on a boundary where the picture and its position could disagree.

export interface SpriteTrackSpec {
  // PNG data URLs, every one exactly width x height.
  sprites: string[];
  width: number;
  height: number;
  // [from (seconds), sprite index or -1 for nothing, x, y] - sorted; each holds until the next.
  runs: [number, number, number, number][];
  // Where the last run ends.
  end: number;
}

// Paints one sprite on a transparent canvas of exactly w x h.
export function encodeSprite(w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): string {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(w));
  canvas.height = Math.max(2, Math.round(h));
  const ctx = canvas.getContext("2d");
  if (ctx) paint(ctx);
  return canvas.toDataURL("image/png");
}

// Per-cell contents (null: nothing shown) as runs, cell i starting at cellStart(i). A cell showing
// nothing keeps the last position, so the position only changes when something visible moves.
export function runsFromCells(cells: ({ sprite: number; x: number; y: number } | null)[], cellStart: (i: number) => number): [number, number, number, number][] {
  const runs: [number, number, number, number][] = [];
  let x = 0;
  let y = 0;
  let prev = "";
  cells.forEach((c, i) => {
    const sprite = c ? c.sprite : -1;
    if (c) {
      x = c.x;
      y = c.y;
    }
    const key = `${sprite}|${x}|${y}`;
    if (key === prev) return;
    prev = key;
    runs.push([Number(cellStart(i).toFixed(6)), sprite, x, y]);
  });
  return runs;
}
