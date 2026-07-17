// Home-screen icon generator: renders the clip-grid mark to public/icons/*.png.
//
// The mark is the product's own UI — four rounded clips in the four track
// colors on the app's dark tile. It reads at 48px, needs no emoji font, and
// anyone who has seen the session grid recognizes it instantly.
//
// Three outputs. 192 and 512 are the manifest's "any" icons and carry the
// full-bleed tile. 512-maskable pads the mark into the safe zone (Android
// crops maskable icons to whatever shape the launcher wants — a circle takes
// the corners off, so the art can only occupy the middle ~80%). 180 is the
// apple-touch-icon: iOS ignores manifests for home-screen icons and composites
// its own rounding, so it gets the full-bleed art too.
//
// Usage: node scripts/make-icons.mjs   (writes public/icons/, prints sizes)

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer-core";

const chrome = process.env.CHROME_BIN || "/usr/bin/google-chrome";
const outDir = path.join(process.cwd(), "public", "icons");

// The app's chrome (index.html --bg/--bar) and its four track colors (TRACKS
// in src/main.js). Kept in sync by hand; they are the product's identity and
// they do not move.
const TILE = "#0e0e0f";
const TRACK_COLORS = ["#e8b84b", "#54a8e0", "#cf6f9b", "#7bc86c"];

// pad: fraction of the tile left empty around the mark. Full-bleed art sits
// close to the edge; maskable art hides inside the safe zone.
function markSvg(size, pad) {
  const inner = size * (1 - pad * 2);
  const gap = inner * 0.075;
  const cell = (inner - gap) / 2;
  const radius = cell * 0.18;
  const clips = TRACK_COLORS.map((color, i) => {
    const x = size * pad + (i % 2) * (cell + gap);
    const y = size * pad + Math.floor(i / 2) * (cell + gap);
    return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="${radius}" fill="${color}"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" fill="${TILE}"/>
    ${clips}
  </svg>`;
}

const ICONS = [
  { name: "icon-192.png", size: 192, pad: 0.11 },
  { name: "icon-512.png", size: 512, pad: 0.11 },
  { name: "icon-512-maskable.png", size: 512, pad: 0.2 },
  { name: "apple-touch-icon.png", size: 180, pad: 0.11 },
];

await mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--force-color-profile=srgb"],
});
try {
  const page = await browser.newPage();
  for (const { name, size, pad } of ICONS) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0;background:${TILE}">${markSvg(size, pad)}</body></html>`,
      { waitUntil: "load" }
    );
    const png = await page.screenshot({ type: "png", omitBackground: false });
    await writeFile(path.join(outDir, name), png);
    console.log(`${name.padEnd(24)} ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
  }
} finally {
  await browser.close();
}
console.log(`\nwrote ${ICONS.length} icons to public/icons/`);
