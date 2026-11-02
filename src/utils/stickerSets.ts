// utils/stickerSets.ts
//
// Ready-made stickers (stickerAssets.ts) for the Elements gallery - each piece of the explainer
// look in the colours and words it is usually used with - and sets: several stickers placed and
// timed together the way an explainer builds a point up beside the speaker (a label, then the
// stat counting up, then a footnote chip), added in one step and edited piece by piece after.

import { makeImageOverlay } from "../handlers/videoEditHandlers";
import type { ImageOverlay } from "./videoEditTypes";
import { AssetKind, OverlayAsset, assetEntry, makeAsset } from "./videoAssets";
import { STICKER_COLORS as C, stickerAspect } from "./stickerAssets";

export interface StickerPreset {
  id: string;
  label: string;
  asset: OverlayAsset;
}

const make = (kind: AssetKind, patch: Partial<OverlayAsset> = {}): OverlayAsset => ({ ...makeAsset(kind), ...patch });

export const STICKER_PRESETS: StickerPreset[] = [
  { id: "made-white", label: "Made with", asset: make("chip", { color: C.white, icon: "briefcast", text: "Made with Briefcast" }) },
  { id: "made-blue", label: "Made with", asset: make("chip", { color: C.blue, icon: "briefcast", text: "Made with Briefcast" }) },
  { id: "made-outline", label: "Made with", asset: make("chip", { color: C.white, icon: "briefcast", text: "Made with Briefcast", fill: "outline" }) },
  { id: "made-plain", label: "Made with", asset: make("chip", { color: C.white, icon: "briefcast", text: "Made with Briefcast", fill: "none" }) },
  { id: "label-people", label: "Label", asset: make("chip") },
  { id: "label-partner", label: "Label", asset: make("chip", { icon: "sparkle", text: "Partnered with" }) },
  { id: "label-globe", label: "Label", asset: make("chip", { color: C.blue, icon: "globe", text: "Universities globally" }) },
  { id: "label-plus", label: "Footnote", asset: make("chip", { color: C.teal, icon: "plus", text: "and by partners, even more" }) },
  { id: "place-pin", label: "Place", asset: make("chip", { icon: "pin", text: "Kenya" }) },
  { id: "tag-plain", label: "Tag", asset: make("chip", { color: C.teal, icon: "none", text: "Past" }) },
  { id: "name-tag", label: "Name tag", asset: make("name-tag") },
  { id: "stat", label: "Stat counter", asset: make("stat") },
  { id: "card-doc", label: "Info card", asset: make("card") },
  { id: "card-more", label: "Info card", asset: make("card", { color: C.amber, icon: "plus", tag: "", text: "Tons more coming", subtext: "over the next couple of weeks" }) },
  { id: "place-white", label: "Place card", asset: make("place") },
  { id: "place-blue", label: "Place card", asset: make("place", { color: C.blue, accent: C.amber, text: "Stanford University", subtext: "USA" }) },
  { id: "disc-cap", label: "Icon disc", asset: make("disc") },
  { id: "disc-arrow", label: "Step arrow", asset: make("disc", { icon: "arrow-down", tag: "" }) },
  { id: "title", label: "Title", asset: make("title") },
  { id: "milestone", label: "Milestone", asset: make("milestone") },
  // Beyond the explainer: social, shop, events, reviews, chat.
  { id: "live", label: "Live", asset: make("chip", { color: C.red, icon: "wifi", text: "LIVE" }) },
  { id: "watching", label: "Viewers", asset: make("chip", { color: C.ink, icon: "eye", text: "1.2K watching" }) },
  { id: "link-bio", label: "Link", asset: make("chip", { color: C.white, icon: "link", text: "Link in bio" }) },
  { id: "subscribe", label: "Subscribe", asset: make("chip", { color: C.red, icon: "bell", text: "Subscribe" }) },
  { id: "sale", label: "Sale", asset: make("chip", { color: C.plum, icon: "percent", text: "50% OFF" }) },
  { id: "episode", label: "Episode", asset: make("chip", { color: C.blue, icon: "play", text: "New episode" }) },
  { id: "free", label: "Free", asset: make("chip", { color: C.teal, icon: "gift", text: "Free" }) },
  { id: "tip", label: "Tip", asset: make("chip", { icon: "bulb", text: "Pro tip" }) },
  { id: "quote", label: "Quote", asset: make("quote") },
  { id: "profile", label: "Profile", asset: make("profile") },
  { id: "profile-dark", label: "Profile", asset: make("profile", { color: C.ink, accent: C.red, tag: "Subscribe", subtext: "1.2M subscribers" }) },
  { id: "rating", label: "Rating", asset: make("rating") },
  { id: "meter", label: "Meter", asset: make("meter") },
  { id: "checklist", label: "Checklist", asset: make("checklist") },
  { id: "price", label: "Price", asset: make("price") },
  { id: "chat-them", label: "Chat", asset: make("message") },
  { id: "chat-you", label: "Chat", asset: make("message", { color: C.blue, accent: C.amber, side: "right", tag: "You", text: "Yep - edited it in 10 minutes 😎" }) },
  { id: "versus", label: "Versus", asset: make("versus") },
  { id: "date", label: "Date", asset: make("date") },
  { id: "icon-fire", label: "Icon", asset: make("icon", { icon: "fire", color: C.red, fill: "solid" }) },
  { id: "icon-star", label: "Icon", asset: make("icon") },
  { id: "emoji-fire", label: "Emoji", asset: make("emoji") },
  { id: "emoji-party", label: "Emoji", asset: make("emoji", { text: "\u{1F389}", fill: "solid", color: C.amber, lip: true }) },
];

// ---------- sets ----------

interface SetPiece {
  asset: OverlayAsset;
  // Top-left and height as fractions of a 16:9 frame; width follows the sticker's own shape.
  x: number;
  y: number;
  height: number;
  // Seconds after the set starts that this piece comes in.
  delay: number;
  rotation?: number;
  // Covers the whole frame (a slide's backdrop).
  fullFrame?: boolean;
  // Width over height on a 16:9 frame, where a set lines pieces up to one width.
  aspect?: number;
  // Sits just right of that piece (its index), whatever width its words give it - a row of chips.
  after?: number;
}

export interface StickerSet {
  id: string;
  label: string;
  // How long the set stays up, seconds.
  length: number;
  pieces: SetPiece[];
}

const chipOf = (color: string, icon: OverlayAsset["icon"], text: string) => make("chip", { color, icon, text });
const floaty = (text: string): OverlayAsset => make("emoji", { text, loop: "float" });

const backdrop = (color: string): SetPiece => ({ asset: make("rectangle", { color, color2: undefined, entrance: "wipe", exit: false }), x: 0, y: 0, height: 1, delay: 0, fullFrame: true });

export const STICKER_SETS: StickerSet[] = [
  {
    id: "stat",
    label: "Stat reveal",
    length: 6,
    pieces: [
      { asset: make("chip"), x: 0.06, y: 0.22, height: 0.065, delay: 0 },
      { asset: make("stat"), x: 0.055, y: 0.3, height: 0.22, delay: 0.3 },
      { asset: make("chip", { color: C.teal, icon: "plus", text: "and by partners, even more" }), x: 0.08, y: 0.54, height: 0.06, delay: 2.3 },
    ],
  },
  {
    id: "flow",
    label: "How it works",
    length: 7,
    pieces: [
      { asset: make("chip", { color: C.white, icon: "none", text: "All Brightpath students" }), x: 0.72, y: 0.2, height: 0.06, delay: 0 },
      { asset: make("chip", { icon: "none", text: "Current" }), x: 0.725, y: 0.285, height: 0.055, delay: 0.4 },
      { asset: make("chip", { color: C.teal, icon: "none", text: "Past" }), after: 1, x: 0, y: 0.285, height: 0.055, delay: 0.6 },
      { asset: make("card"), x: 0.72, y: 0.38, height: 0.14, delay: 1.1 },
      { asset: make("disc", { icon: "arrow-down", tag: "" }), x: 0.8, y: 0.545, height: 0.065, delay: 1.6 },
      { asset: make("chip", { color: C.white, icon: "cap", text: "Further your education" }), x: 0.73, y: 0.63, height: 0.055, delay: 2 },
      { asset: make("chip", { color: C.plum, icon: "none", text: "Master's" }), x: 0.74, y: 0.715, height: 0.05, delay: 2.6 },
      { asset: make("chip", { icon: "none", text: "Bachelor's" }), after: 6, x: 0, y: 0.715, height: 0.05, delay: 2.8 },
    ],
  },
  {
    id: "partners",
    label: "Partners list",
    length: 7,
    pieces: [
      { asset: make("chip", { icon: "sparkle", text: "Partnered with" }), x: 0.73, y: 0.2, height: 0.055, delay: 0 },
      // One width down the column, as a list reads.
      { asset: make("place"), x: 0.73, y: 0.275, height: 0.17, delay: 0.5, aspect: (0.21 * 16) / 9 / 0.17 },
      { asset: make("place", { color: C.blue, accent: C.amber, text: "Stanford University", subtext: "USA" }), x: 0.73, y: 0.465, height: 0.135, delay: 1.5, aspect: (0.21 * 16) / 9 / 0.135 },
      { asset: make("card", { color: C.amber, icon: "plus", tag: "", text: "Tons more coming", subtext: "over the next couple of weeks" }), x: 0.73, y: 0.625, height: 0.13, delay: 2.5, aspect: (0.21 * 16) / 9 / 0.13 },
    ],
  },
  {
    id: "places",
    label: "Around the world",
    length: 6,
    pieces: [
      { asset: make("chip", { color: C.blue, icon: "globe", text: "Universities globally" }), x: 0.4, y: 0.08, height: 0.055, delay: 0 },
      { asset: make("chip", { color: C.teal, icon: "pin", text: "Nigeria" }), x: 0.82, y: 0.36, height: 0.05, delay: 0.6, rotation: 2 },
      { asset: make("chip", { icon: "pin", text: "Kenya" }), x: 0.04, y: 0.4, height: 0.05, delay: 0.9, rotation: -3 },
      { asset: make("chip", { color: C.plum, icon: "pin", text: "US" }), x: 0.86, y: 0.48, height: 0.05, delay: 1.2, rotation: -2 },
      { asset: make("chip", { color: C.white, icon: "pin", text: "UK" }), x: 0.06, y: 0.56, height: 0.05, delay: 1.5, rotation: 2 },
      { asset: make("chip", { icon: "pin", text: "Canada" }), x: 0.82, y: 0.62, height: 0.05, delay: 1.8, rotation: -2 },
    ],
  },
  {
    id: "intro",
    label: "Intro slide",
    length: 4,
    pieces: [
      backdrop(C.blue),
      { asset: make("title"), x: 0.08, y: 0.3, height: 0.34, delay: 0.3 },
      { asset: make("confetti", { color: C.amber, color2: C.white, exit: false }), x: 0.5, y: 0.08, height: 0.5, delay: 0.7 },
    ],
  },
  {
    id: "anniversary",
    label: "Milestone slide",
    length: 4,
    pieces: [
      backdrop(C.blue),
      { asset: make("milestone"), x: 0.3, y: 0.33, height: 0.3, delay: 0.3 },
      { asset: make("chip", { color: C.plum, icon: "none", text: "Yes, 5 years!" }), x: 0.6, y: 0.62, height: 0.05, delay: 1.1, rotation: -6 },
      { asset: make("sparkles", { color: C.white, color2: C.amber, glow: false }), x: 0.62, y: 0.12, height: 0.3, delay: 0.6 },
    ],
  },
  {
    id: "end",
    label: "End card",
    length: 5,
    pieces: [
      backdrop(C.blue),
      { asset: make("title", { tag: "" }), x: 0.08, y: 0.3, height: 0.3, delay: 0.3 },
      { asset: make("chip", { icon: "sparkle", text: "5 years" }), x: 0.08, y: 0.64, height: 0.05, delay: 0.9 },
      { asset: make("chip", { color: C.teal, icon: "users", text: "200,000+ trained" }), after: 2, x: 0, y: 0.64, height: 0.05, delay: 1.1 },
    ],
  },
  {
    id: "testimonial",
    label: "Testimonial",
    length: 6,
    pieces: [
      { asset: make("quote"), x: 0.05, y: 0.16, height: 0.32, delay: 0 },
      { asset: make("rating"), x: 0.05, y: 0.52, height: 0.13, delay: 1.2 },
    ],
  },
  {
    id: "drop",
    label: "Product drop",
    length: 6,
    pieces: [
      { asset: chipOf(C.plum, "sparkle", "NEW DROP"), x: 0.06, y: 0.2, height: 0.06, delay: 0 },
      { asset: make("price"), x: 0.06, y: 0.28, height: 0.22, delay: 0.4 },
      { asset: make("icon", { icon: "cart", fill: "solid", color: C.amber }), x: 0.24, y: 0.22, height: 0.1, delay: 0.9, rotation: 8 },
      { asset: chipOf(C.red, "clock", "Limited time"), x: 0.06, y: 0.535, height: 0.055, delay: 1.4 },
    ],
  },
  {
    id: "follow",
    label: "Follow end screen",
    length: 6,
    pieces: [
      { asset: make("profile", { color: C.ink, accent: C.red, tag: "Subscribe", subtext: "New videos every Friday" }), x: 0.29, y: 0.38, height: 0.14, delay: 0 },
      { asset: chipOf(C.red, "heart", "Like"), x: 0.31, y: 0.56, height: 0.06, delay: 0.6 },
      { asset: chipOf(C.white, "send", "Share"), after: 1, x: 0, y: 0.56, height: 0.06, delay: 0.8 },
      { asset: chipOf(C.amber, "bell", "Turn on alerts"), after: 2, x: 0, y: 0.56, height: 0.06, delay: 1 },
    ],
  },
  {
    id: "event",
    label: "Event invite",
    length: 6,
    pieces: [
      { asset: chipOf(C.amber, "sparkle", "You're invited"), x: 0.06, y: 0.2, height: 0.06, delay: 0 },
      { asset: make("date"), x: 0.06, y: 0.285, height: 0.18, delay: 0.4 },
      { asset: chipOf(C.teal, "gift", "Free entry"), x: 0.06, y: 0.5, height: 0.055, delay: 1.1 },
      { asset: chipOf(C.white, "link", "Register - link below"), after: 2, x: 0, y: 0.5, height: 0.055, delay: 1.3 },
    ],
  },
  {
    id: "versus",
    label: "Before & after",
    length: 7,
    pieces: [
      { asset: make("versus"), x: 0.37, y: 0.07, height: 0.12, delay: 0 },
      { asset: make("checklist", { color: C.white, accent: C.red, tag: "Before", text: "Hours of editing; Messy cuts; No captions" }), x: 0.05, y: 0.26, height: 0.3, delay: 0.6 },
      { asset: make("checklist", { color: C.blue, accent: C.amber, tag: "After", text: "Done in minutes; Clean jump cuts; Auto captions" }), x: 0.66, y: 0.26, height: 0.3, delay: 1.6 },
    ],
  },
  {
    id: "progress",
    label: "Progress report",
    length: 6,
    pieces: [
      { asset: chipOf(C.blue, "trend", "Q3 goals"), x: 0.64, y: 0.16, height: 0.06, delay: 0 },
      { asset: make("meter", { text: "Signups", countTo: 82 }), x: 0.64, y: 0.245, height: 0.11, delay: 0.3 },
      { asset: make("meter", { text: "Revenue", countTo: 64, accent: C.amber }), x: 0.64, y: 0.37, height: 0.11, delay: 0.7 },
      { asset: make("meter", { text: "Retention", countTo: 91, accent: C.blue }), x: 0.64, y: 0.495, height: 0.11, delay: 1.1 },
    ],
  },
  {
    id: "chat",
    label: "Chat story",
    length: 7,
    pieces: [
      { asset: make("message", { tag: "Sam", text: "Did you really edit this on your laptop?" }), x: 0.05, y: 0.14, height: 0.15, delay: 0 },
      { asset: make("message", { color: C.blue, accent: C.amber, side: "right", tag: "You", text: "Yep - 10 minutes in Briefcast 😎" }), x: 0.62, y: 0.34, height: 0.15, delay: 1.7 },
      { asset: make("message", { tag: "Sam", text: "Okay I'm downloading it right now" }), x: 0.05, y: 0.54, height: 0.15, delay: 3.4 },
    ],
  },
  {
    id: "steps",
    label: "Three steps",
    length: 6,
    pieces: [
      { asset: make("disc", { icon: "number-1", tag: "", color: C.blue }), x: 0.06, y: 0.22, height: 0.09, delay: 0 },
      { asset: chipOf(C.white, "none", "Record your screen"), after: 0, x: 0, y: 0.235, height: 0.06, delay: 0.15 },
      { asset: make("disc", { icon: "number-2", tag: "", color: C.blue }), x: 0.06, y: 0.35, height: 0.09, delay: 0.7 },
      { asset: chipOf(C.white, "none", "Trim the pauses"), after: 2, x: 0, y: 0.365, height: 0.06, delay: 0.85 },
      { asset: make("disc", { icon: "number-3", tag: "", color: C.blue }), x: 0.06, y: 0.48, height: 0.09, delay: 1.4 },
      { asset: chipOf(C.white, "none", "Share the link"), after: 4, x: 0, y: 0.495, height: 0.06, delay: 1.55 },
    ],
  },
  {
    id: "tip",
    label: "Pro tip",
    length: 5,
    pieces: [
      { asset: make("icon", { icon: "bulb", fill: "solid", color: C.amber }), x: 0.06, y: 0.24, height: 0.13, delay: 0 },
      { asset: make("card", { color: C.white, icon: "none", tag: "Pro tip", text: "Hold Shift to snap", subtext: "Everything lines up to the centre" }), after: 0, x: 0, y: 0.235, height: 0.14, delay: 0.35 },
    ],
  },
  {
    id: "reactions",
    label: "Reactions",
    length: 5,
    pieces: [
      { asset: floaty("\u{1F525}"), x: 0.08, y: 0.2, height: 0.13, delay: 0, rotation: -10 },
      { asset: floaty("\u{1F602}"), x: 0.82, y: 0.16, height: 0.12, delay: 0.3, rotation: 8 },
      { asset: floaty("\u{1F60D}"), x: 0.12, y: 0.62, height: 0.12, delay: 0.6, rotation: 6 },
      { asset: floaty("\u{1F44F}"), x: 0.8, y: 0.6, height: 0.13, delay: 0.9, rotation: -8 },
      { asset: floaty("\u{1F389}"), x: 0.66, y: 0.08, height: 0.11, delay: 1.2, rotation: 10 },
    ],
  },
  {
    id: "live",
    label: "Live badge",
    length: 8,
    pieces: [
      { asset: make("chip", { color: C.red, icon: "wifi", text: "LIVE", loop: "pulse" }), x: 0.035, y: 0.05, height: 0.055, delay: 0 },
      { asset: chipOf(C.ink, "eye", "1.2K watching"), after: 0, x: 0, y: 0.05, height: 0.055, delay: 0.3 },
    ],
  },
];

// The box a sticker is added with: `height` of the frame, as wide as its shape (its words, for one
// that hugs them), never wider than most of the frame.
export function stickerBox(asset: OverlayAsset, height: number, frameAspect: number, fixedAspect?: number): { width: number; height: number } {
  const aspect = fixedAspect ?? stickerAspect(asset) ?? assetEntry(asset.kind).aspect;
  let h = height;
  let w = (h * aspect) / frameAspect;
  if (w > 0.9) {
    w = 0.9;
    h = (w * frameAspect) / aspect;
  }
  return { width: w, height: h };
}

// A set's pieces as overlays, starting at `start` - laid out for 16:9 and kept on the frame for any
// other shape (a piece's right edge pulls it back in; on a tall frame everything scales to fit).
export function placeStickerSet(set: StickerSet, frameAspect: number, start: number, total: number): ImageOverlay[] {
  const end = Math.min(total, start + set.length);
  // Heights were chosen for 16:9 - on a tall frame the same height is far wider in proportion.
  const shrink = Math.min(1, frameAspect / (16 / 9));
  const placed: ImageOverlay[] = [];
  for (const p of set.pieces) {
    const from = Math.min(end - 0.5, start + p.delay);
    if (p.fullFrame) {
      placed.push(makeImageOverlay("", 0, 0, 1, 1, Math.max(start, from), end, p.asset));
      continue;
    }
    const box = stickerBox(p.asset, p.height * shrink, frameAspect, p.aspect);
    const prev = p.after !== undefined ? placed[p.after] : undefined;
    const wantX = prev ? prev.x + prev.width + 0.012 : p.x;
    const x = Math.max(0.02, Math.min(wantX, 0.98 - box.width));
    const y = Math.max(0.02, Math.min(p.y, 0.98 - box.height));
    const o = makeImageOverlay("", x, y, box.width, box.height, Math.max(start, from), end, p.asset);
    placed.push(p.rotation ? { ...o, rotation: p.rotation } : o);
  }
  return placed;
}
