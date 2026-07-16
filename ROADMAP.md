# Roadmap / TODO

The live prototype is the Vite + Tone.js + DOM app at the repo root. `AGENTS.md` carries the
full "what works today" list; the short version: Session + Arrangement views with quantized
launch, launch modes and follow-actions, session-record into the arrangement, four clip
editors with velocity lanes, a vertical mixer with reverb/echo sends and loudness-matched
device presets, a randomized-but-balanced cold open with a 🎲 reroll, WAV export (master +
stems) through the same graph as live playback, project save/load, undo/redo, and two
headless gates (`npm run smoke`, `npm run calibrate`).

## Agreed next (in order)

1. **Chop deck** — the noodles-native warp (DECISIONS D6): load a WAV, auto-slice at
   transients or grid divisions, slices on pads sequenced on the same 16 steps,
   per-slice repitch via playbackRate. Extends the sample system that shipped.
2. **Motion lane editing** — the velocity-lane surface gains a param picker so recorded
   rides (DECISIONS D5) can be drawn and tweaked per step, plus send automation once
   the base-restore story against mixer state is decided.

Shipped since the last revision: clip launch modes + follow-actions, the vertical mixer,
sends, sidechain duck, per-preset loudness calibration, session record, WAV/stem export,
project files, the dice, the morphable devices (XY pad between the preset corners +
color/motion slot per track, calibration-gated), the bundled drum sample bank with
per-voice pins and user WAVs, motion capture — per-scene 16-step automation lanes
recorded by riding the sound pad (DECISIONS D5) — and the archetype dice (DECISIONS D9):
grooves with coupled tempo/pocket/kit, motif melodies, weighted harmony families, bass
behaviors, wet rolls, and a ✨b variation scene.

## Performance (Galaxy A16 5G / Dimensity 6300)

Adversarial investigation verdict (high confidence): **the stack is not the bottleneck —
the implementation is**, and the Vite dev server is a big confound. BandLab/Soundtrap run
smoothly on the same Web Audio API on this device class. So: optimize, don't switch stacks.

Done: convolution reverb → Freeverb; pad 24-voice fatsaw → 4-voice single saw; MetalSynth
hat → filtered noise burst; `latencyHint: "playback"` with `lookAhead 0.25` (scheduling
survives main-thread jank); pinch zoom scales a CSS transform and commits ONE rebuild on
release (no per-frame rebuild at all); meters transform-only and
only while the mixer is open; morph voices capped at the top-2 corners (2x a single synth,
never 4x); colors pay-per-roll; sample drums cost buffer playback instead of synthesis;
grid class sweeps dirty-checked per 16th; **idle park** — the context suspends ~6 s after
stop (past the longest tails) and wakes on any trigger, so a stopped app costs zero audio
CPU. Sound-neutral only, per the standing rule: no quality or capability trades.

Remaining, in honesty: the always-on chain while PLAYING (Freeverb combs, chorus, five
compressors, master stack) is the floor and it IS the sound — shrinking it means a measured
device tier that makes weak phones sound different from the export, a fork the builder must
call. Tier-2 render items still open: diff-based `paint()`/`refreshClip`, `color-mix()`
precompute, snapshot-undo only on committed change. A 44.1 kHz context (~8% on 48 k phones)
was tried and reverted — Tone throws wrapping custom-rate contexts (see AGENTS.md).

**On-device: run the production build, not the dev server** — `npm run build && npm run
preview -- --host`. The dev server ships unbundled ESM + unminified Tone.js; on the A55
cores that parse/waterfall cost dwarfs everything else.

## Later / ideas

- Piano roll: note-name labels on blocks, velocity as stems (partly done).
- Export: MIDI out, audio bounce, Ableton Link (Link needs a native build — DECISIONS D1).
- The living-light/Pixi aesthetic was dropped for Ableton's real UI (see the design thread).
