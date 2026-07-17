// Master-chain forensics: measure what the signal chain actually does, as
// opposed to what its constants say it does.
//
// Everything here renders through the REAL graph (buildGraph in src/audio.js —
// the same one the live app and the WAV export use), so a number printed here
// is a number the app produces. Offline renders are deterministic: repeat runs
// agree to 0.00 dB.
//
// What it measures and why each section exists:
//
//   meters   Self-test. BS.1770-4 defines a calibration signal, and a meter
//            that misses it is a confident liar. Read this row first.
//   comps    Per-config makeup gain and lookahead latency of every
//            DynamicsCompressorNode in the graph. Web Audio mandates an
//            automatic makeup that no API reports; the lookahead is why
//            parallel paths comb. Both are invisible in the source.
//   chain    Small-signal gain and the level-dependent slope of the master.
//            The gap between this and the constants is the gain nobody wrote.
//   harm     Harmonic series of a 60 Hz tone. The low shelf sits before the
//            saturation so a small speaker hears bass it can't reproduce; that
//            works only if the 2nd harmonic exists, which needs an ASYMMETRIC
//            curve. tanh is odd and makes odd harmonics only.
//   align    Path latency of every bus that sums into the master, measured by
//            impulse. Anything unequal is a comb filter.
//   width    L/R correlation. 1.000 means the app is mono and every stereo
//            effect upstream is burning CPU to be summed away.
//   morph    The crossfade law in isolation, on bare layers with no lane
//            filters in the way: same pitch, phase-locked, so they sum
//            coherently and equal-power weights overshoot.
//   program  LUFS-I / true peak / crest / PLR on real renders. The verdict.
//
// Usage: npm run audit            (full sweep)
//        npm run audit -- --quick (skip the dice section)

import { startPreview, openApp } from "./preview.mjs";

const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const host = process.env.SMOKE_HOST || "127.0.0.1";
const port = Number(process.env.SMOKE_PORT || 4175);
const url = `http://${host}:${port}/noodles/`;
const quick = process.argv.includes("--quick");
// --program renders only the meter self-test and the verdict metrics: the loop
// you want while tuning a gain constant against a LUFS target.
const programOnly = process.argv.includes("--program");

const preview = startPreview({ host, port });
let browser;
try {
  await preview.ready();
  const app = await openApp({ chrome, url });
  browser = app.browser;
  const { page, errors } = app;

  const report = await page.evaluate(async (quick, programOnly) => {
    const Tone = window.__noodlesTone;
    const buildGraph = window.__noodlesGraph;
    const { song, audio, applyProject } = window.__noodles;
    const db = (x) => 20 * Math.log10(Math.max(Math.abs(x), 1e-12));
    const r2 = (x) => Math.round(x * 100) / 100;
    const r3 = (x) => Math.round(x * 1000) / 1000;

    // ---------------------------------------------------------------
    // Meters
    // ---------------------------------------------------------------

    // ITU-R BS.1770-4 K-weighting, derived for the buffer's own sample rate
    // (the spec tabulates coefficients at 48 k only; our renders are 44.1 k).
    // Same analog prototype, bilinear-transformed per RBJ.
    function kWeightCoeffs(sr) {
      const shelfF = 1681.9744509555319;
      const shelfG = 3.999843853973347;
      const shelfQ = 0.7071752369554196;
      const K = Math.tan((Math.PI * shelfF) / sr);
      const Vh = Math.pow(10, shelfG / 20);
      const Vb = Math.pow(Vh, 0.499666774155);
      const d0 = 1 + K / shelfQ + K * K;
      const shelf = {
        b: [(Vh + (Vb * K) / shelfQ + K * K) / d0, (2 * (K * K - Vh)) / d0, (Vh - (Vb * K) / shelfQ + K * K) / d0],
        a: [1, (2 * (K * K - 1)) / d0, (1 - K / shelfQ + K * K) / d0],
      };
      const hpF = 38.13547087602444;
      const hpQ = 0.5003270373238773;
      const Kh = Math.tan((Math.PI * hpF) / sr);
      const dh = 1 + Kh / hpQ + Kh * Kh;
      const hp = { b: [1, -2, 1], a: [1, (2 * (Kh * Kh - 1)) / dh, (1 - Kh / hpQ + Kh * Kh) / dh] };
      return [shelf, hp];
    }

    function biquad(x, { b, a }) {
      const y = new Float64Array(x.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < x.length; i++) {
        const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
        x2 = x1; x1 = x[i];
        y2 = y1; y1 = v;
        y[i] = v;
      }
      return y;
    }

    // Gated integrated loudness + the short-term series (3 s window, 100 ms
    // hop) that PSR needs.
    function loudness(chans, sr, n) {
      const stages = kWeightCoeffs(sr);
      const k = chans.map((c) => stages.reduce((d, st) => biquad(d, st), Float64Array.from(c)));
      // Mean square over a block, summed across channels (G = 1.0 for L/R).
      const blockMs = (startSec, lenSec) => {
        const s = Math.floor(startSec * sr);
        const e = Math.min(n, s + Math.floor(lenSec * sr));
        if (e - s < 1) return 0;
        let acc = 0;
        for (const d of k) {
          let sum = 0;
          for (let i = s; i < e; i++) sum += d[i] * d[i];
          acc += sum / (e - s);
        }
        return acc;
      };
      const lufs = (ms) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));

      // Integrated: 400 ms blocks, 75% overlap, absolute gate then relative.
      const blocks = [];
      for (let t = 0; t + 0.4 <= n / sr + 1e-9; t += 0.1) blocks.push(blockMs(t, 0.4));
      const absKept = blocks.filter((m) => lufs(m) > -70);
      let integrated = -Infinity;
      if (absKept.length) {
        const relGate = lufs(absKept.reduce((s, m) => s + m, 0) / absKept.length) - 10;
        const kept = absKept.filter((m) => lufs(m) > relGate);
        if (kept.length) integrated = lufs(kept.reduce((s, m) => s + m, 0) / kept.length);
      }

      // Short-term: 3 s window, 100 ms hop; falls back to the whole buffer when
      // the render is shorter than one window.
      const shortTerm = [];
      const win = Math.min(3, n / sr);
      for (let t = 0; t + win <= n / sr + 1e-9; t += 0.1) shortTerm.push({ t, lufs: lufs(blockMs(t, win)) });
      return { integrated, shortTerm, win };
    }

    // Oversampled true peak (BS.1770-4 Annex 2 in spirit): zero-stuff by L,
    // Kaiser-windowed sinc interpolator, evaluated polyphase so the zeros cost
    // nothing. Sample peak hides inter-sample overs; every lossy codec in the
    // Bluetooth path reconstructs them and clips what's over.
    //
    // 8x, not the standard's 4x, and Kaiser, not Blackman — both for accuracy
    // this chain actually needs. Oversampling by L only evaluates the
    // reconstruction at L points per sample, so the true peak can hide between
    // them: at 4x a sine at fs/4 is sampled every 22.5 degrees, and the nearest
    // point can sit 11.25 degrees off the crest — cos(11.25) = -0.17 dB, a
    // floor no filter length fixes because it isn't the filter. 8x halves the
    // grid error to 0.04 dB. The Kaiser is for the other end: a 96-tap Blackman
    // droops 0.24 dB at 0.45*fs, which is exactly where a white-noise snare
    // lives, so it under-reads the overs that matter most. Under-reading a true
    // peak is the unsafe direction; measured worst-case error here is 0.13 dB.
    const TP_L = 8, TP_M = 192, TP_P = TP_M / TP_L;
    const tpPhases = (() => {
      const bessel0 = (x) => {
        let s = 1, t = 1;
        for (let k = 1; k < 60; k++) {
          t *= Math.pow(x / (2 * k), 2);
          s += t;
          if (t < 1e-15 * s) break;
        }
        return s;
      };
      const beta = 12;
      const h = new Float64Array(TP_M);
      for (let i = 0; i < TP_M; i++) {
        const x = (1 / TP_L) * (i - (TP_M - 1) / 2);
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const w = bessel0(beta * Math.sqrt(1 - Math.pow((2 * i) / (TP_M - 1) - 1, 2))) / bessel0(beta);
        h[i] = (1 / TP_L) * sinc * w;
      }
      // Normalize EACH PHASE to sum to 1, not the whole filter to L: that is
      // what makes every phase reconstruct DC to itself instead of only the
      // ensemble averaging out to right.
      return Array.from({ length: TP_L }, (_, p) => {
        const sub = new Float64Array(TP_P);
        let sum = 0;
        for (let m = 0; m < TP_P; m++) {
          sub[m] = h[m * TP_L + p];
          sum += sub[m];
        }
        for (let m = 0; m < TP_P; m++) sub[m] /= sum;
        return sub;
      });
    })();

    function truePeak(chans, from = 0, to = Infinity) {
      let peak = 0;
      for (const d of chans) {
        const lo = Math.max(0, Math.floor(from));
        const hi = Math.min(d.length, Math.ceil(to));
        for (let i = lo; i < hi; i++) {
          for (let p = 0; p < TP_L; p++) {
            const sub = tpPhases[p];
            let acc = 0;
            for (let m = 0; m < TP_P; m++) {
              const idx = i - m;
              if (idx >= 0) acc += sub[m] * d[idx];
            }
            const a = Math.abs(acc);
            if (a > peak) peak = a;
          }
        }
      }
      return peak;
    }

    const channelsOf = (buf) => Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));

    // The verdict block for one rendered buffer.
    function program(buf) {
      const chans = channelsOf(buf);
      let peak = 0, sumSq = 0, count = 0;
      for (const d of chans) {
        for (let i = 0; i < d.length; i++) {
          const a = Math.abs(d[i]);
          if (a > peak) peak = a;
          sumSq += d[i] * d[i];
          count++;
        }
      }
      const rms = Math.sqrt(sumSq / count);
      const { integrated, shortTerm, win } = loudness(chans, buf.sampleRate, buf.length);
      const tpDb = db(truePeak(chans));
      // PSR at the loudest moment: true peak inside the window minus the
      // window's short-term loudness (MeterPlugs' definition).
      let psr = 0;
      if (shortTerm.length) {
        const loudest = shortTerm.reduce((a, b) => (b.lufs > a.lufs ? b : a));
        const s = Math.floor(loudest.t * buf.sampleRate);
        psr = db(truePeak(chans, s, s + Math.floor(win * buf.sampleRate))) - loudest.lufs;
      }
      return {
        lufs: r2(integrated),
        peak: r2(db(peak)),
        tp: r2(tpDb),
        crest: r2(db(peak) - db(rms)),
        plr: r2(tpDb - integrated),
        psr: r2(psr),
      };
    }

    // L/R correlation and the side/mid ratio. corr 1.000 = mono.
    function width(buf) {
      if (buf.numberOfChannels < 2) return { corr: 1, sideDb: -99 };
      const [L, R] = channelsOf(buf);
      let ll = 0, rr = 0, lr = 0, mid = 0, side = 0;
      for (let i = 0; i < L.length; i++) {
        ll += L[i] * L[i];
        rr += R[i] * R[i];
        lr += L[i] * R[i];
        const m = (L[i] + R[i]) / 2, s = (L[i] - R[i]) / 2;
        mid += m * m;
        side += s * s;
      }
      const denom = Math.sqrt(ll * rr);
      return {
        corr: r3(denom > 1e-12 ? lr / denom : 1),
        sideDb: r2(db(Math.sqrt(side / L.length)) - db(Math.sqrt(mid / L.length))),
      };
    }

    // Goertzel magnitude at one frequency over an integer number of periods.
    function toneMag(d, f0, sr, from, len) {
      const w = (2 * Math.PI * f0) / sr;
      const cw = Math.cos(w), sw = Math.sin(w);
      const coeff = 2 * cw;
      let s1 = 0, s2 = 0;
      for (let i = from; i < from + len; i++) {
        const s0 = d[i] + coeff * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const re = s1 - s2 * cw;
      const im = s2 * sw;
      return (2 * Math.sqrt(re * re + im * im)) / len;
    }

    // Steady-state RMS over the tail of a render (past every attack/release).
    function tailRms(buf, tailSec = 0.5) {
      const sr = buf.sampleRate;
      const s = Math.max(0, buf.length - Math.floor(tailSec * sr));
      let sum = 0, count = 0;
      for (const d of channelsOf(buf)) {
        for (let i = s; i < buf.length; i++) { sum += d[i] * d[i]; count++; }
      }
      return Math.sqrt(sum / count);
    }

    // First sample above the noise floor. Every path into the master should
    // report the same number.
    function onset(buf) {
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > 1e-6) return i;
      return -1;
    }

    const out = {};
    out.rate = Tone.getContext().sampleRate;

    // ---------------------------------------------------------------
    // Meter self-test, before any of its numbers get believed.
    // ---------------------------------------------------------------
    {
      // BS.1770-4: "a 0 dB FS 997 Hz sine wave applied to the left, centre or
      // right channel gives a reading of -3.01 LKFS".
      const buf = await Tone.Offline(() => {
        const merge = new Tone.Merge().toDestination();
        const osc = new Tone.Oscillator(997, "sine");
        osc.connect(merge, 0, 0);
        osc.start(0);
      }, 4);
      const chans = channelsOf(buf);
      const { integrated } = loudness(chans, buf.sampleRate, buf.length);
      out.meters = {
        "BS.1770 997Hz 0dBFS one channel": { got: r2(integrated), want: -3.01 },
        // A full-scale sine is its own true peak: no ISP to find, so a meter
        // reading much over 0 here is inventing overs.
        "true peak of a 0 dBFS 997 Hz sine": { got: r2(db(truePeak(chans))), want: 0.0 },
      };
    }
    {
      // The test that actually exercises the interpolator. A full-scale sine at
      // exactly fs/4, offset 45 degrees, samples at +/-0.707 forever: sample
      // peak -3.01, true peak 0.00, and the 3.01 dB between them is entirely
      // between the samples. The 997 Hz rows above pass on a meter that does no
      // interpolation at all, so they prove nothing about near-Nyquist content —
      // which is the only kind that generates real overs.
      //
      // The tone is faded in and out, and that is not cosmetic: a buffer that
      // starts mid-waveform is a step discontinuity the interpolator rings on,
      // and the ringing reads as +0.57 dB of overs that belong to the test
      // rather than the signal. Real renders start from silence.
      const buf = await Tone.Offline(() => {
        const raw = Tone.getContext().rawContext;
        const n = Math.floor(raw.sampleRate * 0.5);
        const fade = Math.floor(raw.sampleRate * 0.02);
        const ab = raw.createBuffer(2, n, raw.sampleRate);
        for (let c = 0; c < 2; c++) {
          const d = ab.getChannelData(c);
          for (let i = 0; i < n; i++) {
            const edge = Math.min(i, n - 1 - i);
            const ramp = edge >= fade ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade);
            d[i] = Math.cos((Math.PI * i) / 2 + Math.PI / 4) * ramp;
          }
        }
        new Tone.ToneBufferSource({ url: new Tone.ToneAudioBuffer(ab) }).toDestination().start(0);
      }, 0.5);
      const chans = channelsOf(buf);
      let peak = 0;
      for (const d of chans) for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
      out.meters["fs/4 sine 45deg: sample peak"] = { got: r2(db(peak)), want: -3.01 };
      // -0.04, not 0.00: the residual 8x grid error, derived above. Asserting
      // 0.00 here would be asserting a meter more exact than 8x can be.
      out.meters["fs/4 sine 45deg: TRUE peak"] = { got: r2(db(truePeak(chans))), want: -0.04 };
    }

    // ---------------------------------------------------------------
    // Probes
    // ---------------------------------------------------------------

    // A steady sine at `inDb` into a node built by `make`, measured at the tail.
    const sineThrough = async (make, inDb, freq = 1000, dur = 2) => {
      const buf = await Tone.Offline(() => {
        const osc = new Tone.Oscillator(freq, "sine").connect(make());
        osc.volume.value = inDb;
        osc.start(0);
      }, dur);
      // A sine's RMS is amp/sqrt(2); report the equivalent amplitude in dBFS.
      return db(tailRms(buf) * Math.SQRT2);
    };

    // A one-sample impulse into `target`, for latency.
    //
    // The source buffer spans the WHOLE render, and that is load-bearing. Give
    // it a short one and Chrome stops flushing a DelayNode's line the moment
    // the buffer source upstream of a StereoPannerNode goes inactive — the
    // impulse goes into the delay and never comes out, and the probe reports a
    // silent path that is in fact fine. Verified against raw Web Audio, no Tone
    // involved: a 256-sample source reads -240 dB through panner -> delay, a
    // 4096-sample source reads -3.37 dB through the identical graph. One sample
    // of signal, padded with silence, costs nothing and keeps the source alive.
    const impulseInto = async (wire, dur = 0.08) =>
      Tone.Offline(() => {
        const target = wire();
        const raw = Tone.getContext().rawContext;
        const ab = raw.createBuffer(1, Math.ceil(dur * raw.sampleRate) + 512, raw.sampleRate);
        ab.getChannelData(0)[0] = 1;
        const src = new Tone.ToneBufferSource({ url: new Tone.ToneAudioBuffer(ab) }).connect(target);
        src.start(0);
      }, dur);

    if (!programOnly) {
    // --- Every DynamicsCompressorNode config in the graph. The makeup is a
    // pure function of (threshold, ratio, knee) and is measured well below
    // threshold, where the node is nothing but that gain.
    const COMP_CONFIGS = {
      glue: { threshold: -20, ratio: 3, attack: 0.03, release: 0.25, knee: 12 },
      input: { threshold: -20, ratio: 4, attack: 0.005, release: 0.15, knee: 12 },
      drumParallel: { threshold: -24, ratio: 4.5, attack: 0.004, release: 0.13, knee: 12 },
      "Tone.Limiter(-2)": { threshold: -2, ratio: 20, attack: 0.003, release: 0.01, knee: 30 },
    };
    out.comps = {};
    for (const [name, cfg] of Object.entries(COMP_CONFIGS)) {
      const inDb = -60;
      const gain = (await sineThrough(() => new Tone.Compressor(cfg).toDestination(), inDb)) - inDb;
      const imp = await impulseInto(() => new Tone.Compressor(cfg).toDestination());
      const at = onset(imp);
      out.comps[name] = { makeupDb: r2(gain), latencyMs: at < 0 ? null : r2((at / imp.sampleRate) * 1000) };
    }

    // --- The master chain, end to end.
    const masterOnly = () => buildGraph({ meters: false, exportGrade: true, withVerb: false, withEcho: false }).master;
    out.chain = { sweep: {}, slope: {} };
    // -40 dBFS, not -60, is the small-signal reference: Tone's distortion curve
    // returns 0 for |x| < 0.001, a dead zone that gates the whole wet path
    // below about -60 dBFS and reads as (fake) LOWER gain down there.
    const levels = [-60, -50, -40, -30, -24, -18, -12, -6, 0];
    let prev = null;
    for (const inDb of levels) {
      const outDb = await sineThrough(masterOnly, inDb);
      out.chain.sweep[inDb] = r2(outDb);
      if (prev) out.chain.slope[`${prev[0]}..${inDb}`] = r2((outDb - prev[1]) / (inDb - prev[0]));
      prev = [inDb, outDb];
    }
    out.chain.smallSignalDb = r2(out.chain.sweep[-40] + 40);

    // --- Harmonics of a 60 Hz tone through the chain, SWEPT across level. One
    // level is a trap: the asymmetric saturation and the symmetric stages
    // downstream each make a 2nd harmonic, and where they cancel is a function
    // of level — a probe at a single input can land in the null and report the
    // 2nd harmonic as absent when it's there at every other level. The row that
    // matters is 2H: it should be present (not -55) and not swing wildly.
    out.harm = {};
    for (const inDb of [-24, -18, -12, -6]) {
      const buf = await Tone.Offline(() => {
        const osc = new Tone.Oscillator(60, "sine").connect(masterOnly());
        osc.volume.value = inDb;
        osc.start(0);
      }, 2);
      const sr = buf.sampleRate;
      const d = buf.getChannelData(0);
      const len = Math.round(sr); // ~1 s, an integer count of 60 Hz periods
      const from = buf.length - len - 1;
      const h1 = toneMag(d, 60, sr, from, len);
      out.harm[`${inDb} dBFS`] = Object.fromEntries(
        [2, 3, 4, 5].map((k) => [`${k}H`, r2(db(toneMag(d, 60 * k, sr, from, len) / h1))])
      );
    }

    // --- Path latency, by impulse, measured at the bus sum rather than at the
    // master (the master chain is common to every path, so it cannot cause a
    // comb and would only smear the onset).
    {
      const busGraph = (mutate) => {
        const g = buildGraph({ meters: false, exportGrade: true, withVerb: false, withEcho: false });
        g.musicDuck.disconnect(g.master);
        g.drumBus.disconnect(g.master);
        g.musicDuck.toDestination();
        g.drumBus.toDestination();
        mutate?.(g);
        return g;
      };
      out.align = {};
      const at = async (label, wire) => {
        const buf = await impulseInto(wire);
        const i = onset(buf);
        out.align[label] = i < 0 ? { samples: null, ms: null } : { samples: i, ms: r2((i / buf.sampleRate) * 1000) };
      };
      for (const t of ["harmony", "bass", "melody"]) {
        await at(t, () => busGraph().colorIn[t]);
      }
      await at("drums (dry)", () => busGraph((g) => g.channels.drums.disconnect(g.drumParallel)).colorIn.drums);
      await at("drums (parallel)", () => busGraph((g) => g.channels.drums.disconnect(g.drumDry)).colorIn.drums);
    }

    // --- The crossfade law, isolated. Two bare layers, same pitch, no lane
    // filters and no blended cutoff in the way — so the only thing under test
    // is how the weights add. `mix` is what applyMorphTo writes at the midpoint.
    //
    // The reference is the two corners' own power mean, not one corner: a
    // sawtooth and a sine at the same `volume` do not have the same RMS
    // (0.577 A vs 0.707 A), so comparing a mixed pair against either corner
    // alone measures the waveform's RMS as if it were the law. Both laws are
    // scored against the same reference, so the comparison is the point.
    {
      const layerPair = (waveA, waveB, mix) =>
        Tone.Offline(() => {
          const dest = new Tone.Gain(1).toDestination();
          const mk = (wave, gainDb) => {
            const s = new Tone.Synth({ oscillator: { type: wave }, envelope: { attack: 0.01, decay: 0.1, sustain: 1, release: 0.1 } }).connect(dest);
            s.volume.value = gainDb;
            s.triggerAttack(110, 0);
          };
          if (waveB === null) mk(waveA, 0);
          else {
            mk(waveA, mix);
            mk(waveB, mix);
          }
        }, 1.5);
      const EQUAL_POWER = 10 * Math.log10(0.5); // -3.01: the old law
      const LINEAR = 20 * Math.log10(0.5); // -6.02: the new one
      out.law = {};
      for (const [label, a, b] of [
        ["same wave (saw+saw)", "sawtooth", "sawtooth"],
        ["different wave (saw+sine)", "sawtooth", "sine"],
      ]) {
        const soloA = tailRms(await layerPair(a, null, null), 0.5);
        const soloB = tailRms(await layerPair(b, null, null), 0.5);
        // What a level-flat pad should read at the midpoint: the mean POWER of
        // the two corners it sits between.
        const want = db(Math.sqrt((soloA * soloA + soloB * soloB) / 2));
        out.law[label] = {
          equalPower: r2(db(tailRms(await layerPair(a, b, EQUAL_POWER), 0.5)) - want),
          linear: r2(db(tailRms(await layerPair(a, b, LINEAR), 0.5)) - want),
        };
      }
    }

    // --- The fader's channel count, A/B. Tone.Channel defaults channelCount to
    // 1 and hands it to a Panner with channelCountMode "explicit", so a stereo
    // input is DOWN-MIXED to mono before it is panned. Decorrelated noise in,
    // correlation out: 1.000 means the two channels came out the same signal.
    {
      const throughChannel = async (cc) =>
        Tone.Offline(() => {
          const chan = new Tone.Channel({ volume: 0, pan: 0, channelCount: cc }).toDestination();
          // Two independent noise sources, hard left and hard right: as
          // decorrelated as a signal gets.
          const merge = new Tone.Merge().connect(chan);
          new Tone.Noise("white").connect(merge, 0, 0).start(0);
          new Tone.Noise("pink").connect(merge, 0, 1).start(0);
        }, 1);
      out.fader = {};
      for (const cc of [1, 2]) out.fader[`Tone.Channel channelCount: ${cc}`] = width(await throughChannel(cc));
    }
    }

    // ---------------------------------------------------------------
    // Program material: the fixed reference scene, then real dice rolls.
    // ---------------------------------------------------------------
    const note = (midi, len, vel) => [{ midi, len, vel }];
    const lane16 = (fill) => Array.from({ length: 16 }, (_, s) => fill(s) ?? null);
    const scene = {
      tag: "CAL",
      harmony: [0, 5, 3, 4],
      drums: {
        kick: lane16((s) => (s % 4 === 0 ? 0.9 : 0)).map(Number),
        snare: lane16((s) => (s === 4 || s === 12 ? 0.9 : 0)).map(Number),
        hat: lane16((s) => (s % 2 === 0 ? (s % 4 === 2 ? 0.85 : 0.65) : 0)).map(Number),
        clap: lane16((s) => (s === 6 || s === 14 ? 0.7 : 0)).map(Number),
      },
      bass: lane16((s) => (s % 4 === 0 ? note(36 + [0, 0, 7, 5][s / 4], 4, 0.9) : null)),
      melody: lane16((s) => (s % 2 === 0 ? note(60 + [0, 4, 7, 12, 7, 4, 0, 4][s / 2], 2, 0.8) : null)),
    };
    const clip = { scene: 0, start: 0, len: 4 };
    applyProject({
      tempo: 100, key: 0, scale: "major", swing: 0, scenes: [scene],
      arrangement: { harmony: [clip], drums: [clip], bass: [clip], melody: [clip] },
      loop: { on: false, start: 0, len: 4 },
    });
    for (const t of ["harmony", "bass", "melody"]) audio.setPatch(t, { x: 0, y: 0, color: "none", amount: 0.5, motion: 0.5 });
    audio.setPatch("drums", { x: 0, y: 0, color: "none", amount: 0.5, motion: 0.5, bank: "sample", pins: {} });
    audio.setKit("clean");
    audio.setHarmonyPreset("keys");
    audio.setBassPreset("deep");
    audio.setMelodyPreset("lead");

    const cal = await audio.renderOffline(null);
    out.program = { "CAL clean/keys/deep/lead": program(cal) };
    if (!programOnly) {
    out.width = { "CAL dry": width(cal) };
    // Width with the chorus-heavy corner and a phaser: the stereo effects only
    // pay for themselves if they survive the fader.
    audio.setHarmonyPreset("ambient");
    audio.setPatch("melody", { x: 0.5, y: 0.5, color: "phase", amount: 0.7, motion: 0.5 });
    out.width["ambient harmony + phased melody"] = width(await audio.renderOffline(null));
    audio.setPatch("melody", { x: 0, y: 0, color: "none", amount: 0.5, motion: 0.5 });
    audio.setHarmonyPreset("keys");

    // --- Kick low end through the drum bus. The dry and parallel halves used
    // to sum 6 ms apart, which is a comb with its first null at 83 Hz — right
    // through the kick.
    {
      const kickOnly = { ...scene.drums, snare: new Array(16).fill(0), hat: new Array(16).fill(0), clap: new Array(16).fill(0) };
      const saved = song.scenes[0].drums;
      song.scenes[0].drums = kickOnly;
      const buf = await audio.renderOffline("drums");
      song.scenes[0].drums = saved;
      const sr = buf.sampleRate;
      const d = buf.getChannelData(0);
      const len = Math.min(buf.length - 1, Math.floor(0.5 * sr));
      out.kick = {};
      for (const f of [40, 50, 60, 70, 83, 100, 120, 166, 250]) {
        out.kick[`${f}Hz`] = r2(db(toneMag(d, f, sr, 0, len)));
      }
    }
    }

    // --- The real thing: press the dice and measure the roll, end to end.
    if (!quick) {
      out.dice = {};
      for (let i = 0; i < 6; i++) {
        document.querySelector("#dice-btn").click();
        const what = `${song.tempo}bpm ${audio.kit()}/${audio.harmonyPreset()}/${audio.bassPreset()}/${audio.melodyPreset()}`;
        out.dice[`roll ${i + 1}: ${what}`] = program(await audio.renderOffline(null));
      }
    }
    return out;
  }, quick, programOnly);

  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);

  const pad = (s, n) => String(s).padEnd(n);
  const num = (s, n) => String(s).padStart(n);
  let bad = 0;

  console.log("\n== meter self-test ==");
  for (const [name, m] of Object.entries(report.meters)) {
    const off = Math.abs(m.got - m.want);
    const ok = off < 0.15;
    if (!ok) bad++;
    console.log(`  ${pad(name, 38)} ${num(m.got, 7)}  want ${num(m.want, 6)}  ${ok ? "ok" : `OFF BY ${off.toFixed(2)}`}`);
  }

  if (report.comps) {
  console.log("\n== compressors: spec makeup gain + lookahead latency ==");
  for (const [name, c] of Object.entries(report.comps)) {
    console.log(`  ${pad(name, 17)} makeup ${num(c.makeupDb, 6)} dB   latency ${num(c.latencyMs, 5)} ms`);
  }

  console.log("\n== master chain: sine in -> out (dBFS) ==");
  console.log(`  small-signal gain ${report.chain.smallSignalDb} dB  (measured at -40; -60 sits in Tone's dead zone)`);
  for (const [inDb, outDb] of Object.entries(report.chain.sweep)) console.log(`  ${num(inDb, 4)} -> ${num(outDb, 7)}`);
  console.log("  slope (dB out per dB in):");
  for (const [range, s] of Object.entries(report.chain.slope)) console.log(`    ${pad(range, 12)} ${s}`);

  if (report.harm) {
    console.log("\n== 60 Hz harmonics vs level (dB rel. fundamental) ==");
    console.log("   (2H is the even/octave-up harmonic — must be present at every level, no null)");
    console.log(`  ${pad("input", 10)} ${["2H", "3H", "4H", "5H"].map((h) => num(h, 7)).join("")}`);
    for (const [lvl, hs] of Object.entries(report.harm)) {
      console.log(`  ${pad(lvl, 10)} ${["2H", "3H", "4H", "5H"].map((h) => num(hs[h], 7)).join("")}`);
    }
    const h2 = Object.values(report.harm).map((hs) => hs["2H"]);
    if (Math.max(...h2) < -50) { console.log("  2H ABSENT at every level"); bad++; }
  }

  console.log("\n== path latency to the bus sum (impulse) ==");
  for (const [name, a] of Object.entries(report.align)) {
    console.log(`  ${pad(name, 18)} ${num(a.samples, 5)} samples  ${num(a.ms, 6)} ms`);
  }
  const lags = Object.values(report.align).map((a) => a.samples);
  const lagSpread = Math.max(...lags) - Math.min(...lags);
  console.log(`  spread ${lagSpread} samples${lagSpread ? `  <- COMB: first null at ${Math.round(report.rate / (2 * lagSpread))} Hz` : "  (aligned)"}`);
  if (lagSpread) bad++;

  console.log("\n== crossfade law: pad midpoint vs the mean power of its corners ==");
  for (const [name, l] of Object.entries(report.law)) {
    console.log(`  ${pad(name, 26)} equal-power ${num(l.equalPower, 6)} dB   linear ${num(l.linear, 6)} dB`);
  }

  console.log("\n== the fader's channel count (corr 1.000 = mono) ==");
  for (const [name, w] of Object.entries(report.fader)) {
    console.log(`  ${pad(name, 34)} corr ${num(w.corr, 6)}   side/mid ${num(w.sideDb, 7)} dB`);
  }

  console.log("\n== stereo width, real program (corr 1.000 = mono) ==");
  for (const [name, w] of Object.entries(report.width)) {
    console.log(`  ${pad(name, 34)} corr ${num(w.corr, 6)}   side/mid ${num(w.sideDb, 7)} dB`);
  }

  console.log("\n== kick through the drum bus (dB, dry+parallel summed) ==");
  for (const [f, v] of Object.entries(report.kick)) console.log(`  ${pad(f, 8)} ${num(v, 7)}`);
  }

  const row = (label, p) =>
    `  ${pad(label, 42)} LUFS ${num(p.lufs, 7)}  peak ${num(p.peak, 6)}  tp ${num(p.tp, 6)}  crest ${num(p.crest, 5)}  PLR ${num(p.plr, 5)}  PSR ${num(p.psr, 5)}`;
  console.log("\n== program (BS.1770-4 gated LUFS, 4x true peak) ==");
  for (const [label, p] of Object.entries(report.program)) console.log(row(label, p));
  if (report.dice) {
    console.log("\n== dice rolls, end to end ==");
    for (const [label, p] of Object.entries(report.dice)) console.log(row(label, p));
    const vals = (k) => Object.values(report.dice).map((p) => p[k]);
    const spread = (v) => Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100;
    console.log(`  LUFS spread ${spread(vals("lufs"))} dB   max true peak ${Math.max(...vals("tp"))} dBTP`);
  }

  console.log("\nJSON:", JSON.stringify(report));
  if (bad) console.log(`\n${bad} check(s) failed — see the rows marked above.`);
} finally {
  if (browser) await browser.close();
  await preview.stop();
}
