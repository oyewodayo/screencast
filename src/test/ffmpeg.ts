// test/ffmpeg.ts
//
// The ffmpeg the filter-parity tests compare the preview models against (audioFx, chromaKey): the
// bundled one on Windows (src-tauri/binaries), otherwise the one on PATH - macOS and Linux don't
// bundle one. Resolved by actually running it, not by checking the file exists: CI creates empty
// placeholder files there so tauri-build's resource globs match, and an empty file "exists".
// Returns null when none runs, and the tests skip rather than fail.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

let cached: string | null | undefined;

export function testFfmpeg(): string | null {
  if (cached !== undefined) return cached;
  const bundled = join(__dirname, "../../src-tauri/binaries/ffmpeg/ffmpeg.exe");
  const candidates = process.platform === "win32" ? [bundled, "ffmpeg"] : ["ffmpeg"];
  cached = null;
  for (const candidate of candidates) {
    if (candidate === bundled && !existsSync(bundled)) continue;
    try {
      execFileSync(candidate, ["-version"], { stdio: "ignore" });
      cached = candidate;
      break;
    } catch {
      // Not runnable - try the next.
    }
  }
  return cached;
}
