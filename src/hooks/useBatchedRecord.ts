// hooks/useBatchedRecord.ts
//
// A path -> value record (thumbnail URLs, mostly) filled by many small async results, committed in
// batches rather than one render per result. A gallery resolving hundreds of thumbnails used to
// re-render every tile once per thumbnail - hundreds of full-grid renders back to back, which kept
// the main thread busy enough that clicks on the same screen waited behind them.
//
// A timer rather than requestAnimationFrame: rAF stops while the window is occluded, which would
// hold every result back until it's shown again.
import { useCallback, useEffect, useRef, useState } from "react";

const FLUSH_MS = 32;

export function useBatchedRecord<T>(): [Record<string, T>, (key: string, value: T, overwrite?: boolean) => void] {
  const [record, setRecord] = useState<Record<string, T>>({});
  const pendingRef = useRef<{ key: string; value: T; overwrite: boolean }[]>([]);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  // Keeps the first value for a key unless `overwrite` - a refreshed thumbnail replaces the old one.
  const put = useCallback((key: string, value: T, overwrite = false) => {
    pendingRef.current.push({ key, value, overwrite });
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const pending = pendingRef.current;
      pendingRef.current = [];
      setRecord((prev) => {
        let next = prev;
        for (const { key, value, overwrite } of pending) {
          if (!overwrite && key in next) continue;
          if (next === prev) next = { ...prev };
          next[key] = value;
        }
        return next;
      });
    }, FLUSH_MS);
  }, []);

  return [record, put];
}
