# Agent brief — Noodles (a mobile Ableton-style DAW)

This file is the current source of truth for whoever (or whatever) works on the code.
Read it fully before touching anything; then read `ROADMAP.md`. The other root docs
are history — see "Stale docs" below so they don't mislead you.

## What this is, in one paragraph

A mobile-first, browser-based DAW built in Ableton Live's idiom: a Session clip grid, an
Arrangement timeline, per-clip editors (chord blocks, a drum-rack step sequencer, a
scale-snapped piano roll), a mixer, and simple devices. It is deliberately **scale-aware**
— pick a key + scale and you can't play a wrong note — which is both the "learn by playing,
no lessons" goal and Ableton Live 12's own direction. The mandate from the builder: take
Ableton's real UI and functionality and translate it to a thumb, keeping it **simple,
educational, fun, and powerful** — steal Ableton's interaction model (grid, launch-and-loop,
direct drag, scale-awareness, one-tap transforms), never its density. Big touch targets,
progressive disclosure, magic on one tap, always in key.

The whole thing lives at the repo root (Vite + Tone.js + vanilla DOM/CSS). It runs on the
builder's phone over the LAN. **Target device: Galaxy A16 5G** (MediaTek Dimensity 6300,
entry-level) — performance is a first-class constraint, not an afterthought.

## Run it

```bash
npm install
npm run dev -- --host          # iteration; open the printed Network URL on a phone
```

For a real read on performance, use the production build, not the dev server:

```bash
npm run build && npm run preview -- --host
```

The dev server ships unbundled ES modules + unminified Tone.js; on the A16's little cores
that parse/waterfall cost is large and misleading. Judge speed on the prod build.

## Verify — read this, it's the load-bearing workflow

There is **no test suite** and the UI only makes sense on a phone-sized touch screen. Every
change in this project was verified by driving the running dev server with **headless Chrome
(puppeteer-core)**: interact via DOM selectors and synthetic pointer events, screenshot to
"see" the result, assert DOM state, and catch runtime throws with `page.on('pageerror')`.

A green `npm run build` only proves it compiles — it does **not** prove Tone.js/DOM run
without throwing. Always build **and** headless-smoke before you claim something works.

Minimal template (google-chrome is at `/usr/bin/google-chrome`; run the dev server first):

```js
import puppeteer from "puppeteer-core";
const b = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
         "--enable-unsafe-swiftshader", "--mute-audio"],
});
const p = await b.newPage();
await p.setViewport({ width: 390, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const errs = []; p.on("pageerror", e => errs.push(e.message));
await p.goto("http://localhost:5177/", { waitUntil: "networkidle2" });
await new Promise(r => setTimeout(r, 500));
// interact: p.$$(".clip.filled"), (await p.$$(...))[i].click(), p.mouse.*, p.evaluate(...)
// assert:   const n = (await p.$$(".arr-lane[data-track=bass] .arr-clip")).length;
await p.screenshot({ path: "shot.png" });
console.log("errors:", errs.length ? errs.join("|") : "none");
await b.close();
```

Then Read the PNG to inspect the UI. Audio can't be heard headlessly — verify sound
logic by reading state, and lean on the builder for on-device audio/feel checks.

## Architecture

Four files under `src/` + `index.html`. Keep the boundaries: model is pure data + theory, audio is the
Tone.js graph, main is all UI/interaction, index.html is the shell + CSS.

**`src/model.js`** — pure data and music theory, no DOM, no Tone. The `song`:

```
song = {
  tempo: 92, key: 0 /*0..11, 0=C*/, scale: "major", swing: 0.16 /*0..0.6*/,
  scenes: [ Scene ],
  arrangement: { harmony:[Clip], drums:[Clip], bass:[Clip], melody:[Clip] },
  loop: { on:false, start:0, len:4 },
}
Scene = {
  tag: "A",
  harmony: [degreeIdx × 4],                 // index 0..6 into CHORDS, one chord per bar
  drums:   { kick:[bool×16], snare, hat, clap },
  melody:  [ [{midi,len,vel}...] | null × 16 ],  // scale-snapped note stacks
  bass:    [ [{midi,len,vel}...] | null × 16 ],
}
Clip = { scene: sceneIndex, start: bar, len: bars }   // references a scene's clip for that track
```

Scale-awareness lives here: `CHORDS` is an exported **live binding** (a `let`, not a `const`)
rebuilt by `setScaleContext(key, scaleName)` — the seven diatonic triads are derived from the
key + scale, with correct roman-numeral case and names. Harmony is stored as **scale-degree
indices**, so it follows a key/scale change for free. `scaleNotes(base, rows)` and
`snapToScale(midi)` drive the piano roll. `SCALES` has major/minor/dorian/phrygian/lydian/
mixolydian (all 7-note, so 7 chords each). Also here: `voiceLead`, `sharedTones`, `euclid`,
the drum-voice metadata, and `makeSong` / `makeScene` / `cloneScene` / `arrangeLength` / `clipAt`.

**`src/audio.js`** — `createAudio(song)` builds the Tone.js graph and returns the transport
API. The one rule that matters: **`buildGraph()` is the only place the signal chain exists.**
The live context and `renderOffline` (WAV export) both call it, so export-matches-app holds
by construction; never fork the chain. Topology: per track a preset **trim** Gain and
`Tone.Channel` (drums skip the per-track input compressor; they already get parallel
compression), reverb + echo sends, a kick-sidechain duck on everything melodic, a drum bus
with a parallel compressor, and a master section (gain → saturation → soft clip → glue
compressor → +8 dB makeup → limiter at -2). Harmony = saw pad (the LFO owns its filter
cutoff, because a signal connected to a param overrides it; presets rescale the LFO range)
+ mono halo + a highpassed root hint; bass and lead are PolySynths behind drive/filters; the
kit is MembraneSynth kick + filtered-noise snare/hat/clap. Each track's device is a
**morph**: four synth layers (one per preset corner, oscillator + envelope fixed) crossfaded
by a patch `{x, y}` with equal-power bilinear weights, shared tone controls blended; drums
morph by blending kit scalars directly. Plus one **color** insert per track
(tape/crush/phase/trem/wob) with amount + motion, motion rates tempo-synced. Preset *names*
are the corners, and the old preset API snaps to them and reads back the dominant one. The
corner tables carry **measured** gain trims and the morph space inherits them. Run
`npm run calibrate` before and after changing corners, colors, or the chain; per-track
spreads (corners AND space table) must stay ≲2.5 dB or randomizing sounds starts randomizing
the mix. One `Tone.Loop("16n")` clock drives both Scene looping and Arrangement
playback, emitting UI events through `Tone.Draw.schedule` → `onVisual`. Public API:
`init/play/stop/playing`, `launchScene`/`launchClip`, `playArrangement`/`setArrangePos`/
`enterArrangement`, `setTempo`/`setSwing`, `preview`/`previewHit`/`previewNote`, mixer
`setVol`/`setPan`/`setSend`/`setEcho`/`setMute`/`setSolo`/`meter`, preset getters/setters
per track, `onVisual`, and `renderOffline(soloTrack)`. Context is created with
`latencyHint:"playback"` and `lookAhead: 0.25` — scheduling runs on the main thread, and on
little cores a janky frame under 0.1 s of headroom becomes an audible gap. Don't wrap a
custom-sampleRate native AudioContext in Tone.Context: it throws stackless
InvalidStateErrors somewhere inside Tone (tried for the 48k→44.1k saving, reverted).

**`src/main.js`** — all UI and interaction, vanilla DOM (no framework). It builds: the
transport (pinned **play + undo + redo** that never scroll and sit above any open editor,
then BPM ±, KEY + scale picker, GROOVE, Session|Arrange toggle, Mix, +); the Session clip
grid; the Arrangement timeline (bar ruler, track lanes, clips, playhead, loop brace); the
bottom-sheet editors (chords / drum rack / piano roll — the piano roll has note length,
a velocity lane, and one-tap Transforms: Arp/Oct/Humanize/Random/Clear); and the mixer sheet
(faders/pan/send/meters + kit picker + synth cutoff/decay). Undo/redo is **whole-song
`structuredClone` snapshots** (`pushUndo` before an edit; drag handlers snapshot on
pointerdown and commit only if something changed). `refreshAll()` re-renders everything after
a key/scale change or an undo (and re-applies `setScaleContext`).

**`index.html`** — the dark Ableton-style CSS and the shell: `#transport`, `#session`,
`#arrangement`, `#scrim`, `#sheet`. Colors are per-track. `vite.config.js` targets `esnext`.

## What works today

Session clip grid with quantized launch, per-clip launch modes (loop/one-shot) and
follow-actions; Arrangement timeline with drag-move, edge-resize, split, duplicate, delete,
cross-track drag, a loop brace, and a gliding playhead; session-record (arm ● and your
scene launches get written into the arrangement bar by bar); four clip editors, each with a
velocity lane; vertical mixer strips (fader, pan, reverb + echo sends, live meters with peak
hold, preset pickers); loudness-matched device presets per track; randomized-but-balanced
cold open (key, scale, tempo, presets, magic scene) plus a 🎲 button that rerolls it all;
global Key + Scale (the whole app transposes and re-snaps in key); one-tap Transforms;
undo/redo; groove/swing; WAV export (master + four stems, plus a seamless loop render when
the arrangement loop is set) through the same graph as live playback, handed back as
tap-to-save buttons because a long render outlives a phone tap's transient activation;
project save/load to file and localStorage; GitHub Pages deploy on push.

## What's next (priority order — from `ROADMAP.md`)

The drum-sample loader shipped: four bundled sample kits (street/warm/dusty/808, generated
by `npm run samples` into `public/samples/`, ~410 KB) play by default as morphable corners,
with per-voice pins and user-loaded local WAVs (session-scoped; a persistence story for user
samples is an open fork — IndexedDB vs project-file embedding). Remaining browser ideas:
more bundled kits/characters, and melodic sample sources.

Plus tier-2 performance work listed in `ROADMAP.md` (diff-based cell repaints, precompute
`color-mix()` into CSS custom properties, snapshot undo only on committed change, lazy meters).

## Constraints and gotchas (learned the hard way)

- **Offline / strict CSP.** No external assets, CDNs, fonts, or network fetches — everything
  must be bundled or user-provided. That is *why* the drums are synthesized (samples can't be
  fetched here), and why the sample loader has to take **local files the user picks**, not URLs.
- **Low-end phone is the target.** Node count in the audio graph and CSS/DOM repaint cost are
  the enemies. Avoid: rebuilding the world on a continuous gesture (pinch/drag), `box-shadow`
  blur on frequently-toggled cells, per-move `color-mix()` recompute, layout-property
  animation (`width`) instead of `transform`. An adversarial investigation confirmed the
  **stack is fine — the implementation is the bottleneck**; optimize, don't switch stacks.
- **The transport must always be reachable.** Play/pause (and undo/redo) are pinned top-left in
  `.tleft`, never scroll off, and float above the editor scrim (z-index). Don't regress this.
- **Scale-aware is the core.** It's the "can't-make-it-wrong" promise and the Ableton-12 idea.
  Harmony is degree-based (follows key/scale automatically); bass/melody transpose + re-snap on
  key change. Keep every new note-producing surface scale-snapped by default.
- **Modern-browser features in use:** `structuredClone`, CSS `color-mix()`, `esnext` build
  target. Fine for the target phones; don't add polyfills.
- **Two gates before claiming anything works:** `npm run smoke` (headless Chrome drives the
  core flow of launch, editors, record, export, and dice, and fails on any page error) and,
  if you touched the audio chain or presets, `npm run calibrate` (renders every preset
  through the real graph and prints RMS/peak tables; per-track spreads should stay ≲2.5 dB).
  A green `npm run build` proves nothing about runtime.
- **`window.__noodles`** exposes `{ song, audio, applyProject }` for the headless harnesses.
  It is not a public API, but keep it working; smoke and calibrate depend on it.

## Stale docs — read for philosophy, not for what to build

`HANDOFF.md`, `CLAUDE.md`, `DECISIONS.md`, `RESEARCH_FINDINGS.md` are from the project's
**original** concept: a playful, glowy "living-light" sketchpad (Pixi + bloom, three
zoomable playgrounds). That aesthetic and paradigm were **dropped** after the builder clarified
they wanted literal mobile Ableton. Keep from those docs: the design philosophy (learning
through play, can't-make-it-wrong, no gamification), and the research (Ableton Note, Hooktheory
scale-degree color, Euclidean rhythm, ZUI). Ignore: the living-light visuals, the Pixi stack,
the fractal-zoom paradigm, the `DECISIONS.md` platform calls. The current truth is the
app at the repo root + `ROADMAP.md` + this file.

## How the builder works

Fast, hands-on, wants to *see* results — send screenshots, not descriptions. Values blunt
honesty about what's actually verified versus assumed. Prefers momentum over check-ins; make
the obvious call and surface only real forks. Ship a change, verify it headlessly, show it.
