// components/whiteboard/WhiteboardTable.tsx
//
// The live body of a "table" WhiteboardNode (see whiteboardTypes.ts's own doc comment on that
// shapeType) - a grid of cells with per-cell text, row/column resize, insert/delete, merge, and a
// spreadsheet-style right-click menu - mounted directly by WhiteboardCanvas.tsx in place of the
// usual shapeOutlineFor-driven body every other shapeType gets (same split "latticeGauge"/
// LatticeGaugeWidget.tsx already established: this file owns everything about how a table actually
// renders and is edited; WhiteboardStylePanel.tsx only adds/removes whole rows/columns at the END
// and the header-row toggle - see its own "table" Field block).
//
// Interaction model (deliberately two-step, same as most spreadsheet/table UIs): a plain click on
// the table when it ISN'T already selected behaves like clicking any other shape (falls through to
// WhiteboardCanvas.tsx's own onPointerDown, which selects/starts a move-drag) - a table doesn't
// intercept that first click. Only once the table IS selected does clicking/dragging over cells
// drill into it (stopPropagation'd here) to select a cell RANGE (a single cell, a dragged
// rectangle, a whole row/column via the small selector handles above/left of the grid, or - a
// mouse-drag alternative for cells that aren't adjacent to drag across - Ctrl+clicking a second
// cell to extend the range to the rectangle between it and whatever was clicked last) and, for a
// plain click, immediately start editing that one cell's text. Row/column divider drag-resize, the
// insert/delete "+"/"x" affordances, the row/column selector handles, and the right-click menu
// likewise only appear once selected, matching every other shape's own resize handles being
// selected-only. Ctrl+Enter (while editing a cell, or with a range selected) inserts a row right
// below it - the most common direction, kept as a single easy shortcut; Ctrl+ArrowUp/Down/Left/
// Right insert a row/column on that specific side instead, for full control over where the new one
// lands without needing the mouse (see insertRowWithCellText/insertColWithCellText's own doc
// comment).
//
// A selected RANGE (WhiteboardTable's own `range` state - never persisted, purely a live editing
// aid) is what the right-click menu and the table's own Ctrl+C/X/V/Delete keyboard shortcuts act
// on - a SEPARATE, cell-content-only clipboard from WhiteboardEditor.tsx's whole-node Ctrl+C/V
// (which copies/pastes entire WhiteboardNodes, tables included, onto the canvas). This file's own
// clipboard is a plain module-level variable rather than React state or a prop - it's meant to work
// like a real clipboard (copy cell text in one table, paste it into a DIFFERENT table instance),
// and unlike the node-level one it never needs to trigger a render or survive a page switch through
// anything other than "the module is still loaded", which is already guaranteed for the lifetime of
// the whiteboard editor being open.
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IoAddCircle, IoCloseCircle, IoEllipsisHorizontal, IoEllipsisVertical } from "react-icons/io5";
import {
  MIN_TABLE_CELL_FRACTION,
  MIN_TABLE_COLS,
  MIN_TABLE_ROWS,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  TableCellBorders,
  TableMergedCell,
  WhiteboardNode,
  adjustMergesForInsert,
  adjustMergesForRemove,
  insertTableFraction,
  removeTableFraction,
  resolveTableGrid,
} from "../../utils/whiteboardTypes";

export interface WhiteboardTableProps {
  node: WhiteboardNode;
  selected: boolean;
  // The whiteboard's own ambient zoom (WhiteboardCanvas.tsx's pan/zoom) - divides divider-drag
  // pointer deltas so resizing a row/column feels the same regardless of how zoomed-in the
  // surrounding diagram canvas happens to be, same "divide screen deltas by zoom" convention every
  // drag gesture in WhiteboardCanvas.tsx (and LatticeGaugeWidget.tsx's own orbit/pan) already follows.
  canvasZoom: number;
  // Persists one discrete change (a cell's committed text, a divider's final resting position, a
  // row/column insert/delete/merge) as a single ordinary node edit - WhiteboardCanvas.tsx wires
  // this to onEditNode(node, { ...node, ...patch }), the same commit path any other shape-specific
  // interaction (an amplifier's dragged lead, a plaquette pick) goes through, undo-tracked for free.
  onCommit: (patch: Partial<WhiteboardNode>) => void;
  // Reports this table's own currently-selected cell/row/column RANGE (or null once nothing's
  // selected) up to WhiteboardCanvas.tsx -> WhiteboardEditor.tsx -> WhiteboardStylePanel.tsx - the
  // style panel has no selection concept below "which whole node," so this is what lets its own
  // "Cell background"/per-side border-style controls (see whiteboardTypes.ts's withRangeFill/
  // withRangeBorderSide) know WHICH cells to act on. Purely a live UI concern, same "not persisted"
  // treatment every other transient selection/hover state in this file already gets.
  onRangeChange?: (range: { r0: number; c0: number; r1: number; c1: number } | null) => void;
}

// See this file's own top comment - a cell-content-only clipboard, deliberately module-level (not
// component state) so copy/cut in one table and paste into a different one just works.
let cellClipboard: string[][] | null = null;

// Cumulative boundary positions (in pixels) for a set of fractions over a `total` span - e.g.
// boundaries([0.2, 0.5, 0.3], 100) = [0, 20, 70, 100]. Length is always fractions.length + 1.
function boundaries(fractions: number[], total: number): number[] {
  const out = [0];
  let acc = 0;
  for (const f of fractions) {
    acc += f * total;
    out.push(acc);
  }
  return out;
}

// An inclusive rectangular block of cells, r0<=r1 and c0<=c1 always (see normalizeRange) - what's
// selected for the right-click menu and this table's own Ctrl+C/X/V/Delete shortcuts. A single cell
// is just r0===r1 && c0===c1; a whole row/column (from the selector handles) sets the other axis to
// the grid's own full 0..rows-1/0..cols-1 span.
interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}
function normalizeRange(a: { row: number; col: number }, b: { row: number; col: number }): CellRange {
  return { r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) };
}

// Plain data transforms for the table's own structural fields (rows/cols/fractions/cellText/
// merges) - a shared shape so a multi-row/column delete (several indices removed as one undo step,
// from the right-click menu) can apply the same single-index insert/remove logic repeatedly against
// a working copy and commit the FINAL result once, rather than needing its own separate one-shot
// math or (worse) issuing one onCommit per row, which would fragment one user action into several
// undo steps.
interface TableEditState {
  rows: number;
  cols: number;
  rowHeights: number[];
  colWidths: number[];
  cellText: string[][];
  mergedCells: TableMergedCell[];
  cellFill: (string | null)[][];
  cellBorders: TableCellBorders[][];
}
function withInsertedRow(state: TableEditState, afterIndex: number): TableEditState {
  const index = afterIndex + 1;
  const cellText = state.cellText.map((r) => [...r]);
  cellText.splice(index, 0, Array(state.cols).fill(""));
  const cellFill = state.cellFill.map((r) => [...r]);
  cellFill.splice(index, 0, Array(state.cols).fill(null));
  const cellBorders = state.cellBorders.map((r) => [...r]);
  cellBorders.splice(index, 0, Array.from({ length: state.cols }, () => ({})));
  return {
    ...state,
    rows: state.rows + 1,
    rowHeights: insertTableFraction(state.rowHeights, index),
    cellText,
    cellFill,
    cellBorders,
    mergedCells: adjustMergesForInsert(state.mergedCells, "row", index),
  };
}
function withInsertedCol(state: TableEditState, afterIndex: number): TableEditState {
  const index = afterIndex + 1;
  const cellText = state.cellText.map((row) => {
    const next = [...row];
    next.splice(index, 0, "");
    return next;
  });
  const cellFill = state.cellFill.map((row) => {
    const next = [...row];
    next.splice(index, 0, null);
    return next;
  });
  const cellBorders = state.cellBorders.map((row) => {
    const next = [...row];
    next.splice(index, 0, {});
    return next;
  });
  return {
    ...state,
    cols: state.cols + 1,
    colWidths: insertTableFraction(state.colWidths, index),
    cellText,
    cellFill,
    cellBorders,
    mergedCells: adjustMergesForInsert(state.mergedCells, "col", index),
  };
}
function withRemovedRow(state: TableEditState, index: number): TableEditState {
  return {
    ...state,
    rows: state.rows - 1,
    rowHeights: removeTableFraction(state.rowHeights, index),
    cellText: state.cellText.filter((_, r) => r !== index),
    cellFill: state.cellFill.filter((_, r) => r !== index),
    cellBorders: state.cellBorders.filter((_, r) => r !== index),
    mergedCells: adjustMergesForRemove(state.mergedCells, "row", index),
  };
}
function withRemovedCol(state: TableEditState, index: number): TableEditState {
  return {
    ...state,
    cols: state.cols - 1,
    colWidths: removeTableFraction(state.colWidths, index),
    cellText: state.cellText.map((row) => row.filter((_, c) => c !== index)),
    cellFill: state.cellFill.map((row) => row.filter((_, c) => c !== index)),
    cellBorders: state.cellBorders.map((row) => row.filter((_, c) => c !== index)),
    mergedCells: adjustMergesForRemove(state.mergedCells, "col", index),
  };
}

type DividerDrag = { kind: "col" | "row"; index: number; startClientPos: number; startFractions: number[] };

const AFFORDANCE_SIZE = 16;
const SELECTOR_SIZE = 14;

const WhiteboardTable: React.FC<WhiteboardTableProps> = ({ node, selected, canvasZoom, onCommit, onRangeChange }) => {
  const grid = resolveTableGrid(node);
  const headerRow = node.tableHeaderRow ?? true;
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editingText, setEditingText] = useState("");
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);
  const [liveColWidths, setLiveColWidths] = useState<number[] | null>(null);
  const [liveRowHeights, setLiveRowHeights] = useState<number[] | null>(null);
  const [range, setRange] = useState<CellRange | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<DividerDrag | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // The delete-row/delete-column button sits OUTSIDE the table's own box (negative left/top), past a
  // gap of a few pixels the cursor has to cross to reach it. The pointer leaves the cell (clearing
  // hoveredRow/hoveredCol, which is what makes the button render at all) the instant it crosses that
  // gap - well before it arrives at the button - so the button vanishes out from under a user
  // deliberately moving toward it to click it. A short grace-period timer instead of clearing
  // immediately gives the pointer time to cross the gap; entering a cell OR the button itself cancels
  // it (see cancelHoverClear/scheduleHoverClear below).
  const hoverClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverClear = () => {
    if (hoverClearTimerRef.current) {
      clearTimeout(hoverClearTimerRef.current);
      hoverClearTimerRef.current = null;
    }
  };
  const scheduleHoverClear = () => {
    cancelHoverClear();
    hoverClearTimerRef.current = setTimeout(() => {
      setHoveredRow(null);
      setHoveredCol(null);
    }, 300);
  };
  useEffect(() => cancelHoverClear, []);
  const rangeAnchorRef = useRef<{ row: number; col: number } | null>(null);
  const rangeDraggingRef = useRef(false);

  const colWidths = liveColWidths ?? grid.colWidths;
  const rowHeights = liveRowHeights ?? grid.rowHeights;
  const colBounds = boundaries(colWidths, node.width);
  const rowBounds = boundaries(rowHeights, node.height);

  // Anchor-cell lookup for merges (keyed "row-col") and the set of cells a merge COVERS but isn't
  // the anchor of - those render nothing of their own (see the render loop below), the same way a
  // spreadsheet's merged region is really just its top-left cell stretched over its neighbors.
  const mergeAt = new Map<string, TableMergedCell>();
  const covered = new Set<string>();
  for (const m of grid.mergedCells) {
    mergeAt.set(`${m.row}-${m.col}`, m);
    for (let rr = m.row; rr < m.row + m.rowSpan; rr++)
      for (let cc = m.col; cc < m.col + m.colSpan; cc++) if (!(rr === m.row && cc === m.col)) covered.add(`${rr}-${cc}`);
  }

  // A whole-node deselect (clicking elsewhere on the canvas) leaves no reason to keep a cell range
  // "selected" underneath it - matches every other shape's own selection-dependent chrome
  // (resize handles, etc.) disappearing the instant `selected` goes false.
  useEffect(() => {
    if (!selected) setRange(null);
  }, [selected]);

  // Clamps the current range whenever the table's own row/column count shrinks out from under it (a
  // delete-row/column, whether from the right-click menu or the per-row/column hover "x") - without
  // this, `range` could keep pointing at indices that no longer exist once rows/cols shrinks past
  // it, which every reader of the lifted-up range (WhiteboardStylePanel.tsx's own "Cell" background/
  // border-style controls chief among them) would then have to defend against forever instead of
  // this simply never happening.
  useEffect(() => {
    setRange((prev) => {
      if (!prev || (prev.r1 < grid.rows && prev.c1 < grid.cols)) return prev;
      const r1 = Math.min(prev.r1, grid.rows - 1);
      const c1 = Math.min(prev.c1, grid.cols - 1);
      return { r0: Math.min(prev.r0, r1), c0: Math.min(prev.c0, c1), r1, c1 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the counts matter here, not the
    // whole `grid` object (a fresh one every render would re-run this constantly for no reason).
  }, [grid.rows, grid.cols]);

  // Focuses the table's own wrapper whenever a MULTI-cell range becomes active outside of editing -
  // that's what lets this component's own onKeyDown (Ctrl+C/X/V, Delete, Escape - see the wrapper's
  // own handler below) actually receive those keys instead of the whiteboard's global ones (a plain
  // single-cell click still enters EDIT mode instead, per beginEditingCell, which grabs its own
  // contentEditable focus and needs no help from this).
  useEffect(() => {
    if (range && !editingCell && (range.r0 !== range.r1 || range.c0 !== range.c1)) wrapperRef.current?.focus();
  }, [range, editingCell]);

  // Reports the current range up to the style panel (see this prop's own doc comment) - every
  // change, including back to null once nothing's selected, so the panel's own "Cell" controls
  // disappear the instant there's nothing left for them to act on.
  useEffect(() => {
    onRangeChange?.(range);
  }, [range, onRangeChange]);

  // Ends a range drag-select no matter WHERE the pointer is released (even outside the table
  // entirely) - a plain per-cell onPointerUp would miss a release that happens past the table's own
  // edge, leaving the drag stuck "on" for every subsequent hover.
  useEffect(() => {
    const end = () => {
      rangeDraggingRef.current = false;
    };
    window.addEventListener("pointerup", end);
    return () => window.removeEventListener("pointerup", end);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  const commitCellText = (row: number, col: number, text: string) => {
    if (grid.cellText[row]?.[col] === text) return;
    const next = grid.cellText.map((r) => [...r]);
    next[row][col] = text;
    onCommit({ tableCellText: next });
  };

  const beginEditingCell = (row: number, col: number) => {
    setEditingCell({ row, col });
    setEditingText(grid.cellText[row][col]);
  };

  // Which cell (if any) to jump into next once the CURRENT cell's blur fires - set by Tab/Enter's
  // onKeyDown, consumed by onBlur below. Routing every commit-and-advance through an explicit
  // `.blur()` call (rather than committing AND calling setEditingCell directly from onKeyDown) is
  // deliberate, matching the plain per-node text editor's own Enter/Escape handling in
  // WhiteboardCanvas.tsx: it guarantees the commit happens exactly once. Committing directly from
  // onKeyDown while ALSO changing which cell is "active" would, on the next render, unmount this
  // contentEditable (its branch flips from editing to plain) - removing a still-focused element
  // fires a browser blur event of its own, which would run this same onBlur handler a SECOND time
  // against this cell's now-stale closure, double-committing (harmless in outcome since the text is
  // identical, but an extra, redundant undo step). Blurring first means the element is no longer
  // focused by the time React removes it, so that second blur never fires.
  const pendingNavRef = useRef<{ row: number; col: number } | null>(null);
  // Set right before a Ctrl+Enter-triggered column insert (see the cell editor's own onKeyDown
  // below) calls `.blur()` to end editing - that insert already commits the cell's own just-typed
  // text as PART of the combined "insert a column AND keep this text" patch (see
  // handleCtrlEnterInsertColumn), so the blur that follows must NOT ALSO run onCellEditorBlur's own
  // commitCellText: that would re-commit the SAME text against the now-stale pre-insertion `grid`
  // (captured in this render's closure), overwriting the just-inserted column's own freshly-sized
  // tableCellText with the old, one-column-shorter shape - exactly the kind of corrupted mismatch
  // resolveTableGrid's own defensive clamping exists to survive, but is much better avoided outright.
  const skipNextBlurCommitRef = useRef(false);

  // Focusing via the `autoFocus` prop is unreliable for a `contentEditable` div mounted from a
  // click handler (rather than initial page load) - browsers gate the native `autofocus` attribute
  // behind rules meant for page-load elements, so it can silently no-op here. Imperatively focusing
  // via this ref instead - the same fix WhiteboardCanvas.tsx's own per-node text editor already
  // uses for its own contentEditable - and selecting the cell's full existing text (ready to be
  // replaced by typing, same convention that editor's own double-click-to-edit follows).
  useEffect(() => {
    if (!editingCell) return;
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
  }, [editingCell]);

  const onCellEditorBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!editingCell) return;
    if (skipNextBlurCommitRef.current) {
      skipNextBlurCommitRef.current = false;
      setEditingCell(null);
      return;
    }
    commitCellText(editingCell.row, editingCell.col, e.currentTarget.innerText);
    const nav = pendingNavRef.current;
    pendingNavRef.current = null;
    if (nav && nav.row >= 0 && nav.row < grid.rows && nav.col >= 0 && nav.col < grid.cols) {
      setEditingCell(nav);
      setEditingText(grid.cellText[nav.row][nav.col]);
      setRange({ r0: nav.row, c0: nav.col, r1: nav.row, c1: nav.col });
    } else {
      setEditingCell(null);
    }
  };

  const beginDividerDrag = (e: React.PointerEvent, kind: "col" | "row", index: number) => {
    e.stopPropagation();
    // Only the PRIMARY (left) button starts an actual resize drag - same "don't let a right-click
    // trigger a left-click gesture" reasoning as the cell body's own onPointerDown (see its comment).
    // stopPropagation above still runs either way, so a right-click landing on this narrow strip
    // doesn't fall through to WhiteboardCanvas's own generic node context menu (its own onContextMenu
    // below handles that click cleanly instead).
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { kind, index, startClientPos: kind === "col" ? e.clientX : e.clientY, startFractions: kind === "col" ? grid.colWidths : grid.rowHeights };
  };

  const onDividerPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const total = drag.kind === "col" ? node.width : node.height;
    const clientPos = drag.kind === "col" ? e.clientX : e.clientY;
    const deltaFrac = (clientPos - drag.startClientPos) / canvasZoom / total;
    const next = [...drag.startFractions];
    // Dragging the divider AFTER `index` only ever trades size between that row/column and its
    // immediate neighbor - every other row/column stays exactly as-is, matching how dragging one
    // resize handle on a plain shape only ever affects that one box, not its neighbors.
    const a = next[drag.index] + deltaFrac;
    const b = next[drag.index + 1] - deltaFrac;
    if (a < MIN_TABLE_CELL_FRACTION || b < MIN_TABLE_CELL_FRACTION) return;
    next[drag.index] = a;
    next[drag.index + 1] = b;
    if (drag.kind === "col") setLiveColWidths(next);
    else setLiveRowHeights(next);
  };

  const endDividerDrag = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.kind === "col" && liveColWidths) onCommit({ tableColWidths: liveColWidths });
    if (drag.kind === "row" && liveRowHeights) onCommit({ tableRowHeights: liveRowHeights });
    setLiveColWidths(null);
    setLiveRowHeights(null);
  };

  const asEditState = (): TableEditState => ({
    rows: grid.rows,
    cols: grid.cols,
    rowHeights: grid.rowHeights,
    colWidths: grid.colWidths,
    cellText: grid.cellText,
    mergedCells: grid.mergedCells,
    cellFill: grid.cellFill,
    cellBorders: grid.cellBorders,
  });
  const commitEditState = (state: TableEditState) =>
    onCommit({
      tableRows: state.rows,
      tableCols: state.cols,
      tableRowHeights: state.rowHeights,
      tableColWidths: state.colWidths,
      tableCellText: state.cellText,
      tableMergedCells: state.mergedCells,
      tableCellFill: state.cellFill,
      tableCellBorders: state.cellBorders,
    });

  const insertRow = (afterIndex: number) => {
    if (grid.rows >= MAX_TABLE_ROWS) return;
    commitEditState(withInsertedRow(asEditState(), afterIndex));
  };
  const insertCol = (afterIndex: number) => {
    if (grid.cols >= MAX_TABLE_COLS) return;
    commitEditState(withInsertedCol(asEditState(), afterIndex));
  };
  // Ctrl+Enter/Ctrl+Arrow in the cell editor (see its own onKeyDown) - adds a row/column relative to
  // the cell being edited AND keeps whatever was just typed there, as one combined commit rather
  // than two separate ones: a plain `insertRow`/`insertCol` call right before blurring would still
  // be followed by the blur's OWN ordinary commitCellText call, which closes over THIS render's
  // `grid` - one row/column short of the array it would be writing into after the insert already
  // landed, corrupting the very commit that was supposed to preserve the text (see
  // skipNextBlurCommitRef's own doc comment, which callers of these must set before blurring).
  // Both return whether they actually committed - false (at MAX_TABLE_ROWS/COLS) means the caller
  // must NOT set skipNextBlurCommitRef, so the blur that follows still runs its own ordinary
  // commitCellText and the just-typed text isn't silently dropped on the floor.
  const insertRowWithCellText = (afterIndex: number, editRow: number, editCol: number, text: string): boolean => {
    if (grid.rows >= MAX_TABLE_ROWS) return false;
    const withText: TableEditState = { ...asEditState(), cellText: grid.cellText.map((row, r) => (r === editRow ? row.map((v, c) => (c === editCol ? text : v)) : row)) };
    commitEditState(withInsertedRow(withText, afterIndex));
    return true;
  };
  const insertColWithCellText = (afterIndex: number, editRow: number, editCol: number, text: string): boolean => {
    if (grid.cols >= MAX_TABLE_COLS) return false;
    const withText: TableEditState = { ...asEditState(), cellText: grid.cellText.map((row, r) => (r === editRow ? row.map((v, c) => (c === editCol ? text : v)) : row)) };
    commitEditState(withInsertedCol(withText, afterIndex));
    return true;
  };
  // Deletes several rows/columns at once (the right-click menu's "Delete Row(s)"/"Delete Column(s)"
  // over a multi-row/column range) as ONE undo step - applies withRemovedRow/Col repeatedly against
  // a working copy (highest index first, so removing one never shifts an index still waiting to be
  // removed) and commits only the final result, rather than one onCommit per row.
  const deleteRows = (indices: number[]) => {
    let state = asEditState();
    const sorted = [...indices].sort((a, b) => b - a);
    for (const i of sorted) {
      if (state.rows <= MIN_TABLE_ROWS) break;
      state = withRemovedRow(state, i);
    }
    commitEditState(state);
  };
  const deleteCols = (indices: number[]) => {
    let state = asEditState();
    const sorted = [...indices].sort((a, b) => b - a);
    for (const i of sorted) {
      if (state.cols <= MIN_TABLE_COLS) break;
      state = withRemovedCol(state, i);
    }
    commitEditState(state);
  };

  const handleMerge = () => {
    if (!range) return;
    const { r0, c0, r1, c1 } = range;
    if (r0 === r1 && c0 === c1) return;
    // A range that partially overlaps an existing merge first dissolves that merge, then the full
    // requested rectangle becomes one new merge - simplest well-defined behavior for an overlap
    // that could otherwise leave two merges illegally sharing a cell.
    const overlaps = (m: TableMergedCell) => !(m.col + m.colSpan <= c0 || m.col > c1 || m.row + m.rowSpan <= r0 || m.row > r1);
    const kept = grid.mergedCells.filter((m) => !overlaps(m));
    onCommit({ tableMergedCells: [...kept, { row: r0, col: c0, rowSpan: r1 - r0 + 1, colSpan: c1 - c0 + 1 }] });
    setRange({ r0, c0, r1: r0, c1: c0 });
  };
  const handleUnmerge = () => {
    if (!range) return;
    const merge = grid.mergedCells.find((m) => m.row === range.r0 && m.col === range.c0);
    if (!merge) return;
    onCommit({ tableMergedCells: grid.mergedCells.filter((m) => m !== merge) });
  };

  // The set of cells COVERED (not anchored) by any merge in `state` - shared by handleSplitRow/Col's
  // own "which OTHER rows/columns need a fresh re-merge" scan below, so it never proposes anchoring
  // a new merge on a row/column that's actually the covered half of some unrelated existing merge
  // (which would illegally overlap it).
  const coveredCellsOf = (mergedCells: TableMergedCell[]): Set<string> => {
    const set = new Set<string>();
    for (const m of mergedCells)
      for (let rr = m.row; rr < m.row + m.rowSpan; rr++)
        for (let cc = m.col; cc < m.col + m.colSpan; cc++) if (!(rr === m.row && cc === m.col)) set.add(`${rr}-${cc}`);
    return set;
  };

  // "Split Row"/"Split Column" - divides just the ONE selected cell into two, leaving every other
  // row/column showing exactly what it did before. On a cell already merged along that axis, this is
  // simply peeling one row/column back off the merge (the exact inverse of one "Merge Cells" step -
  // shrinks rather than dissolving the whole thing at once the way "Unmerge Cells" does). On a plain
  // cell there's no such merge to shrink - a row/column boundary is otherwise shared by the WHOLE
  // table (see this file's own top comment on the grid being uniform), so a real "just this cell"
  // split has to: insert a new row/column globally (which, unhandled, would add a visible row/column
  // to EVERY other cell too), then immediately re-merge every OTHER row's/column's own newly-doubled
  // cell back into one - net visible effect, only the selected cell gains a divider.
  const handleSplitRow = () => {
    if (!range) return;
    const merge = grid.mergedCells.find((m) => m.row === range.r0 && m.col === range.c0 && m.rowSpan > 1);
    if (merge) {
      const shrunk = { ...merge, rowSpan: merge.rowSpan - 1 };
      const kept = grid.mergedCells.filter((m) => m !== merge);
      onCommit({ tableMergedCells: shrunk.rowSpan > 1 || shrunk.colSpan > 1 ? [...kept, shrunk] : kept });
      return;
    }
    const r0 = range.r0;
    const c0 = range.c0;
    const state = withInsertedRow(asEditState(), r0);
    const covered = coveredCellsOf(state.mergedCells);
    const newMerges = [...state.mergedCells];
    // A candidate re-merge {r0,c,rowSpan:2,colSpan:1} is only safe to add if NO existing merge (an
    // unrelated one that happens to run through this exact row/column pair, not just one spanning
    // r0..r0+1 at exactly this column) already overlaps that same 2-row-by-1-column footprint - a
    // general rectangle-overlap test (same shape handleMerge's own overlap check uses) rather than a
    // narrower "does some merge span EXACTLY this boundary" heuristic, which missed some of the
    // shapes an existing merge can actually take and could leave two merges illegally claiming the
    // same cell (see resolveTableGrid's own defensive de-overlap doc comment for what that breaks).
    const overlapsExisting = (c: number): boolean => newMerges.some((m) => !(m.col + m.colSpan <= c || m.col > c || m.row + m.rowSpan <= r0 || m.row > r0 + 1));
    for (let c = 0; c < state.cols; c++) {
      if (c === c0 || covered.has(`${r0}-${c}`) || overlapsExisting(c)) continue;
      newMerges.push({ row: r0, col: c, rowSpan: 2, colSpan: 1 });
    }
    commitEditState({ ...state, mergedCells: newMerges });
  };
  const handleSplitCol = () => {
    if (!range) return;
    const merge = grid.mergedCells.find((m) => m.row === range.r0 && m.col === range.c0 && m.colSpan > 1);
    if (merge) {
      const shrunk = { ...merge, colSpan: merge.colSpan - 1 };
      const kept = grid.mergedCells.filter((m) => m !== merge);
      onCommit({ tableMergedCells: shrunk.rowSpan > 1 || shrunk.colSpan > 1 ? [...kept, shrunk] : kept });
      return;
    }
    const r0 = range.r0;
    const c0 = range.c0;
    const state = withInsertedCol(asEditState(), c0);
    const covered = coveredCellsOf(state.mergedCells);
    const newMerges = [...state.mergedCells];
    // See handleSplitRow's own doc comment on this same shape of check just above - a full
    // rectangle-overlap test against the candidate {r,c0,rowSpan:1,colSpan:2}, not a narrower
    // "spans exactly this boundary" heuristic.
    const overlapsExisting = (r: number): boolean => newMerges.some((m) => !(m.col + m.colSpan <= c0 || m.col > c0 + 1 || m.row + m.rowSpan <= r || m.row > r));
    for (let r = 0; r < state.rows; r++) {
      if (r === r0 || covered.has(`${r}-${c0}`) || overlapsExisting(r)) continue;
      newMerges.push({ row: r, col: c0, rowSpan: 1, colSpan: 2 });
    }
    commitEditState({ ...state, mergedCells: newMerges });
  };

  const copyRangeText = (r: CellRange): string[][] => {
    const out: string[][] = [];
    for (let row = r.r0; row <= r.r1; row++) {
      const line: string[] = [];
      for (let col = r.c0; col <= r.c1; col++) line.push(grid.cellText[row][col]);
      out.push(line);
    }
    return out;
  };
  const handleCopyCells = () => {
    if (range) cellClipboard = copyRangeText(range);
  };
  const handleCutCells = () => {
    if (!range) return;
    cellClipboard = copyRangeText(range);
    const next = grid.cellText.map((r) => [...r]);
    for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) next[r][c] = "";
    onCommit({ tableCellText: next });
  };
  const handlePasteCells = () => {
    if (!cellClipboard || !range) return;
    const next = grid.cellText.map((r) => [...r]);
    for (let dr = 0; dr < cellClipboard.length; dr++) {
      for (let dc = 0; dc < cellClipboard[dr].length; dc++) {
        const r = range.r0 + dr;
        const c = range.c0 + dc;
        if (r < grid.rows && c < grid.cols) next[r][c] = cellClipboard[dr][dc];
      }
    }
    onCommit({ tableCellText: next });
  };
  const clearRangeText = () => {
    if (!range) return;
    const next = grid.cellText.map((r) => [...r]);
    for (let r = range.r0; r <= range.r1; r++) for (let c = range.c0; c <= range.c1; c++) next[r][c] = "";
    onCommit({ tableCellText: next });
  };

  const beginRangeSelect = (row: number, col: number) => {
    rangeAnchorRef.current = { row, col };
    rangeDraggingRef.current = true;
    setRange({ r0: row, c0: col, r1: row, c1: col });
  };
  const extendRangeSelect = (row: number, col: number) => {
    if (!rangeDraggingRef.current || !rangeAnchorRef.current) return;
    setRange(normalizeRange(rangeAnchorRef.current, { row, col }));
  };

  return (
    <div
      ref={wrapperRef}
      tabIndex={-1}
      className="relative w-full h-full select-none"
      style={{ outline: "none", overflow: "visible" }}
      onPointerLeave={scheduleHoverClear}
      onKeyDown={(e) => {
        if (!range) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === "c") {
          e.preventDefault();
          e.stopPropagation();
          handleCopyCells();
        } else if (mod && e.key.toLowerCase() === "x") {
          e.preventDefault();
          e.stopPropagation();
          handleCutCells();
        } else if (mod && e.key.toLowerCase() === "v") {
          e.preventDefault();
          e.stopPropagation();
          handlePasteCells();
        } else if (mod && (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          // Same directional row/column insert as the cell editor's own Ctrl+Enter/Ctrl+Arrow (see
          // its doc comment) - this branch covers a RANGE that's selected but not currently being
          // edited (e.g. a whole row/column picked via its own selector handle, or a cell after
          // Escape). Extends outward from whichever edge of the selection matches the requested
          // direction - `range.r1`/`range.c1` (below/right) or `range.r0`/`range.c0` (above/left).
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "ArrowUp") insertRow(range.r0 - 1);
          else if (e.key === "ArrowLeft") insertCol(range.c0 - 1);
          else if (e.key === "ArrowRight") insertCol(range.c1);
          else insertRow(range.r1); // Enter or ArrowDown - below
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          e.stopPropagation();
          clearRangeText();
        } else if (e.key === "Escape") {
          e.stopPropagation();
          setRange(null);
        }
      }}
    >
      {/* Background fill, underneath the cell text/editing layer. */}
      <div className="absolute inset-0" style={{ backgroundColor: node.fillColor ?? "transparent" }} />
      {/* The table's own outer border, as a plain non-positioning overlay - drawn on a dedicated
          child rather than the wrapper itself (which hosts every absolutely-positioned cell/handle
          below) because a border on a positioned ancestor shifts where `top:0,left:0` lands for its
          own absolutely-positioned children by exactly the border's width (the CSS spec's
          containing block for those is the ancestor's PADDING edge, not its border edge) - every
          cell/divider/handle below assumes (0,0) is the table's true top-left, so the border has to
          live somewhere that doesn't move that origin. */}
      {node.strokeWidth > 0 && (
        <div className="absolute inset-0 pointer-events-none" style={{ border: `${node.strokeWidth}px solid ${node.strokeColor}`, boxSizing: "border-box" }} />
      )}
      {headerRow && grid.rows > 0 && (
        <div className="absolute pointer-events-none" style={{ left: 0, top: 0, width: node.width, height: rowBounds[1], backgroundColor: "rgba(0,0,0,0.06)" }} />
      )}

      {/* Cell text (and, for the active cell, its inline editor). Cells COVERED by a merge (but not
          its own anchor) render nothing - the anchor cell below is sized to span the whole merged
          region instead, borders and all, the same way a spreadsheet's merged block is really just
          its top-left cell stretched over its neighbors. */}
      {Array.from({ length: grid.rows }).map((_, r) =>
        Array.from({ length: grid.cols }).map((_, c) => {
          if (covered.has(`${r}-${c}`)) return null;
          const merge = mergeAt.get(`${r}-${c}`);
          const spanRows = merge?.rowSpan ?? 1;
          const spanCols = merge?.colSpan ?? 1;
          const left = colBounds[c];
          const top = rowBounds[r];
          const w = colBounds[c + spanCols] - left;
          const h = rowBounds[r + spanRows] - top;
          const isEditing = editingCell?.row === r && editingCell?.col === c;
          const isHeaderCell = headerRow && r === 0;
          const inRange = !!range && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1;
          const textStyle: React.CSSProperties = {
            color: node.fontColor,
            fontFamily: node.fontFamily,
            fontSize: node.fontSize,
            fontWeight: isHeaderCell ? "bold" : node.fontWeight,
            fontStyle: node.fontStyle,
            textDecoration: node.textDecoration,
            textAlign: node.textAlign,
          };
          // Per-side border, honoring this cell's own tableCellBorders override (see
          // whiteboardTypes.ts's own doc comment) where present, else falling back to the ordinary
          // uniform grid line - `hasDefaultLine` matches the pre-override behavior exactly (only an
          // INTERIOR right/bottom boundary gets a default per-cell line at all; the table's own
          // outer edges are the dedicated border overlay above, and top/left interior boundaries are
          // already drawn as the previous cell's own right/bottom) so a cell with no overrides at all
          // renders pixel-identical to before this feature existed.
          const cellBorderOverrides = grid.cellBorders[r][c];
          // A boundary between two cells has TWO owners - this cell's own bottom/right (the
          // "default" side, per the comment above) and the touching neighbor's top/left (override-
          // only). Setting an explicit style on the override-only side (e.g. "Top line: Dashed" in
          // the style panel) only ever touched THIS cell's own tableCellBorders entry - it never
          // suppressed the neighbor's still-perfectly-normal default solid line for that same
          // boundary, so both rendered stacked on top of each other (a solid line with a dashed one
          // right underneath - reported live by a user styling a cell's top border). Fixed by having
          // the default side check whether its neighbor already claims this boundary via an explicit
          // override before falling back to drawing its own default line.
          const neighborOverride = (nr: number, nc: number, side: "top" | "left"): string | null | undefined => {
            if (covered.has(`${nr}-${nc}`)) return undefined; // covered cell renders nothing of its own - ignore
            const o = grid.cellBorders[nr]?.[nc]?.[side];
            return o && o !== "solid" ? o : undefined;
          };
          const sideBorder = (side: "top" | "right" | "bottom" | "left", hasDefaultLine: boolean): string | undefined => {
            const override = cellBorderOverrides[side];
            if (override === "none") return "none";
            if (!override || override === "solid") {
              if (!hasDefaultLine) return undefined;
              if (side === "bottom" && neighborOverride(r + spanRows, c, "top")) return undefined;
              if (side === "right" && neighborOverride(r, c + spanCols, "left")) return undefined;
              return `${node.strokeWidth}px solid ${node.strokeColor}`;
            }
            return `${node.strokeWidth > 0 ? node.strokeWidth : 1}px ${override} ${node.strokeColor}`;
          };
          const cellFill = grid.cellFill[r][c];
          return (
            <div
              key={`${r}-${c}`}
              className="absolute overflow-hidden"
              style={{
                left,
                top,
                width: w,
                height: h,
                boxSizing: "border-box",
                backgroundColor: cellFill ?? undefined,
                borderTop: sideBorder("top", false),
                borderLeft: sideBorder("left", false),
                borderRight: sideBorder("right", c + spanCols < grid.cols && node.strokeWidth > 0),
                borderBottom: sideBorder("bottom", r + spanRows < grid.rows && node.strokeWidth > 0),
              }}
              onPointerEnter={() => {
                cancelHoverClear();
                setHoveredRow(r);
                setHoveredCol(c);
                extendRangeSelect(r, c);
              }}
              onPointerDown={(e) => {
                if (!selected || isEditing) return;
                e.stopPropagation();
                // Only the PRIMARY (left) button starts a range-select drag - a right-click firing
                // this too would collapse whatever range is already selected down to just this one
                // cell before its own onContextMenu handler (below) ever runs, making "drag-select a
                // block, then right-click inside it to act on the whole thing" impossible (a right-
                // click would always narrow to a single cell first). onContextMenu's own `!inRange`
                // check already handles narrowing the selection when the right-click lands OUTSIDE
                // whatever's currently selected - that's the only place this should happen.
                if (e.button !== 0) return;
                if (e.ctrlKey || e.metaKey) {
                  // Ctrl+click extends the CURRENT selection to the rectangle between whatever cell
                  // was last plainly clicked (the anchor - see beginRangeSelect) and this one,
                  // rather than starting a fresh drag from here - the same "click one cell, then
                  // Ctrl+click another to select the block between them" the rest of this app's own
                  // click-to-select-a-node convention doesn't otherwise offer for a table's own
                  // cells. Deliberately doesn't move the anchor itself, so a THIRD Ctrl+click still
                  // extends from the SAME original corner rather than the last-clicked cell -
                  // matches how Shift+Click range-extension works in spreadsheets generally, just
                  // bound to Ctrl here since Shift is already claimed elsewhere in this app (additive
                  // multi-NODE selection).
                  const anchor = rangeAnchorRef.current ?? { row: r, col: c };
                  rangeAnchorRef.current = anchor;
                  setRange(normalizeRange(anchor, { row: r, col: c }));
                  return;
                }
                beginRangeSelect(r, c);
              }}
              onClick={(e) => {
                if (!selected) return;
                e.stopPropagation();
                if (e.ctrlKey || e.metaKey) return; // handled by onPointerDown above - extends the selection rather than editing
                if (!isEditing) beginEditingCell(r, c);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!isEditing) beginEditingCell(r, c);
              }}
              onContextMenu={(e) => {
                if (!selected) return;
                e.preventDefault();
                e.stopPropagation();
                if (!inRange) setRange({ r0: r, c0: c, r1: r, c1: c });
                setContextMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              {inRange && !isEditing && <div className="absolute inset-0 pointer-events-none" style={{ backgroundColor: "rgba(37,99,235,0.15)" }} />}
              {isEditing ? (
                <div
                  ref={editorRef}
                  contentEditable
                  suppressContentEditableWarning
                  className="absolute inset-0 px-1.5 py-1 outline-none whitespace-pre-wrap break-words overflow-hidden flex"
                  style={{
                    ...textStyle,
                    alignItems: node.verticalAlign === "top" ? "flex-start" : node.verticalAlign === "bottom" ? "flex-end" : "center",
                    justifyContent: node.textAlign === "left" ? "flex-start" : node.textAlign === "right" ? "flex-end" : "center",
                    cursor: "text",
                    backgroundColor: "#ffffff",
                    boxShadow: "inset 0 0 0 2px #2563eb",
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  // Deliberately NOT wired to setEditingText on every keystroke: `editingText` state
                  // only seeds this div's INITIAL content when editing begins (see beginEditingCell /
                  // the Tab-nav branch above) - every actual read of the typed text (blur, Tab,
                  // Ctrl+Enter, Escape) already pulls live DOM via e.currentTarget.innerText. Feeding
                  // state back in as `{editingText}` children on every input would make React replace
                  // the text node on each keystroke, which resets the caret to offset 0 - so each new
                  // character gets typed before everything already there ("typing backward").
                  onBlur={onCellEditorBlur}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") {
                      e.preventDefault();
                      pendingNavRef.current = null;
                      (e.currentTarget as HTMLDivElement).blur();
                    } else if (e.key === "Tab") {
                      e.preventDefault();
                      const forward = !e.shiftKey;
                      const nextCol = c + (forward ? 1 : -1);
                      pendingNavRef.current = nextCol >= 0 && nextCol < grid.cols ? { row: r, col: nextCol } : { row: r + (forward ? 1 : -1), col: forward ? 0 : grid.cols - 1 };
                      (e.currentTarget as HTMLDivElement).blur();
                    } else if ((e.ctrlKey || e.metaKey) && (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
                      // Ctrl+Enter (or Ctrl+an arrow key, for full control over which side the new
                      // row/column lands on - Down/Enter = below, Up = above, Right = right, Left =
                      // left of the cell being edited) inserts a row/column right there, keeping
                      // whatever was just typed - see insertRowWithCellText/insertColWithCellText's
                      // own doc comment for why the text has to be folded into that one commit
                      // rather than left for this same blur's ordinary commit to pick up separately.
                      e.preventDefault();
                      pendingNavRef.current = null;
                      const text = (e.currentTarget as HTMLDivElement).innerText;
                      skipNextBlurCommitRef.current =
                        e.key === "ArrowUp"
                          ? insertRowWithCellText(r - 1, r, c, text)
                          : e.key === "ArrowLeft"
                          ? insertColWithCellText(c - 1, r, c, text)
                          : e.key === "ArrowRight"
                          ? insertColWithCellText(c, r, c, text)
                          : insertRowWithCellText(r, r, c, text); // Enter or ArrowDown - below
                      (e.currentTarget as HTMLDivElement).blur();
                    } else if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      pendingNavRef.current = { row: r + 1, col: c };
                      (e.currentTarget as HTMLDivElement).blur();
                    }
                  }}
                >
                  {editingText}
                </div>
              ) : (
                <div
                  className="absolute inset-0 px-1.5 py-1 flex whitespace-pre-wrap break-words pointer-events-none"
                  style={{
                    ...textStyle,
                    alignItems: node.verticalAlign === "top" ? "flex-start" : node.verticalAlign === "bottom" ? "flex-end" : "center",
                    justifyContent: node.textAlign === "left" ? "flex-start" : node.textAlign === "right" ? "flex-end" : "center",
                  }}
                >
                  {grid.cellText[r][c]}
                </div>
              )}
            </div>
          );
        })
      )}

      {selected && !editingCell && (
        <>
          {/* Row/column divider drag handles - thin strips straddling each internal grid line. */}
          {colBounds.slice(1, -1).map((x, i) => (
            <div
              key={`cd${i}`}
              onPointerDown={(e) => beginDividerDrag(e, "col", i)}
              onPointerMove={onDividerPointerMove}
              onPointerUp={endDividerDrag}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className="absolute"
              style={{ left: x - 4, top: 0, width: 8, height: node.height, cursor: "col-resize" }}
            />
          ))}
          {rowBounds.slice(1, -1).map((y, i) => (
            <div
              key={`rd${i}`}
              onPointerDown={(e) => beginDividerDrag(e, "row", i)}
              onPointerMove={onDividerPointerMove}
              onPointerUp={endDividerDrag}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              className="absolute"
              style={{ left: 0, top: y - 4, width: node.width, height: 8, cursor: "row-resize" }}
            />
          ))}

          {/* Column/row SELECTOR handles - a small icon past the end of each column (above the
              table) / each row (left of the table) that selects that whole column/row when
              clicked, the same "click a spreadsheet's own column/row header" convention. */}
          {colBounds.slice(0, -1).map((x, c) => {
            const w = colBounds[c + 1] - x;
            const isActive = !!range && range.r0 === 0 && range.r1 === grid.rows - 1 && c >= range.c0 && c <= range.c1;
            return (
              <button
                key={`csel${c}`}
                type="button"
                title="Select column"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setRange({ r0: 0, c0: c, r1: grid.rows - 1, c1: c });
                }}
                className={`absolute flex items-center justify-center rounded-sm ${isActive ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-500 hover:bg-blue-100 hover:text-blue-700"}`}
                style={{ left: x + w / 2 - SELECTOR_SIZE / 2, top: -SELECTOR_SIZE - 22, width: SELECTOR_SIZE, height: SELECTOR_SIZE }}
              >
                <IoEllipsisHorizontal size={SELECTOR_SIZE * 0.8} />
              </button>
            );
          })}
          {rowBounds.slice(0, -1).map((y, r) => {
            const h = rowBounds[r + 1] - y;
            const isActive = !!range && range.c0 === 0 && range.c1 === grid.cols - 1 && r >= range.r0 && r <= range.r1;
            return (
              <button
                key={`rsel${r}`}
                type="button"
                title="Select row"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setRange({ r0: r, c0: 0, r1: r, c1: grid.cols - 1 });
                }}
                className={`absolute flex items-center justify-center rounded-sm ${isActive ? "bg-blue-600 text-white" : "bg-gray-200 text-gray-500 hover:bg-blue-100 hover:text-blue-700"}`}
                style={{ left: -SELECTOR_SIZE - 22, top: y + h / 2 - SELECTOR_SIZE / 2, width: SELECTOR_SIZE, height: SELECTOR_SIZE }}
              >
                <IoEllipsisVertical size={SELECTOR_SIZE * 0.8} />
              </button>
            );
          })}

          {/* Insert-at-end affordances. */}
          <button
            type="button"
            title="Add column"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              insertCol(grid.cols - 1);
            }}
            className="absolute flex items-center justify-center text-blue-600 bg-white rounded-full hover:text-blue-800"
            style={{ left: node.width + 4, top: node.height / 2 - AFFORDANCE_SIZE / 2, width: AFFORDANCE_SIZE, height: AFFORDANCE_SIZE }}
          >
            <IoAddCircle size={AFFORDANCE_SIZE} />
          </button>
          <button
            type="button"
            title="Add row"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              insertRow(grid.rows - 1);
            }}
            className="absolute flex items-center justify-center text-blue-600 bg-white rounded-full hover:text-blue-800"
            style={{ left: node.width / 2 - AFFORDANCE_SIZE / 2, top: node.height + 4, width: AFFORDANCE_SIZE, height: AFFORDANCE_SIZE }}
          >
            <IoAddCircle size={AFFORDANCE_SIZE} />
          </button>

          {/* Per-row/per-column delete, shown only while hovering that row/column and only when
              doing so wouldn't empty the table entirely. Pushed further out than the selector
              handles above so the two don't overlap. */}
          {hoveredRow !== null && grid.rows > MIN_TABLE_ROWS && (
            <button
              type="button"
              title="Delete row"
              onPointerEnter={cancelHoverClear}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                deleteRows([hoveredRow]);
                setHoveredRow(null);
              }}
              className="absolute flex items-center justify-center text-red-500 bg-white rounded-full hover:text-red-700"
              style={{
                left: -SELECTOR_SIZE - AFFORDANCE_SIZE - 30,
                top: (rowBounds[hoveredRow] + rowBounds[hoveredRow + 1]) / 2 - AFFORDANCE_SIZE / 2,
                width: AFFORDANCE_SIZE,
                height: AFFORDANCE_SIZE,
              }}
            >
              <IoCloseCircle size={AFFORDANCE_SIZE} />
            </button>
          )}
          {hoveredCol !== null && grid.cols > MIN_TABLE_COLS && (
            <button
              type="button"
              title="Delete column"
              onPointerEnter={cancelHoverClear}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                deleteCols([hoveredCol]);
                setHoveredCol(null);
              }}
              className="absolute flex items-center justify-center text-red-500 bg-white rounded-full hover:text-red-700"
              style={{
                left: (colBounds[hoveredCol] + colBounds[hoveredCol + 1]) / 2 - AFFORDANCE_SIZE / 2,
                top: -SELECTOR_SIZE - AFFORDANCE_SIZE - 30,
                width: AFFORDANCE_SIZE,
                height: AFFORDANCE_SIZE,
              }}
            >
              <IoCloseCircle size={AFFORDANCE_SIZE} />
            </button>
          )}
        </>
      )}

      {contextMenu &&
        range &&
        createPortal(
          <TableContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            range={range}
            grid={grid}
            onClose={() => setContextMenu(null)}
            onInsertRowAbove={() => insertRow(range.r0 - 1)}
            onInsertRowBelow={() => insertRow(range.r1)}
            onInsertColLeft={() => insertCol(range.c0 - 1)}
            onInsertColRight={() => insertCol(range.c1)}
            onDeleteRows={() => deleteRows(Array.from({ length: range.r1 - range.r0 + 1 }, (_, i) => range.r0 + i))}
            onDeleteCols={() => deleteCols(Array.from({ length: range.c1 - range.c0 + 1 }, (_, i) => range.c0 + i))}
            onMerge={handleMerge}
            onUnmerge={handleUnmerge}
            onSplitRow={handleSplitRow}
            onSplitCol={handleSplitCol}
            onCut={handleCutCells}
            onCopy={handleCopyCells}
            onPaste={handlePasteCells}
            canPaste={cellClipboard !== null}
          />,
          document.body
        )}
    </div>
  );
};

// The right-click menu itself - rendered via a portal (document.body) since this table's own DOM
// sits inside WhiteboardCanvas.tsx's zoomed/panned/possibly-rotated node layer, and a `transform`
// on any ancestor makes `position: fixed` resolve against THAT ancestor instead of the real
// viewport (the same reason WhiteboardEditor.tsx's own node/edge right-click menu is portal-rendered
// - see its own context-menu doc comment). `x`/`y` are the click's own viewport (client) coordinates.
function TableContextMenu({
  x,
  y,
  range,
  grid,
  onClose,
  onInsertRowAbove,
  onInsertRowBelow,
  onInsertColLeft,
  onInsertColRight,
  onDeleteRows,
  onDeleteCols,
  onMerge,
  onUnmerge,
  onSplitRow,
  onSplitCol,
  onCut,
  onCopy,
  onPaste,
  canPaste,
}: {
  x: number;
  y: number;
  range: CellRange;
  grid: ReturnType<typeof resolveTableGrid>;
  onClose: () => void;
  onInsertRowAbove: () => void;
  onInsertRowBelow: () => void;
  onInsertColLeft: () => void;
  onInsertColRight: () => void;
  onDeleteRows: () => void;
  onDeleteCols: () => void;
  onMerge: () => void;
  onUnmerge: () => void;
  onSplitRow: () => void;
  onSplitCol: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  canPaste: boolean;
}) {
  const isMultiCell = range.r0 !== range.r1 || range.c0 !== range.c1;
  const rowCount = range.r1 - range.r0 + 1;
  const colCount = range.c1 - range.c0 + 1;
  const anchorMerge = grid.mergedCells.find((m) => m.row === range.r0 && m.col === range.c0);
  const isMerged = !!anchorMerge;
  // Split only makes sense for ONE logical cell - a plain unmerged cell, or a selection that
  // exactly matches an existing merge's own footprint (right-clicking IT, not some other arbitrary
  // multi-cell range that happens to overlap it).
  const isSingleLogicalCell = !isMultiCell || (isMerged && anchorMerge!.rowSpan === rowCount && anchorMerge!.colSpan === colCount);
  const item = (label: string, onClick: () => void, disabled?: boolean) => (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
        onClose();
      }}
      className="w-full text-left px-3 py-1.5 text-xs text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {label}
    </button>
  );
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 w-52 bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg py-1"
      style={{ left: Math.min(x, window.innerWidth - 216), top: Math.min(y, window.innerHeight - 320) }}
    >
      {item("Insert Row Above", onInsertRowAbove, grid.rows >= MAX_TABLE_ROWS)}
      {item("Insert Row Below", onInsertRowBelow, grid.rows >= MAX_TABLE_ROWS)}
      {item("Insert Column Left", onInsertColLeft, grid.cols >= MAX_TABLE_COLS)}
      {item("Insert Column Right", onInsertColRight, grid.cols >= MAX_TABLE_COLS)}
      <div className="my-1 border-t border-gray-100 dark:border-neutral-700/70" />
      {item(rowCount > 1 ? `Delete ${rowCount} Rows` : "Delete Row", onDeleteRows, grid.rows - rowCount < MIN_TABLE_ROWS)}
      {item(colCount > 1 ? `Delete ${colCount} Columns` : "Delete Column", onDeleteCols, grid.cols - colCount < MIN_TABLE_COLS)}
      <div className="my-1 border-t border-gray-100 dark:border-neutral-700/70" />
      {item("Merge Cells", onMerge, !isMultiCell)}
      {item("Unmerge Cells", onUnmerge, !isMerged)}
      {item("Split Row", onSplitRow, !isSingleLogicalCell || (grid.rows >= MAX_TABLE_ROWS && !(isMerged && anchorMerge!.rowSpan > 1)))}
      {item("Split Column", onSplitCol, !isSingleLogicalCell || (grid.cols >= MAX_TABLE_COLS && !(isMerged && anchorMerge!.colSpan > 1)))}
      <div className="my-1 border-t border-gray-100 dark:border-neutral-700/70" />
      {item("Cut", onCut)}
      {item("Copy", onCopy)}
      {item("Paste", onPaste, !canPaste)}
    </div>
  );
}

export default WhiteboardTable;
