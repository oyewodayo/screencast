// components/whiteboard/WhiteboardMinimap.tsx
//
// Lightweight, HiDPI <canvas>-rendered viewport radar in the bottom-right corner of the Whiteboard.
// Draws all node silhouettes + the live viewport rectangle in a single requestAnimationFrame pass
// (zero SVG/DOM elements per node), and supports instant click-to-jump and drag-to-pan.

import React, { memo, useCallback, useEffect, useRef } from "react";
import { isArtboardNode, WhiteboardNode } from "../../utils/whiteboardTypes";

const MAP_W = 188;
const MAP_H = 122;
const MAP_PAD = 10;

interface WhiteboardMinimapProps {
  nodes: WhiteboardNode[];
  selectedNodeIds: Set<string>;
  pan: { x: number; y: number };
  zoom: number;
  viewportWidth: number;
  viewportHeight: number;
  onPanChange: (pan: { x: number; y: number }) => void;
}

interface WorldTransform {
  minX: number;
  minY: number;
  scale: number;
  offsetX: number;
  offsetY: number;
}

const WhiteboardMinimap: React.FC<WhiteboardMinimapProps> = memo(
  ({ nodes, selectedNodeIds, pan, zoom, viewportWidth, viewportHeight, onPanChange }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const transformRef = useRef<WorldTransform>({ minX: 0, minY: 0, scale: 1, offsetX: 0, offsetY: 0 });
    const draggingRef = useRef(false);

    useEffect(() => {
      const raf = requestAnimationFrame(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(MAP_W * dpr) || canvas.height !== Math.round(MAP_H * dpr)) {
          canvas.width = Math.round(MAP_W * dpr);
          canvas.height = Math.round(MAP_H * dpr);
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, MAP_W, MAP_H);

        const safeZoom = Math.max(0.05, zoom);
        const vpLeft = -pan.x / safeZoom;
        const vpTop = -pan.y / safeZoom;
        const vpW = Math.max(1, viewportWidth) / safeZoom;
        const vpH = Math.max(1, viewportHeight) / safeZoom;

        // Compute world bounds combining all nodes + current viewport so the viewport box is always visible.
        let minX = vpLeft;
        let minY = vpTop;
        let maxX = vpLeft + vpW;
        let maxY = vpTop + vpH;

        for (const n of nodes) {
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x + n.width > maxX) maxX = n.x + n.width;
          if (n.y + n.height > maxY) maxY = n.y + n.height;
        }

        const worldW = Math.max(1, maxX - minX);
        const worldH = Math.max(1, maxY - minY);
        const innerW = MAP_W - MAP_PAD * 2;
        const innerH = MAP_H - MAP_PAD * 2;
        const scale = Math.min(innerW / worldW, innerH / worldH);
        const offsetX = MAP_PAD + (innerW - worldW * scale) / 2;
        const offsetY = MAP_PAD + (innerH - worldH * scale) / 2;

        transformRef.current = { minX, minY, scale, offsetX, offsetY };

        const toX = (wx: number) => offsetX + (wx - minX) * scale;
        const toY = (wy: number) => offsetY + (wy - minY) * scale;

        // Draw artboard frames first as subtle tinted backdrops
        for (const n of nodes) {
          if (!isArtboardNode(n)) continue;
          const x = toX(n.x);
          const y = toY(n.y);
          const w = Math.max(2, n.width * scale);
          const h = Math.max(2, n.height * scale);
          ctx.fillStyle = "rgba(148, 163, 184, 0.16)";
          ctx.strokeStyle = "rgba(100, 116, 139, 0.55)";
          ctx.lineWidth = 1;
          ctx.fillRect(x, y, w, h);
          ctx.strokeRect(x, y, w, h);
        }

        // Draw regular & mindmap node silhouettes
        for (const n of nodes) {
          if (isArtboardNode(n)) continue;
          const x = toX(n.x);
          const y = toY(n.y);
          const w = Math.max(2.5, n.width * scale);
          const h = Math.max(2, n.height * scale);
          const isSel = selectedNodeIds.has(n.id);
          ctx.fillStyle = isSel
            ? "#2563eb"
            : n.fillColor && n.fillColor !== "#ffffff"
            ? n.fillColor
            : "#94a3b8";
          ctx.globalAlpha = isSel ? 0.95 : 0.78;
          ctx.fillRect(x, y, w, h);
        }
        ctx.globalAlpha = 1;

        // Draw live viewport rectangle
        const rx = toX(vpLeft);
        const ry = toY(vpTop);
        const rw = Math.max(8, vpW * scale);
        const rh = Math.max(6, vpH * scale);
        ctx.fillStyle = "rgba(37, 99, 235, 0.12)";
        ctx.strokeStyle = "#2563eb";
        ctx.lineWidth = 1.5;
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);

        ctx.restore();
      });
      return () => cancelAnimationFrame(raf);
    }, [nodes, selectedNodeIds, pan, zoom, viewportWidth, viewportHeight]);

    const panToClientPoint = useCallback(
      (clientX: number, clientY: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        const t = transformRef.current;
        const docX = t.minX + (mx - t.offsetX) / Math.max(1e-6, t.scale);
        const docY = t.minY + (my - t.offsetY) / Math.max(1e-6, t.scale);
        onPanChange({
          x: viewportWidth / 2 - docX * zoom,
          y: viewportHeight / 2 - docY * zoom,
        });
      },
      [onPanChange, viewportWidth, viewportHeight, zoom]
    );

    return (
      <div
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute bottom-14 left-3 z-20 rounded-lg bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 shadow-lg overflow-hidden select-none"
        title="Click or drag to navigate canvas"
      >
        <canvas
          ref={canvasRef}
          style={{ width: MAP_W, height: MAP_H, display: "block", cursor: "crosshair" }}
          onPointerDown={(e) => {
            e.stopPropagation();
            draggingRef.current = true;
            (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
            panToClientPoint(e.clientX, e.clientY);
          }}
          onPointerMove={(e) => {
            if (!draggingRef.current) return;
            panToClientPoint(e.clientX, e.clientY);
          }}
          onPointerUp={() => {
            draggingRef.current = false;
          }}
          onPointerCancel={() => {
            draggingRef.current = false;
          }}
        />
      </div>
    );
  }
);

WhiteboardMinimap.displayName = "WhiteboardMinimap";

export default WhiteboardMinimap;
