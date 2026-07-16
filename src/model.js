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

// Motion lanes: per-track clip envelopes — a param name mapped to 16 values
// in 0..1, captured by performing on the sound pad while recording.
export function normalizeMotion(motion = null) {
  const out = {};
  for (const track of ARRANGE_TRACKS) {
    const lanes = motion?.[track];
    if (!lanes || typeof lanes !== "object") continue;
    const t = {};
    for (const [param, lane] of Object.entries(lanes)) {
      if (!Array.isArray(lane)) continue;
      // 1 to 4 bars of ride, in whole bars.
      const len = Math.max(16, Math.min(64, Math.floor(lane.length / 16) * 16));
      t[param] = Array.from({ length: len }, (_, i) => Math.max(0, Math.min(1, Number(lane[i]) || 0)));
    }
    if (Object.keys(t).length) out[track] = t;
  }
  return out;
}

// Per-clip step lengths (polymeter): drums/bass/melody lanes can loop early,
// 2..16 steps, phasing against the other tracks' cycles.
export const STEPPED_TRACKS = ["drums", "bass", "melody"];
export function normalizeSteps(steps = null) {
  const out = {};
  for (const t of STEPPED_TRACKS) {
    const n = Math.round(Number(steps?.[t]));
    out[t] = Number.isFinite(n) ? Math.max(2, Math.min(16, n)) : 16;
  }
  return out;
}
export const stepsFor = (scene, track) => scene?.steps?.[track] || 16;

export function normalizeScene(scene) {
  scene.melody = normalizeNoteLane(scene.melody);
  scene.bass = normalizeNoteLane(scene.bass);
  const drums = scene.drums || {};
  scene.drums = Object.fromEntries(DRUM_VOICES.map((v) => [v, normalizeDrumLane(drums[v])]));
  scene.motion = normalizeMotion(scene.motion);
  scene.steps = normalizeSteps(scene.steps);
  // ±1 only: at -2 the pad highpass (170 Hz) eats the voicings near-silent,
  // and a control whose extreme sounds broken is a hard wall in disguise.
  scene.harmonyOct = Math.max(-1, Math.min(1, Math.round(Number(scene.harmonyOct) || 0)));
  return scene;
}

let sceneSeq = 0;
const SCENE_TAGS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export function makeScene(harmony, drums, melody = null, bass = null, motion = null, steps = null) {
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
    motion: normalizeMotion(motion),
    steps: normalizeSteps(steps),
    harmonyOct: 0, // whole-clip octave for the chord track (piano lanes shift per note instead)
  };
  scene.launch = cloneLaunch();
  return scene;
}

export function defaultScene() {
  return makeMagicScene();
}

// --- The vibe: one coherent roll of groove, tempo, pocket, space, and spice.
// The dice used to roll uniform noise over one pattern archetype — the same
// band playing every song. Now it hires from archetypes (selection beats
// processing) and the noise lives INSIDE the archetype, so a roll grooves
// like a thing without playing the same thing twice.
const rnd = Math.random;
const rint = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pickFrom = (arr) => arr[(rnd() * arr.length) | 0];
const dlane = (fill) => Array.from({ length: 16 }, (_, s) => fill(s) || 0);
function pickW(pairs) {
  let total = 0;
  for (const [, w] of pairs) total += w;
  let r = rnd() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

// Groove archetypes: the drummer the dice hires. Each carries its roll
// weight, kick placement, hat grid, velocity personality, tempo band, pocket
// range, bass behavior weights, a melody-density hint, and the kits it likes
// to play. A voice an archetype sits out returns null — makeScene zero-fills
// missing lanes.
const GROOVES = {
  fourfloor: {
    weight: 22,
    tempo: [116, 130],
    swing: [0, 0.12],
    bass: [["offbeat8", 3], ["bounce", 2], ["roots", 1]],
    melodyGap: 0.55,
    kits: ["clean", "street", "funk"],
    drums() {
      const kick = dlane((s) => (s % 4 === 0 ? 0.92 + rnd() * 0.08 : 0));
      const snare = dlane((s) => (s === 4 || s === 12 ? 0.85 + rnd() * 0.1 : 0));
      const sixteens = rnd() < 0.35;
      const hat = dlane((s) => {
        if (s % 2 === 0) return (s % 4 === 2 ? 0.8 : 0.5) + rnd() * 0.15;
        return sixteens ? 0.35 + rnd() * 0.15 : 0;
      });
      const clap = rnd() < 0.5 ? dlane((s) => (s === 4 || s === 12 ? 0.7 + rnd() * 0.15 : 0)) : null;
      return { kick, snare, hat, clap };
    },
  },
  backbeat: {
    weight: 26,
    tempo: [84, 110],
    swing: [0.06, 0.22],
    bass: [["roots", 3], ["bounce", 1], ["offbeat8", 1]],
    melodyGap: 0.5,
    kits: ["funk", "warm", "street"],
    drums() {
      const kick = dlane((s) => {
        if (s === 0 || s === 8) return 0.9 + rnd() * 0.1;
        if ((s === 6 || s === 10 || s === 14) && rnd() < 0.3) return 0.6 + rnd() * 0.15;
        return 0;
      });
      const snare = dlane((s) => (s === 4 || s === 12 ? 0.85 + rnd() * 0.1 : 0));
      const hat = dlane((s) => {
        if (s % 2 === 0) return (s % 4 === 2 ? 0.8 : 0.55) + rnd() * 0.15;
        return rnd() < 0.15 ? 0.35 : 0;
      });
      const clap = dlane((s) => ((s === 6 || s === 14) && rnd() < 0.35 ? 0.6 + rnd() * 0.15 : 0));
      return { kick, snare, hat, clap };
    },
  },
  halftime: {
    weight: 18,
    tempo: [70, 92],
    swing: [0, 0.15],
    bass: [["drone", 3], ["roots", 2]],
    melodyGap: 0.65,
    kits: ["808", "heavy", "dusty"],
    drums() {
      // One pickup, chosen once — a per-step coin here fires 7 AND 10.
      const pickup = rnd() < 0.7 ? (rnd() < 0.5 ? 7 : 10) : -1;
      const kick = dlane((s) => (s === 0 ? 1 : s === pickup ? 0.75 + rnd() * 0.15 : 0));
      const snare = dlane((s) => (s === 8 ? 0.95 : 0));
      const rolls = rnd() < 0.5;
      const hat = dlane((s) => {
        if (rolls) return s % 2 === 1 ? 0.3 + rnd() * 0.2 : 0.55 + rnd() * 0.25;
        return s % 2 === 0 ? 0.5 + rnd() * 0.2 : 0;
      });
      const clap = rnd() < 0.6 ? dlane((s) => (s === 8 ? 0.7 : 0)) : null;
      return { kick, snare, hat, clap };
    },
  },
  twostep: {
    weight: 16,
    tempo: [118, 134],
    swing: [0.25, 0.45],
    bass: [["roots", 2], ["offbeat8", 2], ["bounce", 1]],
    melodyGap: 0.45,
    kits: ["garage", "street", "dusty"],
    drums() {
      const second = pickW([[6, 2], [7, 2], [10, 3]]);
      const kick = dlane((s) => {
        if (s === 0) return 0.95;
        if (s === second) return 0.8 + rnd() * 0.1;
        if (s === 14 && rnd() < 0.3) return 0.65;
        return 0;
      });
      const snare = dlane((s) => (s === 4 || s === 12 ? 0.85 + rnd() * 0.1 : 0));
      const ghosts = euclid(16, rint(3, 5), rint(0, 3));
      const hat = dlane((s) => {
        if (s % 4 === 2) return 0.8 + rnd() * 0.15;
        return ghosts[s] && rnd() < 0.7 ? 0.3 + rnd() * 0.15 : 0;
      });
      const clap = dlane((s) => (s === 12 && rnd() < 0.4 ? 0.65 : 0));
      return { kick, snare, hat, clap };
    },
  },
  minimal: {
    weight: 18,
    tempo: [96, 124],
    swing: [0.1, 0.3],
    bass: [["drone", 2], ["roots", 2], ["offbeat8", 1]],
    melodyGap: 0.7,
    kits: ["dusty", "warm", "clean"],
    drums() {
      const kicks = euclid(16, rint(2, 3), 0);
      const kick = dlane((s) => (kicks[s] ? 0.85 + rnd() * 0.15 : 0));
      const snare = dlane((s) => (s === 12 && rnd() < 0.6 ? 0.8 : 0));
      const hats = euclid(16, rint(5, 7), rint(0, 2));
      const hat = dlane((s) => (hats[s] ? 0.4 + rnd() * 0.2 : 0));
      const clap = dlane((s) => (s === 8 && rnd() < 0.3 ? 0.55 : 0));
      return { kick, snare, hat, clap };
    },
  },
};

// The vibe holds ONLY rolled values (plus the groove name) — archetype
// constants stay in GROOVES and are derived where needed, so the vibe can
// persist on the song and any later scene generated from it (the session
// Magic button, the ✨b variation) speaks the same roll.
function rollVibe() {
  const groove = pickW(Object.entries(GROOVES).map(([name, g]) => [name, g.weight]));
  const g = GROOVES[groove];
  return {
    groove,
    tempo: rint(g.tempo[0], g.tempo[1]),
    swing: Math.round((g.swing[0] + rnd() * (g.swing[1] - g.swing[0])) * 100) / 100,
    // The groove hires its kit more often than not; the rest keep the surprise.
    kit: rnd() < 0.6 ? pickFrom(g.kits) : null,
    // Registers roll once per vibe so every scene in the song lives in the
    // same octave. Melody sits in octaves 3-5: octave 2 measured ~4 dB down
    // through the lead highpass and sits on the bass register — out.
    melodyBase: pickFrom([48, 60, 72]),
    bassBase: rnd() < 0.5 ? 36 : 24,
    // Space: about a third of rolls arrive wet, keyed by track and send —
    // verb on the pad and lead, echo on the lead, never bass or drums
    // (low-end discipline; the returns are highpassed and ride the kick
    // duck, so wet stays clean). The app side applies this generically.
    wet: rnd() < 0.35
      ? {
          harmony: { verb: rint(-16, -9) },
          melody: { verb: rint(-18, -10), ...(rnd() < 0.6 ? { echo: rint(-18, -10) } : {}) },
        }
      : null,
    harmonyOct: rnd() < 0.15 ? (rnd() < 0.5 ? 1 : -1) : 0,
    polymeter: rnd() < 0.1 ? (rnd() < 0.5 ? "bass" : "melody") : null,
    bScene: rnd() < 0.6,
  };
}

// Weighted progression families in scale degrees. Length is part of the roll:
// cadences run 4 bars, vamps 2, statics 1 — the arrangement and clip loops
// follow the harmony length wherever it lands.
const CADENCES = [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 4, 3], [1, 4, 0, 0], [0, 3, 0, 4], [0, 0, 3, 4], [5, 4, 3, 4]];
const VAMPS = [[0, 5], [0, 3], [5, 3], [1, 4], [0, 4], [5, 4], [0, 6], [3, 4]];
function magicHarmony() {
  const fam = pickW([["cadence", 45], ["vamp", 25], ["static", 10], ["wander", 20]]);
  if (fam === "cadence") return pickFrom(CADENCES).slice();
  if (fam === "vamp") return pickFrom(VAMPS).slice();
  if (fam === "static") return [rint(0, 6)];
  return Array.from({ length: 4 }, () => rint(0, 6)); // the surprise generator
}

// A melody is a motif, repeated: generate a short cell, tile it with scale-
// step transposition and drop-note variation, and let the groove's gap hint
// leave breathing room. Uniform scatter can't hook; repetition can.
const MOTIF_SHIFTS = [[0, 5], [1, 2], [-1, 2], [2, 1], [-2, 1]];
function magicMelody(vibe) {
  const win = scaleNotes(vibe.melodyBase, 14);
  const gap = GROOVES[vibe.groove].melodyGap;
  const motifLen = rnd() < 0.5 ? 4 : 8;
  const count = motifLen === 4 ? rint(2, 3) : rint(3, 5);
  const offs = new Set([0]);
  while (offs.size < count) {
    offs.add(rnd() < 0.8 ? 2 * rint(0, motifLen / 2 - 1) : rint(0, motifLen - 1));
  }
  const clampIdx = (i) => Math.max(0, Math.min(win.length - 1, i));
  const anchor = rint(4, 9);
  const events = [...offs].sort((a, b) => a - b).map((off) => ({
    off,
    idx: clampIdx(anchor + rint(-3, 3)),
    len: rnd() < 0.35 ? 2 : 1,
    vel: 0.65 + rnd() * 0.3,
  }));
  const melody = new Array(16).fill(null);
  const writeRep = (rep, shift, always) => {
    for (const ev of events) {
      if (!always && rnd() < 0.15) continue;
      const s = rep * motifLen + ev.off;
      if (s >= 16) return;
      melody[s] = [{ midi: win[clampIdx(ev.idx + shift)], len: ev.len, vel: Math.max(0.4, Math.min(1, ev.vel + rnd() * 0.1 - 0.05)) }];
    }
  };
  writeRep(0, 0, true);
  for (let rep = 1; rep * motifLen < 16; rep++) {
    if (rnd() < gap) continue;
    writeRep(rep, pickW(MOTIF_SHIFTS), false);
  }
  // Never a dud: if the gaps ate too much, the motif answers itself.
  if (melody.filter(Boolean).length < 3) writeRep(8 / motifLen, 0, true);
  return melody;
}

// Bass behaviors, weighted per groove: root-quarters with pickups (the old
// default), offbeat 8ths (house), a drone (halftime weight), octave bounce.
function magicBass(vibe) {
  const notes = scaleNotes(vibe.bassBase, 12);
  const low = notes.slice(0, 5);
  const root = notes[0];
  const fifth = notes[Math.min(4, notes.length - 1)];
  const bass = new Array(16).fill(null);
  const behavior = pickW(GROOVES[vibe.groove].bass);
  if (behavior === "drone") {
    bass[0] = [{ midi: root, len: 8, vel: 0.9 }];
    bass[8] = [{ midi: rnd() < 0.3 ? root + 12 : root, len: 8, vel: 0.85 }];
  } else if (behavior === "offbeat8") {
    for (let s = 2; s < 16; s += 4) {
      bass[s] = [{ midi: rnd() < 0.25 ? fifth : root, len: 2, vel: 0.85 + rnd() * 0.1 }];
    }
  } else if (behavior === "bounce") {
    for (let s = 0; s < 16; s += 2) {
      if (rnd() < 0.2) continue;
      bass[s] = [{ midi: s % 4 === 2 ? root + 12 : root, len: 2, vel: (s % 4 === 0 ? 0.9 : 0.75) + rnd() * 0.1 }];
    }
    if (!bass[0]) bass[0] = [{ midi: root, len: 2, vel: 0.9 }];
  } else {
    const pickLow = () => pickFrom(low);
    for (let s = 0; s < 16; s += 4) {
      if (rnd() < 0.8) bass[s] = [{ midi: pickLow(), len: 4, vel: 0.9 }];
    }
    if (!bass.some(Boolean)) bass[0] = [{ midi: pickLow(), len: 4, vel: 0.9 }];
    // Syncopation: a short pickup on the "and" — the held note underneath
    // gets cut short so the low end never doubles up.
    for (const s of [6, 14]) {
      if (rnd() < 0.45 && !bass[s]) {
        const held = bass[s - 2]?.[0];
        if (held) held.len = 2;
        bass[s] = [{ midi: pickLow(), len: 2, vel: 0.7 + rnd() * 0.15 }];
      }
    }
  }
  return bass;
}

export function makeMagicScene(vibe) {
  // Tolerate no vibe (fresh roll) and pre-vibe or trimmed song.vibe shapes
  // from older saves — anything that can't drive the generators re-rolls.
  if (!GROOVES[vibe?.groove] || vibe.melodyBase == null) vibe = rollVibe();
  const drums = GROOVES[vibe.groove].drums();
  drums.kick[0] = Math.max(drums.kick[0], 0.95); // the downbeat anchor, always
  const scene = makeScene(magicHarmony(), drums, magicMelody(vibe), magicBass(vibe));
  scene.tag = "✨";
  scene.harmonyOct = vibe.harmonyOct;
  if (vibe.polymeter) scene.steps[vibe.polymeter] = 12;
  return scene;
}

// The B side: the same song idea with the furniture moved — a fresh motif in
// the same register (the vibe carries it), drums thinned or busied, the
// progression rotated. Same key, same groove: somewhere to GO once the A
// loop lands.
function makeVariationScene(a, vibe) {
  const b = cloneScene(a);
  b.tag = "✨b";
  b.melody = normalizeNoteLane(magicMelody(vibe));
  if (rnd() < 0.5) {
    // thin: drop the clap, pull the hats back
    b.drums.clap.fill(0);
    b.drums.hat = b.drums.hat.map((v, s) => (s % 2 === 1 ? 0 : v * 0.85));
  } else {
    // busy: ghost hats fill the gaps, one extra kick late in the bar
    const ghosts = euclid(16, rint(9, 11), rint(0, 2));
    b.drums.hat = b.drums.hat.map((v, s) => v || (ghosts[s] ? 0.3 + rnd() * 0.1 : 0));
    const extra = rnd() < 0.5 ? 10 : 14;
    if (!b.drums.kick[extra]) b.drums.kick[extra] = 0.7;
  }
  if (a.harmony.length >= 2 && rnd() < 0.5) b.harmony = [...a.harmony.slice(1), a.harmony[0]];
  return b;
}

export function cloneScene(scene) {
  const cloned = makeScene(scene.harmony, scene.drums, scene.melody, scene.bass, scene.motion, scene.steps);
  cloned.launch = cloneLaunch(scene.launch);
  cloned.harmonyOct = scene.harmonyOct || 0;
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
  // One vibe per song: tempo, pocket, and space come from the same roll the
  // patterns do, so the parts agree on what kind of thing they're playing.
  const vibe = rollVibe();
  const s = makeMagicScene(vibe);
  const scenes = [s];
  if (vibe.bScene) scenes.push(makeVariationScene(s, vibe));
  // Place at least 4 bars on the timeline: content loops inside a placed
  // clip, but the timeline itself has a 4-bar floor — a 1-bar vamp placed
  // at its own length would export as one bar of music and three of silence.
  const len = Math.max(4, s.harmony.length);
  return {
    tempo: vibe.tempo,
    key,
    scale,
    trackSwing: {},
    // The whole vibe rides the song: the app side finishes the roll from it
    // (kit, wet sends), and any later scene generated for this song — the
    // session Magic button included — reuses the same roll.
    vibe,
    scenes,
    // Arrangement: per track, clips placed on the bar timeline. Each references
    // a scene's clip for that track (start + length in bars) — Ableton's model
    // of dragging Session clips into the linear timeline.
    arrangement: {
      harmony: [{ scene: 0, start: 0, len }],
      drums: [{ scene: 0, start: 0, len }],
      bass: [{ scene: 0, start: 0, len }],
      melody: [{ scene: 0, start: 0, len }],
    },
    // Performance mutes: per track, 1 at bar index b silences that track's bar
    // in arrangement playback and every export. Written bar-quantized by
    // session record — M/S moves during a take are part of the performance.
    mutes: {},
    loop: { on: false, start: 0, len: 4 },
    swing: vibe.swing, // global groove, rolled inside the archetype's pocket
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
