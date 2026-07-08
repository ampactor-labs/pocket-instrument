# Research findings

The §5 agenda, run 2026-07-08, weighted toward what shapes the harmony cold-open (the v0 milestone). Rhythm and melody targets are covered lighter because they belong to later milestones. Format per target: the lesson, what to steal, what to avoid, and the call.

The short version, turned into build decisions, is at the bottom (§ "What the prototype takes"). Read that if nothing else.

## Study-hard tier

### Ableton — Learning Music / Learning Synths

**Lesson.** The whole thing teaches by letting you tap boxes on and off, hear the result loop immediately, and discover the combinations you like. No lesson gate, no quiz. The chrome is close to nothing; one concept per screen; a live export bridge to Ableton Live at the end so the sketch isn't trapped. It taught a generation harmony the same way Live itself did: make the musical unit triggerable and loopable, and let the ear do the learning.

**Steal.** The loop-is-always-playing model. Sound before instruction. You should hear music within one tap, and every change you make is audible on the next pass of the loop. That immediacy is the teacher.

**Steal.** One concept per surface. The cold-open is harmony only — no rhythm, melody, or learning layer competing for the first 30 seconds.

**Avoid.** Their aesthetic is deliberately flat and neutral (it reads as "educational software"). We want the opposite surface feel — tactile, warm, something you *want* to touch (see Teenage Engineering). Same interaction spine, different skin.

**Call.** This is the closest prior art to the north star and the model for the cold-open interaction. Adopt the loop-and-tap spine wholesale; reskin for delight.

### Hooktheory — Hookpad / TheoryTab

**Lesson.** Hookpad colors by *scale degree*, key-agnostic: 1–7 (and the chords I, ii, iii, IV, V, vi, vii°) map to red, orange, yellow, green, blue, purple, pink in major. Change key and the colors cycle so the *relationships* stay constant. The point is that color = harmonic role, and the role is what transfers between songs and keys — not the letter name.

**Steal.** Color is the primary carrier of harmonic meaning, and it must be *consistent* so the color becomes the name you learn by osmosis. This is the mechanism behind "the affordance carries the theory."

**Adapt, don't copy.** Hooktheory colors by scale degree (7 distinct hues). The handoff asks for color by *function* (tonic / subdominant / dominant — 3 families). Function coloring is the better cold-open read, because it shows the *pull*: three families a beginner can feel (home / leaving / tension-wanting-home), so home→away→tension→home falls out by grabbing colors in an arc. Resolution: hue encodes function family, lightness varies within the family so all seven chords stay individually distinguishable. Best of both — family legible at a glance, per-chord identity on a closer look.

**Avoid.** Their surface is dense (piano-roll + Roman numerals + scale-degree guides all at once). That density is right for their audience (songwriters studying) and wrong for ours in the first 30 seconds. Names stay hidden until tapped.

**Call.** Function-family color, consistent across keys, is the core visual grammar of the harmony playground.

### Teenage Engineering — OP-1 / Pocket Operators

**Lesson.** Constraint is the product. Their hardest design work was *removing* features, not adding them. The OP/PO series was engineered down to a $49 price and a bare board, and the Good Design Award citation nailed the effect: the functions aren't immediately clear, but the format "inspires a desire to press the buttons." The delight is in the wanting-to-touch.

**Steal.** The floor is a fixed, curated palette (the seven diatonic chords), not an open field. Constraint is what makes it can't-make-it-wrong. And the surface has to invite the first press — big, tactile, responsive targets that pop when you hit them.

**Steal.** The default sound is not a placeholder. A PO sounds good the instant you turn it on. Our v0 needs one deliberately gorgeous voice (see DECISIONS P2), because perfect harmony through an ugly patch still fails the 30-second test.

**Avoid.** Their opacity (cryptic labels, hidden modes) is a deliberate choice for a hardware toy you live with for months. We can't be cryptic in the first 30 seconds — the affordance has to be obvious even as the theory stays hidden.

**Call.** Curated-palette-as-floor and press-invites-delight are load-bearing. The voice is a first-class design object, not a TODO.

## Adjacent tools

### Voice-leading / chord tools (Chord Progressor, IMTL, ChordLab, ToneGym)

**Lesson.** The good ones make voice leading *visible* and use it to suggest the next chord. Chord Progressor is built on the neo-Riemannian P/R/L moves — Parallel, Relative, Leading-tone-exchange — where each move changes exactly one note, which is the mathematical definition of smoothest voice leading. That single shared-note idea is the whole common-tone mechanic the handoff calls for.

**Steal.** When two chords sit next to each other, light the pitch classes they share. Two diatonic triads share 0, 1, or 2 notes; the more they share, the smoother the change *sounds*, and now you can *see* why. That is voice leading taught without the word "voice leading."

**Steal (audio).** Voice each chord to keep common tones in place and move the rest by the smallest step. It makes the loop noticeably more pleasing than root-position triads jumping around, and it makes the audio agree with the lit-up common tones.

**Avoid.** Most of these tools are analysis-first — you build a progression to study it. We are play-first — you play, and the analysis (names, why-it's-smooth) is available on demand, never volunteered.

**Call.** Common-tone lighting + a small nearest-voicing voicer are both in v0. This is the harmony playground's signature move.

### Playful mobile making (Koala, Endlesss, GarageBand, Korg Gadget)

**Lesson.** The fast-to-a-loop ones (Koala especially) win on immediacy: throw something down, hear it loop, layer. The DAW-shaped ones (GarageBand, Gadget) are powerful but have a cold start — you face an empty session.

**Steal.** No empty session. Open into something already musical (a default progression already looping), then let the play be *modifying* it, not building from zero. This is the strongest possible cold open: music before the first deliberate choice.

**Call.** v0 opens mid-loop, not on a blank canvas.

### Live-coding / generative (Strudel, Sonic Pi, Orca, Tidal)

**Lesson.** These are the depth end — text/code as the interface, enormous ceiling, steep floor. Strudel matters technically: it's a mature web-audio system (Web Audio + AudioWorklet) proving the browser can carry real generative audio.

**Steal.** Nothing for the cold-open interface (code is the opposite of tactile). But Strudel is a reassurance that the web audio path has headroom for the rhythm/generative layer later.

**Avoid.** Text-as-interface for anything in the first-touch path.

### Isomorphic / Tonnetz layouts (harmonic table, LinnStrument, Lumatone)

**Lesson.** Beautiful, deep, and organized by interval geometry — which is exactly why they reward people who already think in intervals and punish those who don't. On a Tonnetz, adjacency is by third/fifth, so it is *easy* to land on dissonance, and easy = wrong for a non-musician.

**Call (confirms DECISIONS D3).** Tonnetz is a deep zoom layer for voice-leading exploration, never the cold-open interface. The cold open is function-colored blocks where "next to" means "sounds good next," not "an interval away."

## Design / UX questions

### Zoomable UI / semantic zoom (Pad++, Raskin's Archy)

**Lesson.** The real ZUI idea (Pad++, Perlin/Hollan/Bederson; Raskin's *The Humane Interface*) is *semantic* zoom: an object's representation *changes* with scale rather than just resizing. At a distance a paragraph is a title; closer, an abstract; closer still, full text with annotations — detail fading in through transparency ranges as you approach.

**Steal.** This is the blueprint for the deferred fractal interface (DECISIONS P3). A chord block far out is a single colored shape; pinch in and it *becomes* its three voices; further in, extensions and voicing. Detail fades in by opacity, exactly the Pad++ transition. Build the flat block first, but design it knowing the zoom is semantic, not a resize.

**Avoid.** Zoom that only scales (a magnifier) — it adds no information and disorients. If a zoom level doesn't change *what* you see, it isn't a level.

### Onboarding-free / time-to-first-value

**Lesson.** The data backs the north star hard: three-step flows complete at 72%, seven-step at 16%. Let the user do something meaningful in the first 30 seconds. Introduce one concept at a time. The "aha" is when they first feel the value themselves, not when they're told it.

**Steal.** Zero tutorial. The only instruction tolerable is a single faint "tap to begin" (forced by the browser's audio-autoplay policy, so we might as well make it the one gesture that starts the music). After that, discovery only.

**Call.** No onboarding. First tap starts audio and the loop; everything else is learned by touching.

### Anti-gamification

**Lesson.** The research is blunt: extrinsic rewards (points, badges, streaks) *crowd out* intrinsic motivation — when the reward stops, so does the behavior. Duolingo-style streaks are widely read as guilt/manipulation. The alternative ("gamification 2.0") is to make the experience itself the reward.

**Steal.** Nothing to add — this is a *don't*. It confirms Principle 6 as a hard line: no streaks, points, badges, XP, progress bars toward mastery. The reward is the music you made and the naming moments.

**Call.** Principle 6 is non-negotiable, and the research says so empirically.

## Music-content questions

### Minimal harmonic concept set

The smallest set that buys the most range, in the order the fractal zoom should reveal it:

1. **Diatonic function** (cold-open): the seven triads of one major scale, colored by tonic / subdominant / dominant. Enough to write most pop/folk progressions.
2. **Voice leading** (cold-open, visual): common tones between adjacent chords. The glue.
3. **Modal color / borrowed chords** (zoom level 2): a few borrowed chords (bVII, iv, bVI) reachable by a deliberate "reach" past the diatonic set — the soft wall you step through.
4. **Secondary dominants** (zoom level 3): V/x, the first taste of chromatic tension with a clear pull.
5. **Extensions / inversions / voicing** (deepest zoom): 7ths, 9ths, slash chords, the block's inner voices.

v0 ships level 1 + 2. The rest are the depth the zoom reveals, sequenced.

### Mode-to-color / mood

**Lesson + caution.** Mapping modes to mood-color (dorian = wistful, phrygian = dark) is seductive and reductive — it's the highest cheese risk in the visual language. Keep color tied to *structural* meaning (function, scale degree) where it's true, not to *emotional* labels where it's a horoscope. If mood-color appears at all, it's a deep, optional tint, never a claim the surface makes.

**Call.** Color encodes function in v0. No mood-color.

### Euclidean rhythm (later milestone — surveyed, not built)

**Lesson.** Bjorklund's algorithm spreads k onsets over n steps as evenly as possible, and the results are the grooves of the world: E(3,8) is the tresillo / habanera (also on the atoke bell in Ewe music from Ghana), E(5,8) is the Cuban cinquillo. Two knobs (steps, pulses) generate a huge, musical space; swing/microtiming is the depth dial; layering tracks gives polyrhythm. Toussaint's paper is the canonical source; Bjorklund's algorithm is short and well-documented (brianhouse/bjorklund).

**Call.** Confirmed for the rhythm playground. Two-knob Euclidean generator, swing as the depth dial, layer for polyrhythm. Not in v0.

## What the prototype takes (the build spec)

The harmony cold-open, grounded in the above:

1. **Opens mid-loop.** First tap starts audio and a default progression already looping (I–V–vi–IV, the four chords that carry half of pop). Music before any deliberate choice. (Koala / Ableton / onboarding research.)
2. **Seven diatonic chord pads**, colored by function family — tonic greens, subdominant blues, dominant ambers — lightness varied so each is distinct. Big, thumb-reachable, they pop when pressed. (Hooktheory adapted / Teenage Engineering.)
3. **A looping progression lane** the playhead sweeps. Tap a slot to arm and audition it; tap a pad to drop that chord into the armed slot; hear it on the next pass. Auditioning a pad with nothing armed just previews the sound. (Ableton loop-and-tap.)
4. **Common tones light up** between adjacent lane chords — shared pitch classes glow, a thread connects them. Voice leading made visible. (Neo-Riemannian.)
5. **Nearest voicing** in the audio: keep common tones, move the rest by the smallest step, so the loop sounds smooth and the audio agrees with the lit notes.
6. **One warm voice** — a soft, slightly-detuned pad with reverb and a touch of chorus, chosen to be lovable on the first chord. (Teenage Engineering / DECISIONS P2.)
7. **No labels by default.** Chord name (Roman numeral + name) appears only on tap and fades. The learning layer is an opacity dial, off by default. (Pull-not-push / onboarding research.)
8. **Can't-make-it-wrong.** All seven are diatonic, so any sequence is musical. The floor is the constraint. (Teenage Engineering.)
9. **Built flat, designed for semantic zoom.** The block is one shape now; the architecture assumes it will *become* its voices on pinch later. (Pad++.)

## Sources

- Ableton Learning Music — https://learningmusic.ableton.com/ ; playground — https://learningmusic.ableton.com/the-playground.html
- Hooktheory Hookpad — https://www.hooktheory.com/hookpad ; scale-degree reference — https://www.hooktheory.com/support/musicreference?concept=music-concepts-scale-degree
- Teenage Engineering OP-1 / Pocket Operators — https://teenage.engineering/products/po ; history — https://happymag.tv/a-wall-of-sound-in-your-pocket-the-tale-of-teenage-engineerings-pocket-operator/
- Chord Progressor (neo-Riemannian P/R/L) — https://chordprogressor.com/ ; Interactive Music Theory Lab — https://imtl.net/
- Pad++ (Bederson/Hollan) — https://worrydream.com/refs/Hollan_1995_-_Pad++.pdf ; Zooming UI — https://en.wikipedia.org/wiki/Zooming_user_interface
- Onboarding / time-to-value — https://www.appcues.com/blog/aha-moment-guide ; https://thisisglance.com/blog/the-art-of-app-onboarding-how-to-hook-users-in-30-seconds
- Anti-gamification — http://gamification-research.org/2014/08/gamification-considered-harmful/ ; https://uxmag.com/articles/gamification-2-0-beyond-points-and-badges-designing-for-players-not-metrics-chapter-1-the-problem
- Euclidean rhythm — Toussaint, "The Euclidean Algorithm Generates Traditional Musical Rhythms" https://cgm.cs.mcgill.ca/~godfried/publications/banff.pdf ; Bjorklund impl — https://github.com/brianhouse/bjorklund
