import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

const cwd = process.cwd();
const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const host = process.env.SMOKE_HOST || "127.0.0.1";
const port = Number(process.env.SMOKE_PORT || 4173);
const url = process.env.SMOKE_URL || `http://${host}:${port}/noodles/`;
const exportTimeout = Number(process.env.SMOKE_EXPORT_TIMEOUT || 60000);
const outDir = path.join(cwd, ".tmp");
const shotPath = path.join(outDir, "smoke.png");
const propsShotPath = path.join(outDir, "smoke-clip-props.png");
const mixerShotPath = path.join(outDir, "smoke-mixer.png");
const exportShotPath = path.join(outDir, "smoke-export.png");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startPreview() {
  const child = spawn("npm", ["run", "preview", "--", "--host", host, "--port", String(port), "--strictPort"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return {
    child,
    async ready() {
      const started = Date.now();
      while (Date.now() - started < 8000) {
        if (child.exitCode !== null) throw new Error(`preview exited early\n${output}`);
        if (output.includes("Local:") || output.includes(url)) return;
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

async function longPress(page, selector, ms = 650) {
  const handle = await page.waitForSelector(selector, { visible: true });
  const box = await handle.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await wait(ms);
  await page.mouse.up();
}

async function tap(page, selector) {
  const handle = await page.waitForSelector(selector, { visible: true });
  await handle.click();
}

async function closeSheet(page) {
  await page.waitForSelector(".sheet-bar .close", { visible: true });
  const closed = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll(".sheet-bar .close")];
    buttons.at(-1)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return buttons.length > 0;
  });
  if (!closed) throw new Error("no sheet close button");
}

async function clickAction(page, action) {
  const selector = `[data-action="${action}"]`;
  await page.waitForSelector(selector, { visible: true });
  const clicked = await page.evaluate((selector) => {
    const node = document.querySelector(selector);
    node?.click();
    return !!node;
  }, selector);
  if (!clicked) throw new Error(`missing action ${action}`);
}

// Dispatch pointer events straight at the cell: coordinate taps race the
// editor's auto-scroll-to-notes and miss ~1 run in 3.
async function tapPianoCell(page, row, step) {
  const ok = await page.evaluate(({ row, step }) => {
    const cell = document.querySelectorAll(".prow")[row]?.querySelectorAll(".pcell")[step];
    if (!cell) return false;
    const opts = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "touch" };
    cell.dispatchEvent(new PointerEvent("pointerdown", opts));
    cell.dispatchEvent(new PointerEvent("pointerup", opts));
    return true;
  }, { row, step });
  if (!ok) throw new Error(`missing piano cell row ${row} step ${step}`);
  await wait(150);
}

async function tapAt(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

function assertState(ok, msg) {
  if (!ok) throw new Error(msg);
}

await mkdir(outDir, { recursive: true });
const preview = process.env.SMOKE_URL ? null : startPreview();
let browser;

try {
  if (preview) await preview.ready();
  browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: [
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--mute-audio",
      // Fake mic so the beatbox-capture path runs headless.
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console:${msg.text()}`);
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector("#transport", { visible: true });
  await wait(500);

  const initial = await page.evaluate(() => ({
    transport: !!document.querySelector("#transport"),
    clips: document.querySelectorAll(".clip.filled").length,
    drums: !!document.querySelector('.clip.filled[data-track="drums"]'),
    sceneTag: document.querySelector(".scenecell[data-scene='0']")?.textContent ?? "",
  }));
  assertState(initial.transport, "transport missing");
  assertState(initial.clips >= 4, `expected at least 4 filled clips, got ${initial.clips}`);
  assertState(initial.drums, "drum clip missing");
  assertState(initial.sceneTag.includes("✨"), `default scene was not magic-generated: ${initial.sceneTag}`);
  await tap(page, "#bpm");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Tempo");
  await page.$eval(".tempo-input", (el) => { el.value = "104"; });
  await closeSheet(page);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));
  const typedTempo = await page.$eval("#bpm", (el) => el.textContent);
  assertState(typedTempo.includes("104"), `typed tempo did not apply: ${typedTempo}`);

  await tap(page, '.clip.filled[data-track="melody"]');
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Piano Roll");
  let stackedNotes = 0;
  for (const row of [2, 4, 6, 8, 10]) {
    await tapPianoCell(page, row, 1);
    stackedNotes = await page.evaluate(() =>
      [...document.querySelectorAll(".prow")].filter((row) => row.querySelectorAll(".pcell")[1]?.classList.contains("on")).length
    );
    if (stackedNotes >= 2) break;
  }
  assertState(stackedNotes >= 2, `expected layered notes in one step, got ${stackedNotes}`);
  // One gesture: press an empty cell and drag right — the note must grow under
  // the finger (regression: the drag mutated an orphaned clone, so a new
  // note's length always snapped back to 1 and only a second press worked).
  const dragLen = await page.evaluate(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 60));
    const row = [...document.querySelectorAll(".prow")].find((r) =>
      [4, 5, 6, 7].every((s) => !r.querySelectorAll(".pcell")[s]?.classList.contains("on"))
    );
    const cells = row.querySelectorAll(".pcell");
    const at = (cell) => {
      const r = cell.getBoundingClientRect();
      return { bubbles: true, cancelable: true, pointerId: 3, pointerType: "touch", clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    };
    cells[4].dispatchEvent(new PointerEvent("pointerdown", at(cells[4])));
    await tick();
    cells[4].dispatchEvent(new PointerEvent("pointermove", at(cells[7])));
    await tick();
    cells[4].dispatchEvent(new PointerEvent("pointerup", at(cells[7])));
    await tick();
    return Math.max(...(window.__noodles.song.scenes[0].melody[4] || []).map((n) => n.len), 0);
  });
  assertState(dragLen === 4, `press-drag did not stretch the new note to 4 steps (got len ${dragLen})`);
  // Editor dice: rolled melody notes stay inside a 2-octave in-scale window
  // between octave 2 and octave 5 (the old roll scattered across ~8 octaves).
  await page.evaluate(() => [...document.querySelectorAll(".tfbtn")].find((b) => b.textContent === "🎲")?.click());
  const rolledMidis = await page.evaluate(() => window.__noodles.song.scenes[0].melody.flatMap((slot) => (slot || []).map((n) => n.midi)));
  assertState(rolledMidis.length > 0 && rolledMidis.every((m) => m >= 36 && m <= 83), `melody dice rolled out of range: ${JSON.stringify(rolledMidis)}`);
  await closeSheet(page);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));

  await tap(page, ".tbtn.play");
  await page.waitForFunction(() => document.querySelectorAll(".clip.playing").length >= 4);
  const playOn = await page.$eval(".tbtn.play", (el) => el.classList.contains("on"));
  assertState(playOn, "play button did not enter playing state");
  // The pie timers must actually fill: --pct is read by a ::after pseudo, so
  // it must reach it via inheritance (regression: @property inherits:false
  // pinned every pie at zero).
  await page.waitForFunction(() => {
    const clip = document.querySelector(".clip.playing");
    return clip && parseFloat(getComputedStyle(clip, "::after").getPropertyValue("--pct")) > 0;
  }, { timeout: 15000 });
  await tap(page, "#view-toggle-btn");
  const stillPlayingAfterView = await page.$eval(".tbtn.play", (el) => el.classList.contains("on"));
  assertState(stillPlayingAfterView, "view switch stopped playback");
  await tap(page, "#view-toggle-btn");
  await tap(page, ".tbtn.play");

  await longPress(page, '.clip.filled[data-track="drums"]');
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Clip Properties");
  await clickAction(page, "mode-oneshot");
  await page.waitForFunction(() => document.querySelector('.clip.filled[data-track="drums"] .clip-badge')?.textContent.includes("1x"));
  await clickAction(page, "follow-next");
  await page.waitForFunction(() => document.querySelector('.clip.filled[data-track="drums"] .clip-badge')?.textContent.includes("next"));
  const badge = await page.$eval('.clip.filled[data-track="drums"] .clip-badge', (el) => el.textContent);
  assertState(badge.includes("1x") && badge.includes("next"), `unexpected launch badge: ${badge}`);
  const scenesBeforeDuplicate = await page.$$eval(".scenecell", (els) => els.length);
  await clickAction(page, "duplicate-scene");
  await page.waitForFunction((before) => document.querySelectorAll(".scenecell").length === before + 1, {}, scenesBeforeDuplicate);
  const scenesAfterDuplicate = await page.$$eval(".scenecell", (els) => els.length);
  assertState(scenesAfterDuplicate === scenesBeforeDuplicate + 1, "session duplicate did not add a scene");
  await page.screenshot({ path: propsShotPath, fullPage: true });

  await closeSheet(page);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));
  await tap(page, "#view-toggle-btn");
  const arrange = await page.$eval("#app", (app) => app.classList.contains("arrange"));
  assertState(arrange, "arrangement view did not open");

  await tap(page, '.arr-thead[data-track="drums"] [data-track-toggle="mute"]');
  const muted = await page.$eval('.arr-thead[data-track="drums"] [data-track-toggle="mute"]', (el) => el.classList.contains("on"));
  assertState(muted, "arrangement mute button did not toggle");
  await tap(page, '.arr-thead[data-track="drums"] [data-track-toggle="solo"]');
  const soloed = await page.$eval('.arr-thead[data-track="drums"] [data-track-toggle="solo"]', (el) => el.classList.contains("on"));
  assertState(soloed, "arrangement solo button did not toggle");
  await tap(page, '.arr-thead[data-track="drums"] [data-track-toggle="mute"]');
  await tap(page, '.arr-thead[data-track="drums"] [data-track-toggle="solo"]');

  // Tap a track header (outside M/S) → that track's Sound page opens, and it
  // fits the phone viewport without scrolling (the pad flexes to fill).
  await page.evaluate(() => {
    document.querySelector('.arr-thead[data-track="bass"]').dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Sound");
  const soundSub = await page.$eval(".sheet-bar .sub", (el) => el.textContent);
  assertState(soundSub === "Bass", `header tap opened Sound for "${soundSub}", wanted Bass`);
  const soundFit = await page.$eval(".sound-body", (el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  assertState(soundFit.scroll <= soundFit.client + 2, `sound sheet scrolls: ${JSON.stringify(soundFit)}`);
  await closeSheet(page);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));

  // Loop lane: drag across empty lane space paints a new loop and enables it;
  // a tap on the brace toggles it back off.
  await page.evaluate(() => {
    const lane = document.querySelector(".arr-looplane");
    const content = document.querySelector(".arr-content");
    const r = content.getBoundingClientRect();
    const ppb = parseFloat(getComputedStyle(content).getPropertyValue("--ppb")) || 37;
    const y = lane.getBoundingClientRect().top + 12;
    const opts = (x) => ({ bubbles: true, cancelable: true, pointerId: 7, pointerType: "touch", clientX: r.left + x, clientY: y });
    lane.dispatchEvent(new PointerEvent("pointerdown", opts(ppb * 5 + 2)));
    lane.dispatchEvent(new PointerEvent("pointermove", opts(ppb * 7 + 2)));
    lane.dispatchEvent(new PointerEvent("pointerup", opts(ppb * 7 + 2)));
  });
  const painted = await page.evaluate(() => window.__noodles.song.loop);
  assertState(painted.on && painted.start === 5 && painted.len === 2, `loop paint failed: ${JSON.stringify(painted)}`);
  await page.evaluate(() => {
    // Dispatch on the brace itself so e.target matches a real touch there.
    const brace = document.querySelector(".arr-loop");
    const content = document.querySelector(".arr-content");
    const r = content.getBoundingClientRect();
    const ppb = parseFloat(getComputedStyle(content).getPropertyValue("--ppb")) || 37;
    const y = brace.getBoundingClientRect().top + 8;
    const opts = { bubbles: true, cancelable: true, pointerId: 8, pointerType: "touch", clientX: r.left + ppb * 6, clientY: y };
    brace.dispatchEvent(new PointerEvent("pointerdown", opts));
    brace.dispatchEvent(new PointerEvent("pointerup", opts));
  });
  const toggled = await page.evaluate(() => window.__noodles.song.loop.on);
  assertState(toggled === false, "brace tap did not toggle the loop off");
  // Dragging toward the viewport edge must auto-pan the arrangement.
  await page.evaluate(() => {
    const brace = document.querySelector(".arr-loop");
    const r = brace.getBoundingClientRect();
    const opts = (x) => ({ bubbles: true, cancelable: true, pointerId: 9, pointerType: "touch", clientX: x, clientY: r.top + 8 });
    brace.dispatchEvent(new PointerEvent("pointerdown", opts(r.left + 10)));
    document.querySelector(".arr-looplane").dispatchEvent(new PointerEvent("pointermove", opts(innerWidth - 8)));
  });
  await wait(500);
  const panned = await page.evaluate(() => document.querySelector(".arr-scroll").scrollLeft);
  await page.evaluate(() => {
    document.querySelector(".arr-looplane").dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 9 }));
  });
  assertState(panned > 0, `edge drag did not auto-pan the view (scrollLeft ${panned})`);

  await longPress(page, '.arr-thead[data-track="drums"]');
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Track Options");
  await closeSheet(page);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));
  await tap(page, ".arr-corner .view-mix");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Mixer");
  const mixerText = await page.$eval("#sheet", (el) => el.textContent);
  assertState(mixerText.includes("echo"), "mixer missing echo send");
  assertState(mixerText.includes("Master") && mixerText.includes("-6 dB"), "mixer missing master/default level");
  // The strip's device label names the engine's dominant corner (the preset
  // dropdowns are gone; the sound sheet is the one path).
  const kitMatch = await page.evaluate(() => {
    const label = document.querySelector('.mx-strip[data-track="drums"] .mx-devlabel')?.textContent || "";
    return { label, engine: window.__noodles.audio.kit() };
  });
  assertState(kitMatch.label.includes(kitMatch.engine), `mixer device label (${kitMatch.label}) disagrees with engine (${kitMatch.engine})`);
  await tap(page, ".tbtn.play");
  const mixerStillOpen = await page.$eval("#sheet", (el) => el.classList.contains("open"));
  assertState(mixerStillOpen, "play/pause dismissed an open sheet");
  await tap(page, ".tbtn.play");
  await page.screenshot({ path: mixerShotPath, fullPage: true });

  // Sound sheet: morph pad drag, color chip, per-track sound dice.
  await clickAction(page, "sound-bass");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Sound");
  await page.evaluate(() => {
    const xy = document.querySelector('[data-action="xy-bass"]');
    const r = xy.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, pointerId: 2, pointerType: "touch", clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    xy.dispatchEvent(new PointerEvent("pointerdown", opts));
    xy.dispatchEvent(new PointerEvent("pointerup", opts));
  });
  await wait(200);
  const morphed = await page.evaluate(() => window.__noodles.audio.patch("bass"));
  assertState(Math.abs(morphed.x - 0.5) < 0.1 && Math.abs(morphed.y - 0.5) < 0.1, `xy pad tap did not morph to center: ${JSON.stringify(morphed)}`);
  await clickAction(page, "color-tape");
  const colored = await page.evaluate(() => window.__noodles.audio.patch("bass").color);
  assertState(colored === "tape", `color chip did not apply (got ${colored})`);
  await clickAction(page, "sound-dice-bass");
  const rolled = await page.evaluate(() => window.__noodles.audio.patch("bass"));
  assertState(
    rolled.x >= 0 && rolled.x <= 1 && rolled.y >= 0 && rolled.y <= 1 && rolled.amount >= 0 && rolled.amount <= 1,
    `sound dice rolled out of range: ${JSON.stringify(rolled)}`
  );
  await page.evaluate(() => window.__noodles.audio.setPatch("bass", { x: 0, y: 0, color: "none" }));
  // Motion capture: arm the bass, play, ride the pad via setPatch, and some
  // playing scene must grow an x lane with real variety in it.
  await page.evaluate(() => window.__noodles.audio.armMotion("bass", true));
  await tap(page, ".tbtn.play");
  await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 10; i++) {
      window.__noodles.audio.setPatch("bass", { x: i / 10, y: 1 - i / 10 });
      await wait(150);
    }
  });
  await page.waitForFunction(() => {
    return window.__noodles.song.scenes.some((sc) => {
      const lane = sc.motion?.bass?.x;
      return Array.isArray(lane) && new Set(lane.map((v) => v.toFixed(2))).size > 2;
    });
  }, { timeout: 15000 });
  await tap(page, ".tbtn.play");
  await page.evaluate(() => window.__noodles.audio.disarmMotion());
  // Drums: kit pad, sample/synth banks, and the one-shot picker. The sound
  // sheet replaced the mixer, so reopen it to reach the drums strip.
  await closeSheet(page);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));
  await tap(page, ".arr-corner .view-mix");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Mixer");
  await page.evaluate(() => window.__noodles.audio.setPatch("drums", { bank: "sample" }));
  await clickAction(page, "sound-drums");
  await page.waitForSelector('[data-action="xy-drums"]', { visible: true });
  await page.waitForSelector('[data-action="pick-kick"]', { visible: true });
  await clickAction(page, "pick-kick");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "One-shot");
  await clickAction(page, "pin-street-kick");
  await page.waitForFunction(() => window.__noodles.audio.patch("drums").pins.kick === "street-kick");
  await clickAction(page, "pin-kit");
  await page.waitForFunction(() => !window.__noodles.audio.patch("drums").pins.kick);
  const samplesReady = await page.evaluate(() => window.__noodles.audio.samplesReady());
  assertState(samplesReady, "bundled drum samples did not load");
  // Beatbox capture: record the (fake) mic into the kick slot, expect a
  // conditioned one-shot pinned as "user".
  await clickAction(page, "pin-mic");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Record");
  await clickAction(page, "mic-go");
  await page.waitForFunction(() => document.querySelector(".mic-big")?.classList.contains("live"), { timeout: 10000 });
  // Chrome's fake mic beeps periodically; record across a full cycle so the
  // take always contains signal.
  await wait(1200);
  await clickAction(page, "mic-go");
  await page.waitForFunction(
    () => window.__noodles.audio.userSampleName("kick") === "mic kick" && window.__noodles.audio.patch("drums").pins.kick === "user",
    { timeout: 15000 }
  );
  await page.evaluate(() => {
    const pins = { ...window.__noodles.audio.patch("drums").pins };
    delete pins.kick;
    window.__noodles.audio.setPatch("drums", { pins });
  });

  await tapAt(page, 200, 70);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));

  await tap(page, "#file-btn");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Export");
  const exportText = await page.$eval("#sheet", (el) => el.textContent);
  assertState(exportText.includes("Download Project") && exportText.includes("Master WAV"), "export sheet missing grouped project/audio actions");
  await clickAction(page, "save-local-project");
  await page.waitForFunction(() => document.querySelector(".exp-status")?.textContent.includes("Kept on this device"));
  await page.evaluate(() => document.querySelector('[data-action="export-master-wav"]').click());
  try {
    await page.waitForFunction(() => document.querySelector(".exp-links a.save")?.getAttribute("href")?.startsWith("blob:"), { timeout: exportTimeout });
  } catch (e) {
    const status = await page.$eval(".exp-status", (el) => el.textContent);
    throw new Error(`export timed out; status="${status}"; errors=${errors.join(" | ") || "none"}`);
  }
  // The status text is not enough — a silent or truncated WAV would still say
  // "ready". Fetch the offered blob and assert it carries real audio.
  const wav = await page.evaluate(async () => {
    const a = document.querySelector(".exp-links a.save");
    const buf = await fetch(a.href).then((r) => r.arrayBuffer());
    const dv = new DataView(buf);
    const tag = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    let peak = 0, nz = 0, n = 0;
    for (let off = 44; off + 2 <= buf.byteLength; off += 2) {
      const s = dv.getInt16(off, true) / 32768, ab = Math.abs(s);
      if (ab > peak) peak = ab;
      if (s !== 0) nz++;
      n++;
    }
    return { bytes: buf.byteLength, tag, peakDb: Math.round(20 * Math.log10(Math.max(peak, 1e-9)) * 10) / 10, nzPct: Math.round((nz / n) * 100) };
  });
  assertState(wav.tag === "RIFF" && wav.bytes > 100000 && wav.peakDb > -6 && wav.nzPct > 50, `exported WAV empty/silent: ${JSON.stringify(wav)}`);
  await page.screenshot({ path: exportShotPath, fullPage: true });
  await closeSheet(page);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));

  // The ? opens the guide — with the greet pill gone, this is the whole
  // onboarding, so it must actually be comprehensive: every surface gets a
  // section, and the sheet hints that it scrolls.
  await tap(page, "#about-btn");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "noodles");
  const about = await page.evaluate(() => ({
    text: document.querySelector("#sheet").textContent,
    sections: [...document.querySelectorAll("#sheet .about-label")].map((el) => el.textContent),
    hint: !!document.querySelector("#sheet .scroll-hint"),
  }));
  assertState(about.text.includes("instrument"), "about sheet missing its one job");
  for (const section of ["start here", "the grid", "sound", "mix", "arrange", "keep it"]) {
    assertState(about.sections.includes(section), `about guide missing the "${section}" section`);
  }
  assertState(about.hint, "about guide scroll hint missing (or the guide stopped overflowing)");
  // The buried perf overlay: toggling it in the guide shows and hides the HUD.
  await clickAction(page, "perf-toggle");
  await page.waitForSelector("#perf-hud");
  await clickAction(page, "perf-toggle");
  const hudGone = await page.evaluate(() => !document.querySelector("#perf-hud") && !localStorage.getItem("noodles:perf-hud"));
  assertState(hudGone, "perf overlay did not toggle back off");
  await closeSheet(page);
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));

  // Session-record: arm, play a couple of bars in session view, and the
  // performance must land in the arrangement. Regression guard: recording used
  // to throw a ReferenceError on every recorded bar (undefined scheduleSave).
  await tap(page, "#view-toggle-btn");
  const recArmed = await page.$eval("#rec-btn", (el) => (el.click(), true));
  assertState(recArmed, "record button missing");
  await page.waitForFunction(() => document.querySelector("#rec-btn")?.classList.contains("on"));
  await tap(page, ".tbtn.play");
  await page.waitForFunction(
    () => window.__noodles.song.arrangement.harmony.some((c) => c.start === 0 && c.len >= 2),
    { timeout: 30000 }
  );
  await tap(page, ".tbtn.play");
  await page.evaluate(() => document.querySelector("#rec-btn")?.click());
  await page.waitForFunction(() => !document.querySelector("#rec-btn")?.classList.contains("on"));
  await tap(page, "#view-toggle-btn");

  // The transport must actually advance — not merely flip the play button on.
  // Regression guard for the dual-context bug: play() started a transport the
  // clock loop wasn't scheduled on, so nothing sounded and the playhead froze.
  await tap(page, ".tbtn.play");
  const playhead = () => page.evaluate(() => document.querySelector(".arr-playhead")?.style.transform ?? "");
  const phStart = await playhead();
  await wait(800);
  const phEnd = await playhead();
  assertState(phStart !== phEnd, `transport stalled: playhead did not advance (${phStart} -> ${phEnd})`);

  await page.screenshot({ path: shotPath, fullPage: true });

  // Dice: one tap re-rolls the whole song (fresh magic scene), and undo
  // brings the previous song back.
  const scenesBeforeDice = await page.evaluate(() => window.__noodles.song.scenes.length);
  assertState(scenesBeforeDice >= 2, `expected the duplicated scene to persist, got ${scenesBeforeDice}`);
  await page.evaluate(() => document.querySelector("#dice-btn").click());
  const afterDice = await page.evaluate(() => ({
    scenes: window.__noodles.song.scenes.length,
    tag: window.__noodles.song.scenes[0].tag,
  }));
  // A roll is one magic scene, sometimes with a ✨b variation to go to.
  assertState(afterDice.scenes >= 1 && afterDice.scenes <= 2 && afterDice.tag.includes("✨"), `dice did not roll a fresh magic song: ${JSON.stringify(afterDice)}`);
  await page.evaluate(() => document.querySelector(".tbtn.undo").click());
  const scenesAfterUndo = await page.evaluate(() => window.__noodles.song.scenes.length);
  assertState(scenesAfterUndo === scenesBeforeDice, `undo did not restore the pre-dice song (${scenesAfterUndo} vs ${scenesBeforeDice})`);

  // Roll a handful more and hold the register invariant: the dice never deals
  // a driveless sine bass in octave 1 (inaudible on real speakers).
  for (let i = 0; i < 6; i++) {
    const roll = await page.evaluate(() => {
      document.querySelector("#dice-btn").click();
      const { song, audio } = window.__noodles;
      const midis = song.scenes[0].bass.flatMap((slot) => (slot || []).map((n) => n.midi));
      return { preset: audio.bassPreset(), minMidi: Math.min(...midis), count: midis.length };
    });
    assertState(roll.count > 0, `dice roll ${i} produced an empty bassline`);
    assertState(roll.preset !== "deep" || roll.minMidi >= 36, `dice dealt deep bass below octave 2 (min midi ${roll.minMidi})`);
  }

  assertState(errors.length === 0, `runtime errors:\n${errors.join("\n")}`);
  console.log(`smoke ok: ${propsShotPath}`);
  console.log(`smoke ok: ${mixerShotPath}`);
  console.log(`smoke ok: ${exportShotPath}`);
  console.log(`smoke ok: ${shotPath}`);
} finally {
  if (browser) await browser.close();
  if (preview) await preview.stop();
}
