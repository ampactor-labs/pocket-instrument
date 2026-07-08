// Tone.js engine. Per-track mixer channels (vol/pan/send + meter), adjustable
// devices (tight funk/garage kit + bass/lead synth params), note length +
// velocity, and a transport that loops a Scene or plays the Arrangement.

import * as Tone from "tone";
import { CHORDS, DRUM_VOICES, voiceLead, clipAt, arrangeLength, clipLaunch, clipLengthBars } from "./model.js";

const midiToFreq = (m) => Tone.Frequency(m, "midi").toFrequency();
const sixteenth = () => Tone.Time("16n").toSeconds();

export const TRACK_KEYS = ["harmony", "drums", "bass", "melody"];

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
  const master = new Tone.Limiter(-1).toDestination();
  // Algorithmic (Freeverb) instead of convolution — far cheaper per sample on a
  // low-end mobile CPU, and fine for a send reverb.
  const reverb = new Tone.Freeverb({ roomSize: 0.72, dampening: 2600, wet: 1 }).connect(master);
  // A Channel return receives the "verb" send bus and feeds the reverb.
  const reverbReturn = new Tone.Channel().connect(reverb);
  reverbReturn.receive("verb");

  // Mixer strips.
  const channels = {};
  const meters = {};
  const sends = {};
  for (const k of TRACK_KEYS) {
    channels[k] = new Tone.Channel({ volume: 0, pan: 0 }).connect(master);
    meters[k] = new Tone.Meter();
    channels[k].connect(meters[k]);
    sends[k] = channels[k].send("verb", -60);
  }
  const sendDefault = { harmony: -9, melody: -11, drums: -22, bass: -48 };
  for (const k of TRACK_KEYS) sends[k].gain.value = Tone.dbToGain(sendDefault[k]);

  // Harmony: lush pad.
  const chorus = new Tone.Chorus({ frequency: 0.4, delayTime: 4, depth: 0.6, wet: 0.35 }).start();
  const padFilter = new Tone.Filter({ type: "lowpass", frequency: 1500, Q: 0.7 });
  new Tone.LFO({ frequency: 0.05, min: 850, max: 2600 }).connect(padFilter.frequency).start();
  padFilter.connect(chorus);
  chorus.connect(channels.harmony);
  const pad = new Tone.PolySynth(Tone.Synth, {
    maxPolyphony: 4, // chords are 3-4 notes; headroom-only voices removed
    oscillator: { type: "sawtooth" }, // plain saw (one osc/voice); chorus supplies the width
    envelope: { attack: 0.28, decay: 1.1, sustain: 0.72, release: 1.0 }, // short tail = little cross-bar overlap
    volume: -16,
  }).connect(padFilter);
  // Mono shimmer on the top note (was a 6-voice PolySynth, inaudible at -28 dB).
  const halo = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.9, decay: 1, sustain: 0.5, release: 1.6 },
    volume: -26,
  }).connect(channels.harmony);
  const sub = new Tone.Synth({
    oscillator: { type: "sine" },
    envelope: { attack: 0.08, decay: 0.4, sustain: 0.85, release: 1.6 },
    volume: -13,
  }).connect(channels.harmony);

  // Bass + lead — device params live-adjustable.
  const bassFilter = new Tone.Filter({ type: "lowpass", frequency: 750, Q: 0.9 }).connect(channels.bass);
  const bassTrk = new Tone.Synth({
    oscillator: { type: "sawtooth" },
    envelope: { attack: 0.02, decay: 0.2, sustain: 0.6, release: 0.25 },
    volume: -10,
  }).connect(bassFilter);
  const leadFilter = new Tone.Filter({ type: "lowpass", frequency: 3200, Q: 0.6 }).connect(channels.melody);
  const lead = new Tone.Synth({
    oscillator: { type: "triangle" },
    envelope: { attack: 0.01, decay: 0.16, sustain: 0.35, release: 0.3 },
    volume: -14,
  }).connect(leadFilter);
  const devices = {
    bass: { synth: bassTrk, filter: bassFilter, wave: "sawtooth", cutoff: 750 },
    melody: { synth: lead, filter: leadFilter, wave: "triangle", cutoff: 3200 },
  };

  // Kit.
  const kick = new Tone.MembraneSynth({ volume: -2 }).connect(channels.drums);
  const snareFilter = new Tone.Filter({ type: "highpass", frequency: 1400 }).connect(channels.drums);
  const snare = new Tone.NoiseSynth({ noise: { type: "white" }, volume: -10 }).connect(snareFilter);
  // Tight garage hat as a filtered noise burst (was MetalSynth: 6 FM oscillators
  // on the most-triggered voice — the priciest drum in the kit).
  const hatFilter = new Tone.Filter({ type: "highpass", frequency: 7500 }).connect(channels.drums);
  const hat = new Tone.NoiseSynth({ noise: { type: "white" }, envelope: { attack: 0.001, decay: 0.02, sustain: 0 }, volume: -14 }).connect(hatFilter);
  const clapFilter = new Tone.Filter({ type: "bandpass", frequency: 1400, Q: 1.2 }).connect(channels.drums);
  const clap = new Tone.NoiseSynth({ noise: { type: "pink" }, volume: -12 }).connect(clapFilter);

  let kitName = "garage";
  function applyKit(name) {
    const k = KITS[name] || KITS.garage;
    kitName = name;
    kick.set({ pitchDecay: k.kick.pitchDecay, octaves: k.kick.octaves, envelope: k.kick.envelope });
    snare.set({ envelope: { attack: 0.001, decay: k.snare, sustain: 0 } });
    hat.set({ envelope: { attack: 0.001, decay: k.hat.decay, sustain: 0 } });
    hatFilter.frequency.value = k.hat.resonance;
    clap.set({ envelope: { attack: 0.001, decay: k.clap, sustain: 0 } });
  }
  applyKit("garage");

  let prevVoiced = null;
  function playChord(ci, time) {
    const voiced = voiceLead(CHORDS[ci].pcs, prevVoiced);
    prevVoiced = voiced;
    pad.triggerAttackRelease(voiced.map(midiToFreq), "1n", time);
    halo.triggerAttackRelease(midiToFreq(Math.max(...voiced) + 12), "1n", time);
    sub.triggerAttackRelease(midiToFreq(36 + CHORDS[ci].pcs[0]), "1n", time);
  }
  const playLead = (n, time) =>
    lead.triggerAttackRelease(midiToFreq(n.midi), sixteenth() * (n.len || 1), time, n.vel ?? 0.9);
  const playBass = (n, time) =>
    bassTrk.triggerAttackRelease(midiToFreq(n.midi), sixteenth() * (n.len || 1) * 1.1, time, n.vel ?? 0.95);
  function hitDrum(v, time) {
    if (v === "kick") kick.triggerAttackRelease("C1", "8n", time);
    else if (v === "snare") snare.triggerAttackRelease("16n", time);
    else if (v === "clap") clap.triggerAttackRelease("16n", time);
    else hat.triggerAttackRelease("32n", time);
  }
  function preview(ci) {
    const voiced = voiceLead(CHORDS[ci].pcs, prevVoiced);
    pad.triggerAttackRelease(voiced.map(midiToFreq), "2n", Tone.now());
    sub.triggerAttackRelease(midiToFreq(36 + CHORDS[ci].pcs[0]), "2n", Tone.now());
  }

  // Transport.
  let mode = "scene";
  let focusIndex = 0;
  let curScene = 0;
  const trackState = Object.fromEntries(TRACK_KEYS.map((track) => [track, { scene: 0, step: 0, active: true }]));
  let arrStep = 0;
  let visualCb = () => {};

  Tone.Transport.bpm.value = song.tempo;
  Tone.Transport.swingSubdivision = "16n";
  Tone.Transport.swing = song.swing ?? 0;

  function tickArrangement(time) {
    const len = arrangeLength(song);
    const bar = Math.floor(arrStep / 16);
    const stepInBar = arrStep % 16;
    if (stepInBar === 0) {
      const h = clipAt(song, "harmony", bar);
      if (h) {
        const sc = song.scenes[h.scene];
        const ci = sc.harmony[(bar - h.start) % sc.harmony.length];
        playChord(ci, time);
        Tone.Draw.schedule(() => visualCb({ type: "arrchord", bar, chord: ci }), time);
      }
    }
    const d = clipAt(song, "drums", bar);
    if (d) {
      const sc = song.scenes[d.scene];
      for (const v of DRUM_VOICES) if (sc.drums[v][stepInBar]) hitDrum(v, time);
    }
    for (const trk of ["bass", "melody"]) {
      const c = clipAt(song, trk, bar);
      if (c) {
        const n = song.scenes[c.scene][trk][stepInBar];
        if (n) (trk === "bass" ? playBass : playLead)(n, time);
      }
    }
    Tone.Draw.schedule(() => visualCb({ type: "arr", bar, stepInBar, len }), time);
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
    const activeBefore = activeScenes();
    const harmonyState = trackState.harmony;
    const harmonyScene = harmonyState.active ? song.scenes[harmonyState.scene] : null;
    let visualStep = 0;
    let visualBar = 0;
    if (harmonyScene) {
      const stepInBar = harmonyState.step % 16;
      const bar = Math.floor(harmonyState.step / 16) % harmonyScene.harmony.length;
      visualStep = stepInBar;
      visualBar = bar;
      if (stepInBar === 0) {
        const ci = harmonyScene.harmony[bar];
        playChord(ci, time);
        Tone.Draw.schedule(() => visualCb({ type: "chord", scene: harmonyState.scene, bar, chord: ci, activeScenes: activeBefore }), time);
      }
    }

    const drumState = trackState.drums;
    const drumScene = drumState.active ? song.scenes[drumState.scene] : null;
    if (drumScene) {
      const stepInBar = drumState.step % 16;
      for (const v of DRUM_VOICES) {
        if (drumScene.drums[v][stepInBar]) {
          hitDrum(v, time);
          Tone.Draw.schedule(() => visualCb({ type: "hit", scene: drumState.scene, voice: v, step: stepInBar, activeScenes: activeBefore }), time);
        }
      }
    }

    for (const track of ["bass", "melody"]) {
      const st = trackState[track];
      const scene = st.active ? song.scenes[st.scene] : null;
      if (!scene) continue;
      const stepInBar = st.step % 16;
      const n = scene[track][stepInBar];
      if (n) (track === "bass" ? playBass : playLead)(n, time);
    }

    for (const track of TRACK_KEYS) advanceSceneTrack(track);
    const activeAfter = activeScenes();
    Tone.Draw.schedule(() => visualCb({ type: "step", scene: curScene, localStep: visualBar * 16 + visualStep, stepInBar: visualStep, bar: visualBar, activeScenes: activeAfter }), time);
  }, "16n");

  let playing = false;
  let inited = false;

  return {
    async init() {
      if (inited) return;
      inited = true;
      await Tone.start();
      if (reverb.ready) await reverb.ready;
      clock.start(0);
    },
    play() {
      Tone.Transport.start();
      playing = true;
    },
    stop() {
      Tone.Transport.pause();
      playing = false;
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
      curScene = index;
      for (const track of TRACK_KEYS) resetTrack(track, index);
      Tone.Draw.schedule(() => visualCb({ type: "step", scene: index, localStep: 0, stepInBar: 0, bar: 0, activeScenes: activeScenes() }), Tone.now());
      if (!playing) this.play();
    },
    launchClip(index, track) {
      mode = "scene";
      focusIndex = index;
      curScene = index;
      if (!playing) for (const key of TRACK_KEYS) trackState[key].active = false;
      resetTrack(track, index);
      Tone.Draw.schedule(() => visualCb({ type: "step", scene: index, localStep: 0, stepInBar: 0, bar: 0, activeScenes: activeScenes() }), Tone.now());
      if (!playing) this.play();
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
      Tone.Transport.bpm.rampTo(bpm, 0.1);
    },
    setSwing(v) {
      Tone.Transport.swing = v;
    },
    preview,
    previewHit(v) {
      hitDrum(v, Tone.now());
    },
    previewNote(track, midi) {
      (track === "bass" ? playBass : playLead)({ midi, len: 1, vel: 0.9 }, Tone.now());
    },
    // --- mixer ---
    setVol(track, db) {
      channels[track].volume.value = db;
    },
    setPan(track, p) {
      channels[track].pan.value = p;
    },
    setSend(track, db) {
      sends[track].gain.value = Tone.dbToGain(db);
    },
    meter(track) {
      const v = meters[track].getValue();
      return typeof v === "number" ? v : Math.max(...v);
    },
    // --- devices ---
    kit: () => kitName,
    setKit: applyKit,
    device(track) {
      const d = devices[track];
      const e = d.synth.get().envelope;
      return { wave: d.wave, cutoff: d.cutoff, attack: e.attack, decay: e.decay, sustain: e.sustain, release: e.release };
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
  };
}
