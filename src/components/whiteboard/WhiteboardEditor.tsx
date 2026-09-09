// components/whiteboard/WhiteboardEditor.tsx
//
// Top-level Whiteboard editing surface - the Whiteboard feature's counterpart to BoardEditor.tsx.
// Owns the useWhiteboardStore instance, selection state, and view state (zoom/pan - Board has no
// pan since its canvas is a fixed-size buffer, but an infinite diagramming canvas needs one); wires
// the toolbar, WhiteboardCanvas, and WhiteboardStylePanel together, and runs the two IO actions
// that aren't part of the store's own load/edit/autosave lifecycle: exporting a flattened PNG and
// saving the home-grid thumbnail on the way back out.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  IoAdd,
  IoArrowBack,
  IoArrowRedo,
  IoArrowUndo,
  IoContractOutline,
  IoDownloadOutline,
  IoGitNetworkOutline,
  IoGridOutline,
  IoRemove,
  IoSquareOutline,
  IoText,
} from "react-icons/io5";
import { TbCircle, TbDiamond } from "react-icons/tb";
import useWhiteboardStore from "../../hooks/useWhiteboardStore";
import { WhiteboardEdge, WhiteboardNode, WhiteboardShapeType } from "../../utils/whiteboardTypes";
import { canvasToPngBytes } from "../../handlers/pdfExportHandlers";
import { computeContentBounds, renderWhiteboardToCanvas } from "../../handlers/whiteboardHandlers";
import WhiteboardCanvas, { WhiteboardCanvasHandle } from "./WhiteboardCanvas";
import WhiteboardStylePanel from "./WhiteboardStylePanel";

const THUMBNAIL_MAX_DIMENSION = 480;

interface WhiteboardEditorProps {
  whiteboardId: string;
  onBack: () => void;
}

const SHAPE_PALETTE: { type: WhiteboardShapeType; label: string; icon: React.ReactNode }[] = [
  { type: "rectangle", label: "Rectangle", icon: <IoSquareOutline size={18} /> },
  { type: "ellipse", label: "Ellipse", icon: <TbCircle size={18} /> },
  { type: "diamond", label: "Diamond", icon: <TbDiamond size={18} /> },
  { type: "text", label: "Text", icon: <IoText size={18} /> },
];

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

const WhiteboardEditor: React.FC<WhiteboardEditorProps> = ({ whiteboardId, onBack }) => {
  const store = useWhiteboardStore(whiteboardId);
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<Set<string>>(new Set());
  const [armedShapeType, setArmedShapeType] = useState<WhiteboardShapeType | null>(null);
  const [connectorArmed, setConnectorArmed] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const doc = store.doc;

  const selectedNodes = useMemo(() => (doc ? doc.nodes.filter((n) => selectedNodeIds.has(n.id)) : []), [doc, selectedNodeIds]);
  const selectedEdges = useMemo(() => (doc ? doc.edges.filter((e) => selectedEdgeIds.has(e.id)) : []), [doc, selectedEdgeIds]);

  // Centers a freshly opened whiteboard's view once it loads - an empty new whiteboard just shows
  // the origin at 100%; one with existing content fits it to the viewport.
  const didInitialFit = useRef(false);
  useEffect(() => {
    if (!doc || didInitialFit.current) return;
    didInitialFit.current = true;
    if (doc.nodes.length > 0) canvasRef.current?.fitToContent(computeContentBounds(doc));
  }, [doc]);

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
      if (!doc || selectedNodeIds.size === 0) return;
      const selected = doc.nodes.filter((n) => selectedNodeIds.has(n.id));
      const rest = doc.nodes.filter((n) => !selectedNodeIds.has(n.id));
      store.reorderNodes(toFront ? [...rest, ...selected] : [...selected, ...rest]);
    },
    [doc, selectedNodeIds, store]
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
    if (!doc) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = renderWhiteboardToCanvas(doc);
      const bytes = await canvasToPngBytes(canvas);
      await invoke<string>("export_whiteboard_png", { whiteboardName: doc.name, bytes: Array.from(bytes) });
    } catch (err) {
      console.error("Failed to export whiteboard:", err);
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsExporting(false);
    }
  }, [doc]);

  const handleSaveAs = useCallback(async () => {
    if (!doc) return;
    setIsExporting(true);
    setExportError(null);
    try {
      const canvas = renderWhiteboardToCanvas(doc);
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
  }, [doc]);

  const handleBack = useCallback(async () => {
    store.flushSave();
    if (doc) {
      try {
        const thumb = renderWhiteboardToCanvas(doc, THUMBNAIL_MAX_DIMENSION);
        const bytes = await canvasToPngBytes(thumb);
        await invoke("save_whiteboard_thumbnail", { whiteboardId, bytes: Array.from(bytes) });
      } catch (err) {
        console.error("Failed to save whiteboard thumbnail:", err);
      }
    }
    onBack();
  }, [store, doc, whiteboardId, onBack]);

  if (store.loading || !doc) {
    return (
      <div className="flex items-center justify-center w-full h-full text-gray-400 dark:text-neutral-500 text-sm">
        {store.loadError ? `Failed to load whiteboard: ${store.loadError}` : "Loading whiteboard…"}
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-full bg-white dark:bg-neutral-950">
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
        {SHAPE_PALETTE.map((shape) => (
          <ToolbarButton
            key={shape.type}
            title={shape.label}
            active={armedShapeType === shape.type}
            onClick={() => {
              setConnectorArmed(false);
              setArmedShapeType((prev) => (prev === shape.type ? null : shape.type));
            }}
          >
            {shape.icon}
          </ToolbarButton>
        ))}
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
        <ToolbarButton title="Fit to content" onClick={() => canvasRef.current?.fitToContent(computeContentBounds(doc))}>
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
          doc={doc}
          zoom={zoom}
          onZoomChange={setZoom}
          pan={pan}
          onPanChange={setPan}
          selectedNodeIds={selectedNodeIds}
          selectedEdgeIds={selectedEdgeIds}
          onSelectionChange={handleSelectionChange}
          onAddNode={store.addNode}
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
          onShapePlaced={() => setArmedShapeType(null)}
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
    </div>
  );
};

export default WhiteboardEditor;
