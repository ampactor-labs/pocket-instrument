// Tone.js engine. Per-track mixer channels (vol/pan/send + meter), adjustable
// devices (tight funk/garage kit + bass/lead synth params), note length +
// velocity, and a transport that loops a Scene or plays the Arrangement.

import * as Tone from "tone";
import { CHORDS, DRUM_VOICES, voiceLead, clipAt, arrangeLength, clipLaunch, clipLengthBars, noteSlot } from "./model.js";

const midiToFreq = (m) => Tone.Frequency(m, "midi").toFrequency();
const sixteenth = () => Tone.Time("16n").toSeconds();

export const TRACK_KEYS = ["harmony", "drums", "bass", "melody"];

const DEFAULT_TRACK_VOLUME_DB = -6;
const SEND_OFF_DB = -60;
const FIRST_PLAY_WARMUP_MS = 400;
const PLAY_START_LEAD_TIME = "+0.18";
const SOURCE_LEVEL_DB = {
  harmonyPad: -10,
  harmonyHalo: -24,
  harmonyRoot: -30,
  bass: -2,
  melody: 6,
  kick: 5,
  snare: 14,
  hat: 5,
  clap: 7,
};
const KICK_DUCK_GAIN = Tone.dbToGain(-8);
const DRUM_PARALLEL_GAIN = Tone.dbToGain(-10);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sendGain = (db) => (db <= -59 ? 0 : Tone.dbToGain(db));

function scheduleKickDuck(param, time) {
  param.cancelScheduledValues(time);
  param.setValueAtTime(1, time);
  param.linearRampToValueAtTime(KICK_DUCK_GAIN, time + 0.008);
  param.exponentialRampToValueAtTime(1, time + 0.22);
}

// --- Device presets (3 per track, like drum kits) ---
const HARMONY_PRESETS = {
  pad:     { osc: "sawtooth", filter: 1200, attack: 0.35, decay: 1.5, sustain: 0.8, release: 1.2, chorusWet: 0.4, chorusDepth: 0.7 },
  keys:    { osc: "sine",     filter: 3000, attack: 0.01, decay: 0.4, sustain: 0.2, release: 0.4, chorusWet: 0.15, chorusDepth: 0.3 },
  ambient: { osc: "triangle", filter: 800,  attack: 1.0,  decay: 2.0, sustain: 0.9, release: 2.5, chorusWet: 0.8,  chorusDepth: 0.9 },
  stab:    { osc: "square",   filter: 2500, attack: 0.01, decay: 0.2, sustain: 0.0, release: 0.2, chorusWet: 0.1,  chorusDepth: 0.2 },
};
export const HARMONY_PRESET_NAMES = Object.keys(HARMONY_PRESETS);

const BASS_PRESETS = {
  deep:   { wave: "sine",     cutoff: 500,  attack: 0.01,  decay: 0.3,  sustain: 0.7,  release: 0.3 },
  bright: { wave: "sawtooth", cutoff: 2500, attack: 0.02,  decay: 0.15, sustain: 0.4,  release: 0.2 },
  pluck:  { wave: "square",   cutoff: 1500, attack: 0.005, decay: 0.1,  sustain: 0.0,  release: 0.1 },
  sub:    { wave: "triangle", cutoff: 350,  attack: 0.05,  decay: 0.4,  sustain: 1.0,  release: 0.4 },
};
export const BASS_PRESET_NAMES = Object.keys(BASS_PRESETS);

const MELODY_PRESETS = {
  lead:  { wave: "sawtooth", cutoff: 3500, attack: 0.02,  decay: 0.2,  sustain: 0.4, release: 0.3 },
  bell:  { wave: "sine",     cutoff: 4000, attack: 0.001, decay: 0.8,  sustain: 0.0, release: 0.6 },
  synth: { wave: "square",   cutoff: 2000, attack: 0.01,  decay: 0.15, sustain: 0.2, release: 0.15 },
  pluck: { wave: "triangle", cutoff: 2800, attack: 0.005, decay: 0.1,  sustain: 0.0, release: 0.1 },
};
export const MELODY_PRESET_NAMES = Object.keys(MELODY_PRESETS);

// Tight, dead kits — funk / UK garage register (short decays, damped, swung).
const KITS = {
  garage: {
    kick: { pitchDecay: 0.018, octaves: 4, envelope: { attack: 0.001, decay: 0.16, sustain: 0 } },
    snare: 0.09,
    hat: { decay: 0.018, resonance: 6000 },
    clap: 0.09,
    swing: 0.16,
  },
  funk: {
    kick: { pitchDecay: 0.03, octaves: 5, envelope: { attack: 0.001, decay: 0.2, sustain: 0 } },
    snare: 0.12,
    hat: { decay: 0.026, resonance: 5000 },
    clap: 0.11,
    swing: 0.06,
  },
  clean: {
    kick: { pitchDecay: 0.04, octaves: 6, envelope: { attack: 0.001, decay: 0.4, sustain: 0 } },
    snare: 0.17,
    hat: { decay: 0.05, resonance: 4000 },
    clap: 0.14,
    swing: 0,
  },
};
export const KIT_NAMES = Object.keys(KITS);

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
  const masterMeter = new Tone.Meter();
  const masterLimiter = new Tone.Limiter(-1).toDestination();
  const softClip = new Tone.WaveShaper((x) => Math.tanh(x * 1.35) / Math.tanh(1.35), 2048).connect(masterLimiter);
  const glue = new Tone.Compressor({ threshold: -20, ratio: 6, attack: 0.025, release: 0.18, knee: 18 }).connect(softClip);
  const saturation = new Tone.Distortion(0.16).connect(glue);
  saturation.wet.value = 0.60;
  const master = new Tone.Gain(Tone.dbToGain(-3)).connect(saturation);
  masterLimiter.connect(masterMeter);
  // Algorithmic (Freeverb) instead of convolution — far cheaper per sample on a
  // low-end mobile CPU, and fine for a send reverb.
  const reverb = new Tone.Freeverb({ roomSize: 0.72, dampening: 2600, wet: 1 }).connect(master);
  const echo = new Tone.FeedbackDelay({ delayTime: "8n", feedback: 0.26, wet: 1 }).connect(master);
  const echoReturn = new Tone.Gain(Tone.dbToGain(-4)).connect(echo);
  const musicDuck = new Tone.Gain(1).connect(master);
  
  const drumBus = new Tone.Gain(1).connect(master);
  const drumDry = new Tone.Gain(Tone.dbToGain(-1)).connect(drumBus);
  const drumParallel = new Tone.Compressor({
    threshold: -24,
    ratio: 4.5,
    attack: 0.004,
    release: 0.13,
    knee: 12,
  });
  const drumParallelReturn = new Tone.Gain(DRUM_PARALLEL_GAIN).connect(drumBus);
  drumParallel.connect(drumParallelReturn);

  // Mixer strips — direct gain wiring (no send/receive bus, which can silently
  // fail depending on Tone.js version and context lifecycle).
  const channels = {};
  const meters = {};
  const verbSends = {};
  const echoSends = {};
  const channelState = Object.fromEntries(TRACK_KEYS.map((track) => [track, {
    vol: DEFAULT_TRACK_VOLUME_DB,
    pan: 0,
    verb: SEND_OFF_DB,
    echo: SEND_OFF_DB,
    mute: false,
    solo: false,
  }]));
  const muteState = Object.fromEntries(TRACK_KEYS.map((track) => [track, false]));
  const soloState = Object.fromEntries(TRACK_KEYS.map((track) => [track, false]));
  const verbDefault = { harmony: SEND_OFF_DB, melody: SEND_OFF_DB, drums: SEND_OFF_DB, bass: SEND_OFF_DB };
  const echoDefault = { harmony: SEND_OFF_DB, melody: SEND_OFF_DB, drums: SEND_OFF_DB, bass: SEND_OFF_DB };
  for (const k of TRACK_KEYS) {
    const chVol = DEFAULT_TRACK_VOLUME_DB;
    channels[k] = new Tone.Channel({ volume: chVol, pan: 0 });
    if (k === "drums") {
      channels[k].connect(drumDry);
      channels[k].connect(drumParallel);
      meters[k] = new Tone.Meter();
      drumBus.connect(meters[k]);
    } else {
      channels[k].connect(musicDuck);
      meters[k] = new Tone.Meter();
      channels[k].connect(meters[k]);
    }
    // Direct gain nodes wired to the effects instead of the send/receive bus
    verbSends[k] = new Tone.Gain(0).connect(reverb);
    channels[k].connect(verbSends[k]);
    echoSends[k] = new Tone.Gain(0).connect(echoReturn);
    channels[k].connect(echoSends[k]);
  }
  function applyTrackGates() {
    const anySolo = TRACK_KEYS.some((track) => soloState[track]);
    for (const track of TRACK_KEYS) {
      channels[track].mute = muteState[track] || (anySolo && !soloState[track]);
    }
  }

  // Harmony: lush pad.
  const chorus = new Tone.Chorus({ frequency: 0.4, delayTime: 4, depth: 0.6, wet: 0.35 }).start();
  const padHighpass = new Tone.Filter({ type: "highpass", frequency: 170, Q: 0.6 });
  const padFilter = new Tone.Filter({ type: "lowpass", frequency: 1500, Q: 0.7 });
  new Tone.LFO({ frequency: 0.05, min: 850, max: 2600 }).connect(padFilter.frequency).start();
  padHighpass.connect(padFilter);
  padFilter.connect(chorus);
  chorus.connect(channels.harmony);
  const pad = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 4,
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.28, decay: 1.1, sustain: 0.72, release: 1.0 },
    volume: SOURCE_LEVEL_DB.harmonyPad,
  }).connect(padHighpass);

  let harmonyPreset = "keys";
  function applyHarmonyPreset(name) {
    const p = HARMONY_PRESETS[name] || HARMONY_PRESETS.keys;
    harmonyPreset = name;
    pad.set({ oscillator: { type: p.osc }, envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release } });
    padFilter.frequency.value = p.filter;
    chorus.set({ wet: p.chorusWet, depth: p.chorusDepth });
  }
  applyHarmonyPreset("keys");
  // Mono shimmer on the top note (was a 6-voice PolySynth, inaudible at -28 dB).
  const halo = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.9, decay: 1, sustain: 0.5, release: 1.6 },
    volume: SOURCE_LEVEL_DB.harmonyHalo,
  }).connect(channels.harmony);
  const rootHintFilter = new Tone.Filter({ type: "highpass", frequency: 120, Q: 0.7 }).connect(channels.harmony);
  // A quiet low-mid root hint, not a sub-bass voice. Bass owns the low end.
  const sub = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.08, decay: 0.4, sustain: 0.85, release: 1.6 },
    volume: SOURCE_LEVEL_DB.harmonyRoot,
  }).connect(rootHintFilter);

  // Bass + lead — device params live-adjustable.
  const bassHighpass = new Tone.Filter({ type: "highpass", frequency: 34, Q: 0.7 }).connect(channels.bass);
  const bassFilter = new Tone.Filter({ type: "lowpass", frequency: 750, Q: 0.9 }).connect(bassHighpass);
  const bassTrk = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 6,
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.6, release: 0.25 },
    volume: SOURCE_LEVEL_DB.bass,
  }).connect(bassFilter);
  const leadHighpass = new Tone.Filter({ type: "highpass", frequency: 180, Q: 0.7 }).connect(channels.melody);
  const leadFilter = new Tone.Filter({ type: "lowpass", frequency: 3200, Q: 0.6 }).connect(leadHighpass);
  const lead = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 8,
    oscillator: { type: "triangle" },
    envelope: { attack: 0.01, decay: 0.16, sustain: 0.35, release: 0.3 },
    volume: SOURCE_LEVEL_DB.melody,
  }).connect(leadFilter);
  const devices = {
    bass: { synth: bassTrk, filter: bassFilter, wave: "sawtooth", cutoff: 750, preset: "deep" },
    melody: { synth: lead, filter: leadFilter, wave: "triangle", cutoff: 3200, preset: "lead" },
  };

  function applyBassPreset(name) {
    const p = BASS_PRESETS[name] || BASS_PRESETS.deep;
    devices.bass.preset = name; devices.bass.wave = p.wave; devices.bass.cutoff = p.cutoff;
    bassTrk.set({ oscillator: { type: p.wave }, envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release } });
    bassFilter.frequency.rampTo(p.cutoff, 0.05);
  }
  function applyMelodyPreset(name) {
    const p = MELODY_PRESETS[name] || MELODY_PRESETS.lead;
    devices.melody.preset = name; devices.melody.wave = p.wave; devices.melody.cutoff = p.cutoff;
    lead.set({ oscillator: { type: p.wave }, envelope: { attack: p.attack, decay: p.decay, sustain: p.sustain, release: p.release } });
    leadFilter.frequency.rampTo(p.cutoff, 0.05);
  }

  // Kit.
  const kickFilter = new Tone.Filter({ type: "lowpass", frequency: 1800, Q: 0.5 }).connect(channels.drums);
  const kick = new Tone.MembraneSynth({ volume: SOURCE_LEVEL_DB.kick }).connect(kickFilter);
  const snareFilter = new Tone.Filter({ type: "highpass", frequency: 950 }).connect(channels.drums);
  const snare = new Tone.NoiseSynth({ noise: { type: "white" }, volume: SOURCE_LEVEL_DB.snare }).connect(snareFilter);
  // Tight garage hat as a filtered noise burst (was MetalSynth: 6 FM oscillators
  // on the most-triggered voice — the priciest drum in the kit).
  const hatFilter = new Tone.Filter({ type: "highpass", frequency: 7500 }).connect(channels.drums);
  const hat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.02, sustain: 0 }, volume: SOURCE_LEVEL_DB.hat }).connect(hatFilter);
  const clapFilter = new Tone.Filter({ type: "bandpass", frequency: 1400, Q: 1.2 }).connect(channels.drums);
  const clap = new Tone.NoiseSynth({ noise: { type: "pink" }, volume: SOURCE_LEVEL_DB.clap }).connect(clapFilter);

  let kitName = "clean";
  function applyKit(name) {
    const k = KITS[name] || KITS.garage;
    kitName = name;
    kick.set({ pitchDecay: k.kick.pitchDecay, octaves: k.kick.octaves, envelope: k.kick.envelope });
    snare.set({ envelope: { attack: 0.001, decay: k.snare, sustain: 0 } });
    hat.set({ envelope: { attack: 0.001, decay: k.hat.decay, sustain: 0 } });
    hatFilter.frequency.value = k.hat.resonance;
    clap.set({ envelope: { attack: 0.001, decay: k.clap, sustain: 0 } });
  }
  applyKit("clean");

  let prevVoiced = null;
  function playChord(ci, time) {
    const voiced = voiceLead(CHORDS[ci].pcs, prevVoiced);
    prevVoiced = voiced;
    pad.triggerAttackRelease(voiced.map(midiToFreq), "1n", time);
    halo.triggerAttackRelease(midiToFreq(Math.max(...voiced) + 12), "1n", time);
    sub.triggerAttackRelease(midiToFreq(48 + CHORDS[ci].pcs[0]), "1n", time);
  }
  function playNoteStack(track, slot, time) {
    const synth = track === "bass" ? bassTrk : lead;
    const stretch = track === "bass" ? 1.1 : 1;
    for (const n of noteSlot(slot)) {
      synth.triggerAttackRelease(midiToFreq(n.midi), sixteenth() * (n.len || 1) * stretch, time, n.vel ?? 0.9);
    }
  }
  function hitDrum(v, time, vel = 0.9) {
    if (v === "kick") {
      scheduleKickDuck(musicDuck.gain, time);
      kick.triggerAttackRelease("C1", "8n", time, vel);
    }
    else if (v === "snare") snare.triggerAttackRelease("16n", time, vel);
    else if (v === "clap") clap.triggerAttackRelease("16n", time, vel);
    else hat.triggerAttackRelease("32n", time, vel);
  }
  function preview(ci) {
    const voiced = voiceLead(CHORDS[ci].pcs, prevVoiced);
    pad.triggerAttackRelease(voiced.map(midiToFreq), "2n", Tone.now());
    sub.triggerAttackRelease(midiToFreq(48 + CHORDS[ci].pcs[0]), "2n", Tone.now());
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
    if (stepInBar === 0) {
      const h = clipAt(song, "harmony", bar);
      if (h) {
        const sc = song.scenes[h.scene];
        if (sc?.harmony?.length) {
          const ci = sc.harmony[(bar - h.start) % sc.harmony.length];
          playChord(ci, time);
          draw.schedule(() => visualCb({ type: "arrchord", bar, chord: ci }), time);
        }
      }
    }
    const d = clipAt(song, "drums", bar);
    if (d) {
      const sc = song.scenes[d.scene];
      for (const v of DRUM_VOICES) if (sc.drums[v][stepInBar] > 0) hitDrum(v, time, sc.drums[v][stepInBar]);
    }
    for (const trk of ["bass", "melody"]) {
      const c = clipAt(song, trk, bar);
      if (c) {
        playNoteStack(trk, song.scenes[c.scene][trk][stepInBar], time);
      }
    }
    draw.schedule(() => visualCb({ type: "arr", bar, stepInBar, len }), time);
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
        res[track] = st.step / (limitBars * 16);
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
        draw.schedule(() => visualCb({ type: "chord", scene: harmonyState.scene, bar, chord: ci, activeScenes: activeBefore }), time);
      }
    }

    const drumState = trackState.drums;
    const drumScene = drumState.active ? song.scenes[drumState.scene] : null;
    if (drumScene) {
      const stepInBar = drumState.step % 16;
      for (const v of DRUM_VOICES) {
        if (drumScene.drums[v][stepInBar] > 0) {
          hitDrum(v, time, drumScene.drums[v][stepInBar]);
          draw.schedule(() => visualCb({ type: "hit", scene: drumState.scene, voice: v, step: stepInBar, activeScenes: activeBefore }), time);
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
    draw.schedule(() => visualCb({ type: "step", scene: curScene, localStep: visualBar * 16 + visualStep, stepInBar: visualStep, bar: visualBar, activeScenes: activeBefore, queuedTracks: queuedCurrent, progress: progressCurrent }), time);
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
      if (reverb.ready) await reverb.ready;
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
      try { pad.releaseAll(Tone.now()); } catch {}
      try { halo.triggerRelease(Tone.now()); } catch {}
      try { sub.triggerRelease(Tone.now()); } catch {}
      try { bassTrk.releaseAll(Tone.now()); } catch {}
      try { lead.releaseAll(Tone.now()); } catch {}
      prevVoiced = null;
      for (const track of TRACK_KEYS) queuedTracks[track] = -1; // clear queues on stop
      draw.schedule(() => visualCb({ type: "queue", activeScenes: activeScenes(), queuedTracks: getQueuedTracks() }), Tone.now());
    },
    toggle() {
      if (playing) this.stop();
      else this.play();
      return playing;
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
    setMode(m, index = focusIndex) {
      mode = m;
      focusIndex = index;
      if (m === "scene") {
        curScene = index;
        for (const track of TRACK_KEYS) resetTrack(track, index);
      }
    },
    setTempo(bpm) {
      transport.bpm.rampTo(bpm, 0.1);
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
      if (channelState[track]) channelState[track].vol = db;
      channels[track].volume.value = db;
    },
    setPan(track, p) {
      if (channelState[track]) channelState[track].pan = p;
      channels[track].pan.value = p;
    },
    setSend(track, db) {
      if (channelState[track]) channelState[track].verb = db;
      const v = sendGain(db);
      verbSends[track].gain.rampTo(v, 0.02);
    },
    setEcho(track, db) {
      if (channelState[track]) channelState[track].echo = db;
      const v = sendGain(db);
      echoSends[track].gain.rampTo(v, 0.02);
    },
    setMute(track, on) {
      if (!(track in channels)) return;
      muteState[track] = !!on;
      if (channelState[track]) channelState[track].mute = !!on;
      applyTrackGates();
    },
    setSolo(track, on) {
      if (!(track in channels)) return;
      soloState[track] = !!on;
      if (channelState[track]) channelState[track].solo = !!on;
      applyTrackGates();
    },
    meter(track) {
      if (track === "master") {
        const mv = masterMeter.getValue();
        return typeof mv === "number" ? mv : Math.max(...mv);
      }
      const v = meters[track].getValue();
      return typeof v === "number" ? v : Math.max(...v);
    },
    // --- devices ---
    kit: () => kitName,
    setKit: applyKit,
    harmonyPreset: () => harmonyPreset,
    setHarmonyPreset: applyHarmonyPreset,
    bassPreset: () => devices.bass.preset,
    setBassPreset: applyBassPreset,
    melodyPreset: () => devices.melody.preset,
    setMelodyPreset: applyMelodyPreset,
    device(track) {
      const d = devices[track];
      const e = d.synth.get().envelope;
      return { wave: d.wave, cutoff: d.cutoff, preset: d.preset, attack: e.attack, decay: e.decay, sustain: e.sustain, release: e.release };
    },
    setDevice(track, param, value) {
      const d = devices[track];
      if (param === "wave") {
        d.wave = value;
        d.synth.set({ oscillator: { type: value } });
      } else if (param === "cutoff") {
        d.cutoff = value;
        d.filter.frequency.rampTo(value, 0.05);
      } else {
        d.synth.set({ envelope: { [param]: value } });
      }
    },
    onVisual(cb) {
      visualCb = cb;
    },
    // --- offline WAV render ---
    async renderOffline(soloTrack) {
      const totalBars = arrangeLength(song);
      const barSec = 240 / song.tempo;
      const dur = totalBars * barSec + 2;
      const buffer = await Tone.Offline(({ transport: offTr }) => {
        offTr.bpm.value = song.tempo;
        offTr.swing = song.swing ?? 0;
        offTr.swingSubdivision = "16n";
        const offLimiter = new Tone.Limiter(-1).toDestination();
        const offSoftClip = new Tone.WaveShaper((x) => Math.tanh(x * 1.35) / Math.tanh(1.35), 2048).connect(offLimiter);
        const offGlue = new Tone.Compressor({ threshold: -20, ratio: 6, attack: 0.025, release: 0.18, knee: 18 }).connect(offSoftClip);
        const offSat = new Tone.Distortion(0.16).connect(offGlue);
        offSat.wet.value = 0.60;
        const offMaster = new Tone.Gain(Tone.dbToGain(-3)).connect(offSat);
        const offDuckGain = new Tone.Gain(1).connect(offMaster);
        const offDrumDry = new Tone.Gain(Tone.dbToGain(-1)).connect(offMaster);
        const offDrumParallel = new Tone.Compressor({ threshold: -24, ratio: 4.5, attack: 0.004, release: 0.13, knee: 12 });
        const offDrumParallelReturn = new Tone.Gain(DRUM_PARALLEL_GAIN).connect(offMaster);
        offDrumParallel.connect(offDrumParallelReturn);
        const offReverb = new Tone.Freeverb({ roomSize: 0.72, dampening: 2600, wet: 1 }).connect(offMaster);
        const offEchoReturn = new Tone.Gain(Tone.dbToGain(-4)).connect(offMaster);
        const offEcho = new Tone.FeedbackDelay({ delayTime: "8n", feedback: 0.26, wet: 1 }).connect(offEchoReturn);
        const offCh = {};
        const anySolo = TRACK_KEYS.some((track) => channelState[track].solo);
        for (const k of TRACK_KEYS) {
          const st = channelState[k];
          const muted = soloTrack ? k !== soloTrack : st.mute || (anySolo && !st.solo);
          offCh[k] = new Tone.Channel({ volume: muted ? -Infinity : st.vol, pan: st.pan, mute: muted });
          if (k === "drums") {
            offCh[k].connect(offDrumDry);
            offCh[k].connect(offDrumParallel);
          } else {
            offCh[k].connect(offDuckGain);
          }
          offCh[k].connect(new Tone.Gain(sendGain(st.verb ?? verbDefault[k])).connect(offReverb));
          offCh[k].connect(new Tone.Gain(sendGain(st.echo ?? echoDefault[k])).connect(offEcho));
        }

        const hp = HARMONY_PRESETS[harmonyPreset] || HARMONY_PRESETS.keys;
        const offPadHp = new Tone.Filter({ type: "highpass", frequency: 170, Q: 0.6 });
        const offPadF = new Tone.Filter({ type: "lowpass", frequency: hp.filter, Q: 0.7 });
        const offChorus = new Tone.Chorus({ frequency: 0.4, delayTime: 4, depth: hp.chorusDepth, wet: hp.chorusWet }).start();
        offPadHp.connect(offPadF); offPadF.connect(offChorus); offChorus.connect(offCh.harmony);
        const offPad = new Tone.PolySynth(Tone.Synth, { maxPolyphony: 4, oscillator: { type: hp.osc }, envelope: { attack: hp.attack, decay: hp.decay, sustain: hp.sustain, release: hp.release }, volume: SOURCE_LEVEL_DB.harmonyPad }).connect(offPadHp);
        const offHalo = new Tone.Synth({ oscillator: { type: "sine" }, envelope: { attack: 0.9, decay: 1, sustain: 0.5, release: 1.6 }, volume: SOURCE_LEVEL_DB.harmonyHalo }).connect(offCh.harmony);
        const offRootHp = new Tone.Filter({ type: "highpass", frequency: 120, Q: 0.7 }).connect(offCh.harmony);
        const offSub = new Tone.Synth({ oscillator: { type: "sine" }, envelope: { attack: 0.08, decay: 0.4, sustain: 0.85, release: 1.6 }, volume: SOURCE_LEVEL_DB.harmonyRoot }).connect(offRootHp);

        const bp = BASS_PRESETS[devices.bass.preset] || BASS_PRESETS.deep;
        const offBHp = new Tone.Filter({ type: "highpass", frequency: 34, Q: 0.7 }).connect(offCh.bass);
        const offBF = new Tone.Filter({ type: "lowpass", frequency: bp.cutoff, Q: 0.9 }).connect(offBHp);
        const offBass = new Tone.PolySynth(Tone.Synth, { maxPolyphony: 6, oscillator: { type: bp.wave }, envelope: { attack: bp.attack, decay: bp.decay, sustain: bp.sustain, release: bp.release }, volume: SOURCE_LEVEL_DB.bass }).connect(offBF);

        const mp = MELODY_PRESETS[devices.melody.preset] || MELODY_PRESETS.lead;
        const offLHp = new Tone.Filter({ type: "highpass", frequency: 180, Q: 0.7 }).connect(offCh.melody);
        const offLF = new Tone.Filter({ type: "lowpass", frequency: mp.cutoff, Q: 0.6 }).connect(offLHp);
        const offLead = new Tone.PolySynth(Tone.Synth, { maxPolyphony: 8, oscillator: { type: mp.wave }, envelope: { attack: mp.attack, decay: mp.decay, sustain: mp.sustain, release: mp.release }, volume: SOURCE_LEVEL_DB.melody }).connect(offLF);

        const offKickF = new Tone.Filter({ type: "lowpass", frequency: 1800, Q: 0.5 }).connect(offCh.drums);
        const offKick = new Tone.MembraneSynth({ volume: SOURCE_LEVEL_DB.kick }).connect(offKickF);
        const offSnF = new Tone.Filter({ type: "highpass", frequency: 950 }).connect(offCh.drums);
        const offSnare = new Tone.NoiseSynth({ noise: { type: "white" }, volume: SOURCE_LEVEL_DB.snare }).connect(offSnF);
        const offHatF = new Tone.Filter({ type: "highpass", frequency: 7500 }).connect(offCh.drums);
        const offHat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.02, sustain: 0 }, volume: SOURCE_LEVEL_DB.hat }).connect(offHatF);
        const offClF = new Tone.Filter({ type: "bandpass", frequency: 1400, Q: 1.2 }).connect(offCh.drums);
        const offClap = new Tone.NoiseSynth({ noise: { type: "pink" }, volume: SOURCE_LEVEL_DB.clap }).connect(offClF);

        let offPrev = null;
        const offSix = () => Tone.Time("16n").toSeconds();
        let step = 0;
        const loop = new Tone.Loop((time) => {
          const bar = Math.floor(step / 16);
          if (bar >= totalBars) return;
          const sib = step % 16;
          if (sib === 0) {
            const h = clipAt(song, "harmony", bar);
            if (h) {
              const sc = song.scenes[h.scene];
              if (sc?.harmony?.length) {
                const ci = sc.harmony[(bar - h.start) % sc.harmony.length];
                const v = voiceLead(CHORDS[ci].pcs, offPrev);
                offPrev = v;
                offPad.triggerAttackRelease(v.map(midiToFreq), "1n", time);
                offHalo.triggerAttackRelease(midiToFreq(Math.max(...v) + 12), "1n", time);
                offSub.triggerAttackRelease(midiToFreq(48 + CHORDS[ci].pcs[0]), "1n", time);
              }
            }
          }
          const d = clipAt(song, "drums", bar);
          if (d) { 
            const sc = song.scenes[d.scene]; 
            for (const v of DRUM_VOICES) {
              if (sc.drums[v][sib] > 0) { 
                const kParams = KITS[kitName];
                if (v === "kick") {
                  scheduleKickDuck(offDuckGain.gain, time);
                  offKick.set({ pitchDecay: kParams.kick.pitchDecay, octaves: kParams.kick.octaves, envelope: kParams.kick.envelope });
                  offKick.triggerAttackRelease("C1", "8n", time); 
                } else if (v === "snare") {
                  offSnare.set({ envelope: { attack: 0.001, decay: kParams.snare, sustain: 0 } });
                  offSnare.triggerAttackRelease("16n", time); 
                } else if (v === "clap") {
                  offClap.set({ envelope: { attack: 0.001, decay: kParams.clap, sustain: 0 } });
                  offClap.triggerAttackRelease("16n", time); 
                } else {
                  offHat.set({ envelope: { attack: 0.001, decay: kParams.hat.decay, sustain: 0 } });
                  offHatF.frequency.value = kParams.hat.resonance;
                  offHat.triggerAttackRelease("32n", time); 
                }
              } 
            }
          }
          for (const trk of ["bass", "melody"]) {
            const c = clipAt(song, trk, bar);
            if (c) {
              const synth = trk === "bass" ? offBass : offLead;
              for (const n of noteSlot(song.scenes[c.scene][trk][sib])) {
                synth.triggerAttackRelease(midiToFreq(n.midi), offSix() * (n.len || 1) * (trk === "bass" ? 1.1 : 1), time, n.vel ?? 0.9);
              }
            }
          }
          step++;
        }, "16n");
        loop.start(0);
        offTr.start(0);
      }, dur);
      return buffer;
    },
  };
}
