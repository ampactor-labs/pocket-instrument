import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import puppeteer from "puppeteer-core";

const cwd = process.cwd();
const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const host = process.env.SMOKE_HOST || "127.0.0.1";
const port = Number(process.env.SMOKE_PORT || 4173);
const url = process.env.SMOKE_URL || `http://${host}:${port}/`;
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
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console:${msg.text()}`);
  });

  await page.goto(url, { waitUntil: "networkidle2" });
  await wait(500);

  const initial = await page.evaluate(() => ({
    transport: !!document.querySelector("#transport"),
    clips: document.querySelectorAll(".clip.filled").length,
    drums: !!document.querySelector('.clip.filled[data-track="drums"]'),
  }));
  assertState(initial.transport, "transport missing");
  assertState(initial.clips >= 4, `expected at least 4 filled clips, got ${initial.clips}`);
  assertState(initial.drums, "drum clip missing");

  await tap(page, "#bpm");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Tempo");
  await page.$eval(".tempo-input", (el) => { el.value = "104"; });
  await tap(page, ".sheet-bar .close");
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));
  const typedTempo = await page.$eval("#bpm", (el) => el.textContent);
  assertState(typedTempo.includes("104"), `typed tempo did not apply: ${typedTempo}`);

  await tap(page, ".tbtn.play");
  await page.waitForFunction(() => document.querySelectorAll(".clip.playing").length >= 4);
  const playOn = await page.$eval(".tbtn.play", (el) => el.classList.contains("on"));
  assertState(playOn, "play button did not enter playing state");
  await tap(page, ".tbtn.play");

  await longPress(page, '.clip.filled[data-track="drums"]');
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Clip Properties");
  await tap(page, '[data-action="mode-oneshot"]');
  await tap(page, '[data-action="follow-next"]');
  const badge = await page.$eval('.clip.filled[data-track="drums"] .clip-badge', (el) => el.textContent);
  assertState(badge.includes("1x") && badge.includes("next"), `unexpected launch badge: ${badge}`);
  const scenesBeforeDuplicate = await page.$$eval(".scenecell", (els) => els.length);
  await tap(page, '[data-action="duplicate-scene"]');
  await page.waitForFunction((before) => document.querySelectorAll(".scenecell").length === before + 1, {}, scenesBeforeDuplicate);
  const scenesAfterDuplicate = await page.$$eval(".scenecell", (els) => els.length);
  assertState(scenesAfterDuplicate === scenesBeforeDuplicate + 1, "session duplicate did not add a scene");
  await page.screenshot({ path: propsShotPath, fullPage: true });

  await tap(page, ".sheet-bar .close");
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));
  await tap(page, ".seg .opt:nth-child(2)");
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

  await longPress(page, '.arr-thead[data-track="drums"]');
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Track Options");
  await tap(page, ".sheet-bar .close");
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));
  await tap(page, ".arr-corner .view-mix");
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Mixer");
  const mixerText = await page.$eval("#sheet", (el) => el.textContent);
  assertState(mixerText.includes("echo"), "mixer missing echo send");
  assertState(mixerText.includes("Master") && mixerText.includes("safe chain"), "mixer missing master strip");
  await page.screenshot({ path: mixerShotPath, fullPage: true });
  await tap(page, ".sheet-bar .close");
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));

  await tap(page, '[data-action="open-export"]');
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Export");
  const exportText = await page.$eval("#sheet", (el) => el.textContent);
  assertState(exportText.includes("Download Project") && exportText.includes("Master WAV"), "export sheet missing grouped project/audio actions");
  await tap(page, '[data-action="save-local-project"]');
  await page.waitForFunction(() => document.querySelector(".exp-status")?.textContent.includes("Local snapshot saved"));
  await page.evaluate(() => document.querySelector('[data-action="export-master-wav"]').click());
  await page.waitForFunction(() => document.querySelector(".exp-status")?.textContent.includes("Master exported"), { timeout: 20000 });
  await page.screenshot({ path: exportShotPath, fullPage: true });
  await tap(page, ".sheet-bar .close");
  await page.waitForFunction(() => !document.querySelector("#sheet")?.classList.contains("open"));

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
  assertState(errors.length === 0, `runtime errors:\n${errors.join("\n")}`);
  console.log(`smoke ok: ${propsShotPath}`);
  console.log(`smoke ok: ${mixerShotPath}`);
  console.log(`smoke ok: ${exportShotPath}`);
  console.log(`smoke ok: ${shotPath}`);
} finally {
  if (browser) await browser.close();
  if (preview) await preview.stop();
}
