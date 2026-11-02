// Writes "Insomnia gate.briefvideo" (a 1920x1080 project holding only the gate scenes, placed at
// the reference's 19s+ times) into the run-briefcast fixtures library, or into the folder given.
//   node scripts/stage-check/make-gate-project.mjs [folder]
import { createRequire } from "node:module";
import { copyFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "../..");
const out = path.resolve(process.argv[2] ?? path.join(root, ".claude/skills/run-briefcast/fixtures/library"));
const { build } = createRequire(`${root}/package.json`)("esbuild");
const tmp = path.join(os.tmpdir(), "briefcast-stage-check");
mkdirSync(tmp, { recursive: true });
const bundle = path.join(tmp, "insomnia.mjs");
await build({ entryPoints: [path.join(here, "insomnia.ts")], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
const { GATE, CARD_NAMES, cardsScene } = await import(`file://${bundle}?${Date.now()}`);
// The card fan's pictures, beside the project.
const { cardsDir } = await import("./make-cards.mjs");
const pictures = path.join(out, "Insomnia gate pictures");
mkdirSync(pictures, { recursive: true });
for (const n of CARD_NAMES) copyFileSync(path.join(cardsDir, `${n}.png`), path.join(pictures, `${n}.png`));
const placed = [...GATE, { scene: cardsScene((n) => path.join(pictures, `${n}.png`)), at: 31.35 }].sort((a, b) => a.at - b.at);
const scenes = placed.map(({ scene, at }) => ({ ...scene, startTime: +(at - 19).toFixed(3) }));
const project = path.join(out, "Insomnia gate.briefvideo");
writeFileSync(project, JSON.stringify({ kind: "briefcast-video-project", version: 1, width: 1920, height: 1080 }, null, 2));
writeFileSync(`${project}.edits.json`, JSON.stringify({ duration: 0, clips: [], scenes }));
console.log(project, scenes.map((s) => `${s.name}@${s.startTime}`).join(", "));
