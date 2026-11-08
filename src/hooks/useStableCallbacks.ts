// hooks/useStableCallbacks.ts
//
// The same functions every render, each always calling the latest version passed in. For
// handing a page's handlers to a memoized child: the child's props stay equal from render to
// render (so it skips re-rendering when nothing it shows changed), yet a click still runs the
// handler as of now - not the one from whenever the child last rendered.
import { useRef } from "react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

export function useStableCallbacks<T extends Record<string, AnyFn>>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;
  const stable = useRef<T | null>(null);
  if (!stable.current) {
    const wrapped = {} as Record<string, AnyFn>;
    for (const key of Object.keys(fns)) wrapped[key] = (...args: unknown[]) => latest.current[key](...args);
    stable.current = wrapped as T;
  }
  return stable.current;
}
