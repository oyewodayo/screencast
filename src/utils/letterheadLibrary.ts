// utils/letterheadLibrary.ts
//
// The company's letterheads, saved once and used on any document (DocLetterheadDialog.tsx), and
// the one marked as the default for new documents (DocsHome.tsx's "New document"). Kept on this
// machine in IndexedDB - letterheads carry their logos, too big for localStorage. Every call
// tolerates IndexedDB being unavailable: the library is then simply empty.
import { normalizeLetterhead, type DocLetterhead } from "./docLetterhead";

export interface SavedLetterhead {
  id: string;
  name: string;
  letterhead: DocLetterhead;
  thumb: string; // small PNG data URL of page 1
  createdAt: string;
  isDefault: boolean;
}

const DB = "briefcast-docs";
const STORE = "letterheads";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export async function listLetterheads(): Promise<SavedLetterhead[]> {
  try {
    const all = ((await tx<SavedLetterhead[]>("readonly", (s) => s.getAll() as IDBRequest<SavedLetterhead[]>)) ?? []).filter((r) => normalizeLetterhead(r.letterhead));
    return all.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export async function saveLetterhead(letterhead: DocLetterhead, thumb: string, makeDefault = false): Promise<SavedLetterhead | null> {
  try {
    if (makeDefault) await clearDefault();
    const rec: SavedLetterhead = {
      id: crypto.randomUUID(),
      name: letterhead.name,
      letterhead: { ...letterhead, previousMargins: null },
      thumb,
      createdAt: new Date().toISOString(),
      isDefault: makeDefault,
    };
    await tx("readwrite", (s) => void s.put(rec));
    return rec;
  } catch (err) {
    console.error("Failed to save letterhead:", err);
    return null;
  }
}

async function clearDefault() {
  for (const r of await listLetterheads()) if (r.isDefault) await tx("readwrite", (s) => void s.put({ ...r, isDefault: false }));
}

export async function setDefaultLetterhead(id: string | null): Promise<void> {
  try {
    await clearDefault();
    if (!id) return;
    const r = (await listLetterheads()).find((x) => x.id === id);
    if (r) await tx("readwrite", (s) => void s.put({ ...r, isDefault: true }));
  } catch (err) {
    console.error("Failed to set the default letterhead:", err);
  }
}

export async function renameLetterhead(id: string, name: string): Promise<void> {
  const r = (await listLetterheads()).find((x) => x.id === id);
  if (r) await tx("readwrite", (s) => void s.put({ ...r, name, letterhead: { ...r.letterhead, name } })).catch(() => undefined);
}

export async function deleteLetterhead(id: string): Promise<void> {
  await tx("readwrite", (s) => void s.delete(id)).catch(() => undefined);
}

export async function defaultLetterhead(): Promise<SavedLetterhead | null> {
  return (await listLetterheads()).find((r) => r.isDefault) ?? null;
}
