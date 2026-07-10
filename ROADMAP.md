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
per-voice pins and user WAVs, and motion capture — per-scene 16-step automation lanes
recorded by riding the sound pad (DECISIONS D5).

## Performance (Galaxy A16 5G / Dimensity 6300)

Adversarial investigation verdict (high confidence): **the stack is not the bottleneck —
the implementation is**, and the Vite dev server is a big confound. BandLab/Soundtrap run
smoothly on the same Web Audio API on this device class. So: optimize, don't switch stacks.

Done (two passes): convolution reverb → Freeverb; pad 24-voice fatsaw → 4-voice single saw,
short tail; deleted the inaudible halo PolySynth (now mono); MetalSynth hat → filtered
noise burst; `latencyHint: "playback"`. Render: pinch no longer rebuilds ~100×/s (coalesced
to ≤1/frame + static CSS bar-grid via `--ppb`); mixer meters use `transform: scaleX` not
`width`; dropped blurred box-shadows on high-frequency step/note cells.

Remaining (tier-2): diff-based `paint()` / `refreshClip` (touch only changed cells);
precompute `color-mix()` into CSS custom properties; snapshot-undo only on committed change
(avoid whole-song `structuredClone` per pointerdown); lazy/visible-only mixer meters.

**On-device: run the production build, not the dev server** — `npm run build && npm run
preview -- --host`. The dev server ships unbundled ESM + unminified Tone.js; on the A55
cores that parse/waterfall cost dwarfs everything else.

## Later / ideas

- Piano roll: note-name labels on blocks, velocity as stems (partly done).
- Export: MIDI out, audio bounce, Ableton Link (Link needs a native build — DECISIONS D1).
- The living-light/Pixi aesthetic was dropped for Ableton's real UI (see the design thread).
