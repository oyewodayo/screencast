import React from "react";
import "./brandLoader.css";

export type BrandLoaderSize = "sm" | "md" | "lg";
export type BrandLoaderVariant = "fullscreen" | "contained" | "overlay" | "inline";

export interface BrandLoaderProps {
  /** Main message to display, defaults to "Loading…" */
  message?: string;
  /** Optional secondary explanatory text */
  description?: string;
  /** Layout mode */
  variant?: BrandLoaderVariant;
  /** Size of the brand loader */
  size?: BrandLoaderSize;
  /** Optional progress percentage (0 - 100) */
  progress?: number;
  /** Optional extra CSS classes */
  className?: string;
  /** Whether the loader is smoothly dissolving away as loading finishes */
  isFading?: boolean;
}

/**
 * Briefcast Vector Brand Mark with Animated Transmission Beam
 * Pure crystal-clear SVG, zero blur filters, razor-sharp vector strokes.
 * The frame animates continuously from grey to solid black as the signal beams across.
 */
export const BriefcastBeamLogo: React.FC<{
  size?: BrandLoaderSize;
  className?: string;
}> = ({ size = "md", className = "" }) => {
  const pixelSize = {
    sm: 32,
    md: 52,
    lg: 68,
  }[size];

  return (
    <div
      className={`briefcast-logo-container relative flex items-center justify-center select-none ${className}`}
      style={{ width: pixelSize, height: pixelSize }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 48 48"
        width={pixelSize}
        height={pixelSize}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="overflow-visible"
        shapeRendering="geometricPrecision"
      >
        {/* Screen / Monitor Frame - Animates crisply from grey to solid black (or white in dark mode) */}
        <path
          d="M 8 28 V 12 A 4 4 0 0 1 12 8 H 36 A 4 4 0 0 1 40 12 V 34 A 4 4 0 0 1 36 38 H 26"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="briefcast-screen-frame"
        />

        {/* Wave 3: Outer Projection Arc (radiates into the screen) */}
        <path
          d="M 10 15 A 21 21 0 0 1 31 36"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="briefcast-wave-3"
        />

        {/* Wave 2: Middle Broadcast Arc */}
        <path
          d="M 10 22 A 14 14 0 0 1 24 36"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="briefcast-wave-2"
        />

        {/* Wave 1: Inner Broadcast Arc */}
        <path
          d="M 10 29 A 7 7 0 0 1 17 36"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="briefcast-wave-1"
        />

        {/* Cast Origin Beacon Point */}
        <circle
          cx="10"
          cy="36"
          r="2.5"
          className="briefcast-beacon"
        />
      </svg>
    </div>
  );
};

/**
 * Briefcast Unified Brand Loader
 * Crystal-clear, razor-sharp vector loading state with active frame transmission.
 * Infinitely animates smoothly and can fade out gracefully upon completion.
 */
export const BrandLoader: React.FC<BrandLoaderProps> = ({
  message = "Loading…",
  description,
  variant = "contained",
  size = "md",
  progress,
  className = "",
  isFading = false,
}) => {
  // Inline variant renders a compact horizontal row
  if (variant === "inline") {
    return (
      <div
        className={`inline-flex items-center gap-2 select-none transition-opacity duration-300 ${
          isFading ? "opacity-0 pointer-events-none" : "opacity-100"
        } ${className}`}
      >
        <BriefcastBeamLogo size="sm" />
        {message && (
          <span className="text-xs font-medium text-neutral-700 dark:text-neutral-200">
            {message}
          </span>
        )}
      </div>
    );
  }

  const containerClasses = {
    fullscreen: "fixed inset-0 z-50 flex flex-col items-center justify-center bg-white/95 dark:bg-[#0c0d0e]/95 select-none",
    overlay: "absolute inset-0 z-40 flex flex-col items-center justify-center bg-white/90 dark:bg-black/90 select-none",
    contained: "w-full h-full min-h-[140px] flex flex-col items-center justify-center p-6 select-none",
  }[variant];

  const textSizes = {
    sm: "text-xs",
    md: "text-xs",
    lg: "text-sm",
  }[size];

  const fadeClasses = isFading
    ? "opacity-0 scale-[1.02] pointer-events-none transition-all duration-300 ease-out"
    : "opacity-100 scale-100 transition-all duration-300 ease-out";

  return (
    <div
      className={`${containerClasses} ${fadeClasses} ${className}`}
      role="status"
      aria-live="polite"
    >
      {/* Recreated Vector Logo with Animated Beam */}
      <BriefcastBeamLogo size={size} />

      {/* Clean, Understated Status Label */}
      {message && (
        <div className="mt-3.5 flex flex-col items-center text-center max-w-xs">
          <div
            className={`font-medium tracking-tight text-neutral-700 dark:text-neutral-200 ${textSizes} flex items-center`}
          >
            <span>{message.replace(/[\.\…]+$/, "")}</span>
            <span className="inline-flex ml-0.5 tracking-normal text-blue-600 dark:text-blue-400 font-semibold">
              <span className="animate-briefcast-dot-1">.</span>
              <span className="animate-briefcast-dot-2">.</span>
              <span className="animate-briefcast-dot-3">.</span>
            </span>
          </div>

          {/* Optional description */}
          {description && (
            <p className="mt-0.5 text-[11px] text-neutral-400 dark:text-neutral-500 font-normal">
              {description}
            </p>
          )}

          {/* Optional progress bar */}
          {typeof progress === "number" && (
            <div className="mt-2.5 w-32 flex flex-col items-center gap-1">
              <div className="w-full h-1 bg-neutral-200 dark:bg-neutral-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-600 dark:bg-blue-500 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                />
              </div>
              <span className="text-[10px] font-mono text-neutral-400 dark:text-neutral-500">
                {Math.round(progress)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Compact Brand Spinner for buttons and inline tags
 */
export const BrandSpinner: React.FC<{
  size?: "sm" | "md";
  className?: string;
}> = ({ size = "sm", className = "" }) => {
  return <BriefcastBeamLogo size={size} className={className} />;
};

export default BrandLoader;
