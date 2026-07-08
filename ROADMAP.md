# Roadmap / TODO

The live prototype is the Vite + Tone.js + DOM app at the repo root. Working today: Session +
Arrangement views, four clip editors (chords / drum rack / two piano rolls), mixer,
devices (kit picker + synth cutoff/decay), global Key + Scale (scale-aware), one-tap
Transforms (Arp / Oct / Humanize / Random / Clear), undo/redo, pinned transport.

## Agreed next (in order)

1. **Clip launch modes** — loop vs one-shot per clip, and follow-actions (Ableton's
   clip properties). Long-press a clip → a properties sheet.
2. **Mixer as vertical channel strips** — tall faders, prominent meters, sends A/B/C,
   horizontally scrollable. The Ableton mixer look (reference shots #3, #6).
3. **Sound / sample browser** — and it is the home for the **drum-sample loader**.
   *Priority:* real drum one-shots (tight funk / UK-garage kicks, snares, hats, claps)
   played by the Drum Rack instead of the synth kit. Keep the synth kit as a fallback
   option — it's good — but samples are what nail the sound. Browser organized by
   type/character; user can load their own WAVs.

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
