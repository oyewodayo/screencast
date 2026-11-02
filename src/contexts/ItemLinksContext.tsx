// contexts/ItemLinksContext.tsx
//
// One place that knows every cross-link between library items (video, audio, image, PDF, notes,
// whiteboards, mind maps) and how to open the other end. Dashboard mounts the provider and supplies
// `onOpen`, since only it can switch screens; every viewer then just renders <LinksControl/> for the
// item it is showing. See services/links.rs for the storage and utils/itemLinks.ts for the model.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getFileCategory } from "../utils/fileCategory";
import type { DocSummary } from "../utils/docTypes";
import type { WhiteboardSummary } from "../utils/whiteboardTypes";
import type { MindmapSummary } from "../utils/mindmapTypes";
import { edgesFor, fileRef, normalizePath, refKey, sameRef, type ItemKind, type ItemLinkRecord, type ItemRef, type ResolvedLink } from "../utils/itemLinks";

export interface LinkableFile {
  name: string;
  path: string;
}

export interface LinkCandidate {
  ref: ItemRef;
  title: string;
  family: ResolvedLink["family"];
}

interface CameFrom {
  from: { ref: ItemRef; title: string };
  targetKey: string;
}

interface ItemLinksContextValue {
  links: ItemLinkRecord[];
  docs: DocSummary[];
  whiteboards: WhiteboardSummary[];
  mindmaps: MindmapSummary[];
  files: LinkableFile[];
  cameFrom: CameFrom | null;
  refresh: () => Promise<void>;
  add: (a: ItemRef, b: ItemRef) => Promise<void>;
  remove: (item: ResolvedLink) => Promise<void>;
  open: (target: ItemRef, from?: { ref: ItemRef; title: string }) => void;
  clearCameFrom: () => void;
}

const ItemLinksContext = createContext<ItemLinksContextValue | null>(null);

export const ItemLinksProvider: React.FC<{
  files: LinkableFile[];
  onOpen: (target: ItemRef) => void;
  children: React.ReactNode;
}> = ({ files, onOpen, children }) => {
  const [links, setLinks] = useState<ItemLinkRecord[]>([]);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [whiteboards, setWhiteboards] = useState<WhiteboardSummary[]>([]);
  const [mindmaps, setMindmaps] = useState<MindmapSummary[]>([]);
  const [cameFrom, setCameFrom] = useState<CameFrom | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const refresh = useCallback(async () => {
    const [l, d, w, m] = await Promise.allSettled([
      invoke<ItemLinkRecord[]>("list_links"),
      invoke<DocSummary[]>("list_docs"),
      invoke<WhiteboardSummary[]>("list_whiteboards"),
      invoke<MindmapSummary[]>("list_mindmaps"),
    ]);
    if (l.status === "fulfilled") setLinks(l.value);
    if (d.status === "fulfilled") setDocs(d.value);
    if (w.status === "fulfilled") setWhiteboards(w.value);
    if (m.status === "fulfilled") setMindmaps(m.value);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(
    async (a: ItemRef, b: ItemRef) => {
      await invoke("add_link", { a, b });
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (item: ResolvedLink) => {
      if (item.linkId) await invoke("remove_link", { id: item.linkId });
      if (item.legacyDocId) await invoke("unlink_doc", { id: item.legacyDocId });
      await refresh();
    },
    [refresh],
  );

  const open = useCallback((target: ItemRef, from?: { ref: ItemRef; title: string }) => {
    setCameFrom(from ? { from, targetKey: refKey(target.kind === "file" ? { kind: "file", id: normalizePath(target.id) } : target) } : null);
    onOpenRef.current(target);
  }, []);

  const clearCameFrom = useCallback(() => setCameFrom(null), []);

  const value = useMemo<ItemLinksContextValue>(
    () => ({ links, docs, whiteboards, mindmaps, files, cameFrom, refresh, add, remove, open, clearCameFrom }),
    [links, docs, whiteboards, mindmaps, files, cameFrom, refresh, add, remove, open, clearCameFrom],
  );
  return <ItemLinksContext.Provider value={value}>{children}</ItemLinksContext.Provider>;
};

const familyOfFile = (name: string): ResolvedLink["family"] => getFileCategory(name) ?? "other";

export interface UseItemLinks {
  items: ResolvedLink[];
  candidates: LinkCandidate[];
  // Set when the viewer was reached by clicking a link, so it can offer a way straight back.
  backTo: { ref: ItemRef; title: string } | null;
  link: (target: ItemRef) => Promise<void>;
  unlink: (item: ResolvedLink) => Promise<void>;
  openItem: (item: ResolvedLink) => void;
  openBack: () => void;
  refresh: () => Promise<void>;
}

export function useItemLinks(self: ItemRef | null, selfTitle: string): UseItemLinks | null {
  const ctx = useContext(ItemLinksContext);

  const resolve = useCallback(
    (ref: ItemRef): { title: string; family: ResolvedLink["family"] } | null => {
      if (!ctx) return null;
      if (ref.kind === "file") {
        const file = ctx.files.find((f) => normalizePath(f.path) === normalizePath(ref.id));
        return file ? { title: file.name, family: familyOfFile(file.name) } : null;
      }
      if (ref.kind === "doc") {
        const doc = ctx.docs.find((d) => d.id === ref.id);
        return doc ? { title: doc.title || "Untitled note", family: "doc" } : null;
      }
      if (ref.kind === "whiteboard") {
        const wb = ctx.whiteboards.find((w) => w.id === ref.id);
        return wb ? { title: wb.name, family: "whiteboard" } : null;
      }
      const mm = ctx.mindmaps.find((m) => m.id === ref.id);
      return mm ? { title: mm.name, family: "mindmap" } : null;
    },
    [ctx],
  );

  return useMemo(() => {
    if (!ctx || !self) return null;
    // Edges whose other end no longer resolves (file deleted, project removed) are simply hidden.
    const items: ResolvedLink[] = [];
    for (const edge of edgesFor(self, ctx.links, ctx.docs)) {
      const info = resolve(edge.other);
      if (!info) continue;
      items.push({ key: edge.linkId ?? `legacy:${edge.legacyDocId}`, linkId: edge.linkId, legacyDocId: edge.legacyDocId, ref: edge.other, title: info.title, family: info.family });
    }

    const linkedKeys = new Set(items.map((i) => (i.ref.kind === "file" ? `file:${normalizePath(i.ref.id)}` : refKey(i.ref))));
    const candidates: LinkCandidate[] = [];
    const consider = (ref: ItemRef, title: string, family: ResolvedLink["family"]) => {
      const key = ref.kind === "file" ? `file:${normalizePath(ref.id)}` : refKey(ref);
      if (sameRef(ref, self) || (ref.kind === "file" && self.kind === "file" && normalizePath(ref.id) === normalizePath(self.id)) || linkedKeys.has(key)) return;
      candidates.push({ ref, title, family });
    };
    for (const d of ctx.docs) consider({ kind: "doc", id: d.id }, d.title || "Untitled note", "doc");
    for (const w of ctx.whiteboards) consider({ kind: "whiteboard", id: w.id }, w.name, "whiteboard");
    for (const m of ctx.mindmaps) consider({ kind: "mindmap", id: m.id }, m.name, "mindmap");
    for (const f of ctx.files) consider(fileRef(f.path), f.name, familyOfFile(f.name));

    const selfKey = self.kind === "file" ? refKey({ kind: "file", id: normalizePath(self.id) }) : refKey(self);
    const backTo = ctx.cameFrom && ctx.cameFrom.targetKey === selfKey ? ctx.cameFrom.from : null;

    return {
      items,
      candidates,
      backTo,
      link: (target: ItemRef) => ctx.add(self, target),
      unlink: ctx.remove,
      openItem: (item: ResolvedLink) => ctx.open(item.ref, { ref: self, title: selfTitle }),
      openBack: () => backTo && ctx.open(backTo.ref),
      refresh: ctx.refresh,
    };
  }, [ctx, self, selfTitle, resolve]);
}

export type { ItemKind };
