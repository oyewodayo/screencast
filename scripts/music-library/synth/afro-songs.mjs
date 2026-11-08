// The Briefcast Originals Afro set: amapiano, afrobeats, highlife and 70s Afrobeat, as data for
// compose.mjs (same format as songs.mjs). Amapiano rides on the log drum - its patterns are the
// bass line - over jazzy 9th-chord piano and a swung 16th shaker; afrobeats on the 3-3-2 kick with
// highlife guitars; Afrobeat on interlocking guitars, organ and a unison horn section.

const PIANO_DEEP = { bright: 0.75 };
const LOG = { decay: 0.42, drive: 2.4, droop: 0.7 };
const ROUND_BASS = { wave: "saw", cutoff: 190, envAmt: 600, filterDecay: 0.18, sub: 0.9, drive: 1.3, release: 0.07, decay: 0.5, sustain: 0.55 };
const HIGHLIFE = { bright: 0.85, sustain: 0.7, pickPos: 0.13, mute: 0.05 };
const SCRATCH = { bright: 0.9, sustain: 0.18, pickPos: 0.1, mute: 0.02 };

export const AFRO_SONGS = [
  {
    id: "joburg-sunset", title: "Joburg Sunset", genre: "Amapiano", moods: ["groovy", "warm"], tags: ["amapiano", "afro", "dance", "lifestyle", "summer"], energy: 3,
    bpm: 113, key: 57, scale: "minor", chordSize: 5, swing: 0.12,
    progressions: { A: [1, 4, 7, 3], B: [6, 7, 3, 1] },
    sections: [["intro", 8, "A"], ["verse", 16, "A"], ["build", 4, "B"], ["chorus", 16, "B"], ["break", 8, "A"], ["chorus", 16, "B"], ["outro", 8, "A"]],
    layers: [
      { role: "chords", inst: "piano", opts: PIANO_DEEP, style: "comp", in: ["intro", "verse", "build", "chorus", "break", "outro"], pattern: "x..x..x...x..x..", gate: 0.6, range: [55, 72], reverb: 0.25, vel: 0.7 },
      { role: "bass", inst: "logDrum", opts: LOG, style: "bass", in: ["verse", "chorus", "break", "outro"], range: [33], vel: 0.95,
        pattern: "R-.R-.R-..O-R-..R-.R-.F-..A-R-..", patterns: { chorus: "R-.R-.R-O-.R-.R-R-.R-.F-O-.A-R-.", break: "R---..R-..O---..R---..R-..F-A-.." } },
      { role: "pad", inst: "warmPad", style: "sustain", in: ["intro", "chorus", "break", "outro"], range: [57, 74], level: -3, reverb: 0.4 },
      { role: "lead", inst: "horn", opts: { kind: "alto" }, style: "melody", in: ["chorus"], range: [64, 81], density: 0.36, reverb: 0.3, delay: 0.2 },
      { role: "counter", inst: "horn", opts: { kind: "flute" }, style: "melody", in: ["verse", "break"], range: [72, 88], density: 0.24, reverb: 0.35, delay: 0.25, level: -2 },
    ],
    drums: { kit: "amapiano", sections: { intro: "amapianoLight", verse: "amapiano", build: "amapianoDrop", chorus: "amapianoFull", break: "amapianoDrop", outro: "amapianoLight" }, levels: { kick: -2 } },
    mix: { introFilter: true, delayBeats: 0.75, reverb: { room: 0.7, damp: 0.45 } },
  },
  {
    id: "soft-life", title: "Soft Life", genre: "Amapiano", moods: ["smooth", "chill"], tags: ["amapiano", "private school", "saxophone", "lounge", "lifestyle"], energy: 2,
    bpm: 112, key: 53, scale: "major", chordSize: 5, swing: 0.14,
    progressions: { A: [2, 5, 1, 6], B: [4, 3, 2, 5] },
    sections: [["intro", 8, "A"], ["verse", 16, "A"], ["chorus", 16, "B"], ["break", 8, "A"], ["chorus", 16, "B"], ["outro", 8, "A"]],
    layers: [
      { role: "chords", inst: "epiano", opts: { tremolo: 0.18 }, style: "comp", in: ["intro", "verse", "chorus", "break", "outro"], pattern: "x--.x--.x-..x---", range: [55, 72], reverb: 0.3, vel: 0.7, chorus: { mix: 0.3 } },
      { role: "bass", inst: "logDrum", opts: { ...LOG, decay: 0.36, drive: 1.8, droop: 0.5 }, style: "bass", in: ["verse", "chorus", "outro"], range: [33], vel: 0.85,
        pattern: "R-..R-.R-...O-..R-..R-.F-...A-..", patterns: { chorus: "R-..R-.R-.O-R-..R-..R-.F-.O-A-.." } },
      { role: "pad", inst: "sawEnsemble", opts: { voices: 5, detuneCents: 12, attack: 1, decay: 1.5, sustain: 0.85, release: 1.6, width: 0.8 }, style: "sustain", in: ["chorus", "break"], range: [57, 74], lp: 3200, chorus: true, reverb: 0.45, level: -3 },
      { role: "lead", inst: "horn", opts: { kind: "tenor" }, style: "melody", in: ["chorus", "break"], range: [55, 76], density: 0.32, reverb: 0.32, delay: 0.18 },
    ],
    drums: { kit: "amapiano", sections: { intro: "amapianoLight", verse: "amapiano", chorus: "amapianoFull", break: "amapianoDrop", outro: "amapianoLight" }, levels: { kick: -3, openHat: -2 } },
    mix: { introFilter: true, reverb: { room: 0.72, damp: 0.5 } },
  },
  {
    id: "log-drum-season", title: "Log Drum Season", genre: "Amapiano", moods: ["energetic", "bold"], tags: ["amapiano", "party", "dance", "club", "afro"], energy: 4,
    bpm: 115, key: 50, scale: "minor", chordSize: 4, swing: 0.1,
    progressions: { A: [1, 7, 6, 7], B: [4, 5, 1, 1] },
    sections: [["intro", 8, "A"], ["verse", 8, "A"], ["build", 4, "B"], ["chorus", 16, "A"], ["break", 8, "A"], ["build", 4, "B"], ["chorus", 16, "A"], ["outro", 8, "A"]],
    layers: [
      { role: "chords", inst: "piano", opts: { bright: 0.9 }, style: "comp", in: ["intro", "verse", "build", "chorus", "outro"], pattern: "x..x..x.x..x..x.", gate: 0.45, range: [57, 74], reverb: 0.2, vel: 0.75 },
      { role: "bass", inst: "logDrum", opts: { ...LOG, drive: 3, decay: 0.5, droop: 0.9 }, style: "bass", in: ["verse", "chorus", "break", "outro"], range: [33], vel: 1,
        pattern: "R-.R-.R-O-.R-.R-R-.R-.F-O-.A-R-.", patterns: { break: "R-.R.RO-..R-.R.FR-.R.RO-.A.R-O-." } },
      { role: "lead", inst: "subtractive", opts: { wave: "square", cutoff: 1800, envAmt: 1500, filterDecay: 0.25, vibrato: 0.008, detuneCents: 6, release: 0.18, sustain: 0.7 }, style: "melody", in: ["chorus"], range: [69, 86], density: 0.42, delay: 0.3, reverb: 0.25, level: -1 },
      { role: "pad", inst: "warmPad", style: "sustain", in: ["intro", "break", "build"], range: [55, 72], reverb: 0.45, level: -2 },
    ],
    drums: { kit: "amapiano", sections: { intro: "amapianoLight", verse: "amapiano", build: "amapianoDrop", chorus: "amapianoFull", break: "amapianoDrop", outro: "amapiano" } },
    mix: { introFilter: true, delayBeats: 0.75, reverb: { room: 0.68 } },
  },
  {
    id: "lagos-nights", title: "Lagos Nights", genre: "Afrobeats", moods: ["happy", "groovy"], tags: ["afrobeats", "afro", "dance", "party", "summer"], energy: 4,
    bpm: 104, key: 56, scale: "major", chordSize: 4, swing: 0.08,
    progressions: { A: [4, 5, 3, 6], B: [6, 4, 1, 5] },
    sections: [["intro", 4, "A"], ["verse", 16, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 4, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "arp", inst: "pluck", opts: HIGHLIFE, style: "arp", arp: { rate: 2, order: [0, 2, 1, 2, 0, 2, 1, 3], gate: 0.5 }, in: ["intro", "verse", "chorus", "break", "outro"], range: [64, 77], pan: 0.3, reverb: 0.15, level: 1 },
      { role: "counter", inst: "pluck", opts: SCRATCH, style: "arp", arp: { rate: 1, order: [2, 1, 0, 1, 2, 1, 3, 1], gate: 0.4 }, in: ["chorus"], range: [62, 74], pan: -0.32, level: -1 },
      { role: "chords", inst: "epiano", style: "comp", in: ["verse", "chorus", "break"], pattern: "x-----x-----x---", range: [55, 70], reverb: 0.25, level: -3 },
      { role: "bass", inst: "subtractive", opts: ROUND_BASS, style: "bass", in: ["verse", "chorus", "outro"], pattern: "R..R..R.R..F..A.", range: [36], vel: 0.9 },
      { role: "lead", inst: "mallet", opts: { kind: "kalimba" }, style: "melody", in: ["verse", "break"], range: [67, 84], density: 0.4, reverb: 0.25, delay: 0.2 },
      { role: "lead", inst: "horn", opts: { kind: "soprano" }, style: "melody", in: ["chorus"], range: [65, 82], density: 0.38, reverb: 0.25, delay: 0.22 },
      { role: "pad", inst: "warmPad", style: "sustain", in: ["chorus", "break"], range: [56, 72], level: -4, reverb: 0.4 },
    ],
    drums: { kit: "afrobeats", sections: { intro: "afrobeatsLight", verse: "afrobeats", chorus: "afrobeatsFull", break: "afrobeatsLight", outro: "afrobeatsLight" } },
    mix: { delayBeats: 0.75, reverb: { room: 0.62 } },
  },
  {
    id: "highlife-sunday", title: "Highlife Sunday", genre: "Highlife", moods: ["happy", "warm"], tags: ["highlife", "afro", "guitar", "family", "celebration"], energy: 3,
    bpm: 112, key: 55, scale: "major", chordSize: 3, swing: 0.1,
    progressions: { A: [1, 4, 1, 5], B: [4, 5, 1, 6] },
    sections: [["intro", 4, "A"], ["verse", 16, "A"], ["chorus", 8, "B"], ["verse", 8, "A"], ["chorus", 8, "B"], ["break", 8, "A"], ["chorus", 8, "B"], ["outro", 4, "A"]],
    layers: [
      { role: "arp", inst: "pluck", opts: HIGHLIFE, style: "arp", arp: { rate: 2, order: [0, 1, 2, 1, 2, 1, 0, 2], octaves: 2, gate: 0.55 }, in: ["intro", "verse", "chorus", "break", "outro"], range: [62, 76], pan: 0.32, reverb: 0.15, level: 1 },
      { role: "counter", inst: "pluck", opts: { ...HIGHLIFE, bright: 0.7 }, style: "arp", arp: { rate: 2, order: [2, 0, 1, 0], gate: 0.45 }, in: ["verse", "chorus", "break"], range: [57, 69], pan: -0.32, level: -2 },
      { role: "bass", inst: "subtractive", opts: ROUND_BASS, style: "bass", in: ["verse", "chorus", "break", "outro"], pattern: "R.R..F.R.R..O.F.", range: [36], vel: 0.88 },
      { role: "lead", inst: "horn", opts: { kind: "trumpet" }, style: "melody", in: ["chorus"], range: [64, 80], density: 0.4, reverb: 0.25 },
      { role: "lead", inst: "horn", opts: { kind: "alto" }, style: "melody", unison: 3, transpose: -12, in: ["chorus"], pan: -0.15, level: -3, reverb: 0.25 },
      { role: "counter", inst: "mallet", opts: { kind: "marimba" }, style: "melody", in: ["break"], range: [67, 84], density: 0.42, reverb: 0.2 },
    ],
    drums: { kit: "afrobeats", sections: { intro: "afrobeatsLight", verse: "afrobeatsLight", chorus: "afrobeats", break: "afrobeatsLight", outro: "afrobeatsLight" } },
    mix: { riser: false, reverb: { room: 0.6 } },
  },
  {
    id: "brass-uprising", title: "Brass Uprising", genre: "Afrobeat", moods: ["bold", "groovy"], tags: ["afrobeat", "afro", "horns", "funk", "vintage"], energy: 4,
    bpm: 116, key: 52, scale: "dorian", chordSize: 4, swing: 0.06,
    progressions: { A: [1, 1, 1, 4], B: [4, 4, 1, 1] },
    sections: [["intro", 8, "A"], ["verse", 16, "A"], ["chorus", 16, "B"], ["break", 8, "A"], ["chorus", 16, "B"], ["outro", 8, "A"]],
    layers: [
      { role: "arp", inst: "pluck", opts: SCRATCH, style: "arp", arp: { rate: 1, order: [0, 1, 0, 2, 0, 1, 0, 2], gate: 0.35 }, in: ["intro", "verse", "chorus", "break", "outro"], range: [64, 76], pan: 0.35, level: 1 },
      { role: "counter", inst: "pluck", opts: { ...HIGHLIFE, bright: 0.6 }, style: "arp", arp: { rate: 2, order: [0, 2, 1, 2, 0, 3, 1, 2], gate: 0.5 }, in: ["verse", "chorus", "break", "outro"], range: [55, 67], pan: -0.35, level: -1 },
      { role: "chords", inst: "organ", opts: { drawbars: "888400000", perc: 0.2 }, style: "comp", in: ["verse", "chorus", "outro"], pattern: "..x...x...x.x...", gate: 0.7, range: [55, 72], leslie: 0.9, level: -2 },
      { role: "bass", inst: "subtractive", opts: ROUND_BASS, style: "bass", in: ["intro", "verse", "chorus", "break", "outro"], pattern: "R..R.O.R..F.R.A.", range: [36], vel: 0.9 },
      { role: "lead", inst: "horn", opts: { kind: "tenor" }, style: "melody", in: ["chorus"], range: [55, 72], density: 0.45, reverb: 0.2 },
      { role: "lead", inst: "horn", opts: { kind: "trumpet" }, style: "melody", unison: 4, transpose: 12, in: ["chorus"], pan: 0.2, level: -2, reverb: 0.2 },
      { role: "counter", inst: "organ", opts: { drawbars: "888000000", perc: 0.35 }, style: "melody", in: ["break"], range: [64, 84], density: 0.5, leslie: 6.5, reverb: 0.15 },
    ],
    drums: { kit: "afrobeat", sections: { intro: "afrobeatLight", verse: "afrobeat", chorus: "afrobeat", break: "afrobeatLight", outro: "afrobeat" } },
    mix: { riser: false, reverb: { room: 0.58 }, masterEq: [["highshelf", 9000, 0.7, -1.5]] },
  },
];
