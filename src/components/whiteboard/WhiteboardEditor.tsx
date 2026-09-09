// components/whiteboard/WhiteboardEditor.tsx
//
// Top-level Whiteboard editing surface - the Whiteboard feature's counterpart to BoardEditor.tsx.
// Owns the useWhiteboardStore instance, selection state, and view state (zoom/pan - Board has no
// pan since its canvas is a fixed-size buffer, but an infinite diagramming canvas needs one); wires
// the toolbar, the page tab strip, WhiteboardCanvas, and WhiteboardStylePanel together, and runs
// the two IO actions that aren't part of the store's own load/edit/autosave lifecycle: exporting a
// flattened PNG of the current page and saving the home-grid thumbnail on the way back out.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  IoAdd,
  IoArrowBack,
  IoArrowRedo,
  IoArrowUndo,
  IoChevronDown,
  IoContractOutline,
  IoCopyOutline,
  IoDownloadOutline,
  IoGitNetworkOutline,
  IoGridOutline,
  IoPencilOutline,
  IoRemove,
  IoShapesOutline,
  IoTrashOutline,
} from "react-icons/io5";
import useWhiteboardStore from "../../hooks/useWhiteboardStore";
import { WhiteboardEdge, WhiteboardNode, WhiteboardPage, WhiteboardShapeType } from "../../utils/whiteboardTypes";
import { canvasToPngBytes } from "../../handlers/pdfExportHandlers";
import { computeContentBounds, renderWhiteboardToCanvas, shapeOutlineFor, CYLINDER_CAP_RATIO } from "../../handlers/whiteboardHandlers";
import WhiteboardCanvas, { WhiteboardCanvasHandle } from "./WhiteboardCanvas";
import WhiteboardStylePanel from "./WhiteboardStylePanel";

const THUMBNAIL_MAX_DIMENSION = 480;

interface WhiteboardEditorProps {
  whiteboardId: string;
  onBack: () => void;
}

interface ShapePreset {
  type: WhiteboardShapeType;
  label: string;
  overrides?: Partial<WhiteboardNode>;
}

// One tile per palette entry - shown in the toolbar's "Shapes" popover. "Rounded Rectangle" is not
// its own shapeType (see whiteboardTypes.ts's WhiteboardNode.cornerRadius doc comment) - it's a
// plain rectangle with a nonzero cornerRadius override applied at creation time.
const SHAPE_PRESETS: ShapePreset[] = [
  { type: "rectangle", label: "Rectangle" },
  { type: "rectangle", label: "Rounded", overrides: { cornerRadius: 16 } },
  { type: "ellipse", label: "Ellipse" },
  { type: "diamond", label: "Diamond" },
  { type: "triangle", label: "Triangle" },
  { type: "hexagon", label: "Hexagon" },
  { type: "parallelogram", label: "Parallelogram" },
  { type: "cylinder", label: "Cylinder" },
];

const TILE_W = 44;
const TILE_H = 32;

// Renders a small preview of a shape preset using the exact same geometry decision
// (shapeOutlineFor) the real canvas draws with, rather than a hand-picked icon that could drift
// out of sync with what clicking the tile actually produces.
function ShapePresetPreview({ preset }: { preset: ShapePreset }) {
  const outline = shapeOutlineFor(preset.type, TILE_W - 4, TILE_H - 4);
  const fill = "#dbeafe";
  const stroke = "#2563eb";
  return (
    <svg width={TILE_W} height={TILE_H} viewBox={`0 0 ${TILE_W} ${TILE_H}`}>
      <g transform="translate(2,2)">
        {outline.kind === "rect" && (
          <rect x={0} y={0} width={TILE_W - 4} height={TILE_H - 4} rx={preset.overrides?.cornerRadius ?? 0} fill={fill} stroke={stroke} strokeWidth={2} />
        )}
        {outline.kind === "ellipse" && <ellipse cx={(TILE_W - 4) / 2} cy={(TILE_H - 4) / 2} rx={(TILE_W - 4) / 2} ry={(TILE_H - 4) / 2} fill={fill} stroke={stroke} strokeWidth={2} />}
        {outline.kind === "polygon" && <polygon points={outline.points.map(([x, y]) => `${x},${y}`).join(" ")} fill={fill} stroke={stroke} strokeWidth={2} strokeLinejoin="round" />}
        {outline.kind === "cylinder" && (
          <>
            <path
              d={`M0,${(TILE_H - 4) * CYLINDER_CAP_RATIO} L0,${(TILE_H - 4) * (1 - CYLINDER_CAP_RATIO)} A${(TILE_W - 4) / 2},${(TILE_H - 4) * CYLINDER_CAP_RATIO} 0 0,0 ${TILE_W - 4},${(TILE_H - 4) * (1 - CYLINDER_CAP_RATIO)} L${TILE_W - 4},${(TILE_H - 4) * CYLINDER_CAP_RATIO} Z`}
              fill={fill}
              stroke={stroke}
              strokeWidth={2}
            />
            <ellipse cx={(TILE_W - 4) / 2} cy={(TILE_H - 4) * CYLINDER_CAP_RATIO} rx={(TILE_W - 4) / 2} ry={(TILE_H - 4) * CYLINDER_CAP_RATIO} fill={fill} stroke={stroke} strokeWidth={2} />
          </>
        )}
      </g>
    </svg>
  );
}

function ToolbarButton({ active, disabled, onClick, title, children }: { active?: boolean; disabled?: boolean; onClick: () => void; title: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`p-2 rounded-md text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active ? "bg-blue-100 dark:bg-blue-500/30 text-blue-700 dark:text-blue-300" : "text-neutral-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}

interface PageTabProps {
  page: WhiteboardPage;
  active: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
}

// One page tab - mirrors draw.io's own Page-1/Page-2 tab strip. Double-click to rename inline;
// a small "..." menu (shown once active, since that's the only tab with room/reason to act on
// right now) offers duplicate and delete, the latter behind a two-step confirm (same convention
// as BoardHome's card menu) since deleting a page is permanent and NOT undo-tracked.
function PageTab({ page, active, canDelete, onSelect, onRename, onDelete, onDuplicate }: PageTabProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(page.name);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      setMenuOpen(false);
      setConfirmDelete(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  if (renaming) {
    return (
      <input
        autoFocus
        value={draftName}
        onChange={(e) => setDraftName(e.target.value)}
        onBlur={() => {
          setRenaming(false);
          if (draftName.trim()) onRename(draftName.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraftName(page.name);
            setRenaming(false);
          }
        }}
        className="h-7 w-24 px-1.5 rounded border border-blue-400 bg-white dark:bg-neutral-800 text-xs outline-none"
      />
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={() => {
        setDraftName(page.name);
        setRenaming(true);
      }}
      className={`relative flex items-center gap-1 h-7 px-3 rounded-t-md text-xs cursor-pointer select-none ${
        active ? "bg-white dark:bg-neutral-950 text-neutral-800 dark:text-neutral-100 border border-b-0 border-gray-200 dark:border-neutral-800" : "text-gray-500 dark:text-neutral-400 hover:bg-gray-100 dark:hover:bg-neutral-800"
      }`}
    >
      <span className="max-w-[120px] truncate">{page.name}</span>
      {active && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(false);
            setMenuOpen((prev) => !prev);
          }}
          className="p-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700"
        >
          <IoChevronDown size={11} />
        </button>
      )}
      {menuOpen && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-full mt-1 w-36 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-md shadow-lg overflow-hidden z-10"
        >
          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              onDuplicate();
            }}
            className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700"
          >
            <IoCopyOutline size={13} /> Duplicate page
          </button>
          {canDelete && (
            <button
              type="button"
              onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
              className="w-full flex items-center gap-1.5 text-left px-3 py-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10"
            >
              <IoTrashOutline size={13} /> {confirmDelete ? "Confirm delete?" : "Delete page"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const WhiteboardEditor: React.FC<WhiteboardEditorProps> = ({ whiteboardId, onBack }) => {
  const store = useWhiteboardStore(whiteboardId);
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set());
  const [armedShapeType, setArmedShapeType] = useState<WhiteboardShapeType | null>(null);
  const [armedNodeOverrides, setArmedNodeOverrides] = useState<Partial<WhiteboardNode> | undefined>(undefined);
  const [connectorArmed, setConnectorArmed] = useState(false);
  const [shapesMenuOpen, setShapesMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const doc = store.doc;
  const page = store.activePage;

  const selectedNodes = useMemo(() => (page ? page.nodes.filter((n) => selectedNodeIds.has(n.id)) : []), [page, selectedNodeIds]);
  const selectedEdges = useMemo(() => (page ? page.edges.filter((e) => selectedEdgeIds.has(e.id)) : []), [page, selectedEdgeIds]);

  useEffect(() => {
    if (!shapesMenuOpen) return;
    const close = () => setShapesMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [shapesMenuOpen]);

  // Fits the view to whichever page is active, every time it changes - covers both "a whiteboard
  // just finished loading" and "the user switched pages" in one code path, since either way the
  // canvas's previous pan/zoom has no reason to still make sense for different content. Keyed on
  // just the id (not the whole page object, which changes on every edit) so this never re-fires
  // mid-edit and stomps the user's own pan/zoom or clears their selection out from under them.
  useEffect(() => {
    if (!page) return;
    setSelectedNodeIds(new Set());
    setSelectedEdgeIds(new Set());
    if (page.nodes.length > 0 || page.edges.length > 0) canvasRef.current?.fitToContent(computeContentBounds(page));
    else canvasRef.current?.resetView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.id]);

  // ---- Keyboard shortcuts: undo/redo (Delete/Escape live inside WhiteboardCanvas, which owns
  // selection-adjacent state that undo/redo doesn't need) -----------------------------------------
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const isTyping = active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (isTyping) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        store.undo();
      } else if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        store.redo();
      } else if (armedShapeType && e.key === "Escape") {
        setArmedShapeType(null);
      } else if (connectorArmed && e.key === "Escape") {
        setConnectorArmed(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, armedShapeType, connectorArmed]);

  const handleReorder = useCallback(
    (toFront: boolean) => {
      if (!page || selectedNodeIds.size === 0) return;
      const selected = page.nodes.filter((n) => selectedNodeIds.has(n.id));
      const rest = page.nodes.filter((n) => !selectedNodeIds.has(n.id));
      store.reorderNodes(toFront ? [...rest, ...selected] : [...selected, ...rest]);
    },
    [page, selectedNodeIds, store]
  );

  const handleDuplicateNode = useCallback(
    (node: WhiteboardNode) => {
      const copy: WhiteboardNode = { ...node, id: crypto.randomUUID(), x: node.x + 24, y: node.y + 24, createdAt: Date.now(), updatedAt: Date.now() };
      store.addNode(copy);
      setSelectedNodeIds(new Set([copy.id]));
      setSelectedEdgeIds(new Set());
    },
    [store]
  );

  const handleSelectionChange = useCallback((nodeIds: Set<string>, edgeIds: Set<string>) => {
    setSelectedNodeIds(nodeIds);
    setSelectedEdgeIds(edgeIds);
  }, []);

  const handleExport = useCallback(async () => {
    if (!doc || !page) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = renderWhiteboardToCanvas(page);
      const bytes = await canvasToPngBytes(canvas);
      await invoke<string>("export_whiteboard_png", { whiteboardName: doc.name, bytes: Array.from(bytes) });
    } catch (err) {
      console.error("Failed to export whiteboard:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [doc, page]);

  const handleSaveAs = useCallback(async () => {
    if (!doc || !page) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = renderWhiteboardToCanvas(page);
      const bytes = await canvasToPngBytes(canvas);
      const safeName = doc.name.trim().replace(/[^a-zA-Z0-9 _-]/g, "_") || "Whiteboard";
      const destPath = await saveFileDialog({ defaultPath: `${safeName}.png`, filters: [{ name: "PNG Image", extensions: ["png"] }] });
      if (!destPath) return;
      await invoke("export_whiteboard_png_to_path", { destPath, bytes: Array.from(bytes) });
    } catch (err) {
      console.error("Failed to save whiteboard:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [doc, page]);

  const handleBack = useCallback(async () => {
    store.flushSave();
    if (page) {
      try {
        const thumb = renderWhiteboardToCanvas(page, THUMBNAIL_MAX_DIMENSION);
        const bytes = await canvasToPngBytes(thumb);
        await invoke("save_whiteboard_thumbnail", { whiteboardId, bytes: Array.from(bytes) });
      } catch (err) {
        console.error("Failed to save whiteboard thumbnail:", err);
      }
    }
    onBack();
  }, [store, page, whiteboardId, onBack]);

  const armShape = useCallback((preset: ShapePreset) => {
    setConnectorArmed(false);
    setShapesMenuOpen(false);
    setArmedShapeType((prev) => {
      const isSame = prev === preset.type && JSON.stringify(armedNodeOverrides) === JSON.stringify(preset.overrides);
      return isSame ? null : preset.type;
    });
    setArmedNodeOverrides(preset.overrides);
  }, [armedNodeOverrides]);

  if (store.loading || !doc || !page) {
    return (
      <div className="flex items-center justify-center w-full h-full text-gray-400 dark:text-neutral-500 text-sm">
        {store.loadError ? `Failed to load whiteboard: ${store.loadError}` : "Loading whiteboard…"}
      </div>
    );
  }

  return (
    // pb tracks --docker-height (published by BottomDocker's own ResizeObserver - see
    // BoardStylePanel.tsx's identical comment on the same pattern) so the page tab strip at the
    // bottom always scrolls clear of the app's fixed bottom icon bar instead of rendering
    // underneath it, invisible and unclickable.
    <div className="flex flex-col w-full h-full bg-white dark:bg-neutral-950 pb-[var(--docker-height,64px)]">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-gray-200 dark:border-neutral-800 flex-wrap">
        <ToolbarButton title="Back to whiteboards" onClick={() => void handleBack()}>
          <IoArrowBack size={18} />
        </ToolbarButton>
        <input
          type="text"
          value={doc.name}
          onChange={(e) => store.renameWhiteboard(e.target.value)}
          className="ml-1 mr-2 h-8 px-2 rounded-md border border-transparent hover:border-gray-200 dark:hover:border-neutral-700 focus:border-blue-400 dark:focus:border-blue-500 bg-transparent text-sm font-medium text-neutral-800 dark:text-neutral-100 outline-none max-w-[220px]"
        />
        <div className="w-px h-6 bg-gray-200 dark:bg-neutral-700 mx-1" />
        <ToolbarButton title="Undo" disabled={!store.canUndo} onClick={store.undo}>
          <IoArrowUndo size={18} />
        </ToolbarButton>
        <ToolbarButton title="Redo" disabled={!store.canRedo} onClick={store.redo}>
          <IoArrowRedo size={18} />
        </ToolbarButton>
        <div className="w-px h-6 bg-gray-200 dark:bg-neutral-700 mx-1" />
        <div className="relative">
          <ToolbarButton
            title="Shapes"
            active={armedShapeType !== null && armedShapeType !== "text" && armedShapeType !== "freehand"}
            onClick={(e?: any) => {
              e?.stopPropagation?.();
              setShapesMenuOpen((prev) => !prev);
            }}
          >
            <span className="flex items-center gap-0.5">
              <IoShapesOutline size={18} />
              <IoChevronDown size={11} />
            </span>
          </ToolbarButton>
          {shapesMenuOpen && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute left-0 top-full mt-1 w-[188px] bg-white dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-lg shadow-xl p-2 grid grid-cols-2 gap-1 z-20"
            >
              {SHAPE_PRESETS.map((preset) => {
                const active = armedShapeType === preset.type && JSON.stringify(armedNodeOverrides) === JSON.stringify(preset.overrides);
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => armShape(preset)}
                    className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md ${active ? "bg-blue-100 dark:bg-blue-500/30" : "hover:bg-gray-100 dark:hover:bg-neutral-700"}`}
                  >
                    <ShapePresetPreview preset={preset} />
                    <span className="text-[10px] text-gray-500 dark:text-neutral-400">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <ToolbarButton
          title="Text"
          active={armedShapeType === "text"}
          onClick={() => {
            setConnectorArmed(false);
            setArmedNodeOverrides(undefined);
            setArmedShapeType((prev) => (prev === "text" ? null : "text"));
          }}
        >
          <span className="font-semibold text-sm">A</span>
        </ToolbarButton>
        <ToolbarButton
          title="Pen (freehand)"
          active={armedShapeType === "freehand"}
          onClick={() => {
            setConnectorArmed(false);
            setArmedNodeOverrides(undefined);
            setArmedShapeType((prev) => (prev === "freehand" ? null : "freehand"));
          }}
        >
          <IoPencilOutline size={18} />
        </ToolbarButton>
        <ToolbarButton
          title="Connector"
          active={connectorArmed}
          onClick={() => {
            setArmedShapeType(null);
            setConnectorArmed((prev) => !prev);
          }}
        >
          <IoGitNetworkOutline size={18} />
        </ToolbarButton>
        <div className="w-px h-6 bg-gray-200 dark:bg-neutral-700 mx-1" />
        <ToolbarButton title="Zoom out" onClick={() => canvasRef.current?.zoomBy(1 / 1.25)}>
          <IoRemove size={18} />
        </ToolbarButton>
        <span className="text-xs text-gray-500 dark:text-neutral-400 w-11 text-center select-none">{Math.round(zoom * 100)}%</span>
        <ToolbarButton title="Zoom in" onClick={() => canvasRef.current?.zoomBy(1.25)}>
          <IoAdd size={18} />
        </ToolbarButton>
        <ToolbarButton title="Fit to content" onClick={() => canvasRef.current?.fitToContent(computeContentBounds(page))}>
          <IoContractOutline size={18} />
        </ToolbarButton>
        <ToolbarButton title={doc.showGrid ? "Hide grid" : "Show grid"} active={doc.showGrid} onClick={() => store.setShowGrid(!doc.showGrid)}>
          <IoGridOutline size={18} />
        </ToolbarButton>
        <div className="flex-1" />
        {store.isSaving && <span className="text-xs text-gray-400 dark:text-neutral-500 mr-2">Saving…</span>}
        {exportError && <span className="text-xs text-red-500 dark:text-red-400 mr-2">{exportError}</span>}
        <ToolbarButton title="Save As PNG…" disabled={isExporting} onClick={() => void handleSaveAs()}>
          <IoDownloadOutline size={18} />
        </ToolbarButton>
        <button
          type="button"
          disabled={isExporting}
          onClick={() => void handleExport()}
          className="ml-1 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          {isExporting ? "Exporting…" : "Export PNG"}
        </button>
      </div>

      <div className="relative flex-1 min-h-0">
        <WhiteboardCanvas
          ref={canvasRef}
          page={page}
          showGrid={doc.showGrid}
          zoom={zoom}
          onZoomChange={setZoom}
          pan={pan}
          onPanChange={setPan}
          selectedNodeIds={selectedNodeIds}
          selectedEdgeIds={selectedEdgeIds}
          onSelectionChange={handleSelectionChange}
          onAddNode={(node) => store.addNode(armedNodeOverrides ? { ...node, ...armedNodeOverrides } : node)}
          onEditNode={store.editNode}
          onBatchEditNodes={store.batchEditNodes}
          onDeleteNode={(node) => {
            store.deleteNode(node);
            setSelectedNodeIds((prev) => {
              if (!prev.has(node.id)) return prev;
              const next = new Set(prev);
              next.delete(node.id);
              return next;
            });
          }}
          onAddEdge={store.addEdge}
          onEditEdge={store.editEdge}
          onDeleteEdge={(edge) => {
            store.deleteEdge(edge);
            setSelectedEdgeIds((prev) => {
              if (!prev.has(edge.id)) return prev;
              const next = new Set(prev);
              next.delete(edge.id);
              return next;
            });
          }}
          armedShapeType={armedShapeType}
          onShapePlaced={() => {
            setArmedShapeType(null);
            setArmedNodeOverrides(undefined);
          }}
          connectorArmed={connectorArmed}
          onConnectorPlaced={() => setConnectorArmed(false)}
        />
        <WhiteboardStylePanel
          selectedNodes={selectedNodes}
          selectedEdges={selectedEdges}
          onBatchEditNodes={store.batchEditNodes}
          onEditEdge={store.editEdge}
          onDeleteNode={(node: WhiteboardNode) => {
            store.deleteNode(node);
            setSelectedNodeIds(new Set());
          }}
          onDeleteEdge={(edge: WhiteboardEdge) => {
            store.deleteEdge(edge);
            setSelectedEdgeIds(new Set());
          }}
          onDuplicateNode={handleDuplicateNode}
          onBringToFront={() => handleReorder(true)}
          onSendToBack={() => handleReorder(false)}
        />
      </div>

      {/* Page tab strip - draw.io's own Page-1/Page-2/+ bar. Always shown, even with just one page,
          so "Add page" is always discoverable rather than appearing only once a second page exists. */}
      <div className="flex items-end gap-0.5 px-2 pt-1 bg-gray-50 dark:bg-neutral-900 border-t border-gray-200 dark:border-neutral-800 overflow-x-auto">
        {doc.pages.map((p) => (
          <PageTab
            key={p.id}
            page={p}
            active={p.id === doc.activePageId}
            canDelete={doc.pages.length > 1}
            onSelect={() => store.setActivePage(p.id)}
            onRename={(name) => store.renamePage(p.id, name)}
            onDelete={() => store.deletePage(p.id)}
            onDuplicate={() => store.duplicatePage(p.id)}
          />
        ))}
        <button type="button" title="Add page" onClick={store.addPage} className="p-1.5 mb-0.5 rounded hover:bg-gray-200 dark:hover:bg-neutral-700 text-gray-500 dark:text-neutral-400">
          <IoAdd size={16} />
        </button>
      </div>
    </div>
  );
};

export default WhiteboardEditor;
