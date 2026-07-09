// Music + song model. No rendering, no audio — just the data and the theory.

// Seven diatonic triads of C major, colored by FUNCTION family (tonic greens /
// subdominant blues / dominant ambers), lightness varied so each stays distinct.
// pcs[0] is always the root pitch class.
// Seven-note scales. The seven diatonic triads are derived from the current
// key + scale, so the whole app is "scale aware" (Ableton Live 12 style).
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
export const SCALE_NAMES = Object.keys(SCALES);
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
const DEGREE_HUE = [150, 224, 138, 204, 36, 166, 8];
const PC_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const pcName = (pc) => PC_NAMES[((pc % 12) + 12) % 12];

let curKey = 0;
let curScale = "major";
export let CHORDS = []; // live binding; importers see rebuilds

function rebuildChords() {
  const sc = SCALES[curScale];
  CHORDS = [];
  for (let d = 0; d < 7; d++) {
    const semis = [d, d + 2, d + 4].map((i) => sc[i % 7] + 12 * Math.floor(i / 7));
    const pcs = semis.map((s) => (((curKey + s) % 12) + 12) % 12);
    const third = semis[1] - semis[0];
    const fifth = semis[2] - semis[0];
    const rn = ROMAN[d];
    let roman;
    let suffix;
    if (third === 4 && fifth === 7) { roman = rn; suffix = ""; }
    else if (third === 3 && fifth === 7) { roman = rn.toLowerCase(); suffix = "m"; }
    else if (third === 3 && fifth === 6) { roman = rn.toLowerCase() + "°"; suffix = "dim"; }
    else if (third === 4 && fifth === 8) { roman = rn + "+"; suffix = "aug"; }
    else { roman = rn.toLowerCase(); suffix = ""; }
    CHORDS.push({ roman, name: pcName(pcs[0]) + suffix, pcs, degree: d, hue: DEGREE_HUE[d], sat: 56, light: 56 });
  }
}
export function setScaleContext(key, scaleName) {
  curKey = ((key % 12) + 12) % 12;
  if (SCALES[scaleName]) curScale = scaleName;
  rebuildChords();
}
setScaleContext(0, "major");

// hsl -> 0xRRGGBB for CSS hex conversion.
export function hslInt(h, s, l) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x);
  return (to(f(0)) << 16) | (to(f(8)) << 8) | to(f(4));
}

export const chordColor = (ci, dl = 0) =>
  hslInt(CHORDS[ci].hue, CHORDS[ci].sat, Math.max(0, Math.min(100, CHORDS[ci].light + dl)));

// --- Voice leading: keep common tones, move the rest by the smallest step. ---
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const nearestOctave = (pc, ref) => pc + 12 * Math.round((ref - pc) / 12);

export function voiceLead(pcs, prev) {
  if (!prev) return pcs.map((pc) => 60 + pc);
  let best = null;
  let bestCost = Infinity;
  for (const perm of PERMS) {
    let cost = 0;
    const cand = [0, 0, 0];
    for (let v = 0; v < 3; v++) {
      const m = nearestOctave(pcs[perm[v]], prev[v]);
      cost += Math.abs(m - prev[v]);
      cand[v] = m;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = cand;
    }
  }
  return best;
}

// Pitch classes two chords share — the common tones that light up.
export function sharedTones(a, b) {
  const sa = new Set(CHORDS[a].pcs);
  return CHORDS[b].pcs.filter((pc) => sa.has(pc));
}

// --- Euclidean rhythm (Bjorklund): k pulses spread over n steps, evenly. ---
export function euclid(steps, pulses, rotation = 0) {
  steps = Math.max(1, steps | 0);
  pulses = Math.max(0, Math.min(steps, pulses | 0));
  if (pulses === 0) return new Array(steps).fill(false);
  // Bresenham-style even distribution — equivalent to Bjorklund for our purposes.
  const pat = new Array(steps).fill(false);
  let bucket = 0;
  for (let i = 0; i < steps; i++) {
    bucket += pulses;
    if (bucket >= steps) {
      bucket -= steps;
      pat[i] = true;
    }
  }
  // Rotate so an onset can be pulled onto beat 1.
  if (rotation) {
    const r = ((rotation % steps) + steps) % steps;
    return pat.slice(steps - r).concat(pat.slice(0, steps - r));
  }
  return pat;
}

// --- Song / Scene ---
// A Scene is a loop AND a song section. Harmony is one chord per bar; drums are
// a step-sequencer grid: one 16-step row per voice, a small drum rack.
export const DRUM_VOICES = ["kick", "snare", "hat", "clap"];
export const DRUM_META = {
  kick: { label: "kick", hue: 32, sat: 68, light: 62 },
  snare: { label: "snare", hue: 336, sat: 52, light: 68 },
  hat: { label: "hat", hue: 190, sat: 40, light: 76 },
  clap: { label: "clap", hue: 276, sat: 52, light: 72 },
};

export function cloneNoteSlot(slot) {
  if (!slot) return null;
  const notes = (Array.isArray(slot) ? slot : [slot])
    .filter((n) => n && Number.isFinite(Number(n.midi)))
    .map((n) => ({
      midi: Number(n.midi),
      len: Math.max(1, Math.min(16, Number(n.len) || 1)),
      vel: Math.max(0.05, Math.min(1, Number(n.vel) || 0.9)),
    }));
  return notes.length ? notes : null;
}

export function noteSlot(slot) {
  return Array.isArray(slot) ? slot : slot ? [slot] : [];
}

export function normalizeNoteLane(lane = null) {
  return Array.from({ length: 16 }, (_, i) => cloneNoteSlot(lane?.[i]));
}

// Drum steps are velocities (0 = off). Old projects stored booleans; coerce.
export function normalizeDrumLane(lane = null) {
  return Array.from({ length: 16 }, (_, i) => {
    const v = lane?.[i];
    if (v === true) return 0.9;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.max(0.05, Math.min(1, n)) : 0;
  });
}

export function normalizeScene(scene) {
  scene.melody = normalizeNoteLane(scene.melody);
  scene.bass = normalizeNoteLane(scene.bass);
  const drums = scene.drums || {};
  scene.drums = Object.fromEntries(DRUM_VOICES.map((v) => [v, normalizeDrumLane(drums[v])]));
  return scene;
}

let sceneSeq = 0;
const SCENE_TAGS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export function makeScene(harmony, drums, melody = null, bass = null) {
  const tag = SCENE_TAGS[sceneSeq % SCENE_TAGS.length];
  sceneSeq += 1;
  const scene = {
    tag,
    harmony: harmony.slice(),
    drums: Object.fromEntries(DRUM_VOICES.map((v) => [v, normalizeDrumLane(drums[v])])),
    // Bass and melody: per-step note stacks (or null) for scale-snapped chords.
    // Each note is { midi, len, vel }; old single-note slots normalize to stacks.
    melody: normalizeNoteLane(melody),
    bass: normalizeNoteLane(bass),
  };
  scene.launch = cloneLaunch();
  return scene;
}

export function defaultScene() {
  return makeMagicScene();
}

export function makeMagicScene() {
  const dens = { kick: 0.32, snare: 0.14, hat: 0.5, clap: 0.12 };
  const drums = {};
  for (const v of DRUM_VOICES) {
    drums[v] = new Array(16).fill(0);
    for (let s = 0; s < 16; s++) {
      if (v === "kick" && s % 2 !== 0 && Math.random() > 0.1) continue;
      if (v === "snare" && s % 4 !== 0) continue;
      if (Math.random() >= dens[v]) continue;
      // Velocity shapes the groove: offbeat hats accented, everything else a
      // touch under the anchors so the backbone stays in front.
      if (v === "hat") drums[v][s] = (s % 4 === 2 ? 0.85 : 0.55) + Math.random() * 0.15;
      else drums[v][s] = 0.6 + Math.random() * 0.25;
    }
  }
  drums.kick[0] = 0.95;
  drums.kick[8] = 0.9;
  drums.snare[4] = 0.9;
  drums.snare[12] = 0.9;

  const harmony = Array.from({ length: 4 }, () => Math.floor(Math.random() * 7));

  // Octaves 3-5. Octave 2 measured ~4 dB down through the lead highpass and
  // sits on top of the bass register — thin AND muddy, so it's out.
  const melodyBases = [48, 60, 72];
  const melodyBase = melodyBases[Math.floor(Math.random() * melodyBases.length)];
  const melodyNotes = scaleNotes(melodyBase, 15);
  const melody = new Array(16).fill(null);
  for (let s = 0; s < 16; s++) {
    if (Math.random() < 0.3) {
      melody[s] = [{ midi: melodyNotes[Math.floor(Math.random() * melodyNotes.length)], len: 1, vel: 0.7 + Math.random() * 0.3 }];
    }
  }
  // Floor at four notes: a 2-note roll reads as a dud, not a melody. Fill on
  // empty 8th-grid steps so the top line stays a hook, never a wash.
  const emptyEvens = () => [0, 2, 4, 6, 8, 10, 12, 14].filter((s) => !melody[s]);
  while (melody.filter(Boolean).length < 4) {
    const open = emptyEvens();
    const s = open[Math.floor(Math.random() * open.length)];
    melody[s] = [{ midi: melodyNotes[Math.floor(Math.random() * melodyNotes.length)], len: 2, vel: 0.75 + Math.random() * 0.2 }];
  }

  const bassBase = Math.random() < 0.5 ? 36 : 24;
  const bassNotes = scaleNotes(bassBase, 12);
  const bassPick = () => bassNotes[Math.floor(Math.random() * Math.min(bassNotes.length, 5))];
  const bass = new Array(16).fill(null);
  for (let s = 0; s < 16; s += 4) {
    if (Math.random() < 0.8) {
      bass[s] = [{ midi: bassPick(), len: 4, vel: 0.9 }];
    }
  }
  if (!bass.some(Boolean)) {
    bass[0] = [{ midi: bassPick(), len: 4, vel: 0.9 }];
  }
  // Syncopation: a short pickup on the "and" before beat 3 or pushing into
  // the next bar — what makes a bassline groove instead of plod. The held
  // note underneath gets cut short so the low end never doubles up.
  for (const s of [6, 14]) {
    if (Math.random() < 0.45 && !bass[s]) {
      const held = bass[s - 2]?.[0];
      if (held) held.len = 2;
      bass[s] = [{ midi: bassPick(), len: 2, vel: 0.7 + Math.random() * 0.15 }];
    }
  }

  const scene = makeScene(harmony, drums, melody, bass);
  scene.tag = "✨";
  return scene;
}

export function cloneScene(scene) {
  const cloned = makeScene(scene.harmony, scene.drums, scene.melody, scene.bass);
  cloned.launch = cloneLaunch(scene.launch);
  return cloned;
}

// --- Scale helpers for the piano roll (current key + scale) ---
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

const scaleSet = () => new Set(SCALES[curScale].map((o) => (((curKey + o) % 12) + 12) % 12));

// Ascending in-scale MIDI notes at/above baseMidi (bottom row first).
export function scaleNotes(baseMidi, rows) {
  const set = scaleSet();
  const out = [];
  let m = baseMidi;
  while (out.length < rows && m < 128) {
    if (set.has(((m % 12) + 12) % 12)) out.push(m);
    m++;
  }
  return out;
}

// Nudge a MIDI note to the nearest in-scale pitch.
export function snapToScale(midi) {
  const set = scaleSet();
  for (let off = 0; off < 12; off++) {
    if (set.has((((midi + off) % 12) + 12) % 12)) return midi + off;
    if (set.has((((midi - off) % 12) + 12) % 12)) return midi - off;
  }
  return midi;
}

export const ARRANGE_TRACKS = ["harmony", "drums", "bass", "melody"];
export const LAUNCH_MODES = ["loop", "oneshot"];
export const FOLLOW_ACTIONS = ["none", "next", "prev", "random"];

export function defaultLaunch(track = "drums") {
  return {
    mode: "loop",
    follow: "none",
    followBars: track === "harmony" ? 4 : 1,
  };
}

function cloneLaunch(launch = {}) {
  return Object.fromEntries(ARRANGE_TRACKS.map((track) => [track, { ...defaultLaunch(track), ...(launch[track] || {}) }]));
}

export function ensureLaunchSettings(scene) {
  if (!scene.launch) scene.launch = {};
  for (const track of ARRANGE_TRACKS) {
    scene.launch[track] = { ...defaultLaunch(track), ...(scene.launch[track] || {}) };
    if (!LAUNCH_MODES.includes(scene.launch[track].mode)) scene.launch[track].mode = "loop";
    if (!FOLLOW_ACTIONS.includes(scene.launch[track].follow)) scene.launch[track].follow = "none";
    scene.launch[track].followBars = Math.max(1, Math.min(16, scene.launch[track].followBars | 0 || defaultLaunch(track).followBars));
  }
  return scene.launch;
}

export function clipLaunch(scene, track) {
  return ensureLaunchSettings(scene)[track];
}

export function clipLengthBars(scene, track) {
  return track === "harmony" ? Math.max(1, scene.harmony.length) : 1;
}

export function makeSong() {
  // Randomize key and scale on each fresh load — pairs well with Magic scenes
  const key = Math.floor(Math.random() * 12);
  const scale = SCALE_NAMES[Math.floor(Math.random() * SCALE_NAMES.length)];
  setScaleContext(key, scale);
  const s = defaultScene();
  const len = s.harmony.length;
  const tempo = Math.floor(70 + Math.random() * 61); // 70-130
  return {
    tempo,
    key,
    scale,
    scenes: [s],
    // Arrangement: per track, clips placed on the bar timeline. Each references
    // a scene's clip for that track (start + length in bars) — Ableton's model
    // of dragging Session clips into the linear timeline.
    arrangement: {
      harmony: [{ scene: 0, start: 0, len }],
      drums: [{ scene: 0, start: 0, len }],
      bass: [{ scene: 0, start: 0, len }],
      melody: [{ scene: 0, start: 0, len }],
    },
    loop: { on: false, start: 0, len: 4 },
    swing: 0.16, // global groove (16th-note swing amount)
  };
}

export function arrangeLength(song) {
  let max = 4;
  for (const t of ARRANGE_TRACKS)
    for (const c of song.arrangement[t]) max = Math.max(max, c.start + c.len);
  return max;
}

export function clipAt(song, track, bar) {
  for (const c of song.arrangement[track]) if (bar >= c.start && bar < c.start + c.len) return c;
  return null;
}
