# Pocket instrument

A phone-first music sketchpad. It borrows Ableton's interaction model (the clip
grid, launch-and-loop, direct drag, scale-awareness, one-tap transforms) and
almost none of its density. The bet: the instrument is the lesson. The
affordances carry the theory, so the first pleasing sound is seconds away and
the depth only shows up when you go looking for it.

`HANDOFF.md` is the full brief: who it's for, the design principles, the
playgrounds, the milestone. `DECISIONS.md` records the forks and why each went
the way it did. This file is just how to run the thing.

## Run

```bash
npm install
npm run dev -- --host      # --host serves it on your LAN; open the Network URL on a phone
```

Tap once to start; browsers gate the audio context behind a user gesture. For an
honest read on performance, build and preview rather than trusting the dev
server:

```bash
npm run build && npm run preview -- --host
```

The dev server ships unbundled ES modules and unminified Tone.js. On an
entry-level phone (the target is a Galaxy A16 5G) that parse cost dwarfs
everything else and misleads. Judge speed on the production build.

## What works today

Session and Arrangement views over one song model. Four clip editors: a chord
picker, a drum rack, and two piano rolls (bass and melody). A mixer with
per-track volume, pan, and reverb send, plus device params (kit choice, synth
cutoff and decay). A global key and scale that everything follows; change it and
the bass and melody re-snap so nothing falls out of key. One-tap transforms on
the piano rolls: arp, octave shift, humanize, randomize, clear. Undo and redo
over whole-song snapshots. Per-clip launch modes (loop or one-shot) with
follow-actions.

`ROADMAP.md` has what's next and the performance notes.

## Layout

Vite + Tone.js + vanilla DOM/CSS, no framework.

- `src/model.js` — pure data and music theory. No DOM, no Tone.
- `src/audio.js` — the Tone.js graph and the transport.
- `src/main.js` — all UI and interaction.
- `index.html` — the shell and CSS.

`npm run smoke` drives the built app in headless Chrome (via `puppeteer-core`)
and asserts the core flow, including that the transport actually advances, not
just that the play button lights up.
