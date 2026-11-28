// utils/briefsPublish.ts
//
// Zero-friction bridge from Briefcast (Docs & Videos) to Briefs (withbriefs.com/brief/create):
// formats clean newsletter-ready HTML + plain text, copies both to the clipboard so headings,
// links and chapter lists survive paste, and opens the Briefs composer in the user's browser.
import { invoke } from "@tauri-apps/api/core";
import { formatChapterTimestamp } from "./videoChapters";
import { groupTranscriptIntoParagraphs, type VideoDocChapter, type VideoTranscriptLine } from "./videoToDoc";

export const BRIEFS_CREATE_URL = "https://withbriefs.com/brief/create";

export interface BriefsVideoPayloadInput {
  title: string;
  summary?: string;
  watchUrl?: string | null;
  durationSec?: number;
  chapters?: VideoDocChapter[];
  lines?: VideoTranscriptLine[];
  includeChapters?: boolean;
  includeTranscript?: boolean;
}

export interface BriefsSharePayload {
  html: string;
  text: string;
  previewText: string;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function buildBriefsVideoPayload(input: BriefsVideoPayloadInput): BriefsSharePayload {
  const title = input.title.trim() || "New Video Brief";
  const summary = input.summary?.trim() ?? "";
  const watchUrl = input.watchUrl?.trim() ?? "";
  const chapters = (input.includeChapters !== false ? input.chapters ?? [] : [])
    .filter((c) => Number.isFinite(c.time))
    .sort((a, b) => a.time - b.time);
  const lines = input.includeTranscript ? input.lines ?? [] : [];

  const htmlParts: string[] = [];
  const textParts: string[] = [];

  htmlParts.push(`<h1>${escHtml(title)}</h1>`);
  textParts.push(title);

  if (summary) {
    htmlParts.push(`<p>${escHtml(summary).replace(/\n+/g, "</p><p>")}</p>`);
    textParts.push(summary);
  }

  if (watchUrl) {
    const durationNote = input.durationSec && input.durationSec > 0 ? ` (${formatChapterTimestamp(input.durationSec)})` : "";
    htmlParts.push(`<p><strong>Watch the video${escHtml(durationNote)}:</strong> <a href="${escHtml(watchUrl)}">${escHtml(watchUrl)}</a></p>`);
    textParts.push(`Watch the video${durationNote}: ${watchUrl}`);
  }

  if (chapters.length > 0) {
    htmlParts.push("<h2>What's inside</h2>");
    htmlParts.push(
      `<ul>${chapters
        .map((c, idx) => `<li><strong>${escHtml(formatChapterTimestamp(c.time))}</strong> — ${escHtml(c.label.trim() || `Chapter ${idx + 1}`)}</li>`)
        .join("")}</ul>`
    );
    textParts.push(
      "What's inside:\n" +
        chapters.map((c, idx) => `• ${formatChapterTimestamp(c.time)} — ${c.label.trim() || `Chapter ${idx + 1}`}`).join("\n")
    );
  }

  if (lines.length > 0) {
    const paras = groupTranscriptIntoParagraphs(lines);
    if (paras.length > 0) {
      htmlParts.push("<h2>Transcript</h2>");
      for (const p of paras) {
        htmlParts.push(`<p><strong>${escHtml(formatChapterTimestamp(p.start))}</strong> ${escHtml(p.text)}</p>`);
      }
      textParts.push("Transcript:\n" + paras.map((p) => `${formatChapterTimestamp(p.start)} ${p.text}`).join("\n\n"));
    }
  }

  const text = textParts.join("\n\n");
  return {
    html: htmlParts.join("\n"),
    text,
    previewText: text.length > 900 ? `${text.slice(0, 900)}…` : text,
  };
}

export async function copyRichToClipboard(html: string, text: string): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // Fall back to plain text below when webview blocks ClipboardItem.
    }
  }
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  }
}

export async function openBriefsComposer(): Promise<void> {
  await invoke("open_share_url", { url: BRIEFS_CREATE_URL });
}
