// Pocket — a mobile take on Ableton's Session view.
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
  cloneScene,
  arrangeLength,
  scaleNotes,
  noteName,
  pcName,
  setScaleContext,
  snapToScale,
} from "./model.js";
import { createAudio, KIT_NAMES, HARMONY_PRESET_NAMES, BASS_PRESET_NAMES, MELODY_PRESET_NAMES } from "./audio.js";

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
const PROJECT_SCHEMA = "noodles-project";
const PROJECT_VERSION = 1;
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

let audioReady = false;
async function ensureStarted() {
  if (audioReady) return;
  audioReady = true;
  await audio.init();
}

let playingScene = -1;
const playingTracks = Object.fromEntries(TRACKS.map((t) => [t.key, -1]));
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
const footer = document.getElementById("footer");
let playBtn;
let bpmEl;
const TEMPO_MIN = 40;
const TEMPO_MAX = 220;

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
        if (audio.playing) audio.stop();
        else {
          const sceneIndex = playingScene >= 0 ? playingScene : 0;
          audio.launchScene(sceneIndex);
          setPlaying(sceneIndex);
        }
      }
      updatePlayBtn(audio.playing);
    },
  });
  bpmEl = el("div", { id: "bpm", role: "button", tabindex: "0", html: `${song.tempo}<small>BPM</small>` });
  bindTempoControl(bpmEl);
  // Play/pause + undo/redo are pinned left and never scroll.
  undoBtn = el("div", { class: "tbtn undo", text: "↶", onclick: undo });
  redoBtn = el("div", { class: "tbtn redo", text: "↷", onclick: redo });
  const left = el("div", { class: "tleft" }, [playBtn, undoBtn, redoBtn]);
  const tempo = el("div", { class: "ttempo" }, [bpmEl]);
  transport.append(left, tempo);
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
    el("span", { class: "swlabel", text: "Groove" }),
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
  const keyctl = el("div", { class: "keyctl" }, [el("span", { class: "swlabel", text: "Key" }), keySel, scaleSel]);
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
  const expBtn = el("div", { class: "tbtn", text: "Exp", "data-action": "open-export", onclick: openExport });
  const addBtn = el("div", {
    class: "tbtn",
    text: "+ Scene",
    "data-action": "add-scene",
    onclick: () => {
      pushUndo();
      const from = playingScene >= 0 ? playingScene : song.scenes.length - 1;
      song.scenes.push(cloneScene(song.scenes[from]));
      renderSession();
    },
  });
  footer.append(
    el("div", { class: "frow" }, [keyctl, groove]),
    el("div", { class: "frow" }, [seg, el("div", { class: "fspacer" }), expBtn, addBtn])
  );
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
function clampTempo(v) {
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(v)));
}
function updateTempoUI() {
  if (!bpmEl) return;
  bpmEl.innerHTML = `${song.tempo}<small>BPM</small>`;
}
function applyTempo(v) {
  const next = clampTempo(v);
  if (!Number.isFinite(next) || next === song.tempo) return false;
  song.tempo = next;
  updateTempoUI();
  audio.setTempo(song.tempo);
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
    node.setPointerCapture?.(e.pointerId);
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
  editor = null;
  cancelAnimationFrame(mixerRAF);
  mixerRAF = 0;
  sheet.innerHTML = "";
  sheet.style.setProperty("--tc", "#e8b84b");
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
  sheet.appendChild(
    el("div", { class: "sheet-bar" }, [
      el("div", { class: "swatch" }),
      el("div", { class: "title", text: "Tempo" }),
      el("div", { class: "sub", text: `${TEMPO_MIN}-${TEMPO_MAX} BPM` }),
      el("div", { class: "close", text: "Done", onclick: setTypedTempo }),
    ])
  );
  sheet.appendChild(el("div", { class: "tempo-sheet" }, [input]));
  scrim.classList.add("open");
  sheet.classList.add("open");
  setTimeout(() => {
    input.focus();
    input.select();
  }, 40);
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
  if (!filled) return;
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
    clip.classList.add("pressing");
    timer = window.setTimeout(() => {
      longPress = true;
      clear();
      openClipProps(sceneIndex, track);
    }, 520);
  });
  clip.addEventListener("pointermove", (e) => {
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > 12) {
      moved = true;
      clear();
    }
  });
  clip.addEventListener("pointerup", clear);
  clip.addEventListener("pointercancel", clear);
  // click fires reliably on mobile even when pointerup is swallowed by scroll
  clip.addEventListener("click", () => {
    if (!longPress && !moved) openEditor(sceneIndex, track);
  });
}

function renderSession() {
  sessionEl.innerHTML = "";
  sceneEls.length = 0;
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
    ]);
    bindTrackHeader(head, t.key);
    grid.appendChild(head);
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
        "data-scene": String(i),
        "data-track": t.key,
      });
      if (filled) {
        clip.appendChild(el("div", { class: "tri", text: "▶" }));
        clip.appendChild(content);
        const badge = launchBadge(scene, t.key);
        if (badge) clip.appendChild(badge);
      } else {
        clip.textContent = "＋";
      }
      bindSessionClip(clip, i, t.key, filled);
      refs.clips[t.key] = clip;
      grid.appendChild(clip);
    }
    sceneEls.push(refs);
  });
  sessionEl.appendChild(grid);
  applyPlaying();
  updateTrackMixUI();
}

function setPlaying(i) {
  playingScene = i;
  for (const t of TRACKS) playingTracks[t.key] = i;
  applyPlaying();
}
function setActiveTracks(activeScenes) {
  for (const t of TRACKS) playingTracks[t.key] = activeScenes[t.key] ?? -1;
  const first = playingTracks[TRACKS[0].key];
  playingScene = first >= 0 && TRACKS.every((t) => playingTracks[t.key] === first) ? first : -1;
  applyPlaying();
}
function applyPlaying() {
  sceneEls.forEach((r, i) => {
    const rowOn = i === playingScene;
    r.row.classList.toggle("playing", rowOn);
    for (const t of TRACKS) {
      const c = r.clips[t.key];
      if (c && c.classList.contains("filled")) c.classList.toggle("playing", playingTracks[t.key] === i);
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

function choice(label, on, onclick, attrs = {}) {
  return el("div", { class: "choice" + (on ? " on" : ""), text: label, onclick, ...attrs });
}

function openClipProps(sceneIndex, track) {
  editor = null;
  cancelAnimationFrame(mixerRAF);
  mixerRAF = 0;
  const scene = song.scenes[sceneIndex];
  const launch = clipLaunch(scene, track);
  const meta = TRACKS.find((t) => t.key === track);
  sheet.innerHTML = "";
  sheet.style.setProperty("--tc", meta.color);

  const setLaunch = (patch) => {
    const changed = Object.entries(patch).some(([k, v]) => launch[k] !== v);
    if (!changed) return;
    pushUndo();
    Object.assign(launch, patch);
    refreshClip(sceneIndex, track);
    openClipProps(sceneIndex, track);
  };

  sheet.appendChild(
    el("div", { class: "sheet-bar" }, [
      el("div", { class: "swatch" }),
      el("div", { class: "title", text: "Clip Properties" }),
      el("div", { class: "sub", text: `${meta.name} · Scene ${scene.tag}` }),
      el("div", { class: "close", text: "Done", onclick: closeEditor }),
    ])
  );

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
  sheet.appendChild(
    el("div", { class: "propsection" }, [
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
    ])
  );

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
          song.scenes.push(cloneScene(scene));
          const next = song.scenes.length - 1;
          renderSession();
          openClipProps(next, track);
        },
      }),
    ])
  );

  scrim.classList.add("open");
  sheet.classList.add("open");
}

// ---------------------------------------------------------------------------
// Mixer + devices
// ---------------------------------------------------------------------------
let mixerRAF = 0;
const MIX_DEFAULTS = {
  harmony: { vol: -6, pan: 0, verb: -9, echo: -36, mute: false, solo: false },
  drums: { vol: 0, pan: 0, verb: -22, echo: -42, mute: false, solo: false },
  bass: { vol: 0, pan: 0, verb: -48, echo: -60, mute: false, solo: false },
  melody: { vol: 0, pan: 0, verb: -11, echo: -28, mute: false, solo: false },
};
const mixState = structuredClone(MIX_DEFAULTS);

function slider(min, max, step, val, oninput) {
  const s = el("input", { type: "range", min, max, step, value: val });
  s.addEventListener("input", () => oninput(parseFloat(s.value)));
  return s;
}

function applyTrackMix(track) {
  const ms = mixState[track];
  if (!ms) return;
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
  return el("div", {
    class: "view-mix",
    text: "Mix",
    onpointerdown: (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMixer();
    },
  });
}
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
  editor = null;
  cancelAnimationFrame(mixerRAF);
  mixerRAF = 0;
  sheet.innerHTML = "";
  sheet.style.setProperty("--tc", meta.color);
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
  sheet.appendChild(
    el("div", { class: "sheet-bar" }, [
      el("div", { class: "swatch" }),
      el("div", { class: "title", text: "Track Options" }),
      el("div", { class: "sub", text: meta.name }),
      el("div", { class: "close", text: "Done", onclick: closeEditor }),
    ])
  );
  sheet.appendChild(
    el("div", { class: "propsection" }, [
      el("div", { class: "proplabel", text: "state" }),
      el("div", { class: "choicegrid two" }, [trackChoice("mute", "Mute"), trackChoice("solo", "Solo")]),
    ])
  );
  sheet.appendChild(
    el("div", { class: "tfrow" }, [
      el("div", { class: "tfbtn", text: "Mixer Strip", onclick: () => openMixer(track) }),
      el("div", { class: "tfbtn", text: "Reset Mix", onclick: () => { resetTrackMix(track); openTrackOptions(track); } }),
      el("div", { class: "tfbtn", text: "Reset Sends", onclick: () => { resetTrackMix(track, { sendsOnly: true }); openTrackOptions(track); } }),
    ])
  );
  scrim.classList.add("open");
  sheet.classList.add("open");
  updateTrackMixUI();
}

function openMixer(focusTrack = null) {
  editor = null;
  sheet.innerHTML = "";
  sheet.style.setProperty("--tc", "#8a8a90");
  sheet.appendChild(
      el("div", { class: "sheet-bar" }, [
        el("div", { class: "title", text: "Mixer" }),
      el("div", { class: "sub", text: "levels · verb · echo · devices" }),
      el("div", { class: "close", text: "Done", onclick: closeEditor }),
    ])
  );

  sheet.appendChild(
    el("div", { class: "tfrow" }, [
      el("div", { class: "tfbtn", text: "Reset Mix", onclick: () => { resetAllMix(); openMixer(focusTrack); } }),
      el("div", { class: "tfbtn", text: "Reset Sends", onclick: () => { resetAllMix({ sendsOnly: true }); openMixer(focusTrack); } }),
    ])
  );

  const container = el("div", { class: "mx-container" });
  const meterBars = {};
  for (const t of TRACKS) {
    const k = t.key;
    const ms = mixState[k];
    const meterFill = el("i");
    meterBars[k] = meterFill;
    const meter = el("div", { class: "mx-meter" }, [el("div", { class: "mx-meter-track" }, [meterFill])]);

    const volSlider = el("input", { type: "range", min: "-40", max: "6", step: "1", value: String(ms.vol), class: "mx-vfader" });
    volSlider.addEventListener("input", () => { ms.vol = parseFloat(volSlider.value); audio.setVol(k, ms.vol); });
    const volLabel = el("div", { class: "mx-val", text: `${ms.vol} dB` });
    volSlider.addEventListener("input", () => { volLabel.textContent = `${ms.vol} dB`; });

    const panSlider = slider(-1, 1, 0.05, ms.pan, (v) => { ms.pan = v; audio.setPan(k, v); });
    const verbSlider = slider(-60, 0, 1, ms.verb, (v) => { ms.verb = v; audio.setSend(k, v); });
    const echoSlider = slider(-60, 0, 1, ms.echo, (v) => { ms.echo = v; audio.setEcho(k, v); });

    // Device preset selector — all tracks get 3 options
    const devSection = el("div", { class: "mx-dev-section" });
    if (k === "drums") {
      const sel = el("select", { class: "mx-preset" });
      KIT_NAMES.forEach((n) => { const o = el("option", { value: n, text: n }); if (n === audio.kit()) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => audio.setKit(sel.value));
      devSection.append(el("div", { class: "mx-devlabel", text: "kit" }), sel);
    } else if (k === "harmony") {
      const sel = el("select", { class: "mx-preset" });
      HARMONY_PRESET_NAMES.forEach((n) => { const o = el("option", { value: n, text: n }); if (n === audio.harmonyPreset()) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => audio.setHarmonyPreset(sel.value));
      devSection.append(el("div", { class: "mx-devlabel", text: "preset" }), sel);
    } else if (k === "bass") {
      const sel = el("select", { class: "mx-preset" });
      BASS_PRESET_NAMES.forEach((n) => { const o = el("option", { value: n, text: n }); if (n === audio.bassPreset()) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => audio.setBassPreset(sel.value));
      devSection.append(el("div", { class: "mx-devlabel", text: "preset" }), sel);
    } else {
      const sel = el("select", { class: "mx-preset" });
      MELODY_PRESET_NAMES.forEach((n) => { const o = el("option", { value: n, text: n }); if (n === audio.melodyPreset()) o.selected = true; sel.appendChild(o); });
      sel.addEventListener("change", () => audio.setMelodyPreset(sel.value));
      devSection.append(el("div", { class: "mx-devlabel", text: "preset" }), sel);
    }

    const strip = el("div", { class: "mx-strip" + (focusTrack === k ? " focus" : ""), style: `--tc:${t.color}`, "data-track": k }, [
      el("div", { class: "mx-name" }, [el("span", { class: "mx-dot" }), el("span", { text: t.name })]),
      el("div", { class: "mx-ms" }, [trackToggleButton(k, "mute"), trackToggleButton(k, "solo")]),
      meter,
      volSlider,
      volLabel,
      el("div", { class: "mx-knob" }, [el("label", { text: "pan" }), panSlider]),
      el("div", { class: "mx-knob" }, [el("label", { text: "verb" }), verbSlider]),
      el("div", { class: "mx-knob" }, [el("label", { text: "echo" }), echoSlider]),
      devSection,
    ]);
    container.appendChild(strip);
  }
  const masterFill = el("i");
  meterBars.master = masterFill;
  container.appendChild(
    el("div", { class: "mx-strip mx-master", style: "--tc:#d2d2d4", "data-track": "master" }, [
      el("div", { class: "mx-name" }, [el("span", { class: "mx-dot" }), el("span", { text: "Master" })]),
      el("div", { class: "mx-master-note", text: "safe chain" }),
      el("div", { class: "mx-meter" }, [el("div", { class: "mx-meter-track" }, [masterFill])]),
      el("div", { class: "mx-val", text: "polish on" }),
      el("div", { class: "mx-master-chain", text: "trim · warm · glue · clip · limit" }),
    ])
  );
  sheet.appendChild(container);

  scrim.classList.add("open");
  sheet.classList.add("open");
  if (focusTrack) {
    setTimeout(() => sheet.querySelector(`.mx-strip[data-track="${focusTrack}"]`)?.scrollIntoView({ inline: "center", block: "nearest" }), 30);
  }
  updateTrackMixUI();
  const tick = () => {
    for (const t of TRACKS) {
      const lvl = Math.max(0, Math.min(1, (audio.meter(t.key) + 54) / 54));
      const bar = meterBars[t.key];
      if (bar && Math.abs((bar._lvl || 0) - lvl) > 0.01) {
        bar.style.transform = `scaleY(${lvl})`;
        bar._lvl = lvl;
      }
    }
    const mlvl = Math.max(0, Math.min(1, (audio.meter("master") + 54) / 54));
    if (meterBars.master && Math.abs((meterBars.master._lvl || 0) - mlvl) > 0.01) {
      meterBars.master.style.transform = `scaleY(${mlvl})`;
      meterBars.master._lvl = mlvl;
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
  const badge = launchBadge(song.scenes[sceneIndex], track);
  if (badge) clip.appendChild(badge);
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
  const headers = el("div", { class: "arr-headers" }, [el("div", { class: "arr-corner" }, [viewMixButton()])]);
  for (const t of ARRANGE_TRACKS) {
    const meta = TRACKS.find((x) => x.key === t);
    const head = el("div", { class: "arr-thead track-head", style: `--tc:${meta.color}`, "data-track": t }, [
        el("div", { class: "dot" }),
        el("div", { class: "nm", text: meta.name }),
        el("div", { class: "ms" }, [trackToggleButton(t, "mute"), trackToggleButton(t, "solo")]),
      ]);
    bindTrackHeader(head, t);
    headers.appendChild(head);
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
  updateTrackMixUI();
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
    drums: { kit: audio.kit() },
    harmony: { preset: audio.harmonyPreset() },
    bass: { preset: audio.bassPreset() },
    melody: { preset: audio.melodyPreset() },
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
  if (KIT_NAMES.includes(devices.drums?.kit)) audio.setKit(devices.drums.kit);
  if (HARMONY_PRESET_NAMES.includes(devices.harmony?.preset)) audio.setHarmonyPreset(devices.harmony.preset);
  if (BASS_PRESET_NAMES.includes(devices.bass?.preset)) audio.setBassPreset(devices.bass.preset);
  if (MELODY_PRESET_NAMES.includes(devices.melody?.preset)) audio.setMelodyPreset(devices.melody.preset);
}

function restoreMix(mix = {}) {
  for (const t of TRACKS) {
    const key = t.key;
    const defaults = MIX_DEFAULTS[key];
    const src = mix[key] || {};
    Object.assign(mixState[key], {
      vol: Number.isFinite(Number(src.vol)) ? Number(src.vol) : defaults.vol,
      pan: Number.isFinite(Number(src.pan)) ? Number(src.pan) : defaults.pan,
      verb: Number.isFinite(Number(src.verb)) ? Number(src.verb) : Number.isFinite(Number(src.send)) ? Number(src.send) : defaults.verb,
      echo: Number.isFinite(Number(src.echo)) ? Number(src.echo) : defaults.echo,
      mute: !!src.mute,
      solo: !!src.solo,
    });
  }
  applyMixState();
}

function applyProject(rawProject) {
  const project = rawProject?.schema === PROJECT_SCHEMA ? rawProject : { song: rawProject };
  const nextSong = structuredClone(project.song);
  if (!nextSong || !Array.isArray(nextSong.scenes) || !nextSong.scenes.length) {
    throw new Error("Not a valid Noodles project.");
  }
  if (!nextSong.arrangement) nextSong.arrangement = {};
  for (const t of TRACKS) if (!Array.isArray(nextSong.arrangement[t.key])) nextSong.arrangement[t.key] = [];
  if (!nextSong.loop) nextSong.loop = { on: false, start: 0, len: 4 };
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
    localStorage.setItem(LOCAL_PROJECT_KEY, JSON.stringify(captureProject()));
    status.textContent = "Local snapshot saved";
  } catch (e) {
    status.textContent = "Local save failed: " + e.message;
  }
}

function loadLocalProject(status) {
  try {
    const raw = localStorage.getItem(LOCAL_PROJECT_KEY);
    if (!raw) {
      status.textContent = "No local snapshot yet";
      return;
    }
    applyProject(JSON.parse(raw));
    status.textContent = "Local snapshot loaded";
  } catch (e) {
    status.textContent = "Local load failed: " + e.message;
  }
}

let exporting = false;
function openExport() {
  editor = null;
  sheet.innerHTML = "";
  sheet.style.setProperty("--tc", "#e8b84b");
  const status = el("div", { class: "exp-status", text: "" });
  const fileInput = el("input", { class: "project-file", type: "file", accept: ".noodles,application/json" });
  fileInput.addEventListener("change", () => loadProjectFile(fileInput.files?.[0], status));

  async function doExport(mode) {
    if (exporting) return;
    exporting = true;
    status.textContent = mode === "master" ? "Rendering master\u2026" : "Rendering stems\u2026";
    try {
      if (mode === "master") {
        const buf = await audio.renderOffline(null);
        downloadBlob(encodeWav(buf), "noodles-master.wav");
        status.textContent = "Master exported \u2713";
      } else {
        for (const t of TRACKS) {
          status.textContent = `Rendering ${t.name}\u2026`;
          const buf = await audio.renderOffline(t.key);
          downloadBlob(encodeWav(buf), `noodles-${t.key}.wav`);
        }
        status.textContent = "4 stems exported \u2713";
      }
    } catch (e) {
      status.textContent = "Export failed: " + e.message;
    }
    exporting = false;
  }

  sheet.appendChild(
    el("div", { class: "sheet-bar" }, [
      el("div", { class: "swatch" }),
      el("div", { class: "title", text: "Export" }),
      el("div", { class: "sub", text: "project · WAV" }),
      el("div", { class: "close", text: "Done", onclick: closeEditor }),
    ])
  );
  sheet.appendChild(
    el("div", { class: "propsection" }, [
      el("div", { class: "proplabel", text: "project" }),
      el("div", { class: "exp-grid" }, [
        el("div", { class: "exp-btn", text: "Download Project", "data-action": "download-project", onclick: downloadProject }),
        el("div", { class: "exp-btn", text: "Load Project", "data-action": "load-project", onclick: () => fileInput.click() }),
        el("div", { class: "exp-btn", text: "Save Local", "data-action": "save-local-project", onclick: () => saveLocalProject(status) }),
        el("div", { class: "exp-btn", text: "Load Local", "data-action": "load-local-project", onclick: () => loadLocalProject(status) }),
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
  scrim.classList.add("open");
  sheet.classList.add("open");
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
  if (e.type === "step" && editor && editor.cursorCols) {
    if (editor.cursor >= 0) editor.cursorCols[editor.cursor]?.forEach((c) => c.classList.remove("cursor"));
    editor.cursor = e.stepInBar;
    editor.cursorCols[e.stepInBar]?.forEach((c) => c.classList.add("cursor"));
  }
});

renderTransport();
renderSession();
