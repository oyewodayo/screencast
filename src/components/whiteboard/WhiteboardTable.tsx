// components/whiteboard/WhiteboardTable.tsx
//
// The live body of a "table" WhiteboardNode (see whiteboardTypes.ts's own doc comment on that
// shapeType) - a grid of cells with per-cell text, row/column resize, and insert/delete, mounted
// directly by WhiteboardCanvas.tsx in place of the usual shapeOutlineFor-driven body every other
// shapeType gets (same split "latticeGauge"/LatticeGaugeWidget.tsx already established: this file
// owns everything about how a table actually renders and is edited; WhiteboardStylePanel.tsx only
// adds/removes whole rows/columns and the header-row toggle - see its own "table" Field block).
//
// Interaction model (deliberately two-step, same as most spreadsheet/table UIs): a plain click on
// the table when it ISN'T already selected behaves like clicking any other shape (falls through to
// WhiteboardCanvas.tsx's own onPointerDown, which selects/starts a move-drag) - a table doesn't
// intercept that first click. Only once the table IS selected does clicking a cell drill into it
// (stopPropagation'd here) to start editing that cell's text. Row/column divider drag-resize and
// the insert/delete "+"/"x" affordances likewise only appear once selected, matching every other
// shape's own resize handles being selected-only.
import React, { useEffect, useRef, useState } from "react";
import { IoAddCircle, IoCloseCircle } from "react-icons/io5";
import {
  MIN_TABLE_CELL_FRACTION,
  MIN_TABLE_COLS,
  MIN_TABLE_ROWS,
  MAX_TABLE_COLS,
  MAX_TABLE_ROWS,
  WhiteboardNode,
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
  // row/column insert or delete) as a single ordinary node edit - WhiteboardCanvas.tsx wires this to
  // onEditNode(node, { ...node, ...patch }), the same commit path any other shape-specific
  // interaction (an amplifier's dragged lead, a plaquette pick) goes through, undo-tracked for free.
  onCommit: (patch: Partial<WhiteboardNode>) => void;
}

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

type DividerDrag = { kind: "col" | "row"; index: number; startClientPos: number; startFractions: number[] };

const AFFORDANCE_SIZE = 16;

const WhiteboardTable: React.FC<WhiteboardTableProps> = ({ node, selected, canvasZoom, onCommit }) => {
  const grid = resolveTableGrid(node);
  const headerRow = node.tableHeaderRow ?? true;
  const [editingCell, setEditingCell] = useState<{ row: number; col: number } | null>(null);
  const [editingText, setEditingText] = useState("");
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);
  const [liveColWidths, setLiveColWidths] = useState<number[] | null>(null);
  const [liveRowHeights, setLiveRowHeights] = useState<number[] | null>(null);
  const dragRef = useRef<DividerDrag | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);

  const colWidths = liveColWidths ?? grid.colWidths;
  const rowHeights = liveRowHeights ?? grid.rowHeights;
  const colBounds = boundaries(colWidths, node.width);
  const rowBounds = boundaries(rowHeights, node.height);

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
  // deliberate, matching the plain per-node text editor's own Enter/Escape handling just above in
  // WhiteboardCanvas.tsx: it guarantees the commit happens exactly once. Committing directly from
  // onKeyDown while ALSO changing which cell is "active" would, on the next render, unmount this
  // contentEditable (its branch flips from editing to plain) - removing a still-focused element
  // fires a browser blur event of its own, which would run this same onBlur handler a SECOND time
  // against this cell's now-stale closure, double-committing (harmless in outcome since the text is
  // identical, but an extra, redundant undo step). Blurring first means the element is no longer
  // focused by the time React removes it, so that second blur never fires.
  const pendingNavRef = useRef<{ row: number; col: number } | null>(null);

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
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editingCell]);

  const onCellEditorBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!editingCell) return;
    commitCellText(editingCell.row, editingCell.col, e.currentTarget.innerText);
    const nav = pendingNavRef.current;
    pendingNavRef.current = null;
    if (nav && nav.row >= 0 && nav.row < grid.rows && nav.col >= 0 && nav.col < grid.cols) {
      setEditingCell(nav);
      setEditingText(grid.cellText[nav.row][nav.col]);
    } else {
      setEditingCell(null);
    }
  };

  const beginDividerDrag = (e: React.PointerEvent, kind: "col" | "row", index: number) => {
    e.stopPropagation();
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

  const insertRow = (afterIndex: number) => {
    const nextText = grid.cellText.map((r) => [...r]);
    nextText.splice(afterIndex + 1, 0, Array(grid.cols).fill(""));
    onCommit({ tableRows: grid.rows + 1, tableRowHeights: insertTableFraction(grid.rowHeights, afterIndex + 1), tableCellText: nextText });
  };
  const insertCol = (afterIndex: number) => {
    const nextText = grid.cellText.map((r) => {
      const row = [...r];
      row.splice(afterIndex + 1, 0, "");
      return row;
    });
    onCommit({ tableCols: grid.cols + 1, tableColWidths: insertTableFraction(grid.colWidths, afterIndex + 1), tableCellText: nextText });
  };
  const deleteRow = (index: number) => {
    if (grid.rows <= MIN_TABLE_ROWS) return;
    onCommit({ tableRows: grid.rows - 1, tableRowHeights: removeTableFraction(grid.rowHeights, index), tableCellText: grid.cellText.filter((_, r) => r !== index) });
  };
  const deleteCol = (index: number) => {
    if (grid.cols <= MIN_TABLE_COLS) return;
    onCommit({
      tableCols: grid.cols - 1,
      tableColWidths: removeTableFraction(grid.colWidths, index),
      tableCellText: grid.cellText.map((r) => r.filter((_, c) => c !== index)),
    });
  };

  return (
    <div
      className="relative w-full h-full select-none"
      style={{ overflow: "visible" }}
      onPointerLeave={() => {
        setHoveredRow(null);
        setHoveredCol(null);
      }}
    >
      {/* Background + grid lines in one layer, underneath the cell text/editing layer. */}
      <div className="absolute inset-0" style={{ backgroundColor: node.fillColor ?? "transparent" }} />
      {headerRow && grid.rows > 0 && (
        <div
          className="absolute pointer-events-none"
          style={{ left: 0, top: 0, width: node.width, height: rowBounds[1], backgroundColor: "rgba(0,0,0,0.06)" }}
        />
      )}
      <svg width={node.width} height={node.height} className="absolute inset-0 pointer-events-none" style={{ overflow: "visible" }}>
        <rect x={0} y={0} width={node.width} height={node.height} fill="none" stroke={node.strokeColor} strokeWidth={node.strokeWidth} />
        {colBounds.slice(1, -1).map((x, i) => (
          <line key={`c${i}`} x1={x} y1={0} x2={x} y2={node.height} stroke={node.strokeColor} strokeWidth={node.strokeWidth} />
        ))}
        {rowBounds.slice(1, -1).map((y, i) => (
          <line key={`r${i}`} x1={0} y1={y} x2={node.width} y2={y} stroke={node.strokeColor} strokeWidth={node.strokeWidth} />
        ))}
      </svg>

      {/* Cell text (and, for the active cell, its inline editor). */}
      {Array.from({ length: grid.rows }).map((_, r) =>
        Array.from({ length: grid.cols }).map((_, c) => {
          const left = colBounds[c];
          const top = rowBounds[r];
          const w = colBounds[c + 1] - left;
          const h = rowBounds[r + 1] - top;
          const isEditing = editingCell?.row === r && editingCell?.col === c;
          const isHeaderCell = headerRow && r === 0;
          const textStyle: React.CSSProperties = {
            color: node.fontColor,
            fontFamily: node.fontFamily,
            fontSize: node.fontSize,
            fontWeight: isHeaderCell ? "bold" : node.fontWeight,
            fontStyle: node.fontStyle,
            textDecoration: node.textDecoration,
            textAlign: node.textAlign,
          };
          return (
            <div
              key={`${r}-${c}`}
              className="absolute overflow-hidden"
              style={{ left, top, width: w, height: h }}
              onPointerEnter={() => {
                setHoveredRow(r);
                setHoveredCol(c);
              }}
              onPointerDown={(e) => {
                if (!selected || isEditing) return;
                e.stopPropagation();
              }}
              onClick={(e) => {
                if (!selected) return;
                e.stopPropagation();
                if (!isEditing) beginEditingCell(r, c);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (!isEditing) beginEditingCell(r, c);
              }}
            >
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
                  onInput={(e) => setEditingText((e.currentTarget as HTMLDivElement).innerText)}
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
              className="absolute"
              style={{ left: 0, top: y - 4, width: node.width, height: 8, cursor: "row-resize" }}
            />
          ))}

          {/* Insert-at-end affordances. */}
          <button
            type="button"
            title="Add column"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (grid.cols < MAX_TABLE_COLS) insertCol(grid.cols - 1);
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
              if (grid.rows < MAX_TABLE_ROWS) insertRow(grid.rows - 1);
            }}
            className="absolute flex items-center justify-center text-blue-600 bg-white rounded-full hover:text-blue-800"
            style={{ left: node.width / 2 - AFFORDANCE_SIZE / 2, top: node.height + 4, width: AFFORDANCE_SIZE, height: AFFORDANCE_SIZE }}
          >
            <IoAddCircle size={AFFORDANCE_SIZE} />
          </button>

          {/* Per-row/per-column delete, shown only while hovering that row/column and only when
              doing so wouldn't empty the table entirely. */}
          {hoveredRow !== null && grid.rows > MIN_TABLE_ROWS && (
            <button
              type="button"
              title="Delete row"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                deleteRow(hoveredRow);
                setHoveredRow(null);
              }}
              className="absolute flex items-center justify-center text-red-500 bg-white rounded-full hover:text-red-700"
              style={{
                left: -AFFORDANCE_SIZE - 4,
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
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                deleteCol(hoveredCol);
                setHoveredCol(null);
              }}
              className="absolute flex items-center justify-center text-red-500 bg-white rounded-full hover:text-red-700"
              style={{
                left: (colBounds[hoveredCol] + colBounds[hoveredCol + 1]) / 2 - AFFORDANCE_SIZE / 2,
                top: -AFFORDANCE_SIZE - 4,
                width: AFFORDANCE_SIZE,
                height: AFFORDANCE_SIZE,
              }}
            >
              <IoCloseCircle size={AFFORDANCE_SIZE} />
            </button>
          )}
        </>
      )}
    </div>
  );
};

export default WhiteboardTable;
