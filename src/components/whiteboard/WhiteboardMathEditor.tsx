// components/whiteboard/WhiteboardMathEditor.tsx
//
// Rich Scene-grade LaTeX Maths editor embedded at the top of WhiteboardStylePanel when an
// "equation" node is selected. Renders on the Whiteboard canvas in REALTIME on every keystroke
// (via onPreview, zero undo spam) and commits cleanly on debounce / blur / Ctrl+Enter — while
// palette button clicks, presets, and term-colour actions commit immediately without snap-back.

import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import katex from "katex";
import { WhiteboardNode } from "../../utils/whiteboardTypes";

// `«...»` marks the first editable default token: for wrapping structures (`wrap: true`), if the
// user highlighted part of an expression before clicking, the highlighted text replaces `«...»`;
// otherwise the default value stays visible immediately on the canvas and gets auto-selected in
// the textarea so typing replaces it cleanly.
type MathPaletteItem = { show: string; insert: string; title: string; wrap?: boolean };

const MATH_PALETTE: { group: string; items: MathPaletteItem[] }[] = [
  {
    group: "Structure",
    items: [
      { show: "\\frac{a}{b}", insert: "\\frac{«a»}{b}", title: "Fraction", wrap: true },
      { show: "x^{n}", insert: "^{«n»}", title: "Power / Superscript" },
      { show: "x_{i}", insert: "_{«i»}", title: "Subscript" },
      { show: "\\sqrt{x}", insert: "\\sqrt{«x»}", title: "Square root", wrap: true },
      { show: "\\sum_{i=1}^{n}", insert: "\\sum_{«i=1»}^{n}", title: "Summation" },
      { show: "\\int_{a}^{b}", insert: "\\int_{«a»}^{b}", title: "Integral" },
      { show: "\\left(x\\right)", insert: "\\left(«x»\\right)", title: "Auto-sizing brackets", wrap: true },
      { show: "\\vec{v}", insert: "\\vec{«v»}", title: "Vector arrow", wrap: true },
      { show: "\\hat{x}", insert: "\\hat{«x»}", title: "Hat", wrap: true },
      { show: "\\underbrace{x}_{a}", insert: "\\underbrace{«x»}_{a}", title: "Underbrace with label", wrap: true },
      { show: "\\begin{bmatrix}a\\\\b\\end{bmatrix}", insert: "\\begin{bmatrix} «a» \\\\ b \\end{bmatrix}", title: "Column vector" },
      { show: "\\begin{cases}x\\\\-x\\end{cases}", insert: "\\begin{cases} «x» & x \\ge 0 \\\\ -x & x < 0 \\end{cases}", title: "Piecewise cases" },
      { show: "\\frac{dy}{dx}", insert: "\\frac{d«y»}{dx}", title: "Derivative (dy/dx)", wrap: true },
      { show: "\\frac{d^2y}{dx^2}", insert: "\\frac{d^{2}«y»}{dx^{2}}", title: "Second derivative (d²y/dx²)", wrap: true },
      { show: "\\frac{\\partial f}{\\partial x}", insert: "\\frac{\\partial «f»}{\\partial x}", title: "Partial derivative (∂f/∂x)", wrap: true },
      { show: "\\frac{\\partial^2 f}{\\partial x^2}", insert: "\\frac{\\partial^{2} «f»}{\\partial x^{2}}", title: "Second partial derivative (∂²f/∂x²)", wrap: true },
      { show: "\\frac{\\partial^2}{\\partial x\\partial y}", insert: "\\frac{\\partial^{2} «f»}{\\partial x \\partial y}", title: "Mixed partial derivative (∂²f/∂x∂y)", wrap: true },
      { show: "\\mathrm{d}x", insert: "\\mathrm{d}«x»", title: "Differential (dx)", wrap: true },
    ],
  },
  {
    group: "Matrices",
    items: [
      {
        show: "\\text{2×2}",
        insert: "\\begin{bmatrix} «a» & b \\\\ c & d \\end{bmatrix}",
        title: "2×2 Matrix",
      },
      {
        show: "\\text{3×3}",
        insert: "\\begin{bmatrix} «a» & b & c \\\\ d & e & f \\\\ g & h & i \\end{bmatrix}",
        title: "3×3 Matrix",
      },
      {
        show: "\\text{4×4}",
        insert: "\\begin{bmatrix} «1» & 0 & 0 & 0 \\\\ 0 & 1 & 0 & 0 \\\\ 0 & 0 & 1 & 0 \\\\ 0 & 0 & 0 & 1 \\end{bmatrix}",
        title: "4×4 Matrix",
      },
      {
        show: "|A|_{2}",
        insert: "\\begin{vmatrix} «a» & b \\\\ c & d \\end{vmatrix}",
        title: "2×2 Determinant",
      },
      {
        show: "|A|_{3}",
        insert: "\\begin{vmatrix} «a» & b & c \\\\ d & e & f \\\\ g & h & i \\end{vmatrix}",
        title: "3×3 Determinant",
      },
      {
        show: "\\begin{pmatrix}a\\\\b\\end{pmatrix}",
        insert: "\\begin{pmatrix} «a» & b \\\\ c & d \\end{pmatrix}",
        title: "Parenthesized 2×2 Matrix",
      },
    ],
  },
  {
    group: "Greek",
    items: [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "zeta",
      "eta",
      "theta",
      "kappa",
      "lambda",
      "mu",
      "nu",
      "xi",
      "pi",
      "rho",
      "sigma",
      "tau",
      "phi",
      "chi",
      "psi",
      "omega",
      "varepsilon",
      "varphi",
      "Gamma",
      "Delta",
      "Lambda",
      "Sigma",
      "Phi",
      "Psi",
      "Omega",
    ].map((n) => ({ show: `\\${n}`, insert: `\\${n} `, title: n })),
  },
  {
    group: "Physics",
    items: [
      { show: "\\hbar", insert: "\\hbar ", title: "Reduced Planck constant (hbar)" },
      { show: "\\nabla", insert: "\\nabla ", title: "Nabla / Del operator" },
      { show: "\\partial", insert: "\\partial ", title: "Partial symbol" },
      { show: "\\dagger", insert: "\\dagger ", title: "Dagger / Hermitian conjugate" },
      { show: "\\langle\\psi|", insert: "\\langle «\\psi» |", title: "Bra vector", wrap: true },
      { show: "|\\psi\\rangle", insert: "| «\\psi» \\rangle", title: "Ket vector", wrap: true },
      { show: "\\langle a|b\\rangle", insert: "\\langle «\\phi» | \\psi \\rangle", title: "Bra-ket inner product" },
      { show: "\\bar{\\psi}", insert: "\\bar{«\\psi»}", title: "Bar / Dirac adjoint", wrap: true },
      { show: "\\dot{x}", insert: "\\dot{«x»}", title: "Time derivative (dot)", wrap: true },
      { show: "\\ddot{x}", insert: "\\ddot{«x»}", title: "Second time derivative (double dot)", wrap: true },
      { show: "\\otimes", insert: "\\otimes ", title: "Tensor product" },
      { show: "\\oint", insert: "\\oint_{«C»} ", title: "Contour / closed integral" },
    ],
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
      ["\\propto", "\\propto "],
      ["\\equiv", "\\equiv "],
      ["\\sim", "\\sim "],
      ["\\perp", "\\perp "],
      ["\\parallel", "\\parallel "],
      ["\\in", "\\in "],
    ].map(([show, insert]) => ({ show, insert, title: show.replace("\\", "") })),
  },
];

const QUICK_PRESETS: { label: string; tex: string }[] = [
  { label: "Line", tex: "y = mx + b" },
  { label: "Quadratic", tex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}" },
  { label: "Relativity", tex: "E = mc^2" },
  { label: "Integral", tex: "\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}" },
  { label: "Schrödinger", tex: "i\\hbar \\frac{\\partial \\psi}{\\partial t} = \\hat{H}\\psi" },
];

const TERM_COLOURS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#ec4899", "#111827"];

const showSlots = (tex: string) => tex.replace(/\{\s*\}/g, "{\\color{#9ca3af}{\\square}}");

function typesetPreview(raw: string): { html: string; error?: string } {
  const tex = showSlots(raw);
  try {
    return {
      html: katex.renderToString(tex || "\\;", {
        throwOnError: true,
        displayMode: true,
        output: "html",
        strict: false,
      }),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const plain = msg
      .replace(/^KaTeX parse error:\s*/, "")
      .replace(/Expected '(.+?)', got 'EOF'.*/, "Missing closing $1")
      .replace(/Undefined control sequence: (\\\S+).*/, "$1 is not a known TeX command")
      .replace(/ at position \d+.*$/, "");
    return {
      html: katex.renderToString(tex || "\\;", {
        throwOnError: false,
        displayMode: true,
        output: "html",
        strict: false,
      }),
      error: plain,
    };
  }
}

interface WhiteboardMathEditorProps {
  node: WhiteboardNode;
  onCommit: (patch: Partial<WhiteboardNode>) => void;
  onPreview?: (patch: Partial<WhiteboardNode> | null) => void;
}

const WhiteboardMathEditor: React.FC<WhiteboardMathEditorProps> = memo(({ node, onCommit, onPreview }) => {
  const [draft, setDraft] = useState<string>(node.text);
  const [, bumpSelection] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedRef = useRef<string>(node.text);
  const isPreviewingRef = useRef<boolean>(false);
  const latestDraftRef = useRef<string>(node.text);
  const nodeIdRef = useRef<string>(node.id);

  // Sync draft when switching to a different equation node or on external undo/redo — NEVER
  // overwrite lastCommittedRef with our own in-flight preview echo!
  useEffect(() => {
    if (nodeIdRef.current !== node.id) {
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
      isPreviewingRef.current = false;
      nodeIdRef.current = node.id;
      lastCommittedRef.current = node.text;
      latestDraftRef.current = node.text;
      setDraft(node.text);
      return;
    }
    if (!isPreviewingRef.current && node.text !== lastCommittedRef.current) {
      lastCommittedRef.current = node.text;
      latestDraftRef.current = node.text;
      setDraft(node.text);
    }
  }, [node.id, node.text]);

  // Focus & select when freshly dropped via the Maths tool button
  useEffect(() => {
    const onFocusMath = (e: Event) => {
      const targetId = (e as CustomEvent<string>).detail;
      if (targetId && targetId !== node.id) return;
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.select();
      });
    };
    window.addEventListener("wb-focus-math", onFocusMath);
    return () => window.removeEventListener("wb-focus-math", onFocusMath);
  }, [node.id]);

  // Flush any pending debounced edit if the panel unmounts mid-typing
  useEffect(() => {
    return () => {
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
      }
      if (isPreviewingRef.current && latestDraftRef.current !== lastCommittedRef.current) {
        isPreviewingRef.current = false;
        onCommit({ text: latestDraftRef.current });
        onPreview?.(null);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const preview = useMemo(() => typesetPreview(draft), [draft]);

  const commitImmediately = (nextTex: string) => {
    if (commitTimerRef.current) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    latestDraftRef.current = nextTex;
    setDraft(nextTex);
    const changed = nextTex !== lastCommittedRef.current;
    lastCommittedRef.current = nextTex;
    isPreviewingRef.current = false;
    if (changed) {
      onCommit({ text: nextTex });
    }
    onPreview?.(null);
  };

  // Realtime canvas preview on every keystroke + debounced undo commit
  const handleLiveChange = (nextTex: string) => {
    latestDraftRef.current = nextTex;
    setDraft(nextTex);
    isPreviewingRef.current = true;
    onPreview?.({ text: nextTex });
    if (commitTimerRef.current) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitImmediately(nextTex);
    }, 450);
  };

  // Palette button clicks commit immediately with clean default values, auto-selecting the first
  // editable placeholder token so typing immediately replaces it.
  const insertSnippet = (item: MathPaletteItem) => {
    const snippet = item.insert;
    const el = textareaRef.current;
    const current = latestDraftRef.current;
    const a = el ? el.selectionStart : current.length;
    const b = el ? el.selectionEnd : current.length;
    const chosen = current.slice(a, b);
    const isFreshStarter = chosen === current && current.trim() === "y = mx + b";
    const slotMatch = /«([^»]*)»/.exec(snippet);
    let clean = snippet;
    let selStart = a;
    let selEnd = a;

    // For power/subscript (`^{«n»}` / `_{«i»}`), keep a highlighted base or supply `x` when
    // inserting into an empty spot so KaTeX immediately shows `x^n` / `x_i`.
    if ((snippet === "^{«n»}" || snippet === "_{«i»}") && slotMatch) {
      const op = snippet[0];
      const defaultToken = slotMatch[1];
      const charBefore = a > 0 ? current[a - 1] : "";
      const hasBaseBefore = /[A-Za-z0-9)\]}]/.test(charBefore);
      const base = chosen && !isFreshStarter ? chosen : hasBaseBefore ? "" : "x";
      clean = `${base}${op}{${defaultToken}}`;
      selStart = a + base.length + 2;
      selEnd = selStart + defaultToken.length;
    } else if (slotMatch) {
      const slotIndex = slotMatch.index;
      if (item.wrap && chosen && !isFreshStarter) {
        clean = snippet.slice(0, slotIndex) + chosen + snippet.slice(slotIndex + slotMatch[0].length);
        selStart = a + clean.length;
        selEnd = selStart;
      } else {
        const defaultToken = slotMatch[1];
        clean = snippet.slice(0, slotIndex) + defaultToken + snippet.slice(slotIndex + slotMatch[0].length);
        selStart = a + slotIndex;
        selEnd = selStart + defaultToken.length;
      }
    } else {
      selStart = a + clean.length;
      selEnd = selStart;
    }

    const next = current.slice(0, a) + clean + current.slice(b);
    commitImmediately(next);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart, selEnd);
    });
  };

  const colourSelection = (hex: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const a = el.selectionStart;
    const b = el.selectionEnd;
    if (a === b) return;
    const current = latestDraftRef.current;
    const wrapped = `\\textcolor{${hex}}{${current.slice(a, b)}}`;
    const next = `${current.slice(0, a)}${wrapped}${current.slice(b)}`;
    commitImmediately(next);
    requestAnimationFrame(() => {
      el.focus();
      const endPos = a + wrapped.length;
      el.setSelectionRange(endPos, endPos);
    });
  };

  const hasSelection = Boolean(textareaRef.current && textareaRef.current.selectionStart !== textareaRef.current.selectionEnd);

  return (
    <div className="flex flex-col gap-2">
      {/* Live KaTeX Preview */}
      <div
        className="min-h-[48px] max-h-32 overflow-auto rounded-lg bg-black/[0.03] dark:bg-white/[0.04] ring-1 ring-black/[0.07] dark:ring-white/[0.08] px-2.5 py-2 flex items-center justify-center [&_.katex-display]:m-0"
        style={{ color: node.fontColor, fontSize: 15 }}
        dangerouslySetInnerHTML={{ __html: preview.html }}
      />

      {/* Realtime LaTeX Input */}
      <textarea
        ref={textareaRef}
        value={draft}
        spellCheck={false}
        onChange={(e) => handleLiveChange(e.target.value)}
        onBlur={() => commitImmediately(latestDraftRef.current)}
        onSelect={() => bumpSelection((n) => n + 1)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            commitImmediately(latestDraftRef.current);
          } else if (e.key === "Escape") {
            e.preventDefault();
            commitImmediately(latestDraftRef.current);
            textareaRef.current?.blur();
          }
        }}
        rows={3}
        placeholder="Type LaTeX — e.g. \frac{a}{b} or x^2 + y^2 = r^2"
        className="w-full resize-y rounded-lg bg-black/[0.035] dark:bg-white/[0.05] ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.1] focus:ring-blue-500 px-2.5 py-1.5 font-mono text-[12px] text-neutral-900 dark:text-neutral-100 outline-none placeholder:text-neutral-400"
      />

      {preview.error ? (
        <span className="-mt-1 text-[11px] text-red-500 dark:text-red-400 leading-snug">{preview.error}</span>
      ) : (
        <span className="-mt-1 text-[10px] text-neutral-400 dark:text-neutral-500">
          Renders live on the canvas as you type. Select any part to colour it.
        </span>
      )}

      {/* Quick Formula Starters */}
      <div className="flex flex-wrap gap-1">
        {QUICK_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => commitImmediately(p.tex)}
            className="h-5 px-1.5 rounded text-[10px] font-medium bg-black/[0.04] dark:bg-white/[0.06] hover:bg-blue-500/15 hover:text-blue-600 dark:hover:text-blue-300 text-neutral-600 dark:text-neutral-300 transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Structure / Greek / Relations Palette */}
      <div className="flex flex-col gap-1.5">
        {MATH_PALETTE.map((g) => (
          <div key={g.group} className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
              {g.group}
            </span>
            <div className="grid grid-cols-6 gap-1">
              {g.items.map((it) => (
                <button
                  key={it.insert}
                  type="button"
                  title={it.title}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertSnippet(it)}
                  className="h-7 flex items-center justify-center rounded-md bg-black/[0.04] dark:bg-white/[0.06] hover:bg-blue-500/20 hover:text-blue-700 dark:hover:text-blue-300 text-neutral-800 dark:text-neutral-100 text-[11px] overflow-hidden transition-colors [&_.katex-display]:m-0 [&_.katex]:text-[11px]"
                  dangerouslySetInnerHTML={{
                    __html: katex.renderToString(it.show, { throwOnError: false, output: "html", strict: false }),
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Colour selected term */}
      <div className="flex flex-col gap-1 pt-0.5">
        <span className="text-[10px] text-neutral-500 dark:text-neutral-400">
          {hasSelection ? "Colour selected part" : "Colour part of equation — highlight text above first"}
        </span>
        <div className={`flex items-center gap-1.5 ${hasSelection ? "" : "opacity-40 pointer-events-none"}`}>
          {TERM_COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              title={`Colour selection ${c}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => colourSelection(c)}
              className="w-5 h-5 rounded-full ring-1 ring-inset ring-black/20 dark:ring-white/25 hover:scale-110 transition-transform"
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

WhiteboardMathEditor.displayName = "WhiteboardMathEditor";

export default WhiteboardMathEditor;
