// components/Modals/AnnotationSettingsTab.tsx
//
// Redesigned "Annotate & Shield" settings panel: clean grouped cards, pill toggle switches,
// interactive live ink + pointer preview, direct visual Default Hand Style picker, pointer size
// slider, and Privacy Shield auto-blur controls.
import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  IoChevronDown,
  IoChevronUp,
  IoHandLeftOutline,
  IoKeyOutline,
  IoPencilOutline,
  IoShieldCheckmarkOutline,
} from "react-icons/io5";
import { AppSettings } from "../../utils/appSettings";
import {
  ANNOTATION_COLORS,
  ANNOTATION_FADES,
  ANNOTATION_HAND_STYLES,
  ANNOTATION_POINTERS,
  ANNOTATION_STYLES,
  ANNOTATION_TAP_SOUNDS,
  AnnotationHandStyle,
} from "../../utils/annotationStyles";
import { playTapSound } from "../../utils/annotationSound";
import { HandGraphic } from "../AnnotationPointer";
import AnnotationPreview from "./AnnotationPreview";
import ColorInput from "../common/ColorInput";

interface AnnotationSettingsTabProps {
  settings: AppSettings;
  update: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

const Switch: React.FC<{
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
}> = ({ checked, onChange, disabled, ariaLabel }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 disabled:cursor-default ${
      checked ? "bg-blue-500" : "bg-neutral-300 dark:bg-neutral-700"
    }`}
  >
    <span
      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
        checked ? "translate-x-[18px]" : "translate-x-[3px]"
      }`}
    />
  </button>
);

const Segmented = <T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) => (
  <div className="inline-flex p-0.5 rounded-lg bg-neutral-100 dark:bg-neutral-800/90 border border-neutral-200/70 dark:border-neutral-700/70">
    {options.map((o) => (
      <button
        key={o.id}
        type="button"
        disabled={disabled}
        onClick={() => onChange(o.id)}
        className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all disabled:opacity-40 ${
          value === o.id
            ? "bg-white dark:bg-neutral-700 text-blue-600 dark:text-blue-300 shadow-sm"
            : "text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100"
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const Card: React.FC<{
  icon: React.ReactNode;
  title: string;
  aside?: React.ReactNode;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ icon, title, aside, disabled, children }) => (
  <div
    className={`rounded-xl border border-neutral-200/80 dark:border-neutral-800 bg-neutral-50/60 dark:bg-neutral-900/50 p-3.5 flex flex-col gap-3 transition-opacity ${
      disabled ? "opacity-45 pointer-events-none" : ""
    }`}
  >
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
        {icon}
        <span>{title}</span>
      </div>
      {aside}
    </div>
    {children}
  </div>
);

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex items-center justify-between gap-4">
    <div className="min-w-0">
      <div className="text-[13px] font-medium text-neutral-800 dark:text-neutral-200">{label}</div>
      {hint && <div className="text-[11px] text-neutral-400 dark:text-neutral-500 leading-snug">{hint}</div>}
    </div>
    <div className="shrink-0">{children}</div>
  </div>
);

const OcrStatus: React.FC = () => {
  const [language, setLanguage] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    invoke<string | null>("screen_blur_ocr_language").then(setLanguage, () => setLanguage(null));
  }, []);
  if (language === undefined) return null;
  return language ? (
    <p className="text-[11px] text-neutral-400 dark:text-neutral-500">
      Uses Windows built-in OCR ({language}) — everything stays local on your PC.
    </p>
  ) : (
    <p className="text-[11px] text-amber-600 dark:text-amber-400">
      Windows has no OCR language installed. Add one in Windows Settings › Time &amp; language › Language (with OCR).
    </p>
  );
};

const HAND_PREVIEW_OFFSET: Record<AnnotationHandStyle, { left: number; top: number; rot: number; scale: number }> = {
  minimal: { left: 26, top: 8, rot: -18, scale: 0.72 },
  classic: { left: 26, top: 7, rot: -24, scale: 0.62 },
  wand: { left: 24, top: 6, rot: -28, scale: 0.48 },
  stylus: { left: 22, top: 7, rot: -32, scale: 0.56 },
};

const AnnotationSettingsTab: React.FC<AnnotationSettingsTabProps> = ({ settings, update }) => {
  const [showShortcuts, setShowShortcuts] = useState(false);

  return (
    <div className="flex flex-col gap-3.5">
      {/* Master Header Card */}
      <div className="rounded-xl border border-neutral-200/80 dark:border-neutral-800 bg-white dark:bg-neutral-900/70 p-3.5 flex flex-col gap-3">
        <Row
          label="Screen Annotation Tool"
          hint="Press Ctrl+Shift+D anywhere to draw live while presenting or recording."
        >
          <Switch
            checked={settings.enableAnnotationTool}
            onChange={(v) => update("enableAnnotationTool", v)}
            ariaLabel="Enable screen annotation tool"
          />
        </Row>

        <div
          className={`pt-2.5 border-t border-neutral-100 dark:border-neutral-800/80 flex items-center justify-between gap-3 transition-opacity ${
            settings.enableAnnotationTool ? "" : "opacity-45 pointer-events-none"
          }`}
        >
          <div className="flex items-center gap-2.5">
            <Switch
              checked={settings.annotationShowToolbar}
              onChange={(v) => update("annotationShowToolbar", v)}
              ariaLabel="Show floating toolbar"
            />
            <span className="text-xs text-neutral-600 dark:text-neutral-300">
              Show floating toolbar while drawing
            </span>
          </div>
          <button
            type="button"
            onClick={() => setShowShortcuts((v) => !v)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <IoKeyOutline size={12} />
            Shortcuts
            {showShortcuts ? <IoChevronUp size={12} /> : <IoChevronDown size={12} />}
          </button>
        </div>

        {showShortcuts && (
          <div className="grid grid-cols-2 gap-x-5 gap-y-1.5 pt-2 border-t border-neutral-100 dark:border-neutral-800/80 text-[11px] text-neutral-500 dark:text-neutral-400">
            {[
              ["Ctrl+Shift+D", "Toggle draw mode"],
              ["Esc", "Exit draw mode"],
              ["1 – 8", "Pick ink colour"],
              ["P · M · N · L", "Pen, Marker, Neon, Laser"],
              ["Hold Shift", "Draw straight line"],
              ["Ctrl+Z / Backspace", "Undo / Clear ink"],
              ["B", "Place Privacy Blur"],
              ["Ctrl+Alt+B", "Blur active window"],
            ].map(([keys, what]) => (
              <div key={keys} className="flex items-center justify-between gap-2">
                <span className="truncate">{what}</span>
                <kbd className="shrink-0 px-1.5 py-0.5 rounded font-mono text-[10px] bg-neutral-100 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200">
                  {keys}
                </kbd>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Interactive Live Preview (Ink + Pointer/Hand together) */}
      <div className={settings.enableAnnotationTool ? "" : "opacity-45 pointer-events-none"}>
        <AnnotationPreview
          color={settings.annotationColor}
          width={settings.annotationWidth}
          style={settings.annotationStyle}
          shadow={settings.annotationShadow}
          pointer={settings.annotationPointer}
          handStyle={settings.annotationHandStyle}
          pointerScale={settings.annotationPointerScale}
          pointerImage={settings.annotationPointerImage}
        />
      </div>

      {/* Card 1: Pointer & Hand Style */}
      <Card
        icon={<IoHandLeftOutline size={14} />}
        title="Pointer & Hand Style"
        disabled={!settings.enableAnnotationTool}
        aside={
          <Segmented
            value={settings.annotationPointer}
            options={ANNOTATION_POINTERS}
            onChange={(v) => update("annotationPointer", v)}
          />
        }
      >
        {settings.annotationPointer === "hand" && (
          <div className="flex flex-col gap-2">
            <span className="text-[11.5px] font-medium text-neutral-500 dark:text-neutral-400">
              Default hand style
            </span>
            <div className="grid grid-cols-4 gap-2">
              {ANNOTATION_HAND_STYLES.map((hs) => {
                const active = settings.annotationHandStyle === hs.id;
                const pos = HAND_PREVIEW_OFFSET[hs.id];
                return (
                  <button
                    key={hs.id}
                    type="button"
                    title={hs.hint}
                    onClick={() => update("annotationHandStyle", hs.id)}
                    className={`group flex flex-col items-center rounded-xl p-2 border text-center transition-all ${
                      active
                        ? "border-blue-500 bg-blue-50/70 dark:bg-blue-500/15 ring-1 ring-blue-500/30"
                        : "border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900/60 hover:border-neutral-300 dark:hover:border-neutral-700"
                    }`}
                  >
                    <div className="relative w-12 h-11 overflow-hidden flex items-center justify-center">
                      <div
                        className="absolute transition-transform duration-150 group-hover:scale-105"
                        style={{
                          left: pos.left,
                          top: pos.top,
                          transform: `rotate(${pos.rot}deg) scale(${pos.scale})`,
                          transformOrigin: "0 0",
                        }}
                      >
                        <HandGraphic
                          color={settings.annotationColor}
                          handStyle={hs.id}
                          stick={hs.id === "classic" || hs.id === "wand"}
                        />
                      </div>
                    </div>
                    <span
                      className={`text-[11px] font-medium mt-0.5 ${
                        active ? "text-blue-600 dark:text-blue-300" : "text-neutral-700 dark:text-neutral-300"
                      }`}
                    >
                      {hs.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {settings.annotationPointer === "custom" && (
          <Row label="Custom pointer image" hint="Top centre acts as the drawing point.">
            <div className="flex items-center gap-2">
              {settings.annotationPointerImage && (
                <img
                  src={settings.annotationPointerImage}
                  alt=""
                  className="h-7 w-auto max-w-[2.5rem] object-contain rounded"
                />
              )}
              <input
                type="file"
                accept="image/png,image/webp"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  const url = URL.createObjectURL(file);
                  const img = new Image();
                  img.onload = () => {
                    const scale = Math.min(1, 160 / img.naturalHeight);
                    const canvas = document.createElement("canvas");
                    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
                    update("annotationPointerImage", canvas.toDataURL("image/png"));
                    URL.revokeObjectURL(url);
                  };
                  img.onerror = () => URL.revokeObjectURL(url);
                  img.src = url;
                }}
                className="text-xs text-neutral-500 dark:text-neutral-400 file:mr-2 file:px-2.5 file:py-1 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-neutral-200/70 dark:file:bg-neutral-800 file:text-neutral-700 dark:file:text-neutral-200 file:cursor-pointer"
              />
            </div>
          </Row>
        )}

        {settings.annotationPointer !== "system" && (
          <Row label="Pointer size" hint="Keep it compact so it never covers what you're explaining.">
            <div className="flex items-center gap-2.5">
              <input
                type="range"
                min={0.6}
                max={1.25}
                step={0.05}
                value={settings.annotationPointerScale}
                onChange={(e) => update("annotationPointerScale", Number(e.target.value))}
                className="w-28 accent-blue-500"
              />
              <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums w-9 text-right">
                {Math.round(settings.annotationPointerScale * 100)}%
              </span>
            </div>
          </Row>
        )}

        <div className="pt-2 border-t border-neutral-200/60 dark:border-neutral-800/80 flex flex-col gap-2.5">
          <Row label="Tap ripple" hint="Expanding ring where you click.">
            <Switch
              checked={settings.annotationTapRipple}
              onChange={(v) => update("annotationTapRipple", v)}
              ariaLabel="Tap ripple"
            />
          </Row>
          <Row label="Tap sound">
            <div className="flex items-center gap-2">
              <Segmented
                value={settings.annotationTapSound}
                options={ANNOTATION_TAP_SOUNDS}
                onChange={(v) => {
                  update("annotationTapSound", v);
                  playTapSound(v, settings.annotationSoundVolume);
                }}
              />
              {settings.annotationTapSound !== "off" && (
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={settings.annotationSoundVolume}
                  onChange={(e) => update("annotationSoundVolume", Number(e.target.value))}
                  onPointerUp={() => playTapSound(settings.annotationTapSound, settings.annotationSoundVolume)}
                  title={`Volume: ${Math.round(settings.annotationSoundVolume * 100)}%`}
                  className="w-16 accent-blue-500"
                />
              )}
            </div>
          </Row>
        </div>
      </Card>

      {/* Card 2: Ink & Strokes */}
      <Card icon={<IoPencilOutline size={14} />} title="Ink & Strokes" disabled={!settings.enableAnnotationTool}>
        <Row label="Default color">
          <div className="flex items-center gap-1.5">
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => update("annotationColor", c)}
                aria-label={`Color ${c}`}
                aria-pressed={settings.annotationColor.toLowerCase() === c}
                className={`w-5 h-5 rounded-full ring-1 ring-black/15 dark:ring-white/25 transition-transform hover:scale-110 ${
                  settings.annotationColor.toLowerCase() === c ? "outline outline-2 outline-offset-2 outline-blue-500" : ""
                }`}
                style={{ backgroundColor: c }}
              />
            ))}
            <label
              className={`relative w-5 h-5 rounded-full cursor-pointer ring-1 ring-black/15 dark:ring-white/25 bg-[conic-gradient(#ef4444,#facc15,#22c55e,#3b82f6,#a855f7,#ef4444)] ${
                ANNOTATION_COLORS.includes(settings.annotationColor.toLowerCase())
                  ? ""
                  : "outline outline-2 outline-offset-2 outline-blue-500"
              }`}
              title="Custom color"
            >
              <ColorInput
                value={settings.annotationColor}
                onChange={(e) => update("annotationColor", e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
            </label>
          </div>
        </Row>

        <Row
          label="Ink style"
          hint={ANNOTATION_STYLES.find((st) => st.id === settings.annotationStyle)?.hint}
        >
          <Segmented
            value={settings.annotationStyle}
            options={ANNOTATION_STYLES}
            onChange={(v) => update("annotationStyle", v)}
          />
        </Row>

        <Row label="Stroke thickness">
          <div className="flex items-center gap-2.5">
            <input
              type="range"
              min={2}
              max={24}
              step={1}
              value={settings.annotationWidth}
              onChange={(e) => update("annotationWidth", Number(e.target.value))}
              className="w-28 accent-blue-500"
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums w-8 text-right">
              {settings.annotationWidth}px
            </span>
          </div>
        </Row>

        <Row
          label="Fade out"
          hint={
            settings.annotationStyle === "laser"
              ? "Laser trails always vanish quickly."
              : settings.annotationFade === "never"
              ? "Stays until cleared or exiting draw mode."
              : undefined
          }
        >
          <Segmented
            value={settings.annotationFade}
            options={ANNOTATION_FADES}
            onChange={(v) => update("annotationFade", v)}
            disabled={settings.annotationStyle === "laser"}
          />
        </Row>

        <Row label="Ink drop shadow" hint="Improves contrast over bright or busy slides.">
          <Switch
            checked={settings.annotationShadow}
            disabled={settings.annotationStyle === "neon" || settings.annotationStyle === "laser"}
            onChange={(v) => update("annotationShadow", v)}
            ariaLabel="Ink drop shadow"
          />
        </Row>
      </Card>

      {/* Card 3: Privacy Shield (Live Blur) */}
      <Card
        icon={<IoShieldCheckmarkOutline size={14} />}
        title="Privacy Shield (Live Blur)"
        aside={
          <span className="inline-flex items-center gap-1 text-[10.5px] text-neutral-400 dark:text-neutral-500">
            Active window
            <kbd className="px-1.5 py-0.5 rounded font-mono text-[10px] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300">
              Ctrl+Alt+B
            </kbd>
          </span>
        }
      >
        <Row label="Blur strength" hint="Unreadable even at 0; higher adds extra frost.">
          <div className="flex items-center gap-2.5">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={settings.annotationBlurStrength}
              onChange={(e) => {
                const strength = Number(e.target.value);
                update("annotationBlurStrength", strength);
                void invoke("screen_blur_configure", { config: { strength } }).catch(() => {});
              }}
              className="w-28 accent-blue-500"
            />
            <span className="text-xs text-neutral-500 dark:text-neutral-400 tabular-nums w-8 text-right">
              {settings.annotationBlurStrength}
            </span>
          </div>
        </Row>

        <div className="pt-2 border-t border-neutral-200/60 dark:border-neutral-800/80 flex flex-col gap-2">
          <Row label="Auto-blur WhatsApp" hint="Follows the WhatsApp window automatically.">
            <Segmented
              value={settings.annotationAutoBlurWhatsApp}
              options={[
                { id: "off", label: "Off" },
                { id: "recording", label: "Recording" },
                { id: "always", label: "Always" },
              ]}
              onChange={(v) => update("annotationAutoBlurWhatsApp", v)}
            />
          </Row>
          {settings.annotationAutoBlurWhatsApp !== "off" && (
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ["chatList", "Chat list"],
                  ["contact", "Contact & photo"],
                  ["messages", "Messages"],
                ] as const
              ).map(([key, label]) => {
                const on = settings.annotationBlurWhatsAppParts[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() =>
                      update("annotationBlurWhatsAppParts", { ...settings.annotationBlurWhatsAppParts, [key]: !on })
                    }
                    className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                      on
                        ? "border-blue-500/40 bg-blue-500/12 text-blue-600 dark:text-blue-300"
                        : "border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-neutral-200/60 dark:border-neutral-800/80 flex flex-col gap-2">
          <Row label="Auto-blur sensitive text" hint="Detects secrets on screen with local Windows OCR.">
            <Segmented
              value={settings.annotationAutoBlurText}
              options={[
                { id: "off", label: "Off" },
                { id: "recording", label: "Recording" },
                { id: "always", label: "Always" },
              ]}
              onChange={(v) => update("annotationAutoBlurText", v)}
            />
          </Row>
          {settings.annotationAutoBlurText !== "off" && (
            <>
              <OcrStatus />
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["passwords", "Passwords & PINs"],
                    ["keys", "API keys & tokens"],
                    ["financial", "Cards & banking"],
                    ["personal", "Emails & phones"],
                  ] as const
                ).map(([key, label]) => {
                  const on = settings.annotationBlurTextRules[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        update("annotationBlurTextRules", { ...settings.annotationBlurTextRules, [key]: !on })
                      }
                      className={`px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                        on
                          ? "border-blue-500/40 bg-blue-500/12 text-blue-600 dark:text-blue-300"
                          : "border-neutral-200 dark:border-neutral-700 text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <Row label="Extra blocked words" hint="Comma-separated, case-insensitive.">
                <input
                  type="text"
                  value={settings.annotationBlurKeywords}
                  onChange={(e) => update("annotationBlurKeywords", e.target.value)}
                  placeholder="Client name, codename…"
                  className="w-52 px-2.5 py-1 rounded-lg text-xs bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 text-neutral-800 dark:text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </Row>
            </>
          )}
        </div>
      </Card>
    </div>
  );
};

export default AnnotationSettingsTab;
