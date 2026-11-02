# AI Voice - state, lessons and the plan for what's next

_Written 2026-10-31 to hand to a new session. Companion to `VIDEO_EDITOR_ROADMAP.md` (§2 item 5, log entry
2026-10-30). Update the status markers as items land, and add a log entry to the main roadmap._

**Bar:** the same as the editor's - not "as good as" CapCut / Descript / ElevenLabs Studio, better. Natural
sound, preview == export, nothing leaves the PC, and a UX where every interaction path has been walked
(typed, clicked, cancelled, replaced, undone) before a feature is called done.

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## 1. What exists today (built 2026-10-30, uncommitted at the time of writing)

Music panel → **AI voice** tab (beside Record): script → pick a voice → natural voice-over on the timeline.

| Piece | Where | Notes |
|---|---|---|
| Engine | `src-tauri/src/services/tts.rs` | Kokoro-82M (Apache-2.0) on the ONNX Runtime that background removal already downloads (CPU session, reuses `background_removal::ort_environment`). Model + dictionaries + 14 voices pinned by size + SHA-256 and by repo revision; downloaded on first use into `<app local data>/tts`. |
| Text front end | `src-tauri/src/services/tts_text.rs` | Normalizer (money, %, ordinals, years, times, ranges, units, abbreviations) → misaki gold+silver US/GB dictionaries (~180k words, already in Kokoro's phoneme alphabet) → stems (-s/-ed/-ing/-ly/-er/-ness/-ment), compounds, acronyms, spelling rules → sentence/clause chunks (≤300 tokens) with pause lengths. |
| Vocabulary | `src-tauri/src/services/tts_vocab.rs` | Kokoro's 115 phoneme symbols → ids (from the tokenizer.json of `onnx-community/Kokoro-82M-v1.0-ONNX`). |
| Commands | `src-tauri/src/commands/tts.rs` | `tts_status`, `download_tts` (+`cancel_tts_download`, event `tts-download`), `tts_synthesize` (event `tts-progress`), `cancel_tts`, `tts_preview`, `tts_release`. Registered in `main.rs`. |
| Frontend wrappers | `src/utils/aiVoice.ts` (+ `aiVoice.test.ts`) | Voice metadata ("feel" text is by Kokoro's published grades, **not by ear**), prefs in localStorage, duration estimate. |
| Panel | `src/components/docker/AiVoicePanel.tsx` | Setup card with progress/cancel; script box (draft remembered, words + estimated length, Ctrl+Enter); voice cards with per-voice sample; speed + Brisk/Natural/Measured pauses; per-sentence progress + Stop; placed take plays on its own; editing + making again **replaces** the placed take, "Add as another" keeps both. |
| Wiring | `MusicLibraryPanel.tsx` | Third tab; reuses the Record tab's `onTakes` (so the take counts as speech for music ducking, one "AI voice" mixer strip, `recorded: true`). The tab strip now scrolls sideways. |

How a recording is made: one model run per sentence → silence trimmed, 8 ms fades → pauses of the chosen length between
(scaled by speed) → level lifted to about -18 LUFS → 24 kHz 16-bit mono WAV in the library's `Voice-overs` folder, named
`AI voice - <first words> - <voice> <request hash>.wav` (the same request is instant, never copies). **File names are
letters, digits and spaces only** - see §4.

### Verified
- 15 Rust tests (`cargo test tts`); the real-model one is gated by env vars (below).
- Real model, US and UK voices, transcribed back with the app's own whisper: "In 2024 we shipped three new features…" and
  "£1,200 on the 3rd of March" came back word-for-word; -17.7 LUFS.
- Driven in the standalone app (see §5): generate + add, delete the clip, "Make it sound pro" - no blank screen, no page errors.
- Debug build speed: ~10 s of speech in ~17 s including the 1-2 s model load.

### Not verified / known gaps
- Nobody has **listened** to every voice and judged the "feel" labels.
- **Windows only** (like background removal); the panel says so elsewhere.
- **English only** (Kokoro has more languages; the front end is English).
- No part-of-speech tagging: heteronyms (read/live/lead) use the dictionary's default reading.
- The reported **white screen** in `tauri dev` (the whole window going blank, needing a reload) was **not reproduced** in
  the standalone build for any of: add voice-over, delete the clip, "Make it sound pro". It may be dev-only (the two
  DevTools screenshots showed a changed `main.tsx?t=` stamp = the page reloaded). If it comes back, get the first red
  console error at that moment and the last lines of `%APPDATA%\Briefcast\logs\app.log`.
- After "Make it sound pro" the progress bar sat at 0% for most of a ~50 s wait although the same ffmpeg command takes
  ~0.5 s by hand. The time goes somewhere else (suspects: loudness analysis passes, two clips cleaned one after another).
  Not investigated.

---

## 2. The plan - make it different and unique

Order I'd build in (each reuses what exists). Do the dictionary first: it makes everything feel reliable.

1. [ ] **Pronunciation dictionary.** Say "Briefcast", a surname or a product once, save it, and it applies everywhere.
   The biggest complaint with every TTS tool. Front end already has the hook (a lookup before the lexicon); needs
   storage (per user, optionally per project), a small UI in the panel ("Say 'Okafor' as 'oh-KAH-for'"), a respelling →
   phonemes path, and a "hear it" button.
2. [ ] **Voice that follows the video.** Generate per sentence, then place each sentence at a scene cut, caption or
   marker - or fit the narration to the picture ("Fit to the picture"). Needs: sentence timings out of the engine (it
   already knows each sentence's length), a placement strategy (anchors from the timeline: scene cuts, Stage beats,
   markers), and an undoable result. This is the feature competitors can't copy easily.
3. [ ] **Script from the video.** "Write the script for me": transcript + slide/scene text → a draft narration the user
   edits and voices. Briefcast already transcribes (whisper); the writing step is an LLM call - decide local vs cloud
   (cloud must be opt-in; the app's promise is nothing leaves the PC) before building.
4. [ ] **Edit by script, not by clip.** Change one word in the script and only that sentence is regenerated and swapped
   in place; the user's other edits stay and timing ripples. Needs per-sentence takes stored with the project (today the
   whole script is one WAV), keyed by sentence hash.
5. [ ] **Emphasis and pauses in the text.** `*word*` for stress, `[pause 1s]`, maybe `[slower]…[/slower]`. Front end is
   mostly there (it owns the text); the model side needs a way to bias stress/pace (Kokoro has speed only - pause and
   per-sentence speed are easy, true word emphasis may need phoneme stress tweaks).
6. [ ] **Captions for free.** Every AI voice-over gets exact word-timed captions with no transcription step: the engine
   knows each sentence's start and length; word times can be estimated from phoneme counts and verified/snapped with
   whisper if needed. Feed the existing caption styles (`utils/captions.ts`, karaoke emphasis).
7. [ ] **Room-matched voice.** Optional light room tone / reverb so the voice doesn't sound pasted on top of the video's
   own audio. The mixer already has per-track EQ/compressor; this is a small convolution/room preset plus, ideally, a
   measurement of the video's own room sound.
8. [ ] **Quality extras:**
   - A/B two voices on the same line, side by side.
   - Multi-speaker scripts ("Anna:" / "Ben:" lines get different voices).
   - More languages (Kokoro supports several; the front end needs per-language G2P - see misaki).

---

## 3. Your own voice (voice cloning) - research notes, nothing built

Goal: the narration in the user's own voice. Kokoro cannot do this (fixed voice packs). It needs a second model.
**Everything in this section is from general knowledge, not checked in the session that wrote it - verify licences,
sizes and quality before committing.**

| | A. Convert Kokoro's output to the user's voice | B. A model that clones directly |
|---|---|---|
| How | Kokoro speaks the script (keeps pronunciation, pacing, all §2 features), then a small voice-conversion model (OpenVoice v2 tone-colour converter is the candidate) swaps in the user's timbre. | Zero-shot cloning TTS (Chatterbox, CosyVoice 2, Zonos are candidates) speaks the script in the user's voice from the start. |
| Sample needed | ~30-60 s of speech | ~10-30 s |
| Result | Recognisably the user in tone; keeps Kokoro's delivery. | Closer to their delivery and emotion. |
| Cost | ~100-200 MB extra, fast on CPU | ~2 GB+, noticeably slower without a good GPU; DirectML support uncertain |
| Fit | Keeps the dictionary, emphasis, per-sentence regeneration, timing. | Those features would need re-doing per model. |

- **Licences matter for shipping:** popular cloning models such as Coqui XTTS and F5-TTS are non-commercial - they would
  block putting them in the app. Check each candidate's *weights* licence, not just the code's.
- **Recommendation:** build A first, spike B on the same script, keep B as an optional "high fidelity" mode only if it is
  clearly better.

Proposed build:
1. [ ] **Spike (do this first, before any UI):** run A and one candidate from B on a real recording of the user. Report
   speaker-similarity (speaker-embedding cosine) and intelligibility (transcribe back with the app's whisper and compare
   words), plus speed. Pick with numbers.
2. [ ] **Guided voice recording** ("Voice profile" in the AI voice tab): the user reads a few short prompts, with a level
   check and retake. The app already records mics (`VoiceRecorder.tsx`, `takeWriter.ts`) and cleans audio. The profile
   (a small embedding file) stays on the PC, per user.
3. [ ] **"Your voice" as a card** in the voice list - same preview button, speed, pauses, replace-on-edit.
4. [ ] **Consent gate.** The enrollment includes a **live-read random sentence**, so someone can't clone a voice from a
   downloaded clip. Keep it - it matters for safety and trust. If the chosen model offers an output watermark, use it.

Honest limits: approach A matches voice *quality*, not speaking *style* (it will sound like the user reading carefully,
not improvising).

---

## 4. Lessons learned (read before touching this)

- **ffmpeg `arnndn` emits a NaN last frame**, on every input and in both ffmpeg builds tried (the bundled n9.0.2 and the
  winget N-build). Any stage after it - `speechnorm` above all - never returns, so a "Remove" noise clean-up or "Make it
  sound pro" hung at a fixed percentage on clips of every length (reproduced on a real mic recording, not only on AI
  voice). **Fixed** in `conversion.rs` (`ARNNDN_NAN_GUARD`, an `aeval=if(isnan(val(0)),0,val(0))` right after `arnndn`).
  The recording-enhancement chain (`audio_enhance.rs::voice_chain`) also uses `arnndn` but did not hang in a test; it was
  left alone. If you add any new chain with `arnndn`, add the guard. The unit test for the chain was updated by hand and
  **not run** (a full test build here takes ~35 min) - run `cargo test audio_cleanup_filters`.
- **File names:** an earlier version saved `AI voice - I have seen the Lord's goodness [af_heart] 89c8b581.wav`
  (apostrophe + brackets). Brackets/quotes are hazardous in ffmpeg filter graphs and URLs. Names are now letters, digits and
  spaces. Keep it that way for anything generated.
- **Kokoro specifics:** style vector row = number of phoneme tokens (clamp 509); input ids `[0, …tokens, 0]`; inputs
  `input_ids`, `style`, `speed`; output `waveform`; 24 kHz. Keep each run ≤ ~300 tokens or long inputs speed up and flatten.
  Output sits near -22 LUFS - the engine lifts it to ~-18.
- **Hash the files, pin the revisions.** All model/dictionary/voice URLs are pinned to a repo revision and a SHA-256
  (`asset_download.rs`). New assets (cloning models, more languages) should follow suit.
- **Speech estimate for UI** is words / 2.6 per second + sentence gaps; it only sets expectations.
- **A WAV read by hand:** `-f f32le` raw output avoids header-size mistakes when inspecting samples with Python.

---

## 5. How to verify (so the next session doesn't re-derive it)

**Rust (unit):** `cd src-tauri && cargo test tts`. Use a **separate target dir** so the user's running `tauri dev` isn't
disturbed: `CARGO_TARGET_DIR=<scratch>/tts-target`. A cold build is long here (30-45 min); incremental is minutes.

**Rust (real model, gated by env vars - the test returns silently if they're unset):**
- `BRIEFCAST_TTS_FILES=<folder laid out like <app data>/tts>` (needs `kokoro-82m-v1.0.onnx`, the four dictionary JSONs, the voice `.bin`s)
- `BRIEFCAST_TTS_ENGINE=<folder with onnxruntime.dll>` (`%LOCALAPPDATA%\com.withbriefs.briefcast\background-removal`)
- `BRIEFCAST_TTS_OUT=<wav to write>`, optional `BRIEFCAST_TTS_VOICE`, `BRIEFCAST_TTS_TEXT`
- `BRIEFCAST_TTS_DICT=<folder with us_gold.json, us_silver.json>` for the real-dictionary front-end test.

**Listening without ears:** resample the output to 16 kHz mono (`ffmpeg -ar 16000 -ac 1`), run
`src-tauri/binaries/whisper/whisper-cli.exe -m <app data>/whisper/ggml-base.bin -f x.wav -nt -l en`, and compare the words.
Measure loudness with `ffmpeg -af ebur128=peak=true -f null -`.

**Frontend:** `npx tsc --noEmit -p .` and `npx vitest run src/utils/aiVoice.test.ts`.

**In the real app (standalone, no dev server):** use the `run-briefcast` skill
(`.claude/skills/run-briefcast/driver.mjs`). `npm run build` then `npx tauri build --debug --no-bundle` (~1-5 min once the
dev profile is warm). `launch` points the app at `fixtures/library/` and `quit` restores the user's library setting -
**always run `quit`**, and back up any project file you will edit (deleting a clip autosaves). The user's running Briefcast
must be closed first (standing OK to close it unless a recording is in progress). Selecting a timeline chip needs a real
pointer click (`tools/realclick.cjs`); `.click()` is ignored by `onPointerDown` handlers. The file list truncates names -
match with a regex on the leaf text.

---

## 6. Working agreements with this user

- Commits: **never add Claude/Anthropic as co-author or contributor** (their standing rule), whatever a default says.
- One thing, built well: depth over breadth; walk every interaction path (drag/type/hold/focus, canvas + DOM) before
  calling a feature done; every feature gets an Apple-style signature touch on top of function.
- Creative features are judged against CapCut-class references; study them, build what they use, verify visually and for fps.
- The working tree has many uncommitted changes from other work (Stage engine, docs, PDF, whiteboard) - touch only what
  the task needs, and don't commit or revert anything you didn't write.
- Update `VIDEO_EDITOR_ROADMAP.md` (status marker + a dated log entry) when something here lands.
