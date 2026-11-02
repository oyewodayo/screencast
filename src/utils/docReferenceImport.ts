// utils/docReferenceImport.ts
//
// The one "add references" path every Docs surface shares (citation picker, References panel):
// takes whatever the user typed or pasted - DOI, doi.org link, arXiv ID or link, BibTeX - or a
// .bib file, resolves it, and adds the result to the document's library.
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { BibliographyStore, normalizeCsl, parseBibtex, parseReferenceInput } from "./docBibliography";

export interface AddResult {
  ids: string[];
  added: number;
  // Shown under the input: what was added, or why nothing was.
  message: string;
  error: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summarize(ids: string[], added: number, errors: string[]): AddResult {
  if (ids.length === 0) {
    return { ids, added, error: true, message: errors[0] ?? "No references found in that text." };
  }
  const already = ids.length - added;
  const parts = [added > 0 ? `Added ${plural(added, "reference")}` : "", already > 0 ? `${plural(already, "reference")} already in this document` : ""].filter(Boolean);
  const skipped = errors.length > 0 ? ` · ${plural(errors.length, "entry")} couldn’t be read` : "";
  return { ids, added, error: false, message: `${parts.join(" · ")}${skipped}` };
}

export async function addReferencesFromInput(store: BibliographyStore, input: string): Promise<AddResult> {
  const parsed = parseReferenceInput(input);
  if (parsed.kind === "bibtex") {
    const { entries, errors } = parseBibtex(parsed.text);
    const { ids, added } = store.add(entries);
    return summarize(ids, added, errors);
  }
  if (parsed.kind === "doi") {
    try {
      const json = await invoke<string>("lookup_doi", { doi: parsed.doi });
      const entry = normalizeCsl(JSON.parse(json) as Record<string, unknown>);
      if (!entry.title && !entry.author?.length) return { ids: [], added: 0, error: true, message: "doi.org returned no title or authors for that DOI." };
      const { ids, added } = store.add([entry]);
      return summarize(ids, added, []);
    } catch (err) {
      return { ids: [], added: 0, error: true, message: err instanceof Error ? err.message : String(err) };
    }
  }
  return {
    ids: [],
    added: 0,
    error: true,
    message: "Enter a DOI (10.1038/…), an arXiv ID (2603.20372), or paste a BibTeX entry.",
  };
}

// Returns null when the dialog is cancelled.
export async function importBibFile(store: BibliographyStore): Promise<AddResult | null> {
  const selected = await openFileDialog({ multiple: false, filters: [{ name: "BibTeX", extensions: ["bib", "bibtex", "txt"] }] });
  if (!selected || Array.isArray(selected)) return null;
  try {
    const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path: selected });
    const text = new TextDecoder("utf-8").decode(bytes);
    const { entries, errors } = parseBibtex(text);
    const { ids, added } = store.add(entries);
    return summarize(ids, added, errors);
  } catch (err) {
    return { ids: [], added: 0, error: true, message: err instanceof Error ? err.message : String(err) };
  }
}
