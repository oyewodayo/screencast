// Builds the editor's music library from a sources.json: every track is loudness-normalized and
// encoded to AAC, measured (exact length, a coarse waveform, the "best part" to start from), given a
// short preview clip, and written under a content-addressed name with its size and SHA-256 - what
// the app checks every download against (src-tauri/src/commands/music_library.rs). The output
// folder (catalog.json + tracks/ + previews/) is what gets uploaded to the bucket as-is.
//
//   node scripts/music-library/build-catalog.mjs [--sources music-library/sources.json] [--out music-library/dist]
//
// Unchanged tracks are reused from the previous build (keyed by the source file's hash and these
// settings), so rebuilding after adding one song only encodes that song. See music-library/README.md.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, REPO_ROOT } from "./ffmpeg.mjs";

const SETTINGS_VERSION = 2; // bump to force every track to re-encode
const ANALYSIS_RATE = 8000;
const PEAKS = { music: 160, sfx: 48 };
const PREVIEW_SEC = 30;
const BRIEFCAST_URL = "https://withbriefs.com/briefcast";
const HIGHLIGHT_WINDOW_SEC = 20;
// Licences the app can offer whatever Briefcast's business model turns out to be. NC/ND are out;
// so is anything not listed here until someone has read it.
const LICENSES = {
  "CC0-1.0": { attribution: false },
  "PDM-1.0": { attribution: false },
  "CC-BY-3.0": { attribution: true },
  "CC-BY-4.0": { attribution: true },
  Owned: { attribution: false }, // commissioned / bought outright with redistribution rights
};

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : fallback;
};
const SOURCES = arg("--sources", path.join(REPO_ROOT, "music-library", "sources.json"));
const OUT = arg("--out", path.join(REPO_ROOT, "music-library", "dist"));
const CACHE_PATH = path.join(OUT, ".build-cache.json");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const round = (x, places = 2) => +x.toFixed(places);

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function validate(t, i) {
  const where = `tracks[${i}] (${t.id ?? "no id"})`;
  if (!/^[a-z0-9_-]{1,64}$/.test(t.id ?? "")) fail(`${where}: id must be 1-64 chars of a-z 0-9 - _`);
  if (!t.title?.trim() || !t.artist?.trim()) fail(`${where}: title and artist are required`);
  if (!["music", "sfx"].includes(t.kind ?? "music")) fail(`${where}: kind must be "music" or "sfx"`);
  const lic = LICENSES[t.license?.name];
  if (!lic) fail(`${where}: licence "${t.license?.name}" isn't on the allowed list (${Object.keys(LICENSES).join(", ")})`);
  if (lic.attribution && !t.license.attribution?.trim()) fail(`${where}: ${t.license.name} needs license.attribution - the credit line users will paste`);
  if (t.license.name !== "Owned" && !t.license.sourceUrl && !t.generated) console.warn(`  ! ${where}: no license.sourceUrl - record where it came from`);
  if (t.energy != null && !(t.energy >= 1 && t.energy <= 5)) fail(`${where}: energy must be 1-5`);
  if (!fs.existsSync(path.resolve(t._dir, t.file ?? ""))) fail(`${where}: file not found: ${t.file}`);
}

async function decodeMono(file) {
  const buf = await ffmpeg(["-i", file, "-vn", "-ac", "1", "-ar", String(ANALYSIS_RATE), "-f", "f32le", "pipe:1"]);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

function peaksOf(samples, buckets) {
  const per = Math.max(1, Math.floor(samples.length / buckets));
  const raw = Array.from({ length: buckets }, (_, b) => {
    let max = 0;
    for (let i = b * per, end = Math.min(samples.length, (b + 1) * per); i < end; i++) max = Math.max(max, Math.abs(samples[i]));
    return max;
  });
  const top = Math.max(...raw, 1e-6);
  return raw.map((p) => Math.round((p / top) * 100));
}

// The loudest stretch (RMS over a sliding window), ignoring the very start and end - a fair
// stand-in for "the chorus / the drop" when the curator hasn't marked one.
function findHighlight(samples, duration) {
  const win = Math.min(HIGHLIGHT_WINDOW_SEC, duration * 0.4);
  const block = ANALYSIS_RATE / 2; // 0.5 s
  const energy = [];
  for (let i = 0; i + block <= samples.length; i += block) {
    let e = 0;
    for (let j = i; j < i + block; j++) e += samples[j] * samples[j];
    energy.push(e);
  }
  const n = Math.max(1, Math.round(win * 2));
  const from = Math.floor(duration * 0.05 * 2);
  const to = Math.max(from, Math.floor((duration * 0.9 - win) * 2));
  let best = from;
  let bestE = -1;
  for (let s = from; s <= to && s + n <= energy.length; s++) {
    let e = 0;
    for (let k = s; k < s + n; k++) e += energy[k];
    if (e > bestE) [best, bestE] = [s, e];
  }
  return round(best / 2, 1);
}

// Writes `tmp` to dir/<id>-<sha16>.m4a and returns its catalog asset entry.
function place(tmp, folder, id) {
  const hash = sha256(tmp);
  const name = `${id}-${hash.slice(0, 16)}.m4a`;
  fs.mkdirSync(path.join(OUT, folder), { recursive: true });
  fs.renameSync(tmp, path.join(OUT, folder, name));
  return { url: `${folder}/${name}`, size: fs.statSync(path.join(OUT, folder, name)).size, sha256: hash };
}

async function buildTrack(t) {
  const kind = t.kind ?? "music";
  const src = path.resolve(t._dir, t.file);
  const tmp = path.join(OUT, `.${t.id}.tmp.m4a`);
  // Music is normalized to -16 LUFS so every song sits at the same level under a video; effects are
  // too short for loudnorm to measure, so they're only peak-limited.
  const filter = kind === "music" ? "loudnorm=I=-16:TP=-1.5:LRA=11" : "alimiter=limit=0.95";
  // Every file says where it came from - in any player, file browser or editor it's opened in.
  const library = t.generated ? "Briefcast Originals" : "Briefcast Music Library";
  const credit = t.license.attribution ? ` Credit: ${t.license.attribution}.` : "";
  const metadata = [
    ["title", t.title], ["artist", t.artist], ["album_artist", "Briefcast"], ["album", library], ["genre", t.genre ?? (kind === "sfx" ? "Sound effect" : "")],
    ["copyright", `${t.license.name}${t.generated ? " - Briefcast" : ""}`],
    ["comment", `From the ${library} - free music and sound effects in the Briefcast video editor: ${BRIEFCAST_URL} (licence ${t.license.name}).${credit}`],
  ].flatMap(([k, v]) => (v ? ["-metadata", `${k}=${v}`] : []));
  await ffmpeg(["-i", src, "-vn", "-map_metadata", "-1", ...metadata, "-af", filter, "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", kind === "music" ? "160k" : "128k", "-movflags", "+faststart", tmp]);

  const samples = await decodeMono(tmp);
  const duration = round(samples.length / ANALYSIS_RATE, 3);
  const highlightStart = kind === "music" ? (t.highlightStart != null ? Math.min(t.highlightStart, duration - 1) : findHighlight(samples, duration)) : undefined;
  const file = place(tmp, "tracks", t.id);

  let preview;
  if (kind === "music" && duration > PREVIEW_SEC + 5) {
    const start = Math.min(highlightStart, duration - PREVIEW_SEC);
    const ptmp = path.join(OUT, `.${t.id}.preview.tmp.m4a`);
    await ffmpeg(["-ss", String(start), "-t", String(PREVIEW_SEC), "-i", path.join(OUT, file.url), "-af", `afade=t=in:d=0.3,afade=t=out:st=${PREVIEW_SEC - 1.5}:d=1.5`, "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", ptmp]);
    preview = { ...place(ptmp, "previews", t.id), start: round(start, 2) };
  }

  let beats;
  if (t.bpm && t.firstBeat != null) {
    const step = 60 / t.bpm;
    beats = [];
    for (let b = t.firstBeat; b <= duration; b += step) beats.push(round(b, 3));
  }

  return {
    id: t.id, title: t.title.trim(), artist: t.artist.trim(), kind,
    ...(t.genre ? { genre: t.genre } : {}),
    moods: t.moods ?? [], tags: t.tags ?? [],
    ...(t.energy ? { energy: t.energy } : {}),
    duration,
    ...(t.bpm ? { bpm: t.bpm } : {}),
    ...(beats ? { beats } : {}),
    ...(highlightStart != null ? { highlightStart } : {}),
    peaks: peaksOf(samples, PEAKS[kind]),
    file,
    ...(preview ? { preview } : {}),
    license: { name: t.license.name, ...(t.license.url ? { url: t.license.url } : {}), ...(t.license.attribution ? { attribution: t.license.attribution } : {}), ...(t.license.sourceUrl ? { sourceUrl: t.license.sourceUrl } : {}) },
  };
}

// A sources file lists its own tracks and may `include` other sources files (paths relative to it) -
// how the generated Briefcast Originals join the hand-picked tracks in one library.
function loadSources(file) {
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = path.dirname(file);
  const included = (json.include ?? []).flatMap((rel) => {
    const p = path.resolve(dir, rel);
    if (!fs.existsSync(p)) fail(`Included sources not found: ${rel} - for the Originals, run npm run music:originals first`);
    return loadSources(p);
  });
  return [...included, ...(json.tracks ?? []).map((t) => ({ ...t, _dir: dir }))];
}

if (!fs.existsSync(SOURCES)) fail(`No sources file at ${SOURCES}`);
const sources = loadSources(SOURCES);
sources.forEach(validate);
const dupes = sources.map((t) => t.id).filter((id, i, all) => all.indexOf(id) !== i);
if (dupes.length) fail(`Duplicate ids: ${[...new Set(dupes)].join(", ")}`);

fs.mkdirSync(OUT, { recursive: true });
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
} catch {}

const out = [];
const nextCache = {};
for (const t of sources) {
  const key = crypto.createHash("sha256").update(JSON.stringify({ v: SETTINGS_VERSION, src: sha256(path.resolve(t._dir, t.file)), meta: { ...t, _dir: undefined } })).digest("hex");
  const hit = cache[t.id];
  const reusable = hit?.key === key && [hit.entry.file, hit.entry.preview].every((a) => !a || fs.existsSync(path.join(OUT, a.url)));
  const entry = reusable ? hit.entry : await buildTrack(t);
  console.log(`  ${reusable ? "·" : "✓"} ${t.id} (${entry.duration}s${entry.highlightStart != null ? `, best part at ${entry.highlightStart}s` : ""})`);
  out.push(entry);
  nextCache[t.id] = { key, entry };
}

// Drop files no track points at any more (replaced or removed tracks).
const keep = new Set(out.flatMap((e) => [e.file.url, e.preview?.url].filter(Boolean)));
for (const folder of ["tracks", "previews"]) {
  const dir = path.join(OUT, folder);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) if (!keep.has(`${folder}/${f}`)) fs.rmSync(path.join(dir, f));
}

fs.writeFileSync(path.join(OUT, "catalog.json"), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), tracks: out }));
fs.writeFileSync(CACHE_PATH, JSON.stringify(nextCache));
const bytes = [...keep].reduce((n, u) => n + fs.statSync(path.join(OUT, u)).size, 0);
console.log(`\nLibrary: ${out.length} tracks, ${(bytes / 1e6).toFixed(1)} MB -> ${path.relative(REPO_ROOT, OUT)}`);
