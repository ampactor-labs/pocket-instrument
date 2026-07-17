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

## Ratified 2026-07-10

### D5 — Automation is clip envelopes: 16-step motion lanes, gesture-recorded

The builder asked for automation (and Ableton warp) without overwhelming the casual user. The call: automation lives per scene per track as `scene.motion[track]` — a param name mapped to 16 values, the same step resolution as every other lane in the app. Capture is a performance, not an editor: arm ● in the Sound sheet, play, ride the XY pad or the amount/motion knobs, and only the params you touched get lanes. Playback schedules the morph ramps at transport time (sample-accurate against the heard beat); a scene with no lanes restores the base patch exactly once. Living in the scene means undo, project files, cloning, and offline render all carry automation for free. Deferred deliberately: send automation (needs a base-restore story against mixer state), lane *editing* UI (a param picker on the existing velocity-lane surface is the natural next step), and breakpoint curves (step lanes match the app's grid idiom; curves are DAW-density).

### D7 — The master gets a maximizer-style soft-knee ceiling

Kick transients were overshooting the limiter by up to +10 dB and hard-clipping at the DAC — an accident that read as "slam" but was really converter crunch. Per the builder's own mastering practice (iZotope maximizer with ~20% soft clip on professional mixes), the chain gains a ceiling stage between the makeup and the limiter: transparent below a -4.4 dBFS knee, tanh-saturating into a 0.98 ceiling above it, with a 0.25 pre-scale so ±4 of true amplitude lands on the shaper's curve instead of its clamped endpoints. Measured after: every master combo peaks at -0.2 dBFS with RMS within half a dB of before. The transient crack is now saturation, not clipping — decided, written down, and revertable by deleting one node.

### D6 — Warp is reframed as the chop deck; true time-stretch waits

Ableton-style warp is phase-vocoder stretching — heavy for the target phone, and worklets render silent inside Tone.Offline, which would break export-matches-app (the BitCrusher lesson). What made warp-era sample work joyful was mostly chopping against the grid, reordering, and repitching — and that maps to a noodles-native **chop deck**: load a WAV, auto-slice at transients or grid divisions, slices land on pads and sequence on the same 16 steps, per-slice repitch via playbackRate (native, cheap, offline-safe). If loops-that-follow-tempo is ever needed, stretch once at import into a pre-rendered buffer rather than in realtime. Agreed order: automation first, chop deck second.

## Ratified 2026-07-16

### D8 — The send returns ride the kick duck

The reverb and echo returns used to land on the master directly, so with a send up the wet
tail filled the exact pocket the kick-sidechain had just carved from the dry mix — measured
at a 2.8 dB median dip where the duck itself is -12 dB. Routing both returns through the
duck bus restores the pump: 10.5 dB median dip on the same probe (pad solo, verb at -8,
four-on-floor kick). This is the bass-music discipline (highpass the returns AND sidechain
them), and it costs nothing when sends are dry, which is the default. Revertable by
repointing two connects at `g.master`.

### D9 — The dice rolls archetypes, and it owns the sends

The global 🎲 used to roll wide timbre over one pattern archetype — same drummer, same
bass player, dry room, every roll. Now a **vibe** is rolled once per song: a groove
archetype (four-floor / backbeat / halftime / 2-step / minimal, each with its own kick
placement, hat grid, velocity personality, tempo band, and pocket range), weighted bass
behaviors, a melody built as a repeated-and-varied motif instead of uniform scatter,
weighted harmony families with rolled length (1/2/4 bars), and spice at low rates
(harmonyOct ±1 at 15%, a 12-step polymeter lane at 10%, a ✨b variation scene at 60% so a
good roll has somewhere to go). The groove hires the kit 60% of the time (808 → halftime,
garage → 2-step). About a third of rolls arrive **wet** — verb on pad and lead, echo on
lead, never bass/drums — which crosses into mix state: the builder called this fork, and
the contract is that the dice owns the *sends* (a dry roll resets them) while faders, pan,
and mutes stay the player's. Wet rolls are safe because the returns are highpassed and
ride the kick duck (D8). The design lesson applied: selection beats processing — roll
from curated archetypes with noise inside, not uniform noise over everything.

### D10 — Two grades, one chain: live plays lighter, exports render full — uniformly

The A16's perf overlay measured the audio thread starving on dense rolls (aud×0.92-0.99
while the main thread held 65-83 fps): the DSP floor, not the UI. Rather than a device
tier (breaks export-matches-app only on weak phones, needs measurement machinery and
mid-play switching), the builder chose a UNIFORM split: buildGraph gains an exportGrade
flag — the live graph runs half a Freeverb (four of its eight combs, same tunings and
dampening, level-matched makeup) and a 4-stage phaser instead of 10, while offline
renders keep the full chain. Everything feel-bearing — master stack, comps, duck,
morphing, levels — is identical in both grades. Measured: dry renders identical to
0.0 dB (a parked return is in neither graph), wet level-matched to 0.3 dB, phase level-
identical, with the live grade ~14% cheaper wet and ~20% cheaper under the phase color.
The invariant softens from "export sounds like the app" to "export sounds like the app,
plus mastering polish" — the same honest sentence on every device, which is the point.

## Ratified 2026-07-17

### D11 — The master gain structure is made honest; D7's ceiling is rebuilt as a real ceiling

A forensic audit (`npm run audit`, the harness added with this work) measured the master applying +19.9 dB of small-signal gain while the constants wrote down +5.5. The missing +14.4 dB came from three stages that hid it: Web Audio mandates an automatic makeup on every DynamicsCompressorNode (measured +5.60 on the glue, +6.41 per melodic input comp, +8.55 on the drum parallel) that no API reports; `tanh(x*1.2)/tanh(1.2)` self-normalized to +3.16 dB; and Tone's Distortion `wet` is an equal-power crossfade of two *coherent* paths, so wet=0.42 summed to +5.59 dB, not a 42% blend. That phantom gain is what justified a -20 dB threshold and parked the program on the ceiling at -4.8 LUFS with a crest of 6.3 — past the loudness-war line, no dynamic variety left. D7's ceiling wasn't a safety net; with +14 dB shoved through it, it was the main gain stage, taking -4.9 dB of crest in one pass.

The fix is structural, not cosmetic: every stage is unity at the origin by construction, and the only things that move the level are three constants that say a number out loud (bus trim, glue drive, ceiling drive). The spec makeup is measured and subtracted (`makeComp`); the saturation is our own curve with a real dry/wet mix and unity origin slope; the crossfade sums to unity. D7's `Tone.Limiter(-2)` is deleted — it was a Compressor with Tone's default 30 dB knee, a "limiter" whose knee spanned -17..+13 dBFS, contributing 0.02 dB for a 6 ms lookahead. The ceiling is now un-oversampled on purpose: a memoryless curve's own bound IS the sample-peak guarantee only when it isn't oversampled (a 4x clamp's reconstruction filter rings past the clamp — measured +0.27 dBFS out of a 0.78 curve), so the guarantee is arithmetic and CEIL carries true-peak headroom for the Bluetooth codecs of use case 2.

Four more findings in the same audit, all fixed and measured: (1) the app was mono — `Tone.Channel` defaults channelCount to 1 and its Panner forces channelCountMode "explicit", downmixing every track at the fader while the chorus/phaser/tremolo paid full CPU upstream for width that was summed away; set to 2. (2) The drum dry and parallel buses summed 6 ms apart (a compressor lookahead), a comb with its first null at 83 Hz straight through the kick — every bus is now delay-aligned to the 6.02 ms lookahead and the kick duck is scheduled against it. (3) The morph crossfade used equal-power weights on same-pitch, phase-locked layers that sum coherently, so the pad midpoint ran +3 dB hot; linear weights (which renormalize to unity amplitude) fix it, and the sample drum bank keeps equal power because its layers share only an onset, not a waveform. (4) The low-shelf-into-saturation trick for phone bass needed asymmetry to make the octave-up 2nd harmonic (tanh is odd, makes odd harmonics only); an asymmetric curve now does, with the DC it rectifies blocked *after* the saturation so the intended harmonic doesn't cancel against the symmetric stages downstream.

Measured end state (npm run audit): true peak from +5.1 to under 0 dBTP across the dice space, LUFS-I centered -10.3 (Ian Shepherd's measurements of the app's own references: Radiohead -9.9, Drake -10.2), crest recovered from 6.3 to ~9, per-stage gain model closing to 0.01 dB. The calibrate gate is re-baselined: stems now read wider because they pass mostly linear instead of through a 0.1 dB/dB squash — the ceiling was hiding the spreads, not holding them — while the full-mix master spread stays ~1 dB, which is the property the randomizer actually needs. Reverting is deleting the drive constants and restoring the old nodes; the audit harness stays regardless, because the whole lesson is that a chain you can't measure lies to you.

Left as an open fork, deliberately not chosen: the context sample rate. The `createAudio` comment claimed for a long time that it pinned 44100 to play the drum one-shots bit-exact and save ~8% DSP on 48 k phones, and it never did — `Tone.Context` takes no sampleRate option, so the option was accepted and dropped, and the app runs at the hardware's 48 k. Pinning it for real means constructing a native `AudioContext({sampleRate})` and handing it to Tone, which steps outside the standardized-audio-context wrapper Tone leans on for cross-browser param behaviour. That's a live tradeoff for the builder, not an oversight to paper over; the comment now says what the code does.

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
