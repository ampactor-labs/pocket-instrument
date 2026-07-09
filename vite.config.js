import { defineConfig } from "vite";

// Modern mobile browsers are the target; keep the bundle lean and skip legacy
// transforms/polyfills for this phone-first prototype.
export default defineConfig({
  base: "/noodles/",
  build: { target: "esnext" },
  esbuild: { target: "esnext" },
  optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
