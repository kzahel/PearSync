import { build } from "esbuild";

// Build lib (sync engine + engine manager, runs in Pear main process)
await build({
  entryPoints: [
    "src/lib/sync-engine.ts",
    "src/lib/file-utils.ts",
    "src/engine-manager.ts",
    "src/engine-bridge.ts",
    "src/ring-buffer.ts",
    "src/api-types.ts",
  ],
  outdir: "lib",
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: true,
  bundle: false,
});

// Build UI (runs in Pear Chromium renderer)
await build({
  entryPoints: ["src/ui/app.ts"],
  outdir: "ui",
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  bundle: true,
  external: ["pear-electron"],
});

console.log("Build complete");
