// components/video/StageProSections.tsx
//
// Pro studio controls for StageDockedPanel:
// - 1-click Scene Templates gallery, Custom Saved Templates ("My Presets"), and Whiteboard / Docs /
//   Outline Importer drawer
// - Per-Beat Virtual Camera controls (Zoom, Pan X/Y, Tilt, "Frame selected", Reset)
// - Beat Sound Design picker with instant audio audition
// - Studio Gradient + Dot/Grid Paper background picker
// - Quick Animate 1-click entrance preset chips for the selected element
import React, { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  IoBookmarkOutline,
  IoCameraOutline,
  IoDocumentTextOutline,
  IoDownloadOutline,
  IoGitNetworkOutline,
  IoListOutline,
  IoRefreshOutline,
  IoScanOutline,
  IoSparklesOutline,
  IoSwapHorizontalOutline,
  IoTrashOutline,
  IoVolumeHighOutline,
} from "react-icons/io5";
import { builtinSfxFile } from "../../utils/builtinSfx";
import type { DocSummary } from "../../utils/docTypes";
import type { WhiteboardSummary } from "../../utils/whiteboardTypes";
import {
  beatRestTime,
  frameElementCamera,
  isLightStageBackground,
  reinkScene,
  resolvedBeatCamera,
  setBeatCamera,
  setBeatSound,
} from "../../utils/stage/stageEditing";
import {
  importDocAsScene,
  importWhiteboardAsScene,
  listImportableDocs,
  listImportableWhiteboards,
  parseOutlineText,
  sceneFromOutline,
} from "../../utils/stage/stageImport";
import { STAGE_BEAT_SOUNDS, stageSoundId } from "../../utils/stage/stageSounds";
import {
  STAGE_TEMPLATES,
  STUDIO_GRADIENTS,
  applyTemplateToScene,
  stageBackgroundCss,
} from "../../utils/stage/stageTemplates";
import {
  UserSceneTemplate,
  applyUserSceneTemplate,
  deleteUserSceneTemplate,
  loadUserSceneTemplates,
  saveUserSceneTemplate,
} from "../../utils/stage/stageUserTemplates";
import type {
  StageBackground,
  StageBackgroundPattern,
  StageBackgroundStyle,
  StageBeatSound,
  StageElement,
  StageScene,
} from "../../utils/stage/stageTypes";
import ColorInput from "../common/ColorInput";
import { SliderRow, Swatches } from "./OverlayDockedPanels";
import { IconButton, Segmented, field } from "./StagePanelParts";

type Update = (edit: (s: StageScene) => StageScene) => void;

// Quick audio audition helper for beat sound effects.
let previewAudio: HTMLAudioElement | null = null;
async function auditionBeatSound(sound: StageBeatSound | undefined): Promise<void> {
  const id = stageSoundId(sound);
  if (!id) return;
  try {
    const filePath = await builtinSfxFile(id);
    if (!previewAudio) previewAudio = new Audio();
    previewAudio.pause();
    previewAudio.src = convertFileSrc(filePath);
    previewAudio.volume = 0.78;
    previewAudio.currentTime = 0;
    await previewAudio.play();
  } catch {
    // Ignore autoplay or missing-file rejections during quick preview
  }
}

// ---------- 1. Templates, Custom Presets & Importer Drawer ----------

export const TemplatesImportBar: React.FC<{
  scene: StageScene;
  onUpdate: Update;
  onSelectElement: (id: string | null) => void;
  onSeek: (t: number) => void;
}> = ({ scene, onUpdate, onSelectElement, onSeek }) => {
  const [tab, setTab] = useState<null | "templates" | "saved" | "import">(null);
  const [tplFilter, setTplFilter] = useState<"All" | "Pro" | "Intro" | "Explainer" | "Data" | "Social">("All");
  const [userTemplates, setUserTemplates] = useState<UserSceneTemplate[]>(() => loadUserSceneTemplates());
  const [saveName, setSaveName] = useState("");
  const [importMode, setImportMode] = useState<"whiteboard" | "doc" | "outline">("whiteboard");
  const [whiteboards, setWhiteboards] = useState<WhiteboardSummary[] | null>(null);
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [outlineText, setOutlineText] = useState("# Product Launch\n- Capture your workflow cleanly\n- Highlight key moments with motion\n- Share everywhere in 60fps");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tab !== "import") return;
    if (importMode === "whiteboard" && whiteboards === null) {
      void listImportableWhiteboards().then(setWhiteboards);
    } else if (importMode === "doc" && docs === null) {
      void listImportableDocs().then(setDocs);
    }
  }, [tab, importMode, whiteboards, docs]);

  const applyAndFocus = (next: StageScene) => {
    onUpdate(() => next);
    onSelectElement(null);
    onSeek(beatRestTime(next, 0));
    setTab(null);
  };

  const handleSaveCurrent = () => {
    const nextList = saveUserSceneTemplate(saveName || scene.name || "Custom scene", scene);
    setUserTemplates(nextList);
    setSaveName("");
  };

  const handleImportWhiteboard = async (wb: WhiteboardSummary) => {
    setBusyId(wb.id);
    setError(null);
    try {
      const next = await importWhiteboardAsScene(wb.id, {
        id: scene.id,
        startTime: scene.startTime,
        layer: scene.layer,
        width: scene.width,
      });
      applyAndFocus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import whiteboard");
    } finally {
      setBusyId(null);
    }
  };

  const handleImportDoc = async (doc: DocSummary) => {
    setBusyId(doc.id);
    setError(null);
    try {
      const next = await importDocAsScene(doc.id, doc.title, {
        id: scene.id,
        startTime: scene.startTime,
        layer: scene.layer,
        width: scene.width,
      });
      applyAndFocus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import document");
    } finally {
      setBusyId(null);
    }
  };

  const handleImportOutline = () => {
    const { title, bullets } = parseOutlineText(outlineText);
    const next = sceneFromOutline(title, bullets, {
      id: scene.id,
      startTime: scene.startTime,
      layer: scene.layer,
      width: scene.width,
    });
    applyAndFocus(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.06] p-0.5">
        {(
          [
            ["templates", <IoSparklesOutline size={12} />, "Templates", "Apply a 1-click studio scene template"],
            ["saved", <IoBookmarkOutline size={12} />, `Saved${userTemplates.length ? ` (${userTemplates.length})` : ""}`, "Save and reuse your own scene presets"],
            ["import", <IoDownloadOutline size={12} />, "Import", "Turn a Whiteboard Mind Map, Doc, or outline into an animated scene"],
          ] as const
        ).map(([id, icon, text, title]) => (
          <button
            key={id}
            type="button"
            title={title}
            onClick={() => setTab((cur) => (cur === id ? null : id))}
            className={`h-7 px-1.5 rounded-md flex items-center justify-center gap-1 text-[10.5px] font-medium transition-colors ${
              tab === id ? "bg-teal-500 text-white shadow-sm" : "text-white/75 hover:text-white hover:bg-white/10"
            }`}
          >
            {icon}
            <span className="truncate">{text}</span>
          </button>
        ))}
      </div>

      {tab === "templates" && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-black/30 p-2 ring-1 ring-white/10">
          <div className="flex flex-wrap gap-1">
            {(["All", "Pro", "Intro", "Explainer", "Data", "Social"] as const).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setTplFilter(cat)}
                className={`px-2 py-0.5 rounded-full text-[9.5px] font-medium transition-colors ${
                  tplFilter === cat
                    ? cat === "Pro"
                      ? "bg-gradient-to-r from-teal-500 to-indigo-500 text-white"
                      : "bg-teal-500 text-white"
                    : "bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/12"
                }`}
              >
                {cat === "Pro" ? "✦ Pro" : cat}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-1.5 max-h-64 overflow-y-auto pr-0.5">
            {STAGE_TEMPLATES.filter((t) => tplFilter === "All" || t.category === tplFilter).map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                title={tpl.description}
                onClick={() => applyAndFocus(applyTemplateToScene(scene, tpl.id))}
                className={`group flex flex-col overflow-hidden rounded-lg border bg-white/[0.03] text-left transition-all ${
                  tpl.pro
                    ? "border-teal-400/25 hover:border-teal-300/80"
                    : "border-white/10 hover:border-teal-400/70"
                }`}
              >
                <div
                  className="h-11 w-full relative flex items-end justify-between p-1.5 overflow-hidden"
                  style={{ background: `linear-gradient(135deg, ${tpl.previewFrom}, ${tpl.previewTo})` }}
                >
                  {tpl.pro && (
                    <span className="absolute top-1 left-1 rounded px-1 py-px text-[8px] font-bold tracking-wider bg-gradient-to-r from-teal-400/90 to-sky-400/90 text-slate-950 shadow-sm">
                      PRO
                    </span>
                  )}
                  <span
                    className="h-1.5 w-8 rounded-full opacity-90"
                    style={{ backgroundColor: tpl.accent }}
                  />
                  <span className="rounded bg-black/55 px-1 py-0.5 text-[9px] text-white/85 tabular-nums">
                    {tpl.beatCount} {tpl.beatCount === 1 ? "beat" : "beats"}
                  </span>
                </div>
                <div className="px-2 py-1.5">
                  <div className="text-[11px] font-medium text-white group-hover:text-teal-200 truncate">{tpl.name}</div>
                  <div className="text-[9.5px] text-white/45 truncate">{tpl.description}</div>
                </div>
              </button>
            ))}
          </div>
          <span className="text-[10px] text-white/35">Applies to this scene — keeps its place on the timeline.</span>
        </div>
      )}

      {tab === "saved" && (
        <div className="flex flex-col gap-2 rounded-lg bg-black/30 p-2 ring-1 ring-white/10">
          <div className="flex gap-1">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") handleSaveCurrent();
              }}
              placeholder={scene.name ? `Save "${scene.name}"…` : "Preset name…"}
              className={`${field} flex-1`}
            />
            <button
              type="button"
              onClick={handleSaveCurrent}
              className="shrink-0 px-2.5 rounded-md bg-teal-500 hover:bg-teal-400 text-[11px] font-medium text-white transition-colors"
            >
              Save
            </button>
          </div>
          {userTemplates.length === 0 ? (
            <span className="py-2 text-center text-[10.5px] text-white/40">
              No saved presets yet — save this scene to reuse it across videos.
            </span>
          ) : (
            <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
              {userTemplates.map((tpl) => (
                <div
                  key={tpl.id}
                  className="flex items-center gap-2 rounded-md bg-white/[0.04] hover:bg-white/[0.08] px-2 py-1.5"
                >
                  <span
                    className="w-4 h-4 rounded-sm shrink-0 ring-1 ring-white/20"
                    style={{ background: stageBackgroundCss(tpl.background) }}
                  />
                  <button
                    type="button"
                    onClick={() => applyAndFocus(applyUserSceneTemplate(scene, tpl))}
                    className="flex-1 min-w-0 text-left"
                    title="Click to apply this preset to the current scene"
                  >
                    <div className="text-[11px] font-medium text-white truncate">{tpl.name}</div>
                    <div className="text-[9.5px] text-white/40">
                      {tpl.beatCount} {tpl.beatCount === 1 ? "beat" : "beats"}
                    </div>
                  </button>
                  <IconButton
                    title="Delete saved preset"
                    danger
                    onClick={() => setUserTemplates(deleteUserSceneTemplate(tpl.id))}
                  >
                    <IoTrashOutline size={12} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "import" && (
        <div className="flex flex-col gap-2 rounded-lg bg-black/30 p-2 ring-1 ring-white/10">
          <Segmented
            value={importMode}
            onChange={(m) => {
              setImportMode(m);
              setError(null);
            }}
            options={[
              { value: "whiteboard", label: <span className="flex items-center gap-1"><IoGitNetworkOutline size={12} />Board</span>, title: "Import a Whiteboard or Mind Map" },
              { value: "doc", label: <span className="flex items-center gap-1"><IoDocumentTextOutline size={12} />Doc</span>, title: "Import a Briefcast Document" },
              { value: "outline", label: <span className="flex items-center gap-1"><IoListOutline size={12} />Outline</span>, title: "Paste a title and bullet points" },
            ]}
          />
          {error && <span className="text-[10.5px] text-rose-300">{error}</span>}
          {importMode === "whiteboard" && (
            <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
              {whiteboards === null ? (
                <span className="py-2 text-center text-[10.5px] text-white/40">Loading whiteboards…</span>
              ) : whiteboards.length === 0 ? (
                <span className="py-2 text-center text-[10.5px] text-white/40">No saved whiteboards found.</span>
              ) : (
                whiteboards.map((wb) => (
                  <button
                    key={wb.id}
                    type="button"
                    disabled={busyId === wb.id}
                    onClick={() => void handleImportWhiteboard(wb)}
                    className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-white/[0.04] hover:bg-teal-500/25 text-left text-[11px] text-white/85 hover:text-white transition-colors disabled:opacity-50"
                  >
                    <span className="truncate">{wb.name}</span>
                    <span className="shrink-0 text-[9.5px] text-teal-300">
                      {busyId === wb.id ? "Building…" : "Animate →"}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          {importMode === "doc" && (
            <div className="flex flex-col gap-1 max-h-44 overflow-y-auto">
              {docs === null ? (
                <span className="py-2 text-center text-[10.5px] text-white/40">Loading documents…</span>
              ) : docs.length === 0 ? (
                <span className="py-2 text-center text-[10.5px] text-white/40">No saved documents found.</span>
              ) : (
                docs.map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    disabled={busyId === doc.id}
                    onClick={() => void handleImportDoc(doc)}
                    className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md bg-white/[0.04] hover:bg-teal-500/25 text-left text-[11px] text-white/85 hover:text-white transition-colors disabled:opacity-50"
                  >
                    <span className="truncate">{doc.title || "Untitled"}</span>
                    <span className="shrink-0 text-[9.5px] text-teal-300">
                      {busyId === doc.id ? "Building…" : "Animate →"}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          {importMode === "outline" && (
            <div className="flex flex-col gap-1.5">
              <textarea
                rows={4}
                value={outlineText}
                onChange={(e) => setOutlineText(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder={"# Heading\n- First key point\n- Second key point"}
                className={`${field} resize-y text-[11px]`}
              />
              <button
                type="button"
                onClick={handleImportOutline}
                className="h-7 rounded-md bg-teal-500 hover:bg-teal-400 text-[11px] font-medium text-white transition-colors"
              >
                Build animated beats
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------- 2. Per-Beat Virtual Camera & Beat Sound ----------

export const BeatCameraAndSound: React.FC<{
  scene: StageScene;
  beat: number;
  selectedRect?: { x: number; y: number; width: number; height: number } | null;
  onUpdate: Update;
}> = ({ scene, beat, selectedRect, onUpdate }) => {
  const cam = resolvedBeatCamera(scene, beat);
  const camActive = Math.abs(cam.zoom - 1) > 0.005 || Math.abs(cam.panX) > 1 || Math.abs(cam.panY) > 1 || Math.abs(cam.tilt) > 0.1;
  const [showCam, setShowCam] = useState(camActive);
  const prevBeat = useRef(beat);
  useEffect(() => {
    if (prevBeat.current !== beat) {
      prevBeat.current = beat;
      if (camActive) setShowCam(true);
    }
  }, [beat, camActive]);

  const beatSoundOwn = scene.beats[beat]?.sound;
  const effectiveSound: StageBeatSound = beatSoundOwn ?? scene.beatSound ?? "none";

  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <div className="flex items-center justify-between gap-1.5">
        <button
          type="button"
          onClick={() => setShowCam((v) => !v)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10.5px] font-medium transition-colors ${
            camActive
              ? "bg-teal-500/20 text-teal-200 ring-1 ring-teal-400/35"
              : "bg-white/[0.05] text-white/70 hover:text-white hover:bg-white/10"
          }`}
          title="Zoom, pan, or tilt the virtual camera on this beat — springs smoothly between beats"
        >
          <IoCameraOutline size={12} />
          <span>Camera</span>
          {camActive && <span className="tabular-nums text-[9.5px] opacity-90">{Math.round(cam.zoom * 100)}%</span>}
        </button>

        <div className="flex items-center gap-1 min-w-0">
          <IoVolumeHighOutline size={12} className="shrink-0 text-white/50" title="Sound effect when this beat starts" />
          <select
            value={beatSoundOwn ?? "__default__"}
            onChange={(e) => {
              const v = e.target.value;
              const next: StageBeatSound | undefined = v === "__default__" ? undefined : (v as StageBeatSound);
              onUpdate((s) => setBeatSound(s, beat, next));
              void auditionBeatSound(next ?? scene.beatSound);
            }}
            title="Sound played when this beat starts (live preview & export)"
            className="min-w-0 max-w-[110px] rounded-md bg-black/30 ring-1 ring-white/10 focus:ring-teal-400 outline-none px-1.5 py-1 text-[10.5px] text-white"
          >
            <option value="__default__">
              {scene.beatSound && scene.beatSound !== "none" ? `Scene (${scene.beatSound})` : "No SFX"}
            </option>
            {STAGE_BEAT_SOUNDS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {effectiveSound !== "none" && (
            <IconButton title={`Preview ${effectiveSound}`} onClick={() => void auditionBeatSound(effectiveSound)}>
              <IoVolumeHighOutline size={12} className="text-teal-300" />
            </IconButton>
          )}
        </div>
      </div>

      {showCam && (
        <div className="flex flex-col gap-1.5 rounded-lg bg-black/25 p-2 ring-1 ring-white/10">
          <SliderRow
            label="Zoom"
            value={cam.zoom}
            min={0.5}
            max={3}
            step={0.02}
            reset={1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={(v) => onUpdate((s) => setBeatCamera(s, beat, { zoom: v }))}
          />
          <SliderRow
            label="Pan X"
            value={cam.panX}
            min={-Math.round(scene.width * 0.6)}
            max={Math.round(scene.width * 0.6)}
            step={10}
            reset={0}
            format={(v) => `${Math.round(v)}`}
            onChange={(v) => onUpdate((s) => setBeatCamera(s, beat, { panX: v }))}
          />
          <SliderRow
            label="Pan Y"
            value={cam.panY}
            min={-650}
            max={650}
            step={10}
            reset={0}
            format={(v) => `${Math.round(v)}`}
            onChange={(v) => onUpdate((s) => setBeatCamera(s, beat, { panY: v }))}
          />
          <SliderRow
            label="Tilt"
            value={cam.tilt}
            min={-15}
            max={15}
            step={0.5}
            reset={0}
            format={(v) => `${v.toFixed(1)}°`}
            onChange={(v) => onUpdate((s) => setBeatCamera(s, beat, { tilt: v }))}
          />
          <div className="flex items-center gap-1.5 pt-0.5">
            {selectedRect && (
              <button
                type="button"
                onClick={() => onUpdate((s) => setBeatCamera(s, beat, frameElementCamera(s, selectedRect)))}
                className="flex-1 h-6 rounded-md bg-teal-500/20 hover:bg-teal-500/35 text-teal-200 text-[10.5px] font-medium flex items-center justify-center gap-1 transition-colors"
                title="Smoothly zoom & pan this beat's camera to spotlight the selected element"
              >
                <IoScanOutline size={11} />
                Frame selected
              </button>
            )}
            <button
              type="button"
              disabled={!camActive}
              onClick={() => onUpdate((s) => setBeatCamera(s, beat, null))}
              className="h-6 px-2 rounded-md bg-white/[0.06] hover:bg-white/12 text-white/75 text-[10.5px] flex items-center justify-center gap-1 disabled:opacity-35 transition-colors"
              title="Reset this beat's camera back to 100% centred"
            >
              <IoRefreshOutline size={11} />
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ---------- 3. Studio Background Picker (Solid + Gradients + Pattern + Effects) ----------

const SOLID_BACKGROUNDS = ["#f2f1ee", "#ffffff", "#e8e8e6", "#111111", "#0b1020", "#1e3a8a"];

function extractBgStyle(bg: StageBackground): StageBackgroundStyle {
  if (bg.kind === "none") return {};
  return {
    pattern: bg.pattern,
    patternSize: bg.patternSize,
    patternOpacity: bg.patternOpacity,
    patternColor: bg.patternColor,
    patternDrift: bg.patternDrift,
    vignette: bg.vignette,
    glow: bg.glow,
    grain: bg.grain,
  };
}

export const StudioBackgroundPicker: React.FC<{
  scene: StageScene;
  onUpdate: Update;
}> = ({ scene, onUpdate }) => {
  const bg = scene.background;
  const applyBg = (nextBg: StageBackground) => {
    onUpdate((s) => {
      const next: StageScene = { ...s, background: nextBg };
      return isLightStageBackground(s.background) === isLightStageBackground(next.background)
        ? next
        : reinkScene(next, !isLightStageBackground(next.background));
    });
  };

  const patchStyle = (patch: Partial<StageBackgroundStyle>) => {
    if (bg.kind === "none") return;
    applyBg({ ...bg, ...patch });
  };

  const setKind = (kind: StageBackground["kind"]) => {
    if (kind === bg.kind) return;
    const style = extractBgStyle(bg);
    if (kind === "none") {
      applyBg({ kind: "none" });
    } else if (kind === "color") {
      const color = bg.kind === "gradient" ? bg.from : "#0f172a";
      applyBg({ kind: "color", color, ...style });
    } else {
      const from = bg.kind === "color" ? bg.color : "#0f172a";
      const to = bg.kind === "color" ? "#134e4a" : "#134e4a";
      applyBg({ kind: "gradient", from, to, angle: 135, radial: false, ...style });
    }
  };

  const currentPattern: StageBackgroundPattern = bg.kind === "none" ? "none" : bg.pattern ?? "none";
  const light = isLightStageBackground(bg);
  const defaultPatSize = currentPattern === "dots" ? 42 : 56;
  const defaultPatOpacity = currentPattern === "dots" ? (light ? 0.16 : 0.18) : light ? 0.09 : 0.1;

  return (
    <div className="flex flex-col gap-2">
      <Segmented
        value={bg.kind}
        onChange={setKind}
        options={[
          { value: "none", label: "None", title: "Transparent — plays over the video underneath" },
          { value: "color", label: "Color", title: "Solid studio color backdrop" },
          { value: "gradient", label: "Gradient", title: "Customizable linear or radial studio gradient" },
        ]}
      />

      {bg.kind === "color" && (
        <Swatches
          colors={SOLID_BACKGROUNDS}
          titles={["Paper", "White", "Light grey", "Ink", "Night", "Blue"]}
          value={bg.color}
          onPick={(c) => c && applyBg({ ...bg, color: c })}
          custom
        />
      )}

      {bg.kind === "gradient" && (
        <div className="flex flex-col gap-2 rounded-lg bg-black/25 p-2 ring-1 ring-white/10">
          <div className="grid grid-cols-8 gap-1">
            {STUDIO_GRADIENTS.map((g) => {
              const active =
                bg.from.toLowerCase() === g.from.toLowerCase() &&
                bg.to.toLowerCase() === g.to.toLowerCase() &&
                !!bg.radial === !!g.radial;
              const css = g.radial
                ? `radial-gradient(circle at center, ${g.from}, ${g.to})`
                : `linear-gradient(${g.angle ?? 135}deg, ${g.from}, ${g.to})`;
              return (
                <button
                  key={g.id}
                  type="button"
                  title={g.label}
                  onClick={() =>
                    applyBg({
                      ...bg,
                      from: g.from,
                      to: g.to,
                      angle: g.angle ?? 135,
                      radial: !!g.radial,
                    })
                  }
                  style={{ background: css }}
                  className={`h-6 rounded-md transition-transform hover:scale-105 ${
                    active ? "ring-2 ring-teal-400 ring-offset-1 ring-offset-neutral-900" : "ring-1 ring-white/15"
                  }`}
                />
              );
            })}
          </div>

          {/* Custom From / To color stops + Swap */}
          <div className="flex items-center gap-1.5">
            <label className="flex-1 flex items-center gap-1.5 rounded-md bg-white/[0.04] px-1.5 py-1 ring-1 ring-white/10">
              <ColorInput
                value={bg.from}
                onChange={(e) => applyBg({ ...bg, from: e.target.value })}
                title="Start / centre gradient colour"
                className="w-4 h-4 rounded-sm shrink-0 cursor-pointer border-0 bg-transparent p-0"
              />
              <span className="text-[10px] text-white/65 truncate uppercase tabular-nums">{bg.from}</span>
            </label>
            <IconButton
              title="Swap gradient colours"
              onClick={() => applyBg({ ...bg, from: bg.to, to: bg.from })}
            >
              <IoSwapHorizontalOutline size={13} />
            </IconButton>
            <label className="flex-1 flex items-center gap-1.5 rounded-md bg-white/[0.04] px-1.5 py-1 ring-1 ring-white/10">
              <ColorInput
                value={bg.to}
                onChange={(e) => applyBg({ ...bg, to: e.target.value })}
                title="End / outer gradient colour"
                className="w-4 h-4 rounded-sm shrink-0 cursor-pointer border-0 bg-transparent p-0"
              />
              <span className="text-[10px] text-white/65 truncate uppercase tabular-nums">{bg.to}</span>
            </label>
          </div>

          <Segmented
            value={bg.radial ? "radial" : "linear"}
            onChange={(mode) => applyBg({ ...bg, radial: mode === "radial" })}
            options={[
              { value: "linear", label: "Linear", title: "Directional gradient across the stage" },
              { value: "radial", label: "Radial", title: "Spotlight gradient from the centre outward" },
            ]}
          />

          {!bg.radial && (
            <SliderRow
              label="Angle"
              value={bg.angle ?? 135}
              min={0}
              max={360}
              step={5}
              reset={135}
              format={(v) => `${Math.round(v)}°`}
              onChange={(angle) => applyBg({ ...bg, angle })}
            />
          )}

          <SliderRow
            label="Animate"
            value={bg.motion ?? 0}
            min={0}
            max={1}
            step={0.05}
            reset={0}
            format={(v) => (v <= 0.01 ? "Still" : `${Math.round(v * 100)}%`)}
            onChange={(motion) => applyBg({ ...bg, motion: motion <= 0.01 ? undefined : motion })}
          />
        </div>
      )}

      {bg.kind !== "none" && (
        <>
          <div className="flex flex-col gap-1.5 rounded-lg bg-black/25 p-2 ring-1 ring-white/10">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10.5px] text-white/60">Paper texture</span>
              <div className="w-36">
                <Segmented
                  value={currentPattern}
                  onChange={(pattern) => patchStyle({ pattern })}
                  options={[
                    { value: "none", label: "Plain", title: "No overlay texture" },
                    { value: "dots", label: "Dots", title: "GPU-rendered studio dot matrix" },
                    { value: "grid", label: "Grid", title: "GPU-rendered engineering grid" },
                  ]}
                />
              </div>
            </div>

            {currentPattern !== "none" && (
              <div className="flex flex-col gap-1.5 pt-1 border-t border-white/10">
                <SliderRow
                  label="Spacing"
                  value={bg.patternSize ?? defaultPatSize}
                  min={16}
                  max={140}
                  step={2}
                  reset={defaultPatSize}
                  format={(v) => `${Math.round(v)}px`}
                  onChange={(patternSize) => patchStyle({ patternSize })}
                />
                <SliderRow
                  label="Opacity"
                  value={bg.patternOpacity ?? defaultPatOpacity}
                  min={0.02}
                  max={0.65}
                  step={0.01}
                  reset={defaultPatOpacity}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onChange={(patternOpacity) => patchStyle({ patternOpacity })}
                />
                <SliderRow
                  label="Drift"
                  value={bg.patternDrift ?? 0}
                  min={0}
                  max={80}
                  step={2}
                  reset={0}
                  format={(v) => (v <= 0 ? "Still" : `${Math.round(v)}/s`)}
                  onChange={(patternDrift) => patchStyle({ patternDrift: patternDrift <= 0 ? undefined : patternDrift })}
                />
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-white/60">Line ink</span>
                  <div className="flex items-center gap-1.5">
                    <label className="flex items-center gap-1.5 rounded-md bg-white/[0.05] px-1.5 py-0.5 ring-1 ring-white/10">
                      <ColorInput
                        value={bg.patternColor ?? (light ? "#111111" : "#ffffff")}
                        onChange={(e) => patchStyle({ patternColor: e.target.value })}
                        title="Custom colour for dots or grid lines"
                        className="w-3.5 h-3.5 rounded-sm shrink-0 cursor-pointer border-0 bg-transparent p-0"
                      />
                      <span className="text-[10px] text-white/70">{bg.patternColor ? bg.patternColor.toUpperCase() : "Auto"}</span>
                    </label>
                    {bg.patternColor && (
                      <IconButton
                        title="Reset texture ink to automatic light/dark contrast"
                        onClick={() => patchStyle({ patternColor: undefined })}
                      >
                        <IoRefreshOutline size={11} />
                      </IconButton>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5 rounded-lg bg-black/25 p-2 ring-1 ring-white/10">
            <div className="flex items-center justify-between">
              <span className="text-[10.5px] text-white/60">Backdrop effects</span>
              {((bg.vignette ?? 0) > 0 || (bg.glow ?? 0) > 0 || (bg.grain ?? 0) > 0) && (
                <button
                  type="button"
                  onClick={() => patchStyle({ vignette: undefined, glow: undefined, grain: undefined })}
                  className="text-[10px] text-white/45 hover:text-white transition-colors"
                >
                  Reset
                </button>
              )}
            </div>
            <SliderRow
              label="Vignette"
              value={bg.vignette ?? 0}
              min={0}
              max={1}
              step={0.02}
              reset={0}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(vignette) => patchStyle({ vignette: vignette <= 0.005 ? undefined : vignette })}
            />
            <SliderRow
              label="Spotlight"
              value={bg.glow ?? 0}
              min={0}
              max={1}
              step={0.02}
              reset={0}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(glow) => patchStyle({ glow: glow <= 0.005 ? undefined : glow })}
            />
            <SliderRow
              label="Film grain"
              value={bg.grain ?? 0}
              min={0}
              max={1}
              step={0.02}
              reset={0}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(grain) => patchStyle({ grain: grain <= 0.005 ? undefined : grain })}
            />
          </div>
        </>
      )}
    </div>
  );
};

// ---------- 4. Quick Animate 1-Click Entrance Chips ----------

type QuickPresetId = "rise" | "pop" | "blur" | "wipe" | "words";

export const QuickAnimateBar: React.FC<{
  element: StageElement;
  onUpdateElement: (edit: (e: StageElement) => StageElement) => void;
}> = ({ element, onUpdateElement }) => {
  if (element.kind === "stack" || element.kind === "connector") return null;

  const current: QuickPresetId | null =
    element.kind === "text" && element.textReveal?.by === "word"
      ? "words"
      : element.enter?.wipe
        ? "wipe"
        : element.enter && element.enter.scale !== undefined && element.enter.scale < 0.85
          ? "pop"
          : element.enter && (element.enter.blur ?? 0) >= 18 && (element.enter.dy ?? 0) === 0
            ? "blur"
            : element.enter && (element.enter.dy ?? 0) > 0
              ? "rise"
              : null;

  const apply = (id: QuickPresetId) => {
    if (id === "words") {
      onUpdateElement((e) => ({
        ...e,
        textReveal: e.textReveal?.by === "word" ? undefined : { by: "word", style: "rise", stagger: 0.07 },
      }));
      return;
    }
    const presets: Record<Exclude<QuickPresetId, "words">, StageElement["enter"]> = {
      rise: { dx: 0, dy: 34, scale: 1, blur: 8, wipe: undefined },
      pop: { dx: 0, dy: 0, scale: 0.65, blur: 4, wipe: undefined },
      blur: { dx: 0, dy: 0, scale: 1.06, blur: 24, wipe: undefined },
      wipe: { dx: 0, dy: 0, scale: 1, blur: 0, draw: 0, opacity: 1, wipe: "right" },
    };
    onUpdateElement((e) => ({
      ...e,
      textReveal: undefined,
      enter: presets[id],
    }));
  };

  const chips: { id: QuickPresetId; label: string; title: string }[] = [
    { id: "rise", label: "Rise", title: "Glides smoothly up into view" },
    { id: "pop", label: "Pop", title: "Springs in with a crisp scale pop" },
    { id: "blur", label: "Blur", title: "Focuses in from soft cinematic blur" },
    { id: "wipe", label: "Wipe", title: "Sweeps smoothly across from left to right" },
    ...(element.kind === "text"
      ? [{ id: "words" as const, label: "Words", title: "Reveals word by word with kinetic stagger" }]
      : []),
  ];

  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] text-white/55">Quick entrance</span>
      <div className="flex flex-wrap gap-1">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            title={c.title}
            onClick={() => apply(c.id)}
            className={`px-2 py-0.5 rounded-full text-[10.5px] font-medium transition-colors ${
              current === c.id
                ? "bg-teal-500 text-white"
                : "bg-white/[0.06] text-white/70 hover:bg-white/12 hover:text-white"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
};

// ---------- 5. Scene Default Beat Sound Row ----------

export const SceneBeatSoundRow: React.FC<{
  scene: StageScene;
  onUpdate: Update;
}> = ({ scene, onUpdate }) => (
  <div className="flex items-center justify-between gap-2">
    <span className="text-[11px] text-white/60">Default beat SFX</span>
    <div className="flex items-center gap-1">
      <select
        value={scene.beatSound ?? "none"}
        onChange={(e) => {
          const val = e.target.value as StageBeatSound;
          onUpdate((s) => ({ ...s, beatSound: val === "none" ? undefined : val }));
          void auditionBeatSound(val);
        }}
        className="rounded-md bg-black/30 ring-1 ring-white/10 focus:ring-teal-400 outline-none px-2 py-1 text-[11px] text-white"
      >
        {STAGE_BEAT_SOUNDS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {scene.beatSound && scene.beatSound !== "none" && (
        <IconButton title={`Preview ${scene.beatSound}`} onClick={() => void auditionBeatSound(scene.beatSound)}>
          <IoVolumeHighOutline size={12} className="text-teal-300" />
        </IconButton>
      )}
    </div>
  </div>
);
