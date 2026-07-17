import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// The version shown on the ? page: package.json's version, plus the short
// commit it was built from so a bug report names an exact build. A dirty tree
// (uncommitted changes) is stamped so a hand-built preview never masquerades as
// a clean release. Git absent (a tarball build) falls back to the bare version.
const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url))).version;
const buildStamp = (() => {
  try {
    const sha = execSync("git rev-parse --short HEAD").toString().trim();
    const dirty = execSync("git status --porcelain").toString().trim() ? "-dev" : "";
    return `${sha}${dirty}`;
  } catch {
    return "nogit";
  }
})();

// Modern mobile browsers are the target; keep the bundle lean and skip legacy
// transforms/polyfills for this phone-first prototype.
export default defineConfig({
  base: "/noodles/",
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __BUILD__: JSON.stringify(buildStamp),
  },
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
  plugins: [
    // Installable and fully offline. The app already makes zero external
    // requests — Tone.js is bundled, there are no fonts or CDNs — and the
    // whole thing including the drum bank is about a megabyte, so precaching
    // everything is honest: installed, noodles works in airplane mode.
    VitePWA({
      registerType: "autoUpdate", // skipWaiting + clientsClaim; the app decides when to swap
      // Registration lives in src/main.js: it needs updateViaCache:"none"
      // (Pages serves sw.js with max-age=600 — the injected script would let a
      // launch check a ten-minute-old copy and miss a fresh deploy) and it has
      // to know whether swapping the running page is safe.
      injectRegister: null,
      workbox: {
        // The sample bank is the reason offline is real — without the WAVs the
        // drums fall back to the synth kit and it isn't the same instrument.
        globPatterns: ["**/*.{js,css,html,wav,png,svg,webmanifest}"],
        navigateFallback: "/noodles/index.html",
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: "noodles · a pocket instrument",
        short_name: "noodles",
        description:
          "An instrument that runs in your pocket. Tap play and there's a groove; roll the dice and it's a different song.",
        // standalone, not fullscreen: the browser chrome goes away, the status
        // bar stays. On a couch you still want to know the time and the battery.
        display: "standalone",
        start_url: "/noodles/",
        scope: "/noodles/",
        background_color: "#0e0e0f", // --bg: the launch splash matches the app
        theme_color: "#1b1b1d", // --bar: the system bar matches the transport
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
