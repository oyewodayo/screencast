// components/video/StageMathPanel.tsx
//
// Editing an equation element: TeX typed with an instant typeset preview beside it (the stage takes
// the change on Enter or leaving the field - one undo step, not one per keystroke), errors said in
// plain words, a palette of the structures and symbols TeX makes hard to remember, part of the
// equation coloured by selecting it and picking a colour, and "rewrite next" - the move that makes
// equations come alive: the next beat, with the equation ready to change into its next form.
import React, { useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { IoArrowForward } from "react-icons/io5";
import { SliderRow, Swatches } from "./OverlayDockedPanels";
import { STAGE_INKS } from "./StagePanelParts";
import { MATH_INK, loadMath } from "../../utils/stage/stageMath";
import { setElementProps } from "../../utils/stage/stageEditing";
import type { StageElement, StageProps, StageScene } from "../../utils/stage/stageTypes";

type Update = (edit: (s: StageScene) => StageScene) => void;

// What the palette inserts: `insert` with "□" marking where the cursor lands (later □ are the next
// slots to fill), shown as `show`.
const PALETTE: { group: string; items: { show: string; insert: string; title: string }[] }[] = [
  {
    group: "Structure",
    items: [
      { show: "\\frac{a}{b}", insert: "\\frac{□}{□}", title: "Fraction" },
      { show: "x^{n}", insert: "^{□}", title: "Power" },
      { show: "x_{i}", insert: "_{□}", title: "Subscript" },
      { show: "\\sqrt{x}", insert: "\\sqrt{□}", title: "Square root" },
      { show: "\\sum_{i}^{n}", insert: "\\sum_{□}^{□}", title: "Sum" },
      { show: "\\int_{a}^{b}", insert: "\\int_{□}^{□}", title: "Integral" },
      { show: "\\left(x\\right)", insert: "\\left(□\\right)", title: "Brackets that grow with what's inside" },
      { show: "\\vec{v}", insert: "\\vec{□}", title: "Vector arrow" },
      { show: "\\hat{x}", insert: "\\hat{□}", title: "Hat" },
      { show: "\\begin{bmatrix}a\\\\b\\end{bmatrix}", insert: "\\begin{bmatrix} □ \\\\ □ \\end{bmatrix}", title: "Column vector" },
      { show: "\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}", insert: "\\begin{bmatrix} □ & □ \\\\ □ & □ \\end{bmatrix}", title: "Matrix" },
      { show: "\\underbrace{x}_{a}", insert: "\\underbrace{□}_{□}", title: "Brace underneath with a label" },
    ],
  },
  {
    group: "Greek",
    items: ["alpha", "beta", "gamma", "delta", "epsilon", "theta", "lambda", "mu", "pi", "sigma", "phi", "omega", "Delta", "Sigma", "nabla", "partial"].map((n) => ({ show: `\\${n}`, insert: `\\${n} `, title: n })),
  },
  {
    group: "Relations",
    items: [
      ["=", "="],
      ["\\neq", "\\neq "],
      ["\\approx", "\\approx "],
      ["\\leq", "\\leq "],
      ["\\geq", "\\geq "],
      ["\\pm", "\\pm "],
      ["\\times", "\\times "],
      ["\\cdot", "\\cdot "],
      ["\\to", "\\to "],
      ["\\Rightarrow", "\\Rightarrow "],
      ["\\infty", "\\infty "],
      ["\\cdots", "\\cdots "],
    ].map(([show, insert]) => ({ show, insert, title: show.replace("\\", "") })),
  },
];

const TERM_COLOURS = ["#58c4dd", "#fc6255", "#83c167", "#ffff00", "#ff862f", "#9a72ac", "#e8e8e8"];

// Empty slots ({} left by the palette) shown as faint boxes - where to type next.
const showSlots = (tex: string) => tex.replace(/\{\s*\}/g, "{\\color{#6b7280}{\\square}}");

// TeX typeset to HTML for a preview, or the error it hits, said plainly.
function typeset(raw: string): { html: string; error?: string } {
  const tex = showSlots(raw);
  try {
    return { html: katex.renderToString(tex || "\\;", { throwOnError: true, displayMode: true, output: "html", strict: false }) };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const plain = raw
      .replace(/^KaTeX parse error:\s*/, "")
      .replace(/Expected '(.+?)', got 'EOF'.*/, "Missing a closing $1")
      .replace(/Undefined control sequence: (\\\S+).*/, "$1 isn't a command TeX knows")
      .replace(/ at position \d+.*$/, "");
    return { html: katex.renderToString(tex || "\\;", { throwOnError: false, displayMode: true, output: "html", strict: false }), error: plain };
  }
}

export const MathEditor: React.FC<{
  scene: StageScene;
  beat: number;
  element: StageElement;
  here: StageProps;
  onUpdate: Update;
  onRewriteNext: () => void;
}> = ({ scene, beat, element, here, onUpdate, onRewriteNext }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const tex = draft ?? here.text ?? "";
  const preview = useMemo(() => typeset(tex), [tex]);
  const size = element.textLook?.fontSize ?? 64;
  useEffect(() => setDraft(null), [element.id, beat]);
  // Double-clicking the equation on the stage comes here.
  useEffect(() => {
    const focus = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== element.id) return;
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("stage-edit-math", focus);
    return () => window.removeEventListener("stage-edit-math", focus);
  }, [element.id]);

  // The box fitted to the typeset equation, keeping its centre where it was.
  const fit = (nextTex: string, nextSize = size) => {
    void loadMath(nextTex, nextSize, MATH_INK).then((l) => {
      const w = l.width + 32;
      const h = l.height + 24;
      onUpdate((s) => {
        const e = s.elements.find((x) => x.id === element.id);
        if (!e) return s;
        return setElementProps(s, beat, element.id, { width: w, height: h, x: here.x + (here.width - w) / 2, y: here.y + (here.height - h) / 2 });
      });
    });
  };
  const commit = () => {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    if (next === (here.text ?? "")) return;
    onUpdate((s) => setElementProps(s, beat, element.id, { text: next }));
    fit(next);
  };

  // Puts `snippet` at the cursor (replacing a selection), the cursor landing on its first □.
  const insert = (snippet: string) => {
    const el = ref.current;
    const current = tex;
    const a = el ? el.selectionStart : current.length;
    const b = el ? el.selectionEnd : current.length;
    const chosen = current.slice(a, b);
    // A selection fills the first slot: select "x", press √, get \sqrt{x}.
    let piece = snippet;
    if (chosen && piece.includes("□")) piece = piece.replace("□", chosen);
    const firstSlot = piece.indexOf("□");
    const clean = piece.replace(/□/g, "");
    const next = current.slice(0, a) + clean + current.slice(b);
    setDraft(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const caret = a + (firstSlot >= 0 && !chosen ? firstSlot : clean.length);
      el.setSelectionRange(caret, caret);
    });
  };
  // The selected part of the TeX coloured - just that part: \textcolor scopes to its argument, where
  // \color would switch the colour for everything after it too.
  const colourSelection = (colour: string) => {
    const el = ref.current;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    if (a === b) return;
    const next = `${tex.slice(0, a)}\\textcolor{${colour}}{${tex.slice(a, b)}}${tex.slice(b)}`;
    setDraft(null);
    onUpdate((s) => setElementProps(s, beat, element.id, { text: next }));
    fit(next);
  };
  const hasSelection = () => !!ref.current && ref.current.selectionStart !== ref.current.selectionEnd;
  const [, force] = useState(0);
  const laterBeats = scene.beats.length - 1 - beat;

  return (
    <>
      {/* The equation typeset as you type it. */}
      <div
        className="min-h-[52px] max-h-40 overflow-auto rounded-md bg-black/40 ring-1 ring-white/10 px-2 py-2 text-white text-[15px] flex items-center justify-center [&_.katex-display]:m-0"
        // KaTeX output, generated from the user's own TeX with trust off - no scripts, no links.
        dangerouslySetInnerHTML={{ __html: preview.html }}
      />
      <textarea
        ref={ref}
        value={tex}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onSelect={() => force((n) => n + 1)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") setDraft(null);
        }}
        rows={2}
        placeholder="Type TeX - e.g. \frac{a}{b} or x^2 + y^2 = r^2"
        className="w-full resize-y rounded-md bg-black/30 ring-1 ring-white/10 focus:ring-teal-400 px-2 py-1.5 font-mono text-[12px] text-white outline-none placeholder:text-white/30"
      />
      {preview.error ? (
        <span className="-mt-1 text-[11px] text-red-300">{preview.error}</span>
      ) : (
        <span className="-mt-1 text-[10px] text-white/35">Enter puts it on the stage. Select part of it to colour just that part.</span>
      )}
      <div className="flex flex-col gap-1.5">
        {PALETTE.map((g) => (
          <div key={g.group} className="flex flex-col gap-1">
            <span className="text-[10px] text-white/40">{g.group}</span>
            <div className="grid grid-cols-6 gap-1">
              {g.items.map((it) => (
                <button
                  key={it.insert}
                  type="button"
                  title={it.title}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insert(it.insert)}
                  className="h-8 flex items-center justify-center rounded-md bg-white/[0.05] hover:bg-teal-500/30 text-white text-[11px] overflow-hidden [&_.katex-display]:m-0 [&_.katex]:text-[11px]"
                  dangerouslySetInnerHTML={{ __html: katex.renderToString(it.show, { throwOnError: false, output: "html" }) }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-white/60">{hasSelection() ? "Colour the selected part" : "Colour part of it - select it above first"}</span>
        <div className={`flex gap-1.5 ${hasSelection() ? "" : "opacity-40 pointer-events-none"}`}>
          {TERM_COLOURS.map((c) => (
            <button key={c} type="button" title={c} onMouseDown={(e) => e.preventDefault()} onClick={() => colourSelection(c)} className="w-6 h-6 rounded-full ring-1 ring-white/25 hover:scale-110 transition-transform" style={{ background: c }} />
          ))}
        </div>
      </div>
      <span className="text-[11px] text-white/60">Ink</span>
      <Swatches colors={["#ffffff", ...STAGE_INKS.filter((c) => c !== "#ffffff")]} value={here.color} onPick={(c) => c && onUpdate((s) => setElementProps(s, beat, element.id, { color: c }))} custom />
      <SliderRow
        label="Size"
        value={size}
        min={16}
        max={220}
        step={1}
        format={(v) => `${Math.round(v)}`}
        reset={64}
        onChange={(v) => {
          onUpdate((s) => ({ ...s, elements: s.elements.map((e) => (e.id === element.id ? { ...e, textLook: { ...(e.textLook ?? { fontSize: 64 }), fontSize: v } } : e)) }));
          fit(here.text ?? "", v);
        }}
      />
      <button
        type="button"
        onClick={onRewriteNext}
        title="Go to the next beat (adding one if needed) to change this equation there - it rewrites itself, matching symbols gliding into place"
        className="flex items-center justify-center gap-1.5 rounded-md bg-teal-500/20 hover:bg-teal-500/35 px-2 py-2 text-[12px] text-teal-50"
      >
        Rewrite it in {laterBeats > 0 ? `beat ${beat + 2}` : "a new beat"} <IoArrowForward size={13} />
      </button>
    </>
  );
};
