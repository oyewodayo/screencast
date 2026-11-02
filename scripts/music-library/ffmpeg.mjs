// Shared ffmpeg helpers for the music-library scripts: the app's bundled ffmpeg when it's there,
// else $FFMPEG / $FFPROBE, else whatever is on PATH.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bundled = (name) => path.join(repoRoot, "src-tauri", "binaries", "ffmpeg", process.platform === "win32" ? `${name}.exe` : name);

export const REPO_ROOT = repoRoot;
export const FFMPEG = process.env.FFMPEG || (fs.existsSync(bundled("ffmpeg")) ? bundled("ffmpeg") : "ffmpeg");
export const FFPROBE = process.env.FFPROBE || (fs.existsSync(bundled("ffprobe")) ? bundled("ffprobe") : "ffprobe");

// Runs a tool to completion; resolves with its stdout as a Buffer, rejects with the stderr tail.
export function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    let err = "";
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.trim()}`))));
  });
}

export const ffmpeg = (args) => run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
