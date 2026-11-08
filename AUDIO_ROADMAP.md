# Audio roadmap

Mixing features that were proposed, then deliberately postponed. Most first-time users aren't
sound engineers: they record, add music and export. These would impress engineers but rarely a
first-time user, so they wait until engineers ask for them.

## Done

- **Volume automation:** a volume line drawn on the waveform, sounding the same in preview and
  export.
- **Master bus:** a true-peak limiter, EBU R128 loudness meters and loudness targets on export.
- **Playback bleed removal:** native, for takes of any length.
- **Long-file support:** streamed peaks, ranges and writers; segmented processing; a 100-hour
  audio-only canvas; a viewport-driven filmstrip.
- **Automatic joins (`audioJoins.ts`):** an equal-power crossfade where pieces of one track
  overlap, an 8 ms click-proof fade where a piece is cut mid-sound, and nothing on seamless splits.
  The same fades are used in preview, the mixer's play, Save as and export.
- **Ducking you can see:** a shaded dip on the music track (`DuckShade.tsx`) and a live ducking
  meter on its mixer strip.
- **"Make it sound pro" (`soundPro.ts`, `SoundProPopover.tsx`):** one click cleans and levels the
  voice, ducks the music, turns on the limiter and sets the loudness for YouTube, a podcast or
  broadcast. It's one undo step, with a Before/After switch.

## Later

### Parametric EQ with a live spectrum

Replaces the fixed 3-band EQ (low/mid/high) with draggable bands (bell, shelf, high/low-pass) drawn
over a live spectrum.

- **Why it waits:** experts use it, and beginners avoid EQ entirely. For beginners, "Make it sound
  pro" and voice presets do the job.
- **Notes:** the track FX run in the `track-fx-processor` worklet and export through
  `audio_fx_filters` (Rust). Each new band type needs a matching ffmpeg filter (`equalizer`,
  `highshelf`, `lowshelf`, `highpass`, `lowpass`) so preview and export still match sample for
  sample.

### Shared reverb send

One reverb on the mix (room/plate/hall), with a send level on each track.

- **Why it waits:** rarely wanted for spoken voice, and easy to make a mix sound worse.
- **Notes:** a convolution or algorithmic reverb in the master graph (`mixerGraph.ts`). In export
  it needs an `asplit` per track into one reverb (`afir` with a bundled impulse response, or
  `aecho` chains), mixed back before the master limiter.

### Clip gain

A single trim (dB) for a whole piece, independent of its volume line and fader.

- **Why it waits:** dragging the volume line covers most of it. Add it when people ask for
  "normalize this piece" or batch trims.

### Ideas noted along the way

- Voice presets ("Podcast", "Warm", "Clear"): one click, built on the existing EQ and compressor.
- Loudness match between pieces: every take at the same perceived level, measured with R128.
