# Music library

The free music & sound effects behind the editor's **Music** button (`MusicLibraryPanel.tsx`).
This folder holds the catalog *source*. The built library is a static folder (`dist/`) that goes
up to a bucket, and the app reads it from there (`src-tauri/src/commands/music_library.rs`).

```
music-library/
  sources.json   # what's in the library (you edit this); includes originals/sources.json
  audio/         # files for hand-picked tracks (gitignored, keep a backup)
  originals/     # Briefcast Originals, rendered from code (gitignored): npm run music:originals
  dist/          # build output (gitignored): catalog.json + tracks/ + previews/
```

## Build it

```
npm run music:originals   # render the Briefcast Originals (~6 min), only when the synth changes
npm run music:build       # encode + measure everything into dist/
```

The **Briefcast Originals** are 16 songs and 69 sound effects composed and mixed entirely in code
(`scripts/music-library/synth/`: instruments, drum kits, a composer and a mix engine). They're
ours outright and published as CC0. To change a song, edit its entry in `synth/songs.mjs`, then run
`node scripts/music-library/make-originals.mjs --only <id>` and `npm run music:build`.

Debug builds load `music-library/dist/catalog.json` automatically. Open a video, click the
music-notes button, and the library is there.

## Adding a track

1. **Check the licence.** Only these are accepted, because they allow commercial use and
   editing, however Briefcast ends up being sold:
   `CC0-1.0`, `PDM-1.0`, `CC-BY-3.0`, `CC-BY-4.0`, `Owned` (commissioned, or bought with
   redistribution rights). **Never NC or ND.** Also check the site's own terms: some "free music"
   sites allow use in *your* video but not repackaging their files into another app's library.
2. Put the file in `audio/` and add an entry to `sources.json`:

```json
{
  "tracks": [
    {
      "id": "sunrise-walk",
      "title": "Sunrise Walk",
      "artist": "Jane Doe",
      "kind": "music",
      "genre": "Acoustic",
      "moods": ["happy", "warm"],
      "tags": ["vlog", "travel"],
      "energy": 3,
      "file": "audio/sunrise-walk.mp3",
      "highlightStart": 42.5,
      "bpm": 96, "firstBeat": 0.31,
      "license": {
        "name": "CC-BY-4.0",
        "url": "https://creativecommons.org/licenses/by/4.0/",
        "attribution": "\"Sunrise Walk\" by Jane Doe (janedoe.com), licensed under CC BY 4.0",
        "sourceUrl": "https://where-you-got-it.example/sunrise-walk"
      }
    }
  ]
}
```

- `kind`: `music` or `sfx`. `energy`: 1 (calm, sits under a voice) to 5 (driving). This
  drives "Suggested for this video".
- `highlightStart` (optional): where the best part starts. If you leave it out, the loudest
  20 s is used. Songs open there in the editor, and the 30 s preview is cut from there.
- `bpm` + `firstBeat` (optional): gives an exact beat grid. Without them, the app detects
  beats itself when a song is added.
- `attribution` is required for CC-BY. Users get it as a ready-to-paste credit line.
- Keep `sourceUrl` filled in. It's your record of where the track came from.

3. `npm run music:build`. Only new or changed tracks are re-encoded. Every song is
   normalized to −16 LUFS, so the whole library sits at one level.

## Publishing (Cloudflare R2)

Upload `dist/` as-is, for example `rclone sync music-library/dist r2:<bucket>/briefcast/music/v1`.

- Track and preview file names contain their content hash, so serve `tracks/*` and `previews/*`
  with `Cache-Control: public, max-age=31536000, immutable`.
- Serve `catalog.json` with a short cache (`max-age=300`). The app revalidates it with ETags
  at most every 6 hours.
- Use a custom domain, not `r2.dev`, which is rate-limited.

Release builds read `https://media.withbriefs.com/briefcast/music/v1/catalog.json`. You can change
this at build time with `BRIEFCAST_MUSIC_CATALOG_URL`, or at run time with
`BRIEFCAST_MUSIC_CATALOG` (a URL or a local path), which is handy for testing a new catalog
against an installed app. Until that URL is live, release builds show "music library
unavailable", and "Use a file from your computer" still works.
