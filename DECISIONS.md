# Decisions

Running log of the forks the handoff (§8.2) says to surface rather than bury. Each entry is a *provisional* call — the reasoning is here so the builder can overturn it, not just read a verdict. Ratified means "we talked it through and agreed"; provisional means "my recommendation, not yet argued against."

## Ratified 2026-07-08

### D1 — Ableton Link forces native (or a native bridge) eventually

Link is UDP multicast on the LAN. A sandboxed browser cannot join a Link session — no PWA, no exception. So use case 2 (backing track through the room speakers, synced to a real instrument) is structurally unavailable on the web path.

This does not block v0: the harmony cold-open needs no Link. But it settles part of the long-game platform question in advance — the build that serves use case 2 has to be native, or ship a small native Link helper the web app talks to. Recorded now so it is a chosen constraint, not a surprise found at port time.

### D2 — v0 stack is JS + Canvas + Web Audio; Sonido stays out of v0

The riskiest assumption is feel (handoff §7), and the feel risk lives almost entirely in the touch/gesture/animation layer, not the synth. So prototype in the stack that iterates fastest on gesture: Canvas (Pixi or raw) plus Web Audio, the `celezdial-selekta` lineage already in the repo neighborhood (Vite + Tone.js).

Reusing Sonido in v0 would couple the one variable we are trying to isolate (does the gesture feel good) to two unproven-for-this-purpose decisions: the Rust/WASM toolchain for the UI, and a GPU-tactile Rust UI framework (egui is wrong for a tactile instrument — it is immediate-mode and utilitarian; Makepad is plausible but unproven in our hands). Stack those later. Sonido is the port target once the interaction is validated, not the v0 substrate.

Note: Sonido already compiles to WASM and runs in a browser today (the live node-graph demo uses egui + `cpal` with the wasm-bindgen feature), so the reuse path is real — just not the fastest path to prove feel.

### D3 — Tonnetz is a deep zoom layer, never the cold-open interface

A Tonnetz orders adjacency by interval geometry, which is exactly what makes it easy to land somewhere dissonant. That violates Principle 4 (can't-make-it-wrong) for the non-musician on the couch — it rewards people who already think in intervals. So the cold-open surface is function-colored diatonic blocks where "next to" means "sounds good next," and the Tonnetz lives inside the harmony playground as something you pinch down into for voice-leading exploration. This is the handoff's own "deep structure to evaluate" placed at the right depth.

### D4 — The spark card is deferred out of v0

It is the one feature that fights the north star: a word-with-definition card is content arriving from outside the instrument, which is a push, and Principle 3 is "learning is pull, never push." The handoff already flags it as highest cheese-risk. It is also nowhere near the cold-open milestone. Cut from v0; revisit only if the instrument itself proves it needs a muse.

## Provisional (my recommendation, argue against it)

### P1 — Use case 1 leads v0; the cold-open harmony playground is the whole first milestone

Reading §7 straight: the couch-songwriting cold open is the milestone, the backing-track/Link scenario is phase two. Confirm this is the priority order before the research pass sets its emphasis.

### P2 — The v0 default voice is one deliberately chosen, instantly-lovable patch

§7 criterion 1 ("makes something they like in 30s") depends as much on timbre as on harmony. Perfect voice leading through an ugly patch fails the test. So v0 needs one gorgeous default voice — a soft, warm, slightly-detuned pad/keys in the Teenage Engineering register — chosen with the same care as the interaction, not filed under "audio: both, TBD." A curated sample or a hand-rolled Tone.js poly-synth can nail it; this is also the one place a small Sonido WASM voice could earn its way into v0.

### P3 — The fractal zoom is deferred behind a flat v0

Pinch-into-a-chord is a novel gesture and the product's signature bet, but §7 correctly scopes v0 to flat blocks plus common-tone lighting. Prove the flat playground is delightful before committing the whole product to the zoom metaphor. If flat blocks already clear the 30-second test, the zoom is upside, not load-bearing.

## Still open (from handoff §9)

- **Naming.** The repo is now named `noodles`. Keep the codebase and docs aligned with that name.
- **Platform priority for the eventual native build:** iOS-first vs Android-first (web-first is settled for v0 per D2).
- **Synth vs sample balance** for the full sound palette beyond the v0 default voice (P2).
- **How much of Sonido** to pull in for the native port (D2 keeps it out of v0; the port depth is undecided).
