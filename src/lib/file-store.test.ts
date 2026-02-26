import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "./file-store";

const BLOCK_SIZE = 64 * 1024; // 64KB default

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pearsync-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("FileStore — core functionality", () => {
  it("writes a small file and reads it back", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const data = Buffer.from("hello world");
    const meta = await fs.writeFile(data);

    expect(meta.offset).toBe(0);
    expect(meta.length).toBe(1);
    expect(meta.size).toBe(data.length);

    const result = await fs.readFile(meta.offset, meta.length);
    expect(result.equals(data)).toBe(true);

    await fs.close();
    await store.close();
  });

  it("writes a large file (multiple blocks) and reads it back", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const data = randomBytes(BLOCK_SIZE * 3 + 1000);
    const meta = await fs.writeFile(data);

    expect(meta.length).toBe(4);
    expect(meta.size).toBe(data.length);

    const result = await fs.readFile(meta.offset, meta.length);
    expect(result.equals(data)).toBe(true);

    await fs.close();
    await store.close();
  });

  it("writes an empty file and reads it back", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const data = Buffer.alloc(0);
    const meta = await fs.writeFile(data);

    expect(meta.offset).toBe(0);
    expect(meta.length).toBe(0);
    expect(meta.size).toBe(0);

    const result = await fs.readFile(meta.offset, meta.length);
    expect(result.length).toBe(0);

    await fs.close();
    await store.close();
  });

  it("writes multiple files sequentially and reads each correctly", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const file1 = Buffer.from("first file content");
    const file2 = randomBytes(BLOCK_SIZE * 2 + 500);
    const file3 = Buffer.from("third");

    const meta1 = await fs.writeFile(file1);
    const meta2 = await fs.writeFile(file2);
    const meta3 = await fs.writeFile(file3);

    expect(meta1.offset).toBe(0);
    expect(meta2.offset).toBe(1);
    expect(meta3.offset).toBe(4); // 1 + 3 blocks

    const result1 = await fs.readFile(meta1.offset, meta1.length);
    const result2 = await fs.readFile(meta2.offset, meta2.length);
    const result3 = await fs.readFile(meta3.offset, meta3.length);

    expect(result1.equals(file1)).toBe(true);
    expect(result2.equals(file2)).toBe(true);
    expect(result3.equals(file3)).toBe(true);

    await fs.close();
    await store.close();
  });

  it("returns consistent hash for same content", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const data = Buffer.from("deterministic content");
    const meta1 = await fs.writeFile(data);
    const meta2 = await fs.writeFile(Buffer.from("deterministic content"));

    expect(meta1.hash).toBe(meta2.hash);
    expect(meta1.hash).toHaveLength(64);

    await fs.close();
    await store.close();
  });

  it("returns different hashes for different content", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const meta1 = await fs.writeFile(Buffer.from("alpha"));
    const meta2 = await fs.writeFile(Buffer.from("beta"));

    expect(meta1.hash).not.toBe(meta2.hash);

    await fs.close();
    await store.close();
  });
});

describe("FileStore — chunking", () => {
  it("block count matches expected for given file size", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store, { blockSize: 100 });
    await fs.ready();

    const data = Buffer.alloc(350); // 100 + 100 + 100 + 50 = 4 blocks
    const meta = await fs.writeFile(data);

    expect(meta.length).toBe(4);

    await fs.close();
    await store.close();
  });

  it("handles file size that is exact multiple of block size", async () => {
    const store = new Corestore(await makeTmpDir());
    const blockSize = 256;
    const fs = new FileStore(store, { blockSize });
    await fs.ready();

    const data = randomBytes(blockSize * 5);
    const meta = await fs.writeFile(data);

    expect(meta.length).toBe(5);
    expect(meta.size).toBe(blockSize * 5);

    const result = await fs.readFile(meta.offset, meta.length);
    expect(result.equals(data)).toBe(true);

    await fs.close();
    await store.close();
  });

  it("handles file size that is NOT exact multiple of block size", async () => {
    const store = new Corestore(await makeTmpDir());
    const blockSize = 256;
    const fs = new FileStore(store, { blockSize });
    await fs.ready();

    const data = randomBytes(blockSize * 5 + 7);
    const meta = await fs.writeFile(data);

    expect(meta.length).toBe(6);
    expect(meta.size).toBe(blockSize * 5 + 7);

    const result = await fs.readFile(meta.offset, meta.length);
    expect(result.equals(data)).toBe(true);

    await fs.close();
    await store.close();
  });

  it("preserves data at chunk boundaries", async () => {
    const store = new Corestore(await makeTmpDir());
    const blockSize = 8;
    const fs = new FileStore(store, { blockSize });
    await fs.ready();

    // Create data with known bytes at boundaries
    const data = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcd"); // 30 bytes
    const meta = await fs.writeFile(data);

    expect(meta.length).toBe(4); // 8 + 8 + 8 + 6

    const result = await fs.readFile(meta.offset, meta.length);
    expect(result.toString()).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZabcd");

    await fs.close();
    await store.close();
  });
});

describe("FileStore — replication", () => {
  it("replicates a file from storeA to storeB", async () => {
    const storeA = new Corestore(await makeTmpDir());
    const fsA = new FileStore(storeA);
    await fsA.ready();

    const data = Buffer.from("replicated file content");
    const meta = await fsA.writeFile(data);

    // Set up replication
    const storeB = new Corestore(await makeTmpDir());
    const s1 = storeA.replicate(true);
    const s2 = storeB.replicate(false);
    s1.pipe(s2).pipe(s1);

    // Open same core on storeB by key (not by name)
    const coreB = storeB.get({ key: fsA.core.key });
    await coreB.ready();

    // Read from the replicated core
    const blocks: Buffer[] = [];
    for (let i = 0; i < meta.length; i++) {
      const block = await coreB.get(meta.offset + i);
      blocks.push(block!);
    }
    const result = Buffer.concat(blocks);
    expect(result.equals(data)).toBe(true);

    s1.destroy();
    s2.destroy();
    await fsA.close();
    await coreB.close();
    await storeA.close();
    await storeB.close();
  });

  it("replicates multiple files", async () => {
    const storeA = new Corestore(await makeTmpDir());
    const fsA = new FileStore(storeA);
    await fsA.ready();

    const file1 = Buffer.from("first replicated file");
    const file2 = randomBytes(BLOCK_SIZE * 2 + 100);
    const meta1 = await fsA.writeFile(file1);
    const meta2 = await fsA.writeFile(file2);

    // Set up replication
    const storeB = new Corestore(await makeTmpDir());
    const s1 = storeA.replicate(true);
    const s2 = storeB.replicate(false);
    s1.pipe(s2).pipe(s1);

    // Open same core on storeB by key
    const coreB = storeB.get({ key: fsA.core.key });
    await coreB.ready();

    // Read file1 from B
    const blocks1: Buffer[] = [];
    for (let i = 0; i < meta1.length; i++) {
      blocks1.push((await coreB.get(meta1.offset + i))!);
    }
    expect(Buffer.concat(blocks1).equals(file1)).toBe(true);

    // Read file2 from B
    const blocks2: Buffer[] = [];
    for (let i = 0; i < meta2.length; i++) {
      blocks2.push((await coreB.get(meta2.offset + i))!);
    }
    expect(Buffer.concat(blocks2).equals(file2)).toBe(true);

    s1.destroy();
    s2.destroy();
    await fsA.close();
    await coreB.close();
    await storeA.close();
    await storeB.close();
  });

  it("replicates files written after replication starts", async () => {
    const storeA = new Corestore(await makeTmpDir());
    const fsA = new FileStore(storeA);
    await fsA.ready();

    // Start replication BEFORE writing
    const storeB = new Corestore(await makeTmpDir());
    const s1 = storeA.replicate(true);
    const s2 = storeB.replicate(false);
    s1.pipe(s2).pipe(s1);

    // Open core on B by key
    const coreB = storeB.get({ key: fsA.core.key });
    await coreB.ready();

    // Write after replication is set up
    const data = Buffer.from("written after replication started");
    const meta = await fsA.writeFile(data);

    // Read from B — should replicate the new data
    const blocks: Buffer[] = [];
    for (let i = 0; i < meta.length; i++) {
      blocks.push((await coreB.get(meta.offset + i))!);
    }
    expect(Buffer.concat(blocks).equals(data)).toBe(true);

    s1.destroy();
    s2.destroy();
    await fsA.close();
    await coreB.close();
    await storeA.close();
    await storeB.close();
  });
});

describe("FileStore — edge cases", () => {
  it("handles a large file (10MB+)", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const data = randomBytes(10 * 1024 * 1024 + 42); // ~10MB
    const meta = await fs.writeFile(data);

    const expectedBlocks = Math.ceil(data.length / BLOCK_SIZE);
    expect(meta.length).toBe(expectedBlocks);
    expect(meta.size).toBe(data.length);

    const result = await fs.readFile(meta.offset, meta.length);
    expect(result.equals(data)).toBe(true);

    await fs.close();
    await store.close();
  });

  it("handles binary content (random bytes)", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const data = randomBytes(BLOCK_SIZE + 1);
    const meta = await fs.writeFile(data);

    const result = await fs.readFile(meta.offset, meta.length);
    expect(result.equals(data)).toBe(true);

    await fs.close();
    await store.close();
  });

  it("handles concurrent writes", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    const data1 = randomBytes(BLOCK_SIZE + 500);
    const data2 = randomBytes(BLOCK_SIZE * 2 + 300);

    // Write "simultaneously" — both start before either finishes
    const [meta1, meta2] = await Promise.all([fs.writeFile(data1), fs.writeFile(data2)]);

    // Both should succeed and have distinct offsets/lengths
    expect(meta1.size).toBe(data1.length);
    expect(meta2.size).toBe(data2.length);

    // Offsets should not overlap
    const range1 = [meta1.offset, meta1.offset + meta1.length];
    const range2 = [meta2.offset, meta2.offset + meta2.length];
    expect(range1[1] <= range2[0] || range2[1] <= range1[0]).toBe(true);

    // Both files should be readable and correct
    const result1 = await fs.readFile(meta1.offset, meta1.length);
    const result2 = await fs.readFile(meta2.offset, meta2.length);

    expect(result1.equals(data1)).toBe(true);
    expect(result2.equals(data2)).toBe(true);

    await fs.close();
    await store.close();
  });

  it("exposes the underlying core", async () => {
    const store = new Corestore(await makeTmpDir());
    const fs = new FileStore(store);
    await fs.ready();

    expect(fs.core).toBeDefined();
    expect(fs.core.key).toBeInstanceOf(Buffer);
    expect(fs.core.length).toBe(0);

    await fs.writeFile(Buffer.from("test"));
    expect(fs.core.length).toBe(1);

    await fs.close();
    await store.close();
  });
});
