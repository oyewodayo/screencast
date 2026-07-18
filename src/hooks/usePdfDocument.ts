// hooks/usePdfDocument.ts
import { useEffect, useState } from "react";
import { getDocument, GlobalWorkerOptions, PDFDocumentProxy } from "pdfjs-dist";
// The `?url` suffix tells Vite to emit this as a static asset and hand back its final URL,
// rather than trying to execute it as a module — this is the reliable way to point pdf.js's
// worker at a same-origin file under Tauri's CSP (no CDN, no inline blob dependency).
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

let workerConfigured = false;

function ensureWorkerConfigured(): void {
  if (workerConfigured) return;
  GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  workerConfigured = true;
}

interface UsePdfDocumentResult {
  pdfDoc: PDFDocumentProxy | null;
  numPages: number;
  loading: boolean;
  error: string | null;
}

export default function usePdfDocument(src: string | undefined): UsePdfDocumentResult {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setPdfDoc(null);
      setNumPages(0);
      return;
    }

    ensureWorkerConfigured();

    let cancelled = false;
    setLoading(true);
    setError(null);

    const loadingTask = getDocument({ url: src });
    loadingTask.promise.then(
      (doc) => {
        if (cancelled) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setLoading(false);
      },
      (err) => {
        if (cancelled) return;
        console.error("Failed to load PDF:", err);
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
  }, [src]);

  return { pdfDoc, numPages, loading, error };
}
