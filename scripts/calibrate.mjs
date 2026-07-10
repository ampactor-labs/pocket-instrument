// Mix calibration: render every device preset through the real offline graph
// (which IS the live graph — see buildGraph in src/audio.js) against a fixed
// reference scene, and report per-preset loudness. The preset gain trims in
// audio.js are tuned until every preset of a track lands at the same RMS, so
// the on-load randomizer can roll anything and the balance holds.
//
// Usage: npm run calibrate   (prints a dB table + JSON blob)

import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const host = process.env.SMOKE_HOST || "127.0.0.1";
const port = Number(process.env.SMOKE_PORT || 4174);
const url = `http://${host}:${port}/noodles/`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startPreview() {
  const child = spawn("npm", ["run", "preview", "--", "--host", host, "--port", String(port), "--strictPort"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  return {
    async ready() {
      const started = Date.now();
      while (Date.now() - started < 8000) {
        if (child.exitCode !== null) throw new Error(`preview exited early\n${output}`);
        if (output.includes("Local:")) return;
        await wait(100);
      }
      throw new Error(`preview did not become ready\n${output}`);
    },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await wait(200);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

const preview = startPreview();
let browser;
try {
  await preview.ready();
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--mute-audio"],
    // The whole sweep runs as one page.evaluate — ~75 offline renders —
    // which blows past the 180 s default protocol timeout.
    protocolTimeout: 1_800_000,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__noodles);

  const report = await page.evaluate(async () => {
    const { song, audio, applyProject } = window.__noodles;

    // --- Fixed reference scene: every probe renders this, only the preset
    // (or one lane's octave) changes between renders.
    const note = (midi, len, vel) => [{ midi, len, vel }];
    const lane16 = (fill) => Array.from({ length: 16 }, (_, s) => fill(s) ?? null);
    const bassLane = (base) => lane16((s) => (s % 4 === 0 ? note(base + [0, 0, 7, 5][s / 4], 4, 0.9) : null));
    const melodyLane = (base) => lane16((s) => (s % 2 === 0 ? note(base + [0, 4, 7, 12, 7, 4, 0, 4][s / 2], 2, 0.8) : null));
    const drums = {
      kick: lane16((s) => (s % 4 === 0 ? 0.9 : 0)).map(Number),
      snare: lane16((s) => (s === 4 || s === 12 ? 0.9 : 0)).map(Number),
      hat: lane16((s) => (s % 2 === 0 ? (s % 4 === 2 ? 0.85 : 0.65) : 0)).map(Number),
      clap: lane16((s) => (s === 6 || s === 14 ? 0.7 : 0)).map(Number),
    };
    const scene = {
      tag: "CAL",
      harmony: [0, 5, 3, 4],
      drums,
      bass: bassLane(36),
      melody: melodyLane(60),
    };
    applyProject({
      tempo: 100,
      key: 0,
      scale: "major",
      swing: 0,
      scenes: [scene],
      arrangement: {
        harmony: [{ scene: 0, start: 0, len: 4 }],
        drums: [{ scene: 0, start: 0, len: 4 }],
        bass: [{ scene: 0, start: 0, len: 4 }],
        melody: [{ scene: 0, start: 0, len: 4 }],
      },
      loop: { on: false, start: 0, len: 4 },
    });

    // Stats over the musical body, not the reverb tail. `hi` is RMS through a
    // double one-pole 80 Hz highpass — a crude speaker-band meter. Flat RMS
    // counts sub energy a phone or bookshelf speaker can't reproduce, which is
    // how "deep at C1 is inaudible" once hid behind a healthy-looking number.
    const stats = (buf, bodySec) => {
      const sr = buf.sampleRate;
      const n = Math.min(buf.length, Math.floor(bodySec * sr));
      const a = Math.exp((-2 * Math.PI * 80) / sr);
      let peak = 0;
      let sum = 0;
      let hiSum = 0;
      let count = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        let y1 = 0, x1 = 0, y2 = 0, x2 = 0;
        for (let i = 0; i < n; i++) {
          const x = d[i];
          const ab = Math.abs(x);
          if (ab > peak) peak = ab;
          sum += x * x;
          y1 = a * (y1 + x - x1);
          x1 = x;
          y2 = a * (y2 + y1 - x2);
          x2 = y1;
          hiSum += y2 * y2;
        }
        count += n;
      }
      const db = (x) => Math.round(20 * Math.log10(Math.max(x, 1e-9)) * 10) / 10;
      return { peak: db(peak), rms: db(Math.sqrt(sum / count)), hi: db(Math.sqrt(hiSum / count)) };
    };
    const bodySec = () => (240 / song.tempo) * 4;
    const render = async (soloTrack) => stats(await audio.renderOffline(soloTrack), bodySec());

    const out = { harmony: {}, bass: {}, melody: {}, kits: {}, bassOct: {}, melodyOct: {}, master: {} };
    const PRESETS = {
      harmony: ["pad", "keys", "ambient", "stab"],
      bass: ["deep", "bright", "pluck", "sub"],
      melody: ["lead", "bell", "synth", "pluck"],
      kits: ["garage", "funk", "clean"],
    };

    for (const p of PRESETS.harmony) {
      audio.setHarmonyPreset(p);
      out.harmony[p] = await render("harmony");
    }
    audio.setHarmonyPreset("keys");

    for (const p of PRESETS.melody) {
      audio.setMelodyPreset(p);
      out.melody[p] = await render("melody");
    }
    // Melody register probe: same preset, walked down the octaves.
    audio.setMelodyPreset("lead");
    for (const base of [36, 48, 60, 72]) {
      song.scenes[0].melody = melodyLane(base);
      out.melodyOct[base] = await render("melody");
    }
    song.scenes[0].melody = melodyLane(60);

    for (const p of PRESETS.bass) {
      audio.setBassPreset(p);
      out.bass[p] = await render("bass");
    }
    // Bass register probe: every preset at both magic-scene octaves.
    for (const p of PRESETS.bass) {
      audio.setBassPreset(p);
      const both = {};
      for (const base of [24, 36]) {
        song.scenes[0].bass = bassLane(base);
        both[base] = await render("bass");
      }
      out.bassOct[p] = both;
      song.scenes[0].bass = bassLane(36);
    }
    audio.setBassPreset("deep");

    for (const k of PRESETS.kits) {
      audio.setKit(k);
      out.kits[k] = await render("drums");
    }
    audio.setKit("clean");

    // Full-mix sanity: a spread of combos through the master chain.
    const combos = [
      ["clean", "keys", "deep", "lead"],
      ["garage", "pad", "sub", "bell"],
      ["funk", "ambient", "pluck", "synth"],
      ["garage", "stab", "bright", "pluck"],
      ["clean", "ambient", "sub", "lead"],
      ["funk", "keys", "bright", "bell"],
    ];
    for (const [kit, h, b, m] of combos) {
      audio.setKit(kit);
      audio.setHarmonyPreset(h);
      audio.setBassPreset(b);
      audio.setMelodyPreset(m);
      out.master[`${kit}/${h}/${b}/${m}`] = await render(null);
    }

    // The morph space between corners plus every color, per track. Corners
    // are loudness-matched; the space must inherit it — this is the gate that
    // keeps "roll any sound" from meaning "roll any level".
    const SPACE_SPECS = [
      { label: "center", x: 0.5, y: 0.5, color: "none" },
      { label: "edge-right", x: 1, y: 0.5, color: "none" },
      { label: "edge-bottom", x: 0.5, y: 1, color: "none" },
      { label: "tape", x: 0.5, y: 0.5, color: "tape", amount: 0.7, motion: 0.4 },
      { label: "crush", x: 0.5, y: 0.5, color: "crush", amount: 0.6, motion: 0.5 },
      { label: "phase", x: 0.25, y: 0.75, color: "phase", amount: 0.7, motion: 0.5 },
      { label: "trem", x: 0.75, y: 0.25, color: "trem", amount: 0.7, motion: 0.6 },
      { label: "wob", x: 0.5, y: 0.5, color: "wob", amount: 0.6, motion: 0.6 },
    ];
    out.space = {};
    for (const t of ["harmony", "bass", "melody"]) {
      const rows = {};
      for (const spec of SPACE_SPECS) {
        audio.setPatch(t, { x: spec.x, y: spec.y, color: spec.color, amount: spec.amount ?? 0.5, motion: spec.motion ?? 0.5 });
        rows[spec.label] = await render(t);
      }
      audio.setPatch(t, { x: 0, y: 0, color: "none", amount: 0.5, motion: 0.5 });
      out.space[t] = rows;
    }

    // The real thing: press the dice like a user would and render every roll
    // end to end — random key, scale, tempo, presets, magic scene. This is
    // the cohesion check across actual reloads, content variance included.
    out.dice = {};
    for (let i = 0; i < 8; i++) {
      document.querySelector("#dice-btn").click();
      const roll = {
        what: `${song.tempo}bpm ${audio.kit()}/${audio.harmonyPreset()}/${audio.bassPreset()}/${audio.melodyPreset()}`,
        master: await render(null),
      };
      for (const t of ["harmony", "drums", "bass", "melody"]) roll[t] = await render(t);
      out.dice[`roll ${i + 1}: ${roll.what}`] = roll;
    }
    return out;
  });

  if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);

  const spreadOf = (vals) => Math.round((Math.max(...vals) - Math.min(...vals)) * 10) / 10;
  const spread = (group) => spreadOf(Object.values(group).map((s) => s.rms));
  for (const [name, group] of Object.entries(report)) {
    if (name === "bassOct") {
      console.log(`\n== bass octave 1 vs 2 (rms dB, hi = above 80 Hz) ==`);
      for (const [p, both] of Object.entries(group)) {
        console.log(`  ${p.padEnd(8)} oct1 ${both[24].rms} (hi ${both[24].hi})  oct2 ${both[36].rms} (hi ${both[36].hi})`);
      }
      continue;
    }
    if (name === "space") {
      console.log(`\n== morph space + colors (rms / hi dB per track) ==`);
      for (const [t, rows] of Object.entries(group)) {
        console.log(`  ${t} — spread ${spread(rows)} dB`);
        for (const [label, s] of Object.entries(rows)) {
          console.log(`    ${label.padEnd(14)} ${String(s.rms).padStart(6)} / ${String(s.hi).padStart(6)}`);
        }
      }
      continue;
    }
    if (name === "dice") {
      const rolls = Object.entries(group);
      console.log(`\n== dice rolls, end to end (master rms/hi · stems rms) ==`);
      for (const [label, r] of rolls) {
        const stems = ["harmony", "drums", "bass", "melody"].map((t) => `${t[0]}${r[t].rms}`).join(" ");
        console.log(`  ${label.padEnd(44)} ${String(r.master.rms).padStart(6)} / ${String(r.master.hi).padStart(6)}   ${stems}`);
      }
      console.log(`  master spread ${spreadOf(rolls.map(([, r]) => r.master.rms))} dB (hi ${spreadOf(rolls.map(([, r]) => r.master.hi))} dB)`);
      for (const t of ["harmony", "drums", "bass", "melody"]) {
        console.log(`  ${t} stem spread ${spreadOf(rolls.map(([, r]) => r[t].rms))} dB`);
      }
      continue;
    }
    console.log(`\n== ${name} (rms / peak dB) — spread ${spread(group)} dB ==`);
    for (const [p, s] of Object.entries(group)) {
      console.log(`  ${String(p).padEnd(28)} ${String(s.rms).padStart(6)} / ${String(s.peak).padStart(6)}`);
    }
  }
  console.log("\nJSON:", JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  await preview.stop();
}
