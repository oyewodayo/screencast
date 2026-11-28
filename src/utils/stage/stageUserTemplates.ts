// utils/stage/stageUserTemplates.ts
//
// Custom user-saved Scene templates persisted in localStorage so creators can save their own
// branded intros, lower-thirds, and explainer cards and apply them to any scene in one click.
import { duplicateScene } from "./stageEditing";
import type { StageBackground, StageScene } from "./stageTypes";

const STORAGE_KEY = "briefcast.stage.userTemplates.v1";
const MAX_USER_TEMPLATES = 32;

export interface UserSceneTemplate {
  id: string;
  name: string;
  createdAt: string;
  beatCount: number;
  background: StageBackground;
  scene: StageScene;
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tpl_${Math.random().toString(36).slice(2, 10)}`;

export function loadUserSceneTemplates(): UserSceneTemplate[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is UserSceneTemplate =>
        !!item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        !!item.scene &&
        Array.isArray(item.scene.elements) &&
        Array.isArray(item.scene.beats)
    );
  } catch {
    return [];
  }
}

function persist(list: UserSceneTemplate[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_USER_TEMPLATES)));
  } catch (err) {
    console.warn("Could not save custom scene templates:", err);
  }
}

export function saveUserSceneTemplate(name: string, scene: StageScene): UserSceneTemplate[] {
  const trimmed = name.trim() || scene.name?.trim() || "Custom scene";
  const snapshot: StageScene = JSON.parse(JSON.stringify(scene));
  const entry: UserSceneTemplate = {
    id: newId(),
    name: trimmed,
    createdAt: new Date().toISOString(),
    beatCount: snapshot.beats.length,
    background: snapshot.background,
    scene: { ...snapshot, name: trimmed },
  };
  const next = [entry, ...loadUserSceneTemplates()].slice(0, MAX_USER_TEMPLATES);
  persist(next);
  return next;
}

export function deleteUserSceneTemplate(id: string): UserSceneTemplate[] {
  const next = loadUserSceneTemplates().filter((t) => t.id !== id);
  persist(next);
  return next;
}

// Applies a saved user template onto an existing scene, preserving its timeline identity, position,
// and target stage dimensions while giving every element and beat fresh IDs.
export function applyUserSceneTemplate(existing: StageScene, template: UserSceneTemplate): StageScene {
  const cloned = duplicateScene(template.scene, existing.startTime);
  // Rescale element horizontal coordinates if aspect ratio changed (e.g. 16:9 template onto 9:16).
  const scaleX = template.scene.width > 0 ? existing.width / template.scene.width : 1;
  const elements =
    Math.abs(scaleX - 1) < 0.01
      ? cloned.elements
      : cloned.elements.map((e) => ({
          ...e,
          props: {
            ...e.props,
            x: Math.round(e.props.x * scaleX),
            width: Math.max(24, Math.round(e.props.width * scaleX)),
          },
        }));
  return {
    ...cloned,
    id: existing.id,
    name: template.name,
    startTime: existing.startTime,
    layer: existing.layer,
    width: existing.width,
    height: existing.height,
    elements,
  };
}
