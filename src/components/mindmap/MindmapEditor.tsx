// components/mindmap/MindmapEditor.tsx
//
// The Mindmap editor shell: the drag-and-drop component palette down the left, the canvas in the
// middle, the inspector on the right, and the document header across the top.
//
// Layout mirrors roadmap.sh's own editor because the arrangement is load-bearing, not decorative:
// the palette is a source you drag FROM, the canvas is the target, and the inspector acts on
// whatever the canvas has selected - putting any of the three anywhere else breaks that flow.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { IoArrowBack, IoArrowRedo, IoArrowUndo, IoDownloadOutline, IoEyeOutline, IoPencilOutline } from "react-icons/io5";
import {
  TbAlignLeft,
  TbFrame,
  TbGridDots,
  TbHandClick,
  TbHeading,
  TbLineDashed,
  TbLink,
  TbListCheck,
  TbMagnet,
  TbMaximize,
  TbMinus,
  TbPhoto,
  TbSeparatorVertical,
  TbSquare,
  TbTag,
  TbZoomIn,
  TbZoomOut,
} from "react-icons/tb";
import useMindmapStore from "../../hooks/useMindmapStore";
import {
  MINDMAP_COMPONENT_ORDER,
  MINDMAP_FONT_PX,
  MINDMAP_PALETTE,
  MINDMAP_TYPE_DEFAULTS,
  MINDMAP_TYPE_LABEL,
  MINDMAP_CHECK_GLYPH,
  MindmapNode,
  MindmapNodeType,
  MindmapSide,
  createMindmapNode,
  nodeItems,
  resolveCheckColor,
  resolveCheckStyle,
} from "../../utils/mindmapTypes";
import { autoSizedBox, buildAddTopic, canAutoSize, computeContentBounds } from "../../handlers/mindmapHandlers";
import { wrapTextToWidth } from "../../utils/canvasText";
import { canvasToPdfBytes, canvasToPngBytes } from "../../handlers/pdfExportHandlers";
import MindmapCanvas, { MindmapCanvasHandle } from "./MindmapCanvas";
import MindmapPanel from "./MindmapPanel";
import MindmapLiveView from "./MindmapLiveView";

const THUMBNAIL_MAX_DIMENSION = 480;

// Below this pointer travel a palette press is a click, not a drag - mirrors Dashboard.tsx's own
// SIDEBAR_DRAG_THRESHOLD_PX, which exists for the same reason (pointer-event dragging has to
// distinguish the two itself, since there is no native dragstart to do it).
const PALETTE_DRAG_THRESHOLD_PX = 4;

// The two formats the roadmap can leave the app as. PNG for dropping into a slide or a chat; PDF
// for something that gets printed or shared as a document.
type ExportFormat = "png" | "pdf";

// The checkbox/chevron plus its gap in front of a checklist or links-group row - see
// MindmapNodeBody's own row layout. Auto-size has to allow for it or the text runs under the icon.
const LIST_ROW_ICON_WIDTH = 20;
// Vertical gap between rows, matching the same layout's `gap: 4`.
const LIST_ROW_GAP = 4;

// One icon per component type for the palette. A coloured square only answers "what colour is it",
// which is not the question a palette has to answer - the icon says what the thing IS, and it is
// tinted with the type's own default colour at the call site so the palette still previews that too.
const MINDMAP_TYPE_ICON: Record<MindmapNodeType, React.ReactNode> = {
  title: <TbHeading size={16} />,
  topic: <TbSquare size={16} />,
  subtopic: <TbLineDashed size={16} />,
  paragraph: <TbAlignLeft size={16} />,
  label: <TbTag size={16} />,
  button: <TbHandClick size={16} />,
  image: <TbPhoto size={16} />,
  checklist: <TbListCheck size={16} />,
  linksGroup: <TbLink size={16} />,
  section: <TbFrame size={16} />,
  horizontalLine: <TbMinus size={16} />,
  verticalLine: <TbSeparatorVertical size={16} />,
};

interface MindmapEditorProps {
  mindmapId: string;
  onBack: () => void;
}

// Measures a label at a given font size using a shared offscreen canvas - auto-size needs real text
// metrics, which mindmapHandlers.ts (pure, no DOM) deliberately can't obtain itself. One module-level
// context rather than one per call: creating a canvas per measurement is a surprisingly large cost
// when auto-sizing a whole selection at once.
let measureCtx: CanvasRenderingContext2D | null = null;
function measureLabel(text: string, fontPx: number, bold: boolean): { width: number; height: number } {
  if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
  const lines = (text || " ").split("\n");
  if (!measureCtx) return { width: lines[0].length * fontPx * 0.6, height: lines.length * fontPx * 1.3 };
  measureCtx.font = `${bold ? "700 " : ""}${fontPx}px system-ui, sans-serif`;
  const width = Math.max(...lines.map((l) => measureCtx!.measureText(l).width));
  return { width, height: lines.length * fontPx * 1.3 };
}

const MindmapEditor: React.FC<MindmapEditorProps> = ({ mindmapId, onBack }) => {
  const store = useMindmapStore(mindmapId);
  const canvasRef = useRef<MindmapCanvasHandle>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isExporting, setIsExporting] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // Reader mode. Purely a view switch on the same document - no separate published copy, so what a
  // reader sees is always exactly what the editor last saved.
  const [liveView, setLiveView] = useState(false);

  const doc = store.doc;
  // The canvas's in-progress drag/resize, for display only (see its onLiveNodesChange prop). Applied
  // over the committed selection so the inspector's geometry fields track the drag live instead of
  // waiting for pointer-up.
  const [liveNodesOverride, setLiveNodesOverride] = useState<MindmapNode[] | null>(null);
  const selectedNodes = useMemo(() => {
    const list = doc ? doc.nodes.filter((n) => selectedIds.has(n.id)) : [];
    if (!liveNodesOverride) return list;
    const liveById = new Map(liveNodesOverride.map((n) => [n.id, n]));
    return list.map((n) => liveById.get(n.id) ?? n);
  }, [doc, selectedIds, liveNodesOverride]);

  // The document point at the middle of the visible canvas - where a clicked (rather than dragged)
  // palette tile lands.
  const centerDocPoint = useCallback((): { x: number; y: number } => {
    const rect = canvasHostRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (rect.width / 2 - pan.x) / zoom, y: (rect.height / 2 - pan.y) / zoom };
  }, [pan, zoom]);

  // Frame the whole roadmap once, the first time a document finishes loading. Without this a new
  // mindmap opens at 100% with the viewport parked at the origin, so the template - the entire point
  // of which is to show you what a roadmap looks like - is mostly off-screen on arrival. Guarded by a
  // ref rather than a dependency list so it never re-fires and yanks the view back while editing.
  // The Briefcast library root, needed to turn a stored asset filename into a loadable asset: URL.
  // Null until it arrives, which renders an imported image as its placeholder for the first frame.
  const [briefcastDir, setBriefcastDir] = useState<string | null>(null);
  useEffect(() => {
    invoke<string>("get_briefcast_dir")
      .then(setBriefcastDir)
      .catch((err) => console.error("Failed to resolve Briefcast folder:", err));
  }, []);

  // One resolver shared by the canvas, the reader view and the export, so all three load the same
  // bytes. An imported asset wins over a raw URL: if a node has both, the import is the deliberate
  // one (see MindmapNode.assetFileName).
  const imageSrcFor = useCallback(
    (node: MindmapNode): string | null => {
      if (node.assetFileName && briefcastDir) {
        const sep = briefcastDir.includes("\\") ? "\\" : "/";
        const root = briefcastDir.replace(/[\\/]+$/, "");
        return convertFileSrc([root, "Mindmaps", mindmapId, "assets", node.assetFileName].join(sep));
      }
      return node.imageUrl?.trim() || null;
    },
    [briefcastDir, mindmapId]
  );

  // Imports a picture into this mindmap's own assets/ folder and points the node at it.
  const handleChooseImage = useCallback(
    async (node: MindmapNode) => {
      try {
        const picked = await openFileDialog({
          multiple: false,
          filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif"] }],
        });
        if (!picked || Array.isArray(picked)) return;
        const assetFileName = await invoke<string>("import_mindmap_image", { mindmapId, sourcePath: picked, assetId: crypto.randomUUID() });
        store.editNodes([node], [{ ...node, assetFileName }]);
      } catch (err) {
        console.error("Failed to import image:", err);
        setExportError(err instanceof Error ? err.message : String(err));
      }
    },
    [mindmapId, store]
  );

  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current || !doc || doc.nodes.length === 0) return;
    didFitRef.current = true;
    // One frame later, so the canvas has been laid out and its rect is measurable.
    const raf = requestAnimationFrame(() => canvasRef.current?.fitToContent());
    return () => cancelAnimationFrame(raf);
  }, [doc]);

  // ---- Node mutations -----------------------------------------------------------------------------

  const updateSelected = useCallback(
    (patch: Partial<MindmapNode>) => {
      if (selectedNodes.length === 0) return;
      store.editNodes(
        selectedNodes,
        selectedNodes.map((n) => ({ ...n, ...patch }))
      );
    },
    [selectedNodes, store]
  );

  const handleAddTopic = useCallback(
    (parent: MindmapNode, side: MindmapSide) => {
      if (!doc) return;
      // A topic's child defaults to a subtopic and a subtopic's to another subtopic - the shape a
      // roadmap actually grows in. Adding off a title starts a new topic.
      const childType: MindmapNodeType = parent.type === "title" ? "topic" : "subtopic";
      const { node, edge } = buildAddTopic(parent, side, childType, doc.nodes, crypto.randomUUID(), crypto.randomUUID());
      store.addNodes([node], [edge]);
      setSelectedIds(new Set([node.id]));
    },
    [doc, store]
  );

  const handlePaletteDrop = useCallback(
    (type: MindmapNodeType, point: { x: number; y: number }) => {
      const node = createMindmapNode(crypto.randomUUID(), type, point.x, point.y);
      // A section is a backdrop, so it goes to the BACK of the z-order (index 0). Dropped on top
      // like every other node it would cover whatever it was meant to sit behind, and the first
      // thing anyone would have to do is send it backwards.
      store.addNodes([node], [], type === "section" ? [0] : undefined);
      setSelectedIds(new Set([node.id]));
    },
    [store]
  );

  // ---- Palette drag -------------------------------------------------------------------------------
  //
  // Plain pointer events, NOT the HTML5 drag-and-drop API (draggable/onDragStart/onDrop). That API
  // does not work inside this app's window: it registers a native OS-level drop-target hook (needed
  // for Tauri's own file-drop event, the only way to get real filesystem paths out of an external
  // drop), and that hook takes over drag handling for the whole webview - so dragstart either never
  // fires or the drop never arrives. Dashboard.tsx hit exactly this and documents it at
  // SIDEBAR_DRAG_THRESHOLD_PX; the timeline's clip reordering had to be converted the same way.
  //
  // Using the native API here was a real bug: the palette simply did not drag.
  const paletteDragRef = useRef<{ type: MindmapNodeType; startX: number; startY: number; dragging: boolean } | null>(null);
  // Ghost position, non-null only once a drag has passed the threshold - drives the tile preview
  // that follows the cursor, which the native API would have drawn for us.
  const [paletteGhost, setPaletteGhost] = useState<{ type: MindmapNodeType; x: number; y: number } | null>(null);

  // Converts a viewport point into document space using the canvas host's own rect plus the current
  // pan/zoom - the same transform MindmapCanvas applies internally, done here because the drop is
  // resolved by the editor rather than by a handler on the canvas.
  const clientToDocPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const rect = canvasHostRef.current?.getBoundingClientRect();
      if (!rect) return null;
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return null;
      return { x: (clientX - rect.left - pan.x) / zoom, y: (clientY - rect.top - pan.y) / zoom };
    },
    [pan, zoom]
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const drag = paletteDragRef.current;
      if (!drag) return;
      if (!drag.dragging && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < PALETTE_DRAG_THRESHOLD_PX) return;
      drag.dragging = true;
      setPaletteGhost({ type: drag.type, x: e.clientX, y: e.clientY });
    };
    const up = (e: PointerEvent) => {
      const drag = paletteDragRef.current;
      paletteDragRef.current = null;
      setPaletteGhost(null);
      if (!drag) return;
      // A drag that ended over the canvas places the node there. A plain click (never passed the
      // threshold) places it at the middle of the current view instead - the palette stays usable
      // without dragging at all, which also means a future regression in pointer dragging can't
      // make the tool unusable the way this one did.
      const point = drag.dragging ? clientToDocPoint(e.clientX, e.clientY) : centerDocPoint();
      if (point) handlePaletteDrop(drag.type, point);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  const handleAutoSize = useCallback(
    (node: MindmapNode) => {
      // A divider has no text to size to, and its height IS its thickness - running it through the
      // text path forced it up to the 80x32 minimum meant for labelled boxes, which turned a 2px
      // rule into a filled black rectangle (the line body paints its whole box). There is nothing
      // sensible for auto-size to mean here, so it does nothing; the panel also hides the button for
      // these types, and this guard keeps the operation safe regardless of how it's reached.
      if (!canAutoSize(node)) return;

      const fontPx = MINDMAP_FONT_PX[node.fontSize];
      // A checklist/links group is a heading PLUS its rows. Sizing it to the heading alone (what the
      // plain text path does) clips every row out of view, so the rows are measured too - matching
      // how MindmapNodeBody actually lays them out.
      if ((node.type === "checklist" || node.type === "linksGroup") && (node.items?.length ?? 0) > 0) {
        const heading = measureLabel(node.label, fontPx, true);
        const rows = (node.items ?? []).map((item) => measureLabel(item.text, fontPx - 1, false));
        const width = Math.max(heading.width, ...rows.map((r) => r.width + LIST_ROW_ICON_WIDTH));
        const height = heading.height + rows.reduce((sum, r) => sum + r.height + LIST_ROW_GAP, 0);
        store.editNodes([node], [{ ...node, ...autoSizedBox(width, height) }]);
        return;
      }

      const { width, height } = measureLabel(node.label, fontPx, node.bold ?? false);
      store.editNodes([node], [{ ...node, ...autoSizedBox(width, height) }]);
    },
    [store]
  );

  const handleDeleteSelection = useCallback(() => {
    if (selectedNodes.length === 0) return;
    store.deleteNodes(selectedNodes);
    setSelectedIds(new Set());
  }, [selectedNodes, store]);

  const reorder = useCallback(
    (toFront: boolean) => {
      if (!doc || selectedNodes.length === 0) return;
      const ids = new Set(selectedNodes.map((n) => n.id));
      const rest = doc.nodes.filter((n) => !ids.has(n.id));
      const moved = doc.nodes.filter((n) => ids.has(n.id));
      store.reorderNodes(toFront ? [...rest, ...moved] : [...moved, ...rest]);
    },
    [doc, selectedNodes, store]
  );

  // ---- Export -------------------------------------------------------------------------------------
  //
  // Renders the whole roadmap to a canvas by rasterizing the live DOM through an SVG <foreignObject>
  // would be fragile across WebView versions; instead this draws the same geometry with Canvas2D,
  // which is what the whiteboard's own export already does and is the only approach that reliably
  // produces bytes rather than a tainted canvas.
  const renderToCanvas = useCallback(
    async (maxDimension?: number): Promise<HTMLCanvasElement> => {
      const canvas = document.createElement("canvas");
      if (!doc) return canvas;
      const bounds = computeContentBounds(doc);
      const contentW = Math.max(1, bounds.maxX - bounds.minX);
      const contentH = Math.max(1, bounds.maxY - bounds.minY);
      const scale = maxDimension ? Math.min(1, maxDimension / Math.max(contentW, contentH)) : 1;
      canvas.width = Math.max(1, Math.round(contentW * scale));
      canvas.height = Math.max(1, Math.round(contentH * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return canvas;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.translate(-bounds.minX, -bounds.minY);

      const byId = new Map(doc.nodes.map((n) => [n.id, n]));
      // Connectors first, so they pass behind the boxes exactly as on the live canvas.
      for (const edge of doc.edges) {
        const s = byId.get(edge.sourceId);
        const t = byId.get(edge.targetId);
        if (!s || !t) continue;
        const { edgePath } = await import("../../handlers/mindmapHandlers");
        ctx.save();
        ctx.strokeStyle = "#2b7fff";
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        if (edge.style === "dashed") ctx.setLineDash([1, 7]);
        ctx.stroke(new Path2D(edgePath(s, edge.sourceSide, t, edge.targetSide)));
        ctx.restore();
      }

      for (const node of doc.nodes) {
        const palette = MINDMAP_PALETTE[node.colorKey];
        const fontPx = MINDMAP_FONT_PX[node.fontSize];
        if (node.type === "horizontalLine" || node.type === "verticalLine") {
          ctx.fillStyle = palette.border;
          ctx.fillRect(node.x, node.y, node.width, node.height);
          continue;
        }
        // Matches MindmapNodeBody: a title is a heading, drawn as plain text with no box.
        const boxed = node.type === "topic" || node.type === "subtopic" || node.type === "button";
        if (boxed) {
          ctx.fillStyle = palette.background;
          ctx.fillRect(node.x, node.y, node.width, node.height);
          ctx.strokeStyle = palette.border;
          ctx.lineWidth = 2;
          ctx.strokeRect(node.x, node.y, node.width, node.height);
        }
        ctx.textBaseline = "middle";

        // Everything below matches MindmapNodeBody's own CSS box: 10px of horizontal padding, 4px
        // vertical for a single-line node and 8px for the stacked ones, lineHeight 1.3, and
        // `overflow: hidden`. The clip is what makes that last one true here - without it a label too
        // tall for its node spills across the roadmap in the export while staying neatly cut off on
        // screen. Long labels wrap (rather than running off the shape) for the same reason: the DOM
        // renderer sets `word-break: break-word`, so wrapping is what the user already sees.
        ctx.save();
        ctx.beginPath();
        ctx.rect(node.x, node.y, node.width, node.height);
        ctx.clip();
        const padX = 10;
        const innerW = node.width - padX * 2;

        // A checklist/links group is a heading plus its rows - drawing only the heading would export
        // an empty-looking box, matching neither the canvas nor the reader view.
        const rows = nodeItems(node);
        if (rows.length > 0) {
          const checkColor = resolveCheckColor(node);
          const glyph = MINDMAP_CHECK_GLYPH[resolveCheckStyle(node)];
          const rowFontPx = fontPx - 1;
          const headLineH = fontPx * 1.3;
          const rowLineH = rowFontPx * 1.3;
          const ROW_GAP = 4;
          const MARKER_W = 12;
          const MARKER_GAP = 6;
          const textLeft = node.x + padX + MARKER_W + MARKER_GAP;
          const textW = node.width - padX - MARKER_W - MARKER_GAP - padX;
          ctx.textAlign = "left";

          // Heading, wrapped. `y` then walks down the rows the way the flex column does, advancing by
          // each row's OWN measured height - a fixed step per row would have a wrapped two-line item
          // sit on top of the next one.
          ctx.font = `700 ${fontPx}px system-ui, sans-serif`;
          ctx.fillStyle = palette.text;
          const headLines = wrapTextToWidth(ctx, node.label, innerW);
          let y = node.y + 8;
          for (const line of headLines) {
            ctx.fillText(line, node.x + padX, y + headLineH / 2);
            y += headLineH;
          }
          y += ROW_GAP;

          for (const item of rows) {
            ctx.font = `${rowFontPx}px system-ui, sans-serif`;
            const itemLines = wrapTextToWidth(ctx, item.text, textW);
            const blockH = Math.max(MARKER_W, itemLines.length * rowLineH);
            // The marker is centered against the whole row, matching `alignItems: center`.
            const markerCY = y + blockH / 2;
            if (node.type === "checklist") {
              ctx.strokeStyle = item.checked ? checkColor : palette.border;
              ctx.lineWidth = 1.5;
              ctx.strokeRect(node.x + padX, markerCY - MARKER_W / 2, MARKER_W, MARKER_W);
              if (item.checked) {
                ctx.fillStyle = checkColor;
                ctx.font = `9px system-ui, sans-serif`;
                ctx.textAlign = "center";
                ctx.fillText(glyph, node.x + padX + MARKER_W / 2, markerCY);
                ctx.textAlign = "left";
              }
            } else {
              ctx.fillStyle = "#2b7fff";
              ctx.font = `${rowFontPx}px system-ui, sans-serif`;
              ctx.fillText("\u203A", node.x + padX, markerCY);
            }
            ctx.fillStyle = node.type === "linksGroup" ? "#2b7fff" : palette.text;
            // 0.85 is the row opacity the canvas gives every item; a ticked one reads fainter still.
            ctx.globalAlpha = (node.type === "checklist" && item.checked ? 0.55 : 1) * 0.85;
            ctx.font = `${rowFontPx}px system-ui, sans-serif`;
            itemLines.forEach((line, i) => ctx.fillText(line, textLeft, y + rowLineH / 2 + i * rowLineH));
            ctx.globalAlpha = 1;
            y += blockH + ROW_GAP;
          }
          ctx.restore();
          continue;
        }

        ctx.fillStyle = palette.text;
        ctx.font = `${node.italic ? "italic " : ""}${node.bold ? "700 " : ""}${fontPx}px system-ui, sans-serif`;
        // A paragraph is the only left-aligned, top-anchored kind; a title or label is centered text
        // with no box, and a boxed node centers in both axes (see MindmapNodeBody's `base`).
        const leftAligned = node.type === "paragraph" || node.type === "section";
        ctx.textAlign = leftAligned ? "left" : "center";
        const cx = leftAligned ? node.x + padX : node.x + node.width / 2;
        const lines = wrapTextToWidth(ctx, node.label, innerW);
        const lineH = fontPx * 1.3;
        const padY = leftAligned ? 8 : 4;
        const startY = leftAligned
          ? node.y + padY + lineH / 2
          : node.y + node.height / 2 - ((lines.length - 1) * lineH) / 2;
        lines.forEach((line, i) => ctx.fillText(line, cx, startY + i * lineH));
        ctx.restore();
      }
      return canvas;
    },
    [doc]
  );

  // PNG and PDF share one renderer: the PDF is the same canvas wrapped in a single page (see
  // canvasToPdfBytes), so the two formats can never drift into showing different diagrams.
  const encodeAs = useCallback(
    async (format: ExportFormat): Promise<Uint8Array> => {
      const canvas = await renderToCanvas();
      return format === "pdf" ? canvasToPdfBytes(canvas) : canvasToPngBytes(canvas);
    },
    [renderToCanvas]
  );

  const handleExport = useCallback(
    async (format: ExportFormat) => {
      if (!doc) return;
      setExportMenuOpen(false);
      setIsExporting(true);
      setExportError(null);
      try {
        const bytes = await encodeAs(format);
        await invoke<string>("export_mindmap_file", { mindmapName: doc.name, extension: format, bytes: Array.from(bytes) });
      } catch (err) {
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsExporting(false);
      }
    },
    [doc, encodeAs]
  );

  const handleSaveAs = useCallback(
    async (format: ExportFormat) => {
      if (!doc) return;
      setExportMenuOpen(false);
      try {
        const dest = await saveFileDialog({
          defaultPath: `${doc.name}.${format}`,
          filters: [format === "pdf" ? { name: "PDF document", extensions: ["pdf"] } : { name: "PNG image", extensions: ["png"] }],
        });
        if (!dest) return;
        setIsExporting(true);
        const bytes = await encodeAs(format);
        await invoke("export_mindmap_to_path", { destPath: dest, bytes: Array.from(bytes) });
      } catch (err) {
        setExportError(err instanceof Error ? err.message : String(err));
      } finally {
        setIsExporting(false);
      }
    },
    [doc, encodeAs]
  );

  const handleBack = useCallback(async () => {
    store.flushSave();
    if (doc) {
      try {
        const thumb = await renderToCanvas(THUMBNAIL_MAX_DIMENSION);
        const bytes = await canvasToPngBytes(thumb);
        await invoke("save_mindmap_thumbnail", { mindmapId, bytes: Array.from(bytes) });
      } catch (err) {
        console.error("Failed to save mindmap thumbnail:", err);
      }
    }
    onBack();
  }, [store, doc, mindmapId, renderToCanvas, onBack]);

  if (store.loading) return <div className="w-full h-full flex items-center justify-center text-sm text-gray-500">Loading mindmap…</div>;
  if (store.loadError || !doc) return <div className="w-full h-full flex items-center justify-center text-sm text-red-500">{store.loadError ?? "Mindmap not found"}</div>;

  return (
    <div className="flex flex-col w-full h-full bg-white dark:bg-neutral-950">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-2 border-b border-gray-200 dark:border-neutral-800">
        <button type="button" onClick={handleBack} title="Back to mindmaps" className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-neutral-800">
          <IoArrowBack size={18} />
        </button>
        <div className="flex flex-col min-w-0">
          <input
            value={doc.name}
            onChange={(e) => store.editDetails(e.target.value, doc.description)}
            className="text-sm font-semibold bg-transparent outline-none min-w-0 w-48"
            placeholder="Roadmap name"
          />
          <input
            value={doc.description}
            onChange={(e) => store.editDetails(doc.name, e.target.value)}
            className="text-[11px] text-gray-500 dark:text-neutral-400 bg-transparent outline-none min-w-0 w-64"
            placeholder="What is this roadmap for?"
          />
        </div>

        <div className="mx-2 h-6 w-px bg-gray-200 dark:bg-neutral-800" />
        <button type="button" onClick={store.undo} disabled={!store.canUndo} title="Undo" className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-30">
          <IoArrowUndo size={16} />
        </button>
        <button type="button" onClick={store.redo} disabled={!store.canRedo} title="Redo" className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-neutral-800 disabled:opacity-30">
          <IoArrowRedo size={16} />
        </button>

        <div className="mx-2 h-6 w-px bg-gray-200 dark:bg-neutral-800" />
        <button type="button" onClick={() => canvasRef.current?.zoomBy(1 / 1.2)} title="Zoom out" className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-neutral-800">
          <TbZoomOut size={16} />
        </button>
        <span className="text-xs tabular-nums text-gray-500 w-10 text-center">{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => canvasRef.current?.zoomBy(1.2)} title="Zoom in" className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-neutral-800">
          <TbZoomIn size={16} />
        </button>
        <button type="button" onClick={() => canvasRef.current?.fitToContent()} title="Fit to content" className="p-1.5 rounded-md hover:bg-gray-100 dark:hover:bg-neutral-800">
          <TbMaximize size={16} />
        </button>
        <button
          type="button"
          onClick={() => store.setShowGrid(!doc.showGrid)}
          title={doc.showGrid ? "Hide grid" : "Show grid"}
          className={`p-1.5 rounded-md ${doc.showGrid ? "bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
        >
          <TbGridDots size={16} />
        </button>
        <button
          type="button"
          onClick={() => store.setSnapToGrid(!doc.snapToGrid)}
          title={doc.snapToGrid ? "Snap to grid on" : "Snap to grid off"}
          className={`p-1.5 rounded-md ${doc.snapToGrid ? "bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"}`}
        >
          <TbMagnet size={16} />
        </button>

        <div className="ml-auto flex items-center gap-2">
          {exportError && <span className="text-xs text-red-500">{exportError}</span>}
          {store.isSaving && <span className="text-[11px] text-gray-400">Saving…</span>}
          <button
            type="button"
            onClick={() => setLiveView((v) => !v)}
            title={liveView ? "Back to editing" : "Live View - see the roadmap the way a reader does"}
            className={`h-8 px-2.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition ${
              liveView ? "bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300" : "hover:bg-gray-100 dark:hover:bg-neutral-800"
            }`}
          >
            {liveView ? <IoPencilOutline size={15} /> : <IoEyeOutline size={15} />}
            {liveView ? "Edit" : "Live View"}
          </button>
          {/* One menu rather than four toolbar buttons: the format (PNG/PDF) and the destination
              (straight into the library, or a chosen path) are two independent choices, and spelling
              out all four combinations across the toolbar would crowd out everything else. */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setExportMenuOpen((v) => !v)}
              disabled={isExporting}
              className="h-8 px-3 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 text-xs font-semibold flex items-center gap-1.5 hover:opacity-90 disabled:opacity-50 transition"
            >
              <IoDownloadOutline size={15} />
              {isExporting ? "Exporting…" : "Export"}
            </button>
            {exportMenuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setExportMenuOpen(false)} />
                <div className="absolute right-0 top-9 z-30 w-52 rounded-lg border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 shadow-xl py-1 text-xs">
                  <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Save to library</p>
                  <button type="button" onClick={() => handleExport("png")} className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700">
                    PNG image
                  </button>
                  <button type="button" onClick={() => handleExport("pdf")} className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700">
                    PDF document
                  </button>
                  <div className="my-1 border-t border-gray-100 dark:border-neutral-700/70" />
                  <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Save as…</p>
                  <button type="button" onClick={() => handleSaveAs("png")} className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700">
                    PNG image…
                  </button>
                  <button type="button" onClick={() => handleSaveAs("pdf")} className="w-full text-left px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-neutral-700">
                    PDF document…
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Drag ghost - the pointer-event palette drag has to draw its own, since there is no native
          drag image. pointer-events: none so it never becomes the drop target itself. */}
      {paletteGhost && (
        <div
          className="fixed z-50 pointer-events-none px-2.5 py-2 rounded-lg border-2 border-violet-400 bg-white dark:bg-neutral-800 text-xs shadow-lg opacity-90"
          style={{ left: paletteGhost.x + 10, top: paletteGhost.y + 10 }}
        >
          {MINDMAP_TYPE_LABEL[paletteGhost.type]}
        </div>
      )}
      {liveView ? (
        <div className="flex-1 min-h-0">
          <MindmapLiveView doc={doc} imageSrcFor={imageSrcFor} onSetProgress={(node, progress) => store.editNodes([node], [{ ...node, progress }])} />
        </div>
      ) : (
      <div className="flex-1 min-h-0 flex">
        {/* Component palette. Drag a tile onto the canvas to place that node type - the drag carries
            the type on a private MIME so an unrelated drag (a file, some text) can't be mistaken for
            one of these. */}
        <div className="shrink-0 w-52 border-r border-gray-200 dark:border-neutral-800 overflow-y-auto p-2 flex flex-col gap-1.5 bg-gray-50/60 dark:bg-neutral-900/40">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-neutral-500 px-1 pb-1">
            Components <span className="font-normal normal-case tracking-normal">(drag &amp; drop)</span>
          </p>
          {MINDMAP_COMPONENT_ORDER.map((type) => {
            const palette = MINDMAP_PALETTE[MINDMAP_TYPE_DEFAULTS[type].colorKey];
            return (
              <div
                key={type}
                onPointerDown={(e) => {
                  e.preventDefault();
                  paletteDragRef.current = { type, startX: e.clientX, startY: e.clientY, dragging: false };
                }}
                className="flex items-center gap-2 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-xs cursor-grab active:cursor-grabbing hover:border-violet-400 hover:shadow-sm transition select-none"
                title={`Drag "${MINDMAP_TYPE_LABEL[type]}" onto the canvas, or click to drop it in the middle`}
              >
                {/* A typed icon rather than a colour chip - "what is this component" is the
                    question the palette has to answer, and a coloured square only answers "what
                    colour is it". The icon is tinted with the type's own default colour so the
                    palette still previews that too. */}
                <span className="shrink-0 flex items-center justify-center w-4 h-4" style={{ color: palette.border }}>
                  {MINDMAP_TYPE_ICON[type]}
                </span>
                {MINDMAP_TYPE_LABEL[type]}
              </div>
            );
          })}
        </div>

        <div className="relative flex-1 min-w-0" ref={canvasHostRef}>
          <MindmapCanvas
            ref={canvasRef}
            doc={doc}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
            onEditNodes={store.editNodes}
            onAddEdge={store.addEdge}
            onDeleteSelection={handleDeleteSelection}
            onAddTopic={handleAddTopic}
            onLiveNodesChange={setLiveNodesOverride}
            imageSrcFor={imageSrcFor}
            onUndo={store.undo}
            onRedo={store.redo}
            zoom={zoom}
            onZoomChange={setZoom}
            pan={pan}
            onPanChange={setPan}
          />
          <MindmapPanel
            selected={selectedNodes}
            onUpdate={updateSelected}
            onAddTopic={handleAddTopic}
            onAutoSize={handleAutoSize}
            onBringToFront={() => reorder(true)}
            onSendToBack={() => reorder(false)}
            onDelete={handleDeleteSelection}
            onChooseImage={handleChooseImage}
          />
        </div>
      </div>
      )}
    </div>
  );
};

export default MindmapEditor;
