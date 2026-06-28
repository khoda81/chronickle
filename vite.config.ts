import { defineConfig } from "vite";

// Deploy target is https://khoda81.github.io/chronickle/, so the asset base
// path must be `/chronickle/` to resolve hashed bundles correctly.
export default defineConfig({
  base: "/chronickle/",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
