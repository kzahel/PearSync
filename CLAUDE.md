# PearSync — Development Guidelines

## After Every Change

Always run these checks after modifying any code:

```sh
npx tsc --noEmit          # Type check
npx biome check --write . # Format + lint (auto-fix)
npx vitest run            # Run tests
```

If any check fails, fix it before moving on.

## Project Structure

- `src/` — TypeScript source (all new code goes here)
  - `src/lib/` — Sync engine, file utilities (runs in Pear main process)
  - `src/ui/` — UI code (runs in Pear Chromium renderer)
  - `src/**/*.test.ts` — Tests (vitest)
- `lib/` — Compiled JS output from `src/lib/` (esbuild)
- `ui/` — Compiled JS output from `src/ui/` + static HTML/CSS
- `reference/` — Cloned Holepunch repos for reference (gitignored)
- `test-data/` — Temp data from test runs (gitignored)

## Build

```sh
node esbuild.config.js    # Compile TS → JS
pear run --dev .          # Run the Pear app in dev mode
```

## Tech Stack

- **TypeScript** with strict mode
- **esbuild** for TS → JS compilation
- **Biome** for linting and formatting
- **vitest** for testing
- **Pear** desktop runtime (pear-electron + pear-bridge)
- **Autopass** for P2P manifest, pairing, ACL
- **Hypercore/Corestore** for file content storage and replication
