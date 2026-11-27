import { describe, expect, it } from "vitest";
import {
  extractCaptionQuoteAt,
  filterStudyNotes,
  parseStudyNotesJson,
  sortStudyNotes,
  studyNotesToMarkdown,
  type StudyNote,
} from "./videoStudyNotes";

const sampleNotes: StudyNote[] = [
  {
    id: "n2",
    time: 125,
    text: "Superconducting qubits need dilution fridges (~15 mK)",
    tag: "key",
    quote: "Typical operating temperature is around 15 millikelvin.",
    createdAt: 200,
    updatedAt: 200,
  },
  {
    id: "n1",
    time: 42,
    text: "Check T1 vs T2 coherence times",
    tag: "question",
    createdAt: 100,
    updatedAt: 100,
  },
  {
    id: "n3",
    time: 310,
    text: "Compare trapped ions vs neutral atoms in follow-up brief",
    tag: "todo",
    createdAt: 300,
    updatedAt: 300,
  },
];

describe("videoStudyNotes", () => {
  it("sorts notes chronologically by timestamp", () => {
    const sorted = sortStudyNotes(sampleNotes);
    expect(sorted.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
  });

  it("filters notes by tag and free-text query including timestamps and quotes", () => {
    expect(filterStudyNotes(sampleNotes, "", "key").map((n) => n.id)).toEqual(["n2"]);
    expect(filterStudyNotes(sampleNotes, "millikelvin", "all").map((n) => n.id)).toEqual(["n2"]);
    expect(filterStudyNotes(sampleNotes, "0:42", "all").map((n) => n.id)).toEqual(["n1"]);
    expect(filterStudyNotes(sampleNotes, "neutral", "todo").map((n) => n.id)).toEqual(["n3"]);
    expect(filterStudyNotes(sampleNotes, "neutral", "key")).toEqual([]);
  });

  it("parses sidecar JSON defensively and preserves autoPauseOnType", () => {
    const parsed = parseStudyNotesJson(
      JSON.stringify({
        version: 1,
        autoPauseOnType: false,
        notes: [
          { id: "a", time: 90, text: "Hello", tag: "key" },
          { id: "bad", time: "NaN", text: "ignored" },
          { id: "b", time: 10, text: "First", tag: "unknown-tag" },
        ],
      })
    );
    expect(parsed.autoPauseOnType).toBe(false);
    expect(parsed.notes.map((n) => n.id)).toEqual(["b", "a"]);
    expect(parsed.notes[0].tag).toBe("note");
  });

  it("extracts spoken caption quotes around the current timestamp", () => {
    const lines = [
      { start: 10, end: 14, text: "First we introduce decoherence." },
      { start: 14.2, end: 18.5, text: "T2 is always bounded by twice T1." },
      { start: 19, end: 23, text: "Spin echo recovers dephasing." },
    ];
    const quote = extractCaptionQuoteAt(lines, 16);
    expect(quote).toContain("T2 is always bounded by twice T1.");
    expect(quote).toContain("Spin echo recovers dephasing.");
  });

  it("exports structured Markdown with timestamps, tags, quotes, and saved slide snapshots", () => {
    const snapshots = new Map<string, string>([["n2", "asset://slide-2.jpg"]]);
    const md = studyNotesToMarkdown(sampleNotes, {
      videoTitle: "Quantum Qubits",
      includeHeader: true,
      snapshotUrlByNoteId: snapshots,
    });
    expect(md).toContain("# Quantum Qubits — Study Notes");
    expect(md).toContain("- **0:42** [Question] — Check T1 vs T2 coherence times");
    expect(md).toContain("- **2:05** [Key Idea] — Superconducting qubits need dilution fridges (~15 mK)");
    expect(md).toContain('> "Typical operating temperature is around 15 millikelvin."');
    expect(md).toContain("![Slide at 2:05](asset://slide-2.jpg)");
  });
});
