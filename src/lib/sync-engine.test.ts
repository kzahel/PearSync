import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm, unlink, writeFile, mkdir, utimes, readdir } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import testnet from "hyperdht/testnet";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateStore } from "./local-state-store";
import {
	type FileMetadata,
	type TombstoneMetadata,
	ManifestStore,
	isFileMetadata,
	isTombstone,
} from "./manifest-store";
import { type SyncEvent, SyncEngine, buildConflictPath } from "./sync-engine";

let tmpDirs: string[] = [];

async function makeTmpDir(prefix = "pearsync-sync-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

function waitForSync(
	engine: SyncEngine,
	predicate: (event: SyncEvent) => boolean,
	timeoutMs = 5000,
): Promise<SyncEvent> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Timed out waiting for sync event")),
			timeoutMs,
		);
		const handler = (event: SyncEvent) => {
			if (predicate(event)) {
				clearTimeout(timer);
				engine.removeListener("sync", handler);
				resolve(event);
			}
		};
		engine.on("sync", handler);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(
	condition: () => Promise<boolean> | boolean,
	timeoutMs = 15000,
	intervalMs = 50,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await condition()) return;
		await sleep(intervalMs);
	}
	throw new Error("Timed out waiting for condition");
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
		check();
	});
}

/** Wait for both sides to see 2 members after pairing. */
function waitForMembers(a: ManifestStore, b: ManifestStore): Promise<void> {
	return Promise.all([
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
	]).then(() => {});
}

afterEach(async () => {
	for (const dir of tmpDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
});

describe("SyncEngine — local changes", () => {
	it("local file change is detected and stored", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		const syncPromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update",
		);
		await engine.start();

		// Write a file directly to the sync folder
		await writeFile(join(syncDir, "hello.txt"), "hello world");

		const event = await syncPromise;
		expect(event.path).toBe("/hello.txt");
		expect(event.direction).toBe("local-to-remote");
		expect(event.type).toBe("update");

		// Verify manifest has the entry
		const manifest = engine.getManifest();
		const meta = await manifest.get("/hello.txt");
		expect(meta).not.toBeNull();
		expect(isTombstone(meta!)).toBe(false);
		const fileMeta = meta as FileMetadata;
		expect(fileMeta.size).toBe(11);
		expect(fileMeta.hash).toBe(
			createHash("sha256").update("hello world").digest("hex"),
		);

		// Verify FileStore has the blocks
		const fileStore = engine.getFileStore();
		const data = await fileStore.readFile(fileMeta.blocks.offset, fileMeta.blocks.length);
		expect(data.toString()).toBe("hello world");

		await engine.close();
		await store.close();
	});

	it("local file deletion is detected", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		// Write a file first, wait for sync
		const createPromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update" && e.path === "/to-delete.txt",
		);
		await engine.start();

		await writeFile(join(syncDir, "to-delete.txt"), "temporary");
		await createPromise;

		// Now delete the file
		const deletePromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "delete" && e.path === "/to-delete.txt",
		);
		await unlink(join(syncDir, "to-delete.txt"));
		const event = await deletePromise;
		expect(event.type).toBe("delete");

		// Verify manifest entry is now a tombstone
		const meta = await engine.getManifest().get("/to-delete.txt");
		expect(meta).not.toBeNull();
		expect(isTombstone(meta!)).toBe(true);

		await engine.close();
		await store.close();
	});

	it("local file modification is detected", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		await engine.start();

		await writeFile(join(syncDir, "modify.txt"), "version 1");
		const version1Hash = createHash("sha256").update("version 1").digest("hex");
		await waitForCondition(async () => {
			const meta = await engine.getManifest().get("/modify.txt");
			return meta !== null && isFileMetadata(meta) && meta.hash === version1Hash;
		});

		const firstMeta = await engine.getManifest().get("/modify.txt");
		expect(firstMeta).not.toBeNull();
		expect(isTombstone(firstMeta!)).toBe(false);
		const firstHash = (firstMeta as FileMetadata).hash;

		// Modify the file.
		await sleep(100);
		await writeFile(join(syncDir, "modify.txt"), "version 2");
		const version2Hash = createHash("sha256").update("version 2").digest("hex");
		await waitForCondition(async () => {
			const meta = await engine.getManifest().get("/modify.txt");
			return meta !== null && isFileMetadata(meta) && meta.hash === version2Hash;
		});

		const secondMeta = await engine.getManifest().get("/modify.txt");
		expect(secondMeta).not.toBeNull();
		expect(isTombstone(secondMeta!)).toBe(false);
		const secondFileMeta = secondMeta as FileMetadata;
		expect(secondFileMeta.hash).not.toBe(firstHash);
		expect(secondFileMeta.hash).toBe(
			createHash("sha256").update("version 2").digest("hex"),
		);

		await engine.close();
		await store.close();
	});

	it("unchanged files are skipped (same hash)", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		const createPromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update",
		);
		await engine.start();

		await writeFile(join(syncDir, "same.txt"), "unchanged content");
		await createPromise;

		const firstMeta = await engine.getManifest().get("/same.txt");
		expect(firstMeta).not.toBeNull();

		// Touch the file (rewrite with same content)
		let extraSyncFired = false;
		engine.on("sync", (event: SyncEvent) => {
			if (event.path === "/same.txt" && event.direction === "local-to-remote") {
				extraSyncFired = true;
			}
		});

		await sleep(100);
		await writeFile(join(syncDir, "same.txt"), "unchanged content");

		// Wait a bit to see if a sync event fires
		await sleep(1000);

		expect(extraSyncFired).toBe(false);

		// Manifest should still have same entry
		const secondMeta = await engine.getManifest().get("/same.txt");
		expect(secondMeta).not.toBeNull();
		expect(isTombstone(secondMeta!)).toBe(false);
		expect((secondMeta as FileMetadata).hash).toBe((firstMeta as FileMetadata).hash);

		await engine.close();
		await store.close();
	});
});

describe("SyncEngine — remote changes", () => {
	it("remote manifest update materializes file to disk", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();
		await engine.start();

		// Simulate a remote peer: create a separate core and write data
		const remoteCore = store.get({ name: "remote-peer-data" });
		await remoteCore.ready();

		const fileContent = Buffer.from("content from remote peer");
		const result = await remoteCore.append(fileContent);
		const offset = result.length - 1;

			const metadata: FileMetadata = {
				kind: "file",
				size: fileContent.length,
				mtime: Date.now(),
				hash: createHash("sha256").update(fileContent).digest("hex"),
				baseHash: null,
				seq: 1,
				writerKey: remoteCore.key.toString("hex"),
				blocks: { offset, length: 1 },
			};

		// Manually put into manifest as if a remote peer put it
		const manifest = engine.getManifest();
		const syncPromise = waitForSync(
			engine,
			(e) => e.direction === "remote-to-local" && e.path === "/remote-file.txt",
		);
		await manifest.put("/remote-file.txt", metadata);
		await syncPromise;

		// Verify file appeared on disk
		const diskContent = await readFile(join(syncDir, "remote-file.txt"));
		expect(diskContent.toString()).toBe("content from remote peer");

		await remoteCore.close();
		await engine.close();
		await store.close();
	});

	it("watcher suppression prevents feedback loops", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();
		await engine.start();

		// Simulate remote update that writes a file to disk
		const remoteCore = store.get({ name: "remote-peer-data-2" });
		await remoteCore.ready();

		const fileContent = Buffer.from("remote content for suppression test");
		const result = await remoteCore.append(fileContent);
		const offset = result.length - 1;

			const metadata: FileMetadata = {
				kind: "file",
				size: fileContent.length,
				mtime: Date.now(),
				hash: createHash("sha256").update(fileContent).digest("hex"),
				baseHash: null,
				seq: 1,
				writerKey: remoteCore.key.toString("hex"),
				blocks: { offset, length: 1 },
			};

		const syncPromise = waitForSync(
			engine,
			(e) => e.direction === "remote-to-local" && e.path === "/suppressed.txt",
		);
		await engine.getManifest().put("/suppressed.txt", metadata);
		await syncPromise;

		// Now listen for any local-to-remote sync on that file — it should NOT fire
		let feedbackFired = false;
		engine.on("sync", (event: SyncEvent) => {
			if (event.path === "/suppressed.txt" && event.direction === "local-to-remote") {
				feedbackFired = true;
			}
		});

		// Wait long enough for watcher to process
		await sleep(1500);

		expect(feedbackFired).toBe(false);

		await remoteCore.close();
		await engine.close();
		await store.close();
	});
});

describe("SyncEngine — end-to-end with testnet", () => {
	let tn: Awaited<ReturnType<typeof testnet>>;

	afterEach(async () => {
		if (tn) {
			for (const node of tn.nodes) await node.destroy();
		}
	});

	it("two paired SyncEngines: file in folder A appears in folder B", async () => {
		tn = await testnet(10);

		const storeDirA = await makeTmpDir();
		const syncDirA = await makeTmpDir("pearsync-folderA-");
		const storeDirB = await makeTmpDir();
		const syncDirB = await makeTmpDir("pearsync-folderB-");

		const storeA = new Corestore(storeDirA);
		const storeB = new Corestore(storeDirB);

		// Create paired ManifestStores
		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const invite = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });
		await waitForMembers(manifestA, manifestB);

		// Create SyncEngines with injected manifests
		const engineA = new SyncEngine(storeA, syncDirA, { manifest: manifestA });
		await engineA.ready();

		const engineB = new SyncEngine(storeB, syncDirB, { manifest: manifestB });
		await engineB.ready();

		await engineA.start();
		await engineB.start();

		// Engine A: write a file to folder A
		const syncBPromise = waitForSync(
			engineB,
			(e) => e.direction === "remote-to-local" && e.path === "/shared.txt",
			15000,
		);

		await writeFile(join(syncDirA, "shared.txt"), "hello from A");

		// Wait for file to appear in folder B
		await syncBPromise;

		const contentB = await readFile(join(syncDirB, "shared.txt"));
		expect(contentB.toString()).toBe("hello from A");

		// Engine B: write a different file to folder B
		await waitUntil(manifestB, async () => manifestB.writable);

		const syncAPromise = waitForSync(
			engineA,
			(e) => e.direction === "remote-to-local" && e.path === "/from-b.txt",
			15000,
		);

		await writeFile(join(syncDirB, "from-b.txt"), "hello from B");

		// Wait for file to appear in folder A
		await syncAPromise;

		const contentA = await readFile(join(syncDirA, "from-b.txt"));
		expect(contentA.toString()).toBe("hello from B");

		await engineA.close();
		await engineB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
	}, 30000);
});

// ===== Layer 5 Tests =====

describe("LocalStateStore", () => {
	it("state persists across load cycles", async () => {
		const syncDir = await makeTmpDir("pearsync-state-");

		const store1 = new LocalStateStore(syncDir);
		await store1.load();
		await store1.set("/foo.txt", {
			lastSyncedHash: "abc123",
			lastSyncedMtime: 1000,
			lastManifestHash: "abc123",
			lastManifestWriterKey: "writer1",
		});

		// Create a new instance and load from disk
		const store2 = new LocalStateStore(syncDir);
		await store2.load();
		const state = store2.get("/foo.txt");
		expect(state).toBeDefined();
		expect(state!.lastSyncedHash).toBe("abc123");
		expect(state!.lastSyncedMtime).toBe(1000);
		expect(state!.lastManifestWriterKey).toBe("writer1");
	});

	it("remove deletes state", async () => {
		const syncDir = await makeTmpDir("pearsync-state-");

		const store1 = new LocalStateStore(syncDir);
		await store1.load();
		await store1.set("/bar.txt", {
			lastSyncedHash: "def456",
			lastSyncedMtime: 2000,
			lastManifestHash: "def456",
			lastManifestWriterKey: "writer2",
		});
		await store1.remove("/bar.txt");
		expect(store1.get("/bar.txt")).toBeUndefined();

		// Reload from disk
		const store2 = new LocalStateStore(syncDir);
		await store2.load();
		expect(store2.get("/bar.txt")).toBeUndefined();
	});

	it("ignores .pearsync/ paths in watcher", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();
		await engine.start();

		// Write a file inside .pearsync/
		await mkdir(join(syncDir, ".pearsync"), { recursive: true });
		await writeFile(join(syncDir, ".pearsync", "something"), "internal data");

		let syncFired = false;
		engine.on("sync", (event: SyncEvent) => {
			if (event.path.includes(".pearsync")) {
				syncFired = true;
			}
		});

		await sleep(1000);
		expect(syncFired).toBe(false);

		// Verify no manifest entry for the .pearsync file
		const meta = await engine.getManifest().get("/.pearsync/something");
		expect(meta).toBeNull();

		await engine.close();
		await store.close();
	});
});

describe("Tombstones", () => {
	it("local delete writes tombstone to manifest", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		const createPromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update" && e.path === "/tombstone-test.txt",
		);
		await engine.start();

		await writeFile(join(syncDir, "tombstone-test.txt"), "will be deleted");
		await createPromise;

		await unlink(join(syncDir, "tombstone-test.txt"));
		await waitForCondition(async () => {
			const current = await engine.getManifest().get("/tombstone-test.txt");
			return current !== null && isTombstone(current);
		});

		const meta = await engine.getManifest().get("/tombstone-test.txt");
		expect(meta).not.toBeNull();
			expect(isTombstone(meta!)).toBe(true);
			if (!meta || !isTombstone(meta)) throw new Error("Expected tombstone metadata");
			expect(meta.writerKey).toBeDefined();
			expect(meta.mtime).toBeGreaterThan(0);

		await engine.close();
		await store.close();
	});

	it("tombstone replicates and deletes file on remote peer", async () => {
		const tn = await testnet(10);

		const storeDirA = await makeTmpDir();
		const syncDirA = await makeTmpDir("pearsync-folderA-");
		const storeDirB = await makeTmpDir();
		const syncDirB = await makeTmpDir("pearsync-folderB-");

		const storeA = new Corestore(storeDirA);
		const storeB = new Corestore(storeDirB);

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const invite = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });
		await waitForMembers(manifestA, manifestB);

		const engineA = new SyncEngine(storeA, syncDirA, { manifest: manifestA });
		await engineA.ready();
		const engineB = new SyncEngine(storeB, syncDirB, { manifest: manifestB });
		await engineB.ready();

		await engineA.start();
		await engineB.start();

		// A writes a file → wait for B to download it
		const syncBDownload = waitForSync(
			engineB,
			(e) => e.direction === "remote-to-local" && e.type === "update" && e.path === "/deleteme.txt",
			15000,
		);
		await writeFile(join(syncDirA, "deleteme.txt"), "going away");
		await syncBDownload;

		const contentB = await readFile(join(syncDirB, "deleteme.txt"));
		expect(contentB.toString()).toBe("going away");

		// A deletes the file
		await unlink(join(syncDirA, "deleteme.txt"));
		await waitForCondition(() => !existsSync(join(syncDirB, "deleteme.txt")));

		// File should be gone from B's folder
		expect(existsSync(join(syncDirB, "deleteme.txt"))).toBe(false);

		await engineA.close();
		await engineB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
		for (const node of tn.nodes) await node.destroy();
	}, 30000);

	it("edit wins over delete", async () => {
		const tn = await testnet(10);

		const storeDirA = await makeTmpDir();
		const syncDirA = await makeTmpDir("pearsync-folderA-");
		const storeDirB = await makeTmpDir();
		const syncDirB = await makeTmpDir("pearsync-folderB-");

		const storeA = new Corestore(storeDirA);
		const storeB = new Corestore(storeDirB);

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const invite = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });
		await waitForMembers(manifestA, manifestB);

		const engineA = new SyncEngine(storeA, syncDirA, { manifest: manifestA });
		await engineA.ready();
		const engineB = new SyncEngine(storeB, syncDirB, { manifest: manifestB });
		await engineB.ready();

		await engineA.start();
		await engineB.start();

		// A writes "original" → wait for B to download
		const syncBDownload = waitForSync(
			engineB,
			(e) => e.direction === "remote-to-local" && e.type === "update" && e.path === "/editwin.txt",
			15000,
		);
		await writeFile(join(syncDirA, "editwin.txt"), "original");
		await syncBDownload;

		// Stop both engines to simulate concurrent offline changes
		await engineA.stop();
		await engineB.stop();

		// A deletes the file
		await unlink(join(syncDirA, "editwin.txt"));

		// B modifies it
		await writeFile(join(syncDirB, "editwin.txt"), "edited");

		// Restart both engines
		await engineA.start();
		await engineB.start();

		// Wait for sync to settle
		await sleep(2000);

		// The file should exist on B (edit wins over delete)
		expect(existsSync(join(syncDirB, "editwin.txt"))).toBe(true);
		const content = await readFile(join(syncDirB, "editwin.txt"));
		expect(content.toString()).toBe("edited");

		await engineA.close();
		await engineB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
		for (const node of tn.nodes) await node.destroy();
	}, 30000);
});

describe("Conflict detection", () => {
	it("conflict filename format", () => {
		// Mock a fixed date for testing
		const originalToISOString = Date.prototype.toISOString;
		Date.prototype.toISOString = () => "2026-02-26T12:00:00.000Z";

		expect(buildConflictPath("/readme.txt", "a1b2c3d4")).toBe(
			"/readme.conflict-2026-02-26-a1b2c3d4.txt",
		);
		expect(buildConflictPath("/photos/cat.jpg", "deadbeef")).toBe(
			"/photos/cat.conflict-2026-02-26-deadbeef.jpg",
		);
		expect(buildConflictPath("/Makefile", "abc12345")).toBe(
			"/Makefile.conflict-2026-02-26-abc12345",
		);

		Date.prototype.toISOString = originalToISOString;
	});

	it("simultaneous edits create conflict copy", async () => {
		const tn = await testnet(10);

		const storeDirA = await makeTmpDir();
		const syncDirA = await makeTmpDir("pearsync-folderA-");
		const storeDirB = await makeTmpDir();
		const syncDirB = await makeTmpDir("pearsync-folderB-");

		const storeA = new Corestore(storeDirA);
		const storeB = new Corestore(storeDirB);

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const invite = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });
		await waitForMembers(manifestA, manifestB);

		const engineA = new SyncEngine(storeA, syncDirA, { manifest: manifestA });
		await engineA.ready();
		const engineB = new SyncEngine(storeB, syncDirB, { manifest: manifestB });
		await engineB.ready();

		await engineA.start();
		await engineB.start();

		// A writes /doc.txt → wait for B to download
		const syncBDownload = waitForSync(
			engineB,
			(e) => e.direction === "remote-to-local" && e.type === "update" && e.path === "/doc.txt",
			15000,
		);
		await writeFile(join(syncDirA, "doc.txt"), "original content");
		await syncBDownload;

		// Stop both engines (simulate offline edits)
		await engineA.stop();
		await engineB.stop();

		// Both sides make different edits
		await writeFile(join(syncDirA, "doc.txt"), "A's edit");
		await writeFile(join(syncDirB, "doc.txt"), "B's edit");

		// Listen for conflict event
		const conflictPromise = new Promise<SyncEvent>((resolve) => {
			const handler = (event: SyncEvent) => {
				if (event.type === "conflict" && event.path === "/doc.txt") {
					engineA.removeListener("sync", handler);
					engineB.removeListener("sync", handler);
					resolve(event);
				}
			};
			engineA.on("sync", handler);
			engineB.on("sync", handler);
		});

		// Restart both engines
		await engineA.start();
		await engineB.start();

		const conflictEvent = await conflictPromise;
		expect(conflictEvent.type).toBe("conflict");
		expect(conflictEvent.conflictPath).toBeDefined();
		expect(conflictEvent.conflictPath).toMatch(/\.conflict-\d{4}-\d{2}-\d{2}-[a-f0-9]{8}\.txt$/);

		await engineA.close();
		await engineB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
		for (const node of tn.nodes) await node.destroy();
	}, 30000);

	it("same content edits do not conflict", async () => {
		const tn = await testnet(10);

		const storeDirA = await makeTmpDir();
		const syncDirA = await makeTmpDir("pearsync-folderA-");
		const storeDirB = await makeTmpDir();
		const syncDirB = await makeTmpDir("pearsync-folderB-");

		const storeA = new Corestore(storeDirA);
		const storeB = new Corestore(storeDirB);

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const invite = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });
		await waitForMembers(manifestA, manifestB);

		const engineA = new SyncEngine(storeA, syncDirA, { manifest: manifestA });
		await engineA.ready();
		const engineB = new SyncEngine(storeB, syncDirB, { manifest: manifestB });
		await engineB.ready();

		await engineA.start();
		await engineB.start();

		// A writes /same.txt → wait for B to download
		const syncBDownload = waitForSync(
			engineB,
			(e) => e.direction === "remote-to-local" && e.type === "update" && e.path === "/same.txt",
			15000,
		);
		await writeFile(join(syncDirA, "same.txt"), "original");
		await syncBDownload;

		// Stop both
		await engineA.stop();
		await engineB.stop();

		// Both write the SAME content
		await writeFile(join(syncDirA, "same.txt"), "identical edit");
		await writeFile(join(syncDirB, "same.txt"), "identical edit");

		// Listen for conflict (should NOT fire)
		let conflictFired = false;
		const conflictHandler = (event: SyncEvent) => {
			if (event.type === "conflict") conflictFired = true;
		};
		engineA.on("sync", conflictHandler);
		engineB.on("sync", conflictHandler);

		await engineA.start();
		await engineB.start();

		await sleep(2000);

		expect(conflictFired).toBe(false);

		// No conflict files should exist
		const { readdir } = await import("node:fs/promises");
		const filesA = await readdir(syncDirA);
		const filesB = await readdir(syncDirB);
		expect(filesA.filter((f) => f.includes(".conflict-"))).toHaveLength(0);
		expect(filesB.filter((f) => f.includes(".conflict-"))).toHaveLength(0);

		await engineA.close();
		await engineB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
		for (const node of tn.nodes) await node.destroy();
	}, 30000);
});

describe("Peer names", () => {
	it("peer name is registered on startup", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();
		await engine.start();

		const manifest = engine.getManifest();
		const writerKey = manifest.writerKey;
		const peerEntry = await manifest.get(`__peer:${writerKey}`);
		expect(peerEntry).not.toBeNull();
		expect((peerEntry as unknown as { name: string }).name).toBe(writerKey.slice(0, 8));

		await engine.close();
		await store.close();
	});

	it("peer names are visible to remote peer", async () => {
		const tn = await testnet(10);

		const storeDirA = await makeTmpDir();
		const syncDirA = await makeTmpDir("pearsync-folderA-");
		const storeDirB = await makeTmpDir();
		const syncDirB = await makeTmpDir("pearsync-folderB-");

		const storeA = new Corestore(storeDirA);
		const storeB = new Corestore(storeDirB);

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const invite = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });
		await waitForMembers(manifestA, manifestB);

		const engineA = new SyncEngine(storeA, syncDirA, { manifest: manifestA });
		await engineA.ready();
		const engineB = new SyncEngine(storeB, syncDirB, { manifest: manifestB });
		await engineB.ready();

		await engineA.start();
		await engineB.start();

		// Wait for replication to settle
		await sleep(2000);

		// B should see A's peer name
		const aWriterKey = manifestA.writerKey;
		const peerEntryOnB = await manifestB.get(`__peer:${aWriterKey}`);
		expect(peerEntryOnB).not.toBeNull();
		expect((peerEntryOnB as unknown as { name: string }).name).toBe(aWriterKey.slice(0, 8));

		await engineA.close();
		await engineB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
		for (const node of tn.nodes) await node.destroy();
	}, 30000);
});

describe("Deletion propagation", () => {
	it("remote deletion of unmodified file removes it locally", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		await engine.start();

		await writeFile(join(syncDir, "to-remote-delete.txt"), "content");
		await waitForCondition(async () => {
			const meta = await engine.getManifest().get("/to-remote-delete.txt");
			return meta !== null && isFileMetadata(meta);
		});

		// Simulate a remote peer writing a tombstone
		const remoteWriterKey = "deadbeef".repeat(8);
		const manifest = engine.getManifest();

		await manifest.putTombstone("/to-remote-delete.txt", remoteWriterKey);
		await waitForCondition(() => !existsSync(join(syncDir, "to-remote-delete.txt")));

		expect(existsSync(join(syncDir, "to-remote-delete.txt"))).toBe(false);

		await engine.close();
		await store.close();
	});

	it("remote deletion of locally-modified file does NOT delete", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		const createPromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update" && e.path === "/keep-me.txt",
			15000,
		);
		await engine.start();

		await writeFile(join(syncDir, "keep-me.txt"), "original");
		await createPromise;

		// Locally modify the file (bypass watcher by writing directly)
		await engine.stop();
		await writeFile(join(syncDir, "keep-me.txt"), "locally modified");

		// Simulate a remote tombstone
		const remoteWriterKey = "deadbeef".repeat(8);
		const manifest = engine.getManifest();
		await manifest.putTombstone("/keep-me.txt", remoteWriterKey);

		// Restart to trigger remote change handling
		await engine.start();

		await sleep(2000);

		// File should still exist (edit wins over delete)
		expect(existsSync(join(syncDir, "keep-me.txt"))).toBe(true);
		const content = await readFile(join(syncDir, "keep-me.txt"));
		expect(content.toString()).toBe("locally modified");

		await engine.close();
		await store.close();
	});

	it("new local file not in manifest is uploaded, not deleted", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		const syncPromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update" && e.path === "/brand-new.txt",
			15000,
		);
		await engine.start();

		await writeFile(join(syncDir, "brand-new.txt"), "new file content");
		await syncPromise;

		// Verify it was uploaded, not deleted
		const meta = await engine.getManifest().get("/brand-new.txt");
		expect(meta).not.toBeNull();
		expect(isTombstone(meta!)).toBe(false);
		expect((meta as FileMetadata).hash).toBe(
			createHash("sha256").update("new file content").digest("hex"),
		);

		await engine.close();
		await store.close();
	});
});

describe("Revision-based reconciliation", () => {
	it("conflict resolution does not use mtime to override remote manifest winner", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

			await engine.start();
			await writeFile(join(syncDir, "clock-skew.txt"), "base");
			const baseHashExpected = createHash("sha256").update("base").digest("hex");
			await waitForCondition(async () => {
				const meta = await engine.getManifest().get("/clock-skew.txt");
				return meta !== null && isFileMetadata(meta) && meta.hash === baseHashExpected;
			});

			const baseMeta = await engine.getManifest().get("/clock-skew.txt");
			expect(baseMeta).not.toBeNull();
			expect(isFileMetadata(baseMeta!)).toBe(true);
			const baseFile = baseMeta as FileMetadata;
			const baseHash = baseFile.hash;

		await engine.stop();

		// Local divergent edit with very high mtime to simulate clock skew.
		await writeFile(join(syncDir, "clock-skew.txt"), "local-edit");
		const farFuture = new Date("2100-01-01T00:00:00.000Z");
		await utimes(join(syncDir, "clock-skew.txt"), farFuture, farFuture);

		// Remote divergent edit with very old mtime (would lose under pure mtime logic).
		const remoteCore = store.get({ name: "remote-skew-core" });
		await remoteCore.ready();
		const remoteData = Buffer.from("remote-edit");
		const append = await remoteCore.append(remoteData);
			const metadata: FileMetadata = {
				kind: "file",
				size: remoteData.length,
				mtime: 1,
				hash: createHash("sha256").update(remoteData).digest("hex"),
				writerKey: remoteCore.key.toString("hex"),
				blocks: { offset: append.length - 1, length: 1 },
				baseHash,
				seq: baseFile.seq + 1,
			};
			await engine.getManifest().put("/clock-skew.txt", metadata);

			await engine.start();
			await waitForCondition(async () => {
				const current = await readFile(join(syncDir, "clock-skew.txt"), "utf-8");
				return current === "remote-edit";
			});

			const winner = await readFile(join(syncDir, "clock-skew.txt"), "utf-8");
			expect(winner).toBe("remote-edit");

		const files = await readdir(syncDir);
		const conflictName = files.find((name) => name.startsWith("clock-skew.conflict-"));
		expect(conflictName).toBeDefined();
		const conflictContents = await readFile(join(syncDir, conflictName!), "utf-8");
		expect(conflictContents).toBe("local-edit");

		await remoteCore.close();
		await engine.close();
		await store.close();
	});

	it("ignores stale tombstones that do not match current synced base hash", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();
		await engine.start();

		const baseSync = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update" && e.path === "/stale-delete.txt",
			15000,
		);
		await writeFile(join(syncDir, "stale-delete.txt"), "v1");
		await baseSync;

		const remoteCore = store.get({ name: "remote-stale-tombstone-core" });
		await remoteCore.ready();
		const remoteV2 = Buffer.from("v2");
		const append = await remoteCore.append(remoteV2);
		const v1Hash = createHash("sha256").update("v1").digest("hex");
		const v2Hash = createHash("sha256").update("v2").digest("hex");

			const v2Meta: FileMetadata = {
				kind: "file",
				size: remoteV2.length,
				mtime: Date.now(),
				hash: v2Hash,
				writerKey: remoteCore.key.toString("hex"),
				blocks: { offset: append.length - 1, length: 1 },
				baseHash: v1Hash,
				seq: 2,
			};
		const downloadV2 = waitForSync(
			engine,
			(e) => e.direction === "remote-to-local" && e.type === "update" && e.path === "/stale-delete.txt",
			15000,
		);
		await engine.getManifest().put("/stale-delete.txt", v2Meta);
		await downloadV2;

			const staleTombstone: TombstoneMetadata = {
				kind: "tombstone",
				deleted: true,
				mtime: Date.now() + 1,
				writerKey: "f".repeat(64),
				baseHash: v1Hash,
				seq: 3,
			};
			await engine.getManifest().put("/stale-delete.txt", staleTombstone);
		await sleep(1200);

		expect(existsSync(join(syncDir, "stale-delete.txt"))).toBe(true);
		const contents = await readFile(join(syncDir, "stale-delete.txt"), "utf-8");
		expect(contents).toBe("v2");

		await remoteCore.close();
		await engine.close();
		await store.close();
	});
});

describe("Startup reconciliation", () => {
	it("does not roll back remote update after local downtime", async () => {
		let tn: Awaited<ReturnType<typeof testnet>> | null = null;
		let storeA: Corestore | null = null;
		let storeB: Corestore | null = null;
		let manifestA: ManifestStore | null = null;
		let manifestB: ManifestStore | null = null;
		let engineA: SyncEngine | null = null;
		let engineB: SyncEngine | null = null;
		let syncDirA = "";
		let syncDirB = "";

		try {
			tn = await testnet(10);

			const storeDirA = await makeTmpDir();
			syncDirA = await makeTmpDir("pearsync-folderA-");
			const storeDirB = await makeTmpDir();
			syncDirB = await makeTmpDir("pearsync-folderB-");

			storeA = new Corestore(storeDirA);
			storeB = new Corestore(storeDirB);

			manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
			await manifestA.ready();
			const invite = await manifestA.createInvite();
			manifestB = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });
			await waitForMembers(manifestA, manifestB);

			engineA = new SyncEngine(storeA, syncDirA, { manifest: manifestA });
			engineB = new SyncEngine(storeB, syncDirB, { manifest: manifestB });
			await engineA.ready();
			await engineB.ready();
			await engineA.start();
			await engineB.start();

			const syncBDownload = waitForSync(
				engineB,
				(e) => e.direction === "remote-to-local" && e.type === "update" && e.path === "/doc.txt",
				15000,
			);
			await writeFile(join(syncDirA, "doc.txt"), "v1");
			await syncBDownload;

			// Let A settle local state before stopping.
			await sleep(1000);
			await engineA.stop();

			const syncBUpload = waitForSync(
				engineB,
				(e) => e.direction === "local-to-remote" && e.type === "update" && e.path === "/doc.txt",
				15000,
			);
			await writeFile(join(syncDirB, "doc.txt"), "v2");
			await syncBUpload;

				const v2Hash = createHash("sha256").update("v2").digest("hex");
				await waitUntil(manifestB, async () => {
					const meta = await manifestB!.get("/doc.txt");
					return meta !== null && isFileMetadata(meta) && meta.hash === v2Hash;
				});
				await waitUntil(manifestA, async () => {
					const meta = await manifestA!.get("/doc.txt");
					return meta !== null && isFileMetadata(meta) && meta.hash === v2Hash;
				});

			await engineA.start();
			await sleep(2500);

			const contentA = await readFile(join(syncDirA, "doc.txt"), "utf-8");
			const contentB = await readFile(join(syncDirB, "doc.txt"), "utf-8");

			expect(contentA).toBe("v2");
			expect(contentB).toBe("v2");
		} finally {
			if (engineA) await engineA.close();
			if (engineB) await engineB.close();
			if (manifestA) await manifestA.close();
			if (manifestB) await manifestB.close();
			if (storeA) await storeA.close();
			if (storeB) await storeB.close();
			if (tn) {
				for (const node of tn.nodes) await node.destroy();
			}
		}
	}, 60000);

	it("applies remote tombstone on restart when local file is unchanged", async () => {
		let tn: Awaited<ReturnType<typeof testnet>> | null = null;
		let storeA: Corestore | null = null;
		let storeB: Corestore | null = null;
		let manifestA: ManifestStore | null = null;
		let manifestB: ManifestStore | null = null;
		let engineA: SyncEngine | null = null;
		let engineB: SyncEngine | null = null;
		let syncDirA = "";
		let syncDirB = "";

		try {
			tn = await testnet(10);

			const storeDirA = await makeTmpDir();
			syncDirA = await makeTmpDir("pearsync-folderA-");
			const storeDirB = await makeTmpDir();
			syncDirB = await makeTmpDir("pearsync-folderB-");

			storeA = new Corestore(storeDirA);
			storeB = new Corestore(storeDirB);

			manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
			await manifestA.ready();
			const invite = await manifestA.createInvite();
			manifestB = await ManifestStore.pair(storeB, invite, { bootstrap: tn.bootstrap });
			await waitForMembers(manifestA, manifestB);

			engineA = new SyncEngine(storeA, syncDirA, { manifest: manifestA });
			engineB = new SyncEngine(storeB, syncDirB, { manifest: manifestB });
			await engineA.ready();
			await engineB.ready();
			await engineA.start();
			await engineB.start();

			const syncBDownload = waitForSync(
				engineB,
				(e) =>
					e.direction === "remote-to-local" && e.type === "update" && e.path === "/delete-me.txt",
				15000,
			);
			await writeFile(join(syncDirA, "delete-me.txt"), "to-delete");
			await syncBDownload;

			// Let A settle local state before stopping.
			await sleep(1000);
			await engineA.stop();

			const syncBDelete = waitForSync(
				engineB,
				(e) =>
					e.direction === "local-to-remote" && e.type === "delete" && e.path === "/delete-me.txt",
				15000,
			);
			await unlink(join(syncDirB, "delete-me.txt"));
			await syncBDelete;

			await waitUntil(manifestB, async () => {
				const meta = await manifestB!.get("/delete-me.txt");
				return meta !== null && isTombstone(meta);
			});
			await waitUntil(manifestA, async () => {
				const meta = await manifestA!.get("/delete-me.txt");
				return meta !== null && isTombstone(meta);
			});

			await engineA.start();
			await sleep(2500);

			expect(existsSync(join(syncDirA, "delete-me.txt"))).toBe(false);
			expect(existsSync(join(syncDirB, "delete-me.txt"))).toBe(false);

			const metaA = await manifestA.get("/delete-me.txt");
			expect(metaA).not.toBeNull();
			expect(isTombstone(metaA!)).toBe(true);
		} finally {
			if (engineA) await engineA.close();
			if (engineB) await engineB.close();
			if (manifestA) await manifestA.close();
			if (manifestB) await manifestB.close();
			if (storeA) await storeA.close();
			if (storeB) await storeB.close();
			if (tn) {
				for (const node of tn.nodes) await node.destroy();
			}
		}
	}, 60000);
});

describe("Reserved manifest key policy", () => {
	it("does not materialize system manifest keys without leading slash", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();
		await engine.start();

		const metadata: FileMetadata = {
			kind: "file",
			size: 8,
			mtime: Date.now(),
			hash: createHash("sha256").update("internal").digest("hex"),
			baseHash: null,
			seq: 1,
			writerKey: "a".repeat(64),
			blocks: { offset: 0, length: 1 },
		};

		await expect(engine.getManifest().put("__system-note", metadata)).rejects.toThrow();
		await sleep(1000);

		expect(existsSync(join(syncDir, "__system-note"))).toBe(false);

		await engine.close();
		await store.close();
	});

	it("syncs user files whose names begin with __ after slash normalization", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		const syncPromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update" && e.path === "/__user.txt",
			15000,
		);
		await engine.start();

		await writeFile(join(syncDir, "__user.txt"), "user file");
		await syncPromise;

		const meta = await engine.getManifest().get("/__user.txt");
		expect(meta).not.toBeNull();
		expect(isTombstone(meta!)).toBe(false);
		expect((meta as FileMetadata).hash).toBe(
			createHash("sha256").update("user file").digest("hex"),
		);

		await engine.close();
		await store.close();
	});
});
