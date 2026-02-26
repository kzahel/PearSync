# Layer 1: Hypercore File Storage

## Context

You are working on PearSync, a P2P folder sync tool built on the Holepunch stack. Read `PLAN.md` for the full architecture. Read `CLAUDE.md` for development guidelines.

This is Layer 1 — the foundation. We need to validate that we can chunk files into Hypercores and read them back, and that two Corestores can replicate Hypercore data between each other locally.

## Reference Code

- `reference/hypercore/` — Hypercore source and tests (look at `test/` for API usage patterns)
- `reference/corestore/` — Corestore source and tests (look at how `store.replicate()` works)
- `reference/hyperdrive/` — Hyperdrive uses Hypercore+Hyperblobs internally, good reference for chunked file storage
- `node_modules/hypercore/` and `node_modules/corestore/` — installed versions

## What to Build

Build a `FileStore` class in `src/lib/file-store.ts` that:

1. Takes a Corestore instance
2. Creates/opens a named Hypercore for file data (`store.get({ name: 'file-data' })`)
3. Can write a file (Buffer) by chunking it into blocks and appending to the core
4. Can read a file back given a block offset and length
5. Returns metadata about the stored file (offset, length, size, hash)

### API sketch

```typescript
interface StoredFile {
  offset: number;   // starting block index
  length: number;   // number of blocks
  size: number;     // total bytes
  hash: string;     // sha256 of content
}

class FileStore {
  constructor(store: Corestore)
  async ready(): Promise<void>
  async writeFile(data: Buffer): Promise<StoredFile>
  async readFile(offset: number, length: number): Promise<Buffer>
  async close(): Promise<void>
  get core(): Hypercore  // the underlying core
}
```

## What to Test

Write comprehensive tests in `src/lib/file-store.test.ts` using vitest. Each test should use a temporary directory for the Corestore that gets cleaned up after.

### Core functionality tests:
- Write a small file (< 1 block), read it back, bytes match
- Write a large file (multiple blocks), read it back, bytes match
- Write an empty file (0 bytes), read it back
- Write multiple files sequentially, read each one back correctly by offset/length
- Hash is consistent for same content
- Hash differs for different content

### Chunking tests:
- Verify block count matches expected for given file size and block size
- Verify chunk boundaries are correct (no data loss at edges)
- Test with file sizes that are exact multiples of block size
- Test with file sizes that are NOT exact multiples

### Replication tests (this is the critical one):
- Create two Corestores (storeA, storeB) in separate temp directories
- Create a FileStore on storeA, write a file
- Replicate storeA ↔ storeB using `storeA.replicate(storeB.replicate(true))` (local pipe replication)
- On storeB, open the same Hypercore by key (not by name — name is local-only)
- Read the file from storeB's core and verify bytes match
- Test replication of multiple files
- Test that new files written after replication starts also replicate

### Edge cases:
- Very large file (10MB+) — verify it handles many blocks
- Binary content (random bytes, not just text)
- Concurrent writes — write two files "simultaneously" and verify both are correct

## Important Technical Notes

- **Corestore replication**: Use `const s1 = storeA.replicate(true); const s2 = storeB.replicate(false); s1.pipe(s2).pipe(s1)` for local pipe-based replication. Look at `reference/corestore/test/` for examples.
- **Hypercore by key vs name**: `store.get({ name: 'x' })` creates a core with a deterministic key derived from the store's primary key + the name. To open the same core on another store, you need to use `store.get({ key: core.key })` — names are not shared across stores.
- **Block size**: Use 64KB (65536 bytes) as default. Make it configurable.
- **Cleanup**: Tests must clean up temp directories. Use `fs.mkdtemp` for temp dirs and `fs.rm` with `{ recursive: true }` in afterEach/afterAll.
- The project uses ES modules (`"type": "module"` in package.json).
- Use `node:` prefix for Node built-in imports.

## Development Workflow

1. Read `CLAUDE.md` first for project conventions
2. Study the reference repos' test files to understand API patterns
3. Write the `FileStore` class
4. Write comprehensive tests
5. Run `npm run check` (tsc + biome + vitest) — everything must pass
6. Make sure CI will pass — the GitHub Actions workflow at `.github/workflows/ci.yml` runs `npm run check`
7. Commit the work

## Success Criteria

- `FileStore` class with clean TypeScript types
- All tests pass (`npm run check` is green)
- Replication test proves that file data written on one Corestore can be read from another after pipe-based local replication
- Code is clean, well-organized, follows existing project conventions
- No test flakiness — tests should be deterministic
