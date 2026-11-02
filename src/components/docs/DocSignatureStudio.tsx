// components/docs/DocSignatureStudio.tsx
//
// Making a signature to put on the document - three ways, plus the ones saved before:
//   Draw   - a signing pad with real-pen ink (utils/signatureInk.ts): width follows a stylus's
//            pressure, or the speed of a mouse or finger, with tapered ends. Undo / clear.
//   Type   - the name set in handwriting faces, bundled so they work offline
//   Upload - a photo or scan of a signature on paper (pick, drop or paste); the paper is lifted
//            off (utils/signatureBackground.ts) with a before/after wipe to check the result
// "Place signature" hands back a transparent PNG and its size on the page; DocsEditor then saves
// it into the document's assets and DocSignaturePlacer lets you drop it anywhere - settling onto a
// signing line when you're near one.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { MdClose, MdOutlineDraw, MdOutlineFileUpload, MdRedo, MdTextFields, MdUndo } from "react-icons/md";
import { drawStroke, drawStrokes, strokesToPng, type InkPoint, type InkStroke } from "../../utils/signatureInk";
import { analyze, lift, type LiftAnalysis } from "../../utils/signatureBackground";
import { deleteSignature, loadSignatures, loadSignerName, saveSignature, saveSignerName, type SavedSignature } from "./signatureStore";
import "./docSignature.css";

export interface SignatureResult {
  blob: Blob;
  width: number; // CSS px on the page
  height: number;
  signer: string | null;
}

interface Props {
  onPlace: (sig: SignatureResult) => void;
  onClose: () => void;
}

type Tab = "draw" | "type" | "upload";

const INKS = [
  { id: "black", label: "Black", color: "#111827" },
  { id: "blue", label: "Blue ink", color: "#1f3fae" },
  { id: "navy", label: "Royal blue", color: "#0b3d91" },
];
const NIBS = [
  { id: "fine", label: "Fine", size: 2.4 },
  { id: "medium", label: "Medium", size: 3.6 },
  { id: "bold", label: "Bold", size: 5.4 },
];
const SIGNATURE_FONTS = [
  { family: "Mrs Saint Delafield", scale: 1.25 },
  { family: "Herr Von Muellerhoff", scale: 1.25 },
  { family: "Alex Brush", scale: 1.0 },
  { family: "La Belle Aurore", scale: 0.95 },
  { family: "Sacramento", scale: 1.1 },
  { family: "Great Vibes", scale: 1.0 },
  { family: "Dancing Script", scale: 0.95 },
  { family: "Caveat", scale: 1.0 },
];

// On the page a signature is about the size of a pen signature on a form: ~1.9in wide at most,
// ~0.6in tall.
const MAX_W = 190;
const MAX_H = 64;
const fitOnPage = (w: number, h: number) => {
  const s = Math.min(MAX_W / w, MAX_H / h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
};

const PAD_W = 560;
const PAD_H = 210;

const canvasToBlob = (c: HTMLCanvasElement) => new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
const blobToDataUrl = (b: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

// ------------------------------------------------------------------------------------------------
// Draw

const DrawPad: React.FC<{ strokes: InkStroke[]; setStrokes: (s: InkStroke[]) => void; ink: string; nib: number }> = ({ strokes, setStrokes, ink, nib }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<InkStroke | null>(null);
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const rafRef = useRef<number | null>(null);

  const paint = useCallback(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, PAD_W, PAD_H);
    drawStrokes(ctx, strokesRef.current, { size: nib, color: ink });
    if (liveRef.current) drawStroke(ctx, liveRef.current, { size: nib, color: ink }, false);
  }, [ink, nib]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = PAD_W * dpr;
    c.height = PAD_H * dpr;
    paint();
  }, [paint, strokes]);

  const point = (e: PointerEvent | React.PointerEvent, rect: DOMRect): InkPoint => ({
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    t: e.timeStamp,
    p: e.pointerType === "pen" ? e.pressure || 0.5 : 0.5,
  });

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full touch-none cursor-crosshair"
      style={{ width: PAD_W, height: PAD_H }}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const rect = e.currentTarget.getBoundingClientRect();
        liveRef.current = { pen: e.pointerType === "pen", points: [point(e, rect)] };
        paint();
      }}
      onPointerMove={(e) => {
        const live = liveRef.current;
        if (!live) return;
        const rect = e.currentTarget.getBoundingClientRect();
        // Coalesced events: every sample the device produced since the last frame, not just one -
        // fast curves stay round instead of turning into polygons.
        const native = e.nativeEvent as PointerEvent;
        const events = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
        for (const ev of events.length ? events : [native]) live.points.push(point(ev, rect));
        if (rafRef.current == null)
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            paint();
          });
      }}
      onPointerUp={() => {
        const live = liveRef.current;
        liveRef.current = null;
        if (live && live.points.length) setStrokes([...strokesRef.current, live]);
      }}
      onPointerCancel={() => {
        liveRef.current = null;
        paint();
      }}
    />
  );
};

// ------------------------------------------------------------------------------------------------
// Upload

interface UploadState {
  name: string;
  preview: ImageData; // the source at preview size
  analysis: LiftAnalysis;
  full: () => ImageData; // the source at full working size, for the final lift
}

const PREVIEW_MAX = 900;
const FULL_MAX = 2000;

async function decodeToImageData(blob: Blob, maxSide: number): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s));
  const h = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return ctx.getImageData(0, 0, w, h);
}

// ------------------------------------------------------------------------------------------------

const DocSignatureStudio: React.FC<Props> = ({ onPlace, onClose }) => {
  const [saved, setSaved] = useState<SavedSignature[]>(() => loadSignatures());
  const [tab, setTab] = useState<Tab>("draw");
  const [ink, setInk] = useState(INKS[0].color);
  const [nib, setNib] = useState(NIBS[1].size);
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [undone, setUndone] = useState<InkStroke[]>([]);
  const [name, setName] = useState(() => loadSignerName());
  const [font, setFont] = useState(SIGNATURE_FONTS[0].family);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [liftOn, setLiftOn] = useState(true);
  const [strength, setStrength] = useState(0.5);
  const [inkMode, setInkMode] = useState<"original" | "black" | "blue">("original");
  const [wipe, setWipe] = useState(0.5);
  const [dragOver, setDragOver] = useState(false);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const beforeRef = useRef<HTMLCanvasElement>(null);

  // Handwriting faces are fetched on first use; load them all so the Type cards render in their
  // own faces straight away (and the canvas render below never falls back to a default font).
  useEffect(() => {
    void import("./docSignatureFonts.css");
  }, []);
  useEffect(() => {
    if (tab !== "type") return;
    void Promise.all(SIGNATURE_FONTS.map((f) => document.fonts.load(`48px "${f.family}"`).catch(() => undefined)));
  }, [tab]);

  const inkColor = inkMode === "black" ? INKS[0].color : inkMode === "blue" ? INKS[1].color : null;

  // Live lift preview.
  useEffect(() => {
    if (!upload) return;
    const { preview, analysis } = upload;
    const out = liftOn ? lift(analysis, { strength, color: inkColor, despeckle: true }).data : preview.data;
    const draw = (c: HTMLCanvasElement | null, data: Uint8ClampedArray) => {
      if (!c) return;
      c.width = preview.width;
      c.height = preview.height;
      c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data), preview.width, preview.height), 0, 0);
    };
    draw(previewRef.current, out);
    draw(beforeRef.current, preview.data);
    // `tab`: the canvases only exist on the Upload tab - redraw once they mount.
  }, [upload, liftOn, strength, inkColor, tab]);

  const loadUpload = useCallback(async (blob: Blob, label: string) => {
    setUploadError(null);
    try {
      const preview = await decodeToImageData(blob, PREVIEW_MAX);
      const analysis = analyze(preview);
      let fullCache: ImageData | null = null;
      const fullPromise = decodeToImageData(blob, FULL_MAX).then((d) => (fullCache = d));
      setTab("upload");
      setWipe(0.5);
      setUpload({
        name: label,
        preview,
        analysis,
        full: () => {
          if (!fullCache) throw new Error("still decoding");
          return fullCache;
        },
      });
      await fullPromise;
    } catch (err) {
      console.error("Failed to read signature image:", err);
      setUploadError("That file couldn’t be read as an image. Try a PNG or JPEG.");
    }
  }, []);

  const pickFile = async () => {
    const picked = await openFileDialog({ multiple: false, filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }] });
    if (!picked || Array.isArray(picked)) return;
    const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path: picked });
    await loadUpload(new Blob([bytes]), picked.split(/[\\/]/).pop() ?? "image");
  };

  // Paste a signature image from the clipboard while the studio is open.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      void loadUpload(file, file.name || "Pasted image");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [loadUpload]);

  const undo = useCallback(() => {
    setStrokes((s) => {
      if (!s.length) return s;
      setUndone((u) => [...u, s[s.length - 1]]);
      return s.slice(0, -1);
    });
  }, []);
  const redo = useCallback(() => {
    setUndone((u) => {
      if (!u.length) return u;
      setStrokes((s) => [...s, u[u.length - 1]]);
      return u.slice(0, -1);
    });
  }, []);

  const canPlace = tab === "draw" ? strokes.length > 0 : tab === "type" ? name.trim().length > 0 : !!upload;

  const produce = async (): Promise<SignatureResult | null> => {
    const signer = name.trim() || null;
    if (tab === "draw") {
      const png = await strokesToPng(strokes, { size: nib, color: ink }, 3);
      if (!png) return null;
      return { blob: png.blob, ...fitOnPage(png.width, png.height), signer };
    }
    if (tab === "type") {
      const f = SIGNATURE_FONTS.find((x) => x.family === font) ?? SIGNATURE_FONTS[0];
      const px = Math.round(110 * f.scale);
      await document.fonts.load(`${px}px "${f.family}"`).catch(() => undefined);
      const text = name.trim();
      const probe = document.createElement("canvas").getContext("2d")!;
      probe.font = `${px}px "${f.family}"`;
      const m = probe.measureText(text);
      // Script faces swash far past their advance width; measure the real ink box.
      const left = Math.ceil(m.actualBoundingBoxLeft) + px * 0.15;
      const w = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight + px * 0.3);
      const asc = Math.ceil(m.actualBoundingBoxAscent + px * 0.12);
      const h = Math.ceil(asc + m.actualBoundingBoxDescent + px * 0.12);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      ctx.font = `${px}px "${f.family}"`;
      ctx.fillStyle = ink;
      ctx.fillText(text, left, asc);
      const blob = await canvasToBlob(c);
      if (!blob) return null;
      // Typed at ~110px; on the page the text is drawn at a normal signature height.
      const size = fitOnPage(w, h);
      return { blob, ...size, signer };
    }
    if (upload) {
      let src: ImageData;
      try {
        src = upload.full();
      } catch {
        src = upload.preview;
      }
      const analysis = src === upload.preview ? upload.analysis : analyze(src);
      const result = liftOn ? lift(analysis, { strength, color: inkColor, despeckle: true }) : { data: src.data, bounds: { left: 0, top: 0, right: src.width - 1, bottom: src.height - 1 } };
      const b = result.bounds;
      if (!b) return null;
      const pad = Math.round(Math.max(src.width, src.height) * 0.012) + 2;
      const x0 = Math.max(0, b.left - pad);
      const y0 = Math.max(0, b.top - pad);
      const x1 = Math.min(src.width, b.right + pad + 1);
      const y1 = Math.min(src.height, b.bottom + pad + 1);
      const full = document.createElement("canvas");
      full.width = src.width;
      full.height = src.height;
      full.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(result.data), src.width, src.height), 0, 0);
      const crop = document.createElement("canvas");
      crop.width = x1 - x0;
      crop.height = y1 - y0;
      crop.getContext("2d")!.drawImage(full, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);
      const blob = await canvasToBlob(crop);
      if (!blob) return null;
      return { blob, ...fitOnPage(crop.width, crop.height), signer };
    }
    return null;
  };

  const place = async () => {
    if (!canPlace || busy) return;
    setBusy(true);
    try {
      const sig = await produce();
      if (!sig) return;
      if (name.trim()) saveSignerName(name.trim());
      if (remember) saveSignature({ dataUrl: await blobToDataUrl(sig.blob), width: sig.width, height: sig.height, signer: sig.signer });
      onPlace(sig);
    } catch (err) {
      console.error("Failed to make signature:", err);
    } finally {
      setBusy(false);
    }
  };

  const placeSaved = async (s: SavedSignature) => {
    const blob = await (await fetch(s.dataUrl)).blob();
    onPlace({ blob, width: s.width, height: s.height, signer: s.signer ?? (name.trim() || null) });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      const typing = (e.target as HTMLElement)?.closest?.("input, textarea");
      if (tab === "draw" && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if (tab === "draw" && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, tab, undo, redo]);

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "draw", label: "Draw", icon: <MdOutlineDraw size={17} /> },
    { id: "type", label: "Type", icon: <MdTextFields size={17} /> },
    { id: "upload", label: "Upload", icon: <MdOutlineFileUpload size={17} /> },
  ];

  const inkPicker = (
    <div className="flex items-center gap-1.5">
      {INKS.map((k) => (
        <button
          key={k.id}
          type="button"
          onClick={() => setInk(k.color)}
          className={`w-6 h-6 rounded-full transition-transform ${ink === k.color ? "ring-2 ring-offset-2 ring-blue-500 dark:ring-offset-neutral-800 scale-110" : "hover:scale-110"}`}
          style={{ background: k.color }}
          data-tip={k.label}
          aria-label={k.label}
        />
      ))}
    </div>
  );

  const typedPreviewSize = useMemo(() => {
    const len = Math.max(4, name.trim().length);
    return Math.max(26, Math.min(44, 520 / len));
  }, [name]);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[9vh] bg-neutral-950/40 backdrop-blur-[2px] doc-sig-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="doc-sig-dialog w-[640px] max-w-[calc(100vw-32px)] max-h-[86vh] overflow-y-auto rounded-2xl bg-white dark:bg-neutral-800 shadow-[0_24px_64px_rgba(15,23,42,0.35)] text-neutral-800 dark:text-neutral-100">
        <div className="flex items-center justify-between px-6 pt-5">
          <div>
            <h2 className="text-lg font-semibold">Sign this document</h2>
            <p className="text-[13px] text-neutral-500 dark:text-neutral-400">Draw, type or upload your signature, then place it anywhere on the page.</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-700" aria-label="Close">
            <MdClose size={20} />
          </button>
        </div>

        {saved.length > 0 && (
          <div className="px-6 pt-4">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">Your signatures</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {saved.map((s) => (
                <div key={s.id} className="group relative shrink-0">
                  <button
                    type="button"
                    onClick={() => void placeSaved(s)}
                    className="h-16 w-36 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-white hover:border-blue-400 hover:shadow-[0_0_0_3px_rgba(59,130,246,0.15)] flex items-center justify-center px-2 transition"
                    data-tip="Place this signature"
                  >
                    <img src={s.dataUrl} alt={s.signer ? `Signature of ${s.signer}` : "Saved signature"} className="max-h-12 max-w-full object-contain" draggable={false} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSaved(deleteSignature(s.id))}
                    className="absolute -top-1.5 -right-1.5 hidden group-hover:flex w-5 h-5 items-center justify-center rounded-full bg-neutral-800 text-white shadow"
                    aria-label="Forget this signature"
                    data-tip="Forget"
                  >
                    <MdClose size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="px-6 pt-4">
          <div className="inline-flex p-1 rounded-xl bg-neutral-100 dark:bg-neutral-900">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`h-8 px-3.5 inline-flex items-center gap-1.5 rounded-lg text-[13px] font-medium transition ${
                  tab === t.id ? "bg-white dark:bg-neutral-700 shadow-sm text-neutral-900 dark:text-white" : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="px-6 pt-3">
          {tab === "draw" && (
            <>
              <div className="doc-sig-pad relative mx-auto" style={{ width: PAD_W, height: PAD_H, maxWidth: "100%" }}>
                <div className="doc-sig-line" />
                <span className="doc-sig-x">×</span>
                {strokes.length === 0 && <span className="doc-sig-hint">Sign here with your mouse, pen or finger</span>}
                <DrawPad strokes={strokes} setStrokes={(s) => (setStrokes(s), setUndone([]))} ink={ink} nib={nib} />
              </div>
              <div className="mt-3 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  {inkPicker}
                  <div className="flex items-center rounded-lg bg-neutral-100 dark:bg-neutral-900 p-0.5">
                    {NIBS.map((n) => (
                      <button
                        key={n.id}
                        type="button"
                        onClick={() => setNib(n.size)}
                        className={`h-7 px-2.5 inline-flex items-center gap-1.5 rounded-md text-xs ${nib === n.size ? "bg-white dark:bg-neutral-700 shadow-sm font-medium" : "text-neutral-500"}`}
                      >
                        <span className="inline-block rounded-full bg-current" style={{ width: 14, height: Math.max(1.5, n.size * 0.55) }} />
                        {n.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={undo} disabled={!strokes.length} className="p-1.5 rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30" data-tip="Undo stroke" data-tip-kbd="Ctrl+Z" aria-label="Undo">
                    <MdUndo size={18} />
                  </button>
                  <button type="button" onClick={redo} disabled={!undone.length} className="p-1.5 rounded-md text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30" data-tip="Redo stroke" aria-label="Redo">
                    <MdRedo size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={() => (setStrokes([]), setUndone([]))}
                    disabled={!strokes.length}
                    className="h-8 px-2.5 rounded-md text-[13px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-30"
                  >
                    Clear
                  </button>
                </div>
              </div>
            </>
          )}

          {tab === "type" && (
            <>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Type your full name"
                className="w-full h-11 px-3.5 rounded-xl border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-[15px] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                onKeyDown={(e) => e.key === "Enter" && void place()}
              />
              <div className="mt-3 grid grid-cols-2 gap-2">
                {SIGNATURE_FONTS.map((f) => (
                  <button
                    key={f.family}
                    type="button"
                    onClick={() => setFont(f.family)}
                    className={`relative h-[72px] rounded-xl border bg-white dark:bg-white px-3 flex items-center justify-center overflow-hidden transition ${
                      font === f.family ? "border-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.18)]" : "border-neutral-200 dark:border-neutral-700 hover:border-neutral-300"
                    }`}
                    data-tip={f.family}
                  >
                    <span className="whitespace-nowrap leading-none" style={{ fontFamily: `"${f.family}", cursive`, fontSize: typedPreviewSize * f.scale, color: ink }}>
                      {name.trim() || "Your Name"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-3">{inkPicker}</div>
            </>
          )}

          {tab === "upload" && (
            <>
              {!upload ? (
                <div
                  className={`doc-sig-drop flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed text-center transition ${
                    dragOver ? "border-blue-500 bg-blue-50/70 dark:bg-blue-500/10" : "border-neutral-300 dark:border-neutral-600"
                  }`}
                  style={{ height: PAD_H }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
                    if (file) void loadUpload(file, file.name);
                  }}
                >
                  <MdOutlineFileUpload size={30} className="text-neutral-400" />
                  <div className="text-sm font-medium">Drop a photo or scan of your signature</div>
                  <div className="text-xs text-neutral-500">or paste it (Ctrl+V) - the paper is removed automatically</div>
                  <button type="button" onClick={() => void pickFile()} className="mt-1 h-8 px-3.5 rounded-lg bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700">
                    Choose image…
                  </button>
                  {uploadError && <div className="text-xs text-red-600">{uploadError}</div>}
                </div>
              ) : (
                <>
                  {/* Before / after wipe on a checkerboard: drag across to compare. */}
                  <div
                    className="doc-sig-compare relative rounded-2xl overflow-hidden select-none cursor-ew-resize"
                    style={{ height: PAD_H }}
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      const r = e.currentTarget.getBoundingClientRect();
                      setWipe(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
                    }}
                    onPointerMove={(e) => {
                      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                      const r = e.currentTarget.getBoundingClientRect();
                      setWipe(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
                    }}
                  >
                    <canvas ref={previewRef} className="absolute inset-0 w-full h-full object-contain" />
                    <canvas ref={beforeRef} className="absolute inset-0 w-full h-full object-contain" style={{ clipPath: `inset(0 ${(1 - wipe) * 100}% 0 0)` }} />
                    <div className="absolute top-0 bottom-0 w-0.5 bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)]" style={{ left: `${wipe * 100}%` }}>
                      <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-1/2 w-6 h-6 rounded-full bg-white border-2 border-blue-500 shadow" />
                    </div>
                    <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/55 text-white text-[11px] font-medium">Original</span>
                    <span className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-blue-600/90 text-white text-[11px] font-medium">{liftOn ? "Lifted" : "As is"}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2.5">
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 text-[13px] cursor-pointer shrink-0">
                        <input type="checkbox" checked={liftOn} onChange={(e) => setLiftOn(e.target.checked)} className="accent-blue-600 w-4 h-4" />
                        Remove background
                      </label>
                      <div className={`flex-1 flex items-center gap-2 ${liftOn && !upload.analysis.alreadyTransparent ? "" : "opacity-40 pointer-events-none"}`}>
                        <span className="text-[11px] text-neutral-500 shrink-0">Cleaner</span>
                        <input type="range" min={0} max={1} step={0.01} value={strength} onChange={(e) => setStrength(Number(e.target.value))} className="flex-1 accent-blue-600 h-1.5" aria-label="Ink sensitivity" />
                        <span className="text-[11px] text-neutral-500 shrink-0">Fainter ink</span>
                      </div>
                    </div>
                    <button type="button" onClick={() => setUpload(null)} className="h-8 px-2.5 rounded-md text-[13px] text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700">
                      Choose another
                    </button>
                    <div className={`flex items-center gap-1.5 ${liftOn ? "" : "opacity-40 pointer-events-none"}`}>
                      <span className="text-[13px] mr-1">Ink</span>
                      {(["original", "black", "blue"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setInkMode(m)}
                          className={`h-7 px-2.5 rounded-md text-xs inline-flex items-center gap-1.5 border ${inkMode === m ? "border-blue-500 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-500/10" : "border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300"}`}
                        >
                          <span className="w-3 h-3 rounded-full" style={{ background: m === "black" ? INKS[0].color : m === "blue" ? INKS[1].color : "conic-gradient(#334155, #1e40af, #334155)" }} />
                          {m === "original" ? "Keep original" : m === "black" ? "Black" : "Blue"}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <div className="mt-5 px-6 py-4 border-t border-neutral-100 dark:border-neutral-700 flex items-center gap-3">
          {tab !== "type" && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Signer’s name (optional)"
              className="h-9 w-48 px-3 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 text-[13px] outline-none focus:border-blue-500"
              data-tip="Shown with the signature’s date when you hover it"
            />
          )}
          <label className="flex items-center gap-2 text-[13px] text-neutral-600 dark:text-neutral-300 cursor-pointer">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="accent-blue-600 w-4 h-4" />
            Save for next time
          </label>
          <div className="flex-1" />
          <button type="button" onClick={onClose} className="h-9 px-4 rounded-lg text-[13px] font-medium text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canPlace || busy}
            onClick={() => void place()}
            className="h-9 px-4 rounded-lg text-[13px] font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 inline-flex items-center gap-1.5"
          >
            <MdOutlineDraw size={16} />
            Place signature
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default DocSignatureStudio;
