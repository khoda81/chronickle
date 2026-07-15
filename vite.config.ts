import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Deploy target is https://khoda81.github.io/chronickle/, so the asset base
// path must be `/chronickle/` to resolve hashed bundles correctly.
export default defineConfig({
  plugins: [solid()],
  base: "/chronickle/",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
