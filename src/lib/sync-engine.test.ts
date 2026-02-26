import { createHash } from "node:crypto";
import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import testnet from "hyperdht/testnet";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FileMetadata } from "./manifest-store";
import { ManifestStore } from "./manifest-store";
import { type SyncEvent, SyncEngine } from "./sync-engine";

// Suppress localwatch bug: it throws when cleaning up watched dirs that were deleted.
// See node_modules/localwatch/index.js clearAll() — accesses node.stat.isDirectory() when stat is null.
const originalListeners = process.listeners("uncaughtException");
function localwatchErrorFilter(err: Error) {
	if (
		err instanceof TypeError &&
		err.message.includes("Cannot read properties of null") &&
		err.stack?.includes("localwatch")
	) {
		return; // swallow
	}
	// Re-throw non-localwatch errors
	throw err;
}
beforeAll(() => {
	process.on("uncaughtException", localwatchErrorFilter);
});
afterAll(() => {
	process.removeListener("uncaughtException", localwatchErrorFilter);
});

let tmpDirs: string[] = [];

async function makeTmpDir(prefix = "pearsync-sync-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

function waitForSync(
	engine: SyncEngine,
	predicate: (event: SyncEvent) => boolean,
	timeoutMs = 10000,
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
		expect(meta!.size).toBe(11);
		expect(meta!.hash).toBe(
			createHash("sha256").update("hello world").digest("hex"),
		);

		// Verify FileStore has the blocks
		const fileStore = engine.getFileStore();
		const data = await fileStore.readFile(meta!.blocks.offset, meta!.blocks.length);
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

		// Verify manifest entry is removed
		const meta = await engine.getManifest().get("/to-delete.txt");
		expect(meta).toBeNull();

		await engine.close();
		await store.close();
	});

	it("local file modification is detected", async () => {
		const storeDir = await makeTmpDir();
		const syncDir = await makeTmpDir("pearsync-folder-");

		const store = new Corestore(storeDir);
		const engine = new SyncEngine(store, syncDir);
		await engine.ready();

		const createPromise = waitForSync(
			engine,
			(e) => e.direction === "local-to-remote" && e.type === "update" && e.path === "/modify.txt",
		);
		await engine.start();

		await writeFile(join(syncDir, "modify.txt"), "version 1");
		await createPromise;

		const firstMeta = await engine.getManifest().get("/modify.txt");
		expect(firstMeta).not.toBeNull();
		const firstHash = firstMeta!.hash;

		// Modify the file
		const modifyPromise = waitForSync(
			engine,
			(e) =>
				e.direction === "local-to-remote" &&
				e.type === "update" &&
				e.path === "/modify.txt",
		);

		// Small delay to ensure watcher sees it as a new change
		await sleep(100);
		await writeFile(join(syncDir, "modify.txt"), "version 2");
		await modifyPromise;

		const secondMeta = await engine.getManifest().get("/modify.txt");
		expect(secondMeta).not.toBeNull();
		expect(secondMeta!.hash).not.toBe(firstHash);
		expect(secondMeta!.hash).toBe(
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
		expect(secondMeta!.hash).toBe(firstMeta!.hash);

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
			size: fileContent.length,
			mtime: Date.now(),
			hash: createHash("sha256").update(fileContent).digest("hex"),
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
			size: fileContent.length,
			mtime: Date.now(),
			hash: createHash("sha256").update(fileContent).digest("hex"),
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
			30000,
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
			30000,
		);

		await writeFile(join(syncDirB, "from-b.txt"), "hello from B");

		// Wait for file to appear in folder A
		await syncAPromise;

		const contentA = await readFile(join(syncDirA, "from-b.txt"));
		expect(contentA.toString()).toBe("hello from B");

		await engineA.close();
		await engineB.close();
		await storeA.close();
		await storeB.close();
	}, 60000);
});
