# Pear / Bare Runtime Compatibility

Pear desktop apps run on the **Bare** runtime, not Node.js. Bare provides its own set of built-in modules (`bare-fs`, `bare-crypto`, `bare-path`, etc.) but does not support Node.js's `node:*` import specifiers. Our TypeScript source uses `node:*` imports so that tests and the CLI server run on standard Node.js. The esbuild post-build step in `esbuild.config.js` patches the compiled output so it works in both environments.

## Problems and workarounds

### 1. `node:*` imports don't exist in Bare

Bare has equivalent packages (`bare-fs`, `bare-crypto`, `bare-events`, `bare-os`, `bare-path`) published to npm. Static ESM imports resolve fine when the packages are in `node_modules`.

**Workaround:** Post-build string replacement in `esbuild.config.js` rewrites `"node:crypto"` → `"bare-crypto"`, etc. in the compiled `lib/*.js` files. The source stays Node.js-native for tests.

### 2. `createRequire` from `bare-module` can't resolve from `pear://` URLs

`sync-engine.ts` uses `createRequire(import.meta.url)` + `require("node:fs")` to get a mutable reference to `fs` for monkey-patching `fs.watch`. In the Pear runtime, `import.meta.url` is a `pear://dev/...` URL, and `bare-module`'s `createRequire` can't resolve module names from that protocol.

**Workaround:** The post-build step replaces the entire `createRequire` pattern with `import mutableFs from "bare-fs"`. The default import from a CJS package gives a mutable object, so the `fs.watch` patching still works.

### 3. Pear's module resolver can't find `node_modules` from nested output paths

When esbuild entry points span `src/` and `src/lib/`, the common root is `src/`, so `src/lib/sync-engine.ts` compiles to `lib/lib/sync-engine.js`. Pear's module resolver fails to walk up from `pear://dev/lib/lib/` to find `node_modules/` at the project root.

**Workaround:** Split the esbuild lib build into two steps with explicit `outbase` so all output lands flat in `lib/`. A second set of string replacements fixes the cross-references (`"./lib/manifest-store.js"` → `"./manifest-store.js"`).

## Summary of post-build patches

All patches live in `esbuild.config.js` in the `nodeToBareMappings` array:

| Original (in compiled JS) | Replaced with | Reason |
|---|---|---|
| `import { createRequire } from "node:module"` | `import mutableFs from "bare-fs"` | createRequire can't resolve from pear:// |
| `const require2 = createRequire(…); const mutableFs = require2("node:fs");` | *(removed)* | see above |
| `"node:crypto"` | `"bare-crypto"` | Bare built-in |
| `"node:events"` | `"bare-events"` | Bare built-in |
| `"node:fs/promises"` | `"bare-fs/promises"` | Bare built-in |
| `"node:os"` | `"bare-os"` | Bare built-in |
| `"node:path"` | `"bare-path"` | Bare built-in |
| `"./lib/manifest-store.js"` | `"./manifest-store.js"` | Flat output |
| `"./lib/sync-engine.js"` | `"./sync-engine.js"` | Flat output |

## Running the Pear app

```sh
node esbuild.config.js                                              # build + patch
"$HOME/Library/Application Support/pear/bin/pear" run --dev .       # launch
```

Pear installs to `~/Library/Application Support/pear/bin/pear` on macOS. It is not an npm package and cannot be run via `npx`.
