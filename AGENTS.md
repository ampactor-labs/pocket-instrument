# Handoff — Pocket Instrument (a mobile Ableton-style DAW)

You (Codex / GPT-5.5) are taking over this project. This file is the current source of
truth. Read it fully before touching code; then read `ROADMAP.md`. The other root docs
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

The whole thing lives in `prototype/` (Vite + Tone.js + vanilla DOM/CSS). It runs on the
builder's phone over the LAN. **Target device: Galaxy A16 5G** (MediaTek Dimensity 6300,
entry-level) — performance is a first-class constraint, not an afterthought.

## Run it

```bash
cd prototype
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

Four files in `prototype/`. Keep the boundaries: model is pure data + theory, audio is the
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
  melody:  [ {midi,len,vel} | null × 16 ],  // monophonic step line, one note per 16th
  bass:    [ {midi,len,vel} | null × 16 ],
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
API. Graph: four per-track `Tone.Channel`s (volume/pan/send + a meter) → master limiter; a
`Freeverb` send return; harmony = detuned-ish saw pad + mono sine halo + sine sub; bass and
lead `Synth`s with filters (device params); a drum kit (kick MembraneSynth, snare/clap/hat as
filtered noise). One `Tone.Loop("16n")` clock drives **both** Scene looping and Arrangement
playback (per bar, `clipAt` picks each track's active clip), emitting UI events through
`Tone.Draw.schedule` → the `onVisual` callback. Public API: `init/play/stop/toggle/playing`,
`launchScene`, `playArrangement`/`setArrangePos`/`enterArrangement`, `setMode`, `setTempo`,
`setSwing`, `preview`/`previewHit`/`previewNote`, mixer `setVol`/`setPan`/`setSend`/`meter`,
devices `kit`/`setKit`/`device`/`setDevice`, and `onVisual`. Context is created with
`latencyHint:"playback"` for weak devices; keep the default 0.1s lookAhead.

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

Session clip grid and launch; Arrangement timeline with drag-move, edge-resize, split,
duplicate, delete, cross-track drag, a loop brace, and a gliding playhead; four clip editors;
mixer (vol/pan/send + live meters); devices (kit picker: garage/funk/clean, plus bass/melody
cutoff + decay); global Key + Scale (the whole app transposes and re-snaps in key); one-tap
Transforms; undo/redo; a global groove/swing slider; a pinned always-available transport. Two
performance passes are done (see `ROADMAP.md`).

## What's next (priority order — from `ROADMAP.md`)

1. **Clip launch modes** — loop vs one-shot per clip, and follow-actions. Long-press a clip →
   a properties sheet.
2. **Mixer as vertical channel strips** — tall faders, prominent meters, sends A/B/C,
   horizontally scrollable (the real Ableton mixer look).
3. **Sound / sample browser** — and it is the home for the **drum-sample loader**. This is the
   one the builder wants most: real drum one-shots (tight funk / UK-garage kicks, snares,
   hats, claps) played by the Drum Rack instead of the synth kit. Keep the synth kit as a
   fallback — it's good — but samples are the goal. The loader must accept user-loaded local
   WAVs (see the offline constraint below). Browser organized by type/character.

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
- **Nothing is committed.** The repo is `git init`'d with no commits — the whole working tree
  is uncommitted. Make an initial commit early so you have a baseline to diff against.

## Stale docs — read for philosophy, not for what to build

`HANDOFF.md`, `CLAUDE.md`, `DECISIONS.md`, `RESEARCH_FINDINGS.md` are from the project's
**original** concept: a playful, glowy "living-light pocket instrument" (Pixi + bloom, three
zoomable playgrounds). That aesthetic and paradigm were **dropped** after the builder clarified
they wanted literal mobile Ableton. Keep from those docs: the design philosophy (learning
through play, can't-make-it-wrong, no gamification), and the research (Ableton Note, Hooktheory
scale-degree color, Euclidean rhythm, ZUI). Ignore: the living-light visuals, the Pixi stack,
the fractal-zoom paradigm, the `DECISIONS.md` platform calls. The current truth is `prototype/`
+ `ROADMAP.md` + this file.

## How the builder works

Fast, hands-on, wants to *see* results — send screenshots, not descriptions. Values blunt
honesty about what's actually verified versus assumed. Prefers momentum over check-ins; make
the obvious call and surface only real forks. Ship a change, verify it headlessly, show it.
