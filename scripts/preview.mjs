// Shared boot for the headless harnesses (smoke, calibrate, audit): build a
// production preview server and drive it with a real Chrome. Every harness
// judges the app the way DECISIONS says to — on the production build, never on
// the dev server.

import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function startPreview({ host, port, cwd = process.cwd() } = {}) {
  const child = spawn("npm", ["run", "preview", "--", "--host", host, "--port", String(port), "--strictPort"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => (output += chunk.toString());
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return {
    child,
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

// A page on the built app, with pageerror collection wired up. The caller gets
// the errors array so it can fail loudly instead of measuring a broken page.
export async function openApp({ chrome, url, protocolTimeout = 3_600_000 }) {
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--mute-audio"],
    protocolTimeout,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: "networkidle2" });
  await page.waitForFunction(() => !!window.__noodles);
  return { browser, page, errors };
}
