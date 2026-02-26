import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import testnet from "hyperdht/testnet";
import { afterEach, describe, expect, it } from "vitest";
import type { FileMetadata } from "./manifest-store";
import { ManifestStore } from "./manifest-store";

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pearsync-manifest-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeMetadata(overrides?: Partial<FileMetadata>): FileMetadata {
  const baseHash = overrides?.baseHash ?? null;
  const seq = overrides?.seq ?? 1;
  return {
    size: 1024,
    mtime: Date.now(),
    hash: "a".repeat(64),
    baseHash,
    seq,
    writerKey: "b".repeat(64),
    blocks: { offset: 0, length: 2 },
    ...overrides,
  };
}

function waitForUpdate(manifest: ManifestStore): Promise<void> {
  return new Promise((resolve) => manifest.once("update", resolve));
}

/** Wait until a condition is met, re-checking on each update event. */
function waitUntil(manifest: ManifestStore, condition: () => Promise<boolean>): Promise<void> {
  return new Promise((resolve) => {
    const check = async () => {
      if (await condition()) {
        manifest.removeListener("update", check);
        resolve();
      }
    };
    manifest.on("update", check);
    // Also check immediately in case it's already true
    check();
  });
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("ManifestStore — CRUD", () => {
  it("put an entry and get it back", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    const metadata = makeMetadata({ size: 2048, hash: "c".repeat(64) });
    await manifest.put("/docs/readme.txt", metadata);

    const result = await manifest.get("/docs/readme.txt");
    expect(result).toEqual(metadata);

    await manifest.close();
    await store.close();
  });

  it("put multiple entries and list returns all of them", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    const m1 = makeMetadata({ size: 100 });
    const m2 = makeMetadata({ size: 200 });
    const m3 = makeMetadata({ size: 300 });
    await manifest.put("/a.txt", m1);
    await manifest.put("/b.txt", m2);
    await manifest.put("/c.txt", m3);

    const entries = await manifest.list();
    expect(entries).toHaveLength(3);

    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["/a.txt", "/b.txt", "/c.txt"]);

    const byPath = Object.fromEntries(entries.map((e) => [e.path, e.metadata]));
    expect(byPath["/a.txt"]).toEqual(m1);
    expect(byPath["/b.txt"]).toEqual(m2);
    expect(byPath["/c.txt"]).toEqual(m3);

    await manifest.close();
    await store.close();
  });

  it("get a non-existent path returns null", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    const result = await manifest.get("/nonexistent.txt");
    expect(result).toBeNull();

    await manifest.close();
    await store.close();
  });

  it("remove an entry, get returns null after removal", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    await manifest.put("/file.txt", makeMetadata());
    expect(await manifest.get("/file.txt")).not.toBeNull();

    await manifest.remove("/file.txt");
    expect(await manifest.get("/file.txt")).toBeNull();

    await manifest.close();
    await store.close();
  });

  it("list after removal excludes the removed entry", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    await manifest.put("/keep.txt", makeMetadata({ size: 1 }));
    await manifest.put("/remove.txt", makeMetadata({ size: 2 }));
    await manifest.remove("/remove.txt");

    const entries = await manifest.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe("/keep.txt");

    await manifest.close();
    await store.close();
  });

  it("put the same path twice (update), get returns the latest metadata", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    const original = makeMetadata({ size: 100, mtime: 1000 });
    const updated = makeMetadata({ size: 200, mtime: 2000 });

    await manifest.put("/file.txt", original);
    await manifest.put("/file.txt", updated);

    const result = await manifest.get("/file.txt");
    expect(result).toEqual(updated);

    await manifest.close();
    await store.close();
  });

  it("paths are stored as-is (no normalization)", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    await manifest.put("relative/path.txt", makeMetadata());
    expect(await manifest.get("relative/path.txt")).not.toBeNull();
    expect(await manifest.get("/relative/path.txt")).toBeNull();

    await manifest.close();
    await store.close();
  });

  it("empty list on fresh instance", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    const entries = await manifest.list();
    expect(entries).toEqual([]);

    await manifest.close();
    await store.close();
  });
});

describe("ManifestStore — events", () => {
  it("update event fires after put", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    const updatePromise = waitForUpdate(manifest);
    await manifest.put("/file.txt", makeMetadata());
    await updatePromise;

    await manifest.close();
    await store.close();
  });

  it("update event fires after remove", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    await manifest.put("/file.txt", makeMetadata());
    // Drain any pending update event
    await waitForUpdate(manifest);

    const removeUpdatePromise = waitForUpdate(manifest);
    await manifest.remove("/file.txt");
    await removeUpdatePromise;

    await manifest.close();
    await store.close();
  });
});

describe("ManifestStore — edge cases", () => {
  it("handles large JSON metadata value", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    const metadata = makeMetadata({
      hash: "x".repeat(256),
      writerKey: "y".repeat(256),
      size: Number.MAX_SAFE_INTEGER,
    });
    await manifest.put("/large-meta.txt", metadata);

    const result = await manifest.get("/large-meta.txt");
    expect(result).toEqual(metadata);

    await manifest.close();
    await store.close();
  });

  it("handles special characters in path", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    const paths = ["/foo bar/baz.txt", "/émoji/🎉.txt", "/special/a&b=c.txt"];
    for (const p of paths) {
      await manifest.put(p, makeMetadata());
    }

    for (const p of paths) {
      expect(await manifest.get(p)).not.toBeNull();
    }

    const entries = await manifest.list();
    const entryPaths = entries.map((e) => e.path).sort();
    expect(entryPaths).toEqual([...paths].sort());

    await manifest.close();
    await store.close();
  });

  it("exposes writerKey and writable properties", async () => {
    const store = new Corestore(await makeTmpDir());
    const manifest = ManifestStore.create(store, { replicate: false });
    await manifest.ready();

    expect(typeof manifest.writerKey).toBe("string");
    expect(manifest.writerKey).toHaveLength(64);
    expect(manifest.writable).toBe(true);

    await manifest.close();
    await store.close();
  });
});

describe("ManifestStore — pairing & replication", () => {
  let tn: Awaited<ReturnType<typeof testnet>>;

  afterEach(async () => {
    if (tn) {
      for (const node of tn.nodes) {
        await node.destroy();
      }
    }
  });

  it("two instances pair and both become writable with 2 members", async () => {
    tn = await testnet(10);

    const storeA = new Corestore(await makeTmpDir());
    const a = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
    await a.ready();

    const invite = await a.createInvite();

    const storeB = new Corestore(await makeTmpDir());
    const b = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });

    // Wait for both sides to see 2 members
    await Promise.all([
      new Promise<void>((resolve) => {
        const check = () => {
          if (a.autopass.base.system.members === 2) {
            a.removeListener("update", check);
            resolve();
          }
        };
        if (a.autopass.base.system.members === 2) return resolve();
        a.on("update", check);
      }),
      new Promise<void>((resolve) => {
        const check = () => {
          if (b.autopass.base.system.members === 2) {
            b.removeListener("update", check);
            resolve();
          }
        };
        if (b.autopass.base.system.members === 2) return resolve();
        b.on("update", check);
      }),
    ]);

    expect(a.writable).toBe(true);
    expect(b.writable).toBe(true);
    expect(a.autopass.base.system.members).toBe(2);
    expect(b.autopass.base.system.members).toBe(2);

    await a.close();
    await b.close();
    await storeA.close();
    await storeB.close();
  });

  it("instance A puts an entry, instance B receives it", async () => {
    tn = await testnet(10);

    const storeA = new Corestore(await makeTmpDir());
    const a = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
    await a.ready();

    const invite = await a.createInvite();

    const storeB = new Corestore(await makeTmpDir());
    const b = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });

    // Wait for pairing to stabilize
    await new Promise<void>((resolve) => {
      const check = () => {
        if (b.autopass.base.system.members === 2) {
          b.removeListener("update", check);
          resolve();
        }
      };
      if (b.autopass.base.system.members === 2) return resolve();
      b.on("update", check);
    });

    const metadata = makeMetadata({ size: 4096, hash: "d".repeat(64) });
    await a.put("/synced-file.txt", metadata);
    await waitUntil(b, async () => (await b.get("/synced-file.txt")) !== null);

    const result = await b.get("/synced-file.txt");
    expect(result).toEqual(metadata);

    await a.close();
    await b.close();
    await storeA.close();
    await storeB.close();
  });

  it("instance B puts an entry, instance A receives it (bidirectional)", async () => {
    tn = await testnet(10);

    const storeA = new Corestore(await makeTmpDir());
    const a = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
    await a.ready();

    const invite = await a.createInvite();

    const storeB = new Corestore(await makeTmpDir());
    const b = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });

    // Wait for B to be a full writer
    await new Promise<void>((resolve) => {
      const check = () => {
        if (b.autopass.base.system.members === 2 && b.writable) {
          b.removeListener("update", check);
          resolve();
        }
      };
      if (b.autopass.base.system.members === 2 && b.writable) return resolve();
      b.on("update", check);
    });

    const metadata = makeMetadata({ size: 8192 });
    const updatePromise = waitForUpdate(a);
    await b.put("/from-b.txt", metadata);
    await updatePromise;

    const result = await a.get("/from-b.txt");
    expect(result).toEqual(metadata);

    await a.close();
    await b.close();
    await storeA.close();
    await storeB.close();
  });

  it("instance A puts multiple entries, instance B can list all of them", async () => {
    tn = await testnet(10);

    const storeA = new Corestore(await makeTmpDir());
    const a = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
    await a.ready();

    const invite = await a.createInvite();

    const storeB = new Corestore(await makeTmpDir());
    const b = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });

    // Wait for pairing
    await new Promise<void>((resolve) => {
      const check = () => {
        if (b.autopass.base.system.members === 2) {
          b.removeListener("update", check);
          resolve();
        }
      };
      if (b.autopass.base.system.members === 2) return resolve();
      b.on("update", check);
    });

    const files = [
      { path: "/one.txt", metadata: makeMetadata({ size: 1 }) },
      { path: "/two.txt", metadata: makeMetadata({ size: 2 }) },
      { path: "/three.txt", metadata: makeMetadata({ size: 3 }) },
    ];

    for (const f of files) {
      const updatePromise = waitForUpdate(b);
      await a.put(f.path, f.metadata);
      await updatePromise;
    }

    const entries = await b.list();
    expect(entries).toHaveLength(3);
    const paths = entries.map((e) => e.path).sort();
    expect(paths).toEqual(["/one.txt", "/three.txt", "/two.txt"]);

    await a.close();
    await b.close();
    await storeA.close();
    await storeB.close();
  });

  it("instance A removes an entry, instance B sees it removed", async () => {
    tn = await testnet(10);

    const storeA = new Corestore(await makeTmpDir());
    const a = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
    await a.ready();

    const invite = await a.createInvite();

    const storeB = new Corestore(await makeTmpDir());
    const b = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });

    // Wait for pairing
    await new Promise<void>((resolve) => {
      const check = () => {
        if (b.autopass.base.system.members === 2) {
          b.removeListener("update", check);
          resolve();
        }
      };
      if (b.autopass.base.system.members === 2) return resolve();
      b.on("update", check);
    });

    // Put then verify B can see it
    await a.put("/temp.txt", makeMetadata());
    await waitUntil(b, async () => (await b.get("/temp.txt")) !== null);
    expect(await b.get("/temp.txt")).not.toBeNull();

    // Remove and verify B sees the removal
    await a.remove("/temp.txt");
    await waitUntil(b, async () => (await b.get("/temp.txt")) === null);
    expect(await b.get("/temp.txt")).toBeNull();

    await a.close();
    await b.close();
    await storeA.close();
    await storeB.close();
  });
});
