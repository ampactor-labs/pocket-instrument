// Tone.js engine. Per-track mixer channels (vol/pan/sends + meter), a morphable
// device per track (vector synthesis over four preset corners + a color/motion
// slot), note length + velocity, and a transport that loops a Scene or plays
// the Arrangement.
//
// One rule keeps the WAV export honest: buildGraph() is the ONLY place the
// signal chain exists. The live context and the offline renderer both call it,
// so "export sounds like the app" holds by construction. If you touch the
// chain, touch it there.
//
// The sound space, in one breath: each melodic track hosts FOUR synth layers,
// one per preset corner, each keeping its own oscillator and envelope. A patch
// is a point {x, y} between the corners — bilinear weights set layer levels
// (equal-power) and blend the shared tone controls (filter, drive, chorus).
// On top sits one color insert (tape/crush/phase/trem/wob) with amount +
// motion, motion rates quantized to tempo divisions. Corners are loudness-
// matched by measurement (npm run calibrate), the space between inherits it,
// and the per-track lane filters stay outside the explorable space — so any
// point a finger or a dice can reach is already mixed.

import * as Tone from "tone";
import { CHORDS, DRUM_VOICES, voiceLead, clipAt, arrangeLength, clipLaunch, clipLengthBars, noteSlot } from "./model.js";

// Debug handle for the headless harnesses; lets calibrate/smoke experiments
// build minimal Tone graphs without reaching into the bundle.
if (typeof window !== "undefined") window.__noodlesTone = Tone;

const midiToFreq = (m) => Tone.Frequency(m, "midi").toFrequency();
const sixteenth = () => Tone.Time("16n").toSeconds();

export const TRACK_KEYS = ["harmony", "drums", "bass", "melody"];
export const MELODIC_TRACKS = ["harmony", "bass", "melody"];

const DEFAULT_TRACK_VOLUME_DB = -6;
const SEND_OFF_DB = -60;
const FIRST_PLAY_WARMUP_MS = 400;
const PLAY_START_LEAD_TIME = "+0.18";
const SOURCE_LEVEL_DB = {
  harmonyPad: -9,
  harmonyHalo: -23,
  harmonyRoot: -29,
  bass: -7,
  melody: -7,
  kick: 0,
  snare: 5,
  hat: -5,
  clap: 3,
};
const KICK_DUCK_GAIN = Tone.dbToGain(-12);
const DRUM_PARALLEL_GAIN = Tone.dbToGain(-8);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The send knobs sweep -30..0 dB; the bottom of the range is "off".
const sendGain = (db) => (db <= -29 ? 0 : Tone.dbToGain(db));

function scheduleKickDuck(param, time) {
  param.cancelScheduledValues(time);
  param.setValueAtTime(1, time);
  param.linearRampToValueAtTime(KICK_DUCK_GAIN, time + 0.008);
  param.exponentialRampToValueAtTime(1, time + 0.25);
}

// --- Preset corners (like drum kits, one set per track) ---
// gain values are trims measured so every corner of a track lands at the same
// loudness — morphing or randomizing must never change the mix balance.
const HARMONY_PRESETS = {
  pad:     { osc: "sawtooth", filter: 1200, attack: 0.35, decay: 1.5, sustain: 0.8, release: 1.2, chorusWet: 0.4, chorusDepth: 0.7, gain: -4.5 },
  keys:    { osc: "sine",     filter: 3000, attack: 0.01, decay: 0.4, sustain: 0.2, release: 0.4, chorusWet: 0.15, chorusDepth: 0.3, gain: -3 },
  ambient: { osc: "triangle", filter: 800,  attack: 1.0,  decay: 2.0, sustain: 0.9, release: 2.5, chorusWet: 0.8,  chorusDepth: 0.9, gain: -4 },
  stab:    { osc: "square",   filter: 2500, attack: 0.01, decay: 0.2, sustain: 0.0, release: 0.2, chorusWet: 0.1,  chorusDepth: 0.2, gain: 3 },
};
export const HARMONY_PRESET_NAMES = Object.keys(HARMONY_PRESETS);

const BASS_PRESETS = {
  deep:   { wave: "sine",     cutoff: 500,  attack: 0.01,  decay: 0.3,  sustain: 0.7,  release: 0.3, gain: -2.5, drive: 0, detune: 0 },
  bright: { wave: "sawtooth", cutoff: 2500, attack: 0.02,  decay: 0.15, sustain: 0.4,  release: 0.2, gain: -3, drive: 0.1, detune: 0 },
  pluck:  { wave: "fmsquare", cutoff: 1800, attack: 0.001, decay: 0.2,  sustain: 0.1,  release: 0.1, gain: -4.5, drive: 0.5, detune: 0 },
  sub:    { wave: "triangle", cutoff: 350,  attack: 0.05,  decay: 0.4,  sustain: 1.0,  release: 0.4, gain: -9.5, drive: 0.35, detune: 0 },
};
export const BASS_PRESET_NAMES = Object.keys(BASS_PRESETS);

const MELODY_PRESETS = {
  lead:  { wave: "sawtooth", cutoff: 3500, attack: 0.02,  decay: 0.2,  sustain: 0.4, release: 0.3, gain: -5.5 },
  bell:  { wave: "sine",     cutoff: 4000, attack: 0.001, decay: 0.8,  sustain: 0.0, release: 0.6, gain: -7 },
  synth: { wave: "square",   cutoff: 2000, attack: 0.01,  decay: 0.15, sustain: 0.2, release: 0.15, gain: -6 },
  pluck: { wave: "triangle", cutoff: 2800, attack: 0.005, decay: 0.1,  sustain: 0.0, release: 0.1, gain: 1.5 },
};
export const MELODY_PRESET_NAMES = Object.keys(MELODY_PRESETS);

const PRESET_TABLES = { harmony: HARMONY_PRESETS, bass: BASS_PRESETS, melody: MELODY_PRESETS };
// Corner order = table order, laid out TL, TR, BL, BR on the XY pad.
export const CORNERS = {
  harmony: HARMONY_PRESET_NAMES,
  bass: BASS_PRESET_NAMES,
  melody: MELODY_PRESET_NAMES,
};
export const COLOR_NAMES = ["none", "tape", "crush", "phase", "trem", "wob"];

// Tight, dead kits — funk / UK garage register (short decays, damped).
const KITS = {
  garage: {
    kick: { pitchDecay: 0.018, octaves: 4, envelope: { attack: 0.001, decay: 0.16, sustain: 0 } },
    snare: 0.09,
    hat: { decay: 0.018, resonance: 6000 },
    clap: 0.09,
    gain: 4,
  },
  funk: {
    kick: { pitchDecay: 0.03, octaves: 5, envelope: { attack: 0.001, decay: 0.2, sustain: 0 } },
    snare: 0.12,
    hat: { decay: 0.026, resonance: 5000 },
    clap: 0.11,
    gain: 2.5,
  },
  clean: {
    kick: { pitchDecay: 0.04, octaves: 6, envelope: { attack: 0.001, decay: 0.4, sustain: 0 } },
    snare: 0.17,
    hat: { decay: 0.05, resonance: 4000 },
    clap: 0.14,
    gain: -1.5,
  },
};
export const KIT_NAMES = Object.keys(KITS);

// --- Patch specs ---
// Melodic: { x, y, color, amount, motion }. Drums: { color, amount, motion }.
export function defaultPatch(track) {
  const base = { color: "none", amount: 0.5, motion: 0.5 };
  return track === "drums" ? base : { x: 0, y: 0, ...base };
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function normalizePatch(track, raw = {}) {
  const p = { ...defaultPatch(track), ...raw };
  p.color = COLOR_NAMES.includes(p.color) ? p.color : "none";
  p.amount = clamp01(p.amount);
  p.motion = clamp01(p.motion);
  if (track !== "drums") {
    p.x = clamp01(p.x);
    p.y = clamp01(p.y);
  }
  return p;
}

// Bilinear corner weights for a point in the pad.
function cornerWeights(patch) {
  const { x, y } = patch;
  return [(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y];
}

export function cornerXY(track, name) {
  const i = Math.max(0, CORNERS[track].indexOf(name));
  return { x: i % 2, y: Math.floor(i / 2) };
}

export function dominantCorner(track, patch) {
  const w = cornerWeights(patch);
  return CORNERS[track][w.indexOf(Math.max(...w))];
}

// Blend helpers: frequencies morph in log space, times and levels linearly.
const blendLin = (vals, w) => vals.reduce((acc, v, i) => acc + v * w[i], 0);
const blendLog = (vals, w) => Math.exp(vals.reduce((acc, v, i) => acc + Math.log(Math.max(v, 1e-3)) * w[i], 0));

// Key-tracked velocity boosts: octave 1 loses audible energy to the 34 Hz
// highpass and to small speakers, so quieter registers get pushed back up.
// Factors close the measured octave-1 vs octave-2 RMS gaps (npm run
// calibrate, bassOct table). Keyed by the patch's dominant corner.
function bassVelocityBoost(preset, midi) {
  if (midi >= 36) return 1;
  if (preset === "sub") return 2.5;
  if (preset === "pluck") return 1.35;
  if (preset === "bright") return 1.1;
  return 1; // deep: pure sine — a boost only booms woofers, phones stay deaf
}

// --- The signal chain, built once for live playback and once per offline
// render. Nodes bind to whichever Tone context is active at call time. ---
function buildGraph({ meters = false } = {}) {
  const g = {};

  // Master chain: gain → gentle saturation → soft clip → glue comp → makeup →
  // brickwall. The EDM-forward "always loud, never clipping" spine.
  g.masterLimiter = new Tone.Limiter(-2).toDestination();
  g.makeupGain = new Tone.Gain(Tone.dbToGain(8)).connect(g.masterLimiter);
  g.glue = new Tone.Compressor({ threshold: -20, ratio: 4, attack: 0.03, release: 0.25, knee: 12 }).connect(g.makeupGain);
  g.softClip = new Tone.WaveShaper((x) => Math.tanh(x * 1.2) / Math.tanh(1.2), 2048).connect(g.glue);
  g.saturation = new Tone.Distortion(0.08).connect(g.softClip);
  g.saturation.wet.value = 0.32;
  g.master = new Tone.Gain(Tone.dbToGain(-3)).connect(g.saturation);

  // Sends. Algorithmic (Freeverb) instead of convolution — far cheaper per
  // sample on a low-end mobile CPU, and fine for a send reverb.
  g.reverb = new Tone.Freeverb({ roomSize: 0.72, dampening: 2600, wet: 1 }).connect(g.master);
  g.echo = new Tone.FeedbackDelay({ delayTime: "8n", feedback: 0.26, wet: 1 }).connect(g.master);
  g.echoReturn = new Tone.Gain(Tone.dbToGain(-4)).connect(g.echo);

  // Everything melodic passes through the kick-side duck; drums get a dry bus
  // plus a parallel-compressed return for weight.
  g.musicDuck = new Tone.Gain(1).connect(g.master);
  g.drumBus = new Tone.Gain(1).connect(g.master);
  g.drumDry = new Tone.Gain(Tone.dbToGain(-1)).connect(g.drumBus);
  g.drumParallel = new Tone.Compressor({ threshold: -24, ratio: 4.5, attack: 0.004, release: 0.13, knee: 12 });
  g.drumParallelReturn = new Tone.Gain(DRUM_PARALLEL_GAIN).connect(g.drumBus);
  g.drumParallel.connect(g.drumParallelReturn);

  // Mixer strips. Melodic tracks run through a per-track compressor into the
  // channel; drums hit their channel directly (the drum bus already carries
  // parallel compression — a third stage on top was mud, not glue).
  g.channels = {};
  g.inputs = {};
  g.trims = {};
  g.verbSends = {};
  g.echoSends = {};
  g.meters = {};
  for (const k of TRACK_KEYS) {
    g.channels[k] = new Tone.Channel({ volume: DEFAULT_TRACK_VOLUME_DB, pan: 0 });
    if (k === "drums") {
      g.channels[k].connect(g.drumDry);
      g.channels[k].connect(g.drumParallel);
    } else {
      // Preset level trims land AFTER the input compressor: pre-comp (and
      // pre-drive) gain shapes tone and gets eaten by the nonlinearities,
      // so leveling there never converges. Drive for tone, trim for level.
      g.inputs[k] = new Tone.Compressor({ threshold: -20, ratio: 4, attack: 0.005, release: 0.15, knee: 12 });
      g.trims[k] = new Tone.Gain(1);
      g.inputs[k].connect(g.trims[k]);
      g.trims[k].connect(g.channels[k]);
      g.channels[k].connect(g.musicDuck);
    }
    g.verbSends[k] = new Tone.Gain(0).connect(g.reverb);
    g.channels[k].connect(g.verbSends[k]);
    g.echoSends[k] = new Tone.Gain(0).connect(g.echoReturn);
    g.channels[k].connect(g.echoSends[k]);
    if (meters) {
      g.meters[k] = new Tone.Meter();
      (k === "drums" ? g.drumBus : g.channels[k]).connect(g.meters[k]);
    }
  }
  if (meters) {
    g.masterMeter = new Tone.Meter();
    g.masterLimiter.connect(g.masterMeter);
  }

  // Color insert points: everything a track makes flows through colorIn, and
  // applyColorTo splices the selected effect between colorIn and colorDest.
  g.colorIn = {};
  g.colorDest = {};
  g.colorNodes = {};
  g.colorTypes = {};
  for (const k of TRACK_KEYS) {
    g.colorIn[k] = new Tone.Gain(1);
    g.colorDest[k] = k === "drums" ? g.channels.drums : g.inputs[k];
    g.colorIn[k].connect(g.colorDest[k]);
    g.colorNodes[k] = null;
    g.colorTypes[k] = "none";
  }

  // Layer factory: one synth per preset corner, oscillator and envelope FIXED
  // to that corner. Morphing crossfades whole voices — each corner keeps its
  // identity, the blend does the work. Layers below ~2% weight are muted and
  // never triggered, so parked-at-a-corner costs what a single synth did.
  //
  // Construct at the track source level: PolySynth bakes the constructor
  // volume into each lazily-created VOICE (later .volume writes only reach
  // the output node), so this is where the voice level — and the level that
  // hits the drive stage — gets set. The output node then carries only the
  // morph weight (applyMorphTo).
  const makeLayers = (table, poly, dest, srcDb) =>
    Object.values(table).map((p) => {
      const synth = new Tone.PolySynth(Tone.Synth, {
        maxPolyphony: poly,
        oscillator: { type: p.osc || p.wave, detune: p.detune || 0 },
        envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release },
        volume: srcDb,
      }).connect(dest);
      if ((p.osc || p.wave) === "fmsquare") synth.set({ oscillator: { modulationType: "sawtooth", harmonicity: 0.5, modulationIndex: 2 } });
      return synth;
    });

  // Harmony: morphing pad + mono shimmer an octave up + a quiet low-mid root
  // hint. Bass owns the low end, so the pad and the hint are highpassed.
  g.chorus = new Tone.Chorus({ frequency: 0.4, delayTime: 4, depth: 0.6, wet: 0.35 }).start();
  g.padHighpass = new Tone.Filter({ type: "highpass", frequency: 170, Q: 0.6 });
  g.padFilter = new Tone.Filter({ type: "lowpass", frequency: 1500, Q: 0.7 });
  // The LFO OWNS the pad cutoff (a signal connected to a param overrides it —
  // writing frequency.value is silently ignored and rampTo throws). Patches
  // steer the cutoff by rescaling the LFO's min/max around the blended value.
  g.padLfo = new Tone.LFO({ frequency: 0.05, min: 850, max: 2600 }).connect(g.padFilter.frequency);
  g.padLfo.start();
  g.padHighpass.connect(g.padFilter);
  g.padFilter.connect(g.chorus);
  g.chorus.connect(g.colorIn.harmony);
  g.padLayers = makeLayers(HARMONY_PRESETS, 4, g.padHighpass, SOURCE_LEVEL_DB.harmonyPad);
  g.halo = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.9, decay: 1, sustain: 0.5, release: 1.6 },
    volume: SOURCE_LEVEL_DB.harmonyHalo,
  }).connect(g.colorIn.harmony);
  g.rootHintFilter = new Tone.Filter({ type: "highpass", frequency: 120, Q: 0.7 }).connect(g.colorIn.harmony);
  g.sub = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.08, decay: 0.4, sustain: 0.85, release: 1.6 },
    volume: SOURCE_LEVEL_DB.harmonyRoot,
  }).connect(g.rootHintFilter);

  // Bass and lead: layers feed the shared drive/filter lane.
  g.bassHighpass = new Tone.Filter({ type: "highpass", frequency: 34, Q: 0.7 }).connect(g.colorIn.bass);
  g.bassFilter = new Tone.Filter({ type: "lowpass", frequency: 750, Q: 0.9 }).connect(g.bassHighpass);
  g.bassDrive = new Tone.Distortion(0).connect(g.bassFilter);
  g.bassLayers = makeLayers(BASS_PRESETS, 6, g.bassDrive, SOURCE_LEVEL_DB.bass);
  g.leadHighpass = new Tone.Filter({ type: "highpass", frequency: 180, Q: 0.7 }).connect(g.colorIn.melody);
  g.leadFilter = new Tone.Filter({ type: "lowpass", frequency: 3200, Q: 0.6 }).connect(g.leadHighpass);
  g.leadLayers = makeLayers(MELODY_PRESETS, 8, g.leadFilter, SOURCE_LEVEL_DB.melody);
  g.layers = { harmony: g.padLayers, bass: g.bassLayers, melody: g.leadLayers };

  // Kit. Hat is a filtered noise burst on purpose — MetalSynth's 6 FM
  // oscillators made the most-triggered voice the priciest drum in the kit.
  g.kickFilter = new Tone.Filter({ type: "lowpass", frequency: 1800, Q: 0.5 }).connect(g.colorIn.drums);
  g.kick = new Tone.MembraneSynth({ volume: SOURCE_LEVEL_DB.kick }).connect(g.kickFilter);
  g.snareFilter = new Tone.Filter({ type: "highpass", frequency: 950 }).connect(g.colorIn.drums);
  g.snare = new Tone.NoiseSynth({ noise: { type: "white" }, volume: SOURCE_LEVEL_DB.snare }).connect(g.snareFilter);
  g.hatFilter = new Tone.Filter({ type: "highpass", frequency: 7500 }).connect(g.colorIn.drums);
  g.hat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.02, sustain: 0 }, volume: SOURCE_LEVEL_DB.hat }).connect(g.hatFilter);
  g.clapFilter = new Tone.Filter({ type: "bandpass", frequency: 1400, Q: 1.2 }).connect(g.colorIn.drums);
  g.clap = new Tone.NoiseSynth({ noise: { type: "pink" }, volume: SOURCE_LEVEL_DB.clap }).connect(g.clapFilter);

  return g;
}

// --- Patch appliers, parameterized by graph so live and offline share them.
function setTrim(g, track, db, ramp) {
  if (ramp) g.trims[track].gain.rampTo(Tone.dbToGain(db), 0.05);
  else g.trims[track].gain.value = Tone.dbToGain(db);
}

// The output node carries ONLY the morph weight: the track source level is
// baked into the voices at construction (PolySynth constructor volume →
// voices; .volume writes → output node; they stack). sqrt(weight) amplitude
// = equal power across the pad; 10*log10(w) in dB.
const layerDb = (w) => 10 * Math.log10(Math.max(w, 1e-4));

function applyMorphTo(g, track, patch, { ramp = false } = {}) {
  const table = Object.values(PRESET_TABLES[track]);
  const w = cornerWeights(patch);
  g.layers[track].forEach((layer, i) => {
    const db = w[i] > 0.02 ? layerDb(w[i]) : -96;
    if (ramp) layer.volume.rampTo(db, 0.03);
    else layer.volume.value = db;
  });
  setTrim(g, track, blendLin(table.map((p) => p.gain), w), ramp);
  if (track === "harmony") {
    const filter = blendLog(table.map((p) => p.filter), w);
    g.padLfo.min = filter * 0.5;
    g.padLfo.max = filter * 1.5;
    g.chorus.set({ wet: blendLin(table.map((p) => p.chorusWet), w), depth: blendLin(table.map((p) => p.chorusDepth), w) });
  } else {
    const cutoff = blendLog(table.map((p) => p.cutoff), w);
    const node = track === "bass" ? g.bassFilter : g.leadFilter;
    if (ramp) node.frequency.rampTo(cutoff, 0.05);
    else node.frequency.value = cutoff;
    if (track === "bass") g.bassDrive.distortion = blendLin(table.map((p) => p.drive || 0), w);
  }
}

// Motion picks a tempo division; colors that pulse stay on the grid.
const MOTION_DIVISIONS = ["2n", "4n", "8n", "8t", "16n"];
const motionHz = (motion) => {
  const div = MOTION_DIVISIONS[Math.min(MOTION_DIVISIONS.length - 1, Math.floor(motion * MOTION_DIVISIONS.length))];
  return 1 / Tone.Time(div).toSeconds();
};

// Color registry. Everything here is plain-DSP on purpose: worklet-based
// effects (Tone's real BitCrusher) go silent inside Tone.Offline, and the
// export must stay identical to the live app. Each maker returns
// { nodes: [...serial chain...], updateColor(amount, motion) }.
const COLOR_MAKERS = {
  tape(amount, motion) {
    const vib = new Tone.Vibrato({ frequency: 0.4 + motion * 4.6, depth: 0.03 + amount * 0.22 });
    return {
      nodes: [vib],
      updateColor: (a, m) => {
        vib.frequency.value = 0.4 + m * 4.6;
        vib.depth.value = 0.03 + a * 0.22;
      },
    };
  },
  crush(amount) {
    // Waveshaper quantizer: bit depth from amount (8 -> 3 bits). No sample-
    // rate reduction, but cheap, deterministic, and offline-safe.
    const curve = (bits) => {
      const steps = Math.pow(2, bits - 1);
      return (x) => Math.round(x * steps) / steps;
    };
    const shaper = new Tone.WaveShaper(curve(8 - amount * 5), 1024);
    return { nodes: [shaper], updateColor: (a) => shaper.setMap(curve(8 - a * 5), 1024) };
  },
  phase(amount, motion) {
    const phaser = new Tone.Phaser({ frequency: 0.1 + motion * 1.9, octaves: 2 + amount * 3, baseFrequency: 300 });
    phaser.wet.value = Math.min(1, 0.3 + amount * 0.7);
    return {
      nodes: [phaser],
      updateColor: (a, m) => {
        phaser.frequency.value = 0.1 + m * 1.9;
        phaser.octaves = 2 + a * 3;
        phaser.wet.value = Math.min(1, 0.3 + a * 0.7);
      },
    };
  },
  trem(amount, motion) {
    // Chopping the signal costs duty-cycle energy; the makeup gain gives it
    // back so trem reads as movement, not a volume drop (measured ~4-5 dB).
    const tremolo = new Tone.Tremolo({ frequency: motionHz(motion), depth: 0.3 + amount * 0.7, spread: 60 }).start();
    const makeup = new Tone.Gain(Tone.dbToGain(1 + amount * 5));
    return {
      nodes: [tremolo, makeup],
      updateColor: (a, m) => {
        tremolo.frequency.value = motionHz(m);
        tremolo.depth.value = 0.3 + a * 0.7;
        makeup.gain.value = Tone.dbToGain(1 + a * 5);
      },
    };
  },
  wob(amount, motion) {
    const auto = new Tone.AutoFilter({
      frequency: motionHz(motion),
      baseFrequency: 120 + amount * 180,
      octaves: 2.5 + amount * 2,
    }).start();
    auto.wet.value = 1;
    return {
      nodes: [auto],
      updateColor: (a, m) => {
        auto.frequency.value = motionHz(m);
        auto.baseFrequency = 120 + a * 180;
        auto.octaves = 2.5 + a * 2;
      },
    };
  },
};

function applyColorTo(g, track, patch) {
  const type = patch.color;
  if (g.colorTypes[track] === type) {
    g.colorNodes[track]?.updateColor(patch.amount, patch.motion);
    return;
  }
  g.colorIn[track].disconnect();
  if (g.colorNodes[track]) {
    for (const n of g.colorNodes[track].nodes) n.dispose();
    g.colorNodes[track] = null;
  }
  if (type === "none" || !COLOR_MAKERS[type]) {
    g.colorIn[track].connect(g.colorDest[track]);
    g.colorTypes[track] = "none";
    return;
  }
  const made = COLOR_MAKERS[type](patch.amount, patch.motion);
  let prev = g.colorIn[track];
  for (const n of made.nodes) {
    prev.connect(n);
    prev = n;
  }
  prev.connect(g.colorDest[track]);
  g.colorNodes[track] = made;
  g.colorTypes[track] = type;
}

function applyPatchTo(g, track, patch, opts) {
  if (track !== "drums") applyMorphTo(g, track, patch, opts);
  applyColorTo(g, track, patch);
}

function applyKitTo(g, name) {
  const k = KITS[name] || KITS.garage;
  g.kick.set({ pitchDecay: k.kick.pitchDecay, octaves: k.kick.octaves, envelope: k.kick.envelope });
  g.snare.set({ envelope: { attack: 0.001, decay: k.snare, sustain: 0 } });
  g.hat.set({ envelope: { attack: 0.001, decay: k.hat.decay, sustain: 0 } });
  g.hatFilter.frequency.value = k.hat.resonance;
  g.clap.set({ envelope: { attack: 0.001, decay: k.clap, sustain: 0 } });
  g.kick.volume.value = SOURCE_LEVEL_DB.kick + k.gain;
  g.snare.volume.value = SOURCE_LEVEL_DB.snare + k.gain;
  g.hat.volume.value = SOURCE_LEVEL_DB.hat + k.gain;
  g.clap.volume.value = SOURCE_LEVEL_DB.clap + k.gain;
}

// --- Note triggers, parameterized by graph + patch state. vstate carries the
// voice-leading memory ({ prev }) so each render gets its own. Only layers
// carrying weight get triggered — silent corners cost nothing.
function eachActiveLayer(g, track, patch, fn) {
  const w = cornerWeights(patch);
  g.layers[track].forEach((layer, i) => {
    if (w[i] > 0.02) fn(layer);
  });
}

function playChordOn(g, patches, vstate, ci, time) {
  const voiced = voiceLead(CHORDS[ci].pcs, vstate.prev);
  vstate.prev = voiced;
  eachActiveLayer(g, "harmony", patches.harmony, (layer) => layer.triggerAttackRelease(voiced.map(midiToFreq), "1n", time));
  g.halo.triggerAttackRelease(midiToFreq(Math.max(...voiced) + 12), "1n", time);
  g.sub.triggerAttackRelease(midiToFreq(48 + CHORDS[ci].pcs[0]), "1n", time);
}

function playNoteStackOn(g, patches, track, slot, time) {
  const stretch = track === "bass" ? 1.1 : 1;
  const boostPreset = track === "bass" ? dominantCorner("bass", patches.bass) : null;
  for (const n of noteSlot(slot)) {
    let vel = n.vel ?? 0.9;
    if (track === "bass") vel *= bassVelocityBoost(boostPreset, n.midi);
    const dur = sixteenth() * (n.len || 1) * stretch;
    eachActiveLayer(g, track, patches[track], (layer) => layer.triggerAttackRelease(midiToFreq(n.midi), dur, time, vel));
  }
}

function hitDrumOn(g, v, time, vel = 0.9) {
  if (v === "kick") {
    scheduleKickDuck(g.musicDuck.gain, time);
    g.kick.triggerAttackRelease("C1", "8n", time, vel);
  } else if (v === "snare") g.snare.triggerAttackRelease("16n", time, vel);
  else if (v === "clap") g.clap.triggerAttackRelease("16n", time, vel);
  else g.hat.triggerAttackRelease("32n", time, vel);
}

// One arrangement step — shared by the live transport and the offline render.
// Returns the chord index when a new bar triggered one (for the UI), else null.
function playArrangementStepOn(g, patches, vstate, song, bar, stepInBar, time) {
  let chord = null;
  if (stepInBar === 0) {
    const h = clipAt(song, "harmony", bar);
    if (h) {
      const sc = song.scenes[h.scene];
      if (sc?.harmony?.length) {
        chord = sc.harmony[(bar - h.start) % sc.harmony.length];
        playChordOn(g, patches, vstate, chord, time);
      }
    }
  }
  const d = clipAt(song, "drums", bar);
  if (d) {
    const sc = song.scenes[d.scene];
    for (const v of DRUM_VOICES) if (sc.drums[v][stepInBar] > 0) hitDrumOn(g, v, time, sc.drums[v][stepInBar]);
  }
  for (const trk of ["bass", "melody"]) {
    const c = clipAt(song, trk, bar);
    if (c) playNoteStackOn(g, patches, trk, song.scenes[c.scene][trk][stepInBar], time);
  }
  return chord;
}

export function createAudio(song) {
  // Favor throughput over latency on weak mobile CPUs — a bigger buffer absorbs
  // CPU jitter and prevents xruns. Must be set before any node is created.
  Tone.setContext(new Tone.Context({ latencyHint: "playback" }));
  // setContext swaps the active context, so the clock loop below binds to the
  // NEW context's transport. The deprecated Tone.Transport / Tone.Draw globals
  // still point at the original context — driving playback through them starts a
  // transport the loop isn't on (silent, no playhead). Bind to the live context.
  const transport = Tone.getTransport();
  const draw = Tone.getDraw();
  // Beat-synced visuals fire on the transport clock, but the sound reaches
  // the ear an output-latency later (large under latencyHint:"playback",
  // larger again on Bluetooth). Shift them so the eye and the ear agree.
  const scheduleDraw = (cb, time) => {
    const raw = Tone.getContext().rawContext;
    draw.schedule(cb, time + (raw.outputLatency || raw.baseLatency || 0));
  };

  const live = buildGraph({ meters: true });
  let kitName = "clean";
  const patches = Object.fromEntries(TRACK_KEYS.map((t) => [t, defaultPatch(t)]));
  applyKitTo(live, kitName);
  for (const t of TRACK_KEYS) applyPatchTo(live, t, patches[t]);

  const channelState = Object.fromEntries(TRACK_KEYS.map((track) => [track, {
    vol: DEFAULT_TRACK_VOLUME_DB,
    pan: 0,
    verb: SEND_OFF_DB,
    echo: SEND_OFF_DB,
    mute: false,
    solo: false,
  }]));
  function applyTrackGates() {
    const anySolo = TRACK_KEYS.some((track) => channelState[track].solo);
    for (const track of TRACK_KEYS) {
      live.channels[track].mute = channelState[track].mute || (anySolo && !channelState[track].solo);
    }
  }

  const liveVoice = { prev: null };
  const playChord = (ci, time) => playChordOn(live, patches, liveVoice, ci, time);
  const playNoteStack = (track, slot, time) => playNoteStackOn(live, patches, track, slot, time);
  const hitDrum = (v, time, vel) => hitDrumOn(live, v, time, vel);
  function preview(ci) {
    const voiced = voiceLead(CHORDS[ci].pcs, liveVoice.prev);
    eachActiveLayer(live, "harmony", patches.harmony, (layer) => layer.triggerAttackRelease(voiced.map(midiToFreq), "2n", Tone.now()));
    live.sub.triggerAttackRelease(midiToFreq(48 + CHORDS[ci].pcs[0]), "2n", Tone.now());
  }

  // Transport.
  let mode = "scene";
  let focusIndex = 0;
  let curScene = 0;
  const trackState = Object.fromEntries(TRACK_KEYS.map((track) => [track, { scene: 0, step: 0, active: true }]));
  let arrStep = 0;
  const queuedTracks = Object.fromEntries(TRACK_KEYS.map((track) => [track, -1]));
  let visualCb = () => {};

  transport.bpm.value = song.tempo;
  transport.swingSubdivision = "16n";
  transport.swing = song.swing ?? 0;

  function tickArrangement(time) {
    const len = arrangeLength(song);
    const bar = Math.floor(arrStep / 16);
    const stepInBar = arrStep % 16;
    const chord = playArrangementStepOn(live, patches, liveVoice, song, bar, stepInBar, time);
    if (chord !== null) scheduleDraw(() => visualCb({ type: "arrchord", bar, chord }), time);
    scheduleDraw(() => visualCb({ type: "arr", bar, stepInBar, len }), time);
    arrStep += 1;
    const loop = song.loop;
    if (loop && loop.on) {
      const s0 = loop.start * 16;
      const s1 = (loop.start + loop.len) * 16;
      if (arrStep >= s1 || arrStep < s0) arrStep = s0;
    } else if (arrStep >= len * 16) {
      arrStep = 0;
    }
  }

  function activeScenes() {
    return Object.fromEntries(TRACK_KEYS.map((track) => [track, trackState[track].active ? trackState[track].scene : -1]));
  }

  function getQueuedTracks() {
    return Object.fromEntries(TRACK_KEYS.map((track) => [track, queuedTracks[track]]));
  }

  function getTrackProgress() {
    const res = {};
    for (const track of TRACK_KEYS) {
      const st = trackState[track];
      if (st.active && song.scenes[st.scene]) {
        const scene = song.scenes[st.scene];
        const launch = clipLaunch(scene, track);
        const naturalBars = clipLengthBars(scene, track);
        const limitBars = launch.follow !== "none" ? launch.followBars : naturalBars;
        // Completion of the sounding step, not elapsed-at-its-start: the UI
        // sweeps toward this value, so the pie reaches 100% exactly when the
        // loop wraps instead of resetting from 15/16ths full.
        res[track] = (st.step + 1) / (limitBars * 16);
      }
    }
    return res;
  }

  function resetTrack(track, sceneIndex) {
    trackState[track] = { scene: sceneIndex, step: 0, active: !!song.scenes[sceneIndex] };
  }

  function targetScene(sceneIndex, follow) {
    const count = song.scenes.length;
    if (count <= 0) return -1;
    if (follow === "next") return (sceneIndex + 1) % count;
    if (follow === "prev") return (sceneIndex - 1 + count) % count;
    if (follow === "random") {
      if (count === 1) return sceneIndex;
      let next = sceneIndex;
      while (next === sceneIndex) next = Math.floor(Math.random() * count);
      return next;
    }
    return -1;
  }

  function advanceSceneTrack(track) {
    const st = trackState[track];
    if (!st.active) return;
    const scene = song.scenes[st.scene];
    if (!scene) {
      st.active = false;
      return;
    }
    const launch = clipLaunch(scene, track);
    const naturalBars = clipLengthBars(scene, track);
    const limitBars = launch.follow !== "none" ? launch.followBars : naturalBars;
    st.step += 1;
    if (st.step < limitBars * 16) return;
    const nextScene = targetScene(st.scene, launch.follow);
    if (nextScene >= 0) {
      resetTrack(track, nextScene);
      return;
    }
    if (launch.mode === "oneshot") {
      st.step = 0;
      st.active = false;
    } else {
      st.step = 0;
    }
  }

  const clock = new Tone.Loop((time) => {
    if (mode === "arrangement") return tickArrangement(time);

    let maxLimitBars = 1;
    let maxStep = 0;
    let anyActive = false;
    for (const track of TRACK_KEYS) {
      const st = trackState[track];
      if (st.active && song.scenes[st.scene]) {
        anyActive = true;
        const launch = clipLaunch(song.scenes[st.scene], track);
        const limitBars = launch.follow !== "none" ? launch.followBars : clipLengthBars(song.scenes[st.scene], track);
        if (limitBars >= maxLimitBars) {
          maxLimitBars = limitBars;
          maxStep = st.step;
        }
      }
    }

    if (!anyActive || maxStep === 0) {
      for (const track of TRACK_KEYS) {
        if (queuedTracks[track] >= 0) {
          resetTrack(track, queuedTracks[track]);
          queuedTracks[track] = -1;
        }
      }
    }

    const activeBefore = activeScenes();
    const harmonyState = trackState.harmony;
    const harmonyScene = harmonyState.active ? song.scenes[harmonyState.scene] : null;
    let visualStep = 0;
    let visualBar = 0;
    if (harmonyScene?.harmony?.length) {
      const stepInBar = harmonyState.step % 16;
      const bar = Math.floor(harmonyState.step / 16) % harmonyScene.harmony.length;
      visualStep = stepInBar;
      visualBar = bar;
      if (stepInBar === 0) {
        const ci = harmonyScene.harmony[bar];
        playChord(ci, time);
        scheduleDraw(() => visualCb({ type: "chord", scene: harmonyState.scene, bar, chord: ci, activeScenes: activeBefore }), time);
      }
    }

    const drumState = trackState.drums;
    const drumScene = drumState.active ? song.scenes[drumState.scene] : null;
    if (drumScene) {
      const stepInBar = drumState.step % 16;
      for (const v of DRUM_VOICES) {
        if (drumScene.drums[v][stepInBar] > 0) {
          hitDrum(v, time, drumScene.drums[v][stepInBar]);
          scheduleDraw(() => visualCb({ type: "hit", scene: drumState.scene, voice: v, step: stepInBar, activeScenes: activeBefore }), time);
        }
      }
    }

    for (const track of ["bass", "melody"]) {
      const st = trackState[track];
      const scene = st.active ? song.scenes[st.scene] : null;
      if (!scene) continue;
      const stepInBar = st.step % 16;
      playNoteStack(track, scene[track][stepInBar], time);
    }

    const progressCurrent = getTrackProgress();
    const queuedCurrent = getQueuedTracks();
    scheduleDraw(() => visualCb({ type: "step", scene: curScene, localStep: visualBar * 16 + visualStep, stepInBar: visualStep, bar: visualBar, activeScenes: activeBefore, queuedTracks: queuedCurrent, progress: progressCurrent }), time);
    for (const track of TRACK_KEYS) advanceSceneTrack(track);
  }, "16n");

  let playing = false;
  let inited = false;

  return {
    async init() {
      if (inited) return;
      inited = true;
      await Tone.start();
      if (Tone.getContext().state !== "running") await Tone.getContext().resume();
      // Prime the hardware audio pipeline with a near-silent impulse so the
      // first real notes aren't swallowed by the OS/browser ramp-up.
      const ctx = Tone.getContext().rawContext;
      const primer = ctx.createOscillator();
      const primerGain = ctx.createGain();
      primerGain.gain.value = 0.001;
      primer.connect(primerGain);
      primerGain.connect(ctx.destination);
      primer.start();
      await wait(150);
      primer.stop();
      primer.disconnect();
      primerGain.disconnect();
      await wait(FIRST_PLAY_WARMUP_MS);
      if (live.reverb.ready) await live.reverb.ready;
      clock.start(0);
    },
    play() {
      transport.start(PLAY_START_LEAD_TIME);
      playing = true;
    },
    stop() {
      transport.pause();
      playing = false;
      // Immediately silence all voices so pause feels instant
      for (const t of MELODIC_TRACKS) {
        for (const layer of live.layers[t]) {
          try { layer.releaseAll(Tone.now()); } catch {}
        }
      }
      try { live.halo.triggerRelease(Tone.now()); } catch {}
      try { live.sub.triggerRelease(Tone.now()); } catch {}
      liveVoice.prev = null;
      for (const track of TRACK_KEYS) queuedTracks[track] = -1; // clear queues on stop
      draw.schedule(() => visualCb({ type: "queue", activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }), Tone.now());
    },
    get playing() {
      return playing;
    },
    launchScene(index) {
      mode = "scene";
      focusIndex = index;
      if (!playing) {
        curScene = index;
        for (const track of TRACK_KEYS) resetTrack(track, index);
        for (const track of TRACK_KEYS) queuedTracks[track] = -1;
        draw.schedule(() => visualCb({ type: "step", scene: index, localStep: 0, stepInBar: 0, bar: 0, activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }), Tone.now());
        this.play();
      } else {
        curScene = index;
        for (const track of TRACK_KEYS) queuedTracks[track] = index;
        draw.schedule(() => visualCb({ type: "queue", activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }), Tone.now());
      }
    },
    launchClip(index, track) {
      mode = "scene";
      focusIndex = index;
      if (!playing) {
        curScene = index;
        for (const key of TRACK_KEYS) trackState[key].active = false;
        for (const key of TRACK_KEYS) queuedTracks[key] = -1;
        resetTrack(track, index);
        draw.schedule(() => visualCb({ type: "step", scene: index, localStep: 0, stepInBar: 0, bar: 0, activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }), Tone.now());
        this.play();
      } else {
        queuedTracks[track] = index;
        draw.schedule(() => visualCb({ type: "queue", activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }), Tone.now());
      }
    },
    playArrangement(fromBar = 0) {
      mode = "arrangement";
      arrStep = Math.max(0, fromBar) * 16;
      if (!playing) this.play();
    },
    setArrangePos(bar) {
      arrStep = Math.max(0, bar) * 16;
    },
    enterArrangement() {
      mode = "arrangement";
    },
    get mode() {
      return mode;
    },
    setTempo(bpm) {
      transport.bpm.rampTo(bpm, 0.1);
      // Tempo-synced colors (trem/wob) chase the new grid.
      for (const t of TRACK_KEYS) live.colorNodes[t]?.updateColor?.(patches[t].amount, patches[t].motion);
    },
    setSwing(v) {
      transport.swing = v;
    },
    preview,
    previewHit(v) {
      hitDrum(v, Tone.now());
    },
    previewNote(track, midi) {
      playNoteStack(track, [{ midi, len: 1, vel: 0.9 }], Tone.now());
    },
    // --- mixer ---
    setVol(track, db) {
      channelState[track].vol = db;
      live.channels[track].volume.value = db;
    },
    setPan(track, p) {
      channelState[track].pan = p;
      live.channels[track].pan.value = p;
    },
    setSend(track, db) {
      channelState[track].verb = db;
      live.verbSends[track].gain.rampTo(sendGain(db), 0.02);
    },
    setEcho(track, db) {
      channelState[track].echo = db;
      live.echoSends[track].gain.rampTo(sendGain(db), 0.02);
    },
    setMute(track, on) {
      if (!channelState[track]) return;
      channelState[track].mute = !!on;
      applyTrackGates();
    },
    setSolo(track, on) {
      if (!channelState[track]) return;
      channelState[track].solo = !!on;
      applyTrackGates();
    },
    meter(track) {
      const m = track === "master" ? live.masterMeter : live.meters[track];
      const v = m.getValue();
      return typeof v === "number" ? v : Math.max(...v);
    },
    // --- devices: patches ---
    patch(track) {
      return { ...patches[track] };
    },
    setPatch(track, partial) {
      patches[track] = normalizePatch(track, { ...patches[track], ...partial });
      applyPatchTo(live, track, patches[track], { ramp: true });
      return { ...patches[track] };
    },
    // Corner-name compatibility: the dropdowns, project files from v1, and the
    // register rules all speak preset names. A name is just a corner of the pad.
    kit: () => kitName,
    setKit(name) {
      if (KITS[name]) kitName = name;
      applyKitTo(live, kitName);
    },
    harmonyPreset: () => dominantCorner("harmony", patches.harmony),
    setHarmonyPreset(name) {
      this.setPatch("harmony", cornerXY("harmony", name));
    },
    bassPreset: () => dominantCorner("bass", patches.bass),
    setBassPreset(name) {
      this.setPatch("bass", cornerXY("bass", name));
    },
    melodyPreset: () => dominantCorner("melody", patches.melody),
    setMelodyPreset(name) {
      this.setPatch("melody", cornerXY("melody", name));
    },
    onVisual(cb) {
      visualCb = cb;
    },
    // --- offline WAV render: the same buildGraph as live, driven linearly ---
    async renderOffline(soloTrack) {
      const totalBars = arrangeLength(song);
      const barSec = 240 / song.tempo;
      const dur = totalBars * barSec + 2;
      const patchesCopy = structuredClone(patches);
      const buffer = await Tone.Offline(({ transport: offTr }) => {
        offTr.bpm.value = song.tempo;
        offTr.swing = song.swing ?? 0;
        offTr.swingSubdivision = "16n";
        const g = buildGraph({ meters: false });
        applyKitTo(g, kitName);
        for (const t of TRACK_KEYS) applyPatchTo(g, t, patchesCopy[t]);
        const anySolo = TRACK_KEYS.some((track) => channelState[track].solo);
        for (const k of TRACK_KEYS) {
          const st = channelState[k];
          const muted = soloTrack ? k !== soloTrack : st.mute || (anySolo && !st.solo);
          g.channels[k].set({ volume: muted ? -Infinity : st.vol, pan: st.pan, mute: muted });
          g.verbSends[k].gain.value = sendGain(st.verb);
          g.echoSends[k].gain.value = sendGain(st.echo);
        }
        const vstate = { prev: null };
        let step = 0;
        new Tone.Loop((time) => {
          const bar = Math.floor(step / 16);
          if (bar >= totalBars) return;
          playArrangementStepOn(g, patchesCopy, vstate, song, bar, step % 16, time);
          step += 1;
        }, "16n").start(0);
        offTr.start(0);
      }, dur);
      return buffer;
    },
  };
}
