// Renders the Briefcast Originals - songs (songs.mjs, afro-songs.mjs, and the jazz set in
// jazz-songs.mjs, played by jazz.mjs) and sound effects, composed and mixed entirely in code
// (scripts/music-library/synth), so they're ours outright and published as CC0 - into
// music-library/originals/, plus the sources.json build-catalog.mjs reads.
//
//   node scripts/music-library/make-originals.mjs              everything
//   node scripts/music-library/make-originals.mjs --only id,id  just these (others keep their files)
//   node scripts/music-library/make-originals.mjs --sfx         just the sound effects (seconds, not minutes)
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, REPO_ROOT } from "./ffmpeg.mjs";
import { activeRmsDb, peakOf, SR, wavBytes } from "./synth/dsp.mjs";
import { renderSong } from "./synth/compose.mjs";
import { renderJazz } from "./synth/jazz.mjs";
import { SONGS } from "./synth/songs.mjs";
import { JAZZ_SONGS } from "./synth/jazz-songs.mjs";
import { AFRO_SONGS } from "./synth/afro-songs.mjs";
import { SFX } from "./synth/sfx.mjs";
import { MORE_SFX } from "./synth/sfx-more.mjs";
import { JAZZ_SFX } from "./synth/sfx-jazz.mjs";
import { AFRO_SFX } from "./synth/sfx-afro.mjs";

const OUT = path.join(REPO_ROOT, "music-library", "originals");
const AUDIO = path.join(OUT, "audio");
const LICENSE = { name: "CC0-1.0", url: "https://creativecommons.org/publicdomain/zero/1.0/" };
const ARTIST = "Briefcast Originals";

const onlyArg = process.argv.indexOf("--only");
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;
const sfxOnly = process.argv.includes("--sfx");
const wanted = (id) => (sfxOnly ? id.startsWith("sfx-") : !only || only.has(id));

// Sound-effect categories - shown as the filter chips on the panel's Sound effects tab.
const FIRST_WAVE_CATEGORY = {
  "sfx-whoosh": "transitions", "sfx-whoosh-fast": "transitions", "sfx-swoosh-up": "transitions", "sfx-swoosh-down": "transitions", "sfx-swipe": "transitions",
  "sfx-riser": "transitions", "sfx-downlifter": "transitions", "sfx-whoosh-hit": "transitions", "sfx-glitch": "transitions",
  "sfx-pop": "interface", "sfx-bubble": "interface", "sfx-click": "interface", "sfx-mouse-click": "interface", "sfx-typing": "interface", "sfx-shutter": "interface", "sfx-error": "interface",
  "sfx-ding": "notifications", "sfx-success": "notifications", "sfx-notification": "notifications",
  "sfx-coin": "creator", "sfx-sparkle": "creator", "sfx-impact": "cinematic", "sfx-tick-tock": "cinematic",
};
const ALL_SFX = [...SFX.map((fx) => ({ ...fx, category: FIRST_WAVE_CATEGORY[fx.id] ?? "interface" })), ...MORE_SFX, ...JAZZ_SFX, ...AFRO_SFX];

fs.mkdirSync(AUDIO, { recursive: true });

async function save(id, buffer) {
  const wav = path.join(AUDIO, `${id}.wav`);
  fs.writeFileSync(wav, wavBytes(buffer));
  await ffmpeg(["-i", wav, "-c:a", "flac", "-sample_fmt", "s32", path.join(AUDIO, `${id}.flac`)]);
  fs.rmSync(wav);
}

const tracks = [];
const ALL_SONGS = [...SONGS, ...AFRO_SONGS, ...JAZZ_SONGS];
for (const song of ALL_SONGS) {
  const entry = {
    id: song.id, title: song.title, artist: ARTIST, kind: "music", genre: song.genre, moods: song.moods, tags: song.tags, energy: song.energy,
    file: `audio/${song.id}.flac`, bpm: song.bpm, firstBeat: 0, license: LICENSE, generated: true,
  };
  if (wanted(song.id)) {
    const t0 = Date.now();
    const { buffer, highlightStart, duration, firstBeat = 0 } = song.engine === "jazz" ? renderJazz(song) : renderSong(song);
    const peak = peakOf(buffer);
    const loud = activeRmsDb(buffer);
    if (!Number.isFinite(loud) || !(peak > 0.1) || peak > 1) throw new Error(`${song.id}: bad render (peak ${peak}, level ${loud})`);
    await save(song.id, buffer);
    entry.highlightStart = highlightStart;
    entry.firstBeat = firstBeat;
    console.log(`  ♪ ${song.title.padEnd(18)} ${song.genre.padEnd(16)} ${Math.floor(duration / 60)}:${String(Math.round(duration % 60)).padStart(2, "0")}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  tracks.push(entry);
}

for (const fx of ALL_SFX) {
  if (wanted(fx.id)) {
    const buffer = fx.make();
    if (!(peakOf(buffer) > 0.1)) throw new Error(`${fx.id}: silent render`);
    await save(fx.id, buffer);
    console.log(`  ◆ ${fx.title.padEnd(18)} ${(buffer.length / SR).toFixed(2)}s`);
  }
  tracks.push({ id: fx.id, title: fx.title, artist: ARTIST, kind: "sfx", genre: "Sound effect", moods: [fx.category], tags: fx.tags, file: `audio/${fx.id}.flac`, license: LICENSE, generated: true });
}

// Keep highlight points from a previous full run for songs not re-rendered this time.
const sourcesPath = path.join(OUT, "sources.json");
if ((only || sfxOnly) && fs.existsSync(sourcesPath)) {
  const prev = new Map(JSON.parse(fs.readFileSync(sourcesPath, "utf8")).tracks.map((t) => [t.id, t]));
  for (const t of tracks) {
    const p = prev.get(t.id);
    if (t.highlightStart == null && p?.highlightStart != null) t.highlightStart = p.highlightStart;
    if (t.kind === "music" && !wanted(t.id) && p?.firstBeat != null) t.firstBeat = p.firstBeat;
  }
}
fs.writeFileSync(sourcesPath, JSON.stringify({ tracks }, null, 2) + "\n");
console.log(`\nBriefcast Originals: ${ALL_SONGS.length} songs, ${ALL_SFX.length} effects -> ${path.relative(REPO_ROOT, OUT)}`);
