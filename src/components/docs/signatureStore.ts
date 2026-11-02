// components/docs/signatureStore.ts
//
// Signatures saved for reuse ("Save for next time" in DocSignatureStudio.tsx), and the hand-off
// that lets a just-placed signature write itself onto the page (DocImageView.tsx's ink-in).
// Saved signatures are this person's own, on this machine: kept in localStorage as small PNG data
// URLs, newest first, at most MAX. Every read and write tolerates storage being unavailable - the
// studio then simply has nothing saved.

export interface SavedSignature {
  id: string;
  dataUrl: string;
  width: number; // CSS px on the page
  height: number;
  signer: string | null;
  createdAt: string;
}

const KEY = "briefcast.docs.signatures";
const NAME_KEY = "briefcast.docs.signerName";
const MAX = 6;

export function loadSignatures(): SavedSignature[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as SavedSignature[]) : [];
    return Array.isArray(list) ? list.filter((s) => typeof s?.dataUrl === "string" && s.dataUrl.startsWith("data:image/")) : [];
  } catch {
    return [];
  }
}

export function saveSignature(sig: Omit<SavedSignature, "id" | "createdAt">): SavedSignature[] {
  const entry: SavedSignature = { ...sig, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  // The same picture saved twice stays one entry, moved to the front.
  const list = [entry, ...loadSignatures().filter((s) => s.dataUrl !== sig.dataUrl)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or unavailable: drop the oldest until it fits, else keep it for this session.
    for (let n = list.length - 1; n > 0; n--) {
      try {
        localStorage.setItem(KEY, JSON.stringify(list.slice(0, n)));
        break;
      } catch {
        // keep trimming
      }
    }
  }
  return list;
}

export function deleteSignature(id: string): SavedSignature[] {
  const list = loadSignatures().filter((s) => s.id !== id);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // unavailable
  }
  return list;
}

export function loadSignerName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveSignerName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // unavailable
  }
}

// Signature images placed in the last moment: their node view plays the ink-in reveal once.
const justPlaced = new Set<string>();
export const markJustPlaced = (src: string) => {
  justPlaced.add(src);
  window.setTimeout(() => justPlaced.delete(src), 4000);
};
export const takeJustPlaced = (src: string): boolean => justPlaced.delete(src);
