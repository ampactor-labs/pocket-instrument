// Noodles — a mobile take on Ableton's Session view.
// Clip grid (tracks x scenes) + transport; tap a clip to edit it (drum rack /
// chord editor). DOM/CSS for the DAW chrome, Tone.js underneath.

import {
  CHORDS,
  DRUM_VOICES,
  DRUM_META,
  ARRANGE_TRACKS,
  SCALE_NAMES,
  FOLLOW_ACTIONS,
  chordColor,
  clipLaunch,
  hslInt,
  makeSong,
  makeScene,
  cloneScene,
  arrangeLength,
  noteSlot,
  normalizeScene,
  scaleNotes,
  noteName,
  pcName,
  setScaleContext,
  snapToScale,
  makeMagicScene,
  stepsFor,
} from "./model.js";
import { createAudio, KIT_NAMES, SAMPLE_KIT_NAMES, HARMONY_PRESET_NAMES, BASS_PRESET_NAMES, MELODY_PRESET_NAMES, CORNERS, COLOR_NAMES, DRUM_BANKS, drumCornerNames } from "./audio.js";

// Pitch range shown in the piano roll, per track.
const PIANO = { melody: { base: 12, rows: 56 }, bass: { base: 12, rows: 56 } };

function setNoteSlot(lane, step, notes) {
  const clean = notes
    .filter((n) => n && Number.isFinite(Number(n.midi)))
    .map((n) => ({
      midi: Number(n.midi),
      len: Math.max(1, Math.min(16, Number(n.len) || 1)),
      vel: Math.max(0.05, Math.min(1, Number(n.vel) || 0.9)),
    }));
  lane[step] = clean.length ? clean : null;
}

function removeNoteFromSlot(lane, step, index) {
  const notes = noteSlot(lane[step]).filter((_, i) => i !== index);
  setNoteSlot(lane, step, notes);
}

function removePitchInRange(lane, midi, fromStep, toStep, exceptStep) {
  for (let step = fromStep; step <= toStep; step++) {
    if (step === exceptStep) continue;
    const next = noteSlot(lane[step]).filter((n) => n.midi !== midi);
    setNoteSlot(lane, step, next);
  }
}

function slotPeakVel(slot) {
  return noteSlot(slot).reduce((max, n) => Math.max(max, n.vel ?? 0.9), 0);
}

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
const DEFAULT_TRACK_VOLUME_DB = -6;
const METER_MIN_DB = -60;
const METER_MAX_DB = 0;
const TRACK_VOLUME_MIN_DB = -36;
const TRACK_VOLUME_MAX_DB = 0;
const clampTrackDb = (db) => Math.max(TRACK_VOLUME_MIN_DB, Math.min(TRACK_VOLUME_MAX_DB, Math.round(db)));
const formatDb = (db) => `${db > 0 ? "+" : ""}${db} dB`;
const meterLevel = (db) => {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)));
};
const chordNotes = (ci) => CHORDS[ci] ? CHORDS[ci].pcs.map(pcName).join(" ") : "";
function chordMarkup(ci, { notes = false } = {}) {
  const ch = CHORDS[ci];
  if (!ch) return "";
  return `<b>${ch.roman}</b><span>${ch.name}</span>${notes ? `<em class="chord-notes">${chordNotes(ci)}</em>` : ""}`;
}

const song = makeSong();
setScaleContext(song.key, song.scale);
const audio = createAudio(song);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
// A rolled sound is any point in the track's morph space plus a color, with
// "none" weighted so a full-song roll doesn't stack four effects at once.
const COLOR_POOL = ["none", "none", "tape", "crush", "phase", "trem", "wob"];
function rolledPatch(track) {
  const p = { x: Math.random(), y: Math.random(), color: pick(COLOR_POOL), amount: 0.3 + Math.random() * 0.55, motion: Math.random() };
  if (track === "drums") {
    // The sample bank is the star; the synth kit stays in rotation.
    p.bank = Math.random() < 0.7 ? "sample" : "synth";
    p.pins = {};
  }
  return p;
}
function randomizePresets() {
  for (const t of ["harmony", "bass", "melody", "drums"]) audio.setPatch(t, rolledPatch(t));
}
// The dice must never deal dead air: "deep" is a driveless sine, and a sine
// in octave 1 (~33 Hz fundamental, no harmonics) is inaudible on phone and
// bookshelf speakers alike. Fold a fresh magic bassline up an octave when it
// lands there. Presets with drive keep their low rolls — their harmonics
// carry on small speakers. Hand-placed low notes are untouched on purpose.
function fitBassRegister(scene) {
  if (audio.bassPreset() !== "deep") return scene;
  const notes = scene.bass.flatMap((slot) => noteSlot(slot));
  if (notes.length && notes.some((n) => n.midi < 36)) {
    for (const n of notes) n.midi += 12;
  }
  return scene;
}
randomizePresets();
fitBassRegister(song.scenes[0]);
const PROJECT_SCHEMA = "noodles-project";
const PROJECT_VERSION = 2; // v2: devices carry full patch specs, not just preset names
const LOCAL_PROJECT_KEY = "noodles:last-project";

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

function capturePointer(node, pointerId) {
  try {
    node.setPointerCapture?.(pointerId);
  } catch {
    // Synthetic/mobile browser pointer streams can end before capture resolves.
  }
}

const buzz = (ms = 8) => navigator.vibrate?.(ms);

let audioReady = false;
async function ensureStarted() {
  if (audioReady) return;
  audioReady = true;
  await audio.init();
}

let playingScene = -1;
const playingTracks = Object.fromEntries(TRACKS.map((t) => [t.key, -1]));
const queuedSceneTracks = Object.fromEntries(TRACKS.map((t) => [t.key, -1]));
const sceneEls = []; // per scene: { row, clips: {track: el} }

let view = "session"; // 'session' | 'arrangement'
let sessionRecord = false;
let ppb = 37; // arrangement pixels-per-bar; default zoomed out so bar 8 fills screen
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
  applyStepDur();
  closeEditor();
  renderTransport();
  renderSession();
  if (view === "arrangement") renderArrangement();
  updateUndoButtons();
}
function restoreSnap(s) {
  Object.assign(song, structuredClone(s));
  song.scenes?.forEach(normalizeScene);
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
const footer = document.getElementById("footer");
let playBtn;
let bpmEl;
const TEMPO_MIN = 40;
const TEMPO_MAX = 220;

async function togglePlayback() {
  await ensureStarted();
  if (view === "arrangement") {
    if (audio.playing) audio.stop();
    else audio.playArrangement(arrPlayBar);
  } else {
    if (audio.playing) audio.stop();
    else {
      const sceneIndex = playingScene >= 0 ? playingScene : 0;
      audio.launchScene(sceneIndex);
      setPlaying(sceneIndex);
    }
  }
  updatePlayBtn(audio.playing);
}

function renderTransport() {
  transport.innerHTML = "";
  playBtn = el("div", {
    class: "tbtn play" + (audio.playing ? " on" : ""),
    text: audio.playing ? "⏹" : "▶",
    onclick: togglePlayback,
  });
  const recBtn = el("div", {
    class: "tbtn record" + (sessionRecord ? " on" : ""),
    text: "●",
    id: "rec-btn",
    onclick: () => {
      sessionRecord = !sessionRecord;
      if (sessionRecord) pushUndo();
      renderTransport();
    },
  });
  bpmEl = el("div", { id: "bpm", role: "button", tabindex: "0", html: `${song.tempo}<small>BPM</small>` });
  bindTempoControl(bpmEl);
  undoBtn = el("div", { class: "tbtn undo", text: "↶", onclick: undo });
  redoBtn = el("div", { class: "tbtn redo", text: "↷", onclick: redo });
  const left = el("div", { class: "tleft" }, [recBtn, playBtn, undoBtn, redoBtn]);
  const tempo = el("div", { class: "ttempo" }, [bpmEl]);
  // View toggle + File button live in the header (always visible)
  const viewBtn = el("div", {
    class: "tbtn" + (view === "arrangement" ? " accent" : ""),
    text: "View",
    id: "view-toggle-btn",
    onclick: () => setView(view === "session" ? "arrangement" : "session"),
  });
  const fileBtn = el("div", { class: "tbtn", text: "File", id: "file-btn", onclick: openExport });
  const tright = el("div", { class: "tright" }, [viewBtn, fileBtn]);
  transport.append(left, tempo, tright);
  updateUndoButtons();
  renderFooter();
}

function renderFooter() {
  if (!footer) return;
  footer.innerHTML = "";
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
    el("span", { class: "swlabel", text: "GROOVE" }),
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
  const keyctl = el("div", { class: "keyctl" }, [keySel, scaleSel]);
  // The dice sits with the song's musical identity: one tap rolls a whole new
  // key + tempo + sounds + magic scene, same as a fresh load. Undo-safe.
  const diceBtn = el("div", { class: "tbtn accent", text: "🎲", id: "dice-btn", title: "New song: random key, tempo, sounds", onclick: rerollSong });
  const aboutBtn = el("div", { class: "tbtn", text: "?", id: "about-btn", title: "What is this?", onclick: openAboutSheet });
  footer.append(
    el("div", { class: "frow" }, [keyctl, diceBtn, aboutBtn, groove])
  );
}

// ---------------------------------------------------------------------------
// About — what this is, in the product's own voice. Pull, never push: it
// lives behind the ? and never opens itself.
// ---------------------------------------------------------------------------
function openAboutSheet() {
  resetSheet("#e8b84b");
  sheet.appendChild(sheetBar("noodles", "a pocket instrument"));
  const p = (text) => el("div", { class: "about-p", text });
  const label = (text) => el("div", { class: "about-label", text });
  const body = el("div", { class: "editor-scroll" }, [
    p("This is an instrument. The song playing right now was rolled on the spot, just for you, and every bit of it is yours to change. You can't break it: everything stays in key, every roll comes out mixed, and undo sits in the top bar."),

    label("start here"),
    p("▶ plays, ⏹ stops. Tap a scene row's ▶ to launch that whole row. Tap any clip to open it and draw. 🎲 rolls a fresh song: new key, tempo, sounds, groove."),

    label("the grid"),
    p("Each row is a scene — a loop and a song section in one. + adds another: blank, a copy, or a fresh magic one. The corner pie on a playing clip shows where it is in its loop. Long-press a clip for launch modes and follow actions, a scene's ▶ for scene moves, a track name for track moves."),

    label("editors"),
    p("Drums: tap or drag to paint hits; the lane below sets how hard each step hits. Notes: tap to add, drag right to stretch, tap again to remove — every pitch lands in key. Chords: pick from the seven that fit, colored by their job. − / + shortens a clip's loop; a 12-step line against 16-step drums drifts in and out of phase on purpose. ◧ zooms the note grid when your thumbs need bigger targets."),

    label("sound"),
    p("✦ on a mixer strip opens the morph pad: four sounds in the corners, everything between them yours to find. Add one color — tape, crush, phase, trem, wob — with its own amount and motion. Pocket swings that one track against the global GROOVE. Drums come in two banks, sampled kits and a synth kit, and every drum can pin a one-shot, load a WAV, or 🎙 record your own mouth."),

    label("ride"),
    p("Arm ● ride in a sound sheet, hit play, and perform: your moves on the pad and knobs are captured to the beat and loop with the clip from then on. Rides live in the scene, save with the project, and play in exports. A clip wearing ∿ has one."),

    label("mix"),
    p("Mix opens the mixer. The fader is the meter: drag the handle to set level, the body glows with loudness, the bright bar is the peak, the tick holds the recent maximum. Verb and echo are sends into a shared room, off by default — turn a knob up to send a track into it."),

    label("arrange"),
    p("View flips to the timeline. Drag clips around, pull a right edge to resize, sweep the strip under the bar numbers to set a loop — tap the loop to switch it on and off. Arm ● in the top bar while you jam scenes and the performance writes itself into the timeline."),

    label("keep it"),
    p("File saves the project to a file or keeps it on this device, and exports a WAV — master or four stems — through the exact chain you're hearing. Mic recordings last until the tab closes; save the project to keep everything else."),

    p("Made for couches and phone speakers. Tell your friends."),
  ]);
  sheet.appendChild(body);
  openSheet();
  requestAnimationFrame(() => {
    if (body.scrollHeight > body.clientHeight + 8) {
      const hint = el("div", { class: "scroll-hint", text: "⌄" });
      sheet.appendChild(hint);
      body.addEventListener("scroll", () => hint.remove(), { once: true });
    }
  });
}


function emptyScene() {
  return makeScene(
    [0, 0, 0, 0],
    Object.fromEntries(DRUM_VOICES.map((v) => [v, new Array(16).fill(false)])),
    new Array(16).fill(null),
    new Array(16).fill(null)
  );
}

function insertSceneAt(index, scene) {
  const at = Math.max(0, Math.min(song.scenes.length, index));
  for (const track of ARRANGE_TRACKS) {
    for (const clip of song.arrangement[track]) {
      if (clip.scene >= at) clip.scene += 1;
    }
  }
  song.scenes.splice(at, 0, scene);
  return at;
}

function swapScenes(a, b) {
  if (a === b || !song.scenes[a] || !song.scenes[b]) return;
  const tmp = song.scenes[a];
  song.scenes[a] = song.scenes[b];
  song.scenes[b] = tmp;
  for (const track of ARRANGE_TRACKS) {
    for (const clip of song.arrangement[track]) {
      if (clip.scene === a) clip.scene = b;
      else if (clip.scene === b) clip.scene = a;
    }
  }
}

function deleteSceneAt(index) {
  if (song.scenes.length <= 1 || !song.scenes[index]) return false;
  song.scenes.splice(index, 1);
  for (const track of ARRANGE_TRACKS) {
    song.arrangement[track] = song.arrangement[track]
      .filter((clip) => clip.scene !== index)
      .map((clip) => ({ ...clip, scene: clip.scene > index ? clip.scene - 1 : clip.scene }));
  }
  if (playingScene === index) playingScene = -1;
  else if (playingScene > index) playingScene -= 1;
  for (const t of TRACKS) {
    if (playingTracks[t.key] === index) playingTracks[t.key] = -1;
    else if (playingTracks[t.key] > index) playingTracks[t.key] -= 1;
    if (queuedSceneTracks[t.key] === index) queuedSceneTracks[t.key] = -1;
    else if (queuedSceneTracks[t.key] > index) queuedSceneTracks[t.key] -= 1;
  }
  return true;
}

function openAddSceneSheet() {
  resetSheet("#e8b84b");
  const baseIndex = playingScene >= 0 ? playingScene : song.scenes.length - 1;
  const addScene = (scene) => {
    pushUndo();
    insertSceneAt(song.scenes.length, scene);
    closeEditor();
    renderSession();
    if (view === "arrangement") renderArrangement();
  };
  sheet.appendChild(sheetBar("Add Scene", "blank · duplicate · magic"));
  sheet.appendChild(
    el("div", { class: "tfrow" }, [
      el("div", { class: "tfbtn", text: "Blank", onclick: () => addScene(emptyScene()) }),
      el("div", { class: "tfbtn", text: "Duplicate Current", onclick: () => addScene(cloneScene(song.scenes[baseIndex])) }),
      el("div", { class: "tfbtn accent", text: "Magic", onclick: () => addScene(fitBassRegister(makeMagicScene())) }),
    ])
  );
  openSheet();
}


function setView(v) {
  view = v;
  document.getElementById("app").classList.toggle("arrange", v === "arrangement");
  if (v === "arrangement") {
    if (!audio.playing) audio.enterArrangement();
    renderArrangement();
  }
  renderTransport();
}
function updatePlayBtn(on) {
  playBtn.classList.toggle("on", on);
  playBtn.textContent = on ? "⏹" : "▶";
}
function clampTempo(v) {
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(v)));
}
function updateTempoUI() {
  if (!bpmEl) return;
  bpmEl.innerHTML = `${song.tempo}<small>BPM</small>`;
}
// One 16th note in seconds — the sweep duration for the clip pie timers.
function applyStepDur() {
  document.documentElement.style.setProperty("--stepdur", (15 / song.tempo).toFixed(4) + "s");
}
function applyTempo(v) {
  const next = clampTempo(v);
  if (!Number.isFinite(next) || next === song.tempo) return false;
  song.tempo = next;
  updateTempoUI();
  audio.setTempo(song.tempo);
  applyStepDur();
  return true;
}
function bindTempoControl(node) {
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openTempoEditor();
    }
  });
  node.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startTempo = song.tempo;
    const pre = snapshot();
    let dragging = false;
    let changed = false;
    node.classList.add("dragging");
    capturePointer(node, e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = startY - ev.clientY;
      if (!dragging && Math.hypot(dx, dy) < 7) return;
      dragging = true;
      const delta = Math.round(dy / 2 + dx / 6);
      changed = applyTempo(startTempo + delta) || changed;
    };
    const up = () => {
      node.classList.remove("dragging");
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", cancel);
      if (dragging) {
        if (changed) commitUndo(pre);
      } else {
        openTempoEditor();
      }
    };
    const cancel = () => {
      node.classList.remove("dragging");
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", cancel);
      if (changed) commitUndo(pre);
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", cancel);
  });
}

function openTempoEditor() {
  resetSheet("#e8b84b");
  const input = el("input", {
    class: "tempo-input",
    type: "number",
    inputmode: "numeric",
    min: String(TEMPO_MIN),
    max: String(TEMPO_MAX),
    step: "1",
    value: String(song.tempo),
  });
  const setTypedTempo = () => {
    const next = Number(input.value);
    if (Number.isFinite(next) && clampTempo(next) !== song.tempo) {
      pushUndo();
      applyTempo(next);
    }
    closeEditor();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") setTypedTempo();
  });
  // Tap tempo: average the last few tap intervals into the input.
  const taps = [];
  const tapBtn = el("div", {
    class: "tfbtn tap-tempo",
    text: "tap the beat",
    onclick: () => {
      const now = performance.now();
      while (taps.length && now - taps[taps.length - 1] > 2500) taps.length = 0;
      taps.push(now);
      if (taps.length >= 2) {
        const gaps = taps.slice(1).map((t, i) => t - taps[i]);
        const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        input.value = String(clampTempo(60000 / avg));
        tapBtn.textContent = `tap the beat · ${input.value}`;
      }
      if (taps.length > 6) taps.shift();
    },
  });
  sheet.appendChild(sheetBar("Tempo", `${TEMPO_MIN}-${TEMPO_MAX} BPM`, { onDone: setTypedTempo }));
  sheet.appendChild(el("div", { class: "tempo-sheet" }, [input, tapBtn]));
  openSheet();
  setTimeout(() => {
    input.focus();
    input.select();
  }, 40);
}

// The dice: exactly what a fresh page load rolls — new key, scale, tempo,
// device presets, and one magic scene — without the reload. Undo brings the
// song back (device presets stay rolled; they're not part of song snapshots).
function rerollSong() {
  pushUndo();
  const fresh = makeSong();
  for (const key of Object.keys(song)) delete song[key];
  Object.assign(song, fresh);
  randomizePresets();
  fitBassRegister(song.scenes[0]);
  selClip = null;
  arrPlayBar = 0;
  playingScene = -1;
  for (const t of TRACKS) playingTracks[t.key] = -1;
  refreshAll();
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
        for (const n of noteSlot(sc[trk][s])) n.midi = snapToScale(n.midi + delta);
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
    if (!scene.harmony || scene.harmony.length === 0) return null;
    return el("div", { 
      class: "harmony-mini", 
      html: scene.harmony.map((ci) => `<div>${chordMarkup(ci)}</div>`).join("")
    });
  }
  if (track === "drums") {
    if (!scene.drums || !Object.values(scene.drums).some(v => v.some(x => x))) return null;
    const mini = el("div", { class: "mini" });
    for (let s = 0; s < 16; s++) {
      const hit = scene.drums.kick[s] || scene.drums.snare[s] || scene.drums.clap[s];
      mini.appendChild(el("i", { style: `height:${hit ? 15 : scene.drums.hat[s] ? 8 : 3}px` }));
    }
    return mini;
  }
  if (track === "melody" || track === "bass") {
    if (!scene[track] || !scene[track].some(n => n !== null)) return null;
    const mini = el("div", { class: "mini" });
    const lane = scene[track];
    for (let s = 0; s < 16; s++) {
      const notes = noteSlot(lane[s]);
      const height = notes.length ? Math.round(4 + slotPeakVel(lane[s]) * 9 + Math.min(4, notes.length - 1) * 2) : 3;
      mini.appendChild(el("i", { style: `height:${height}px` }));
    }
    return mini;
  }
  return null;
}

// Depth made visible: a shortened loop shows its step count, a motion ride
// shows a wave — bottom-left, mirroring the launch badge.
function stateBadge(scene, track) {
  const bits = [];
  if (track !== "harmony" && stepsFor(scene, track) !== 16) bits.push(String(stepsFor(scene, track)));
  if (scene.motion?.[track] && Object.keys(scene.motion[track]).length) bits.push("∿");
  return bits.length ? el("div", { class: "clip-badge state", text: bits.join(" ") }) : null;
}

function launchBadge(scene, track) {
  const launch = clipLaunch(scene, track);
  const bits = [];
  if (launch.mode === "oneshot") bits.push("1x");
  if (launch.follow === "next") bits.push("next");
  else if (launch.follow === "prev") bits.push("prev");
  else if (launch.follow === "random") bits.push("rnd");
  return bits.length ? el("div", { class: "clip-badge", text: bits.join(" ") }) : null;
}

function bindSessionClip(clip, sceneIndex, track, filled) {
  let timer = 0;
  let longPress = false;
  let startX = 0;
  let startY = 0;
  let moved = false;
  const clear = () => {
    clearTimeout(timer);
    timer = 0;
    clip.classList.remove("pressing");
  };
  clip.addEventListener("pointerdown", (e) => {
    longPress = false;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    if (filled) clip.classList.add("pressing");
    timer = window.setTimeout(() => {
      longPress = true;
      clear();
      if (filled) beginClipDrag(e, clip, sceneIndex, track);
    }, 480);
  });
  clip.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) {
      moved = true;
      clear();
    }
  });
  clip.addEventListener("pointerup", clear);
  clip.addEventListener("pointercancel", clear);
  clip.addEventListener("click", () => {
    if (longPress || moved) return;
    if (filled) openEditor(sceneIndex, track);
    else openNewClipSheet(sceneIndex, track);
  });
}

// Long-press on a filled clip: drag it vertically to another scene slot
function beginClipDrag(origEv, clip, sceneIndex, track) {
  // gather all scene slot positions for this track column
  const allSlots = [...document.querySelectorAll(`.clip[data-track="${track}"]`)];
  if (!allSlots.length) return;
  const rects = allSlots.map((sl) => ({ el: sl, rect: sl.getBoundingClientRect(), si: parseInt(sl.dataset.scene, 10) }));
  clip.style.opacity = "0.4";
  let targetSI = sceneIndex;
  let moved = false;
  const move = (ev) => {
    const hit = rects.find((r) => ev.clientY >= r.rect.top && ev.clientY < r.rect.bottom);
    if (hit) {
      rects.forEach((r) => r.el.style.outline = "");
      hit.el.style.outline = "2px solid #e8b84b";
      if (hit.si !== sceneIndex) moved = true;
      targetSI = hit.si;
    }
  };
  const up = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    clip.style.opacity = "";
    rects.forEach((r) => r.el.style.outline = "");
    if (targetSI !== sceneIndex) {
      pushUndo();
      // Swap the clip data between the two scene slots for this track
      const srcScene = song.scenes[sceneIndex];
      const dstScene = song.scenes[targetSI];
      // For drums, harmony, bass, melody — swap the data fields
      const tmp = structuredClone(srcScene[track]);
      srcScene[track] = structuredClone(dstScene[track]);
      dstScene[track] = tmp;
      const tl = srcScene.launch?.[track];
      const tdl = dstScene.launch?.[track];
      if (srcScene.launch && dstScene.launch) {
        srcScene.launch[track] = structuredClone(tdl);
        dstScene.launch[track] = structuredClone(tl);
      }
      renderSession();
    } else if (!moved) {
      openClipProps(sceneIndex, track);
    }
  };
  document.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerup", up);
}

function openNewClipSheet(sceneIndex, track) {
  // An empty slot was tapped — offer to create a clip or do nothing
  // For now, opening the editor on an empty slot makes sense (adds content on edit)
  openEditor(sceneIndex, track);
}

// Scene label cell: single tap = launch, long press = Scene Options
function bindSceneCell(launch, sceneIndex) {
  let timer = 0;
  let longPress = false;
  let startX = 0, startY = 0;
  const clear = () => { clearTimeout(timer); timer = 0; };
  launch.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".scene-opt-btn")) return;
    longPress = false;
    startX = e.clientX; startY = e.clientY;
    timer = window.setTimeout(() => {
      longPress = true;
      clear();
      openSceneOptions(sceneIndex);
    }, 480);
  });
  launch.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) clear();
  });
  launch.addEventListener("pointerup", clear);
  launch.addEventListener("pointercancel", clear);
  launch.addEventListener("click", async () => {
    if (longPress) return;
    await ensureStarted();
    audio.launchScene(sceneIndex);
    setPlaying(sceneIndex);
    updatePlayBtn(true);
  });
}

function openSceneOptions(sceneIndex) {
  const scene = song.scenes[sceneIndex];
  resetSheet("#e8b84b");
  sheet.appendChild(sheetBar("Scene Options", `Scene ${scene.tag}`));
  sheet.appendChild(
    el("div", { class: "tfrow" }, [
      el("div", { class: "tfbtn", text: "▶ Launch", onclick: async () => {
        closeEditor();
        await ensureStarted();
        audio.launchScene(sceneIndex);
        setPlaying(sceneIndex);
        updatePlayBtn(true);
      }}),
      el("div", { class: "tfbtn", text: "Duplicate", onclick: () => {
        pushUndo();
        const cloned = cloneScene(scene);
        insertSceneAt(sceneIndex + 1, cloned);
        closeEditor();
        renderSession();
      }}),
      el("div", { class: "tfbtn", text: "Move Up", onclick: () => {
        if (sceneIndex === 0) return;
        pushUndo();
        swapScenes(sceneIndex, sceneIndex - 1);
        closeEditor();
        renderSession();
      }}),
      el("div", { class: "tfbtn", text: "Move Down", onclick: () => {
        if (sceneIndex >= song.scenes.length - 1) return;
        pushUndo();
        swapScenes(sceneIndex, sceneIndex + 1);
        closeEditor();
        renderSession();
      }}),
      el("div", { class: "tfbtn", style: "color:#d24b4b", text: "Delete", onclick: () => {
        if (song.scenes.length <= 1) { closeEditor(); return; }
        pushUndo();
        deleteSceneAt(sceneIndex);
        closeEditor();
        renderSession();
        if (view === "arrangement") renderArrangement();
      }}),
    ])
  );
  openSheet();
}

function renderSession() {
  sessionEl.innerHTML = "";
  sceneEls.length = 0;
  invalidateGridState();
  const grid = el("div", { class: "grid" });
  grid.style.gridTemplateColumns = `58px repeat(${TRACKS.length}, 1fr)`;
  grid.appendChild(el("div", { class: "head corner" }, [viewMixButton()]));
  for (const t of TRACKS) {
    const head = el("div", {
      class: "head track-head",
      style: `--tc:${t.color}`,
      "data-track": t.key,
    }, [
      el("div", { class: "head-name", text: t.name }),
      el("div", { class: "head-ms" }, [trackToggleButton(t.key, "mute"), trackToggleButton(t.key, "solo")]),
      el("div", { class: "more", text: "⋯" }),
    ]);
    bindTrackHeader(head, t.key);
    grid.appendChild(head);
  }
  song.scenes.forEach((scene, i) => {
    const refs = { clips: {} };
    const launch = el("div", {
      class: "scenecell",
      "data-scene": String(i),
    }, [el("div", { class: "tri", text: "▶" }), el("div", { text: scene.tag }), el("div", { class: "more", text: "⋯" })]);
    bindSceneCell(launch, i);
    refs.row = launch;
    grid.appendChild(launch);

    for (const t of TRACKS) {
      const content = clipContent(scene, t.key);
      const filled = content !== null;
      const clip = el("div", {
        class: `clip ${filled ? "filled" : "empty"}`,
        style: `--tc:${t.color}`,
        "data-scene": String(i),
        "data-track": t.key,
      });
      if (filled) {
        clip.appendChild(el("div", { class: "tri", text: "▶" }));
        clip.appendChild(content);
        const badge = launchBadge(scene, t.key);
        if (badge) clip.appendChild(badge);
        const state = stateBadge(scene, t.key);
        if (state) clip.appendChild(state);
      } else {
        clip.textContent = "+";
      }
      bindSessionClip(clip, i, t.key, filled);
      refs.clips[t.key] = clip;
      grid.appendChild(clip);
    }
    sceneEls.push(refs);
  });

  // "+" add-scene cell at the very bottom of the scene column
  const addSceneCell = el("div", {
    class: "scenecell scene-add-cell",
    title: "Add scene",
    onclick: openAddSceneSheet,
  }, [el("div", { class: "tri", style: "color:#e8b84b;font-size:22px", text: "+" })]);
  grid.appendChild(addSceneCell);
  // The rest of the row is a ghost scene — same tap as +, reads as "more
  // stacks here" instead of "this is everything".
  grid.appendChild(
    el("div", { class: "clip ghost", style: "grid-column: 2 / -1", title: "Add scene", onclick: openAddSceneSheet, text: "+ scene" })
  );

  sessionEl.appendChild(grid);
  applyPlaying();
  updateTrackMixUI();
}

// The step event arrives every 16th; repainting the whole grid that often
// costs main-thread time right when beat visuals need to land. Both sweeps
// below skip when their state hasn't changed since the last paint.
let lastActiveKey = null;
let lastQueuedKey = null;
function invalidateGridState() {
  lastActiveKey = null;
  lastQueuedKey = null;
}
function setPlaying(i) {
  playingScene = i;
  for (const t of TRACKS) playingTracks[t.key] = i;
  invalidateGridState();
  applyPlaying();
}
function setActiveTracks(activeScenes) {
  const key = TRACKS.map((t) => activeScenes[t.key] ?? -1).join(",");
  if (key === lastActiveKey) return;
  lastActiveKey = key;
  for (const t of TRACKS) playingTracks[t.key] = activeScenes[t.key] ?? -1;
  const first = playingTracks[TRACKS[0].key];
  playingScene = first >= 0 && TRACKS.every((t) => playingTracks[t.key] === first) ? first : -1;
  applyPlaying();
}
function applyPlaying() {
  sceneEls.forEach((r, i) => {
    const rowOn = i === playingScene;
    r.row.classList.toggle("playing", rowOn);
    // Row is "queued" if ALL tracks are queued to this scene
    const rowQueued = !rowOn && TRACKS.every((t) => queuedSceneTracks[t.key] === i);
    r.row.classList.toggle("queued", rowQueued);
    for (const t of TRACKS) {
      const c = r.clips[t.key];
      if (c && c.classList.contains("filled")) {
        c.classList.toggle("playing", playingTracks[t.key] === i);
        c.classList.toggle("queued", queuedSceneTracks[t.key] === i && playingTracks[t.key] !== i);
      }
    }
  });
}

function applyQueued(qt) {
  const key = TRACKS.map((t) => qt?.[t.key] ?? -1).join(",");
  if (key === lastQueuedKey) return;
  lastQueuedKey = key;
  for (const t of TRACKS) queuedSceneTracks[t.key] = qt?.[t.key] ?? -1;
  applyPlaying();
}

// ---------------------------------------------------------------------------
// Editor sheet
// ---------------------------------------------------------------------------
const sheet = document.getElementById("sheet");
const scrim = document.getElementById("scrim");
let editor = null; // { scene, track, stepEls, cursor }
let suppressOutsideClick = false;

scrim.addEventListener("click", closeEditor);
document.addEventListener("pointerdown", (e) => {
  if (!sheet.classList.contains("open")) return;
  if (sheet.contains(e.target)) return;
  if (e.target.closest(".tbtn.play")) return;

  closeEditor();
  if (e.target.closest("#transport")) {
    suppressOutsideClick = true;
    e.preventDefault();
    e.stopPropagation();
  }
}, true);
document.addEventListener("click", (e) => {
  if (!suppressOutsideClick) return;
  suppressOutsideClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);

function openEditor(sceneIndex, track) {
  const scene = song.scenes[sceneIndex];
  resetSheet(trackColor(track));
  editor = { scene: sceneIndex, track, cursorCols: null, cursor: -1 };

  const title = track === "drums" ? "Drum Rack" : track === "harmony" ? "Chords" : "Piano Roll";
  sheet.appendChild(
    sheetBar(title, `${TRACKS.find((t) => t.key === track).name} · Scene ${scene.tag}`, {
      buttons: [el("div", { class: "close", style: "margin-right:6px", text: "Options", onclick: () => openClipProps(sceneIndex, track) })],
    })
  );

  if (track === "drums") buildDrumEditor(scene);
  else if (track === "harmony") buildHarmonyEditor(sceneIndex, scene);
  else buildPianoEditor(sceneIndex, scene, track);

  openSheet();
}

function closeEditor() {
  editor = null;
  cancelAnimationFrame(mixerRAF);
  mixerRAF = 0;
  audio.disarmMotion();
  scrim.classList.remove("open");
  sheet.classList.remove("open");
}

// Every sheet goes through the same three moves: reset the sheet (also stops a
// running mixer meter loop), append a title bar, open. Keep them here so no
// opener can forget one.
function resetSheet(color) {
  editor = null;
  cancelAnimationFrame(mixerRAF);
  mixerRAF = 0;
  sheet.innerHTML = "";
  sheet.style.setProperty("--tc", color);
}

function sheetBar(title, sub, { buttons = [], onDone = closeEditor } = {}) {
  return el("div", { class: "sheet-bar" }, [
    el("div", { class: "swatch" }),
    el("div", { class: "title", text: title }),
    el("div", { class: "sub", text: sub }),
    ...buttons,
    el("div", { class: "close", text: "Done", onclick: onDone }),
  ]);
}

function openSheet() {
  scrim.classList.add("open");
  sheet.classList.add("open");
}

function choice(label, on, onclick, attrs = {}) {
  return el("div", { class: "choice" + (on ? " on" : ""), text: label, onclick, ...attrs });
}

function openClipProps(sceneIndex, track) {
  const scene = song.scenes[sceneIndex];
  const launch = clipLaunch(scene, track);
  const meta = TRACKS.find((t) => t.key === track);
  resetSheet(meta.color);

  const setLaunch = (patch) => {
    const changed = Object.entries(patch).some(([k, v]) => launch[k] !== v);
    if (!changed) return;
    pushUndo();
    Object.assign(launch, patch);
    refreshClip(sceneIndex, track);
    openClipProps(sceneIndex, track);
  };

  sheet.appendChild(sheetBar("Clip Properties", `${meta.name} · Scene ${scene.tag}`));

  sheet.appendChild(
    el("div", { class: "propsection" }, [
      el("div", { class: "proplabel", text: "launch mode" }),
      el("div", { class: "choicegrid two" }, [
        choice("Loop", launch.mode === "loop", () => setLaunch({ mode: "loop" }), { "data-action": "mode-loop" }),
        choice("One-shot", launch.mode === "oneshot", () => setLaunch({ mode: "oneshot" }), { "data-action": "mode-oneshot" }),
      ]),
    ])
  );

  const followLabels = { none: "None", next: "Next", prev: "Prev", random: "Random" };
  sheet.appendChild(
    el("div", { class: "propsection" }, [
      el("div", { class: "proplabel", text: "follow action" }),
      el("div", { class: "choicegrid four" },
        FOLLOW_ACTIONS.map((action) =>
          choice(followLabels[action], launch.follow === action, () => setLaunch({ follow: action }), {
            "data-action": `follow-${action}`,
          })
        )
      ),
    ])
  );

  const bars = el("div", { class: "numval", text: `${launch.followBars} bar${launch.followBars === 1 ? "" : "s"}` });
  const afterSection = el("div", { class: "propsection" + (launch.follow === "none" ? " disabled" : ""), style: launch.follow === "none" ? "opacity: 0.3; pointer-events: none;" : "" }, [
    el("div", { class: "proplabel", text: "after" }),
    el("div", { class: "numrow" }, [
      el("div", {
        class: "choice stepper",
        text: "-",
        onclick: () => setLaunch({ followBars: Math.max(1, launch.followBars - 1) }),
      }),
      bars,
      el("div", {
        class: "choice stepper",
        text: "+",
        onclick: () => setLaunch({ followBars: Math.min(16, launch.followBars + 1) }),
      }),
    ]),
  ]);
  sheet.appendChild(afterSection);

  sheet.appendChild(
    el("div", { class: "tfrow" }, [
      el("div", {
        class: "tfbtn",
        text: "Launch",
        onclick: async () => {
          await ensureStarted();
          const wasPlaying = audio.playing;
          audio.launchClip(sceneIndex, track);
          if (!wasPlaying) for (const t of TRACKS) playingTracks[t.key] = -1;
          playingTracks[track] = sceneIndex;
          updatePlayBtn(true);
          applyPlaying();
        },
      }),
      el("div", { class: "tfbtn", text: "Edit", onclick: () => openEditor(sceneIndex, track) }),
      el("div", {
        class: "tfbtn",
        text: "Duplicate Scene",
        "data-action": "duplicate-scene",
        onclick: () => {
          pushUndo();
          const next = insertSceneAt(song.scenes.length, cloneScene(scene));
          renderSession();
          openClipProps(next, track);
        },
      }),
      el("div", {
        class: "tfbtn",
        style: "color:#d24b4b",
        text: "Delete Clip",
        onclick: () => {
          pushUndo();
          if (track === "drums") {
            for (const v of DRUM_VOICES) for (let s = 0; s < 16; s++) scene.drums[v][s] = false;
          } else if (track === "melody" || track === "bass") {
            for (let s = 0; s < 16; s++) scene[track][s] = null;
          } else if (track === "harmony") {
            scene.harmony = [];
          }
          closeEditor();
          renderSession();
        },
      }),
    ])
  );

  openSheet();
}

// ---------------------------------------------------------------------------
// Mixer + devices
// ---------------------------------------------------------------------------
let mixerRAF = 0;
// Dry by default: every send parks at the knob floor (-30 is off). The dry mix
// is the meaty one — the master chain does the gluing, and reverb/echo are
// there to be dialed in per track, not baked into the cold open. Reset Sends
// returns here, i.e. to silence.
const MIX_DEFAULTS = {
  harmony: { vol: DEFAULT_TRACK_VOLUME_DB, pan: 0, verb: -30, echo: -30, mute: false, solo: false },
  drums: { vol: DEFAULT_TRACK_VOLUME_DB, pan: 0, verb: -30, echo: -30, mute: false, solo: false },
  bass: { vol: DEFAULT_TRACK_VOLUME_DB, pan: 0, verb: -30, echo: -30, mute: false, solo: false },
  melody: { vol: DEFAULT_TRACK_VOLUME_DB, pan: 0, verb: -30, echo: -30, mute: false, solo: false },
};
const mixState = structuredClone(MIX_DEFAULTS);

function knob(label, min, max, step, val, onChange, format = (v) => v) {
  const container = el("div", { class: "knob-container" });
  const lbl = el("div", { class: "knob-label", text: label });
  const dial = el("div", { class: "knob-dial" });
  const indicator = el("div", { class: "knob-indicator" });
  const valEl = el("div", { class: "knob-val", text: format(val) });
  // The value lives inside the dial; the freed row below lets the dial grow.
  dial.append(indicator, valEl);
  container.append(lbl, dial);

  let currentVal = val;
  const updateVisuals = () => {
    const pct = (currentVal - min) / (max - min);
    const deg = -135 + pct * 270;
    indicator.style.transform = `rotate(${deg}deg)`;
    valEl.textContent = format(currentVal);
  };
  updateVisuals();

  let startY = 0;
  let startVal = 0;
  
  dial.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startVal = currentVal;
    
    const move = (ev) => {
      const deltaY = startY - ev.clientY;
      const range = max - min;
      let newVal = startVal + (deltaY / 120) * range;
      newVal = Math.max(min, Math.min(max, newVal));
      newVal = Math.round(newVal / step) * step;
      if (Math.abs(newVal - currentVal) > 1e-5) {
        currentVal = newVal;
        updateVisuals();
        onChange(currentVal);
      }
    };
    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
  });
  
  return container;
}

function applyTrackMix(track) {
  const ms = mixState[track];
  if (!ms) return;
  ms.vol = clampTrackDb(ms.vol);
  audio.setVol(track, ms.vol);
  audio.setPan(track, ms.pan);
  audio.setSend(track, ms.verb);
  audio.setEcho(track, ms.echo);
  audio.setMute(track, ms.mute);
  audio.setSolo(track, ms.solo);
}

function applyMixState() {
  for (const t of TRACKS) applyTrackMix(t.key);
  updateTrackMixUI();
}

function resetTrackMix(track, { sendsOnly = false } = {}) {
  const next = structuredClone(MIX_DEFAULTS[track]);
  if (!next) return;
  if (sendsOnly) {
    mixState[track].verb = next.verb;
    mixState[track].echo = next.echo;
  } else {
    Object.assign(mixState[track], next);
  }
  applyTrackMix(track);
  updateTrackMixUI();
}

function resetAllMix({ sendsOnly = false } = {}) {
  for (const t of TRACKS) resetTrackMix(t.key, { sendsOnly });
}

function trackMutedByState(track) {
  const anySolo = Object.values(mixState).some((s) => s.solo);
  return mixState[track]?.mute || (anySolo && !mixState[track]?.solo);
}
function updateTrackMixUI() {
  document.querySelectorAll("[data-track-toggle]").forEach((btn) => {
    const state = mixState[btn.dataset.track];
    const kind = btn.dataset.trackToggle;
    const on = !!state?.[kind];
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll(".track-head[data-track], .arr-thead[data-track], .mx-strip[data-track]").forEach((node) => {
    const track = node.dataset.track;
    node.classList.toggle("muted", trackMutedByState(track));
    node.classList.toggle("soloed", !!mixState[track]?.solo);
  });
  document.querySelectorAll(".clip[data-track], .arr-lane[data-track]").forEach((node) => {
    node.classList.toggle("track-muted", trackMutedByState(node.dataset.track));
  });
}
function setTrackMute(track, on) {
  if (!mixState[track] || mixState[track].mute === on) return;
  mixState[track].mute = on;
  audio.setMute(track, on);
  updateTrackMixUI();
}
function setTrackSolo(track, on) {
  if (!mixState[track] || mixState[track].solo === on) return;
  mixState[track].solo = on;
  audio.setSolo(track, on);
  updateTrackMixUI();
}
function toggleTrackMute(track) {
  setTrackMute(track, !mixState[track]?.mute);
}
function toggleTrackSolo(track) {
  setTrackSolo(track, !mixState[track]?.solo);
}
function trackToggleButton(track, kind) {
  const isMute = kind === "mute";
  return el("div", {
    class: `msbtn ${mixState[track]?.[kind] ? "on" : ""}`,
    text: isMute ? "M" : "S",
    role: "button",
    "aria-pressed": String(!!mixState[track]?.[kind]),
    "data-track": track,
    "data-track-toggle": kind,
    onpointerdown: (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isMute) toggleTrackMute(track);
      else toggleTrackSolo(track);
    },
  });
}
function viewMixButton() {
  // Corner Mix buttons in session/arrangement headers — kept for legacy layout compat
  return el("div", {
    class: "view-mix",
    text: "Mix",
    onclick: (e) => {
      e.stopPropagation();
      openMixer();
    },
  });
}
// One element, both jobs: the meter is the fader. The body fills with RMS
// (perceived level), an instantaneous peak bar rides above it, a hold tick
// with a numeric readout marks the recent maximum, and on tracks a handle
// riding the same column sets the volume — Ableton's channel strip, sized
// for a thumb.
function makeVolMeter(state, { withHandle = false } = {}) {
  state.rmsEl = el("div", { class: "mv-rms" });
  state.peakEl = el("div", { class: "mv-peak" });
  state.holdEl = el("div", { class: "mv-hold" });
  state.labelEl = el("div", { class: "mv-label" });
  state.rmsDb = -Infinity;
  state.peakDb = -Infinity;
  state.holdDb = -Infinity;
  state.holdUntil = 0;
  const kids = [state.rmsEl, state.peakEl, state.holdEl, state.labelEl];
  if (withHandle) {
    state.handleEl = el("div", { class: "mv-handle" });
    kids.push(state.handleEl);
  }
  return el("div", { class: "mx-vol" + (withHandle ? " grab" : "") }, kids);
}

// Ableton-ish ballistics: RMS attacks fast and releases slow, peak falls at a
// fixed rate, the hold tick keeps the recent maximum for a beat then lets go.
function advanceMeter(state, levels, now) {
  state.rmsDb = Number.isFinite(state.rmsDb)
    ? state.rmsDb + (levels.rms - state.rmsDb) * (levels.rms > state.rmsDb ? 0.5 : 0.12)
    : levels.rms;
  state.peakDb = levels.peak > state.peakDb ? levels.peak : state.peakDb - 1.1;
  if (levels.peak >= state.holdDb) {
    state.holdDb = levels.peak;
    state.holdUntil = now + 1200;
  } else if (now > state.holdUntil) {
    state.holdDb -= 0.6;
  }
  state.rmsEl.style.transform = `scaleY(${meterLevel(state.rmsDb)})`;
  const showPeak = Number.isFinite(state.peakDb) && state.peakDb > METER_MIN_DB;
  state.peakEl.style.display = showPeak ? "block" : "none";
  if (showPeak) state.peakEl.style.top = `${(1 - meterLevel(state.peakDb)) * 100}%`;
  const showHold = Number.isFinite(state.holdDb) && state.holdDb > METER_MIN_DB;
  state.holdEl.style.display = showHold ? "block" : "none";
  state.labelEl.textContent = showHold ? Math.round(state.holdDb) : "";
  if (showHold) state.holdEl.style.top = `${(1 - meterLevel(state.holdDb)) * 100}%`;
}

const volToPct = (db) => (1 - (db - TRACK_VOLUME_MIN_DB) / (TRACK_VOLUME_MAX_DB - TRACK_VOLUME_MIN_DB)) * 100;
function bindTrackHeader(node, track) {
  let timer = 0;
  let longPressed = false;
  let startX = 0;
  let startY = 0;
  const clear = () => {
    clearTimeout(timer);
    timer = 0;
    node.classList.remove("pressing");
  };
  node.addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-track-toggle]")) return;
    longPressed = false;
    startX = e.clientX;
    startY = e.clientY;
    node.classList.add("pressing");
    timer = window.setTimeout(() => {
      longPressed = true;
      clear();
      openTrackOptions(track);
    }, 520);
  });
  node.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) clear();
  });
  node.addEventListener("pointerup", clear);
  node.addEventListener("pointercancel", clear);
  node.addEventListener("click", () => {
    if (longPressed) longPressed = false;
  });
}
function openTrackOptions(track) {
  const meta = TRACKS.find((t) => t.key === track);
  if (!meta) return;
  resetSheet(meta.color);
  const trackChoice = (kind, label) =>
    el("div", {
      class: `choice track-choice ${mixState[track][kind] ? "on" : ""}`,
      text: label,
      "data-track": track,
      "data-track-toggle": kind,
      onpointerdown: (e) => {
        e.preventDefault();
        if (kind === "mute") toggleTrackMute(track);
        else toggleTrackSolo(track);
      },
    });
  sheet.appendChild(sheetBar("Track Options", meta.name));
  sheet.appendChild(
    el("div", { class: "propsection" }, [
      el("div", { class: "proplabel", text: "state" }),
      el("div", { class: "choicegrid two" }, [trackChoice("mute", "Mute"), trackChoice("solo", "Solo")]),
    ])
  );
  sheet.appendChild(
    el("div", { class: "tfrow" }, [
      el("div", { class: "tfbtn accent", text: "✦ Sound", onclick: () => openSoundSheet(track) }),
      el("div", { class: "tfbtn", text: "Mixer Strip", onclick: () => openMixer(track) }),
      el("div", { class: "tfbtn", text: "Reset Mix", onclick: () => { resetTrackMix(track); openTrackOptions(track); } }),
      el("div", { class: "tfbtn", text: "Reset Sends", onclick: () => { resetTrackMix(track, { sendsOnly: true }); openTrackOptions(track); } }),
    ])
  );
  openSheet();
  updateTrackMixUI();
}

function openMixer(focusTrack = null) {
  resetSheet("#8a8a90");
  sheet.appendChild(
    sheetBar("Mixer", "levels · sends · devices", {
      buttons: [el("div", { class: "close", style: "font-size:11px;padding:5px 7px", text: "Reset", onclick: () => { resetAllMix(); openMixer(focusTrack); } })],
    })
  );

  const container = el("div", { class: "mx-container" });
  const meterBars = {};
  for (const t of TRACKS) {
    const k = t.key;
    const ms = mixState[k];
    ms.vol = clampTrackDb(ms.vol);
    const mState = {};
    meterBars[k] = mState;
    const volMeter = makeVolMeter(mState, { withHandle: true });
    const volLabel = el("div", { class: "mx-val", text: formatDb(ms.vol) });
    mState.handleEl.style.top = `${volToPct(ms.vol)}%`;
    // Relative drag anywhere on the column — no jump if you grab off-handle.
    volMeter.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startVol = ms.vol;
      const range = TRACK_VOLUME_MAX_DB - TRACK_VOLUME_MIN_DB;
      const height = volMeter.getBoundingClientRect().height || 1;
      capturePointer(volMeter, e.pointerId);
      const move = (ev) => {
        const next = clampTrackDb(startVol + (-(ev.clientY - startY) / height) * range);
        if (next === ms.vol) return;
        ms.vol = next;
        audio.setVol(k, next);
        mState.handleEl.style.top = `${volToPct(next)}%`;
        volLabel.textContent = formatDb(next);
      };
      const up = () => {
        volMeter.removeEventListener("pointermove", move);
        volMeter.removeEventListener("pointerup", up);
        volMeter.removeEventListener("pointercancel", up);
      };
      volMeter.addEventListener("pointermove", move);
      volMeter.addEventListener("pointerup", up);
      volMeter.addEventListener("pointercancel", up);
    });

    const panSlider = knob("pan", -1, 1, 0.05, ms.pan, (v) => { ms.pan = v; audio.setPan(k, v); }, (v) => (v === 0 ? "C" : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`));
    const verbSlider = knob("verb", -30, 0, 1, ms.verb, (v) => { ms.verb = v; audio.setSend(k, v); });
    const echoSlider = knob("echo", -30, 0, 1, ms.echo, (v) => { ms.echo = v; audio.setEcho(k, v); });

    // One path to the device: the sound sheet. The old preset dropdowns were
    // a third, flattened way to pick corners the pad already owns.
    const devSection = el("div", { class: "mx-dev-section" }, [
      el("div", { class: "mx-devlabel", text: audio.kit && k === "drums" ? `kit · ${audio.kit()}` : `sound · ${k === "harmony" ? audio.harmonyPreset() : k === "bass" ? audio.bassPreset() : audio.melodyPreset()}` }),
      el("div", { class: "mx-sound", text: "✦ sound", "data-action": `sound-${k}`, onclick: () => openSoundSheet(k) }),
    ]);

    const strip = el("div", { class: "mx-strip" + (focusTrack === k ? " focus" : ""), style: `--tc:${t.color}`, "data-track": k }, [
      el("div", { class: "mx-name" }, [el("span", { class: "mx-dot" }), el("span", { text: t.name })]),
      el("div", { class: "mx-ms" }, [trackToggleButton(k, "mute"), trackToggleButton(k, "solo")]),
      volMeter,
      volLabel,
      panSlider,
      verbSlider,
      echoSlider,
      devSection,
    ]);
    container.appendChild(strip);
  }
  const masterState = {};
  meterBars.master = masterState;
  container.appendChild(
    el("div", { class: "mx-strip mx-master", style: "--tc:#d2d2d4", "data-track": "master" }, [
      el("div", { class: "mx-name" }, [el("span", { class: "mx-dot" }), el("span", { text: "Master" })]),
      makeVolMeter(masterState),
    ])
  );
  sheet.appendChild(container);

  openSheet();
  if (focusTrack) {
    setTimeout(() => sheet.querySelector(`.mx-strip[data-track="${focusTrack}"]`)?.scrollIntoView({ inline: "center", block: "nearest" }), 30);
  }
  updateTrackMixUI();
  const tick = () => {
    const now = performance.now();
    for (const t of TRACKS) advanceMeter(meterBars[t.key], audio.meterLevels(t.key), now);
    advanceMeter(meterBars.master, audio.meterLevels("master"), now);
    mixerRAF = requestAnimationFrame(tick);
  };
  cancelAnimationFrame(mixerRAF);
  mixerRAF = requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Sound sheet — the morph pad between a track's four presets, plus one color.
// The dropdown names are the corners; the space between them is the point of
// this sheet. Everything auditions live while the loop plays.
// ---------------------------------------------------------------------------
function openSoundSheet(track) {
  const meta = TRACKS.find((t) => t.key === track);
  resetSheet(meta.color);
  // Motion capture: arm ●, play, and perform on the pad — the ride is written
  // into the playing scene's lanes, quantized to 16ths, and loops from then on.
  const recBtn = el("div", {
    class: "close rec-motion" + (audio.motionArmed(track) ? " on" : ""),
    style: "margin-right:6px",
    text: "● ride",
    title: "Record motion: arm, play, ride the pad",
    "data-action": `motion-rec-${track}`,
    onclick: () => {
      audio.armMotion(track, !audio.motionArmed(track));
      openSoundSheet(track);
    },
  });
  const soundDice = el("div", {
    class: "close",
    style: "margin-right:6px",
    text: "🎲",
    "data-action": `sound-dice-${track}`,
    onclick: () => {
      audio.setPatch(track, rolledPatch(track));
      openSoundSheet(track);
    },
  });
  sheet.appendChild(sheetBar("Sound", meta.name, { buttons: [recBtn, soundDice] }));
  const body = el("div", { class: "editor-scroll" });
  sheet.appendChild(body);
  const patch = audio.patch(track);
  const isDrums = track === "drums";

  if (isDrums) {
    const bankChips = el("div", { class: "choicegrid two" });
    for (const bank of DRUM_BANKS) {
      bankChips.appendChild(
        choice(bank === "sample" ? "samples" : "synth", patch.bank === bank, () => {
          audio.setPatch(track, { bank });
          openSoundSheet(track);
        }, { "data-action": `bank-${bank}` })
      );
    }
    body.appendChild(el("div", { class: "propsection" }, [el("div", { class: "proplabel", text: "bank" }), bankChips]));
  }

  {
    const padWrap = el("div", { class: "propsection" }, [el("div", { class: "proplabel", text: "morph" })]);
    const xy = el("div", { class: "xy-pad", style: `--tc:${meta.color}`, "data-action": `xy-${track}` });
    const names = isDrums ? drumCornerNames(patch) : CORNERS[track];
    const cornerPos = ["tl", "tr", "bl", "br"];
    names.forEach((n, i) => xy.appendChild(el("div", { class: `xy-corner ${cornerPos[i]}`, text: n })));
    const dot = el("div", { class: "xy-dot" });
    xy.appendChild(dot);
    const placeDot = (p) => {
      dot.style.left = `${p.x * 100}%`;
      dot.style.top = `${p.y * 100}%`;
    };
    placeDot(patch);
    xy.addEventListener("pointerdown", async (e) => {
      e.preventDefault();
      await ensureStarted();
      const rect = xy.getBoundingClientRect();
      const set = (ev) => {
        const x = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
        placeDot(audio.setPatch(track, { x, y }));
      };
      set(e);
      capturePointer(xy, e.pointerId);
      const move = (ev) => set(ev);
      const up = () => {
        xy.removeEventListener("pointermove", move);
        xy.removeEventListener("pointerup", up);
        xy.removeEventListener("pointercancel", up);
      };
      xy.addEventListener("pointermove", move);
      xy.addEventListener("pointerup", up);
      xy.addEventListener("pointercancel", up);
    });
    padWrap.appendChild(xy);
    body.appendChild(padWrap);
  }

  const chips = el("div", { class: "choicegrid three" });
  const chipEls = {};
  for (const c of COLOR_NAMES) {
    chipEls[c] = choice(c, patch.color === c, () => {
      const next = audio.setPatch(track, { color: c });
      for (const [name, elc] of Object.entries(chipEls)) elc.classList.toggle("on", name === next.color);
    }, { "data-action": `color-${c}` });
    chips.appendChild(chipEls[c]);
  }
  body.appendChild(el("div", { class: "propsection" }, [el("div", { class: "proplabel", text: "color" }), chips]));

  const pctFmt = (v) => `${Math.round(v * 100)}%`;
  const knobs = [
    knob("amount", 0, 1, 0.01, patch.amount, (v) => audio.setPatch(track, { amount: v }), pctFmt),
    knob("motion", 0, 1, 0.01, patch.motion, (v) => audio.setPatch(track, { motion: v }), pctFmt),
  ];
  if (track !== "harmony") {
    // Per-track pocket: overrides the global GROOV for this track only.
    knobs.push(
      knob("pocket", 0, 0.6, 0.01, song.trackSwing?.[track] ?? song.swing, (v) => {
        (song.trackSwing ||= {})[track] = v;
      }, pctFmt)
    );
  }
  body.appendChild(
    el("div", { class: "propsection" }, [
      el("div", { class: "proplabel", text: track === "harmony" ? "amount · motion" : "amount · motion · pocket" }),
      el("div", { class: "knobrow" }, knobs),
    ])
  );

  if (isDrums && patch.bank === "sample") {
    const rows = el("div", { class: "propsection" }, [el("div", { class: "proplabel", text: "one-shots" })]);
    for (const v of DRUM_VOICES) {
      const pin = patch.pins?.[v];
      const label = pin === "user" ? (audio.userSampleName(v) || "your wav") : pin || "follows the kit";
      rows.appendChild(
        el("div", { class: "srow", "data-action": `pick-${v}`, onclick: () => openDrumSamplePicker(v) }, [
          el("div", { class: "srow-voice", style: `--pc:${padHex(v)}`, text: DRUM_META[v].label }),
          el("div", { class: "srow-pin" + (pin ? " pinned" : ""), text: label }),
        ])
      );
    }
    body.appendChild(rows);
  }

  // A recorded ride lives in the playing scene; offer the way out.
  const sceneIdx = playingTracks[track] >= 0 ? playingTracks[track] : 0;
  const motionScene = song.scenes[sceneIdx];
  if (motionScene?.motion?.[track] && Object.keys(motionScene.motion[track]).length) {
    body.appendChild(
      el("div", { class: "tfrow" }, [
        el("div", {
          class: "tfbtn",
          text: `Clear motion (scene ${motionScene.tag})`,
          "data-action": `motion-clear-${track}`,
          onclick: () => {
            pushUndo();
            delete motionScene.motion[track];
            openSoundSheet(track);
          },
        }),
      ])
    );
  }
  openSheet();
  // The sheet often cuts cleanly at a section edge and LOOKS complete; hint
  // that it scrolls, and remove the hint at the first scroll.
  requestAnimationFrame(() => {
    if (body.scrollHeight > body.clientHeight + 8) {
      const hint = el("div", { class: "scroll-hint", text: "⌄" });
      sheet.appendChild(hint);
      body.addEventListener("scroll", () => hint.remove(), { once: true });
    }
  });
}

// Per-voice one-shot picker: the bundled library organized by kit character,
// plus your own WAV. Every choice auditions immediately.
function openDrumSamplePicker(voice) {
  const meta = TRACKS.find((t) => t.key === "drums");
  resetSheet(meta.color);
  sheet.appendChild(sheetBar("One-shot", DRUM_META[voice].label, { onDone: () => openSoundSheet("drums") }));
  const body = el("div", { class: "editor-scroll" });
  sheet.appendChild(body);
  const patch = audio.patch("drums");
  const current = patch.pins?.[voice] || null;

  const setPin = async (pin) => {
    const pins = { ...audio.patch("drums").pins };
    if (pin) pins[voice] = pin;
    else delete pins[voice];
    audio.setPatch("drums", { pins });
    await ensureStarted();
    audio.previewHit(voice);
    openDrumSamplePicker(voice);
  };

  const list = el("div", { class: "choicegrid two" });
  list.appendChild(choice("follows the kit", !current, () => setPin(null), { "data-action": "pin-kit" }));
  for (const kit of SAMPLE_KIT_NAMES) {
    const name = `${kit}-${voice}`;
    list.appendChild(choice(`${kit} ${DRUM_META[voice].label}`, current === name, () => setPin(name), { "data-action": `pin-${name}` }));
  }
  const fileInput = el("input", { class: "project-file", type: "file", accept: "audio/wav,audio/*" });
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      await audio.loadUserSample(voice, await file.arrayBuffer(), file.name);
      setPin("user");
    } catch {
      openDrumSamplePicker(voice);
    }
  });
  const userLabel = current === "user" && audio.userSampleName(voice) ? audio.userSampleName(voice) : "load a wav…";
  list.appendChild(choice(userLabel, current === "user", () => fileInput.click(), { "data-action": "pin-user" }));
  if (navigator.mediaDevices?.getUserMedia) {
    list.appendChild(choice("🎙 record", false, () => openMicCapture(voice), { "data-action": "pin-mic" }));
  }
  body.appendChild(el("div", { class: "propsection" }, [el("div", { class: "proplabel", text: "pick one — it auditions as you tap" }), list, fileInput]));
  openSheet();
}

// Beatbox a drum: boom into the mic, it becomes the kick. Playback pauses so
// the take doesn't catch the speakers; the conditioned one-shot pins itself
// and auditions the moment you stop.
function openMicCapture(voice) {
  const meta = TRACKS.find((t) => t.key === "drums");
  resetSheet(meta.color);
  sheet.appendChild(sheetBar("Record", DRUM_META[voice].label, { onDone: () => openDrumSamplePicker(voice) }));
  const status = el("div", { class: "exp-status", text: "mouth ready?" });
  const big = el("div", { class: "mic-big", "data-action": "mic-go", text: "🎙 tap, then make the sound" });
  sheet.appendChild(el("div", { class: "propsection" }, [big, status]));

  let capture = null;
  const keep = async () => {
    big.classList.remove("live");
    big.textContent = "…";
    const cap = capture;
    capture = null;
    try {
      await cap.stop();
      const pins = { ...audio.patch("drums").pins, [voice]: "user" };
      audio.setPatch("drums", { pins });
      await ensureStarted();
      audio.previewHit(voice);
      openDrumSamplePicker(voice);
    } catch (e) {
      status.textContent = e?.message === "too quiet" ? "too quiet — get closer, go again" : "take failed — go again";
      big.textContent = "🎙 tap, then make the sound";
    }
  };
  big.addEventListener("click", async () => {
    if (capture) {
      keep();
      return;
    }
    try {
      if (audio.playing) {
        audio.stop();
        updatePlayBtn(false);
        status.textContent = "paused the beat so the mic hears only you";
      }
      capture = await audio.beginMicCapture(voice);
      big.classList.add("live");
      big.textContent = "● recording — tap to keep";
      status.textContent = "boom / psst / tss — it trims itself";
      capture.done.then(() => {
        if (capture) keep();
      }).catch(() => {});
    } catch {
      status.textContent = "mic blocked — allow microphone access and retry";
    }
  });
  openSheet();
}

// Piano-roll zoom: 17px cells are the smallest target in the app, so the
// roll pages between all 16 steps and fat 8-step halves. Sticky across opens.
let pianoView = 0; // 0 = 16 steps, 1 = steps 1-8, 2 = steps 9-16
const PIANO_VIEWS = ["⊞ 16", "◧ 1–8", "◨ 9–16"];

// Polymeter control: how many of the 16 steps this clip actually loops.
function stepLenControl(scene, track) {
  const set = (d) => {
    pushUndo();
    (scene.steps ||= { drums: 16, bass: 16, melody: 16 })[track] = Math.max(2, Math.min(16, stepsFor(scene, track) + d));
    openEditor(editor.scene, track);
    refreshClip(editor.scene, track);
  };
  return el("div", { class: "steplenctl", title: "Loop length in steps" }, [
    el("div", { class: "tfbtn", text: "−", onclick: () => set(-1) }),
    el("div", { class: "numval steplen", text: `${stepsFor(scene, track)}` }),
    el("div", { class: "tfbtn", text: "+", onclick: () => set(1) }),
  ]);
}

function buildDrumEditor(scene) {
  const tfd = el("div", { class: "tfrow" }, [
    el("div", {
      class: "tfbtn",
      text: "Random",
      onclick: () => {
        pushUndo();
        const dens = { kick: 0.32, snare: 0.14, hat: 0.5, clap: 0.12 };
        for (const v of DRUM_VOICES) {
          for (let s = 0; s < 16; s++) {
            if (v === "kick" && s % 2 !== 0 && Math.random() > 0.1) { scene.drums[v][s] = 0; continue; }
            if (v === "snare" && s % 4 !== 0) { scene.drums[v][s] = 0; continue; }
            scene.drums[v][s] = Math.random() < dens[v] ? 0.7 + Math.random() * 0.3 : 0;
          }
        }
        scene.drums.kick[0] = 0.9;
        scene.drums.kick[8] = 0.9;
        scene.drums.snare[4] = 0.9;
        scene.drums.snare[12] = 0.9;
        openEditor(editor.scene, "drums");
        refreshClip(editor.scene, "drums");
      },
    }),
    el("div", {
      class: "tfbtn",
      text: "Humanize",
      onclick: () => {
        pushUndo();
        for (const v of DRUM_VOICES) {
          for (let s = 0; s < 16; s++) {
            if (scene.drums[v][s] > 0) {
              scene.drums[v][s] = Math.max(0.4, Math.min(1, scene.drums[v][s] + (Math.random() * 0.4 - 0.2)));
            }
          }
        }
        openEditor(editor.scene, "drums");
        refreshClip(editor.scene, "drums");
      },
    }),
    el("div", {
      class: "tfbtn",
      text: "Clear",
      onclick: () => {
        pushUndo();
        for (const v of DRUM_VOICES) for (let s = 0; s < 16; s++) scene.drums[v][s] = 0;
        openEditor(editor.scene, "drums");
        refreshClip(editor.scene, "drums");
      },
    }),
    stepLenControl(scene, "drums"),
  ]);
  sheet.appendChild(tfd);

  const clipLen = stepsFor(scene, "drums");
  const stepEls = {};
  const scrollContainer = el("div", { class: "editor-scroll" });
  for (const v of DRUM_VOICES) {
    stepEls[v] = [];
    const steps = el("div", { class: "steps", style: "touch-action:none" });
    // Drag-paint: pointerdown sets add/delete mode based on initial cell state;
    // dragging over subsequent cells applies the same action to each.
    let drumDragMode = null; // 'add' | 'delete' | null
    let drumDragPre = null;
    const stepsArr = [];
    for (let s = 0; s < 16; s++) {
      const on = scene.drums[v][s];
      const cell = el("div", {
        class: `step ${Math.floor(s / 4) % 2 ? "" : "g"} ${on ? "on" : ""}${s >= clipLen ? " off" : ""}`,
        style: `--pc:${padHex(v)}`,
      });
      stepsArr.push(cell);
      stepEls[v].push(cell);
      steps.appendChild(cell);
    }

    // Build a hit-test function: given clientX within the steps row, return step index
    const stepAtX = (clientX) => {
      const rect = steps.getBoundingClientRect();
      const idx = Math.floor((clientX - rect.left) / (rect.width / 16));
      return Math.max(0, Math.min(15, idx));
    };

    steps.addEventListener("pointerdown", async (e) => {
      e.preventDefault();
      await ensureStarted();
      drumDragPre = snapshot();
      const s0 = stepAtX(e.clientX);
      if (s0 >= clipLen) return;
      drumDragMode = scene.drums[v][s0] > 0 ? "delete" : "add";
      scene.drums[v][s0] = drumDragMode === "add" ? 0.9 : 0;
      stepsArr[s0].classList.toggle("on", scene.drums[v][s0] > 0);
      if (drumDragMode === "add") {
        audio.previewHit(v);
        buzz();
      }
      refreshClip(editor.scene, "drums");
      if (typeof paintDrums === "function") paintDrums();
      capturePointer(steps, e.pointerId);
    });
    steps.addEventListener("pointermove", (e) => {
      if (drumDragMode === null) return;
      const s = stepAtX(e.clientX);
      if (s >= clipLen) return;
      const shouldOn = drumDragMode === "add";
      const isOn = scene.drums[v][s] > 0;
      if (isOn !== shouldOn) {
        scene.drums[v][s] = shouldOn ? 0.9 : 0;
        stepsArr[s].classList.toggle("on", shouldOn);
        refreshClip(editor.scene, "drums");
        if (typeof paintDrums === "function") paintDrums();
      }
    });
    steps.addEventListener("pointerup", () => {
      if (drumDragPre) commitUndo(drumDragPre);
      drumDragMode = null;
      drumDragPre = null;
    });
    steps.addEventListener("pointercancel", () => {
      drumDragMode = null;
      drumDragPre = null;
    });

    const pad = el("div", {
      class: "pad",
      style: `--pc:${padHex(v)}`,
      text: DRUM_META[v].label,
      onclick: async () => {
        await ensureStarted();
        audio.previewHit(v);
        buzz();
      },
    });
    scrollContainer.appendChild(el("div", { class: "drumrow" }, [pad, steps]));
  }
  sheet.appendChild(scrollContainer);

  // .drums variant: match the 54px pad column so bars sit under their steps.
  const vlane = el("div", { class: "vlane drums" });
  const vbars = [];
  vlane.appendChild(el("div", { class: "vkey", text: "vel" }));
  const vsteps = el("div", { class: "vsteps" });
  for (let s = 0; s < 16; s++) {
    const fill = el("i", { style: `--tc:${trackColor("drums")}` });
    const bar = el("div", { class: "vbar" }, [fill]);
    bar.addEventListener("pointerdown", (e) => onDrumVelDown(e, s, bar));
    vbars.push(fill);
    vsteps.appendChild(bar);
  }
  vlane.appendChild(vsteps);
  sheet.appendChild(vlane);

  function paintDrums() {
    for (let s = 0; s < 16; s++) {
      let maxVel = 0;
      for (const v of DRUM_VOICES) {
        if (scene.drums[v][s] > maxVel) maxVel = scene.drums[v][s];
      }
      vbars[s].style.height = maxVel > 0 ? Math.round(maxVel * 100) + "%" : "0%";
      vbars[s].parentElement.style.opacity = maxVel > 0 ? 1 : 0.3;
    }
  }

  async function onDrumVelDown(e, s, bar) {
    e.preventDefault();
    let hasNotes = false;
    for (const v of DRUM_VOICES) if (scene.drums[v][s] > 0) hasNotes = true;
    if (!hasNotes) return;
    await ensureStarted();
    pushUndo();
    const rect = bar.getBoundingClientRect();
    const set = (ev) => {
      const vel = Math.max(0.05, Math.min(1, 1 - (ev.clientY - rect.top) / rect.height));
      for (const v of DRUM_VOICES) {
        if (scene.drums[v][s] > 0) scene.drums[v][s] = vel;
      }
      paintDrums();
    };
    set(e);
    capturePointer(bar, e.pointerId);
    const move = (ev) => set(ev);
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      refreshClip(editor.scene, "drums");
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  }

  paintDrums();

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
    scrollToNotes();
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
              setNoteSlot(lane, b * 4 + k, [{ midi, len: 1, vel: 0.85 }]);
            }
          }
        }),
    }),
    el("div", { class: "tfbtn", text: "Oct−", onclick: () => applyTf(() => { for (let s = 0; s < 16; s++) for (const n of noteSlot(lane[s])) n.midi -= 12; }) }),
    el("div", { class: "tfbtn", text: "Oct+", onclick: () => applyTf(() => { for (let s = 0; s < 16; s++) for (const n of noteSlot(lane[s])) n.midi += 12; }) }),
    el("div", {
      class: "tfbtn",
      text: "Humanize",
      onclick: () => applyTf(() => { for (let s = 0; s < 16; s++) for (const n of noteSlot(lane[s])) n.vel = Math.max(0.4, Math.min(1, n.vel + (Math.random() * 0.4 - 0.2))); }),
    }),
    el("div", {
      class: "tfbtn",
      text: "Random",
      onclick: () =>
        applyTf(() => {
          const ns = scaleNotes(cfg.base, cfg.rows);
          for (let s = 0; s < 16; s++) {
            if (Math.random() >= 0.5) {
              lane[s] = null;
              continue;
            }
            const count = track === "melody" && Math.random() < 0.22 ? 2 + Math.floor(Math.random() * 2) : 1;
            const notes = [];
            for (let i = 0; i < count; i++) {
              notes.push({ midi: ns[Math.floor(Math.random() * ns.length)], len: 1, vel: 0.6 + Math.random() * 0.4 });
            }
            setNoteSlot(lane, s, notes);
          }
        }),
    }),
    el("div", { class: "tfbtn", text: "Clear", onclick: () => applyTf(() => { for (let s = 0; s < 16; s++) lane[s] = null; }) }),
    el("div", {
      class: "tfbtn",
      text: PIANO_VIEWS[pianoView],
      "data-action": "piano-zoom",
      onclick: () => {
        pianoView = (pianoView + 1) % 3;
        openEditor(sceneIndex, track);
      },
    }),
    stepLenControl(scene, track),
  ]);
  sheet.appendChild(tf);
  const clipLen = stepsFor(scene, track);
  const viewOff = pianoView === 2 ? 8 : 0;
  const viewCount = pianoView === 0 ? 16 : 8;

  const scrollContainer = el("div", { class: "editor-scroll" });
  const grid = el("div", { class: "proll" });
  const rowCells = []; // [rowIndex][step]
  const cursorCols = Array.from({ length: 16 }, () => []);

  const noteAt = (step, midi = null) => {
    for (let st = 0; st < 16; st++) {
      const notes = noteSlot(lane[st]);
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        if (step >= st && step < st + n.len && (midi === null || n.midi === midi)) {
          return { step: st, index: i, note: n };
        }
      }
    }
    return null;
  };

  rows.forEach((midi, ri) => {
    const cells = [];
    const rowSteps = el("div", { class: "psteps", style: `grid-template-columns: repeat(${viewCount}, 1fr)` });
    for (let s = viewOff; s < viewOff + viewCount; s++) {
      const cell = el("div", { class: "pcell", style: `--tc:${tc}` });
      cell.addEventListener("pointerdown", (e) => onNoteDown(e, s, midi, cell));
      cells[s] = cell;
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
  scrollContainer.appendChild(grid);
  sheet.appendChild(scrollContainer);

  // Velocity lane.
  const vlane = el("div", { class: "vlane" });
  const vbars = [];
  vlane.appendChild(el("div", { class: "vkey", text: "vel" }));
  const vsteps = el("div", { class: "vsteps", style: `grid-template-columns: repeat(${viewCount}, 1fr)` });
  for (let s = viewOff; s < viewOff + viewCount; s++) {
    const fill = el("i", { style: `--tc:${tc}` });
    const bar = el("div", { class: "vbar" }, [fill]);
    bar.addEventListener("pointerdown", (e) => onVelDown(e, s, bar));
    vbars[s] = fill;
    vsteps.appendChild(bar);
  }
  vlane.appendChild(vsteps);
  sheet.appendChild(vlane);

  function paint() {
    rows.forEach((midi, ri) => {
      for (let s = viewOff; s < viewOff + viewCount; s++) {
        const hit = noteAt(s, midi);
        rowCells[ri][s].className = `pcell${Math.floor(s / 4) % 2 ? "" : " g"}${hit ? " on" : ""}${hit && hit.step === s ? " nstart" : ""}${s >= clipLen ? " off" : ""}`;
      }
    });
    for (let s = viewOff; s < viewOff + viewCount; s++) {
      const notes = noteSlot(lane[s]);
      vbars[s].style.height = notes.length ? Math.round(slotPeakVel(lane[s]) * 100) + "%" : "0%";
      vbars[s].parentElement.style.opacity = notes.length ? 1 : 0.3;
    }
  }

  const scrollToNotes = () => {
    const activeRow = scrollContainer.querySelector(".pcell.on")?.closest(".prow");
    if (activeRow) {
      scrollContainer.scrollTop = activeRow.offsetTop - scrollContainer.clientHeight / 2 + activeRow.clientHeight / 2;
    } else {
      const defaultMidi = track === "bass" ? 36 : 60; // C2 or C4
      const targetRi = rows.findIndex(m => m <= defaultMidi);
      if (targetRi >= 0) {
        const rowEl = grid.children[targetRi];
        if (rowEl) scrollContainer.scrollTop = rowEl.offsetTop - scrollContainer.clientHeight / 2 + rowEl.clientHeight / 2;
      }
    }
  };

  async function onNoteDown(e, s, midi, cell) {
    e.preventDefault();
    if (s >= clipLen) return;
    await ensureStarted();
    pushUndo();
    const existing = noteAt(s, midi);
    const start = existing?.step ?? s;
    const note = existing?.note ?? { midi, len: 1, vel: slotPeakVel(lane[s]) || 0.9 };
    if (!existing) {
      setNoteSlot(lane, s, [...noteSlot(lane[s]), note]);
      audio.previewNote(track, midi);
    }
    paint();
    let moved = false;
    const rect = cell.parentElement.getBoundingClientRect();
    const cw = rect.width / viewCount;
    capturePointer(cell, e.pointerId);
    const move = (ev) => {
      const cur = Math.max(start, Math.min(viewOff + viewCount - 1, viewOff + Math.floor((ev.clientX - rect.left) / cw)));
      const len = cur - start + 1;
      if (len !== note.len) {
        removePitchInRange(lane, midi, start + 1, Math.min(15, start + len - 1), start);
        note.len = len;
        moved = true;
        paint();
      }
    };
    const up = () => {
      cell.removeEventListener("pointermove", move);
      cell.removeEventListener("pointerup", up);
      cell.removeEventListener("pointercancel", up);
      if (!moved && existing) {
        removeNoteFromSlot(lane, existing.step, existing.index);
        paint();
      }
      refreshClip(sceneIndex, track);
    };
    cell.addEventListener("pointermove", move);
    cell.addEventListener("pointerup", up);
    cell.addEventListener("pointercancel", up);
  }

  async function onVelDown(e, s, bar) {
    e.preventDefault();
    if (!noteSlot(lane[s]).length) return;
    await ensureStarted();
    pushUndo();
    const rect = bar.getBoundingClientRect();
    const set = (ev) => {
      const vel = Math.max(0.05, Math.min(1, 1 - (ev.clientY - rect.top) / rect.height));
      for (const n of noteSlot(lane[s])) n.vel = vel;
      paint();
    };
    set(e);
    capturePointer(bar, e.pointerId);
    const move = (ev) => set(ev);
    const up = () => {
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", up);
      bar.removeEventListener("pointercancel", up);
      refreshClip(sceneIndex, track);
    };
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", up);
    bar.addEventListener("pointercancel", up);
  }

  paint();
  setTimeout(scrollToNotes, 20); // wait for layout to settle
  editor.cursorCols = cursorCols;
}

function buildHarmonyEditor(sceneIndex, scene) {
  if (!scene.harmony || scene.harmony.length === 0) scene.harmony = [0, 0, 0, 0];
  let selected = 0;
  const scrollContainer = el("div", { class: "editor-scroll" });
  const row = el("div", { class: "chordrow" });
  const slots = scene.harmony.map((ci, idx) => {
    const slot = el("div", {
      class: "cslot" + (idx === 0 ? " sel" : ""),
      style: `--tc:${trackColor("harmony")}`,
      html: chordMarkup(ci, { notes: true }),
      onclick: () => {
        selected = idx;
        slots.forEach((s, k) => s.classList.toggle("sel", k === idx));
      },
    });
    return slot;
  });
  slots.forEach((s) => row.appendChild(s));
  scrollContainer.appendChild(row);

  const picker = el("div", { class: "picker" });
  CHORDS.forEach((ch, ci) => {
    picker.appendChild(
      el("div", {
        class: "copt",
        style: `background:${chordHex(ci)}`,
        html: chordMarkup(ci, { notes: true }),
        onclick: async () => {
          await ensureStarted();
          pushUndo();
          scene.harmony[selected] = ci;
          slots[selected].innerHTML = chordMarkup(ci, { notes: true });
          audio.preview(ci);
          refreshClip(sceneIndex, "harmony");
        },
      })
    );
  });
  scrollContainer.appendChild(picker);
  sheet.appendChild(scrollContainer);
}

function refreshClip(sceneIndex, track) {
  const refs = sceneEls[sceneIndex];
  if (!refs) return;
  const clip = refs.clips[track];
  const content = clipContent(song.scenes[sceneIndex], track);
  clip.innerHTML = "";
  clip.classList.toggle("filled", content !== null);
  clip.classList.toggle("empty", content === null);
  if (!content) {
    clip.textContent = "+";
    return;
  }
  clip.appendChild(el("div", { class: "tri", text: "▶" }));
  clip.appendChild(content);
  const badge = launchBadge(song.scenes[sceneIndex], track);
  if (badge) clip.appendChild(badge);
  const state = stateBadge(song.scenes[sceneIndex], track);
  if (state) clip.appendChild(state);
}

// ---------------------------------------------------------------------------
// Arrangement view (Ableton's linear timeline, mobile-first)
// ---------------------------------------------------------------------------
let arrScroll = null;
let arrContentEl = null;
let arrPlayhead = null;

function arrMini(scene, track) {
  if (track === "harmony") {
    return el("div", { class: "arr-harmony-mini", html: scene.harmony.map((c) => `<div>${chordMarkup(c)}</div>`).join("") });
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
  for (let s = 0; s < 16; s++) {
    const notes = noteSlot(lane[s]);
    const height = notes.length ? Math.round(3 + slotPeakVel(lane[s]) * 7 + Math.min(4, notes.length - 1) * 2) : 3;
    mini.appendChild(el("i", { style: `height:${height}px` }));
  }
  return mini;
}

function ensureArrShell() {
  const arrEl = document.getElementById("arrangement");
  if (arrScroll) return;
  const headers = el("div", { class: "arr-headers" }, [el("div", { class: "arr-corner" }, [viewMixButton()])]);
  for (const t of ARRANGE_TRACKS) {
    const meta = TRACKS.find((x) => x.key === t);
    const head = el("div", { class: "arr-thead track-head", style: `--tc:${meta.color}`, "data-track": t }, [
        el("div", { class: "dot" }),
        el("div", { class: "nm", text: meta.name }),
        el("div", { class: "ms" }, [trackToggleButton(t, "mute"), trackToggleButton(t, "solo")]),
        el("div", { class: "more", text: "⋯" }),
      ]);
    bindTrackHeader(head, t);
    headers.appendChild(head);
  }
  arrScroll = el("div", { class: "arr-scroll" });
  attachArrGestures(arrScroll);
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

  const ruler = el("div", { class: "arr-ruler" });
  const every = ppb >= 46 ? 1 : 4;
  for (let b = 0; b < totalBars; b++) {
    if (b % every === 0)
      ruler.appendChild(el("div", { class: "arr-tick", style: `left:${b * ppb}px`, text: String(b + 1) }));
  }
  const loop = song.loop;
  // The bottom strip of the ruler is the loop's own lane: body drags move it,
  // either edge grip resizes it, a tap toggles it, and dragging across empty
  // lane space paints a new loop right there.
  const lane = el("div", { class: "arr-looplane", onpointerdown: onLoopLaneDown });
  const brace = el("div", {
    class: "arr-loop" + (loop.on ? " on" : ""),
    style: `left:${loop.start * ppb}px; width:${loop.len * ppb}px`,
  }, [el("div", { class: "lz left" }), el("div", { class: "lz right" })]);
  lane.appendChild(brace);
  ruler.appendChild(lane);
  content.appendChild(ruler);

  ARRANGE_TRACKS.forEach((t) => {
    const meta = TRACKS.find((x) => x.key === t);
    const lane = el("div", {
      class: "arr-lane",
      "data-track": t,
      style: `--tc:${meta.color}`,
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
  updateTrackMixUI();
}

// Content-space bar under a client X, computed FRESH so it stays exact while
// the view auto-pans underneath the pointer.
const barFromX = (x) => Math.max(0, Math.round((x - arrContentEl.getBoundingClientRect().left) / ppb));

// Edge auto-pan for horizontal drags: hover near either edge of the
// arrangement viewport and it scrolls, faster the closer to the edge, calling
// onFrame so the drag math re-applies under the moving content.
const PAN_EDGE = 48;
function makeAutoPan(getClientX, onFrame) {
  let raf = 0;
  const tick = () => {
    raf = 0;
    const x = getClientX();
    const vw = arrScroll.getBoundingClientRect();
    let v = 0;
    if (x > vw.right - PAN_EDGE) v = Math.min(20, (x - (vw.right - PAN_EDGE)) * 0.4);
    else if (x < vw.left + PAN_EDGE) v = -Math.min(20, (vw.left + PAN_EDGE - x) * 0.4);
    if (v !== 0) {
      const before = arrScroll.scrollLeft;
      arrScroll.scrollLeft = Math.max(0, before + v);
      if (arrScroll.scrollLeft !== before) onFrame();
      raf = requestAnimationFrame(tick);
    }
  };
  return {
    poke() {
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

// A tap on the ruler moves the playhead there; a tap on empty lane space drops
// a 4-bar clip of the current scene. Both fire from attachArrGestures on a
// clean tap, so a drag pans the timeline instead of scrubbing or littering
// clips.
function arrRulerTap(clientX) {
  arrPlayBar = barFromX(clientX);
  if (audioReady) audio.setArrangePos(arrPlayBar);
  if (arrPlayhead) arrPlayhead.style.transform = `translateX(${arrPlayBar * ppb}px)`;
  selClip = null;
  updateArrToolbar();
  arrContentEl.querySelectorAll(".arr-clip.sel").forEach((n) => n.classList.remove("sel"));
}

function arrLaneTap(track, clientX) {
  pushUndo();
  const bar = barFromX(clientX);
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
  const grabOffset = barFromX(e.clientX) - clip.start;
  const laneRects = resize
    ? []
    : [...arrContentEl.querySelectorAll(".arr-lane")].map((l) => ({ track: l.dataset.track, rect: l.getBoundingClientRect() }));
  const homeTop = laneRects.find((L) => L.track === track)?.rect.top ?? 0;
  let targetTrack = track;
  const pre = snapshot();
  let changed = false;
  let lastX = e.clientX;
  let lastY = e.clientY;
  capturePointer(cl, e.pointerId);
  const applyFromXY = (x, y) => {
    changed = true;
    const bar = barFromX(x);
    if (resize) {
      clip.len = Math.max(1, bar - clip.start);
      cl.style.width = clip.len * ppb - 2 + "px";
    } else {
      clip.start = Math.max(0, bar - grabOffset);
      cl.style.left = clip.start * ppb + "px";
      const hit = laneRects.find((L) => y >= L.rect.top && y < L.rect.bottom);
      targetTrack = hit ? hit.track : track;
      cl.style.transform = targetTrack !== track ? `translateY(${laneRects.find((L) => L.track === targetTrack).rect.top - homeTop}px)` : "";
      cl.style.zIndex = 8;
    }
    const tools = arrContentEl.querySelector(".arr-tools");
    if (tools) tools.style.left = clip.start * ppb + "px";
  };
  const pan = makeAutoPan(() => lastX, () => applyFromXY(lastX, lastY));
  const move = (ev) => {
    lastX = ev.clientX;
    lastY = ev.clientY;
    applyFromXY(ev.clientX, ev.clientY);
    pan.poke();
  };
  const up = () => {
    pan.stop();
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

function onLoopLaneDown(e) {
  e.stopPropagation();
  e.preventDefault();
  const lane = e.currentTarget;
  const brace = lane.querySelector(".arr-loop");
  const loop = song.loop;
  const pre = snapshot();
  const downBar = barFromX(e.clientX);
  const mode = e.target.classList.contains("left")
    ? "left"
    : e.target.classList.contains("right")
      ? "right"
      : e.target.closest(".arr-loop")
        ? "move"
        : "paint";
  const o = { start: loop.start, end: loop.start + loop.len };
  let changed = false;
  let lastX = e.clientX;
  capturePointer(lane, e.pointerId);
  const apply = () => {
    brace.style.left = loop.start * ppb + "px";
    brace.style.width = loop.len * ppb + "px";
  };
  const applyFromX = (x) => {
    const bar = barFromX(x);
    if (mode === "move") {
      const next = Math.max(0, o.start + (bar - downBar));
      if (next !== loop.start) {
        loop.start = next;
        changed = true;
      }
    } else if (mode === "right") {
      const len = Math.max(1, bar - o.start);
      if (len !== loop.len) {
        loop.len = len;
        changed = true;
      }
    } else if (mode === "left") {
      const start = Math.max(0, Math.min(bar, o.end - 1));
      if (start !== loop.start) {
        loop.start = start;
        loop.len = o.end - start;
        changed = true;
      }
    } else if (bar !== downBar) {
      loop.start = Math.min(downBar, bar);
      loop.len = Math.max(1, Math.abs(bar - downBar));
      loop.on = true;
      brace.classList.add("on");
      changed = true;
    }
    apply();
  };
  const pan = makeAutoPan(() => lastX, () => applyFromX(lastX));
  const move = (ev) => {
    lastX = ev.clientX;
    applyFromX(ev.clientX);
    pan.poke();
  };
  const up = () => {
    pan.stop();
    lane.removeEventListener("pointermove", move);
    lane.removeEventListener("pointerup", up);
    lane.removeEventListener("pointercancel", up);
    if (!changed) {
      if (mode === "paint") {
        // Tap on empty lane: bring the loop here, keep its length and state.
        if (downBar !== loop.start) {
          loop.start = downBar;
          changed = true;
        }
      } else {
        loop.on = !loop.on;
        changed = true;
      }
    }
    if (changed) commitUndo(pre);
    renderArrangement();
  };
  lane.addEventListener("pointermove", move);
  lane.addEventListener("pointerup", up);
  lane.addEventListener("pointercancel", up);
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

// Arrangement gestures. One finger taps to drop a clip / move the playhead and
// drags to pan the timeline; two fingers pinch-zoom, anchored so the bar under
// your fingers stays put instead of drifting. Clips and the loop grip claim
// their own pointers (stopPropagation), so grabbing one never starts a pan.
// The pinch scales the existing DOM with a transform and commits real layout
// once, on release — no per-frame rebuild to stutter on a cheap phone.
const ARR_MIN_PPB = 22;
const ARR_MAX_PPB = 220;
const ARR_TAP_SLOP = 8;
function attachArrGestures(scroll) {
  const pts = new Map(); // pointerId -> clientX
  let mode = "idle"; // idle | tap | pan | pinch
  let downId = -1, downX = 0, downY = 0, downScroll = 0, downTarget = null, moved = false;
  let startDist = 0, startPpb = 0, focalPx = 0, startScroll = 0, lastScale = 1, lastMid = 0;
  const leftOf = () => scroll.getBoundingClientRect().left;
  const targetInfo = (e) => {
    if (e.target.closest(".arr-ruler")) return { kind: "ruler" };
    const lane = e.target.closest(".arr-lane");
    return lane ? { kind: "lane", track: lane.dataset.track } : null;
  };

  scroll.addEventListener("pointerdown", (e) => {
    scroll.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, e.clientX);
    if (pts.size === 1) {
      mode = "tap"; moved = false; downId = e.pointerId;
      downX = e.clientX; downY = e.clientY; downScroll = scroll.scrollLeft;
      downTarget = targetInfo(e);
    } else if (pts.size === 2) {
      mode = "pinch";
      const xs = [...pts.values()];
      startDist = Math.max(1, Math.abs(xs[0] - xs[1]));
      startPpb = ppb;
      startScroll = scroll.scrollLeft;
      focalPx = startScroll + ((xs[0] + xs[1]) / 2 - leftOf()); // content px under the pinch center
    }
  });

  scroll.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, e.clientX);
    if (mode === "pinch" && pts.size >= 2) {
      const xs = [...pts.values()];
      const dist = Math.max(1, Math.abs(xs[0] - xs[1]));
      const targetPpb = Math.max(ARR_MIN_PPB, Math.min(ARR_MAX_PPB, startPpb * (dist / startDist)));
      const scale = targetPpb / startPpb;
      const mid = (xs[0] + xs[1]) / 2 - leftOf();
      // Keep the focal bar pinned under the (possibly sliding) finger center.
      arrContentEl.style.transformOrigin = "0 0";
      arrContentEl.style.transform = `translateX(${mid - focalPx * scale + startScroll}px) scaleX(${scale})`;
      lastScale = scale; lastMid = mid;
    } else if ((mode === "tap" || mode === "pan") && e.pointerId === downId) {
      if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > ARR_TAP_SLOP) { moved = true; mode = "pan"; }
      if (mode === "pan") scroll.scrollLeft = downScroll - (e.clientX - downX);
    }
  });

  const up = (e) => {
    if (mode === "pinch") {
      ppb = Math.max(ARR_MIN_PPB, Math.min(ARR_MAX_PPB, startPpb * lastScale));
      renderArrangement(); // real layout at the new ppb; the transform dies with the old content
      const max = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
      scroll.scrollLeft = Math.max(0, Math.min(max, focalPx * lastScale - lastMid));
    } else if (mode === "tap" && !moved && e.pointerId === downId && downTarget) {
      if (downTarget.kind === "ruler") arrRulerTap(downX);
      else if (downTarget.kind === "lane") arrLaneTap(downTarget.track, downX);
    }
    pts.delete(e.pointerId);
    if (pts.size === 0) mode = "idle";
    else if (pts.size === 1) { // dropped from a pinch to one finger — carry on as a pan
      const [id] = [...pts.keys()];
      downId = id; downX = pts.get(id); downScroll = scroll.scrollLeft; moved = true; mode = "pan";
    }
  };
  scroll.addEventListener("pointerup", up);
  scroll.addEventListener("pointercancel", up);
}

// ---------------------------------------------------------------------------
// Project + WAV Export
// ---------------------------------------------------------------------------
function encodeWav(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const len = buffer.length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true); writeStr(36, "data"); view.setUint32(40, dataSize, true);
  const channels = [];
  for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function projectDevices() {
  return {
    drums: { kit: audio.kit(), patch: audio.patch("drums") },
    harmony: { preset: audio.harmonyPreset(), patch: audio.patch("harmony") },
    bass: { preset: audio.bassPreset(), patch: audio.patch("bass") },
    melody: { preset: audio.melodyPreset(), patch: audio.patch("melody") },
  };
}

function projectMix() {
  return Object.fromEntries(TRACKS.map((t) => [t.key, structuredClone(mixState[t.key])]));
}

function captureProject() {
  return {
    schema: PROJECT_SCHEMA,
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    song: snapshot(),
    mix: projectMix(),
    devices: projectDevices(),
  };
}

function downloadProject() {
  const json = JSON.stringify(captureProject(), null, 2);
  downloadBlob(new Blob([json], { type: "application/json" }), "noodles-project.noodles");
}

function restoreDevices(devices = {}) {
  // Names are corners; full patch specs win when present. Early v2 drum
  // patches had no x/y — keep the kit corner instead of defaulting to 0,0.
  if (KIT_NAMES.includes(devices.drums?.kit)) audio.setKit(devices.drums.kit);
  const legacy = { harmony: HARMONY_PRESET_NAMES, bass: BASS_PRESET_NAMES, melody: MELODY_PRESET_NAMES };
  for (const t of ["harmony", "bass", "melody", "drums"]) {
    const d = devices[t] || {};
    if (d.patch && typeof d.patch === "object") {
      const patch = { ...d.patch };
      if (!("x" in patch)) {
        const cur = audio.patch(t);
        patch.x = cur.x;
        patch.y = cur.y;
      }
      audio.setPatch(t, patch);
    } else if (t !== "drums" && legacy[t].includes(d.preset)) {
      if (t === "harmony") audio.setHarmonyPreset(d.preset);
      else if (t === "bass") audio.setBassPreset(d.preset);
      else audio.setMelodyPreset(d.preset);
    }
  }
}

function restoreMix(mix = {}) {
  for (const t of TRACKS) {
    const key = t.key;
    const defaults = MIX_DEFAULTS[key];
    const src = mix[key] || {};
    const parsed = {
      vol: Number.isFinite(Number(src.vol)) ? Number(src.vol) : defaults.vol,
      pan: Number.isFinite(Number(src.pan)) ? Number(src.pan) : defaults.pan,
      verb: Number.isFinite(Number(src.verb)) ? Number(src.verb) : Number.isFinite(Number(src.send)) ? Number(src.send) : defaults.verb,
      echo: Number.isFinite(Number(src.echo)) ? Number(src.echo) : defaults.echo,
      mute: !!src.mute,
      solo: !!src.solo,
    };
    Object.assign(mixState[key], parsed);
  }
  applyMixState();
}

function applyProject(rawProject) {
  const project = rawProject?.schema === PROJECT_SCHEMA ? rawProject : { song: rawProject };
  const nextSong = structuredClone(project.song);
  if (!nextSong || !Array.isArray(nextSong.scenes) || !nextSong.scenes.length) {
    throw new Error("Not a valid Noodles project.");
  }
  nextSong.scenes.forEach(normalizeScene);
  if (!nextSong.arrangement) nextSong.arrangement = {};
  for (const t of TRACKS) if (!Array.isArray(nextSong.arrangement[t.key])) nextSong.arrangement[t.key] = [];
  if (!nextSong.loop) nextSong.loop = { on: false, start: 0, len: 4 };
  if (!nextSong.trackSwing || typeof nextSong.trackSwing !== "object") nextSong.trackSwing = {};
  if (!Number.isFinite(Number(nextSong.tempo))) nextSong.tempo = 92;
  if (!Number.isFinite(Number(nextSong.key))) nextSong.key = 0;
  if (!nextSong.scale) nextSong.scale = "major";

  pushUndo();
  for (const key of Object.keys(song)) delete song[key];
  Object.assign(song, nextSong);
  restoreMix(project.mix);
  restoreDevices(project.devices);
  selClip = null;
  arrPlayBar = 0;
  playingScene = -1;
  for (const t of TRACKS) playingTracks[t.key] = -1;
  refreshAll();
}

async function loadProjectFile(file, status) {
  if (!file) return;
  try {
    applyProject(JSON.parse(await file.text()));
    status.textContent = "Project loaded";
  } catch (e) {
    status.textContent = "Load failed: " + e.message;
  }
}

function saveLocalProject(status) {
  try {
    const had = !!localStorage.getItem(LOCAL_PROJECT_KEY);
    localStorage.setItem(LOCAL_PROJECT_KEY, JSON.stringify(captureProject()));
    status.textContent = had ? "Kept on this device (replaced the previous one)" : "Kept on this device";
  } catch (e) {
    status.textContent = "Save failed: " + e.message;
  }
}

function loadLocalProject(status) {
  try {
    const raw = localStorage.getItem(LOCAL_PROJECT_KEY);
    if (!raw) {
      status.textContent = "Nothing kept on this device yet";
      return;
    }
    applyProject(JSON.parse(raw));
    status.textContent = "Loaded from this device";
  } catch (e) {
    status.textContent = "Load failed: " + e.message;
  }
}

let exporting = false;
function openExport() {
  resetSheet("#e8b84b");
  const status = el("div", { class: "exp-status", text: "" });
  const links = el("div", { class: "exp-links" });
  const fileInput = el("input", { class: "project-file", type: "file", accept: ".noodles,application/json" });
  fileInput.addEventListener("change", () => loadProjectFile(fileInput.files?.[0], status));

  // A WAV render runs for several seconds; on a phone that outlives the tap's
  // transient activation, so a script-triggered download after the await is
  // silently blocked \u2014 the status said "exported" but no file ever landed.
  // Hand the finished file back as a button the user taps: a fresh gesture
  // that downloads, or opens the native share sheet, reliably.
  function offerSave(blob, name, label) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { class: "exp-btn save", href: url, download: name, text: `\u2913  ${label}` });
    a.addEventListener("click", async (e) => {
      try {
        const file = new File([blob], name, { type: "audio/wav" });
        if (navigator.canShare?.({ files: [file] })) {
          e.preventDefault();
          await navigator.share({ files: [file], title: name });
        }
      } catch { /* share dismissed or unsupported \u2014 the download attribute stands in */ }
    });
    links.appendChild(a);
  }

  async function doExport(mode) {
    if (exporting) return;
    exporting = true;
    links.innerHTML = "";
    status.textContent = mode === "master" ? "Rendering master\u2026" : "Rendering stems\u2026";
    try {
      if (mode === "master") {
        const buf = await audio.renderOffline(null);
        offerSave(encodeWav(buf), "noodles-master.wav", "Save master WAV");
        status.textContent = "Master ready \u2014 tap to save:";
      } else {
        for (const t of TRACKS) {
          status.textContent = `Rendering ${t.name}\u2026`;
          const buf = await audio.renderOffline(t.key);
          offerSave(encodeWav(buf), `noodles-${t.key}.wav`, `Save ${t.name} stem`);
        }
        status.textContent = "Stems ready \u2014 tap to save:";
      }
    } catch (e) {
      status.textContent = "Export failed: " + e.message;
    }
    exporting = false;
  }

  sheet.appendChild(sheetBar("Export", "project · WAV"));
  sheet.appendChild(
    el("div", { class: "propsection" }, [
      el("div", { class: "proplabel", text: "project" }),
      el("div", { class: "exp-grid" }, [
        el("div", { class: "exp-btn", text: "Download Project", "data-action": "download-project", onclick: downloadProject }),
        el("div", { class: "exp-btn", text: "Load Project", "data-action": "load-project", onclick: () => fileInput.click() }),
        el("div", { class: "exp-btn", text: "Keep on device", "data-action": "save-local-project", onclick: () => saveLocalProject(status) }),
        el("div", { class: "exp-btn", text: "Load from device", "data-action": "load-local-project", onclick: () => loadLocalProject(status) }),
      ]),
      fileInput,
    ])
  );
  sheet.appendChild(
    el("div", { class: "propsection" }, [
      el("div", { class: "proplabel", text: "audio" }),
      el("div", { class: "exp-grid" }, [
        el("div", { class: "exp-btn", text: "\uD83C\uDFB5  Master WAV", "data-action": "export-master-wav", onclick: () => doExport("master") }),
        el("div", { class: "exp-btn", text: "\uD83C\uDFDA  Stems (4\u00d7)", "data-action": "export-stems", onclick: () => doExport("stems") }),
      ]),
    ])
  );
  sheet.appendChild(status);
  sheet.appendChild(links);
  openSheet();
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
  if (e.activeScenes) setActiveTracks(e.activeScenes);
  else if (e.scene !== undefined && e.scene !== playingScene) setPlaying(e.scene);
  // Always sync queued state from audio engine
  if (e.queuedTracks !== undefined) applyQueued(e.queuedTracks);
  
  if (e.type === "step") {
    if (sessionRecord && audio.playing && e.stepInBar === 0 && view === "session") {
      for (const track of ARRANGE_TRACKS) {
        const sceneIdx = e.activeScenes[track];
        const trackArr = song.arrangement[track];

        // Truncate or remove existing clips that overlap the current arrPlayBar
        for (let i = trackArr.length - 1; i >= 0; i--) {
          const c = trackArr[i];
          if (arrPlayBar >= c.start && arrPlayBar < c.start + c.len) {
            if (arrPlayBar === c.start) {
              c.start += 1;
              c.len -= 1;
              if (c.len <= 0) trackArr.splice(i, 1);
            } else {
              c.len = arrPlayBar - c.start;
            }
          }
        }

        if (sceneIdx !== undefined && sceneIdx >= 0) {
          let extended = false;
          for (const c of trackArr) {
            if (c.scene === sceneIdx && c.start + c.len === arrPlayBar) {
              c.len += 1;
              extended = true;
              break;
            }
          }
          if (!extended) {
            trackArr.push({ scene: sceneIdx, start: arrPlayBar, len: 1 });
          }
        }
      }
      arrPlayBar++;
    }

    if (e.progress) {
      for (const t of TRACKS) {
        const p = e.progress[t.key];
        const sceneIdx = playingTracks[t.key];
        if (p !== undefined && sceneIdx >= 0) {
          const row = sceneEls[sceneIdx];
          if (row) {
            const clipEl = row.clips[t.key];
            if (clipEl) {
              const pct = p * 100;
              // Wrap = new value below the old one: jump, don't sweep back.
              clipEl.classList.toggle("pie-snap", pct < (clipEl._pct ?? 0));
              clipEl._pct = pct;
              clipEl.style.setProperty("--pct", pct);
            }
          }
        }
      }
    }

    if (editor && editor.cursorCols) {
      if (editor.cursor >= 0) editor.cursorCols[editor.cursor]?.forEach((c) => c.classList.remove("cursor"));
      editor.cursor = e.stepInBar;
      editor.cursorCols[e.stepInBar]?.forEach((c) => c.classList.add("cursor"));
    }
  }
});

applyMixState();
applyStepDur();
renderTransport();
renderSession();

document.addEventListener("visibilitychange", () => {
  if (document.hidden && audio.playing) {
    audio.stop();
    updatePlayBtn(false);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat) return;
  const tag = e.target?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
  e.preventDefault();
  togglePlayback();
});

// Debug/measurement handle for the headless harnesses (smoke, calibrate).
// Not a public API — the scripts drive the same audio engine the UI does.
window.__noodles = { song, audio, applyProject };
