// Stand-in "app window" pictures for the gate's card fan (the reference shows app screenshots; these
// are drawn here with the bundled ffmpeg, nothing copied). Written to %TEMP%/briefcast-stage-check/cards.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "../..");
const ffmpeg = path.join(root, "src-tauri/binaries/ffmpeg/ffmpeg.exe");
export const cardsDir = path.join(os.tmpdir(), "briefcast-stage-check", "cards");
mkdirSync(cardsDir, { recursive: true });
// Fonts beside the output, named relatively - a drive letter's colon trips ffmpeg's filter parser.
copyFileSync("C:/Windows/Fonts/segoeui.ttf", path.join(cardsDir, "ui.ttf"));
copyFileSync("C:/Windows/Fonts/consola.ttf", path.join(cardsDir, "mono.ttf"));
const font = "ui.ttf";
const mono = "mono.ttf";
const cards = [
  { name: "agent", bg: "0x1c1c1c", ink: "white", title: "Agent", accent: "0xe07a5f", lines: ["> add retry with backoff to sync", "  Reading src/sync/worker.ts", "  Edit lib/retry.ts  +24 -3", "  Running tests...", "  41 passed, 0 failed"] },
  { name: "codex", bg: "0x111111", ink: "white", title: "Codex", accent: "0xffffff", lines: ["$ codex run --task tests", "  planning 3 steps", "  patch applied", "  build ok", "  waiting for review"] },
  { name: "docker", bg: "0x1d4ed8", ink: "white", title: "Containers", accent: "0x93c5fd", lines: ["api        running   2h", "worker     running   2h", "db         running   2h", "cache      running   2h", ""] },
  { name: "browser", bg: "0xf5f5f4", ink: "0x111111", title: "Browser", accent: "0x111111", lines: ["Deploy preview", "Status: building", "Logs streaming", "", ""] },
  { name: "terminal", bg: "0x0a0a0a", ink: "0x4ade80", title: "Terminal", accent: "0x4ade80", lines: ["$ npm run watch", "  compiled in 412ms", "  watching for changes", "  rebuilt in 98ms", ""] },
];
for (const c of cards) {
  const draws = [
    `drawbox=x=0:y=0:w=iw:h=64:color=${c.bg}@1:t=fill`,
    `drawtext=fontfile='${font}':text='${c.title}':x=32:y=20:fontsize=26:fontcolor=${c.ink}`,
    `drawbox=x=32:y=120:w=180:h=120:color=${c.accent}@0.9:t=fill`,
    ...c.lines.map((l, i) => (l ? `drawtext=fontfile='${mono}':text='${l.replace(/[:']/g, " ")}':x=32:y=${300 + i * 56}:fontsize=26:fontcolor=${c.ink}@0.85` : null)).filter(Boolean),
    `drawbox=x=32:y=860:w=220:h=48:color=0x22c55e@0.25:t=fill`,
  ];
  execFileSync(ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${c.bg}:s=720x960`, "-vf", draws.join(","), "-frames:v", "1", `${c.name}.png`], { cwd: cardsDir });
}
console.log(cardsDir);
