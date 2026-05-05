import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  shims: true,
  clean: true,
  outDir: "dist",
  noExternal: ["@patch-cat/shared"],
});
