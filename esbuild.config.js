import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

// Build lib — two steps so everything outputs flat into lib/ (not lib/lib/).
// Pear's module resolver can't find node_modules from nested subdirs.
const sharedOpts = {
  outdir: "lib",
  format: "esm",
  platform: "node",
  target: "es2022",
  sourcemap: true,
  bundle: false,
};
await build({
  ...sharedOpts,
  entryPoints: [
    "src/lib/sync-engine.ts",
    "src/lib/file-utils.ts",
    "src/lib/file-store.ts",
    "src/lib/local-state-store.ts",
    "src/lib/manifest-store.ts",
  ],
  outbase: "src/lib",
});
await build({
  ...sharedOpts,
  entryPoints: [
    "src/engine-manager.ts",
    "src/engine-bridge.ts",
    "src/ring-buffer.ts",
    "src/api-types.ts",
  ],
  outbase: "src",
});

// Pear runs on the Bare runtime which doesn't have node:* builtins.
// Replace node:* imports with bare-* equivalents in compiled output.
// Order matters: node:fs/promises before node:fs.
const nodeToBareMappings = [
  // Replace createRequire + require("node:fs") pattern with a direct import.
  // Bare's createRequire can't resolve modules from pear:// URLs.
  // Default import from CJS bare-fs gives a mutable object (needed for watch patching).
  // These must run before the generic node:module / node:fs replacements below.
  ['import { createRequire } from "node:module";\n', 'import mutableFs from "bare-fs";\n'],
  [
    'const require2 = createRequire(import.meta.url);\nconst mutableFs = require2("node:fs");\n',
    "",
  ],
  // Static ESM imports: node:* → bare-* npm packages
  ['"node:crypto"', '"bare-crypto"'],
  ['"node:events"', '"bare-events"'],
  ['"node:fs/promises"', '"bare-fs/promises"'],
  ['"node:os"', '"bare-os"'],
  ['"node:path"', '"bare-path"'],
  // Fix cross-references: src/engine-*.ts import from ./lib/*.js but output is flat
  ['"./lib/manifest-store.js"', '"./manifest-store.js"'],
  ['"./lib/sync-engine.js"', '"./sync-engine.js"'],
];

async function patchDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await patchDir(fullPath);
    } else if (entry.name.endsWith(".js")) {
      let content = await readFile(fullPath, "utf-8");
      let changed = false;
      for (const [from, to] of nodeToBareMappings) {
        if (content.includes(from)) {
          content = content.replaceAll(from, to);
          changed = true;
        }
      }
      if (changed) await writeFile(fullPath, content);
    }
  }
}
await patchDir("lib");

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
