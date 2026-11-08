// components/video/PhonePreviewLayer.tsx
//
// The player as the phone's screen (usePhonePreview): for a tall canvas, its rounded corners and
// camera cut-out over the picture, and - for canvases meant for vertical apps - where those apps'
// buttons, top bar and caption sit over the video, so faces and text can be kept clear of them.
// Guides only: nothing here is exported. The guides step back while playing; the screen shape
// stays.
//
// The app areas follow the platforms' published safe-zone guidance for 9:16 (roughly: the top
// ~7% for tabs, the bottom ~20% for the caption and username, a ~13% column on the right for the
// like/comment/share buttons) - the same for every vertical app, close enough to plan by.
import React from "react";
import { CanvasFormat, canvasPreset } from "../../utils/canvasFormats";

interface PhonePreviewLayerProps {
  canvas: CanvasFormat;
  // The frame's size on screen, px.
  width: number;
  height: number;
  isPlaying: boolean;
}

const PhonePreviewLayer: React.FC<PhonePreviewLayerProps> = ({ canvas, width, height, isPlaying }) => {
  const preset = canvasPreset(canvas.preset);
  // Only a phone-shaped canvas (9:16 or taller) is a phone's screen - a 4:5 post sits square in a feed.
  if (canvas.height / canvas.width < 1.7) return null;
  const isIphone = canvas.preset.startsWith("iphone");
  const radius = width * (isIphone ? 0.13 : 0.1);
  const showUi = !!preset?.appUi && !isPlaying;
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {showUi && (
        <div className="absolute inset-0">
          <Zone style={{ left: 0, right: 0, top: 0, height: "7%" }} label="Top bar" />
          <Zone style={{ left: 0, right: "13%", bottom: 0, height: "20%" }} label="Caption & name" />
          <Zone style={{ right: 0, width: "13%", top: "42%", bottom: 0 }} label="Buttons" vertical />
        </div>
      )}
      {/* The screen's corners: outside the rounded screen is the phone's black. */}
      <div className="absolute inset-0" style={{ borderRadius: radius, boxShadow: `0 0 0 ${Math.ceil(Math.max(width, height))}px #000, inset 0 0 0 1.5px rgba(255,255,255,0.14)` }} />
      {/* The camera: an island on iPhones, a punch-hole on Android phones (and the platform
          formats, previewed on a generic phone). */}
      {isIphone ? (
        <div className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black" style={{ top: width * 0.028, width: width * 0.31, height: width * 0.09 }} />
      ) : (
        <div className="absolute left-1/2 -translate-x-1/2 rounded-full bg-black" style={{ top: width * 0.03, width: width * 0.055, height: width * 0.055 }} />
      )}
    </div>
  );
};

const Zone: React.FC<{ style: React.CSSProperties; label: string; vertical?: boolean }> = ({ style, label, vertical }) => (
  <div
    className="absolute flex items-center justify-center"
    style={{
      ...style,
      background: "repeating-linear-gradient(135deg, rgba(255,255,255,0.07) 0 6px, rgba(255,255,255,0) 6px 12px)",
      outline: "1px dashed rgba(255,255,255,0.35)",
      outlineOffset: -1,
    }}
  >
    <span className="text-[9px] font-medium text-white/70 bg-black/45 rounded px-1 py-px whitespace-nowrap" style={vertical ? { writingMode: "vertical-rl" } : undefined}>
      {label}
    </span>
  </div>
);

export default PhonePreviewLayer;
