// utils/mindmapMigration.ts
//
// Transparent, idempotent migration from a legacy standalone Mindmap document (Briefcast/Mindmaps)
// into a native Whiteboard document (Briefcast/Whiteboards). Uses a deterministic whiteboard id
// (`mm-<mindmapId>`) so re-opening the same legacy mindmap from Home Library, Recent History, or
// Whiteboard Home always opens the already-migrated Whiteboard rather than creating duplicates.

import { invoke } from "@tauri-apps/api/core";
import type { MindmapDocument } from "./mindmapTypes";
import { convertMindmapDocumentToWhiteboardDocument } from "../handlers/whiteboardMindmapHandlers";

export function migratedWhiteboardIdForMindmap(mindmapId: string): string {
  return `mm-${mindmapId}`;
}

export async function openOrMigrateLegacyMindmap(mindmapId: string): Promise<string> {
  const targetId = migratedWhiteboardIdForMindmap(mindmapId);
  try {
    // If already migrated into Whiteboard, open the migrated copy directly.
    await invoke<string>("load_whiteboard", { id: targetId });
    return targetId;
  } catch {
    // Not migrated yet — load the legacy mindmap JSON, convert losslessly, and save as a Whiteboard.
    const raw = await invoke<string>("load_mindmap", { id: mindmapId });
    const legacyDoc: MindmapDocument = JSON.parse(raw);
    const converted = convertMindmapDocumentToWhiteboardDocument(legacyDoc, targetId);
    await invoke("create_whiteboard", {
      id: targetId,
      name: converted.name,
      json: JSON.stringify(converted),
    });
    return targetId;
  }
}
