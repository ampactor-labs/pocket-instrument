import { defineConfig } from "vite";

// esnext so top-level await (Pixi's async `app.init`) works. Modern mobile
// browsers (Chrome 89+, Safari 15+) support it; this is a phone-first prototype.
export default defineConfig({
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
