// components/docs/DocHeaderFooterDialog.tsx
//
// Headers, footers and page numbers (docPageChrome.ts). A side panel, like Document style, so the
// pages stay in view: every change is written to the document at once and shows on every sheet
// (DocPageChromeOverlay.tsx) as it's made. Opened from Page setup or by
// double-clicking a page's top or bottom margin.
import React, { useEffect, useRef } from "react";
import { IoClose } from "react-icons/io5";
import {
  CHROME_SLOTS,
  DEFAULT_PAGE_CHROME,
  PAGE_NUMBER_FORMATS,
  PAGE_NUMBER_STYLES,
  type ChromeBand,
  type ChromeField,
  type ChromeSlot,
  type DocPageChrome,
  type PageNumberPosition,
} from "../../utils/docPageChrome";

interface DocHeaderFooterDialogProps {
  chrome: DocPageChrome;
  // Which band to put the cursor in when the panel opens (a double-clicked margin).
  focusBand: ChromeBand | null;
  onChange: (next: DocPageChrome) => void;
  onClose: () => void;
}

const field =
  "w-full min-w-0 px-2 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-600 bg-transparent outline-none focus:border-blue-500 text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400";
const label = "block text-xs text-neutral-500 dark:text-neutral-400 mb-1";
const sectionTitle = "text-sm font-medium text-neutral-900 dark:text-neutral-50";
const chip = (on: boolean) =>
  `h-7 px-2.5 rounded-full text-xs border transition-colors ${
    on
      ? "border-transparent bg-[#c2e7ff] text-[#001d35] dark:bg-blue-500/30 dark:text-blue-50 font-medium"
      : "border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700/60"
  }`;

const FIELD_BUTTONS: { field: ChromeField; label: string }[] = [
  { field: "page", label: "Page #" },
  { field: "pages", label: "Page count" },
  { field: "title", label: "Title" },
  { field: "date", label: "Date" },
];

const SLOT_LABELS: Record<ChromeSlot, string> = { left: "Left", center: "Center", right: "Right" };

// Where the number goes, picked on a little page: three spots along the top, three along the bottom.
const PositionPicker: React.FC<{ value: PageNumberPosition; onChange: (p: PageNumberPosition) => void }> = ({ value, onChange }) => {
  const spot = (band: ChromeBand, slot: ChromeSlot) => {
    const id = `${band}-${slot}` as PageNumberPosition;
    const on = value === id;
    return (
      <button
        key={id}
        type="button"
        aria-label={`${band === "header" ? "Top" : "Bottom"} ${slot}`}
        aria-pressed={on}
        onClick={() => onChange(id)}
        className={`h-5 w-7 rounded text-[10px] leading-5 font-medium transition-colors ${
          on ? "bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-700 text-neutral-400 hover:bg-blue-100 dark:hover:bg-blue-500/20"
        }`}
      >
        #
      </button>
    );
  };
  return (
    <div className="flex items-center gap-3">
      <div className="w-[104px] h-[132px] shrink-0 rounded-sm border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 flex flex-col justify-between p-1.5">
        <div className="flex justify-between">{CHROME_SLOTS.map((s) => spot("header", s))}</div>
        <div className="flex-1 my-1.5 mx-1 flex flex-col gap-1.5 justify-center" aria-hidden>
          {[100, 92, 96, 70, 88, 94].map((w, i) => (
            <span key={i} className="h-[3px] rounded bg-neutral-200 dark:bg-neutral-700" style={{ width: `${w}%` }} />
          ))}
        </div>
        <div className="flex justify-between">{CHROME_SLOTS.map((s) => spot("footer", s))}</div>
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {value.startsWith("header") ? "Top" : "Bottom"} {value.split("-")[1]} of every page
      </p>
    </div>
  );
};

const DocHeaderFooterDialog: React.FC<DocHeaderFooterDialogProps> = ({ chrome, focusBand, onChange, onClose }) => {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  // The slot the field buttons insert into: the last one focused.
  const lastFocused = useRef<string>(`${focusBand ?? "header"}-left`);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!focusBand) return;
    // The first slot that already has text, else the left one.
    const slot = CHROME_SLOTS.find((s) => chrome[focusBand][s].trim()) ?? "left";
    const el = inputs.current.get(`${focusBand}-${slot}`);
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusBand]);

  const setSlot = (band: ChromeBand, slot: ChromeSlot, text: string) => onChange({ ...chrome, [band]: { ...chrome[band], [slot]: text } });
  const setNumber = (patch: Partial<DocPageChrome["pageNumber"]>) => onChange({ ...chrome, pageNumber: { ...chrome.pageNumber, ...patch } });

  const insertField = (f: ChromeField) => {
    const key = lastFocused.current;
    const [band, slot] = key.split("-") as [ChromeBand, ChromeSlot];
    const el = inputs.current.get(key);
    const text = chrome[band][slot];
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const token = `{${f}}`;
    setSlot(band, slot, text.slice(0, start) + token + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const pn = chrome.pageNumber;

  const bandEditor = (band: ChromeBand) => (
    <section className="space-y-2">
      <h3 className={sectionTitle}>{band === "header" ? "Header" : "Footer"}</h3>
      <div className="grid grid-cols-3 gap-1.5">
        {CHROME_SLOTS.map((slot) => {
          const key = `${band}-${slot}`;
          const holdsNumber = pn.enabled && pn.position === key;
          return (
            <div key={slot} className="min-w-0">
              <label htmlFor={`doc-chrome-${key}`} className={label}>
                {SLOT_LABELS[slot]}
              </label>
              <input
                id={`doc-chrome-${key}`}
                ref={(el) => {
                  if (el) inputs.current.set(key, el);
                  else inputs.current.delete(key);
                }}
                value={chrome[band][slot]}
                onFocus={() => (lastFocused.current = key)}
                onChange={(e) => setSlot(band, slot, e.target.value)}
                placeholder={holdsNumber ? "+ page number" : ""}
                className={`${field} ${slot === "center" ? "text-center" : slot === "right" ? "text-right" : ""}`}
              />
            </div>
          );
        })}
      </div>
    </section>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end print:hidden" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-labelledby="doc-chrome-title"
        className="w-[380px] max-w-full h-full overflow-y-auto bg-white dark:bg-neutral-800 border-l border-neutral-200 dark:border-neutral-700 shadow-[-8px_0_24px_rgba(60,64,67,0.15)]"
      >
        <div className="sticky top-0 z-10 flex items-center gap-2 px-5 py-4 bg-white dark:bg-neutral-800 border-b border-neutral-100 dark:border-neutral-700/60">
          <h2 id="doc-chrome-title" className="flex-1 text-base font-medium text-neutral-900 dark:text-neutral-50">
            Header, footer &amp; page numbers
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 -m-1 rounded-full text-neutral-500 hover:bg-black/[0.06] dark:hover:bg-white/10">
            <IoClose size={20} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-6">
          <section className="space-y-3">
            <label className="flex items-center gap-3 cursor-pointer">
              <span className={`${sectionTitle} flex-1`}>Page numbers</span>
              <input type="checkbox" role="switch" checked={pn.enabled} onChange={(e) => setNumber({ enabled: e.target.checked })} className="peer sr-only" />
              <span
                aria-hidden
                className="relative h-5 w-9 rounded-full bg-neutral-300 dark:bg-neutral-600 transition-colors peer-checked:bg-blue-600 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500/40 after:absolute after:top-0.5 after:left-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
              />
            </label>
            {pn.enabled && (
              <>
                <PositionPicker value={pn.position} onChange={(position) => setNumber({ position })} />
                <div>
                  <span className={label}>Wording</span>
                  <div className="flex flex-wrap gap-1.5">
                    {PAGE_NUMBER_STYLES.map((s) => (
                      <button key={s.id} type="button" aria-pressed={pn.style === s.id} onClick={() => setNumber({ style: s.id })} className={chip(pn.style === s.id)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="doc-chrome-format" className={label}>
                      Numerals
                    </label>
                    <select id="doc-chrome-format" value={pn.format} onChange={(e) => setNumber({ format: e.target.value as DocPageChrome["pageNumber"]["format"] })} className={`${field} bg-white dark:bg-neutral-800`}>
                      {PAGE_NUMBER_FORMATS.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="doc-chrome-start" className={label}>
                      Start at
                    </label>
                    <input
                      id="doc-chrome-start"
                      type="number"
                      min={1}
                      max={9999}
                      value={pn.start}
                      onChange={(e) => {
                        const v = Math.round(Number(e.target.value));
                        if (Number.isFinite(v) && v >= 1 && v <= 9999) setNumber({ start: v });
                      }}
                      className={`${field} tabular-nums`}
                    />
                  </div>
                </div>
              </>
            )}
          </section>

          {bandEditor("header")}
          {bandEditor("footer")}

          <div>
            <span className={label}>Insert into the selected box</span>
            <div className="flex flex-wrap gap-1.5">
              {FIELD_BUTTONS.map((b) => (
                <button
                  key={b.field}
                  type="button"
                  // Keeps focus (and the caret) in the box being edited.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertField(b.field)}
                  className={chip(false)}
                >
                  + {b.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-neutral-400">Fields show as {"{page}"}, {"{pages}"}, {"{title}"} and {"{date}"} and fill in on every page.</p>
          </div>

          <section className="space-y-3">
            <h3 className={sectionTitle}>Options</h3>
            <label className="flex items-start gap-2.5 text-sm text-neutral-700 dark:text-neutral-200 cursor-pointer">
              <input type="checkbox" checked={chrome.differentFirstPage} onChange={(e) => onChange({ ...chrome, differentFirstPage: e.target.checked })} className="mt-0.5 accent-blue-600" />
              <span>
                Different first page
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">No header, footer or number on a title page. It still counts as page 1.</span>
              </span>
            </label>
            <div className="flex items-center gap-3">
              <label htmlFor="doc-chrome-size" className="text-sm text-neutral-700 dark:text-neutral-200 flex-1">
                Text size
              </label>
              <select id="doc-chrome-size" value={chrome.fontSize} onChange={(e) => onChange({ ...chrome, fontSize: Number(e.target.value) })} className={`${field} w-24 bg-white dark:bg-neutral-800`}>
                {[7, 8, 9, 10, 11, 12].map((s) => (
                  <option key={s} value={s}>
                    {s} pt
                  </option>
                ))}
              </select>
            </div>
          </section>

          <div className="flex items-center justify-between pt-2 border-t border-neutral-100 dark:border-neutral-700/60">
            <button type="button" onClick={() => onChange(DEFAULT_PAGE_CHROME)} className="px-3 py-1.5 text-sm rounded-md text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">
              Remove all
            </button>
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700">
              Done
            </button>
          </div>
          <p className="text-xs text-neutral-400">Tip: double-click the top or bottom margin of any page to come back here.</p>
        </div>
      </div>
    </div>
  );
};

export default DocHeaderFooterDialog;
