// The Briefcast Originals: 16 songs across the moods people cut videos to. Each is data for
// compose.mjs - key, tempo, progressions, structure, and the layers that play in each section.
//
// Pattern strings are one bar of 16ths (or two bars, 32 chars). Chords: x accent, o soft, - hold,
// . rest. Bass: R root, O octave, F fifth, T third, A chromatic approach to the next chord, - hold.

const PAD = { voices: 5, detuneCents: 14, attack: 0.9, decay: 1.5, sustain: 0.85, release: 1.6, width: 0.8 };
const STRINGS = { voices: 3, detuneCents: 8, attack: 0.4, decay: 1, sustain: 0.9, release: 0.9, vibrato: 0.0045, width: 0.6 };
const SYNTH_BASS = { wave: "saw", cutoff: 240, envAmt: 900, filterDecay: 0.18, sub: 0.7, drive: 1.6, release: 0.06 };
const ROUND_BASS = { wave: "saw", cutoff: 180, envAmt: 500, filterDecay: 0.2, sub: 0.9, drive: 1.2, release: 0.08, decay: 0.6, sustain: 0.6 };
const PLUCK_SYNTH = { wave: "saw", cutoff: 600, envAmt: 4200, filterDecay: 0.12, decay: 0.25, sustain: 0.15, release: 0.12, detuneCents: 9 };
const ARP_SYNTH = { wave: "saw", cutoff: 800, envAmt: 3200, filterDecay: 0.1, decay: 0.15, sustain: 0.25, release: 0.08 };
const GUITAR = { bright: 0.55, sustain: 2.4, pickPos: 0.2 };
const UKULELE = { bright: 0.72, sustain: 1.1, pickPos: 0.27 };

export const SONGS = [
  {
    id: "golden-hour", title: "Golden Hour", genre: "Lo-fi", moods: ["chill", "warm"], tags: ["study", "vlog", "background"], energy: 2,
    bpm: 82, key: 62, scale: "major", chordSize: 4, swing: 0.22,
    progressions: { A: [2, 5, 1, 6], B: [4, 3, 2, 5] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 4, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "epiano", style: "comp", in: ["intro", "verse", "chorus", "break", "outro"], pattern: "x------.--x-----", range: [55, 71], reverb: 0.25, vel: 0.75 },
      { role: "bass", inst: "subtractive", opts: ROUND_BASS, style: "bass", in: ["verse", "chorus", "outro"], pattern: "R-------.R--F--A", range: [38], vel: 0.8 },
      { role: "lead", inst: "mallet", opts: { kind: "vibes" }, style: "melody", in: ["chorus"], range: [69, 86], density: 0.38, reverb: 0.35, delay: 0.2 },
      { role: "pad", inst: "warmPad", style: "sustain", in: ["break", "chorus"], range: [57, 74], level: -2, reverb: 0.4 },
    ],
    drums: { kit: "lofi", sections: { verse: "lofi", chorus: "lofi", outro: "lofiLight" } },
    mix: { lofi: true, introFilter: true, reverb: { room: 0.7, damp: 0.5 } },
  },
  {
    id: "rainy-window", title: "Rainy Window", genre: "Lo-fi", moods: ["mellow", "calm"], tags: ["study", "podcast", "background"], energy: 1,
    bpm: 72, key: 57, scale: "dorian", chordSize: 5, swing: 0.18,
    progressions: { A: [1, 4, 7, 3], B: [6, 7, 1, 1] },
    sections: [["intro", 2, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 4, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "piano", opts: { bright: 0.55 }, style: "comp", in: ["intro", "verse", "chorus", "break", "outro"], pattern: "x-------o-------", range: [57, 74], reverb: 0.35, vel: 0.65 },
      { role: "bass", inst: "subtractive", opts: ROUND_BASS, style: "bass", in: ["verse", "chorus"], pattern: "R--------R----A-", range: [36], vel: 0.75 },
      { role: "counter", inst: "epiano", style: "melody", in: ["chorus", "break"], range: [69, 84], density: 0.28, reverb: 0.35, delay: 0.25, vel: 0.7 },
    ],
    drums: { kit: "lofi", sections: { verse: "lofiLight", chorus: "lofi", outro: "lofiLight" } },
    mix: { lofi: true, introFilter: true, reverb: { room: 0.75, damp: 0.5 } },
  },
  {
    id: "bright-ideas", title: "Bright Ideas", genre: "Corporate", moods: ["happy", "inspiring"], tags: ["explainer", "tutorial", "business"], energy: 3,
    bpm: 112, key: 60, scale: "major", chordSize: 3, swing: 0,
    progressions: { A: [1, 5, 6, 4], B: [4, 1, 5, 6] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["build", 4, "B"], ["chorus", 8, "A"], ["verse", 8, "A"], ["build", 4, "B"], ["chorus", 8, "A"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "piano", style: "comp", in: ["intro", "verse", "build", "chorus", "outro"], pattern: "x.o.x.o.x.o.x.o.", range: [55, 72], reverb: 0.2, vel: 0.7 },
      { role: "arp", inst: "pluck", opts: { bright: 0.75, sustain: 1.2 }, style: "arp", arp: { rate: 2, order: [0, 1, 2, 3, 2, 1], octaves: 2 }, in: ["build", "chorus"], range: [67, 79], delay: 0.25, pan: 0.2 },
      { role: "bass", inst: "subtractive", opts: SYNTH_BASS, style: "bass", in: ["verse", "build", "chorus", "outro"], pattern: "R.R.R.R.R.R.F.O.", vel: 0.8 },
      { role: "lead", inst: "mallet", opts: { kind: "glock" }, style: "melody", in: ["chorus"], range: [72, 88], density: 0.45, reverb: 0.3, delay: 0.15 },
      { role: "pad", inst: "sawEnsemble", opts: PAD, style: "sustain", in: ["chorus"], range: [55, 74], lp: 4200, chorus: true, reverb: 0.3 },
    ],
    drums: { kit: "pop", sections: { verse: "pop", build: "popHalf", chorus: "popFull", outro: "popHalf" } },
    mix: { reverb: { room: 0.7 } },
  },
  {
    id: "sunday-drive", title: "Sunday Drive", genre: "Acoustic", moods: ["happy", "warm"], tags: ["travel", "vlog", "family"], energy: 3,
    bpm: 100, key: 55, scale: "major", chordSize: 3, swing: 0.08,
    progressions: { A: [1, 6, 4, 5], B: [4, 5, 6, 1] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 4, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "pluck", opts: GUITAR, style: "strum", in: ["intro", "verse", "chorus", "break", "outro"], pattern: "x..x..x.x.x..x..", range: [52, 71], reverb: 0.15, vel: 0.85 },
      { role: "bass", inst: "subtractive", opts: ROUND_BASS, style: "bass", in: ["verse", "chorus", "outro"], pattern: "R...R.F.R...O.F.", range: [36], vel: 0.8 },
      { role: "lead", inst: "mallet", opts: { kind: "kalimba" }, style: "melody", in: ["chorus"], range: [67, 84], density: 0.42, reverb: 0.25, delay: 0.15 },
      { role: "counter", inst: "mallet", opts: { kind: "celesta" }, style: "melody", in: ["break"], range: [72, 86], density: 0.3, reverb: 0.4 },
    ],
    drums: { kit: "acoustic", sections: { verse: "acousticLight", chorus: "acoustic", break: "acousticLight", outro: "acousticLight" } },
    mix: { reverb: { room: 0.65 } },
  },
  {
    id: "momentum", title: "Momentum", genre: "Electronic", moods: ["energetic", "bold"], tags: ["promo", "product", "sports"], energy: 5,
    bpm: 124, key: 54, scale: "minor", chordSize: 4, swing: 0,
    progressions: { A: [1, 6, 3, 7] },
    sections: [["intro", 8, "A"], ["build", 4, "A"], ["chorus", 16, "A"], ["break", 8, "A"], ["build", 4, "A"], ["chorus", 16, "A"], ["outro", 8, "A"]],
    layers: [
      { role: "chords", inst: "sawEnsemble", opts: { voices: 5, detuneCents: 18, attack: 0.005, decay: 0.18, sustain: 0.25, release: 0.15 }, style: "comp", in: ["build", "chorus"], pattern: "..x...x...x...x.", range: [60, 76], lp: 6000, chorus: true, duck: true, reverb: 0.2 },
      { role: "pad", inst: "sawEnsemble", opts: PAD, style: "sustain", in: ["intro", "break"], range: [57, 76], lp: 3500, chorus: true, reverb: 0.4 },
      { role: "bass", inst: "subtractive", opts: SYNTH_BASS, style: "bass", in: ["intro", "build", "chorus", "outro"], pattern: "..R-..R-..R-..R-", duck: true, vel: 0.9 },
      { role: "lead", inst: "subtractive", opts: PLUCK_SYNTH, style: "melody", in: ["chorus", "break"], range: [66, 83], density: 0.55, delay: 0.3, reverb: 0.2, gate: 0.6 },
    ],
    drums: { kit: "house", sections: { intro: "house", build: "house", chorus: "houseFull", outro: "house" } },
    mix: { sidechain: 0.55, introFilter: true, delayBeats: 0.75, reverb: { room: 0.7 } },
  },
  {
    id: "neon-nights", title: "Neon Nights", genre: "Synthwave", moods: ["retro", "bold"], tags: ["gaming", "tech", "night"], energy: 4,
    bpm: 100, key: 50, scale: "minor", chordSize: 3, swing: 0,
    progressions: { A: [1, 6, 7, 1], B: [6, 3, 7, 5] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 4, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "arp", inst: "subtractive", opts: ARP_SYNTH, style: "arp", arp: { rate: 1, order: [0, 1, 2, 3, 2, 1, 0, 2], octaves: 2 }, in: ["intro", "verse", "chorus", "outro"], range: [62, 74], delay: 0.3, pan: -0.15 },
      { role: "pad", inst: "sawEnsemble", opts: PAD, style: "sustain", in: ["verse", "chorus", "break", "outro"], range: [55, 74], lp: 3800, chorus: true, duck: true, reverb: 0.4 },
      { role: "bass", inst: "subtractive", opts: SYNTH_BASS, style: "bass", in: ["verse", "chorus", "outro"], pattern: "R.O.R.O.R.O.R.O.", duck: true },
      { role: "lead", inst: "subtractive", opts: { wave: "square", cutoff: 1500, envAmt: 1800, filterDecay: 0.3, vibrato: 0.006, detuneCents: 7, release: 0.25, sustain: 0.7 }, style: "melody", in: ["chorus"], range: [67, 84], density: 0.4, delay: 0.35, reverb: 0.3 },
    ],
    drums: { kit: "synthwave", sections: { verse: "synthwaveHalf", chorus: "synthwave", outro: "synthwaveHalf" }, levels: { snare: 1 } },
    mix: { sidechain: 0.35, delayBeats: 0.75, drumReverb: 1.6, reverb: { room: 0.85, damp: 0.3 } },
  },
  {
    id: "rise-together", title: "Rise Together", genre: "Cinematic", moods: ["epic", "inspiring"], tags: ["intro", "launch", "trailer"], energy: 4,
    bpm: 90, key: 50, scale: "minor", chordSize: 3, swing: 0,
    progressions: { A: [1, 6, 3, 7], B: [6, 7, 1, 1] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["build", 4, "B"], ["chorus", 8, "A"], ["break", 4, "A"], ["build", 2, "B"], ["chorus", 8, "A"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "piano", style: "arp", arp: { rate: 2, order: [0, 1, 2, 1], octaves: 2 }, in: ["intro", "break", "outro"], range: [55, 67], reverb: 0.4 },
      { role: "arp", inst: "subtractive", opts: { ...ARP_SYNTH, cutoff: 500, envAmt: 1500 }, style: "arp", arp: { rate: 2, order: [0, 0, 1, 0, 2, 0, 1, 0] }, in: ["verse", "build", "chorus"], range: [50, 62], reverb: 0.2, level: 1 },
      { role: "strings", inst: "sawEnsemble", opts: STRINGS, style: "sustain", in: ["verse", "build", "chorus", "outro"], range: [55, 76], lp: 6000, reverb: 0.5 },
      { role: "bass", inst: "sawEnsemble", opts: { ...STRINGS, voices: 2, octaveSub: 0.8 }, style: "bass", in: ["verse", "build", "chorus"], pattern: "R---------------", range: [38], lp: 1500 },
      { role: "lead", inst: "sawEnsemble", opts: { ...STRINGS, attack: 0.12, release: 0.5 }, style: "melody", in: ["chorus"], range: [69, 86], density: 0.32, reverb: 0.55, level: 1 },
      { role: "chords", inst: "sawEnsemble", opts: { voices: 3, detuneCents: 6, attack: 0.03, decay: 0.35, sustain: 0.5, release: 0.3 }, style: "comp", in: ["chorus"], pattern: "x-----x-----x-x-", range: [50, 66], lp: 2600, reverb: 0.3, level: -2 },
    ],
    drums: { kit: "cinematic", sections: { verse: "cinematicLight", build: "cinematicLight", chorus: "cinematic" } },
    mix: { drumReverb: 1.5, reverb: { room: 0.9, damp: 0.3, preDelay: 0.03 }, reverbDb: 2 },
  },
  {
    id: "first-light", title: "First Light", genre: "Piano", moods: ["emotional", "hopeful"], tags: ["story", "memories", "background"], energy: 2,
    bpm: 72, key: 60, scale: "major", chordSize: 3, swing: 0,
    progressions: { A: [6, 4, 1, 5], B: [4, 5, 3, 6] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "piano", opts: { bright: 0.7 }, style: "arp", arp: { rate: 2, order: [0, 1, 2, 3, 2, 1, 2, 1], octaves: 2 }, in: ["intro", "verse", "chorus", "outro"], range: [48, 62], hp: 90, reverb: 0.45, vel: 0.7 },
      { role: "lead", inst: "piano", style: "melody", in: ["verse", "chorus"], range: [67, 84], density: 0.3, reverb: 0.45 },
      { role: "strings", inst: "sawEnsemble", opts: { ...STRINGS, attack: 1.2 }, style: "sustain", in: ["chorus"], range: [55, 74], lp: 5000, reverb: 0.6, level: -2 },
      { role: "bass", inst: "piano", style: "bass", in: ["verse", "chorus"], pattern: "R---------------", range: [36], level: -3 },
    ],
    mix: { riser: false, reverb: { room: 0.88, damp: 0.4 }, reverbDb: 2 },
  },
  {
    id: "deep-focus", title: "Deep Focus", genre: "Ambient", moods: ["calm", "focus"], tags: ["background", "study", "tutorial"], energy: 1,
    bpm: 60, key: 52, scale: "major", chordSize: 4, swing: 0,
    progressions: { A: [1, 4, 6, 4], B: [4, 5, 1, 1] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["outro", 4, "A"]],
    layers: [
      { role: "pad", inst: "warmPad", style: "sustain", in: ["intro", "verse", "chorus", "outro"], range: [52, 71], reverb: 0.5 },
      { role: "pad", inst: "sawEnsemble", opts: { ...PAD, attack: 2, release: 3 }, style: "sustain", in: ["verse", "chorus"], range: [59, 78], lp: 2200, chorus: true, reverb: 0.6, level: -3 },
      { role: "bells", inst: "bell", opts: { decay: 3 }, style: "melody", in: ["verse", "chorus"], range: [72, 88], density: 0.16, reverb: 0.6, delay: 0.3 },
      { role: "bass", inst: "warmPad", opts: { attack: 2, release: 3 }, style: "bass", in: ["verse", "chorus", "outro"], pattern: "R---------------", range: [40], level: -4 },
    ],
    mix: { riser: false, delayBeats: 1.5, reverb: { room: 0.92, damp: 0.45 }, reverbDb: 3 },
  },
  {
    id: "open-sky", title: "Open Sky", genre: "Chill", moods: ["dreamy", "uplifting"], tags: ["travel", "lifestyle", "vlog"], energy: 3,
    bpm: 96, key: 53, scale: "major", chordSize: 4, swing: 0.05,
    progressions: { A: [4, 1, 5, 6], B: [2, 5, 1, 6] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 4, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "epiano", style: "comp", in: ["intro", "verse", "chorus", "break", "outro"], pattern: "x-----x-----x---", range: [55, 72], reverb: 0.25 },
      { role: "arp", inst: "pluck", opts: { bright: 0.65, sustain: 1.5 }, style: "arp", arp: { rate: 2, order: [0, 2, 1, 3], octaves: 2 }, in: ["chorus", "break"], range: [67, 79], delay: 0.35, pan: 0.25 },
      { role: "pad", inst: "sawEnsemble", opts: PAD, style: "sustain", in: ["chorus", "break"], range: [57, 76], lp: 3800, chorus: true, duck: true, reverb: 0.4 },
      { role: "bass", inst: "subtractive", opts: ROUND_BASS, style: "bass", in: ["verse", "chorus", "outro"], pattern: "R-----R-..R---F-", vel: 0.85 },
      { role: "lead", inst: "subtractive", opts: { ...PLUCK_SYNTH, sustain: 0.5, decay: 0.4, cutoff: 900 }, style: "melody", in: ["chorus"], range: [67, 84], density: 0.4, delay: 0.3, reverb: 0.25 },
    ],
    drums: { kit: "pop", sections: { verse: "chill", chorus: "chillFull", outro: "chill" } },
    mix: { sidechain: 0.3, delayBeats: 0.75, reverb: { room: 0.75 } },
  },
  {
    id: "lab-notes", title: "Lab Notes", genre: "Minimal", moods: ["curious", "focus"], tags: ["tutorial", "science", "background", "explainer"], energy: 2,
    bpm: 105, key: 50, scale: "dorian", chordSize: 3, swing: 0.06,
    progressions: { A: [1, 7, 4, 1], B: [6, 7, 4, 4] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 4, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "arp", inst: "mallet", opts: { kind: "marimba" }, style: "arp", arp: { rate: 2, order: [0, 1, 2, 1, 0, 2, 1, 2] }, in: ["intro", "verse", "chorus", "break", "outro"], range: [60, 74], reverb: 0.2, level: 2 },
      { role: "bass", inst: "subtractive", opts: { ...SYNTH_BASS, decay: 0.2, sustain: 0.3, cutoff: 300 }, style: "bass", in: ["verse", "chorus", "outro"], pattern: "R..R..R.R..R..F.", vel: 0.8 },
      { role: "counter", inst: "pluck", opts: { bright: 0.6, sustain: 0.8 }, style: "melody", in: ["chorus"], range: [69, 84], density: 0.35, delay: 0.25, pan: 0.2 },
      { role: "pad", inst: "warmPad", style: "sustain", in: ["chorus", "break"], range: [55, 72], reverb: 0.4, level: -3 },
    ],
    drums: { kit: "soft", sections: { verse: "softLight", chorus: "soft", break: "softLight", outro: "softLight" } },
    mix: { riser: false, delayBeats: 0.75, reverb: { room: 0.6 } },
  },
  {
    id: "breakthrough", title: "Breakthrough", genre: "Inspirational", moods: ["inspiring", "uplifting"], tags: ["business", "launch", "promo"], energy: 4,
    bpm: 116, key: 52, scale: "major", chordSize: 3, swing: 0,
    progressions: { A: [1, 5, 6, 4], B: [6, 4, 1, 5] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["build", 4, "B"], ["chorus", 8, "A"], ["verse", 8, "A"], ["build", 4, "B"], ["chorus", 8, "A"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "piano", style: "comp", in: ["intro", "verse", "build", "chorus", "outro"], pattern: "x.x.x.x.x.x.x.x.", range: [56, 71], reverb: 0.2, vel: 0.7 },
      { role: "strings", inst: "sawEnsemble", opts: STRINGS, style: "sustain", in: ["build", "chorus"], range: [59, 79], lp: 6000, reverb: 0.45 },
      { role: "arp", inst: "pluck", opts: { bright: 0.7, sustain: 1 }, style: "arp", arp: { rate: 1, order: [0, 1, 2, 1], octaves: 2 }, in: ["chorus"], range: [68, 80], delay: 0.2, pan: -0.25 },
      { role: "lead", inst: "mallet", opts: { kind: "glock" }, style: "melody", in: ["chorus"], range: [72, 88], density: 0.42, reverb: 0.3 },
      { role: "bass", inst: "subtractive", opts: SYNTH_BASS, style: "bass", in: ["verse", "build", "chorus", "outro"], pattern: "R.R.R.R.R.R.R.R.", vel: 0.8 },
    ],
    drums: { kit: "pop", sections: { verse: "popHalf", build: "pop", chorus: "popFull", outro: "popHalf" } },
    mix: { reverb: { room: 0.75 } },
  },
  {
    id: "little-steps", title: "Little Steps", genre: "Playful", moods: ["playful", "happy"], tags: ["kids", "explainer", "fun"], energy: 3,
    bpm: 118, key: 53, scale: "major", chordSize: 3, swing: 0.12,
    progressions: { A: [1, 6, 4, 5], B: [4, 1, 2, 5] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 4, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "pluck", opts: UKULELE, style: "strum", in: ["intro", "verse", "chorus", "break", "outro"], pattern: "x.x.x.xxx.x.x.xx", range: [60, 74], reverb: 0.15, vel: 0.8 },
      { role: "bass", inst: "pluck", opts: { bright: 0.3, sustain: 0.7 }, style: "bass", in: ["verse", "chorus", "outro"], pattern: "R...F...R...F...", range: [36], vel: 0.9 },
      { role: "lead", inst: "mallet", opts: { kind: "glock" }, style: "melody", in: ["chorus"], range: [72, 89], density: 0.5, reverb: 0.25 },
      { role: "counter", inst: "mallet", opts: { kind: "marimba" }, style: "melody", in: ["verse", "break"], range: [62, 77], density: 0.35, reverb: 0.2 },
    ],
    drums: { kit: "acoustic", sections: { verse: "acousticLight", chorus: "acoustic", break: "acousticLight", outro: "acousticLight" } },
    mix: { reverb: { room: 0.55 } },
  },
  {
    id: "city-pulse", title: "City Pulse", genre: "Hip-hop", moods: ["bold", "confident"], tags: ["urban", "sports", "fashion"], energy: 3,
    bpm: 90, key: 48, scale: "harmonicMinor", chordSize: 4, swing: 0.14,
    progressions: { A: [1, 6, 4, 5] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["chorus", 8, "A"], ["verse", 8, "A"], ["chorus", 8, "A"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "piano", opts: { bright: 0.6 }, style: "comp", in: ["intro", "verse", "chorus", "outro"], pattern: "x-----x---x-----", range: [55, 70], reverb: 0.25, vel: 0.75 },
      { role: "bass", inst: "bass808", style: "bass", in: ["verse", "chorus"], pattern: "R------R--R-----R-R----R--O-----", range: [36], vel: 0.95 },
      { role: "counter", inst: "epiano", style: "melody", in: ["chorus"], range: [67, 82], density: 0.32, delay: 0.3, reverb: 0.25 },
      { role: "pad", inst: "sawEnsemble", opts: PAD, style: "sustain", in: ["chorus"], range: [55, 72], lp: 2500, chorus: true, reverb: 0.3, level: -3 },
    ],
    drums: { kit: "hiphop", sections: { intro: "hiphopLight", verse: "hiphop", chorus: "hiphop", outro: "hiphopLight" } },
    mix: { introFilter: true, reverb: { room: 0.6 } },
  },
  {
    id: "clockwork", title: "Clockwork", genre: "Documentary", moods: ["mysterious", "tense"], tags: ["documentary", "science", "investigation"], energy: 3,
    bpm: 96, key: 52, scale: "harmonicMinor", chordSize: 3, swing: 0,
    progressions: { A: [1, 6, 4, 5], B: [1, 1, 6, 5] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["build", 4, "B"], ["chorus", 8, "A"], ["break", 4, "A"], ["chorus", 8, "A"], ["outro", 4, "A"]],
    layers: [
      { role: "arp", inst: "subtractive", opts: { ...ARP_SYNTH, cutoff: 450, envAmt: 1800 }, style: "arp", arp: { rate: 1, order: [0, 0, 2, 0, 1, 0, 2, 1] }, in: ["intro", "verse", "build", "chorus", "outro"], range: [52, 64], delay: 0.2, level: 1 },
      { role: "strings", inst: "sawEnsemble", opts: { ...STRINGS, attack: 1 }, style: "sustain", in: ["verse", "build", "chorus", "break"], range: [48, 67], lp: 3500, reverb: 0.5 },
      { role: "counter", inst: "piano", style: "melody", in: ["chorus", "break"], range: [72, 86], density: 0.2, reverb: 0.5, delay: 0.25 },
      { role: "bass", inst: "subtractive", opts: ROUND_BASS, style: "bass", in: ["verse", "build", "chorus"], pattern: "R-------R-------", range: [33] },
    ],
    drums: { kit: "soft", sections: { verse: "pulse", build: "pulse", chorus: "pulseFull", outro: "pulse" } },
    mix: { reverb: { room: 0.85, damp: 0.35 } },
  },
  {
    id: "afterglow", title: "Afterglow", genre: "Chill electronic", moods: ["chill", "dreamy"], tags: ["lifestyle", "fashion", "night"], energy: 3,
    bpm: 110, key: 55, scale: "minor", chordSize: 4, swing: 0.04,
    progressions: { A: [1, 7, 6, 7], B: [4, 5, 1, 1] },
    sections: [["intro", 4, "A"], ["verse", 8, "A"], ["build", 4, "B"], ["chorus", 8, "A"], ["break", 4, "A"], ["build", 4, "B"], ["chorus", 8, "A"], ["outro", 4, "A"]],
    layers: [
      { role: "chords", inst: "epiano", opts: { tremolo: 0.2 }, style: "comp", in: ["intro", "verse", "build", "chorus", "break", "outro"], pattern: "x---x---x-x---x-", range: [55, 72], duck: true, reverb: 0.25 },
      { role: "pad", inst: "sawEnsemble", opts: PAD, style: "sustain", in: ["chorus", "break"], range: [57, 76], lp: 3200, chorus: true, duck: true, reverb: 0.4 },
      { role: "bass", inst: "subtractive", opts: SYNTH_BASS, style: "bass", in: ["verse", "build", "chorus", "outro"], pattern: "R---..R-..R-R---", duck: true },
      { role: "arp", inst: "pluck", opts: { bright: 0.6, sustain: 1.2 }, style: "arp", arp: { rate: 2, order: [0, 1, 2, 3, 1, 2], octaves: 2 }, in: ["build", "chorus"], range: [67, 79], delay: 0.35, pan: 0.2 },
      { role: "counter", inst: "subtractive", opts: { ...PLUCK_SYNTH, cutoff: 1000, sustain: 0.4 }, style: "melody", in: ["chorus"], range: [67, 82], density: 0.35, delay: 0.3, reverb: 0.25 },
    ],
    drums: { kit: "house", sections: { verse: "house", build: "house", chorus: "houseFull", outro: "house" } },
    mix: { sidechain: 0.35, introFilter: true, delayBeats: 0.75, reverb: { room: 0.75 } },
  },
];
