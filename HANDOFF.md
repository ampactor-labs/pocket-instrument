# Handoff — Pocket Instrument `[CODENAME: TBD]`

A playful pocket sketchpad for harmony, rhythm, and melody. Seconds to a sound you love, hours of depth when you go looking. The learning is smuggled in through the instrument itself — never a teaching mode, never a quiz, never cheese.

This doc is written for **Claude Code (Opus 4.8)** to run autonomous web research and feel-first prototyping. Read it fully, then follow the operating instructions at the bottom before writing any code.

---

## 0. Who this is for / who's building it

The builder is a pro Ableton user (former professional) and a Rust/DSP engineer who maintains **Sonido**, a Rust DSP framework (kernel architecture — `DspKernel` / `KernelParams` / `KernelAdapter`; targets Daisy Seed / Hothouse and VST3/CLAP via nih-plug). Assume deep DAW and signal-flow fluency. **Do not explain music-production or DSP basics.** The novelty here is product/interaction design and the "learning without a lesson" problem, not audio engineering — that foundation largely exists.

Two concrete use cases anchor everything. These are the acceptance scenarios; if the app doesn't serve both effortlessly, it's wrong:

1. **Couch songwriting.** Writing songs *with and for* a partner, on a phone, on the couch. Zero friction to a first pleasing idea. Both people can play with it. It stays fun.
2. **Instant backing track.** Throw down a drum loop / progression and play it through the room's speakers while jamming on a real instrument. Needs fast looping and tempo sync to the outside world (see Ableton Link, §6).

---

## 1. North star

**The instrument is the lesson.** A well-built instrument *is* theory made tangible. Ableton taught a generation harmony and arrangement with zero lessons — just by making loops triggerable and stackable. So we do not bolt a "learn" layer onto a toy. We make the affordances themselves carry the theory, so nobody ever feels taught.

The whole product lives or dies in the **first 30 seconds cold**. Optimize that loop obsessively; everything else is subordinate.

---

## 2. Design principles (load-bearing — derive features from these, not the reverse)

1. **The instrument is the lesson.** Before adding any explainer, ask whether the *interface* can carry that meaning silently. Prior proof this works: Ableton's *Learning Music* and *Learning Synths* web apps (study them — §5).

2. **Fractal interface, not beginner/pro modes.** One object at every zoom level, more resolution as you descend. A chord is a colored block → pinch → its three voices → pinch → extensions, inversions, voicing. Zoom *is* the difficulty slider: continuous, self-selected, no mode switch. This kills the doomed "simple mode vs advanced mode" split that always condescends to one audience and constrains the other.

3. **Learning is pull, never push.** Names, labels, and the "why" are always one tap/hold away and *never* volunteered. The default surface is beautiful and label-light. Beginner leaves labels on and osmoses; pro dials annotation opacity to zero and it's a clean sequencer. The learning layer is an opacity dial, not a mode.

4. **Can't-make-it-wrong, can-always-go-deeper.** Good defaults make the floor musical (snap to scale, quantize to grid, diatonic-forward palette). But every constraint is a *soft wall you can step through on purpose* (go chromatic, go off-grid, retune). Never a hard rail. The constraint teaches by making the expected thing effortless and the adventurous thing reachable.

5. **Feel over features.** The cold open is the product. If the first sound isn't delightful and the first gesture isn't obvious, no feature saves it.

6. **No gamification.** No streaks, points, badges, XP, mascots that nag. Those are extrinsic crutches that would make this infantilizing for a pro and cheesy for everyone. The only rewards are the music you made and the "oh — *that's* what that's called" moments.

7. **Sketchpad, not walled garden.** It round-trips to the real world: export to Ableton, MIDI out, audio bounce, Ableton Link to the speakers. A sketch you love must be liftable into a real session. This respects the pro and gives the beginner a path upward.

> Anti-cheese guardrail (operationalized): **no** quizzes, grades, "correct/incorrect," blocking tutorials, forced onboarding, "Did you know?" popups, or anything that interrupts flow to instruct. When in doubt, cut the instruction and strengthen the affordance.

---

## 3. The three playgrounds

Each is a can't-make-it-wrong playground with real depth underneath. The affordance is the point; the theory rides along invisibly.

### Harmony — as geometry
Blocks you place and connect. Diatonic chords sit close and reachable; chromatic/borrowed ones require a deliberate reach. Color by harmonic function. When you connect two chords, the **common tones light up** — voice leading becomes something you *see and feel*, not a rule. A beginner grabs pretty adjacent blocks and writes a great progression by accident; the structure did the teaching. Zoom a block → voices → extensions → inversion/voicing.
*Smuggled theory:* function, diatonic vs borrowed, voice leading, extensions, modal color.
*Deep structure to evaluate:* the **Tonnetz** (neo-Riemannian lattice) and **harmonic-table / isomorphic** note layouts as a possible organizing geometry — research whether this is the interface or too much (§5).

### Rhythm — as evenness
Two knobs: **steps** and **pulses**. A Euclidean generator spreads N hits over M steps as evenly as possible, and nearly every groove on earth falls out before you know what one is. Layer multiple Euclidean tracks for interlock/polyrhythm. Swing / microtiming is the depth dial.
*Smuggled theory:* rhythmic evenness, the deep unity of world grooves (E(3,8) = tresillo, E(5,8) = cinquillo, clave-adjacent patterns), polyrhythm, swing-as-microtiming.
*Source to pull from:* Toussaint, "The Euclidean Algorithm Generates Traditional Musical Rhythms."

### Melody — as contour
**Draw the shape first** — the contour you're humming — then quantize to the current scale/harmony, then refine note by note. Contour-first because that's how humans actually conceive a line: shape before pitches. Constrain to scale/chord tones by default; step outside deliberately for tension.
*Smuggled theory:* scale degrees, chord tones vs passing tones, tension/resolution, phrase contour, call-and-response.

---

## 4. The learning layer (how theory / songwriting / the "word" surface without nagging)

- **Names on demand.** Anything you make tells you what it is — chord name, mode, interval, the groove's name — on tap/hold, never volunteered. This is the *primary* theory delivery: retroactive naming of things you built by ear.
- **The "why" is a peek, not a lecture.** One dismissible line, contextual and micro: *"These two chords share two notes — that's why the change feels smooth."* Never a paragraph.
- **Songwriting as gentle scaffold.** Optional song-section/form frame you can ignore; tension-and-release surfaced, never enforced. For lyric scaffolds that aren't formulaic, study **Pat Pattison**-style prosody thinking (§5) rather than fill-in-the-blank templates.
- **The spark card (word-of-the-day, reimagined as a muse).** An **Oblique-Strategies**-style prompt: a real word *with its definition* (so it genuinely teaches a word), maybe an image, maybe a constraint — *"write around this."* Marginal, dismissible, never blocking, never graded, re-rollable anytime. A muse, not a flashcard. This is the highest cheese-risk feature — if it ever grades or blocks, it's dead.

---

## 5. Research agenda (this is the explicit ask — do this first, produce a findings doc)

For each prior-art target, don't just describe it — **extract the specific lesson** and note what to steal / what to avoid. Verify current state on the web; some of these move.

### Prior art — closest to the vision (study hard)
- **Ableton *Learning Music* & *Learning Synths*** (learningmusic.ableton.com / learningsynths.ableton.com) — the single closest existing thing to "theory through play, zero cheese," made by Ableton. *Extract:* how they carry meaning through interaction, pacing, label restraint.
- **Hooktheory (Hookpad + TheoryTab)** — the leading theory-aware songwriting tool. *Extract:* how they visualize harmonic function, scale-degree thinking, borrowed chords, modulation; the real-song progression database.
- **Teenage Engineering** (Pocket Operators, OP-1/OP-Z, EP-133 KO II) — the constraint-as-feature philosophy. *Extract:* how constraint creates delight and depth simultaneously.

### Prior art — adjacent tools (survey what's good/clunky)
- Chord tools: **Chordbot, Suggester, Navichord, Autochords, Scaler**. What's fluid, what's fiddly.
- Playful mobile making: **Koala Sampler** (throw a beat down fast), **Endlesss**, **GarageBand** (the accessible-DAW baseline), **Korg Gadget**, **Novation Circuit** hardware UX.
- Live-coding / generative (the depth end + Euclidean/algorithmic rhythm): **Strudel / Tidal**, **Sonic Pi**, **Orca**, **Gibber**. Strudel is web-based — relevant to §6.
- Spatial/isomorphic layouts: **harmonic-table** note layout, **LinnStrument**, **Lumatone**, **Tonnetz** apps. Is a Tonnetz interface intuitive or overwhelming for a beginner? Decide.

### Design / UX questions
- **Fractal / zoomable UI (ZUI):** prior art for "same object, more resolution on zoom" without confusion. Progressive disclosure done spatially.
- **Onboarding-free design:** how apps get a user to a rewarding moment in <30s with zero tutorial.
- **Anti-gamification:** the critique of streaks/badges/XP and what intrinsic-motivation design looks like instead.

### Music-content questions (what to actually smuggle in)
- Minimal set of harmonic concepts for maximal expressive range (diatonic function → secondary dominants → modal interchange → basic voice leading).
- Mapping modes to color/mood *without* being reductive or cheesy.
- Euclidean rhythm families + swing/microtiming + polyrhythm as the depth layer.
- Non-formulaic songwriting frameworks worth encoding as light scaffolds (Pattison on prosody; section/form; tension-and-release).

---

## 6. Technical exploration (decisions to run, not decide unilaterally — surface tradeoffs back)

The through-line advantage: **it's all Rust.** Sonido's DSP kernels can potentially be reused across mobile (via cross-compilation) and web (via WASM). "Build deeper, not wider" — reuse the audio foundation rather than rewriting it.

### Audio runtime
- State of **Rust → real-time audio on iOS/Android in 2026**: audio-thread story, `cpal` vs platform audio via FFI, glitch-free callback constraints. Can Sonido's kernels compile and run on-device unchanged?
- **Web path:** AudioWorklet + WASM DSP is viable, and the builder has shipped PWAs before (a PixiJS PWA already exists in their world). This is likely the **fastest path to prove the feel** before committing to native.
- Synthesis vs samples: **both.** Synthesis for the pocket-synth identity + existing DSP; samples for drums/backing.

### UI / rendering (for a fluid, animated, touch-first instrument)
Evaluate against "does it make a *fluid, tactile, GPU-smooth* instrument feel," not just "does it render widgets":
- **Rust-native:** **Makepad** (GPU-rendered, built by Ableton-adjacent people specifically for creative tools — evaluate seriously), **Slint**, **Dioxus**, **egui** (likely too utilitarian for this).
- **Web / PWA:** Canvas/WebGL (PixiJS already in the builder's toolkit) + WASM audio. Fastest iteration on *feel*; natural fit for the fractal/animated interface.
- **Native shell + shared Rust core:** platform UI with Rust core via FFI. Most work, best OS integration.

### Round-trip / output (non-negotiable per Principle 7)
- **Ableton Link** — critical for the "backing track through the speakers" scenario (syncs tempo across devices/apps in the room).
- MIDI export, audio bounce, and an export-to-Ableton path (round-trip to the real DAW the builder already lives in).

**Recommendation to pressure-test:** prototype the *feel* in web/Canvas + WASM-or-JS audio first (fastest iteration, known stack), prove the 30-second cold open, then port the validated design to the "real" stack — with Sonido reuse as the long game. Argue for or against this after research.

---

## 7. First milestone (build this, nothing more, until the feel is proven)

The riskiest assumption is **feel**, not architecture. So the first prototype is the **cold-open harmony playground**:

- Colored chord blocks; diatonic ones reachable, function-colored.
- Tapping/placing/connecting adjacent blocks makes a genuinely *pleasing* progression.
- **Common tones light up** on connection — voice leading made visible.
- Fluid, tactile touch feel. Real (even if simple) audio.

**Success criteria:**
1. A non-musician touches it and makes something they like — **with zero instruction** — in under 30 seconds.
2. A pro (the builder) doesn't hit walls immediately and doesn't feel condescended to.
3. It's *fun to fidget with* even with nothing to write.

If it can't clear those, stop and rework the interaction before adding rhythm/melody/learning layers.

---

## 8. Operating instructions for Claude Code

1. **Research before building.** Execute §5, then write `RESEARCH_FINDINGS.md` — per target: the extracted lesson, steal/avoid, and a recommendation. Do not start prototyping until findings exist.
2. **Surface decisions, don't bury them.** Keep `DECISIONS.md` — a running log of forks (platform priority, UI framework, synth/sample balance, Sonido reuse depth, Tonnetz-as-interface yes/no). Flag the load-bearing ones for the builder rather than choosing silently.
3. **Prototype the feel, not the architecture.** §7 first. Fastest-iteration stack for the feel; harden later.
4. **Don't over-build.** No feature that isn't derivable from §2. When tempted to add instruction, strengthen the affordance instead.
5. **Respect the anti-cheese guardrail** (§2 blockquote) in every UI decision.

---

## 9. Open questions to bring back to the builder

- **Naming.** Codename TBD — the builder enjoys this part; leave it to them, but flag when a working name would help.
- **Platform priority:** iOS-first, Android-first, or web/PWA-first for v0?
- **Tonnetz / harmonic-table geometry:** the organizing interface, or too much for the cold open?
- **Synth vs sample balance** for the default sound palette.
- **How much of Sonido** to pull in for v0 vs. a lightweight stub to move fast.
