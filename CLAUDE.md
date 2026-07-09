# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A phone-first music sketchpad for harmony, rhythm, and melody. The first pleasing sound is seconds away, and the depth reveals itself only when you go looking. The bet, in one line: **the instrument is the lesson.** No teaching mode, no quiz, no "learn" tab bolted onto a toy. The affordances themselves carry the theory, so nobody feels taught.

Two acceptance scenarios decide whether any feature belongs. If it doesn't serve both, it's wrong:

1. **Couch songwriting:** writing songs with a partner on a phone, on the couch, zero friction to a first idea both people can play with.
2. **Instant backing track:** throw down a loop and play it through the room's speakers while jamming on a real instrument (needs fast looping and tempo sync to the outside world).

The whole product lives or dies in the **first 30 seconds cold.** That loop is the thing to optimize; everything else is subordinate.

## Repository status

A working prototype now lives at the repo root: a Vite + Tone.js + vanilla DOM/CSS app, phone-first, run with `npm run dev -- --host`. Working today: Session and Arrangement views, four clip editors (chords, drum rack, two piano rolls), a mixer, global key/scale, one-tap transforms, undo/redo, and per-clip launch modes. `ROADMAP.md` tracks what's next and the performance work. The directory name is `noodles`.

The build intentionally took the literal mobile-Ableton road (clip grid, launch-and-loop, direct drag), a pivot the builder chose over the original fractal "cold-open harmony playground" milestone in `HANDOFF.md` §7. Read `AGENTS.md` + `ROADMAP.md` for what the app is today; read `HANDOFF.md` + `DECISIONS.md` for the north star and the reasoning, which still hold (the instrument is the lesson; learning is pull; can't-make-it-wrong). Where surface detail disagrees, the code and `AGENTS.md` win; on *why*, `HANDOFF.md` wins.

## Canonical docs — read order

- **`HANDOFF.md`** — the source of truth. The full brief: who it's for, the north star, the seven design principles, the three playgrounds (harmony/rhythm/melody), the learning layer, the research agenda, the technical forks, the first milestone. Read it whole before proposing anything. It is preserved verbatim as the builder wrote it; don't edit its prose to satisfy a linter.
- **`DECISIONS.md`** — the forks, with reasoning. What's settled (so you don't re-litigate) and what's still open (so you know what needs the builder's call). Every entry records *why*, so it's overturnable, not gospel. Append here whenever a load-bearing fork gets decided.
- **`AGENTS.md`** — the current built app: the four-file architecture, how to run and verify it, the working conventions. Written during the mobile-Ableton build, so it's the doc closest to the code.
- **`ROADMAP.md`** — what works now, what's agreed next, and the on-device performance findings.

## The invariants easiest to violate

`HANDOFF.md` §2 is the full list of principles. These are the ones whose violation quietly wrecks the product:

- **Learning is pull, never push.** Names, labels, the "why": always one tap away, never volunteered. The default surface is beautiful and label-light. The learning layer is an opacity dial, not a mode.
- **Can't-make-it-wrong, can-always-go-deeper.** Defaults make the floor musical (snap to scale, quantize, diatonic-forward). Every constraint is a soft wall you can step through on purpose, never a hard rail.
- **Fractal, not beginner/pro modes.** One object at every zoom level, more resolution as you descend. Zoom is the difficulty slider. Never a "simple mode vs advanced mode" split.
- **No gamification.** No streaks, points, badges, XP, nagging mascots. The only rewards are the music you made and the "oh, *that's* what that's called" moments.

The anti-cheese guardrail, operationalized (§2 blockquote): no quizzes, grades, "correct/incorrect," blocking tutorials, forced onboarding, "did you know" popups, or anything that interrupts flow to instruct. When in doubt, cut the instruction and strengthen the affordance.

## Decisions already made (don't re-litigate)

Full reasoning in `DECISIONS.md`. The short version:

- **v0 is web: JS + Canvas + Web Audio** (Vite + Tone.js, the `celezdial-selekta` lineage). The feel risk is in the gesture layer, not the synth, so prototype in the fastest gesture-iteration stack. **Sonido stays out of v0;** it's the port target once the interaction is validated, not the v0 substrate.
- **Ableton Link forces native eventually.** Link is LAN UDP multicast; a browser can't join a session. Use case 2 (backing track through the speakers) needs a native build or a native Link bridge. Fine for v0, which needs no Link. But that's why web is a v0-feel decision, not the final platform.
- **Tonnetz is a deep zoom layer, never the cold open.** Interval-adjacency makes dissonance too easy, which breaks can't-make-it-wrong for a non-musician. The cold open is function-colored diatonic blocks; the Tonnetz lives inside the harmony playground for voice-leading exploration.
- **The spark card is deferred out of v0.** It's the one feature that pushes content from outside the instrument, against "learning is pull."

## Operating discipline

From `HANDOFF.md` §8:

- **Research before building.** Execute the §5 agenda and write `RESEARCH_FINDINGS.md` (per target: extracted lesson, steal/avoid, recommendation) before prototyping. The builder may waive this for a scrappy feel-prototype; confirm the sequence rather than assuming it.
- **Prototype the feel, not the architecture.** The milestone is the gesture feeling good, not a clean stack. Harden later.
- **Surface decisions, don't bury them.** Load-bearing forks go to the builder and into `DECISIONS.md`, never silently chosen.
- **Don't over-build.** No feature that doesn't derive from §2. When tempted to add instruction, strengthen the affordance instead.

## Reuse assets in the neighborhood

- **Sonido** (`~/Projects/sonido`) — the builder's Rust DSP framework: 15 crates, a `no_std` core, CLAP/VST3 plus Daisy Seed embedded, and a live browser demo (egui + `cpal` compiled to WASM). `sonido-synth` has PolyBLEP oscillators and morphing wavetables. This is the long-game audio foundation; per the v0 decision it's the port target, not the v0 substrate.
- **celezdial-selekta** (`~/Projects/celezdial-selekta`) — a Vite + React + Tone.js web-audio app; the reference for the v0 web-audio stack.

## Commands

Run from the repo root (the app moved up out of `prototype/`, so an old shell sitting in that folder will fail — `cd` back to the root first):

- `npm install` — install dependencies (first run only).
- `npm run dev -- --host` — Vite dev server; open the printed Network URL on a phone.
- `npm run build && npm run preview -- --host` — production build and preview; judge on-device performance here, never on the dev server.
- `npm run smoke` — headless-Chrome smoke test (`puppeteer-core` + a Chrome binary); drives the core flow and asserts the transport actually advances, not just that the play button lights up.

## A note on naming

`noodles` is the repo name. Keep new identifiers aligned with it and avoid reintroducing the old placeholder.
