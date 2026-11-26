import React, { useState } from "react";
import {
  IoBrushOutline,
  IoClose,
  IoGitNetworkOutline,
  IoPhonePortraitOutline,
  IoShieldCheckmarkOutline,
} from "react-icons/io5";

const ONBOARDING_DISMISSED_KEY = "briefcast.homeQuickStartDismissed.v1";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

interface HomeQuickStartProps {
  /** Number of creations/files already in the user's library. Automatically hides once >= 3. */
  libraryCount: number;
  onStartRecordingSetup: () => void;
  onTryAnnotation: () => void;
  onOpenWhiteboard: () => void;
  onOpenPhoneCamera: () => void;
}

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

/**
 * Calm, dismissible first-run discovery strip on the Home screen. Surfaces Briefcast's highest-wow
 * capabilities (Privacy Shield recording, system-wide Screen Annotation, Whiteboard + Slides, and
 * wireless Phone Camera) when a new user opens an empty or near-empty library, then gets out of
 * the way automatically once they have 3+ items or dismiss it.
 */
const HomeQuickStart: React.FC<HomeQuickStartProps> = ({
  libraryCount,
  onStartRecordingSetup,
  onTryAnnotation,
  onOpenWhiteboard,
  onOpenPhoneCamera,
}) => {
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);

  if (dismissed || libraryCount >= 3) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
    } catch {
      // Best-effort persistence only.
    }
  };

  const tips = [
    {
      title: "Record + Privacy Shield",
      desc: "Auto-blur WhatsApp, passwords & API keys live while you capture.",
      icon: <IoShieldCheckmarkOutline size={16} />,
      tint: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10",
      onClick: onStartRecordingSetup,
    },
    {
      title: `Draw over any app (${isMac ? "⌘" : "Ctrl"}+Shift+D)`,
      desc: "Pen, laser, presenter hand & click-through blur boxes on every monitor.",
      icon: <IoBrushOutline size={16} />,
      tint: "text-blue-600 dark:text-blue-400 bg-blue-500/10",
      onClick: onTryAnnotation,
    },
    {
      title: "Whiteboard, Mind Maps & Slides",
      desc: "Import PowerPoint/PDF decks, sketch roadmaps, or type live LaTeX maths.",
      icon: <IoGitNetworkOutline size={16} />,
      tint: "text-violet-600 dark:text-violet-400 bg-violet-500/10",
      onClick: onOpenWhiteboard,
    },
    {
      title: "Phone as a wireless camera",
      desc: "Scan a QR code to stream your phone camera — nothing to install on it.",
      icon: <IoPhonePortraitOutline size={16} />,
      tint: "text-amber-600 dark:text-amber-400 bg-amber-500/10",
      onClick: onOpenPhoneCamera,
    },
  ];

  return (
    <div className="relative w-full max-w-3xl rounded-xl border border-gray-200/80 dark:border-neutral-800 bg-white/85 dark:bg-neutral-900/80 px-4 py-3.5 text-left">
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-neutral-400">
            Quick start
          </span>
          <span className="text-[11px] text-gray-400 dark:text-neutral-500 truncate">
            Everything runs locally on your computer
          </span>
        </div>
        <button
          type="button"
          onClick={dismiss}
          title="Dismiss quick start"
          aria-label="Dismiss quick start"
          className="p-1 rounded-md text-gray-400 hover:text-gray-700 dark:text-neutral-500 dark:hover:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-800 transition-colors"
        >
          <IoClose size={14} />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {tips.map((tip) => (
          <button
            key={tip.title}
            type="button"
            onClick={tip.onClick}
            className="group flex items-start gap-2.5 p-2.5 rounded-lg border border-transparent hover:border-gray-200/90 dark:hover:border-neutral-700/80 hover:bg-gray-50/90 dark:hover:bg-neutral-800/60 text-left transition-colors cursor-pointer"
          >
            <span className={`mt-0.5 h-7 w-7 shrink-0 rounded-lg flex items-center justify-center ${tip.tint}`}>
              {tip.icon}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-semibold text-gray-800 dark:text-neutral-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                {tip.title}
              </span>
              <span className="block mt-0.5 text-[11px] leading-snug text-gray-500 dark:text-neutral-400">
                {tip.desc}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default HomeQuickStart;
