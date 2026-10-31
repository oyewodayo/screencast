// Writes "Stage showcase.briefvideo" - the 20-second showcase (showcase.ts), its six scenes placed end
// to end on a blank 1920x1080 timeline - into the run-briefcast fixtures library, or the folder given.
//   node scripts/stage-check/make-showcase-project.mjs [folder]
import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? path.join(root, ".claude/skills/run-briefcast/fixtures/library"));
const { build } = createRequire(`${root}/package.json`)("esbuild");
const tmp = path.join(os.tmpdir(), "briefcast-stage-check");
mkdirSync(tmp, { recursive: true });
const bundle = path.join(tmp, "showcase.mjs");
await build({ entryPoints: [path.join(here, "showcase.ts")], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
const { SHOWCASE } = await import(`file://${bundle}?${Date.now()}`);
const scenes = SHOWCASE.map(({ scene, at }) => ({ ...scene, startTime: at }));
const project = path.join(out, "Stage showcase.briefvideo");
writeFileSync(project, JSON.stringify({ kind: "briefcast-video-project", version: 1, width: 1920, height: 1080 }, null, 2));
writeFileSync(`${project}.edits.json`, JSON.stringify({ duration: 0, clips: [], scenes }));
console.log(project, scenes.map((s) => `${s.name}@${s.startTime}`).join(", "));
