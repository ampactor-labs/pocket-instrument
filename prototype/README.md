# Pocket Ableton — living-light prototype

The vertical slice of the paradigm in `../../.claude/plans/elegant-painting-glade.md`:
one Scene (harmony + programmable drums) that you pinch out into a Song ribbon.
Session and arrangement as one fractal surface, no mode toggle.

## Run

```bash
npm install
npm run dev -- --host      # --host exposes it on your LAN for the phone
```

Open the `Network:` URL on your phone (same Wi-Fi). Tap once to start.

## What's here

- **Living-light render** (Pixi + GPU bloom). Chord orbs bloom as the playhead
  reaches them; color bleeds from the active chord into the field; common tones
  glow as threads between orbs.
- **Scene = a loop.** Four harmony orbs (one chord per bar) over three drum
  lanes (kick / snare / hat). It opens already playing.
- **Edit by touch.** Tap an orb → a radial ring of the seven diatonic chords
  blooms around it; tap one to set it. Tap a drum step to toggle it. All seven
  chords are in key, so nothing sounds wrong.
- **Pinch out → the Song.** The chevron at the top (or a pinch) zooms out; the
  Scene becomes a block on a ribbon. Tap `+` to add a section, tap a block to
  dive back in. Pinch in (or tap a block) to return.
- **One lush voice** — detuned saw pad with a drifting filter, a sine halo, sub,
  and reverb; a warm synth kit under it.

## Known tuning (feel first, then dial)

- Bloom runs hot — orb centers blow to white and wash the roman numerals.
- The background color-bleed is strong and lingers into the Song view.
- The radial picker clips off-screen for the leftmost / rightmost orb.
- The Scene→Song crossfade overlaps both layers mid-transition.

## Not yet (next zoom levels)

Bass and melody lanes, the Lane-level Euclidean dials, the Voice-level detail
(chord inversions, hit microtiming), and drag-to-reorder in the Song. This slice
exists to prove the paradigm and the feel before any of that.
