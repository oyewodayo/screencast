// utils/videoStyleTemplates.ts
//
// Style templates for "Create a video" (NewVideoProjectDialog): a folder of photos plus a song
// becomes a finished, beat-synced edit in one click - the way a CapCut template does it. A
// template is a script over what the editor already has:
//
//   - shots: one photo each, or a collage scene (a 2x2 grid, three framed photos, colour panels
//     with words) that holds for two cuts - each lasting a set number of the song's beats;
//   - a cycle of transitions (zoom blur, whip, flash, cube, slice...), camera motion and a look;
//   - caption cards placed on shots - stacks of lines, each in a title look (titleStyles.ts) with
//     its own letter animation (textReveal.ts) - and full-frame overlays (film strip, grain...).
//
// buildStyledProject turns one into an ordinary VideoEditState, so every cut, caption, collage cell
// and overlay stays editable afterwards; the dialog's stage plays that same state.
import { AssetKind, makeAsset } from "./videoAssets";
import { clipOutputDuration } from "./clipTiming";
import type { MusicTrack } from "./musicLibrary";
import type { TextRevealSettings } from "./textReveal";
import { lookPatch, titleStyle } from "./titleStyles";
import { makeAudioOverlay, makeImageOverlay, makeTextOverlay } from "../handlers/videoEditHandlers";
import {
  AdjustmentLayer,
  AudioLibraryInfo,
  AudioOverlay,
  Clip,
  ClipCrop,
  ClipFxKind,
  GradeLookName,
  ImageOverlay,
  KenBurnsPreset,
  OverlayAnimation,
  TextOverlay,
  TransitionType,
  VideoEditState,
  VideoProjectFrame,
  createProjectState,
} from "./videoEditTypes";

// ---------- the script ----------

// Words the user can change in the dialog; caption lines and scenes refer to them by id.
export interface TemplateText {
  id: string;
  label: string;
  sample: string;
}

export interface CaptionLine {
  slot: string;
  // A title look (titleStyles.ts).
  style: string;
  // Font size as a fraction of the frame's short side.
  size: number;
  animation: OverlayAnimation;
  reveal?: TextRevealSettings;
  // Seconds after the card comes up.
  delay?: number;
  caps?: boolean;
}

export interface CaptionCard {
  // Which shot it comes up on (negative counts from the end: -1 is the last shot), and for how many.
  at: number;
  shots: number;
  // Centre of the stack, fraction of the frame height - and across, fraction of the width (default
  // the middle).
  y: number;
  x?: number;
  // Turns the whole card (degrees clockwise): -90 runs it up the frame, a vertical title.
  rotate?: number;
  lines: CaptionLine[];
}

export type TemplateScene =
  // Four photos in a 2x2 grid with thin gutters.
  | { kind: "grid"; at: number; backdrop: string }
  // Three photos in white frames - stacked on a tall frame, side by side on a wide one.
  | { kind: "triptych"; at: number; backdrop: string; border: string }
  // Two photos and two colour panels carrying a word each, in a checkerboard.
  | { kind: "panels"; at: number; backdrop: string; words: [CaptionLine, CaptionLine] };

export const SCENE_PHOTOS: Record<TemplateScene["kind"], number> = { grid: 4, triptych: 3, panels: 2 };

export interface StyleTemplate {
  id: string;
  label: string;
  blurb: string;
  // The card's colours, and the word its tile shows in the template's signature look.
  swatch: [string, string];
  cardStyle: string;
  cardWord: string;
  // Every cut lands this many beats after the last one (with a song); seconds per photo without.
  beatsPerPhoto: number;
  seconds: number;
  // Into each shot after the first, in turn.
  transitions: TransitionType[];
  // How long a transition lasts, as a share of the shorter shot either side of it.
  transitionShare: number;
  motion: KenBurnsPreset[];
  motionIntensity: number;
  look: GradeLookName | null;
  overlays: AssetKind[];
  // A clip effect (clipFx.ts) on each plain shot in turn - null for none.
  fx: (ClipFxKind | null)[];
  fxIntensity: number;
  texts: TemplateText[];
  captions: CaptionCard[];
  scenes: TemplateScene[];
  // A lower third after the opening (videoAssets' "lower-third"): its name and second-line slots.
  lowerThird?: { name: string; line: string };
  // The brand cards this style is made for - switched on when it's picked and a brand is set up.
  suggestBrand?: { intro?: BrandIntroStyle; outro?: boolean; bar?: boolean };
  // What the suggested songs sound like: catalog energy (1 calm .. 5 driving) and words matched
  // against moods, tags and genre.
  music: { energy: [number, number]; words: string[] };
}

const line = (slot: string, style: string, size: number, animation: OverlayAnimation, extra: Partial<CaptionLine> = {}): CaptionLine => ({ slot, style, size, animation, ...extra });

export const STYLE_TEMPLATES: StyleTemplate[] = [
  {
    id: "grand-opening",
    label: "Grand Opening",
    blurb: "Made for video - whip and flash cuts, WE ARE OPEN, a shop-now pill",
    swatch: ["#111827", "#facc15"],
    cardStyle: "bold-yellow",
    cardWord: "OPEN",
    beatsPerPhoto: 2,
    seconds: 1.4,
    transitions: ["whip", "fadewhite", "zoomblur", "push", "lightleak", "slice"],
    transitionShare: 0.35,
    motion: ["punch-in", "zoom-in", "pan-right", "zoom-out"],
    motionIntensity: 0.5,
    look: null,
    overlays: [],
    fx: [null, null, "rgbsplit", null, null],
    fxIntensity: 0.4,
    texts: [
      { id: "kicker", label: "Above", sample: "WE ARE" },
      { id: "h1", label: "Headline", sample: "OPEN" },
      { id: "script", label: "Script", sample: "Now" },
      { id: "cta", label: "Button", sample: "Shop Now" },
      { id: "end", label: "Closing", sample: "SEE YOU THERE" },
    ],
    captions: [
      {
        at: 1,
        shots: 3,
        y: 0.5,
        lines: [
          line("kicker", "tracked-caps", 0.045, "spread"),
          line("h1", "bold-yellow", 0.22, "zoomin", { delay: 0.15 }),
          line("script", "script-white", 0.1, "popin", { delay: 0.45 }),
          line("cta", "highlight", 0.04, "popin", { delay: 0.8 }),
        ],
      },
      { at: -1, shots: 1, y: 0.5, lines: [line("end", "bold-yellow", 0.12, "mask")] },
    ],
    scenes: [],
    suggestBrand: { intro: "loading", outro: true },
    music: { energy: [4, 5], words: ["upbeat", "energetic", "pop", "dance", "hype", "happy"] },
  },
  {
    id: "luxury",
    label: "Luxury",
    blurb: "A fading serif wordmark over gold script, slow and rich",
    swatch: ["#3f0712", "#be123c"],
    cardStyle: "fade-serif",
    cardWord: "VÉRA",
    beatsPerPhoto: 4,
    seconds: 3,
    transitions: ["fade", "lightleak", "slider", "fade"],
    transitionShare: 0.4,
    motion: ["zoom-in", "drift", "push", "zoom-out"],
    motionIntensity: 0.35,
    look: null,
    overlays: [],
    fx: [],
    fxIntensity: 0,
    texts: [
      { id: "mark", label: "Wordmark", sample: "VÉRA" },
      { id: "script", label: "Script", sample: "Bracelet" },
      { id: "line", label: "Under it", sample: "COLLECTION" },
      { id: "cta", label: "Closing", sample: "Get the collection!" },
      { id: "url", label: "Link", sample: "www.yourbrand.com" },
    ],
    captions: [
      { at: 0, shots: 3, y: 0.24, lines: [line("mark", "fade-serif", 0.22, "blur", { reveal: { speed: 0.7 } }), line("script", "gold-script", 0.11, "blur", { delay: 0.6 }), line("line", "tracked-caps", 0.032, "spread", { delay: 1 })] },
      { at: -1, shots: 1, y: 0.3, lines: [line("cta", "playfair-italic-title", 0.075, "typewriter", { reveal: { speed: 1.2, caret: false } }), line("url", "tracked-caps", 0.028, "fade", { delay: 0.8 })] },
    ],
    scenes: [{ kind: "triptych", at: 3, backdrop: "#3f0712", border: "#fff7ed" }],
    suggestBrand: { bar: true, outro: true },
    music: { energy: [2, 3], words: ["elegant", "piano", "cinematic", "lounge", "romantic", "luxury"] },
  },
  {
    id: "event-recap",
    label: "Event Recap",
    blurb: "Glowing headlines over gold script, a photo grid, a sticker finish",
    swatch: ["#1d4ed8", "#06b6d4"],
    cardStyle: "headline-glow",
    cardWord: "RECAP",
    beatsPerPhoto: 2,
    seconds: 1.6,
    transitions: ["zoomblur", "push", "whip", "tiles", "fadewhite", "slice", "cube"],
    transitionShare: 0.35,
    motion: ["punch-in", "zoom-in", "pan-right", "zoom-out", "pan-left"],
    motionIntensity: 0.5,
    look: null,
    overlays: [],
    fx: [null, "focus", null, "rgbsplit", null, null], fxIntensity: 0.55,
    texts: [
      { id: "h1", label: "Opening headline", sample: "EVERY YEAR" },
      { id: "s1", label: "Opening line", sample: "We Gather!" },
      { id: "s2", label: "Second line", sample: "We Celebrate!" },
      { id: "h3", label: "Build-up headline", sample: "THIS YEAR!" },
      { id: "s3", label: "Build-up line", sample: "will not be an exception" },
      { id: "end", label: "Finale", sample: "ARE YOU READY?" },
    ],
    captions: [
      { at: 0, shots: 2, y: 0.5, lines: [line("h1", "headline-glow", 0.15, "typewriter", { reveal: { speed: 1.3, caret: true, caretStyle: "bar" } }), line("s1", "gold-script", 0.13, "popin", { delay: 0.55 })] },
      { at: 3, shots: 2, y: 0.5, lines: [line("h1", "headline-glow", 0.15, "mask"), line("s2", "gold-script", 0.13, "popin", { delay: 0.35 })] },
      { at: -3, shots: 2, y: 0.62, lines: [line("h3", "comic", 0.15, "zoomin"), line("s3", "bold-italic", 0.055, "typewriter", { delay: 0.45, reveal: { speed: 1.6, caret: false } })] },
      { at: -1, shots: 1, y: 0.5, lines: [line("end", "sticker", 0.16, "bounce")] },
    ],
    scenes: [{ kind: "grid", at: 5, backdrop: "#ffffff" }],
    music: { energy: [4, 5], words: ["upbeat", "happy", "energetic", "celebration", "party", "pop", "fun"] },
  },
  {
    id: "film-strip",
    label: "Film Strip",
    blurb: "Rolling film edges, grain, a marker title on a paper strip",
    swatch: ["#57534e", "#f59e0b"],
    cardStyle: "paper-marker",
    cardWord: "Film",
    beatsPerPhoto: 4,
    seconds: 2.4,
    transitions: ["fadewhite", "slideleft", "whip", "fade", "strips"],
    transitionShare: 0.3,
    motion: ["drift", "zoom-in", "float", "zoom-out"],
    motionIntensity: 0.45,
    look: "film",
    overlays: ["filmstrip", "grain"],
    fx: ["colorin", "flicker", "flicker"], fxIntensity: 0.45,
    texts: [
      { id: "title", label: "Title", sample: "Take a journey with us" },
      { id: "sub", label: "Under the title", sample: "through the month of August" },
      { id: "end", label: "Closing", sample: "SEE YOU NEXT TIME" },
    ],
    captions: [
      { at: 0, shots: 2, y: 0.47, lines: [line("title", "paper-marker", 0.085, "typewriter", { reveal: { speed: 1.2, caret: true, caretStyle: "block" } }), line("sub", "typewriter", 0.045, "words", { delay: 1.1 })] },
      { at: -1, shots: 1, y: 0.5, lines: [line("end", "tracked-caps", 0.07, "spread")] },
    ],
    scenes: [{ kind: "triptych", at: 3, backdrop: "#14110f", border: "#f4f1ea" }],
    music: { energy: [2, 4], words: ["indie", "nostalgic", "lofi", "chill", "vintage", "retro", "acoustic"] },
  },
  {
    id: "new-collection",
    label: "New Collection",
    blurb: "Editorial serif, a framed trio, colour panels, a shop-now card",
    swatch: ["#4a2e14", "#c8a77e"],
    cardStyle: "luxe-serif",
    cardWord: "New",
    beatsPerPhoto: 2,
    seconds: 1.8,
    transitions: ["slice", "strips", "split", "push", "fade", "slideleft"],
    transitionShare: 0.35,
    motion: ["zoom-in", "drift", "zoom-out", "pan-up"],
    motionIntensity: 0.35,
    look: null,
    overlays: [],
    fx: [], fxIntensity: 0,
    texts: [
      { id: "title", label: "Title", sample: "New Collection" },
      { id: "w1", label: "Word 1", sample: "STYLISH" },
      { id: "w2", label: "Word 2", sample: "MODERN" },
      { id: "w3", label: "Word 3", sample: "CONFIDENT" },
      { id: "w4", label: "Word 4", sample: "ELEGANT" },
      { id: "cta", label: "Call to action", sample: "SHOP NOW!" },
      { id: "url", label: "Link", sample: "www.yourbrand.com" },
    ],
    captions: [
      // Up the left edge, as the fashion reference sets it - the photo stays clear.
      { at: 0, shots: 2, y: 0.5, x: 0.13, rotate: -90, lines: [line("title", "luxe-serif", 0.17, "mask")] },
      { at: 4, shots: 1, y: 0.2, lines: [line("w3", "tracked-caps", 0.05, "spread")] },
      { at: 5, shots: 1, y: 0.2, lines: [line("w4", "tracked-caps", 0.05, "spread")] },
      { at: -1, shots: 1, y: 0.74, lines: [line("cta", "fatface", 0.13, "popin"), line("url", "caption", 0.04, "fade", { delay: 0.5 })] },
    ],
    scenes: [
      { kind: "triptych", at: 1, backdrop: "#4a2e14", border: "#ffffff" },
      { kind: "panels", at: 3, backdrop: "#4a2e14", words: [line("w1", "tracked-caps", 0.05, "spread"), line("w2", "tracked-caps", 0.05, "spread", { delay: 0.2 })] },
    ],
    music: { energy: [3, 4], words: ["fashion", "chic", "stylish", "lounge", "house", "groove", "elegant"] },
  },
  {
    id: "promo",
    label: "Promo",
    blurb: "Every beat - glitch, zoom blur, fire titles, a hard finish",
    swatch: ["#be123c", "#f97316"],
    cardStyle: "fire",
    cardWord: "DROP",
    beatsPerPhoto: 1,
    seconds: 0.8,
    transitions: ["glitch", "zoomblur", "spin", "flip", "blocks", "whip", "fadewhite"],
    transitionShare: 0.45,
    motion: ["punch-in", "bounce-in", "pulse", "shake"],
    motionIntensity: 0.6,
    look: "tealorange",
    overlays: ["vignette"],
    fx: ["rgbsplit", "huecycle", null, "echo"], fxIntensity: 0.6,
    texts: [
      { id: "h1", label: "Opening", sample: "NEW DROP" },
      { id: "mid", label: "Middle", sample: "LIMITED EDITION" },
      { id: "end", label: "Finale", sample: "AVAILABLE NOW" },
    ],
    captions: [
      { at: 0, shots: 3, y: 0.5, lines: [line("h1", "fire", 0.2, "zoomin")] },
      { at: 6, shots: 3, y: 0.5, lines: [line("mid", "chrome", 0.13, "mask")] },
      { at: -2, shots: 2, y: 0.5, lines: [line("end", "bold-italic", 0.12, "popin")] },
    ],
    scenes: [{ kind: "grid", at: 9, backdrop: "#0a0a0a" }],
    music: { energy: [5, 5], words: ["energetic", "epic", "hype", "electronic", "action", "sport", "trailer", "rock"] },
  },
  {
    id: "night-city",
    label: "Neon Night",
    blurb: "Light beams and flickering neon signs in a cyber grade",
    swatch: ["#3b0764", "#06b6d4"],
    cardStyle: "neon-pink",
    cardWord: "NEON",
    beatsPerPhoto: 2,
    seconds: 1.6,
    transitions: ["beam", "zoomblur", "slice", "spin", "glitch", "cube"],
    transitionShare: 0.4,
    motion: ["push", "sway", "punch-in", "zoom-out"],
    motionIntensity: 0.55,
    look: "cyber",
    overlays: ["vignette"],
    fx: ["echo", null, "rgbsplit", null, "huecycle"], fxIntensity: 0.55,
    texts: [
      { id: "h1", label: "Opening", sample: "AFTER DARK" },
      { id: "mid", label: "Middle", sample: "CITY LIGHTS" },
      { id: "end", label: "Finale", sample: "OPEN ALL NIGHT" },
    ],
    captions: [
      { at: 0, shots: 3, y: 0.5, lines: [line("h1", "neon-blue", 0.13, "flicker")] },
      { at: 5, shots: 2, y: 0.5, lines: [line("mid", "neon-pink", 0.12, "flicker")] },
      { at: -1, shots: 1, y: 0.5, lines: [line("end", "neon-blue", 0.1, "mask")] },
    ],
    scenes: [],
    music: { energy: [3, 5], words: ["electronic", "synthwave", "night", "dark", "dance", "techno", "house"] },
  },
  {
    id: "memories",
    label: "Memories",
    blurb: "Slow and golden, light leaks, handwritten script",
    swatch: ["#9a3412", "#fda4af"],
    cardStyle: "gold-script",
    cardWord: "Love",
    beatsPerPhoto: 4,
    seconds: 3,
    transitions: ["lightleak", "fade", "pagecurl", "lightleak", "iris"],
    transitionShare: 0.4,
    motion: ["float", "breathe", "drift", "zoom-out"],
    motionIntensity: 0.5,
    look: "golden",
    overlays: ["lightleak"],
    fx: ["colorin", null, null, "focus"], fxIntensity: 0.5,
    texts: [
      { id: "title", label: "Title", sample: "Our Memories" },
      { id: "sub", label: "Under the title", sample: "SUMMER 2026" },
      { id: "end", label: "Closing", sample: "Forever" },
    ],
    captions: [
      { at: 0, shots: 2, y: 0.5, lines: [line("title", "gold-script", 0.16, "blur", { reveal: { speed: 0.8 } }), line("sub", "tracked-caps", 0.04, "spread", { delay: 0.9 })] },
      { at: -1, shots: 1, y: 0.5, lines: [line("end", "dancing", 0.16, "blur")] },
    ],
    scenes: [{ kind: "triptych", at: 3, backdrop: "#2a1a10", border: "#fffaf0" }],
    music: { energy: [1, 3], words: ["romantic", "sentimental", "piano", "acoustic", "warm", "emotional", "love", "gentle"] },
  },
  {
    id: "lecture-teaser",
    label: "Lecture Teaser",
    blurb: "Calm pace, clean slides, a speaker lower third and a date card",
    swatch: ["#0f766e", "#a3e635"],
    cardStyle: "label-red",
    cardWord: "TALK",
    beatsPerPhoto: 4,
    seconds: 3.5,
    transitions: ["fade", "push", "slideleft", "wipeleft"],
    transitionShare: 0.25,
    motion: ["zoom-in", "pan-right", "zoom-in", "pan-left"],
    motionIntensity: 0.3,
    look: null,
    overlays: [],
    fx: [], fxIntensity: 0,
    texts: [
      { id: "talk", label: "Lecture title", sample: "Diffusion Models, Explained" },
      { id: "speaker", label: "Speaker", sample: "Speaker · Department" },
      { id: "kicker", label: "Above the title", sample: "COMING UP" },
      { id: "date", label: "Date & place", sample: "Thursday 4 PM · Hall B" },
    ],
    captions: [
      { at: 0, shots: 2, y: 0.44, lines: [line("kicker", "label-red", 0.045, "mask"), line("talk", "luxe-serif", 0.09, "mask", { delay: 0.3 })] },
      { at: -1, shots: 1, y: 0.5, lines: [line("talk", "luxe-serif", 0.08, "words"), line("date", "caption", 0.045, "fade", { delay: 0.6 })] },
    ],
    lowerThird: { name: "talk", line: "speaker" },
    scenes: [],
    music: { energy: [2, 3], words: ["calm", "corporate", "inspiring", "background", "ambient", "piano", "study"] },
  },
];

export const styleTemplate = (id: string | null): StyleTemplate | null => STYLE_TEMPLATES.find((t) => t.id === id) ?? null;

// The template's words as the dialog starts them: its samples.
export const templateTexts = (template: StyleTemplate): Record<string, string> => Object.fromEntries(template.texts.map((t) => [t.id, t.sample]));

// ---------- music ----------

// Seconds per photo for `beatsPerPhoto` beats of a song at `bpm` - or `fallback` with no tempo.
export const photoSecondsAt = (bpm: number | undefined, beatsPerPhoto: number, fallback: number): number =>
  bpm && bpm > 0 ? (beatsPerPhoto * 60) / bpm : fallback;

// What a video made without a template asks of its music - a lively photo montage.
export const MONTAGE_MUSIC: StyleTemplate["music"] = { energy: [3, 4], words: ["upbeat", "happy", "inspiring"] };

// The songs from the library that suit `music` best, the best first: energy in range, words that
// match its moods, and long enough to carry `wanted` seconds from the song's best part.
export function suggestTemplateTracks(tracks: MusicTrack[], music: StyleTemplate["music"], wanted: number, limit = 8): MusicTrack[] {
  const [lo, hi] = music.energy;
  return tracks
    .filter((t) => t.kind === "music")
    .map((t) => {
      const energy = t.energy ?? 3;
      let score = energy >= lo && energy <= hi ? 4 : -1.5 * Math.min(Math.abs(energy - lo), Math.abs(energy - hi));
      const words = [t.genre ?? "", ...t.moods, ...t.tags].join(" ").toLowerCase();
      score += Math.min(3, music.words.filter((w) => words.includes(w)).length);
      if (t.duration - (t.highlightStart ?? 0) >= wanted) score += 1.5;
      else if (t.duration >= wanted) score += 0.5;
      // Known beats mean the preview already cuts on them, before the song is downloaded.
      if (t.bpm && t.beats?.length) score += 0.5;
      return { t, score };
    })
    .sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title))
    .slice(0, limit)
    .map((s) => s.t);
}

// The song under the edit, as the dialog resolved it (a library track downloaded, or a file).
export interface StyledProjectMusic {
  path: string;
  sourceDuration: number;
  bpm?: number;
  beats?: number[];
  // Where the song gets going (library tracks know theirs) - the edit starts there when the rest of
  // the song is long enough to carry it.
  highlightStart?: number;
  label: string;
  library?: AudioLibraryInfo;
}

// Where in the song the edit starts: at (or just after) its best part when the rest of the song can
// carry `wanted` seconds, else as late as still fits - always on a beat, so the cuts land on them.
export function musicStartFor(music: Pick<StyledProjectMusic, "sourceDuration" | "beats" | "highlightStart">, wanted: number): number {
  const latest = Math.max(0, music.sourceDuration - wanted);
  const want = Math.min(music.highlightStart ?? 0, latest);
  if (!music.beats?.length) return want;
  const before = [...music.beats].reverse().find((b) => b <= want + 0.05);
  const after = music.beats.find((b) => b >= want - 0.05 && b <= latest + 0.05);
  return after ?? before ?? music.beats[0];
}

// ---------- building ----------

// The brand a video can open and close on: a logo (optional - the name stands in), a name, a line
// under it and a website.
export type BrandIntroStyle = "neon" | "stamp" | "lines" | "loading";
export const BRAND_INTROS: { id: BrandIntroStyle; label: string; blurb: string }[] = [
  { id: "neon", label: "Neon frame", blurb: "A neon frame draws itself on, the logo pops in with a shine" },
  { id: "stamp", label: "Stamp", blurb: "The logo drops in and lands on a glowing halo" },
  { id: "lines", label: "Lines", blurb: "Guide lines draw a frame, the name rises out of it" },
  { id: "loading", label: "Loading", blurb: "A loader spins, then the logo bursts in" },
];

export interface BrandOptions {
  name: string;
  tagline: string;
  website: string;
  // The logo picture and its width / height.
  logo: { path: string; aspect: number } | null;
  intro: BrandIntroStyle | null;
  // A closing card: logo, name and website.
  outro: boolean;
  // The name small along the top and the website along the bottom, all the way through.
  bar: boolean;
}

export interface StyledProjectOptions {
  // Null builds a plain slideshow from the settings below (Custom in the dialog).
  templateId: string | null;
  // Seconds per photo with no song.
  imageSeconds: number;
  beatsPerPhoto: number;
  // Camera motion on each shot in turn, or none.
  motion: KenBurnsPreset[] | null;
  motionIntensity: number;
  // Into each shot after the first in turn, or straight cuts.
  transitions: TransitionType[] | null;
  transitionShare: number;
  look: GradeLookName | null;
  // The template's frame overlays and clip effects, captions and collage scenes.
  overlays: boolean;
  captions: boolean;
  scenes: boolean;
  // The words, by template text id.
  texts: Record<string, string>;
  music: StyledProjectMusic | null;
  brand?: BrandOptions | null;
}

// The dialog's own options for a template, as it starts them.
export function templateOptions(template: StyleTemplate): Omit<StyledProjectOptions, "music"> {
  return {
    templateId: template.id,
    imageSeconds: template.seconds,
    beatsPerPhoto: template.beatsPerPhoto,
    motion: template.motion,
    motionIntensity: template.motionIntensity,
    transitions: template.transitions,
    transitionShare: template.transitionShare,
    look: template.look,
    overlays: true,
    captions: true,
    scenes: true,
    texts: templateTexts(template),
  };
}

// How the build measures text, when it can (in the app: a canvas, with the face loaded): the width
// of `text` in title look `style`'s face at `fontPx`. Without one, every line is assumed to fit.
export type MeasureText = (text: string, style: string, fontPx: number) => number;

// A video in the media: how long it is and its width / height.
export interface VideoInfo {
  duration: number;
  aspect: number;
}

export interface BuildContext {
  // A photo's width / height, for cropping it to fill a collage cell (1 when unknown).
  aspectOf?: (path: string) => number;
  measure?: MeasureText;
  // The file a shot's photo plays from - a still already filling the frame (photoFill.ts) when the
  // photo isn't the frame's shape. The photo itself by default.
  clipSource?: (path: string) => string;
  // Set for the media that are videos (the rest are photos).
  videoOf?: (path: string) => VideoInfo | undefined;
  // Videos of another shape are cropped to fill the frame (rather than shown with bars).
  fillVideos?: boolean;
}

export interface Shot {
  photos: string[];
  scene: TemplateScene | null;
  beats: number;
  // A brand card opening or closing the video (its picture is only a backdrop).
  brand?: "intro" | "outro";
}

// The media grouped into shots: a collage scene takes several photos at its place in the order -
// only photos, and only if a shot is left after it. A video holds for two cuts when it's long
// enough to, otherwise for as many beats as it has.
export function planShots(
  imagePaths: string[],
  template: StyleTemplate | null,
  scenes: boolean,
  beatsPerPhoto: number,
  videoOf?: (path: string) => VideoInfo | undefined,
  secondsPerBeat = 0.5
): Shot[] {
  const shots: Shot[] = [];
  const pending = scenes && template ? [...template.scenes].sort((a, b) => a.at - b.at) : [];
  let i = 0;
  while (i < imagePaths.length) {
    let scene = pending.length && pending[0].at <= shots.length ? pending.shift()! : null;
    if (scene) {
      const take = imagePaths.slice(i, i + SCENE_PHOTOS[scene.kind]);
      if (imagePaths.length - i < take.length + 1 || take.length < SCENE_PHOTOS[scene.kind] || take.some((p) => videoOf?.(p))) scene = null;
    }
    const video = !scene ? videoOf?.(imagePaths[i]) : undefined;
    if (video) {
      const fits = Math.max(1, Math.floor((video.duration - 0.05) / secondsPerBeat));
      shots.push({ photos: [imagePaths[i]], scene: null, beats: Math.min(beatsPerPhoto * 2, fits) });
      i += 1;
      continue;
    }
    const take = scene ? SCENE_PHOTOS[scene.kind] : 1;
    shots.push({ photos: imagePaths.slice(i, i + take), scene, beats: beatsPerPhoto * (scene ? 2 : 1) });
    i += take;
  }
  return shots;
}

// Where each shot starts and the last one ends, in output seconds: on the song's beats (counted
// from the edit's start), carrying on at the song's average beat past its last one - or, with no
// beats, `secondsPerBeat` apart.
export function shotBoundaries(shots: Shot[], beats: number[] | null, secondsPerBeat: number): number[] {
  const at = (k: number): number => {
    if (!beats?.length) return k * secondsPerBeat;
    if (k < beats.length) return beats[k];
    const last = beats.length - 1;
    const step = last > 0 ? (beats[last] - beats[0]) / last : secondsPerBeat;
    return beats[last] + (k - last) * step;
  };
  const out = [0];
  let k = 0;
  for (const s of shots) {
    k += s.beats;
    out.push(at(k));
  }
  return out;
}

// Where a video shot plays from: a third of the way in - past a slow start, clear of the end - and
// still fitting the shot.
export const videoSegmentStart = (duration: number, length: number): number => Math.max(0, Math.min(duration * 0.3, duration - length - 0.02));

// The crop that makes a video of aspect `pic` fill a frame of aspect `frame`. A project clip's crop
// is a window on the FRAME the clip was first fitted into (bars included - export crops after
// frame_fit_chain, and the preview's clipFrameAffine works on the fitted frame), so it's the
// frame-shaped part of the picture's band: centred, the same fraction across as down.
export function coverClipCrop(pic: number, frame: number): ClipCrop | undefined {
  if (!(pic > 0) || !(frame > 0) || Math.abs(pic / frame - 1) < 0.01) return undefined;
  const k = Math.min(pic, frame) / Math.max(pic, frame);
  return { x: (1 - k) / 2, y: (1 - k) / 2, width: k, height: k };
}

// A new project from media in a style: one clip per shot with its motion and transition, cut on
// the song's beats, collage scenes laid out over their shots, captions on theirs, brand cards at
// the ends, frame overlays across the whole video and the song under it all.
export function buildStyledProject(imagePaths: string[], frame: VideoProjectFrame, options: StyledProjectOptions, ctx: BuildContext = {}): VideoEditState {
  const template = styleTemplate(options.templateId);
  const base = createProjectState([], { imageDuration: options.imageSeconds, kenBurns: false, transition: null });
  if (!imagePaths.length) return base;

  // ---- timing: on the song's beats, from a beat ----
  const music = options.music && options.music.sourceDuration > 0 ? options.music : null;
  const perBeatFallback = options.imageSeconds / Math.max(1, options.beatsPerPhoto);
  const secondsPerBeat = music?.bpm ? 60 / music.bpm : perBeatFallback;
  const shots = planShots(imagePaths, template, options.scenes, options.beatsPerPhoto, ctx.videoOf, secondsPerBeat);
  const brand = options.brand && (options.brand.name.trim() || options.brand.logo) ? options.brand : null;
  // A brand card lasts long enough for its animation to play out - on whole beats.
  const brandBeats = Math.max(options.beatsPerPhoto * 2, Math.ceil(2.8 / secondsPerBeat));
  if (brand?.intro) shots.unshift({ photos: [imagePaths[0]], scene: null, beats: brandBeats, brand: "intro" });
  if (brand?.outro) shots.push({ photos: [imagePaths[imagePaths.length - 1]], scene: null, beats: brandBeats, brand: "outro" });
  let trimStart = 0;
  let beats: number[] | null = null;
  if (music) {
    trimStart = musicStartFor(music, shots.reduce((sum, s) => sum + s.beats, 0) * secondsPerBeat);
    beats = music.beats?.length ? music.beats.filter((b) => b >= trimStart - 0.01).map((b) => Math.max(0, b - trimStart)) : null;
  }
  const bounds = shotBoundaries(shots, beats, secondsPerBeat);
  const total = bounds[bounds.length - 1];
  const aspect = frame.width / frame.height;

  // ---- clips ----
  let clips: Clip[] = shots.map((shot, i) => {
    const length = Math.max(0.3, bounds[i + 1] - bounds[i]);
    const path = shot.photos[0];
    const video = !shot.brand ? ctx.videoOf?.(path) : undefined;
    const plain = !shot.scene && !shot.brand;
    const effect = template && options.overlays && plain && !video && template.fx.length ? template.fx[i % template.fx.length] : null;
    if (video) {
      // A moment from the video, its own sound left to the song.
      const start = videoSegmentStart(video.duration, length);
      const crop = ctx.fillVideos ? coverClipCrop(video.aspect, aspect) : undefined;
      return {
        id: crypto.randomUUID(),
        sourcePath: path,
        start,
        end: Math.min(video.duration, start + length),
        ...(crop ? { crop } : {}),
        ...(music ? { muted: true } : {}),
        ...(options.look ? { grade: { look: { name: options.look, intensity: 0.85 } } } : {}),
      };
    }
    return {
      id: crypto.randomUUID(),
      sourcePath: ctx.clipSource?.(path) ?? path,
      start: 0,
      end: length,
      ...(options.motion?.length && plain ? { kenBurns: { preset: options.motion[i % options.motion.length], intensity: options.motionIntensity } } : {}),
      // A brand card's backdrop drifts in slowly behind it.
      ...(shot.brand ? { kenBurns: { preset: "zoom-in" as const, intensity: 0.25 } } : {}),
      ...(options.look ? { grade: { look: { name: options.look, intensity: 0.85 } } } : {}),
      ...(effect ? { fx: { kind: effect, intensity: template!.fxIntensity } } : {}),
    };
  });
  if (options.transitions?.length) {
    const cycle = options.transitions;
    clips = clips.map((clip, i) => {
      if (i === 0) return clip;
      const shorter = Math.min(clipOutputDuration(clip), clipOutputDuration(clips[i - 1]));
      return { ...clip, transitionIn: { type: cycle[(i - 1) % cycle.length], duration: Math.max(0.15, Math.min(1.2, shorter * options.transitionShare)) } };
    });
  }

  // ---- the song ----
  const audioOverlays: AudioOverlay[] = [];
  if (music) {
    const length = Math.min(total, music.sourceDuration - trimStart);
    audioOverlays.push({
      ...makeAudioOverlay(music.path, music.sourceDuration, 0, length, music.label),
      trimStart,
      ...(music.library ? { library: music.library } : {}),
      ...(music.bpm && music.beats?.length ? { bpm: music.bpm, beats: music.beats } : {}),
      // Starting mid-song fades in so it doesn't land on a cut-off note; stopping before the song
      // does fades out, as the music library's own add does.
      ...(trimStart > 0.05 ? { fadeInSec: 0.3 } : {}),
      ...(trimStart + length < music.sourceDuration - 0.5 ? { fadeOutSec: Math.min(2, length / 5) } : {}),
    });
  }

  const imageOverlays: ImageOverlay[] = [];
  const textOverlays: TextOverlay[] = [];
  const adjustmentLayers: AdjustmentLayer[] = [];
  const textOf = (slot: string) => (options.texts[slot] ?? template?.texts.find((t) => t.id === slot)?.sample ?? "").trim();

  // ---- collage scenes ----
  shots.forEach((shot, i) => {
    const scene = shot.scene;
    if (!scene) return;
    const start = bounds[i];
    const end = bounds[i + 1];
    adjustmentLayers.push(makeBackdrop(scene.backdrop, start, end));
    let photo = 0;
    sceneCells(scene, aspect).forEach((cell, k) => {
      // The cells come in one after another.
      const cellStart = Math.min(end - 0.2, start + 0.12 * k);
      if (cell.word) {
        // A word panel is the backdrop itself, with its word centred in it.
        textOverlays.push(...captionLines([cell.word], textOf, frame, cell.y + cell.h / 2, cellStart, end, ctx.measure, { x: cell.x, w: cell.w }));
        return;
      }
      const path = shot.photos[photo++];
      if (!path) return;
      imageOverlays.push({
        ...makeImageOverlay(path, cell.x, cell.y, cell.w, cell.h, cellStart, end),
        ...coverCrop(ctx.aspectOf?.(path) ?? 1, (cell.w * frame.width) / (cell.h * frame.height)),
        animation: scene.kind === "grid" ? "zoom" : "pop",
        // A print's white border, the same weight on any frame shape.
        ...(cell.border ? { borderColor: cell.border, borderWidth: 0.016 * Math.min(1, aspect), shadow: true } : {}),
      });
    });
  });

  // The shots the template's script counts - everything but the brand cards.
  const content = shots.map((_, i) => i).filter((i) => !shots[i].brand);
  const isContent = (i: number) => i < shots.length && !shots[i].brand;

  // ---- captions ----
  if (template && options.captions && content.length) {
    for (const card of template.captions) {
      const at = card.at < 0 ? content.length + card.at : card.at;
      if (at < 0 || at >= content.length) continue;
      // Captions don't sit on a collage - they wait for the next plain shot.
      let s = content[at];
      while (isContent(s) && shots[s].scene) s++;
      if (!isContent(s)) continue;
      // ...and leave when one starts (or a brand card does).
      let e = s + 1;
      while (e < s + card.shots && isContent(e) && !shots[e].scene) e++;
      const x = card.x ?? 0.5;
      textOverlays.push(...captionLines(card.lines, textOf, frame, card.y, bounds[s], bounds[e], ctx.measure, { x: x - 0.5, w: 1 }, card.rotate ?? 0));
    }
    const lt = template.lowerThird;
    const name = lt ? textOf(lt.name) : "";
    if (lt && name) {
      // After the opening card, for a couple of shots.
      const width = aspect < 1 ? 0.86 : 0.5;
      const height = (width * aspect) / 5;
      const first = content[content.length > 3 ? 2 : 0];
      const start = Math.max(bounds[first], 0.4);
      const end = Math.max(start + 1, bounds[Math.min(content[content.length - 1] + 1, first + 2)]);
      imageOverlays.push(makeImageOverlay("", 0.05, 0.8 - height / 2, width, height, start, Math.min(total, end), { ...makeAsset("lower-third"), text: name, subtext: textOf(lt.line) }));
    }
  }

  // ---- brand ----
  if (brand) {
    const brandLook = template?.cardStyle ?? "luxe-serif";
    const accent = template?.swatch[1] ?? "#facc15";
    shots.forEach((shot, i) => {
      if (!shot.brand) return;
      const card = brandCard(shot.brand === "intro" ? brand.intro ?? "neon" : "outro", brand, bounds[i], bounds[i + 1], frame, brandLook, accent, ctx.measure);
      imageOverlays.push(...card.images);
      textOverlays.push(...card.texts);
      adjustmentLayers.push(...card.backdrops);
    });
    if (brand.bar && content.length) {
      const start = bounds[content[0]];
      const end = bounds[content[content.length - 1] + 1];
      const say = (text: string, style: string, size: number, y: number) =>
        text.trim() ? captionLines([line("t", style, size, "fade")], () => text.trim(), frame, y, start, end, ctx.measure) : [];
      textOverlays.push(...say(brand.name.toUpperCase(), "tracked-caps", 0.03, 0.05), ...say(brand.website, "tracked-caps", 0.024, 0.95));
    }
  }

  // ---- frame overlays, on top of everything ----
  if (template && options.overlays) for (const kind of template.overlays) imageOverlays.push(makeImageOverlay("", 0, 0, 1, 1, 0, total, makeAsset(kind)));

  return { ...base, clips, audioOverlays, imageOverlays, textOverlays, adjustmentLayers };
}

// One brand card over [start, end): a backdrop, the logo (or the name standing in for it) with its
// entrance, and the name, line and website after it - choreographed per style.
function brandCard(
  style: BrandIntroStyle | "outro",
  brand: BrandOptions,
  start: number,
  end: number,
  frame: VideoProjectFrame,
  brandLook: string,
  accent: string,
  measure?: MeasureText
): { images: ImageOverlay[]; texts: TextOverlay[]; backdrops: AdjustmentLayer[] } {
  const now = Date.now();
  const aspect = frame.width / frame.height;
  const short = Math.min(1, aspect);
  const images: ImageOverlay[] = [];
  const texts: TextOverlay[] = [];
  const dark = style === "lines" || style === "loading";
  // Behind it: the first picture, blurred and dimmed - or plain near-black.
  const backdrops: AdjustmentLayer[] = [
    dark
      ? { id: crypto.randomUUID(), name: "Brand backdrop", startTime: start, endTime: end, placement: "under", fill: "#0b0b0d", createdAt: now, updatedAt: now }
      : { id: crypto.randomUUID(), name: "Brand backdrop", startTime: start, endTime: end, placement: "under", blur: 0.035, brightness: 0.38, saturation: 0.8, fadeIn: 0.15, createdAt: now, updatedAt: now },
  ];
  const len = end - start;
  const at = (s: number) => Math.min(end - 0.25, start + s * Math.min(1, len / 2.8));
  const name = brand.name.trim();
  const say = (text: string, look: string, size: number, y: number, animation: OverlayAnimation, delay: number, reveal?: TextRevealSettings) =>
    text.trim() ? captionLines([line("t", look, size, animation, { reveal: { exit: "none", ...reveal } })], () => text.trim(), frame, y, at(delay), end, measure) : [];
  // The logo's box, centred at (0.5, cy), `size` of the short side tall.
  const logoBox = (size: number, cy: number) => {
    const h = size * short;
    const w = Math.min(0.8, (h * (brand.logo?.aspect ?? 1)) / aspect);
    return { x: 0.5 - w / 2, y: cy - h / 2, w, h };
  };
  const logo = (box: ReturnType<typeof logoBox>, from: number, animation: OverlayAnimation, shine: boolean) =>
    brand.logo
      ? images.push({
          ...makeImageOverlay(brand.logo.path, box.x, box.y, box.w, box.h, at(from), end),
          animation,
          ...(shine ? { reveal: { style: "glare" as const, seconds: 0.9, shineEvery: 2.4 } } : {}),
        })
      : 0;
  const element = (kind: AssetKind, box: { x: number; y: number; w: number; h: number }, from: number, color?: string) =>
    images.push(makeImageOverlay("", box.x, box.y, box.w, box.h, at(from), end, { ...makeAsset(kind), ...(color ? { color } : {}), exit: false }));

  if (style === "outro") {
    const box = logoBox(0.22, 0.36);
    logo(box, 0, "pop", true);
    texts.push(
      ...say(name, brandLook, 0.09, brand.logo ? 0.56 : 0.46, "popin", brand.logo ? 0.3 : 0),
      ...say(brand.website, "caption", 0.04, brand.logo ? 0.67 : 0.58, "typewriter", 0.8, { speed: 1.4, caret: false })
    );
    return { images, texts, backdrops };
  }
  if (style === "neon") {
    const box = logoBox(0.3, brand.logo ? 0.4 : 0.47);
    const fw = Math.min(0.92, box.w + 0.16 * short / aspect);
    const fh = box.h + 0.12 * short;
    element("sparkles", { x: 0.5 - fw * 0.75, y: box.y + box.h / 2 - fh * 0.75, w: fw * 1.5, h: fh * 1.5 }, 0.5);
    element("neon", { x: 0.5 - fw / 2, y: box.y + box.h / 2 - fh / 2, w: fw, h: fh }, 0, accent);
    if (brand.logo) logo(box, 0.4, "pop", true);
    else texts.push(...say(name, brandLook, 0.12, 0.47, "popin", 0.45));
    if (brand.logo) texts.push(...say(name, brandLook, 0.09, 0.66, "spread", 0.75));
    texts.push(...say(brand.tagline.toUpperCase(), "tracked-caps", 0.035, brand.logo ? 0.75 : 0.62, "spread", 1.0), ...say(brand.website, "caption", 0.035, brand.logo ? 0.83 : 0.7, "typewriter", 1.25, { speed: 1.6, caret: false }));
  } else if (style === "stamp") {
    const box = logoBox(0.34, 0.4);
    element("halo", { x: 0.5 - (box.w * 1.6) / 2, y: box.y + box.h * 0.78, w: box.w * 1.6, h: (box.w * 1.6 * aspect) / 2.4 }, 0.35, accent);
    if (brand.logo) logo(box, 0, "drop", true);
    texts.push(...say(name, brandLook, brand.logo ? 0.09 : 0.14, brand.logo ? 0.68 : 0.45, "mask", 0.55), ...say(brand.tagline.toUpperCase(), "tracked-caps", 0.035, brand.logo ? 0.77 : 0.58, "spread", 0.9));
    texts.push(...say(brand.website, "caption", 0.035, brand.logo ? 0.85 : 0.67, "typewriter", 1.2, { speed: 1.6, caret: false }));
  } else if (style === "lines") {
    const fw = aspect < 1 ? 0.86 : 0.62;
    const fh = (aspect < 1 ? 0.3 : 0.42) ;
    element("guides", { x: 0.5 - fw / 2, y: 0.5 - fh / 2, w: fw, h: fh }, 0, "#ffffff");
    if (brand.logo) logo(logoBox(0.12, 0.5 - fh / 2 - 0.09 * short), 0.6, "fade", false);
    texts.push(...say(name, brandLook, 0.13, 0.47, "mask", 0.35), ...say(brand.tagline.toUpperCase(), "tracked-caps", 0.032, 0.58, "spread", 0.8));
    texts.push(...say(brand.website, "tracked-caps", 0.026, 0.5 + fh / 2 + 0.05, "fade", 1.1));
  } else {
    // Loading: a loader and its word for the first part, then the logo bursts in.
    const split = start + len * 0.42;
    const sz = 0.16 * short;
    images.push(makeImageOverlay("", 0.5 - sz / aspect / 2, 0.42 - sz / 2, sz / aspect, sz, start, split, { ...makeAsset("spinner"), color: "#ffffff", color2: accent, exit: false }));
    texts.push(...captionLines([line("t", "tracked-caps", 0.035, "flicker")], () => "LOADING", frame, 0.55, start, split, measure));
    const after = (split - start) / Math.min(1, len / 2.8);
    const box = logoBox(0.3, 0.42);
    if (brand.logo) logo(box, after, "zoom", true);
    texts.push(...say(name, brandLook, brand.logo ? 0.1 : 0.15, brand.logo ? 0.66 : 0.47, "popin", after + 0.15), ...say(brand.website, "caption", 0.035, brand.logo ? 0.76 : 0.6, "typewriter", after + 0.5, { speed: 1.6, caret: false }));
  }
  return { images, texts, backdrops };
}

// A solid colour over the whole frame for a scene's time, under its cells.
function makeBackdrop(color: string, start: number, end: number): AdjustmentLayer {
  const now = Date.now();
  return { id: crypto.randomUUID(), name: "Collage backdrop", startTime: start, endTime: end, placement: "under", fill: color, fadeIn: 0.2, createdAt: now, updatedAt: now };
}

export interface SceneCell {
  x: number;
  y: number;
  w: number;
  h: number;
  border?: string;
  word?: CaptionLine;
}

// A scene's cells as frame fractions. Gutters and margins are a share of the short side, so they
// look the same on any frame shape.
export function sceneCells(scene: TemplateScene, aspect: number): SceneCell[] {
  const short = 0.022;
  const gx = aspect >= 1 ? short / aspect : short;
  const gy = aspect >= 1 ? short : short * aspect;
  if (scene.kind === "grid" || scene.kind === "panels") {
    const w = (1 - 3 * gx) / 2;
    const h = (1 - 3 * gy) / 2;
    const cell = (c: number, r: number): SceneCell => ({ x: gx + c * (w + gx), y: gy + r * (h + gy), w, h });
    if (scene.kind === "grid") return [cell(0, 0), cell(1, 0), cell(0, 1), cell(1, 1)];
    return [cell(0, 0), { ...cell(1, 0), word: scene.words[0] }, { ...cell(0, 1), word: scene.words[1] }, cell(1, 1)];
  }
  // Triptych: three framed photos down a tall frame, across a wide one.
  const m = 3 * short;
  if (aspect < 1) {
    const my = m * aspect;
    const h = (1 - 4 * my) / 3;
    const w = Math.min(1 - 2 * m, (h / aspect) * 1.25);
    return [0, 1, 2].map((k) => ({ x: (1 - w) / 2, y: my + k * (h + my), w, h, border: scene.border }));
  }
  const mx = m / aspect;
  const w = (1 - 4 * mx) / 3;
  const h = Math.min(1 - 2 * m, w * aspect * 1.25);
  return [0, 1, 2].map((k) => ({ x: mx + k * (w + mx), y: (1 - h) / 2, w, h, border: scene.border }));
}

// The crop that fills a box of aspect `box` with a picture of aspect `pic`, centred.
export function coverCrop(pic: number, box: number): Pick<ImageOverlay, "cropX" | "cropY" | "cropWidth" | "cropHeight"> {
  if (!(pic > 0) || !(box > 0) || Math.abs(pic - box) < 0.01) return {};
  if (pic > box) {
    const w = box / pic;
    return { cropX: (1 - w) / 2, cropY: 0, cropWidth: w, cropHeight: 1 };
  }
  const h = pic / box;
  return { cropX: 0, cropY: (1 - h) / 2, cropWidth: 1, cropHeight: h };
}

// A stack of caption lines centred on (`area`'s middle, `centerY`), each in its look, from `start`
// (plus its own delay) to `end`, across `area` (the whole frame by default). `rotate` turns the
// whole stack about that centre - at +-90 the lines run up or down the frame and may use its height.
// A line too long for the room shrinks to fit on one line (down to about 60%), then wraps. Boxed
// looks hug their words.
export function captionLines(
  lines: CaptionLine[],
  textOf: (slot: string) => string,
  frame: VideoProjectFrame,
  centerY: number,
  start: number,
  end: number,
  measure?: MeasureText,
  area: { x: number; w: number } = { x: 0, w: 1 },
  rotate = 0
): TextOverlay[] {
  const W = frame.width;
  const H = frame.height;
  const aspect = W / H;
  const shortSide = Math.min(1, aspect);
  const upright = Math.abs(Math.abs(rotate) - 90) < 1;
  // The room along the line, in px: across the area, or (turned upright) up the frame.
  const roomLinePx = upright ? 0.9 * H : area.w * (aspect < 1 ? 0.92 : 0.84) * W;
  const placed = lines
    .map((l) => {
      const style = titleStyle(l.style);
      const raw = textOf(l.slot);
      if (!raw || !style) return null;
      const text = l.caps ? raw.toUpperCase() : raw;
      const look = lookPatch(style.look);
      // Sizes are a share of the short side, stored as a fraction of the frame height.
      let fontSize = l.size * shortSide;
      const padding = (look.padding ?? 0) * shortSide;
      const roomPx = roomLinePx - 2 * padding * H;
      const widthPx = () => (measure ? measure(text, l.style, fontSize * H) : 0);
      for (let k = 0; k < 5 && widthPx() > roomPx; k++) fontSize *= 0.9;
      const lineCount = Math.max(1, Math.ceil(widthPx() / Math.max(1, roomPx) - 0.001));
      const boxPx = look.backgroundColor && measure && lineCount === 1 ? Math.min(roomLinePx, widthPx() + 2 * padding * H + 0.004 * W) : roomLinePx;
      return { l, text, look, fontSize, padding, heightPx: (fontSize * 1.3 * lineCount + 2 * padding) * H, boxPx };
    })
    .filter((p): p is NonNullable<typeof p> => !!p);
  const gapPx = 0.012 * shortSide * H;
  const stackPx = placed.reduce((sum, p) => sum + p.heightPx, 0) + gapPx * Math.max(0, placed.length - 1);
  // The stack's centre, kept inside the frame (only level stacks are clamped - a turned one is laid
  // out along the frame's height on purpose).
  const cx = (area.x + area.w / 2) * W;
  const cy = upright || rotate ? centerY * H : Math.max(0.02 * H + stackPx / 2, Math.min(0.98 * H - stackPx / 2, centerY * H));
  const turn = (rotate * Math.PI) / 180;
  let along = -stackPx / 2;
  return placed.map((p) => {
    const lineStart = Math.max(start, Math.min(end - 0.3, start + (p.l.delay ?? 0)));
    // This line's centre: down the stack, then turned with it.
    const off = along + p.heightPx / 2;
    along += p.heightPx + gapPx;
    const lx = cx - Math.sin(turn) * off;
    const ly = cy + Math.cos(turn) * off;
    const o = makeTextOverlay((lx - p.boxPx / 2) / W, (ly - p.heightPx / 2) / H, p.boxPx / W, p.fontSize, lineStart, end);
    return {
      ...o,
      ...p.look,
      color: p.look.color ?? "#ffffff",
      padding: p.padding,
      height: p.heightPx / H,
      text: p.text,
      textAlign: "center" as const,
      animation: p.l.animation,
      reveal: { exit: "fade" as const, ...p.l.reveal },
      ...(rotate ? { rotation: rotate } : {}),
    };
  });
}
