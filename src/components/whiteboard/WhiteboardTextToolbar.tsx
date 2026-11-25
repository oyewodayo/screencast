// components/whiteboard/WhiteboardTextToolbar.tsx
//
// Contextual floating formatting bar shown at top-center whenever a single "text" node is
// selected (or being edited) — gives instant 1-click access to H1/H2/H3/Body presets, font family,
// font size stepper, Bold/Italic/Underline, alignment, text color, and highlight pill backgrounds
// without scrolling the right-hand Style Panel.

import React, { memo } from "react";
import {
  TbAlignCenter,
  TbAlignLeft,
  TbAlignRight,
  TbBold,
  TbItalic,
  TbMinus,
  TbPlus,
  TbUnderline,
} from "react-icons/tb";
import { WHITEBOARD_BLEND_MODES, WhiteboardBlendMode, WhiteboardNode } from "../../utils/whiteboardTypes";
import { computeAutoTextBoxSize } from "../../handlers/whiteboardProHandlers";
import WhiteboardFontPicker from "./WhiteboardFontPicker";

interface WhiteboardTextToolbarProps {
  node: WhiteboardNode;
  offsetRight?: boolean;
  onUpdateNode: (before: WhiteboardNode, after: WhiteboardNode) => void;
}

const TEXT_PRESETS: { label: string; fontSize: number; fontWeight: "normal" | "bold" }[] = [
  { label: "H1", fontSize: 32, fontWeight: "bold" },
  { label: "H2", fontSize: 24, fontWeight: "bold" },
  { label: "H3", fontSize: 18, fontWeight: "bold" },
  { label: "Body", fontSize: 16, fontWeight: "normal" },
];

const QUICK_TEXT_COLORS = ["#111111", "#4b5563", "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#ffffff"];

const QUICK_BG_PILLS: { label: string; bg: string | null; text?: string }[] = [
  { label: "No background", bg: null },
  { label: "Yellow highlight", bg: "#fef08a", text: "#111111" },
  { label: "Blue pill", bg: "#dbeafe", text: "#1e3a8a" },
  { label: "Green pill", bg: "#dcfce7", text: "#14532d" },
  { label: "Soft card", bg: "#f3f4f6", text: "#111111" },
  { label: "Dark badge", bg: "#171717", text: "#ffffff" },
];

const Divider = () => <div className="w-px h-4 bg-gray-200 dark:bg-neutral-700 mx-0.5 shrink-0" />;

const WhiteboardTextToolbar: React.FC<WhiteboardTextToolbarProps> = memo(({ node, offsetRight = false, onUpdateNode }) => {
  if (node.locked) return null;

  const commit = (patch: Partial<WhiteboardNode>, reflow = false) => {
    const merged: WhiteboardNode = { ...node, ...patch, updatedAt: Date.now() };
    if (reflow && merged.text.trim()) {
      const size = computeAutoTextBoxSize(
        merged.text,
        merged.fontSize,
        merged.fontWeight,
        merged.width,
        merged.fontSize > node.fontSize,
        merged.fontFamily
      );
      merged.width = Math.max(merged.width, size.width);
      merged.height = size.height;
    }
    onUpdateNode(node, merged);
  };

  const stepSize = (delta: number) => {
    const next = Math.max(8, Math.min(200, Math.round(node.fontSize + delta)));
    commit({ fontSize: next }, true);
  };

  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: offsetRight ? "calc(50% - 154px)" : "50%" }}
      className="absolute top-3 -translate-x-1/2 z-20 flex items-center gap-0.5 px-2 py-1 rounded-xl bg-white dark:bg-neutral-900 border border-gray-200/90 dark:border-neutral-700/90 shadow-lg max-w-[calc(100%-360px)] overflow-x-auto"
    >
      {/* Typography presets */}
      <div className="flex items-center gap-0.5 shrink-0">
        {TEXT_PRESETS.map((p) => {
          const active = node.fontSize === p.fontSize && node.fontWeight === p.fontWeight;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => commit({ fontSize: p.fontSize, fontWeight: p.fontWeight }, true)}
              className={`h-7 px-1.5 rounded text-[11px] font-semibold transition-colors ${
                active
                  ? "bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400"
                  : "text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700"
              }`}
              title={`${p.label} (${p.fontSize}px)`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <Divider />

      {/* Font family */}
      <WhiteboardFontPicker
        compact
        value={node.fontFamily}
        onChange={(fontFamily) => commit({ fontFamily }, true)}
      />

      <Divider />

      {/* Font size stepper */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          onClick={() => stepSize(-2)}
          title="Decrease font size"
          className="w-6 h-7 rounded flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700"
        >
          <TbMinus size={12} />
        </button>
        <span className="w-7 text-center text-[11px] font-medium tabular-nums text-neutral-700 dark:text-neutral-200 select-none">
          {Math.round(node.fontSize)}
        </span>
        <button
          type="button"
          onClick={() => stepSize(2)}
          title="Increase font size"
          className="w-6 h-7 rounded flex items-center justify-center text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700"
        >
          <TbPlus size={12} />
        </button>
      </div>

      <Divider />

      {/* B / I / U */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          onClick={() => commit({ fontWeight: node.fontWeight === "bold" ? "normal" : "bold" }, true)}
          title="Bold (Ctrl+B)"
          className={`w-7 h-7 rounded flex items-center justify-center ${
            node.fontWeight === "bold"
              ? "bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400"
              : "text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700"
          }`}
        >
          <TbBold size={14} />
        </button>
        <button
          type="button"
          onClick={() => commit({ fontStyle: node.fontStyle === "italic" ? "normal" : "italic" })}
          title="Italic (Ctrl+I)"
          className={`w-7 h-7 rounded flex items-center justify-center ${
            node.fontStyle === "italic"
              ? "bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400"
              : "text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700"
          }`}
        >
          <TbItalic size={14} />
        </button>
        <button
          type="button"
          onClick={() => commit({ textDecoration: node.textDecoration === "underline" ? "none" : "underline" })}
          title="Underline (Ctrl+U)"
          className={`w-7 h-7 rounded flex items-center justify-center ${
            node.textDecoration === "underline"
              ? "bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400"
              : "text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700"
          }`}
        >
          <TbUnderline size={14} />
        </button>
      </div>

      <Divider />

      {/* Horizontal alignment */}
      <div className="flex items-center gap-0.5 shrink-0">
        {(["left", "center", "right"] as const).map((align) => (
          <button
            key={align}
            type="button"
            onClick={() => commit({ textAlign: align })}
            title={`Align ${align}`}
            className={`w-7 h-7 rounded flex items-center justify-center ${
              node.textAlign === align
                ? "bg-blue-50 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400"
                : "text-neutral-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-700"
            }`}
          >
            {align === "left" ? <TbAlignLeft size={14} /> : align === "center" ? <TbAlignCenter size={14} /> : <TbAlignRight size={14} />}
          </button>
        ))}
      </div>

      <Divider />

      {/* Quick text colors */}
      <div className="flex items-center gap-1 px-0.5 shrink-0">
        {QUICK_TEXT_COLORS.map((c) => {
          const active = node.fontColor.toLowerCase() === c;
          return (
            <button
              key={c}
              type="button"
              onClick={() => commit({ fontColor: c })}
              title={`Text color ${c}`}
              className={`w-4 h-4 rounded-full border border-black/20 dark:border-white/25 transition-transform ${
                active ? "ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-neutral-800 scale-110" : "hover:scale-110"
              }`}
              style={{ backgroundColor: c }}
            />
          );
        })}
      </div>

      <Divider />

      {/* Highlight / Pill background */}
      <div className="flex items-center gap-1 px-0.5 shrink-0">
        {QUICK_BG_PILLS.map((pill) => {
          const active = (node.fillColor ?? null) === pill.bg;
          return (
            <button
              key={pill.label}
              type="button"
              onClick={() =>
                commit({
                  fillColor: pill.bg,
                  cornerRadius: pill.bg ? node.cornerRadius || 6 : node.cornerRadius,
                  ...(pill.text && (pill.bg === "#171717" || node.fontColor === "#ffffff") ? { fontColor: pill.text } : {}),
                })
              }
              title={pill.label}
              className={`w-4 h-4 rounded border border-black/20 dark:border-white/25 flex items-center justify-center text-[9px] transition-transform ${
                active ? "ring-2 ring-blue-500 ring-offset-1 dark:ring-offset-neutral-800 scale-110" : "hover:scale-110"
              }`}
              style={{ backgroundColor: pill.bg ?? "transparent" }}
            >
              {pill.bg === null && <span className="text-red-500 font-bold leading-none">/</span>}
            </button>
          );
        })}
      </div>

      <Divider />

      {/* Blend mode */}
      <select
        value={node.blendMode ?? "normal"}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = e.target.value as WhiteboardBlendMode;
          commit({ blendMode: v === "normal" ? undefined : v });
        }}
        title="Blend mode against layers underneath"
        className="h-7 px-1.5 rounded bg-transparent hover:bg-gray-100 dark:hover:bg-neutral-700 text-[11px] text-neutral-700 dark:text-neutral-200 outline-none cursor-pointer shrink-0"
      >
        {WHITEBOARD_BLEND_MODES.map((opt) => (
          <option key={opt.value} value={opt.value} className="bg-white dark:bg-neutral-800">
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
});

WhiteboardTextToolbar.displayName = "WhiteboardTextToolbar";

export default WhiteboardTextToolbar;
