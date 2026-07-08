// Pocket — a mobile take on Ableton's Session view.
// Clip grid (tracks x scenes) + transport; tap a clip to edit it (drum rack /
// chord editor). DOM/CSS for the DAW chrome, Tone.js underneath.

import {
  CHORDS,
  DRUM_VOICES,
  DRUM_META,
  ARRANGE_TRACKS,
  SCALE_NAMES,
  chordColor,
  hslInt,
  makeSong,
  cloneScene,
  arrangeLength,
  scaleNotes,
  noteName,
  pcName,
  setScaleContext,
  snapToScale,
} from "./model.js";
import { createAudio, KIT_NAMES } from "./audio.js";

// Pitch range shown in the piano roll, per track.
const PIANO = { melody: { base: 60, rows: 15 }, bass: { base: 36, rows: 12 } };

const hex = (n) => "#" + (n >>> 0).toString(16).padStart(6, "0");
const chordHex = (ci) => hex(chordColor(ci));
const padHex = (v) => hex(hslInt(DRUM_META[v].hue, DRUM_META[v].sat, DRUM_META[v].light));

const TRACKS = [
  { key: "harmony", name: "Harmony", color: "#e8b84b" },
  { key: "drums", name: "Drums", color: "#54a8e0" },
  { key: "bass", name: "Bass", color: "#cf6f9b" },
  { key: "melody", name: "Melody", color: "#7bc86c" },
];
const trackColor = (k) => TRACKS.find((t) => t.key === k).color;

const song = makeSong();
setScaleContext(song.key, song.scale);
const audio = createAudio(song);

// --- DOM helpers ---
function el(tag, props = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "style") e.setAttribute("style", v);
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c) e.appendChild(c);
  return e;
}

let audioReady = false;
async function ensureStarted() {
  if (audioReady) return;
  audioReady = true;
  await audio.init();
}

let playingScene = -1;
const sceneEls = []; // per scene: { row, clips: {track: el} }

let view = "session"; // 'session' | 'arrangement'
let ppb = 74; // arrangement pixels-per-bar (pinch zooms this)
let arrPlayBar = 0; // arrangement playhead position in bars
let selClip = null; // { track, idx }

// --- Undo / redo (whole-song snapshots; simple and covers every edit) ---
const undoStack = [];
const redoStack = [];
let undoBtn = null;
let redoBtn = null;
const snapshot = () => structuredClone(song);
function commitUndo(pre) {
  undoStack.push(pre);
  if (undoStack.length > 60) undoStack.shift();
  redoStack.length = 0;
  updateUndoButtons();
}
function pushUndo() {
  commitUndo(snapshot());
}
function refreshAll() {
  setScaleContext(song.key, song.scale);
  audio.setTempo(song.tempo);
  audio.setSwing(song.swing);
  closeEditor();
  renderTransport();
  renderSession();
  if (view === "arrangement") renderArrangement();
  updateUndoButtons();
}
function restoreSnap(s) {
  Object.assign(song, structuredClone(s));
  selClip = null;
  refreshAll();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restoreSnap(undoStack.pop());
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restoreSnap(redoStack.pop());
}
function updateUndoButtons() {
  if (undoBtn) undoBtn.classList.toggle("disabled", undoStack.length === 0);
  if (redoBtn) redoBtn.classList.toggle("disabled", redoStack.length === 0);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
const transport = document.getElementById("transport");
let playBtn;
let bpmEl;

function renderTransport() {
  transport.innerHTML = "";
  playBtn = el("div", {
    class: "tbtn play",
    text: "▶",
    onclick: async () => {
      await ensureStarted();
      if (view === "arrangement") {
        if (audio.playing) audio.stop();
        else audio.playArrangement(arrPlayBar);
      } else {
        audio.toggle();
      }
      updatePlayBtn(audio.playing);
    },
  });
  bpmEl = el("div", { id: "bpm", html: `${song.tempo}<small>BPM</small>` });
  const minus = el("div", { class: "tbtn", text: "–", onclick: () => nudgeTempo(-1) });
  const plus = el("div", { class: "tbtn", text: "+", onclick: () => nudgeTempo(1) });
  const grooveVal = el("span", { class: "swval", text: Math.round(song.swing * 100) + "%" });
  const grooveSlider = el("input", {
    type: "range",
    min: "0",
    max: "0.6",
    step: "0.01",
    value: String(song.swing),
    class: "swingslider",
  });
  grooveSlider.addEventListener("pointerdown", () => pushUndo());
  grooveSlider.addEventListener("input", () => {
    song.swing = parseFloat(grooveSlider.value);
    audio.setSwing(song.swing);
    grooveVal.textContent = Math.round(song.swing * 100) + "%";
  });
  const groove = el("div", { class: "swingctl" }, [
    el("span", { class: "swlabel", text: "groove" }),
    grooveSlider,
    grooveVal,
  ]);
  const keySel = el("select", { class: "keysel" });
  for (let i = 0; i < 12; i++) {
    const o = el("option", { value: String(i), text: pcName(i) });
    if (i === song.key) o.selected = true;
    keySel.appendChild(o);
  }
  keySel.addEventListener("change", () => setKeyScale(parseInt(keySel.value, 10), song.scale));
  const scaleSel = el("select", { class: "keysel" });
  SCALE_NAMES.forEach((n) => {
    const o = el("option", { value: n, text: n });
    if (n === song.scale) o.selected = true;
    scaleSel.appendChild(o);
  });
  scaleSel.addEventListener("change", () => setKeyScale(song.key, scaleSel.value));
  const keyctl = el("div", { class: "keyctl" }, [el("span", { class: "swlabel", text: "key" }), keySel, scaleSel]);
  const seg = el("div", { class: "seg" }, [
    el("div", {
      class: "opt" + (view === "session" ? " on" : ""),
      text: "Session",
      onclick: () => setView("session"),
    }),
    el("div", {
      class: "opt" + (view === "arrangement" ? " on" : ""),
      text: "Arrange",
      onclick: () => setView("arrangement"),
    }),
  ]);
  seg.style.marginLeft = "auto";
  const mixBtn = el("div", { class: "tbtn", text: "Mix", onclick: openMixer });
  const addBtn = el("div", {
    class: "tbtn",
    text: "＋",
    onclick: () => {
      pushUndo();
      const from = playingScene >= 0 ? playingScene : song.scenes.length - 1;
      song.scenes.push(cloneScene(song.scenes[from]));
      renderSession();
    },
  });
  // Play/pause + undo/redo are pinned left and never scroll.
  undoBtn = el("div", { class: "tbtn undo", text: "↶", onclick: undo });
  redoBtn = el("div", { class: "tbtn redo", text: "↷", onclick: redo });
  const left = el("div", { class: "tleft" }, [playBtn, undoBtn, redoBtn]);
  const scroll = el("div", { class: "tscroll" }, [bpmEl, minus, plus, keyctl, groove, seg, mixBtn, addBtn]);
  transport.append(left, scroll);
  updateUndoButtons();
}

function setView(v) {
  view = v;
  if (audioReady) audio.stop();
  document.getElementById("app").classList.toggle("arrange", v === "arrangement");
  if (v === "arrangement") {
    audio.enterArrangement();
    renderArrangement();
  }
  renderTransport();
}
function updatePlayBtn(on) {
  playBtn.classList.toggle("on", on);
  playBtn.textContent = on ? "⏸" : "▶";
}
function nudgeTempo(d) {
  pushUndo();
  song.tempo = Math.max(40, Math.min(220, song.tempo + d));
  bpmEl.innerHTML = `${song.tempo}<small>BPM</small>`;
  audio.setTempo(song.tempo);
}

// Change the global key/scale; harmony follows automatically (it's degree-based),
// and bass/melody are transposed + re-snapped so the whole song stays in key.
function setKeyScale(key, scale) {
  pushUndo();
  const delta = key - song.key;
  song.key = ((key % 12) + 12) % 12;
  song.scale = scale;
  setScaleContext(song.key, song.scale);
  for (const sc of song.scenes) {
    for (const trk of ["bass", "melody"]) {
      for (let s = 0; s < 16; s++) {
        const n = sc[trk][s];
        if (n) n.midi = snapToScale(n.midi + delta);
      }
    }
  }
  refreshAll();
}

// ---------------------------------------------------------------------------
// Session grid
// ---------------------------------------------------------------------------
const sessionEl = document.getElementById("session");

function clipContent(scene, track) {
  if (track === "harmony") {
    return el("div", { text: scene.harmony.map((ci) => CHORDS[ci].roman).join("  ") });
  }
  if (track === "drums") {
    const mini = el("div", { class: "mini" });
    for (let s = 0; s < 16; s++) {
      const hit = scene.drums.kick[s] || scene.drums.snare[s] || scene.drums.clap[s];
      mini.appendChild(el("i", { style: `height:${hit ? 15 : scene.drums.hat[s] ? 8 : 3}px` }));
    }
    return mini;
  }
  if (track === "melody" || track === "bass") {
    const mini = el("div", { class: "mini" });
    const lane = scene[track];
    for (let s = 0; s < 16; s++)
      mini.appendChild(el("i", { style: `height:${lane[s] ? Math.round(4 + (lane[s].vel ?? 0.9) * 11) : 3}px` }));
    return mini;
  }
  return null;
}

function renderSession() {
  sessionEl.innerHTML = "";
  sceneEls.length = 0;
  const grid = el("div", { class: "grid" });
  grid.appendChild(el("div", { class: "head corner", text: "" }));
  for (const t of TRACKS) {
    grid.appendChild(el("div", { class: "head", style: `--tc:${t.color}`, text: t.name }));
  }
  song.scenes.forEach((scene, i) => {
    const refs = { clips: {} };
    const launch = el("div", {
      class: "scenecell",
      onclick: async () => {
        await ensureStarted();
        audio.launchScene(i);
        setPlaying(i);
        updatePlayBtn(true);
      },
    }, [el("div", { class: "tri", text: "▶" }), el("div", { text: scene.tag })]);
    refs.row = launch;
    grid.appendChild(launch);

    for (const t of TRACKS) {
      const content = clipContent(scene, t.key);
      const filled = content !== null;
      const clip = el("div", {
        class: `clip ${filled ? "filled" : "empty"}`,
        style: `--tc:${t.color}`,
        onclick: () => {
          if (filled) openEditor(i, t.key);
        },
      });
      if (filled) {
        clip.appendChild(el("div", { class: "tri", text: "▶" }));
        clip.appendChild(content);
      } else {
        clip.textContent = "＋";
      }
      refs.clips[t.key] = clip;
      grid.appendChild(clip);
    }
    sceneEls.push(refs);
  });
  sessionEl.appendChild(grid);
  applyPlaying();
}

function setPlaying(i) {
  playingScene = i;
  applyPlaying();
}
function applyPlaying() {
  sceneEls.forEach((r, i) => {
    const on = i === playingScene;
    r.row.classList.toggle("playing", on);
    for (const t of TRACKS) {
      const c = r.clips[t.key];
      if (c && c.classList.contains("filled")) c.classList.toggle("playing", on);
    }
  });
}

// ---------------------------------------------------------------------------
// Editor sheet
// ---------------------------------------------------------------------------
const sheet = document.getElementById("sheet");
const scrim = document.getElementById("scrim");
let editor = null; // { scene, track, stepEls, cursor }

scrim.addEventListener("click", closeEditor);

function openEditor(sceneIndex, track) {
  const scene = song.scenes[sceneIndex];
  editor = { scene: sceneIndex, track, cursorCols: null, cursor: -1 };
  sheet.innerHTML = "";
  sheet.style.setProperty("--tc", trackColor(track));

  const title = track === "drums" ? "Drum Rack" : track === "harmony" ? "Chords" : "Piano Roll";
  sheet.appendChild(
    el("div", { class: "sheet-bar" }, [
      el("div", { class: "swatch" }),
      el("div", { class: "title", text: title }),
      el("div", { class: "sub", text: `${TRACKS.find((t) => t.key === track).name} · Scene ${scene.tag}` }),
      el("div", { class: "close", text: "Done", onclick: closeEditor }),
    ])
  );

  if (track === "drums") buildDrumEditor(scene);
  else if (track === "harmony") buildHarmonyEditor(sceneIndex, scene);
  else buildPianoEditor(sceneIndex, scene, track);

  scrim.classList.add("open");
  sheet.classList.add("open");
}

function closeEditor() {
  editor = null;
  cancelAnimationFrame(mixerRAF);
  mixerRAF = 0;
  scrim.classList.remove("open");
  sheet.classList.remove("open");
}

// ---------------------------------------------------------------------------
// Mixer + devices
// ---------------------------------------------------------------------------
let mixerRAF = 0;
const mixState = {
  harmony: { vol: 0, pan: 0, send: -9 },
  drums: { vol: 0, pan: 0, send: -22 },
  bass: { vol: 0, pan: 0, send: -48 },
  melody: { vol: 0, pan: 0, send: -11 },
};

function slider(min, max, step, val, oninput) {
  const s = el("input", { type: "range", min, max, step, value: val });
  s.addEventListener("input", () => oninput(parseFloat(s.value)));
  return s;
}

function openMixer() {
  editor = null;
  sheet.innerHTML = "";
  sheet.style.setProperty("--tc", "#8a8a90");
  sheet.appendChild(
    el("div", { class: "sheet-bar" }, [
      el("div", { class: "title", text: "Mixer" }),
      el("div", { class: "sub", text: "levels · sends · devices" }),
      el("div", { class: "close", text: "Done", onclick: closeEditor }),
    ])
  );

  const meterBars = {};
  for (const t of TRACKS) {
    const k = t.key;
    const ms = mixState[k];
    const meter = el("div", { class: "mxmeter" }, [el("i")]);
    meterBars[k] = meter.firstChild;
    const ctrl = el("div", { class: "mxctrl" }, [
      el("label", { text: "vol" }), slider(-40, 6, 1, ms.vol, (v) => { ms.vol = v; audio.setVol(k, v); }),
      el("label", { text: "pan" }), slider(-1, 1, 0.05, ms.pan, (v) => { ms.pan = v; audio.setPan(k, v); }),
      el("label", { text: "send" }), slider(-60, 0, 1, ms.send, (v) => { ms.send = v; audio.setSend(k, v); }),
    ]);
    const dev = el("div", { class: "mxdev" });
    if (k === "drums") {
      const sel = el("select");
      KIT_NAMES.forEach((n) => {
        const o = el("option", { value: n, text: n });
        if (n === audio.kit()) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => audio.setKit(sel.value));
      dev.append(el("label", { text: "kit" }), sel);
    } else if (k === "bass" || k === "melody") {
      const d = audio.device(k);
      dev.append(
        el("label", { text: "cutoff" }), slider(120, 8000, 20, d.cutoff, (v) => audio.setDevice(k, "cutoff", v)),
        el("label", { text: "decay" }), slider(0.03, 1.2, 0.01, d.decay, (v) => audio.setDevice(k, "decay", v))
      );
    }
    sheet.appendChild(
      el("div", { class: "mxstrip", style: `--tc:${t.color}` }, [
        el("div", { class: "mxhead" }, [el("span", { class: "mxdot" }), el("span", { text: t.name })]),
        meter,
        ctrl,
        dev,
      ])
    );
  }

  scrim.classList.add("open");
  sheet.classList.add("open");
  const tick = () => {
    for (const t of TRACKS) {
      const lvl = Math.max(0, Math.min(1, (audio.meter(t.key) + 54) / 54));
      const bar = meterBars[t.key];
      if (bar && Math.abs((bar._lvl || 0) - lvl) > 0.01) {
        bar.style.transform = `scaleX(${lvl})`;
        bar._lvl = lvl;
      }
    }
    mixerRAF = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(mixerRAF);
  mixerRAF = requestAnimationFrame(tick);
}

function buildDrumEditor(scene) {
  const tfd = el("div", { class: "tfrow" }, [
    el("div", {
      class: "tfbtn",
      text: "Random",
      onclick: () => {
        pushUndo();
        const dens = { kick: 0.32, snare: 0.14, hat: 0.5, clap: 0.12 };
        for (const v of DRUM_VOICES) for (let s = 0; s < 16; s++) scene.drums[v][s] = Math.random() < dens[v];
        openEditor(editor.scene, "drums");
        refreshClip(editor.scene, "drums");
      },
    }),
    el("div", {
      class: "tfbtn",
      text: "Clear",
      onclick: () => {
        pushUndo();
        for (const v of DRUM_VOICES) for (let s = 0; s < 16; s++) scene.drums[v][s] = false;
        openEditor(editor.scene, "drums");
        refreshClip(editor.scene, "drums");
      },
    }),
  ]);
  sheet.appendChild(tfd);

  const stepEls = {};
  for (const v of DRUM_VOICES) {
    stepEls[v] = [];
    const steps = el("div", { class: "steps" });
    for (let s = 0; s < 16; s++) {
      const on = scene.drums[v][s];
      const cell = el("div", {
        class: `step ${Math.floor(s / 4) % 2 ? "" : "g"} ${on ? "on" : ""}`,
        style: `--pc:${padHex(v)}`,
        onclick: async () => {
          await ensureStarted();
          pushUndo();
          scene.drums[v][s] = !scene.drums[v][s];
          cell.classList.toggle("on", scene.drums[v][s]);
          if (scene.drums[v][s]) audio.previewHit(v);
          refreshClip(editor.scene, "drums");
        },
      });
      stepEls[v].push(cell);
      steps.appendChild(cell);
    }
    const pad = el("div", {
      class: "pad",
      style: `--pc:${padHex(v)}`,
      text: DRUM_META[v].label,
      onclick: async () => {
        await ensureStarted();
        audio.previewHit(v);
      },
    });
    sheet.appendChild(el("div", { class: "drumrow" }, [pad, steps]));
  }
  editor.stepEls = stepEls;
  editor.cursorCols = Array.from({ length: 16 }, (_, s) => DRUM_VOICES.map((v) => stepEls[v][s]));
}

function buildPianoEditor(sceneIndex, scene, track) {
  const cfg = PIANO[track];
  const rows = scaleNotes(cfg.base, cfg.rows).reverse(); // high pitch on top
  const lane = scene[track];
  const tc = trackColor(track);

  // One-tap transforms.
  const pcToMidi = (pc, base) => {
    let m = base - (((base % 12) + 12) % 12) + (((pc % 12) + 12) % 12);
    while (m < base) m += 12;
    return m;
  };
  const applyTf = (fn) => {
    pushUndo();
    fn();
    paint();
    refreshClip(sceneIndex, track);
  };
  const tf = el("div", { class: "tfrow" }, [
    el("div", {
      class: "tfbtn",
      text: "Arp",
      onclick: () =>
        applyTf(() => {
          for (let b = 0; b < 4; b++) {
            const ch = CHORDS[scene.harmony[b % scene.harmony.length]];
            for (let k = 0; k < 4; k++) {
              let midi = pcToMidi(ch.pcs[k % 3], cfg.base);
              if (k === 3) midi += 12;
              lane[b * 4 + k] = { midi, len: 1, vel: 0.85 };
            }
          }
        }),
    }),
    el("div", { class: "tfbtn", text: "Oct−", onclick: () => applyTf(() => { for (let s = 0; s < 16; s++) if (lane[s]) lane[s].midi -= 12; }) }),
    el("div", { class: "tfbtn", text: "Oct+", onclick: () => applyTf(() => { for (let s = 0; s < 16; s++) if (lane[s]) lane[s].midi += 12; }) }),
    el("div", {
      class: "tfbtn",
      text: "Humanize",
      onclick: () => applyTf(() => { for (let s = 0; s < 16; s++) if (lane[s]) lane[s].vel = Math.max(0.4, Math.min(1, lane[s].vel + (Math.random() * 0.4 - 0.2))); }),
    }),
    el("div", {
      class: "tfbtn",
      text: "Random",
      onclick: () =>
        applyTf(() => {
          const ns = scaleNotes(cfg.base, cfg.rows);
          for (let s = 0; s < 16; s++)
            lane[s] = Math.random() < 0.5 ? { midi: ns[Math.floor(Math.random() * ns.length)], len: 1, vel: 0.6 + Math.random() * 0.4 } : null;
        }),
    }),
    el("div", { class: "tfbtn", text: "Clear", onclick: () => applyTf(() => { for (let s = 0; s < 16; s++) lane[s] = null; }) }),
  ]);
  sheet.appendChild(tf);

  const grid = el("div", { class: "proll" });
  const rowCells = []; // [rowIndex][step]
  const cursorCols = Array.from({ length: 16 }, () => []);

  const noteStartAt = (step) => {
    for (let st = 0; st < 16; st++) {
      const n = lane[st];
      if (n && step >= st && step < st + n.len) return st;
    }
    return -1;
  };

  rows.forEach((midi, ri) => {
    const cells = [];
    const rowSteps = el("div", { class: "psteps" });
    for (let s = 0; s < 16; s++) {
      const cell = el("div", { class: "pcell", style: `--tc:${tc}` });
      cell.addEventListener("pointerdown", (e) => onNoteDown(e, s, midi, cell));
      cells.push(cell);
      cursorCols[s].push(cell);
      rowSteps.appendChild(cell);
    }
    rowCells.push(cells);
    grid.appendChild(
      el("div", { class: "prow" }, [
        el("div", { class: "pkey" + (midi % 12 === 0 ? " c" : ""), text: noteName(midi) }),
        rowSteps,
      ])
    );
  });
  sheet.appendChild(grid);

  // Velocity lane.
  const vlane = el("div", { class: "vlane" });
  const vbars = [];
  vlane.appendChild(el("div", { class: "vkey", text: "vel" }));
  const vsteps = el("div", { class: "vsteps" });
  for (let s = 0; s < 16; s++) {
    const fill = el("i", { style: `--tc:${tc}` });
    const bar = el("div", { class: "vbar" }, [fill]);
    bar.addEventListener("pointerdown", (e) => onVelDown(e, s, bar));
    vbars.push(fill);
    vsteps.appendChild(bar);
  }
  vlane.appendChild(vsteps);
  sheet.appendChild(vlane);

  function paint() {
    rows.forEach((midi, ri) => {
      for (let s = 0; s < 16; s++) {
        const st = noteStartAt(s);
        const on = st >= 0 && lane[st].midi === midi;
        rowCells[ri][s].className = `pcell${Math.floor(s / 4) % 2 ? "" : " g"}${on ? " on" : ""}${on && st === s ? " nstart" : ""}`;
      }
    });
    for (let s = 0; s < 16; s++) {
      const n = lane[s];
      vbars[s].style.height = n ? Math.round(n.vel * 100) + "%" : "0%";
      vbars[s].parentElement.style.opacity = n ? 1 : 0.3;
    }
  }

  async function onNoteDown(e, s, midi, cell) {
    e.preventDefault();
    await ensureStarted();
    pushUndo();
    const startHere = lane[s] && lane[s].midi === midi ? s : -1;
    if (startHere < 0) {
      const occ = noteStartAt(s);
      if (occ >= 0) lane[occ] = null;
      lane[s] = { midi, len: 1, vel: lane[s]?.vel ?? 0.9 };
      audio.previewNote(track, midi);
    }
    paint();
    let moved = false;
    const rect = cell.parentElement.getBoundingClientRect();
    const cw = rect.width / 16;
    cell.setPointerCapture?.(e.pointerId);
    const move = (ev) => {
      const cur = Math.max(s, Math.min(15, Math.floor((ev.clientX - rect.left) / cw)));
      const len = cur - s + 1;
      if (lane[s] && len !== lane[s].len) {
        for (let i = s + 1; i < s + len && i < 16; i++) if (lane[i]) lane[i] = null;
        lane[s].len = len;
        moved = true;
        paint();
      }
    };
    const up = () => {
      cell.removeEventListener("pointermove", move);
      cell.removeEventListener("pointerup", up);
      if (!moved && startHere === s) {
        lane[s] = null; // tap on a note's start removes it
        paint();
      }
      refreshClip(sceneIndex, track);
    };
    cell.addEventListener("pointermove", move);
    cell.addEventListener("pointerup", up);
  }

  async function onVelDown(e, s, bar) {
    e.preventDefault();
    if (!lane[s]) return;
    await ensureStarted();
    pushUndo();
    const rect = bar.getBoundingClientRect();
    const set = (ev) => {
      lane[s].vel = Math.max(0.05, Math.min(1, 1 - (ev.clientY - rect.top) / rect.height));
      paint();
    };
    set(e);
    bar.setPointerCapture?.(e.pointerId);
    const move = (ev) => set(ev);
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      refreshClip(sceneIndex, track);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
  }

  paint();
  editor.cursorCols = cursorCols;
}

function buildHarmonyEditor(sceneIndex, scene) {
  let selected = 0;
  const row = el("div", { class: "chordrow" });
  const slots = scene.harmony.map((ci, idx) => {
    const slot = el("div", {
      class: "cslot" + (idx === 0 ? " sel" : ""),
      style: `--tc:${trackColor("harmony")}`,
      text: CHORDS[ci].roman,
      onclick: () => {
        selected = idx;
        slots.forEach((s, k) => s.classList.toggle("sel", k === idx));
      },
    });
    return slot;
  });
  slots.forEach((s) => row.appendChild(s));
  sheet.appendChild(row);

  const picker = el("div", { class: "picker" });
  CHORDS.forEach((ch, ci) => {
    picker.appendChild(
      el("div", {
        class: "copt",
        style: `background:${chordHex(ci)}`,
        text: ch.roman,
        onclick: async () => {
          await ensureStarted();
          pushUndo();
          scene.harmony[selected] = ci;
          slots[selected].textContent = ch.roman;
          audio.preview(ci);
          refreshClip(sceneIndex, "harmony");
        },
      })
    );
  });
  sheet.appendChild(picker);
}

function refreshClip(sceneIndex, track) {
  const refs = sceneEls[sceneIndex];
  if (!refs) return;
  const clip = refs.clips[track];
  const content = clipContent(song.scenes[sceneIndex], track);
  clip.innerHTML = "";
  clip.appendChild(el("div", { class: "tri", text: "▶" }));
  if (content) clip.appendChild(content);
}

// ---------------------------------------------------------------------------
// Arrangement view (Ableton's linear timeline, mobile-first)
// ---------------------------------------------------------------------------
let arrScroll = null;
let arrContentEl = null;
let arrPlayhead = null;

function arrMini(scene, track) {
  if (track === "harmony") {
    return el("div", { text: scene.harmony.map((c) => CHORDS[c].roman).join(" ") });
  }
  if (track === "drums") {
    const mini = el("div", { class: "cmini" });
    for (let s = 0; s < 16; s++) {
      const hit = scene.drums.kick[s] || scene.drums.snare[s] || scene.drums.clap[s];
      mini.appendChild(el("i", { style: `height:${hit ? 13 : scene.drums.hat[s] ? 7 : 3}px` }));
    }
    return mini;
  }
  const lane = scene[track];
  const mini = el("div", { class: "cmini" });
  for (let s = 0; s < 16; s++)
    mini.appendChild(el("i", { style: `height:${lane[s] ? Math.round(3 + (lane[s].vel ?? 0.9) * 9) : 3}px` }));
  return mini;
}

function ensureArrShell() {
  const arrEl = document.getElementById("arrangement");
  if (arrScroll) return;
  const headers = el("div", { class: "arr-headers" }, [el("div", { class: "arr-corner" })]);
  for (const t of ARRANGE_TRACKS) {
    const meta = TRACKS.find((x) => x.key === t);
    headers.appendChild(
      el("div", { class: "arr-thead", style: `--tc:${meta.color}` }, [
        el("div", { class: "dot" }),
        el("div", { class: "nm", text: meta.name }),
        el("div", { class: "ms" }, [el("b", { text: "M" }), el("b", { text: "S" })]),
      ])
    );
  }
  arrScroll = el("div", { class: "arr-scroll" });
  attachPinch(arrScroll);
  arrEl.appendChild(el("div", { class: "arr-wrap" }, [headers, arrScroll]));
}

function buildArrClip(track, idx, clip, color) {
  const scene = song.scenes[clip.scene];
  const sel = selClip && selClip.track === track && selClip.idx === idx;
  const cl = el("div", {
    class: "arr-clip" + (sel ? " sel" : ""),
    style: `left:${clip.start * ppb}px; width:${clip.len * ppb - 2}px; --tc:${color}`,
  });
  cl.appendChild(el("div", { class: "cnm", text: scene.tag }));
  const mini = arrMini(scene, track);
  if (mini) cl.appendChild(mini);
  const rz = el("div", { class: "rz" });
  cl.appendChild(rz);
  cl.addEventListener("pointerdown", (e) => onClipDown(e, track, idx, cl, rz));
  return cl;
}

function renderArrangement() {
  ensureArrShell();
  const totalBars = arrangeLength(song) + 4;
  const content = el("div", { class: "arr-content", style: `width:${totalBars * ppb}px; --ppb:${ppb}px` });

  const ruler = el("div", { class: "arr-ruler", onpointerdown: onRulerDown });
  const every = ppb >= 46 ? 1 : 4;
  for (let b = 0; b < totalBars; b++) {
    if (b % every === 0)
      ruler.appendChild(el("div", { class: "arr-tick", style: `left:${b * ppb}px`, text: String(b + 1) }));
  }
  const loop = song.loop;
  const brace = el("div", {
    class: "arr-loop" + (loop.on ? " on" : ""),
    style: `left:${loop.start * ppb}px; width:${loop.len * ppb}px`,
  });
  brace.appendChild(el("div", { class: "lz" }));
  brace.addEventListener("pointerdown", onLoopDown);
  ruler.appendChild(brace);
  content.appendChild(ruler);

  ARRANGE_TRACKS.forEach((t) => {
    const meta = TRACKS.find((x) => x.key === t);
    const lane = el("div", {
      class: "arr-lane",
      "data-track": t,
      style: `--tc:${meta.color}`,
      onpointerdown: (e) => onLaneDown(e, t),
    });
    song.arrangement[t].forEach((clip, idx) => lane.appendChild(buildArrClip(t, idx, clip, meta.color)));
    content.appendChild(lane);
  });

  const stepDur = (60 / song.tempo / 4).toFixed(3);
  arrPlayhead = el("div", {
    class: "arr-playhead",
    style: `transform:translateX(${arrPlayBar * ppb}px); transition:transform ${stepDur}s linear`,
  });
  content.appendChild(arrPlayhead);

  arrScroll.innerHTML = "";
  arrScroll.appendChild(content);
  arrContentEl = content;
  updateArrToolbar();
}

function barFromEvent(e) {
  const rect = arrContentEl.getBoundingClientRect();
  return Math.max(0, Math.round((e.clientX - rect.left) / ppb));
}

function onRulerDown(e) {
  arrPlayBar = barFromEvent(e);
  if (audioReady) audio.setArrangePos(arrPlayBar);
  if (arrPlayhead) arrPlayhead.style.transform = `translateX(${arrPlayBar * ppb}px)`;
  selClip = null;
  updateArrToolbar();
  arrContentEl.querySelectorAll(".arr-clip.sel").forEach((n) => n.classList.remove("sel"));
}

function onLaneDown(e, track) {
  pushUndo();
  const bar = barFromEvent(e);
  const sceneIdx = playingScene >= 0 ? playingScene : 0;
  song.arrangement[track].push({ scene: sceneIdx, start: bar, len: 4 });
  selClip = { track, idx: song.arrangement[track].length - 1 };
  renderArrangement();
}

async function onClipDown(e, track, idx, cl, rz) {
  e.stopPropagation();
  e.preventDefault();
  await ensureStarted();
  selClip = { track, idx };
  arrContentEl.querySelectorAll(".arr-clip.sel").forEach((n) => n.classList.remove("sel"));
  cl.classList.add("sel");
  updateArrToolbar();

  const clip = song.arrangement[track][idx];
  const resize = e.target === rz;
  const startX = e.clientX;
  const origStart = clip.start;
  const origLen = clip.len;
  const laneRects = resize
    ? []
    : [...arrContentEl.querySelectorAll(".arr-lane")].map((l) => ({ track: l.dataset.track, rect: l.getBoundingClientRect() }));
  const homeTop = laneRects.find((L) => L.track === track)?.rect.top ?? 0;
  let targetTrack = track;
  const pre = snapshot();
  let changed = false;
  cl.setPointerCapture?.(e.pointerId);
  const move = (ev) => {
    changed = true;
    const dBars = (ev.clientX - startX) / ppb;
    if (resize) {
      clip.len = Math.max(1, Math.round(origLen + dBars));
      cl.style.width = clip.len * ppb - 2 + "px";
    } else {
      clip.start = Math.max(0, Math.round(origStart + dBars));
      cl.style.left = clip.start * ppb + "px";
      const hit = laneRects.find((L) => ev.clientY >= L.rect.top && ev.clientY < L.rect.bottom);
      targetTrack = hit ? hit.track : track;
      cl.style.transform = targetTrack !== track ? `translateY(${laneRects.find((L) => L.track === targetTrack).rect.top - homeTop}px)` : "";
      cl.style.zIndex = 8;
    }
    const tools = arrContentEl.querySelector(".arr-tools");
    if (tools) tools.style.left = clip.start * ppb + "px";
  };
  const up = () => {
    cl.removeEventListener("pointermove", move);
    cl.removeEventListener("pointerup", up);
    if (!resize && targetTrack !== track) {
      const moved = song.arrangement[track].splice(idx, 1)[0];
      song.arrangement[targetTrack].push(moved);
      selClip = { track: targetTrack, idx: song.arrangement[targetTrack].length - 1 };
    }
    if (changed) commitUndo(pre);
    renderArrangement();
  };
  cl.addEventListener("pointermove", move);
  cl.addEventListener("pointerup", up);
}

function onLoopDown(e) {
  e.stopPropagation();
  pushUndo();
  const loop = song.loop;
  const resize = e.target.classList.contains("lz");
  const startX = e.clientX;
  const os = loop.start;
  const ol = loop.len;
  let moved = false;
  const brace = e.currentTarget;
  brace.setPointerCapture?.(e.pointerId);
  const move = (ev) => {
    const d = Math.round((ev.clientX - startX) / ppb);
    if (d !== 0) moved = true;
    if (resize) loop.len = Math.max(1, ol + d);
    else loop.start = Math.max(0, os + d);
    brace.style.left = loop.start * ppb + "px";
    brace.style.width = loop.len * ppb + "px";
  };
  const up = () => {
    brace.removeEventListener("pointermove", move);
    brace.removeEventListener("pointerup", up);
    if (!moved) {
      loop.on = !loop.on;
      brace.classList.toggle("on", loop.on);
    }
  };
  brace.addEventListener("pointermove", move);
  brace.addEventListener("pointerup", up);
}

function updateArrToolbar() {
  const old = arrContentEl?.querySelector(".arr-tools");
  if (old) old.remove();
  if (!selClip || !arrContentEl) return;
  const clip = song.arrangement[selClip.track][selClip.idx];
  if (!clip) {
    selClip = null;
    return;
  }
  const vw = arrScroll.clientWidth || 360;
  const toolLeft = Math.max(
    arrScroll.scrollLeft + 4,
    Math.min(clip.start * ppb, arrScroll.scrollLeft + vw - 150)
  );
  const tools = el("div", { class: "arr-tools", style: `left:${toolLeft}px` }, [
    el("div", {
      text: "Split",
      onpointerdown: (e) => {
        e.stopPropagation();
        const c = song.arrangement[selClip.track][selClip.idx];
        if (arrPlayBar > c.start && arrPlayBar < c.start + c.len) {
          pushUndo();
          song.arrangement[selClip.track].push({ scene: c.scene, start: arrPlayBar, len: c.start + c.len - arrPlayBar });
          c.len = arrPlayBar - c.start;
          renderArrangement();
        }
      },
    }),
    el("div", {
      text: "Dup",
      onpointerdown: (e) => {
        e.stopPropagation();
        pushUndo();
        const c = song.arrangement[selClip.track][selClip.idx];
        song.arrangement[selClip.track].push({ scene: c.scene, start: c.start + c.len, len: c.len });
        selClip = { track: selClip.track, idx: song.arrangement[selClip.track].length - 1 };
        renderArrangement();
      },
    }),
    el("div", {
      text: "Del",
      onpointerdown: (e) => {
        e.stopPropagation();
        pushUndo();
        song.arrangement[selClip.track].splice(selClip.idx, 1);
        selClip = null;
        renderArrangement();
      },
    }),
  ]);
  arrContentEl.appendChild(tools);
}

function attachPinch(scroll) {
  const pts = new Map();
  let startDist = 0;
  let startPpb = ppb;
  let raf = 0;
  scroll.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, e.clientX);
    if (pts.size === 2) {
      const xs = [...pts.values()];
      startDist = Math.abs(xs[0] - xs[1]);
      startPpb = ppb;
    }
  });
  scroll.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e.clientX);
    if (pts.size === 2 && startDist > 0) {
      const xs = [...pts.values()];
      const np = Math.max(30, Math.min(220, startPpb * (Math.abs(xs[0] - xs[1]) / startDist)));
      if (Math.round(np) === Math.round(ppb)) return; // sub-pixel — nothing visible changes
      ppb = np;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderArrangement(); }); // ≤1 rebuild/frame
    }
  });
  const rm = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) startDist = 0;
  };
  scroll.addEventListener("pointerup", rm);
  scroll.addEventListener("pointercancel", rm);
}

// ---------------------------------------------------------------------------
// Playback → UI sync
// ---------------------------------------------------------------------------
audio.onVisual((e) => {
  if (e.type === "arr") {
    const frac = e.bar + e.stepInBar / 16;
    arrPlayBar = e.bar;
    if (arrPlayhead) arrPlayhead.style.transform = `translateX(${frac * ppb}px)`;
    if (arrScroll) {
      const x = frac * ppb;
      const left = arrScroll.scrollLeft;
      if (x < left + 24 || x > left + arrScroll.clientWidth - 48)
        arrScroll.scrollLeft = Math.max(0, x - arrScroll.clientWidth * 0.3);
    }
    return;
  }
  if (e.scene !== undefined && e.scene !== playingScene) setPlaying(e.scene);
  if (e.type === "step" && editor && editor.cursorCols) {
    if (editor.cursor >= 0) editor.cursorCols[editor.cursor]?.forEach((c) => c.classList.remove("cursor"));
    editor.cursor = e.stepInBar;
    editor.cursorCols[e.stepInBar]?.forEach((c) => c.classList.add("cursor"));
  }
});

renderTransport();
renderSession();
