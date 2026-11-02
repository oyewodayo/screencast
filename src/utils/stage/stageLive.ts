// utils/stage/stageLive.ts
//
// What the editor's Stage layers share: each scene compiled once per version (scenes are replaced,
// never mutated, so a version is the object itself) after its fonts have loaded - the preview, the
// on-canvas editing and the export all read the same compiled scene - and the offsets of elements
// being dragged, which the drawing layer applies without recompiling anything.
import { CompiledStage, compileStage } from "./stageEngine";
import { loadStageImages } from "./stageImages";
import { loadStageMath } from "./stageMath";
import { loadStageGraphs } from "./stageGraph";
import { canvasStageMeasure, loadStageFonts } from "./stageMeasure";
import type { StageScene } from "./stageTypes";

const compiled = new WeakMap<StageScene, CompiledStage>();
const pending = new WeakMap<StageScene, Promise<CompiledStage>>();

// The scene compiled, if it's ready.
export const compiledFor = (scene: StageScene): CompiledStage | null => compiled.get(scene) ?? null;

// The scene compiled once its faces are in (text measured in a fallback face lands somewhere else).
export function whenCompiled(scene: StageScene): Promise<CompiledStage> {
  const ready = compiled.get(scene);
  if (ready) return Promise.resolve(ready);
  let p = pending.get(scene);
  if (!p) {
    p = Promise.all([loadStageFonts(scene), loadStageImages(scene), loadStageMath(scene), loadStageGraphs(scene)]).then(() => {
      const c = compileStage(scene, canvasStageMeasure);
      compiled.set(scene, c);
      return c;
    });
    pending.set(scene, p);
  }
  return p;
}

// Elements being dragged: id -> shift in stage units, relative to the compiled scene the drag began
// on (`from`). The drawing layer applies a shift only while drawing that very compilation: once the
// moved scene has compiled, the shift is already in it and stops applying by itself - whatever order
// the release and the recompile arrive in. `version` moves on every change so the layer redraws.
export interface StageDragOffset {
  dx: number;
  dy: number;
  // A resize or turn by a handle: the change of size and rotation.
  dw?: number;
  dh?: number;
  dr?: number;
  from: CompiledStage | null;
}
export const stageDrag = {
  offsets: new Map<string, StageDragOffset>(),
  version: 0,
  set(id: string, offset: StageDragOffset | null) {
    if (offset) this.offsets.set(id, offset);
    else this.offsets.delete(id);
    this.version++;
  },
};
