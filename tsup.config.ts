import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli/main.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "bin",
  outExtension: () => ({ js: ".js" }),
  banner: {
    js: "#!/usr/bin/env node",
  },
  clean: true,
  dts: false,
  minify: false,
  sourcemap: false,
  splitting: false,
  noExternal: ["citty", "picocolors"],
  external: ["yaml"],
  treeshake: true,
});
