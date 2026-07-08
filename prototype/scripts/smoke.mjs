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

  await longPress(page, '.clip.filled[data-track="drums"]');
  await page.waitForFunction(() => document.querySelector(".sheet-bar .title")?.textContent === "Clip Properties");
  await tap(page, '[data-action="mode-oneshot"]');
  await tap(page, '[data-action="follow-next"]');
  const badge = await page.$eval('.clip.filled[data-track="drums"] .clip-badge', (el) => el.textContent);
  assertState(badge.includes("1x") && badge.includes("next"), `unexpected launch badge: ${badge}`);
  await page.screenshot({ path: propsShotPath, fullPage: true });

  await tap(page, ".sheet-bar .close");
  await tap(page, ".seg .opt:nth-child(2)");
  const arrange = await page.$eval("#app", (app) => app.classList.contains("arrange"));
  assertState(arrange, "arrangement view did not open");

  await page.screenshot({ path: shotPath, fullPage: true });
  assertState(errors.length === 0, `runtime errors:\n${errors.join("\n")}`);
  console.log(`smoke ok: ${propsShotPath}`);
  console.log(`smoke ok: ${shotPath}`);
} finally {
  if (browser) await browser.close();
  if (preview) await preview.stop();
}
