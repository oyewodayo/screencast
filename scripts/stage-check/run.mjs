// Stage render check: bundles harness.ts (the reference's 19-38s sections as Stage scenes), serves it,
// drives headless Edge - the same Chromium as Briefcast's WebView2, so it runs alongside `tauri dev` -
// over the DevTools protocol, and prints per-frame GPU timings at the requested size. Frames asked for
// are written as PNGs. Everything generated goes to the system temp folder.
//
//   STAGE_OPTS='{"width":1920,"height":1080,"frames":{"headline":[1.55,3.3]}}' node scripts/stage-check/run.mjs
//   PROFILE=1 ... prints the top self-time functions; "only":["race"] picks scenes (in that order).
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const root = path.resolve(here, "../..");
const dir = path.join(os.tmpdir(), "briefcast-stage-check");
mkdirSync(dir, { recursive: true });
const { build } = createRequire(`${root}/package.json`)("esbuild");
await build({
  entryPoints: [path.join(here, "harness.ts")],
  bundle: true,
  format: "iife",
  outdir: dir,
  entryNames: "bundle",
  assetNames: "assets/[name]",
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".png": "file", ".svg": "file" },
  alias: { "@stage": `${root}/src/utils/stage` },
  nodePaths: [`${root}/node_modules`],
  define: { "import.meta.env": "{}" },
  logLevel: "error",
});
// Pictures for the image scene.
copyFileSync(path.join(root, ".claude/skills/run-briefcast/fixtures/library/style_test_1_3.jpg"), path.join(dir, "pic.jpg"));
copyFileSync(path.join(root, "src/assets/screencast.png"), path.join(dir, "logo.png"));
// The card fan's stand-in pictures (drawn into dir/cards).
await import("./make-cards.mjs");
writeFileSync(path.join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="bundle.css"><body style="margin:0;background:#000"><script src="bundle.js"></script>`);

const server = createServer((req, res) => {
  const f = path.join(dir, req.url === "/" ? "index.html" : req.url.slice(1));
  let body;
  try {
    body = readFileSync(f);
  } catch {
    res.writeHead(404).end();
    return;
  }
  const types = { ".ttf": "font/ttf", ".jpg": "image/jpeg", ".png": "image/png", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".woff": "font/woff", ".html": "text/html" };
  res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" });
  res.end(body);
}).listen(0);
const port = server.address().port;

const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const debugPort = 9333 + Math.floor(Math.random() * 300);
const flags = (process.env.EDGE_FLAGS ?? "--use-angle=d3d11 --ignore-gpu-blocklist --enable-gpu-rasterization").split(" ").filter(Boolean);
const proc = spawn(edge, ["--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(dir, "profile")}`, ...flags, `http://127.0.0.1:${port}/`], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    target = list.find((t) => t.type === "page" && t.url.includes(`127.0.0.1:${port}`));
  } catch {}
}
if (!target) throw new Error("no page target");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
};
const send = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result;

for (let i = 0; i < 40; i++) {
  const r = await evaluate("typeof window.runStage");
  if (r.result?.value === "function") break;
  await sleep(250);
}
if (process.env.GFX_AT) {
  const [name, t] = process.env.GFX_AT.split("@");
  const r = await evaluate(`window.gfxAt(${JSON.stringify(name)}, ${Number(t)})`);
  for (const row of r.result?.value ?? [r.exceptionDetails]) console.log(JSON.stringify(row));
  ws.close(); proc.kill(); server.close(); process.exit(0);
}
if (process.env.SAMPLE_AT) {
  const [name, t] = process.env.SAMPLE_AT.split("@");
  const r = await evaluate(`window.sampleAt(${JSON.stringify(name)}, ${Number(t)})`);
  console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails, null, 1));
  ws.close(); proc.kill(); server.close(); process.exit(0);
}
const opts = JSON.parse(process.env.STAGE_OPTS ?? "{}");
if (process.env.PROFILE) { await send("Profiler.enable", {}); await send("Profiler.setSamplingInterval", { interval: 200 }); await send("Profiler.start", {}); }
const res = await evaluate(`window.runStage(${JSON.stringify(opts)})`);
if (process.env.PROFILE) {
  const { result } = await send("Profiler.stop", {});
  const prof = result.profile;
  const byId = new Map(prof.nodes.map((n) => [n.id, n]));
  const self = new Map();
  prof.samples.forEach((sid, i) => { const n = byId.get(sid); const k = `${n.callFrame.functionName || "(anon)"} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) || 0) + (prof.timeDeltas[i] || 0)); });
  console.log("-- self time (ms)");
  [...self].sort((a, b) => b[1] - a[1]).slice(0, 22).forEach(([k, t]) => console.log((t / 1000).toFixed(0).padStart(7), k));
}
if (res.exceptionDetails) {
  console.error(JSON.stringify(res.exceptionDetails, null, 1).slice(0, 3000));
} else {
  const out = res.result.value;
  mkdirSync(path.join(dir, "shots"), { recursive: true });
  console.log("GPU:", out.gpu);
  console.log("frames written to", path.join(dir, "shots"));
  for (const [name, v] of Object.entries(out)) {
    if (name === "gpu") continue;
    if (name.endsWith("_sampleMs")) { console.log(`  ${name}: ${v.toFixed(3)} ms/frame`); continue; }
    if (name.endsWith("_slow")) { if (v.length) console.log(`  ${name}:\n    ` + v.join("\n    ")); continue; }
    console.log(`${name}: compile ${v.compileMs.toFixed(1)} ms | prepare ${v.prepareMs.toFixed(1)} ms | ${v.frames} frames | render+finish mean ${v.mean.toFixed(2)} ms p95 ${v.p95.toFixed(2)} max ${v.max.toFixed(2)}`);
    for (const [t, url] of Object.entries(v.shots)) writeFileSync(path.join(dir, "shots", `${name}_${t}.png`), Buffer.from(url.split(",")[1], "base64"));
  }
}
ws.close();
proc.kill();
server.close();
process.exit(0);
