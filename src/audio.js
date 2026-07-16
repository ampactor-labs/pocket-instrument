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
import { CHORDS, DRUM_VOICES, voiceLead, clipAt, arrangeLength, clipLaunch, clipLengthBars, noteSlot, stepsFor } from "./model.js";

// Per-track swing: offbeat lane steps get delayed by up to a third of a 16th
// (1.0 = full triplet feel). Each track reads its own amount, falling back to
// the global groove — the transport's built-in swing is retired so drums can
// sit in a different pocket than the bass. The 16th comes straight from
// song.tempo: a cached transport lookup only refreshed when a melodic note
// played, so drums-only grooves swung on the wrong tempo.
const swingOffsetFor = (song, track, laneStep) =>
  laneStep % 2 === 1 ? ((((song.trackSwing?.[track] ?? song.swing) || 0) * (15 / song.tempo)) / 3) : 0;

// Debug handle for the headless harnesses; lets calibrate/smoke experiments
// build minimal Tone graphs without reaching into the bundle.
if (typeof window !== "undefined") window.__noodlesTone = Tone;

const midiToFreq = (m) => Tone.Frequency(m, "midi").toFrequency();
const sixteenth = () => Tone.Time("16n").toSeconds();

export const TRACK_KEYS = ["harmony", "drums", "bass", "melody"];
export const MELODIC_TRACKS = ["harmony", "bass", "melody"];

const DEFAULT_TRACK_VOLUME_DB = -6;
const SEND_OFF_DB = -60;
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

// Cut [startSec, endSec) out of a rendered buffer into a fresh AudioBuffer —
// used to keep the second cycle of a seamless loop render.
function sliceBuffer(buf, startSec, endSec) {
  const sr = buf.sampleRate;
  const ch = buf.numberOfChannels;
  const start = Math.max(0, Math.floor(startSec * sr));
  const end = Math.min(buf.length, Math.floor(endSec * sr));
  const out = new AudioBuffer({ length: Math.max(1, end - start), numberOfChannels: ch, sampleRate: sr });
  for (let c = 0; c < ch; c++) out.copyToChannel(buf.getChannelData(c).subarray(start, end), c);
  return out;
}

function scheduleKickDuck(param, time) {
  // Hold whatever the gain is at the kick instant: resetting to 1 first put a
  // +12 dB step on the music bus at the head of every kick — a tick on
  // sustained pads, worst on dense patterns where the bus never fully recovers.
  param.cancelAndHoldAtTime(time);
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
  // The fourth corner: trap/808 register — long boomy kick, crisp tight hats,
  // fat snare/clap tails. Gives the kit pad its BR corner and the dice a
  // heavier place to land.
  heavy: {
    kick: { pitchDecay: 0.08, octaves: 7, envelope: { attack: 0.001, decay: 0.7, sustain: 0 } },
    snare: 0.22,
    hat: { decay: 0.012, resonance: 9000 },
    clap: 0.18,
    gain: -5,
  },
};
export const KIT_NAMES = Object.keys(KITS);

// The sample bank: real one-shots, generated by scripts/make-samples.mjs and
// bundled under samples/. Four kits as morph corners, same pad as everything
// else — morphing crossfades the top-2 kits' one-shots per hit. gain values
// are measured trims (npm run calibrate) like every other corner table.
const SAMPLE_KITS = {
  street: { gain: -2.5 },
  warm: { gain: -4.5 },
  dusty: { gain: -6.5 },
  "808": { gain: -7.5 },
};
// NOT Object.keys(SAMPLE_KITS): "808" is an integer-like key and JS
// enumerates those first, which silently rotated the corner map once.
export const SAMPLE_KIT_NAMES = ["street", "warm", "dusty", "808"];
// Voice balance inside the sample bank (one-shots are peak-normalized, so
// musical balance is set here, then verified by the calibrate drum stems).
const SAMPLE_VOICE_DB = { kick: 0, snare: -2, hat: -8, clap: -5 };
// Conditioning targets for user-recorded one-shots: the median per-voice RMS
// of the bundled library INCLUDING each kit's trim (measured, .tmp receipt).
// A mouth-boom lands at library loudness by construction, not by luck.
const USER_TARGET_RMS_DB = { kick: -14, snare: -17, hat: -27, clap: -23 };
export const DRUM_BANKS = ["sample", "synth"];

const sampleBuffers = {};
let samplesReady = false;
let samplesLoading = null;
function loadSamples() {
  if (samplesLoading) return samplesLoading;
  const base = import.meta.env?.BASE_URL || "/";
  samplesLoading = Promise.allSettled(
    SAMPLE_KIT_NAMES.flatMap((kit) =>
      DRUM_VOICES.map(
        (voice) =>
          new Promise((resolve, reject) => {
            const buffer = new Tone.ToneAudioBuffer(
              `${base}samples/${kit}-${voice}.wav`,
              () => {
                (sampleBuffers[kit] ||= {})[voice] = buffer;
                resolve();
              },
              reject
            );
          })
      )
    )
  ).then((results) => {
    samplesReady = results.some((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) console.warn(`noodles: ${failed} drum samples failed to load; synth kit covers the gaps`);
  });
  return samplesLoading;
}

// User-loaded one-shots, one per voice, session-scoped.
const userSamples = {};

// Condition a raw take into a one-shot that sits beside the bundled library:
// find the onset, trim the room before it and the noise after it, fade the
// edges, cap at 1.5 s, and normalize to the voice's library RMS target under
// a -1 dBFS peak ceiling (peak-normalizing alone left the level hostage to
// the take's crest factor). This is the difference between "cute demo" and a
// mouth-boom that actually knocks.
function conditionOneShot(voice, audioBuf) {
  const sr = audioBuf.sampleRate;
  const src = audioBuf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < src.length; i++) peak = Math.max(peak, Math.abs(src[i]));
  if (peak < 0.003) throw new Error("too quiet");
  const startThresh = peak * 0.12;
  let start = 0;
  while (start < src.length && Math.abs(src[start]) < startThresh) start++;
  start = Math.max(0, start - Math.floor(0.003 * sr));
  const tailThresh = peak * 0.02;
  let end = src.length - 1;
  while (end > start && Math.abs(src[end]) < tailThresh) end--;
  end = Math.min(src.length, end + Math.floor(0.02 * sr));
  const len = Math.min(end - start, Math.floor(1.5 * sr));
  if (len < Math.floor(0.01 * sr)) throw new Error("too short");
  const out = Tone.getContext().rawContext.createBuffer(1, len, sr);
  const dst = out.getChannelData(0);
  let localPeak = 0;
  let sumSq = 0;
  for (let i = 0; i < len; i++) {
    dst[i] = src[start + i];
    localPeak = Math.max(localPeak, Math.abs(dst[i]));
    sumSq += dst[i] * dst[i];
  }
  const rms = Math.sqrt(sumSq / len) || 1e-6;
  const target = Math.pow(10, (USER_TARGET_RMS_DB[voice] ?? -17) / 20);
  const gain = Math.min(target / rms, 0.891 / (localPeak || 1));
  const fadeIn = Math.floor(0.002 * sr);
  const fadeOut = Math.min(Math.floor(0.02 * sr), Math.floor(len / 4));
  for (let i = 0; i < len; i++) {
    let v = dst[i] * gain;
    if (i < fadeIn) v *= i / fadeIn;
    if (i >= len - fadeOut) v *= (len - i) / fadeOut;
    dst[i] = v;
  }
  return out;
}

// Corner order = table order, laid out TL, TR, BL, BR on the XY pad. Drums
// morph too: the synth bank blends kit scalars, the sample bank crossfades
// one-shots.
export const CORNERS = {
  harmony: HARMONY_PRESET_NAMES,
  bass: BASS_PRESET_NAMES,
  melody: MELODY_PRESET_NAMES,
  drums: KIT_NAMES,
};
export const drumCornerNames = (patch) => (patch.bank === "synth" ? KIT_NAMES : SAMPLE_KIT_NAMES);

// --- Patch specs: { x, y, color, amount, motion } for every track; drums add
// bank ("sample" | "synth") and pins ({ voice: sampleName | "user" }). ---
export function defaultPatch(track) {
  const p = { x: 0, y: 0, color: "none", amount: 0.5, motion: 0.5 };
  if (track === "drums") {
    p.bank = "sample";
    p.pins = {};
  }
  return p;
}

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function normalizePatch(track, raw = {}) {
  const p = { ...defaultPatch(track), ...raw };
  p.color = COLOR_NAMES.includes(p.color) ? p.color : "none";
  p.amount = clamp01(p.amount);
  p.motion = clamp01(p.motion);
  p.x = clamp01(p.x);
  p.y = clamp01(p.y);
  if (track === "drums") {
    p.bank = DRUM_BANKS.includes(p.bank) ? p.bank : "sample";
    const pins = {};
    for (const v of DRUM_VOICES) {
      const pin = p.pins?.[v];
      if (typeof pin === "string" && pin) pins[v] = pin;
    }
    p.pins = pins;
  }
  return p;
}

// Bilinear corner weights for a point in the pad.
function cornerWeights(patch) {
  const { x, y } = patch;
  return [(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y];
}

// The voices that actually get triggered: the two heaviest corners,
// renormalized to constant power. The ear tracks the nearest corners; the
// other two still shape the sound through the blended filter/drive/envelope
// params, which cost nothing. This caps the morph's voice bill at 2x a
// single synth instead of 4x — the difference between a Dimensity 6300
// keeping up and choking.
function activeLayerWeights(patch) {
  const w = cornerWeights(patch);
  const kept = [0, 1, 2, 3]
    .filter((i) => w[i] > 0.02)
    .sort((a, b) => w[b] - w[a])
    .slice(0, 2);
  const sum = kept.reduce((s, i) => s + w[i], 0) || 1;
  return kept.map((i) => ({ i, w: w[i] / sum }));
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
// render. Nodes bind to whichever Tone context is active at call time.
// Two grades, uniform across devices (DECISIONS D10): the LIVE graph trades
// polish the ear can't hold onto mid-jam for audio-thread headroom the A16
// measurably lacks (aud×0.92 on wet rolls); the EXPORT graph renders the
// full chain. Everything that carries the feel — master stack, comps, duck,
// morphing, levels — is identical in both. ---
function buildGraph({ meters = false, exportGrade = false } = {}) {
  const g = {};
  g.exportGrade = exportGrade;

  // Master chain: gain → rumble HP → low shelf → saturation → soft clip →
  // glue comp → makeup → soft-knee ceiling → brickwall. The goal is
  // translation: shine on a
  // phone AND on big Bluetooth speakers, without tuning for either at the
  // other's expense. Two things carry the low end so it reads on both. The
  // shelf adds a moderate +2 dB around 100 Hz — real weight for speakers that
  // move air, but short of the boom that overwhelms a sub or muddies a laptop.
  // And it sits BEFORE the saturation on purpose: the drive turns that low end
  // into harmonics up at 120/180/240 Hz, so a small speaker that can't
  // reproduce the fundamental still hears the bass implied. Same low end, heard
  // two ways — not a big-rig boost the phone pays for.
  // The glue at 3:1 is a bus glue, not a squash — it moves the mix as one and
  // leaves crest for the kick to punch through. The maximizer-style ceiling
  // (DECISIONS D7): kick transients used to overshoot the limiter by up to
  // +10 dB and hard-clip at the DAC; now anything past the -4.4 dBFS knee
  // saturates smoothly into a 0.98 ceiling instead — transparent below the
  // knee, warm crack above it. The 0.25 pre-scale maps ±4 of true amplitude
  // into the shaper's ±1 domain so overshoots land on the curve, not its
  // clamped endpoints.
  g.masterLimiter = new Tone.Limiter(-2).toDestination();
  const CEIL = 0.98;
  const KNEE = 0.6;
  g.ceiling = new Tone.WaveShaper((x) => {
    const a = x * 4;
    const mag = Math.abs(a);
    const out = mag < KNEE ? mag : KNEE + (CEIL - KNEE) * Math.tanh((mag - KNEE) / (CEIL - KNEE));
    return Math.sign(a) * Math.min(out, CEIL);
  }, 4096).connect(g.masterLimiter);
  g.ceilingScale = new Tone.Gain(0.25).connect(g.ceiling);
  g.makeupGain = new Tone.Gain(Tone.dbToGain(8)).connect(g.ceilingScale);
  g.glue = new Tone.Compressor({ threshold: -20, ratio: 3, attack: 0.03, release: 0.25, knee: 12 }).connect(g.makeupGain);
  g.softClip = new Tone.WaveShaper((x) => Math.tanh(x * 1.2) / Math.tanh(1.2), 2048).connect(g.glue);
  g.saturation = new Tone.Distortion(0.14).connect(g.softClip);
  g.saturation.wet.value = 0.42;
  g.lowShelf = new Tone.Filter({ type: "lowshelf", frequency: 100, gain: 2 }).connect(g.saturation);
  // Subsonic guard: the piano roll reaches C0 (16 Hz) and the bass lane HP at
  // 34 Hz only takes ~14 dB off it — what's left rides into the limiter as
  // headroom loss no speaker gives back. 18 Hz leaves a 30 Hz 808 fundamental
  // essentially untouched (≈ -0.5 dB).
  g.rumbleHP = new Tone.Filter({ type: "highpass", frequency: 18, Q: 0.7 }).connect(g.lowShelf);
  g.master = new Tone.Gain(Tone.dbToGain(-2.5)).connect(g.rumbleHP);

  // Everything melodic passes through the kick-side duck; drums get a dry bus
  // plus a parallel-compressed return for weight.
  g.musicDuck = new Tone.Gain(1).connect(g.master);
  g.drumBus = new Tone.Gain(1).connect(g.master);
  g.drumDry = new Tone.Gain(Tone.dbToGain(-1)).connect(g.drumBus);
  g.drumParallel = new Tone.Compressor({ threshold: -24, ratio: 4.5, attack: 0.004, release: 0.13, knee: 12 });
  g.drumParallelReturn = new Tone.Gain(DRUM_PARALLEL_GAIN).connect(g.drumBus);
  g.drumParallel.connect(g.drumParallelReturn);

  // Sends. Algorithmic (Freeverb) instead of convolution — far cheaper per
  // sample on a low-end mobile CPU, and fine for a send reverb. The highpass
  // on the reverb input keeps kicks and 808 subs out of the tail: reverberant
  // low end reads as mud, not space. The echo carries the same highpass, a
  // touch lower, so its repeats don't pile low-end into the feedback loop.
  // Both returns land on the duck bus, not the master: a wet tail that skips
  // the sidechain fills the exact pocket the kick just carved.
  // reverbOut is whatever node feeds the duck bus — the edge the dry park
  // cuts, in either grade.
  if (exportGrade) {
    g.reverb = new Tone.Freeverb({ roomSize: 0.72, dampening: 2600, wet: 1 }).connect(g.musicDuck);
    g.reverbOut = g.reverb;
  } else {
    // Half a Freeverb for the live grade: four of its eight combs (same
    // Schroeder tunings, same dampening register, resonance a touch up to
    // hold tail length), split two-per-side for width. The +4.5 dB makeup is
    // measured against the full Freeverb on the wet reference (.tmp probe)
    // so a send level chosen live translates to the export.
    g.reverb = new Tone.Gain(1);
    g.reverbOut = new Tone.Gain(Tone.dbToGain(4.5)).connect(g.musicDuck);
    const tunings = [0.0253, 0.02896, 0.03224, 0.03667];
    tunings.forEach((delayTime, i) => {
      // Native feedback combs, NOT Tone.LowpassCombFilter: that class is an
      // AudioWorklet whose processor runs its JS on the audio thread FOREVER
      // once constructed — process() returns !disposed — connected or not.
      // A DelayNode inside the loop makes the cycle legal, and native nodes
      // truly stop when unreachable, so a parked verb costs zero.
      const sum = new Tone.Gain(1);
      const delay = new Tone.Delay({ delayTime, maxDelay: 0.05 });
      const damp = new Tone.Filter({ type: "lowpass", frequency: 2600, Q: 0.5 });
      const fb = new Tone.Gain(0.78);
      g.reverb.connect(sum);
      sum.connect(delay);
      delay.connect(damp);
      damp.connect(fb);
      fb.connect(sum);
      const pan = new Tone.Panner(i % 2 === 0 ? -0.6 : 0.6).connect(g.reverbOut);
      damp.connect(pan);
    });
  }
  g.reverbHP = new Tone.Filter({ type: "highpass", frequency: 200, Q: 0.7 }).connect(g.reverb);
  g.echo = new Tone.FeedbackDelay({ delayTime: "8n", feedback: 0.26, wet: 1 }).connect(g.musicDuck);
  g.echoHP = new Tone.Filter({ type: "highpass", frequency: 160, Q: 0.7 }).connect(g.echo);
  g.echoReturn = new Tone.Gain(Tone.dbToGain(-4)).connect(g.echoHP);

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
    g.verbSends[k] = new Tone.Gain(0).connect(g.reverbHP);
    g.channels[k].connect(g.verbSends[k]);
    g.echoSends[k] = new Tone.Gain(0).connect(g.echoReturn);
    g.channels[k].connect(g.echoSends[k]);
    if (meters) {
      // Waveform analysers instead of Tone.Meter: one buffer read yields BOTH
      // RMS (the perceived-level body) and instantaneous peak, Ableton-style.
      g.meters[k] = new Tone.Analyser({ type: "waveform", size: 256 });
      (k === "drums" ? g.drumBus : g.channels[k]).connect(g.meters[k]);
    }
  }
  if (meters) {
    g.masterMeter = new Tone.Analyser({ type: "waveform", size: 256 });
    g.masterLimiter.connect(g.masterMeter);
  }

  // Color insert points: everything a track makes flows through colorIn, and
  // applyColorTo splices the selected effect between colorIn and colorDest.
  // trackOut is whichever node currently feeds colorDest (colorIn, or the
  // color chain's last node) — the one edge the track park cuts to take the
  // whole source side out of the rendered graph.
  g.colorIn = {};
  g.colorDest = {};
  g.colorNodes = {};
  g.colorTypes = {};
  g.trackOut = {};
  for (const k of TRACK_KEYS) {
    g.colorIn[k] = new Tone.Gain(1);
    g.colorDest[k] = k === "drums" ? g.channels.drums : g.inputs[k];
    g.colorIn[k].connect(g.colorDest[k]);
    g.trackOut[k] = g.colorIn[k];
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
  g.bassLayers = makeLayers(BASS_PRESETS, 4, g.bassDrive, SOURCE_LEVEL_DB.bass);
  g.leadHighpass = new Tone.Filter({ type: "highpass", frequency: 180, Q: 0.7 }).connect(g.colorIn.melody);
  g.leadFilter = new Tone.Filter({ type: "lowpass", frequency: 3200, Q: 0.6 }).connect(g.leadHighpass);
  g.leadLayers = makeLayers(MELODY_PRESETS, 5, g.leadFilter, SOURCE_LEVEL_DB.melody);
  g.layers = { harmony: g.padLayers, bass: g.bassLayers, melody: g.leadLayers };

  // Sample playback lands here: one static gain per voice, straight into the
  // drum color junction. The one-shots are pre-shaped, so they skip the
  // synth-shaping filters below.
  g.sampleGains = {};
  for (const v of DRUM_VOICES) {
    g.sampleGains[v] = new Tone.Gain(Tone.dbToGain(SAMPLE_VOICE_DB[v])).connect(g.colorIn.drums);
  }

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
function setTrim(g, track, db, ramp, at) {
  if (ramp) g.trims[track].gain.rampTo(Tone.dbToGain(db), 0.05, at);
  else g.trims[track].gain.value = Tone.dbToGain(db);
}

// The output node carries ONLY the morph weight: the track source level is
// baked into the voices at construction (PolySynth constructor volume →
// voices; .volume writes → output node; they stack). sqrt(weight) amplitude
// = equal power across the pad; 10*log10(w) in dB.
const layerDb = (w) => 10 * Math.log10(Math.max(w, 1e-4));

function applyMorphTo(g, track, patch, { ramp = false, at } = {}) {
  const table = Object.values(PRESET_TABLES[track]);
  const w = cornerWeights(patch);
  const active = activeLayerWeights(patch);
  g.layers[track].forEach((layer, i) => {
    const entry = active.find((a) => a.i === i);
    const db = entry ? layerDb(entry.w) : -96;
    if (ramp) layer.volume.rampTo(db, 0.03, at);
    else layer.volume.value = db;
  });
  setTrim(g, track, blendLin(table.map((p) => p.gain), w), ramp, at);
  if (track === "harmony") {
    const filter = blendLog(table.map((p) => p.filter), w);
    g.padLfo.min = filter * 0.5;
    g.padLfo.max = filter * 1.5;
    g.chorus.set({ wet: blendLin(table.map((p) => p.chorusWet), w), depth: blendLin(table.map((p) => p.chorusDepth), w) });
  } else {
    const cutoff = blendLog(table.map((p) => p.cutoff), w);
    const node = track === "bass" ? g.bassFilter : g.leadFilter;
    if (ramp) node.frequency.rampTo(cutoff, 0.05, at);
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
  phase(amount, motion, exportGrade) {
    // Ten allpass stages per channel is mastering-grade sweep density; four
    // keeps the character live at a fraction of the audio-thread bill.
    const phaser = new Tone.Phaser({ frequency: 0.1 + motion * 1.9, octaves: 2 + amount * 3, baseFrequency: 300, stages: exportGrade ? 10 : 4 });
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
    g.trackOut[track] = g.colorIn[track];
    g.colorTypes[track] = "none";
    return;
  }
  const made = COLOR_MAKERS[type](patch.amount, patch.motion, g.exportGrade);
  let prev = g.colorIn[track];
  for (const n of made.nodes) {
    prev.connect(n);
    prev = n;
  }
  prev.connect(g.colorDest[track]);
  g.trackOut[track] = prev;
  g.colorNodes[track] = made;
  g.colorTypes[track] = type;
}

function applyPatchTo(g, track, patch, opts) {
  if (track === "drums") applyKitMorphTo(g, patch);
  else applyMorphTo(g, track, patch, opts);
  applyColorTo(g, track, patch);
}

// Kit morph: every kit parameter is a scalar, so drums morph by direct
// blending — same one kick/snare/hat/clap, zero extra nodes or voices.
function applyKitMorphTo(g, patch) {
  const kits = Object.values(KITS);
  const w = cornerWeights(patch);
  const lin = (get) => blendLin(kits.map(get), w);
  const log = (get) => blendLog(kits.map(get), w);
  g.kick.set({
    pitchDecay: log((k) => k.kick.pitchDecay),
    octaves: lin((k) => k.kick.octaves),
    envelope: { attack: 0.001, decay: log((k) => k.kick.envelope.decay), sustain: 0 },
  });
  g.snare.set({ envelope: { attack: 0.001, decay: log((k) => k.snare), sustain: 0 } });
  g.hat.set({ envelope: { attack: 0.001, decay: log((k) => k.hat.decay), sustain: 0 } });
  g.hatFilter.frequency.value = log((k) => k.hat.resonance);
  g.clap.set({ envelope: { attack: 0.001, decay: log((k) => k.clap), sustain: 0 } });
  const gainDb = lin((k) => k.gain);
  g.kick.volume.value = SOURCE_LEVEL_DB.kick + gainDb;
  g.snare.volume.value = SOURCE_LEVEL_DB.snare + gainDb;
  g.hat.volume.value = SOURCE_LEVEL_DB.hat + gainDb;
  g.clap.volume.value = SOURCE_LEVEL_DB.clap + gainDb;
}

// --- Note triggers, parameterized by graph + patch state. vstate carries the
// voice-leading memory ({ prev }) so each render gets its own. Only layers
// carrying weight get triggered — silent corners cost nothing.
function eachActiveLayer(g, track, patch, fn) {
  for (const { i } of activeLayerWeights(patch)) fn(g.layers[track][i]);
}

// oct is the clip's whole-octave shift. It lands AFTER voice leading (prev
// stays register-independent) and moves the pad and its halo together; the
// low root hint stays anchored — it is the harmonic glue under the chord,
// and bass owns the register it would otherwise wander into.
function playChordOn(g, patches, vstate, ci, time, oct = 0) {
  const voiced = voiceLead(CHORDS[ci].pcs, vstate.prev);
  vstate.prev = voiced;
  const shift = 12 * oct;
  eachActiveLayer(g, "harmony", patches.harmony, (layer) => layer.triggerAttackRelease(voiced.map((m) => midiToFreq(m + shift)), "1n", time));
  g.halo.triggerAttackRelease(midiToFreq(Math.max(...voiced) + 12 + shift), "1n", time);
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

// A pin is "<kit>-<voice>" (a bundled one-shot) or "user" (a loaded WAV).
function resolveSampleBuffer(voice, pin) {
  if (!pin) return null;
  if (pin === "user") return userSamples[voice]?.buffer || null;
  const kit = pin.slice(0, pin.lastIndexOf("-"));
  return sampleBuffers[kit]?.[voice] || null;
}

function playSampleHit(g, buffer, voice, time, gain) {
  // Per-hit nodes must bind to the GRAPH's context, not the ambient one:
  // Tone.Offline restores the live context before rendering runs, so nodes
  // created inside render callbacks would otherwise land cross-context.
  const context = g.sampleGains[voice].context;
  const src = new Tone.ToneBufferSource({ context, url: buffer });
  const level = new Tone.Gain({ context, gain }).connect(g.sampleGains[voice]);
  src.connect(level);
  src.onended = () => {
    src.dispose();
    level.dispose();
  };
  src.start(time);
}

function hitDrumOn(g, patches, v, time, vel = 0.9) {
  if (v === "kick") scheduleKickDuck(g.musicDuck.gain, time);
  const patch = patches.drums;
  if (patch.bank === "sample" && samplesReady) {
    const pin = patch.pins?.[v];
    const pinned = resolveSampleBuffer(v, pin);
    if (pinned) {
      // A pinned one-shot keeps its kit's measured trim (user takes are
      // conditioned to the same loudness) — pinning must never move the mix.
      const trim = pin === "user" ? 1 : Tone.dbToGain(SAMPLE_KITS[pin.slice(0, pin.lastIndexOf("-"))]?.gain ?? 0);
      playSampleHit(g, pinned, v, time, vel * trim);
      return;
    }
    let played = false;
    for (const { i, w } of activeLayerWeights(patch)) {
      const kit = SAMPLE_KIT_NAMES[i];
      const buffer = sampleBuffers[kit]?.[v];
      if (!buffer) continue;
      playSampleHit(g, buffer, v, time, vel * Math.sqrt(w) * Tone.dbToGain(SAMPLE_KITS[kit].gain));
      played = true;
    }
    if (played) return;
    // fall through to the synth voice if the buffers never arrived
  }
  if (v === "kick") g.kick.triggerAttackRelease("C1", "8n", time, vel);
  else if (v === "snare") g.snare.triggerAttackRelease("16n", time, vel);
  else if (v === "clap") g.clap.triggerAttackRelease("16n", time, vel);
  else g.hat.triggerAttackRelease("32n", time, vel);
}

// Clip envelopes: a scene's motion lanes override the base patch for this
// step. The morph path schedules its ramps at the tick's transport time so
// automation lands on the heard beat; color params apply at callback time
// (their plain-property knobs can't be scheduled). mstate.motionOn remembers
// which tracks are riding lanes so the base patch gets restored exactly once
// when the lanes end.
function applyMotionOn(g, patchesRef, mstate, track, scene, step, time) {
  const lanes = scene?.motion?.[track];
  mstate.motionOn ||= {};
  if (!lanes || !Object.keys(lanes).length) {
    if (mstate.motionOn[track]) {
      applyPatchTo(g, track, patchesRef[track], { ramp: true, at: time });
      mstate.motionOn[track] = false;
    }
    return;
  }
  const eff = { ...patchesRef[track] };
  for (const [param, lane] of Object.entries(lanes)) {
    if (Array.isArray(lane) && lane.length) eff[param] = lane[step % lane.length] ?? eff[param];
  }
  applyPatchTo(g, track, eff, { ramp: true, at: time });
  mstate.motionOn[track] = true;
}

// One arrangement step — shared by the live transport and the offline render.
// Returns the chord index when a new bar triggered one (for the UI), else null.
// Recorded performance mutes gate note scheduling per bar (tails from earlier
// bars still ring out — a bar-quantized stop, not a hard channel gate), and
// because this function is the single playback path, live arrangement, master,
// stems, and loop exports all replay the same mute performance.
function playArrangementStepOn(g, patches, vstate, song, bar, stepInBar, time) {
  const gated = (trk) => song.mutes?.[trk]?.[bar];
  for (const trk of TRACK_KEYS) {
    if (gated(trk)) continue;
    const c = clipAt(song, trk, bar);
    if (!c) continue;
    const sc = song.scenes[c.scene];
    const absStep = (bar - c.start) * 16 + stepInBar;
    // A live recorder (armed track) wins over lane playback; offline renders
    // have no recorder and always play the lanes.
    if (vstate.recordMotion?.(trk, sc, absStep)) continue;
    applyMotionOn(g, patches, vstate, trk, sc, absStep, time);
  }
  // vstate.wake is the live transport's track-park waker (absent offline);
  // it must fire on every path that makes a sound, and only those.
  let chord = null;
  if (stepInBar === 0 && !gated("harmony")) {
    const h = clipAt(song, "harmony", bar);
    if (h) {
      const sc = song.scenes[h.scene];
      if (sc?.harmony?.length) {
        chord = sc.harmony[(bar - h.start) % sc.harmony.length];
        vstate.wake?.("harmony");
        playChordOn(g, patches, vstate, chord, time, sc.harmonyOct || 0);
      }
    }
  }
  const d = gated("drums") ? null : clipAt(song, "drums", bar);
  if (d) {
    const sc = song.scenes[d.scene];
    const idx = ((bar - d.start) * 16 + stepInBar) % stepsFor(sc, "drums");
    const at = time + swingOffsetFor(song, "drums", idx);
    for (const v of DRUM_VOICES) {
      if (sc.drums[v][idx] > 0) {
        vstate.wake?.("drums");
        hitDrumOn(g, patches, v, at, sc.drums[v][idx]);
      }
    }
  }
  for (const trk of ["bass", "melody"]) {
    if (gated(trk)) continue;
    const c = clipAt(song, trk, bar);
    if (!c) continue;
    const sc = song.scenes[c.scene];
    const idx = ((bar - c.start) * 16 + stepInBar) % stepsFor(sc, trk);
    const slot = sc[trk][idx];
    if (noteSlot(slot).length) {
      vstate.wake?.(trk);
      playNoteStackOn(g, patches, trk, slot, time + swingOffsetFor(song, trk, idx));
    }
  }
  return chord;
}

export function createAudio(song) {
  // Favor throughput over latency on weak mobile CPUs — a bigger buffer absorbs
  // CPU jitter and prevents xruns. Must be set before any node is created.
  // sampleRate 44100: most Androids default to 48 k, which is ~8% more DSP for
  // the identical sound plus a resample of our 44.1 k drum one-shots; a 44.1 k
  // context plays them bit-exact and the OS resamples the output for free.
  // lookAhead 0.25: scheduling runs on the main thread, and on little cores a
  // janky frame at 0.1 s of headroom becomes an audible gap — more headroom
  // costs nothing audible (interactive previews still fire at now).
  const context = new Tone.Context({ latencyHint: "playback", lookAhead: 0.25 });
  Tone.setContext(context);
  // setContext swaps the active context, so the clock loop below binds to the
  // NEW context's transport. The deprecated Tone.Transport / Tone.Draw globals
  // still point at the original context — driving playback through them starts a
  // transport the loop isn't on (silent, no playhead). Bind to the live context.
  const transport = Tone.getTransport();
  // --- The visual clock. Audio scheduled at transport time T is HEARD at
  // T + baseLatency + outputLatency: baseLatency is the context's own
  // buffering (large under latencyHint:"playback"), outputLatency the OS and
  // hardware path (larger again on Bluetooth), and they must be SUMMED —
  // either alone under-compensates by the other. outputLatency is also a
  // LIVE value the browser keeps updating, so instead of shifting each event
  // by a guess frozen at schedule time (what Tone.Draw forces), a rAF pump
  // computes "the audio time reaching the ear right now" every frame and
  // fires everything due against that.
  // Manual trim on top of the estimate: Android's outputLatency can be flat
  // wrong (0 on some builds, stale over Bluetooth), and every audio-clock
  // visual — pies, playhead, cursors — flows through visualLatency, so one
  // nudge corrects them all together. Positive = visuals later.
  let syncNudge = 0;
  const visualLatency = () => {
    const raw = Tone.getContext().rawContext;
    const reported = (raw.baseLatency || 0) + (raw.outputLatency || 0);
    // A zero report is a lie, not a measurement — Brave farbles the latency
    // APIs against fingerprinting and older Android Chrome never fills
    // outputLatency — and trusting it makes every visual lead the sound by
    // the whole real latency. Treat zero as unknown and assume a modest
    // floor; the sync nudge stacks on top for landing it exactly.
    return (reported > 0.001 ? reported : 0.08) + syncNudge;
  };
  const visualQueue = [];
  let visualRAF = 0;
  function pumpVisuals() {
    visualRAF = 0;
    // Half a frame of anticipation so a callback lands on the paint closest
    // to its moment instead of always one frame after it.
    const heard = Tone.getContext().rawContext.currentTime - visualLatency() + 0.008;
    for (let i = 0; i < visualQueue.length; ) {
      const ev = visualQueue[i];
      if (ev.time <= heard) {
        visualQueue.splice(i, 1);
        // Stale events (tab was hidden, rAF paused) get dropped, not replayed.
        if (heard - ev.time < 1) ev.cb();
      } else i++;
    }
    if (visualQueue.length) visualRAF = requestAnimationFrame(pumpVisuals);
  }
  // Beat-synced events pass their transport time; immediate UI feedback
  // (launch/queue state) passes none and fires on the next frame.
  const scheduleVisual = (cb, time = 0) => {
    visualQueue.push({ time, cb });
    if (!visualRAF) visualRAF = requestAnimationFrame(pumpVisuals);
  };

  const live = buildGraph({ meters: true });
  loadSamples();
  const patches = Object.fromEntries(TRACK_KEYS.map((t) => [t, defaultPatch(t)]));
  for (const t of TRACK_KEYS) applyPatchTo(live, t, patches[t]);

  const channelState = Object.fromEntries(TRACK_KEYS.map((track) => [track, {
    vol: DEFAULT_TRACK_VOLUME_DB,
    pan: 0,
    verb: SEND_OFF_DB,
    echo: SEND_OFF_DB,
    mute: false,
    solo: false,
  }]));

  // Dry park: with every send off — the default, and most dice rolls —
  // Freeverb's comb bank and the feedback delay process silence full-time,
  // the priciest always-on cost on a weak phone. A parked return is
  // disconnected from the duck bus, which takes its whole subtree out of
  // the rendered graph; it wakes BEFORE a send opens and parks again once
  // the tail has rung out. Sound-neutral by construction: a parked return
  // only ever carried silence.
  const RETURN_TAIL_MS = 6000;
  const returns = {
    verb: { key: "verb", node: live.reverbOut, parked: false, timer: 0 },
    echo: { key: "echo", node: live.echo, parked: false, timer: 0 },
  };
  const anySendOn = (kind) => TRACK_KEYS.some((t) => sendGain(channelState[t][kind]) > 0);
  function wakeReturn(kind) {
    const r = returns[kind];
    clearTimeout(r.timer);
    r.timer = 0;
    if (r.parked) {
      r.node.connect(live.musicDuck);
      r.parked = false;
    }
  }
  function parkReturnSoon(kind) {
    const r = returns[kind];
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      if (!anySendOn(kind) && !r.parked) {
        r.node.disconnect(live.musicDuck);
        r.parked = true;
      }
    }, RETURN_TAIL_MS);
  }
  // Boot state is all-dry and nothing has played: park immediately, no tail.
  for (const kind of ["verb", "echo"]) {
    returns[kind].node.disconnect(live.musicDuck);
    returns[kind].parked = true;
  }

  // Track park, same principle one level up: a track that hasn't been asked
  // to sound for a while takes its whole source side — synth layers, lane
  // filters, the chorus, the color insert — out of the rendered graph with
  // one cut at the color junction. Triggers wake it synchronously before
  // they schedule, so the first note back is already connected; empty lanes
  // never trigger, so a scene without a melody parks the melody chain. The
  // strip below the cut (comp/trim/channel) stays wired — cheap, and the
  // meters keep reading truthful silence.
  const TRACK_PARK_SEC = 6;
  const lastTrigger = Object.fromEntries(TRACK_KEYS.map((t) => [t, 0]));
  const trackParked = Object.fromEntries(TRACK_KEYS.map((t) => [t, false]));
  function wakeTrack(t) {
    lastTrigger[t] = Tone.now();
    if (trackParked[t]) {
      live.trackOut[t].connect(live.colorDest[t]);
      trackParked[t] = false;
    }
  }
  function sweepTrackPark() {
    const cutoff = Tone.now() - TRACK_PARK_SEC;
    for (const t of TRACK_KEYS) {
      if (!trackParked[t] && lastTrigger[t] < cutoff) {
        live.trackOut[t].disconnect(live.colorDest[t]);
        trackParked[t] = true;
      }
    }
  }
  function applyTrackGates() {
    const anySolo = TRACK_KEYS.some((track) => channelState[track].solo);
    for (const track of TRACK_KEYS) {
      live.channels[track].mute = channelState[track].mute || (anySolo && !channelState[track].solo);
    }
  }

  const liveVoice = { prev: null };
  liveVoice.wake = wakeTrack;
  liveVoice.recordMotion = (track, scene, step) => {
    if (!motionArmed[track]) return false;
    recordMotionTick(track, scene, step);
    return true;
  };
  // Motion capture: arm a track and every 16th samples the live patch values
  // (your finger on the pad) into the playing scene's lanes — but only the
  // params you actually touched while armed, so untouched knobs stay free.
  const MOTION_PARAMS = ["x", "y", "amount", "motion"];
  const motionArmed = Object.fromEntries(TRACK_KEYS.map((t) => [t, false]));
  const motionDirty = Object.fromEntries(TRACK_KEYS.map((t) => [t, new Set()]));
  function recordMotionTick(track, scene, step) {
    liveVoice.motionOn ||= {};
    liveVoice.motionOn[track] = true;
    const dirty = motionDirty[track];
    if (!dirty.size) return;
    const lanes = ((scene.motion ||= {})[track] ||= {});
    for (const param of dirty) {
      // New rides get a 4-bar window; slow sweeps need the room (short loops
      // simply repeat inside it).
      if (!lanes[param]) lanes[param] = new Array(64).fill(patches[track][param]);
      lanes[param][step % lanes[param].length] = patches[track][param];
    }
  }
  const playChord = (ci, time, oct) => {
    wakeTrack("harmony");
    playChordOn(live, patches, liveVoice, ci, time, oct);
  };
  const playNoteStack = (track, slot, time) => {
    if (!noteSlot(slot).length) return; // empty step: no sound, no wake
    wakeTrack(track);
    playNoteStackOn(live, patches, track, slot, time);
  };
  const hitDrum = (v, time, vel) => {
    wakeTrack("drums");
    hitDrumOn(live, patches, v, time, vel);
  };
  function preview(ci, oct = 0) {
    wakeTrack("harmony");
    const voiced = voiceLead(CHORDS[ci].pcs, liveVoice.prev);
    const shift = 12 * oct;
    eachActiveLayer(live, "harmony", patches.harmony, (layer) => layer.triggerAttackRelease(voiced.map((m) => midiToFreq(m + shift)), "2n", Tone.now()));
    live.sub.triggerAttackRelease(midiToFreq(48 + CHORDS[ci].pcs[0]), "2n", Tone.now());
  }

  // Transport.
  let mode = "scene";
  let focusIndex = 0;
  let curScene = 0;
  const trackState = Object.fromEntries(TRACK_KEYS.map((track) => [track, { scene: 0, step: 0, total: 0, active: true }]));
  let arrStep = 0;
  const queuedTracks = Object.fromEntries(TRACK_KEYS.map((track) => [track, -1]));
  let visualCb = () => {};

  transport.bpm.value = song.tempo;
  // Swing is applied per trigger (swingOffsetFor), never on the transport —
  // that's what lets each track sit in its own pocket.
  transport.swing = 0;
  // buildGraph ran before the tempo reached this transport, so the live echo's
  // "8n" froze at Tone's 120 default (offline renders set bpm before building
  // and never had the bug). Pin it to the real grid here and on tempo changes.
  const syncEcho = (bpm) => live.echo.delayTime.rampTo(30 / bpm, 0.1);
  syncEcho(song.tempo);

  function tickArrangement(time) {
    const len = arrangeLength(song);
    const bar = Math.floor(arrStep / 16);
    const stepInBar = arrStep % 16;
    const chord = playArrangementStepOn(live, patches, liveVoice, song, bar, stepInBar, time);
    if (chord !== null) scheduleVisual(() => visualCb({ type: "arrchord", bar, chord }), time);
    // Anchor for the playhead pump: the AudioContext time bar 0 would have
    // sounded, plus the live loop region so the visual wraps exactly when the
    // audio does. Same no-second-clock construction as the pie anchors.
    const stepDur = 15 / song.tempo;
    const anchor = {
      start: time - arrStep * stepDur,
      barSec: stepDur * 16,
      len,
      loop: song.loop && song.loop.on ? { start: song.loop.start, end: song.loop.start + song.loop.len } : null,
    };
    scheduleVisual(() => visualCb({ type: "arr", bar, stepInBar, len, anchor }), time);
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

  // Per-track loop anchor for the pie timers: the AudioContext time at which
  // the current cycle's step 0 sounds, and the cycle's duration in seconds. The
  // visual side reads these against the live audio clock every frame, so the
  // pie is a direct function of playback position — no second clock to drift
  // against, no dependence on each frame's event landing on time.
  function trackLoopAnchors(time) {
    const stepDur = 15 / song.tempo; // seconds per 16th note
    const res = {};
    for (const track of TRACK_KEYS) {
      const st = trackState[track];
      if (st.active && song.scenes[st.scene]) {
        const scene = song.scenes[st.scene];
        const launch = clipLaunch(scene, track);
        const naturalBars = clipLengthBars(scene, track);
        const limitBars = launch.follow !== "none" ? launch.followBars : naturalBars;
        const loopSteps = limitBars * 16;
        const posInLoop = ((st.step % loopSteps) + loopSteps) % loopSteps;
        res[track] = { start: time - posInLoop * stepDur, dur: loopSteps * stepDur };
      }
    }
    return res;
  }

  function resetTrack(track, sceneIndex) {
    trackState[track] = { scene: sceneIndex, step: 0, total: 0, active: !!song.scenes[sceneIndex] };
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
    st.total += 1;
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
    sweepTrackPark();
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
    for (const track of TRACK_KEYS) {
      const st = trackState[track];
      if (!st.active || !song.scenes[st.scene]) continue;
      const sc = song.scenes[st.scene];
      if (!liveVoice.recordMotion(track, sc, st.total)) {
        applyMotionOn(live, patches, liveVoice, track, sc, st.total, time);
      }
    }
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
        playChord(ci, time, harmonyScene.harmonyOct || 0);
        scheduleVisual(() => visualCb({ type: "chord", scene: harmonyState.scene, bar, chord: ci, activeScenes: activeBefore }), time);
      }
    }

    const drumState = trackState.drums;
    const drumScene = drumState.active ? song.scenes[drumState.scene] : null;
    if (drumScene) {
      const idx = drumState.step % stepsFor(drumScene, "drums");
      const at = time + swingOffsetFor(song, "drums", idx);
      for (const v of DRUM_VOICES) {
        if (drumScene.drums[v][idx] > 0) {
          hitDrum(v, at, drumScene.drums[v][idx]);
          scheduleVisual(() => visualCb({ type: "hit", scene: drumState.scene, voice: v, step: idx, activeScenes: activeBefore }), at);
        }
      }
    }

    for (const track of ["bass", "melody"]) {
      const st = trackState[track];
      const scene = st.active ? song.scenes[st.scene] : null;
      if (!scene) continue;
      const idx = st.step % stepsFor(scene, track);
      playNoteStack(track, scene[track][idx], time + swingOffsetFor(song, track, idx));
    }

    const anchorsCurrent = trackLoopAnchors(time);
    const queuedCurrent = getQueuedTracks();
    scheduleVisual(() => visualCb({ type: "step", scene: curScene, localStep: visualBar * 16 + visualStep, stepInBar: visualStep, bar: visualBar, activeScenes: activeBefore, queuedTracks: queuedCurrent, anchors: anchorsCurrent }), time);
    for (const track of TRACK_KEYS) advanceSceneTrack(track);
  }, "16n");

  let playing = false;
  let inited = false;

  // Idle park: stopped, the chain still costs near-playback CPU (feedback
  // loops and LFOs defeat the browser's silence-skipping), so the context
  // suspends once the longest tails have rung out and resumes on any
  // trigger. Suspended = bit-identical silence; nothing about the sound can
  // change. Resume-before-init is guarded — pre-gesture the browser owns
  // the suspended state.
  const IDLE_PARK_MS = 6000;
  let idleTimer = 0;
  function wakeContext() {
    clearTimeout(idleTimer);
    idleTimer = 0;
    const raw = Tone.getContext().rawContext;
    if (inited && raw.state === "suspended") raw.resume();
  }
  function parkContextSoon() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const raw = Tone.getContext().rawContext;
      if (!playing && raw.state === "running") raw.suspend();
    }, IDLE_PARK_MS);
  }

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
      // Samples preload at page build (loadSamples runs there); by first play
      // they're almost always in, so this awaits a settled promise, not a fetch.
      if (live.reverb.ready) await live.reverb.ready;
      await loadSamples();
      clock.start(0);
    },
    play() {
      wakeContext();
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
      parkContextSoon();
      for (const track of TRACK_KEYS) queuedTracks[track] = -1; // clear queues on stop
      scheduleVisual(() => visualCb({ type: "queue", activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }));
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
        scheduleVisual(() => visualCb({ type: "step", scene: index, localStep: 0, stepInBar: 0, bar: 0, activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }));
        this.play();
      } else {
        curScene = index;
        for (const track of TRACK_KEYS) queuedTracks[track] = index;
        scheduleVisual(() => visualCb({ type: "queue", activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }));
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
        scheduleVisual(() => visualCb({ type: "step", scene: index, localStep: 0, stepInBar: 0, bar: 0, activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }));
        this.play();
      } else {
        queuedTracks[track] = index;
        scheduleVisual(() => visualCb({ type: "queue", activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }));
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
      syncEcho(bpm);
      // Tempo-synced colors (trem/wob) chase the new grid.
      for (const t of TRACK_KEYS) live.colorNodes[t]?.updateColor?.(patches[t].amount, patches[t].motion);
    },
    setSwing() {
      // Global groove lives on song.swing and is read live per trigger.
    },
    preview(ci, oct = 0) {
      wakeContext();
      preview(ci, oct);
    },
    previewHit(v) {
      wakeContext();
      hitDrum(v, Tone.now());
    },
    previewNote(track, midi) {
      wakeContext();
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
      if (sendGain(db) > 0) wakeReturn("verb"); // reconnect BEFORE the gain opens
      live.verbSends[track].gain.rampTo(sendGain(db), 0.02);
      if (!anySendOn("verb")) parkReturnSoon("verb");
    },
    setEcho(track, db) {
      channelState[track].echo = db;
      if (sendGain(db) > 0) wakeReturn("echo");
      live.echoSends[track].gain.rampTo(sendGain(db), 0.02);
      if (!anySendOn("echo")) parkReturnSoon("echo");
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
    // RMS + instantaneous peak in dB from one waveform read.
    meterLevels(track) {
      const m = track === "master" ? live.masterMeter : live.meters[track];
      const buf = m.getValue();
      let peak = 0;
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const a = Math.abs(buf[i]);
        if (a > peak) peak = a;
        sum += buf[i] * buf[i];
      }
      return { peak: Tone.gainToDb(peak), rms: Tone.gainToDb(Math.sqrt(sum / buf.length)) };
    },
    // --- devices: patches ---
    patch(track) {
      return { ...patches[track] };
    },
    setPatch(track, partial) {
      const prevColor = patches[track].color;
      patches[track] = normalizePatch(track, { ...patches[track], ...partial });
      if (motionArmed[track] && partial) {
        for (const p of MOTION_PARAMS) if (p in partial) motionDirty[track].add(p);
      }
      if (patches[track].color !== prevColor) {
        // Splicing a different insert mid-stream clicks; duck the junction for
        // the swap. ~45 ms of dip on a deliberate sound-design tap is free.
        const junction = live.colorIn[track].gain;
        junction.rampTo(0, 0.012);
        setTimeout(() => {
          applyPatchTo(live, track, patches[track], { ramp: true });
          // The rewire reconnected the junction — keep the park flag honest
          // or the sweep would never re-park (and wake would double-connect).
          trackParked[track] = false;
          junction.rampTo(1, 0.03);
        }, 18);
      } else {
        applyPatchTo(live, track, patches[track], { ramp: true });
      }
      return { ...patches[track] };
    },
    // Corner-name compatibility: the dropdowns, project files from v1, and the
    // register rules all speak preset names. A name is just a corner of the pad.
    // For drums the name also picks the bank (kit names are unique across both).
    kit() {
      const names = drumCornerNames(patches.drums);
      const w = cornerWeights(patches.drums);
      return names[w.indexOf(Math.max(...w))];
    },
    setKit(name) {
      const bank = SAMPLE_KIT_NAMES.includes(name) ? "sample" : "synth";
      const list = bank === "sample" ? SAMPLE_KIT_NAMES : KIT_NAMES;
      const i = Math.max(0, list.indexOf(name));
      this.setPatch("drums", { bank, x: i % 2, y: Math.floor(i / 2) });
    },
    samplesReady: () => samplesReady,
    setSyncNudge(ms) {
      syncNudge = Math.max(-0.25, Math.min(0.25, (Number(ms) || 0) / 1000));
    },
    visualLatency,
    // The audio-clock position being HEARD right now (context time minus the
    // output/acoustic latency, plus a half-frame of anticipation). The pie pump
    // samples this every frame so the pie sits where the sound is.
    heardNow: () => Tone.getContext().rawContext.currentTime - visualLatency() + 0.008,
    // --- motion capture ---
    armMotion(track, on) {
      motionArmed[track] = !!on;
      if (on) motionDirty[track] = new Set();
    },
    motionArmed: (track) => motionArmed[track],
    disarmMotion() {
      for (const t of TRACK_KEYS) motionArmed[t] = false;
    },
    userSampleName: (voice) => userSamples[voice]?.name || null,
    async loadUserSample(voice, arrayBuffer, name) {
      const audioBuf = await Tone.getContext().rawContext.decodeAudioData(arrayBuffer);
      userSamples[voice] = { buffer: new Tone.ToneAudioBuffer(conditionOneShot(voice, audioBuf)), name };
      return name;
    },
    // Beatbox capture: record the mic straight into a voice slot. Raw-ish
    // constraints — AGC and noise suppression would eat the transient that
    // IS the drum. Returns { done, stop() }; both resolve the sample name.
    async beginMicCapture(voice, { maxMs = 2500 } = {}) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((resolve, reject) => {
        rec.onerror = (e) => reject(e.error || new Error("recorder failed"));
        rec.onstop = async () => {
          try {
            stream.getTracks().forEach((t) => t.stop());
            const raw = await new Blob(chunks).arrayBuffer();
            const audioBuf = await Tone.getContext().rawContext.decodeAudioData(raw);
            const name = `mic ${voice}`;
            userSamples[voice] = { buffer: new Tone.ToneAudioBuffer(conditionOneShot(voice, audioBuf)), name };
            resolve(name);
          } catch (err) {
            reject(err);
          }
        };
      });
      rec.start();
      const timer = setTimeout(() => rec.state !== "inactive" && rec.stop(), maxMs);
      return {
        done,
        stop() {
          clearTimeout(timer);
          if (rec.state !== "inactive") rec.stop();
          return done;
        },
      };
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
    // Render through the real graph. Default: the whole arrangement, one pass,
    // with a tail. opts.loop = {start, len} instead renders a SEAMLESS loop of
    // the region — two cycles back to back, keeping the second, so the first
    // pass's reverb/echo/release tail bleeds into the second's downbeat and the
    // file wraps into itself with no click when a looper repeats it.
    async renderOffline(soloTrack, opts = {}) {
      const barSec = 240 / song.tempo;
      const runPass = (dur, stopStep, barOf) => {
        const patchesCopy = structuredClone(patches);
        return Tone.Offline(({ transport: offTr }) => {
          offTr.bpm.value = song.tempo;
          // Exports render the full chain; opts.graph = "live" exists only
          // for the measurement probes to cost the live grade offline.
          const g = buildGraph({ meters: false, exportGrade: opts.graph !== "live" });
          for (const t of TRACK_KEYS) applyPatchTo(g, t, patchesCopy[t]);
          const anySolo = TRACK_KEYS.some((track) => channelState[track].solo);
          for (const k of TRACK_KEYS) {
            const st = channelState[k];
            const muted = soloTrack ? k !== soloTrack : st.mute || (anySolo && !st.solo);
            g.channels[k].set({ volume: muted ? -Infinity : st.vol, pan: st.pan, mute: muted });
            g.verbSends[k].gain.value = sendGain(st.verb);
            g.echoSends[k].gain.value = sendGain(st.echo);
            // A muted track still gets scheduled (the kick keeps the duck
            // pumping on stems) but its source side never joins the graph —
            // a stems pass renders one track's DSP, not four.
            if (muted) g.trackOut[k].disconnect(g.colorDest[k]);
          }
          // The same dry park, statically: sends are fixed for the whole
          // render, so an all-off return never joins the graph at all.
          if (!TRACK_KEYS.some((k) => g.verbSends[k].gain.value > 0)) g.reverbOut.disconnect(g.musicDuck);
          if (!TRACK_KEYS.some((k) => g.echoSends[k].gain.value > 0)) g.echo.disconnect(g.musicDuck);
          const vstate = { prev: null };
          let step = 0;
          new Tone.Loop((time) => {
            if (step >= stopStep) return;
            playArrangementStepOn(g, patchesCopy, vstate, song, barOf(step), step % 16, time);
            step += 1;
          }, "16n").start(0);
          offTr.start(0);
        }, dur);
      };

      const loop = opts.loop && opts.loop.len >= 1 ? opts.loop : null;
      if (loop) {
        const ls = Math.max(0, Math.floor(loop.start));
        const ll = Math.max(1, Math.floor(loop.len));
        const cycleSec = ll * barSec;
        // Two cycles plus a tail to discard; keep the second cycle only.
        const buf = await runPass(2 * cycleSec + Math.min(2, cycleSec), 2 * ll * 16, (s) => ls + (Math.floor(s / 16) % ll));
        return sliceBuffer(buf, cycleSec, 2 * cycleSec);
      }

      const totalBars = arrangeLength(song);
      return runPass(totalBars * barSec + 2, totalBars * 16, (s) => Math.floor(s / 16));
    },
  };
}
