import { mkdtemp, readFile, rm, unlink, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Corestore from "corestore";
import testnet from "hyperdht/testnet";
import { afterEach, describe, expect, it } from "vitest";
import { ManifestStore, isFileMetadata, isTombstone } from "./manifest-store";
import { SyncEngine } from "./sync-engine";

let tmpDirs: string[] = [];

async function makeTmpDir(prefix = "pearsync-resilience-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
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

async function waitForMembersCount(manifest: ManifestStore, count: number): Promise<void> {
	await waitForCondition(() => manifest.autopass.base.system.members === count, 20000, 100);
}

async function waitForFileContent(path: string, expected: string): Promise<void> {
	await waitForCondition(async () => {
		if (!existsSync(path)) return false;
		const content = await readFile(path, "utf-8");
		return content === expected;
	}, 20000, 100);
}

async function createTestnetOrSkip(): Promise<Awaited<ReturnType<typeof testnet>> | null> {
	try {
		return await testnet(10);
	} catch (err: unknown) {
		const e = err as NodeJS.ErrnoException;
		if (e.code === "EPERM" || String(e.message).includes("operation not permitted")) {
			return null;
		}
		throw err;
	}
}

afterEach(async () => {
	for (const dir of tmpDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
});

describe("Resilience and convergence", () => {
	it("three peers converge on writes from any peer", async () => {
		const tn = await createTestnetOrSkip();
		if (!tn) return;

		const storeA = new Corestore(await makeTmpDir("pearsync-storeA-"));
		const storeB = new Corestore(await makeTmpDir("pearsync-storeB-"));
		const storeC = new Corestore(await makeTmpDir("pearsync-storeC-"));
		const syncA = await makeTmpDir("pearsync-syncA-");
		const syncB = await makeTmpDir("pearsync-syncB-");
		const syncC = await makeTmpDir("pearsync-syncC-");

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();

		const inviteB = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, inviteB, { bootstrap: tn.bootstrap });
		await waitForMembersCount(manifestA, 2);
		await waitForMembersCount(manifestB, 2);

		const inviteC = await manifestA.createInvite();
		const manifestC = await ManifestStore.pair(storeC, inviteC, { bootstrap: tn.bootstrap });
		await waitForMembersCount(manifestA, 3);
		await waitForMembersCount(manifestB, 3);
		await waitForMembersCount(manifestC, 3);

		const engineA = new SyncEngine(storeA, syncA, { manifest: manifestA });
		const engineB = new SyncEngine(storeB, syncB, { manifest: manifestB });
		const engineC = new SyncEngine(storeC, syncC, { manifest: manifestC });
		await engineA.ready();
		await engineB.ready();
		await engineC.ready();
		await engineA.start();
		await engineB.start();
		await engineC.start();

		await writeFile(join(syncA, "mesh-a.txt"), "from A");
		await waitForFileContent(join(syncB, "mesh-a.txt"), "from A");
		await waitForFileContent(join(syncC, "mesh-a.txt"), "from A");

		await writeFile(join(syncC, "mesh-c.txt"), "from C");
		await waitForFileContent(join(syncA, "mesh-c.txt"), "from C");
		await waitForFileContent(join(syncB, "mesh-c.txt"), "from C");

		await engineA.close();
		await engineB.close();
		await engineC.close();
		await manifestA.close();
		await manifestB.close();
		await manifestC.close();
		await storeA.close();
		await storeB.close();
		await storeC.close();
		for (const node of tn.nodes) await node.destroy();
	}, 70000);

	it("late join peer catches up latest state including tombstones", async () => {
		const tn = await createTestnetOrSkip();
		if (!tn) return;

		const storeA = new Corestore(await makeTmpDir("pearsync-storeA-"));
		const storeB = new Corestore(await makeTmpDir("pearsync-storeB-"));
		const storeC = new Corestore(await makeTmpDir("pearsync-storeC-"));
		const syncA = await makeTmpDir("pearsync-syncA-");
		const syncB = await makeTmpDir("pearsync-syncB-");
		const syncC = await makeTmpDir("pearsync-syncC-");

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const inviteB = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, inviteB, { bootstrap: tn.bootstrap });
		await waitForMembersCount(manifestA, 2);
		await waitForMembersCount(manifestB, 2);

		const engineA = new SyncEngine(storeA, syncA, { manifest: manifestA });
		const engineB = new SyncEngine(storeB, syncB, { manifest: manifestB });
		await engineA.ready();
		await engineB.ready();
		await engineA.start();
		await engineB.start();

		await writeFile(join(syncA, "keep.txt"), "v1");
		await writeFile(join(syncA, "drop.txt"), "to-delete");
		await waitForFileContent(join(syncB, "keep.txt"), "v1");
		await waitForFileContent(join(syncB, "drop.txt"), "to-delete");

		await writeFile(join(syncA, "keep.txt"), "v2");
		await waitForFileContent(join(syncB, "keep.txt"), "v2");
		await unlink(join(syncA, "drop.txt"));
		await waitForCondition(() => !existsSync(join(syncB, "drop.txt")), 20000, 100);

		const inviteC = await manifestA.createInvite();
		const manifestC = await ManifestStore.pair(storeC, inviteC, { bootstrap: tn.bootstrap });
		await waitForMembersCount(manifestA, 3);
		await waitForMembersCount(manifestB, 3);
		await waitForMembersCount(manifestC, 3);

		const engineC = new SyncEngine(storeC, syncC, { manifest: manifestC });
		await engineC.ready();
		await engineC.start();

		await waitForFileContent(join(syncC, "keep.txt"), "v2");
		await waitForCondition(() => !existsSync(join(syncC, "drop.txt")), 20000, 100);

		const dropMeta = await manifestC.get("/drop.txt");
		expect(dropMeta).not.toBeNull();
		expect(isTombstone(dropMeta!)).toBe(true);
		const keepMeta = await manifestC.get("/keep.txt");
		expect(keepMeta).not.toBeNull();
		expect(isFileMetadata(keepMeta!)).toBe(true);

		await engineA.close();
		await engineB.close();
		await engineC.close();
		await manifestA.close();
		await manifestB.close();
		await manifestC.close();
		await storeA.close();
		await storeB.close();
		await storeC.close();
		for (const node of tn.nodes) await node.destroy();
	}, 70000);

	it("offline divergent edit creates conflict copy and preserves manifest winner after restart", async () => {
		const tn = await createTestnetOrSkip();
		if (!tn) return;

		const storeA = new Corestore(await makeTmpDir("pearsync-storeA-"));
		const storeB = new Corestore(await makeTmpDir("pearsync-storeB-"));
		const syncA = await makeTmpDir("pearsync-syncA-");
		const syncB = await makeTmpDir("pearsync-syncB-");

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const inviteB = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, inviteB, { bootstrap: tn.bootstrap });
		await waitForMembersCount(manifestA, 2);
		await waitForMembersCount(manifestB, 2);

		const engineA = new SyncEngine(storeA, syncA, { manifest: manifestA });
		const engineB = new SyncEngine(storeB, syncB, { manifest: manifestB });
		await engineA.ready();
		await engineB.ready();
		await engineA.start();
		await engineB.start();

		await writeFile(join(syncA, "conflict.txt"), "base");
		await waitForFileContent(join(syncB, "conflict.txt"), "base");

		await engineB.stop();
		await writeFile(join(syncA, "conflict.txt"), "remote-winner");
		const remoteWinnerHash = createHash("sha256").update("remote-winner").digest("hex");
		await waitForCondition(async () => {
			const meta = await manifestA.get("/conflict.txt");
			return meta !== null && isFileMetadata(meta) && meta.hash === remoteWinnerHash;
		}, 20000, 100);

		await writeFile(join(syncB, "conflict.txt"), "offline-local");
		await engineB.start();

		await waitForFileContent(join(syncB, "conflict.txt"), "remote-winner");
		await waitForCondition(async () => {
			const files = await readdir(syncB);
			const name = files.find((f) => f.startsWith("conflict.conflict-"));
			if (!name) return false;
			const content = await readFile(join(syncB, name), "utf-8");
			return content === "offline-local";
		}, 20000, 100);

		await engineA.close();
		await engineB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
		for (const node of tn.nodes) await node.destroy();
	}, 70000);

	it("rapid update stream converges to latest content on peers", async () => {
		const tn = await createTestnetOrSkip();
		if (!tn) return;

		const storeA = new Corestore(await makeTmpDir("pearsync-storeA-"));
		const storeB = new Corestore(await makeTmpDir("pearsync-storeB-"));
		const syncA = await makeTmpDir("pearsync-syncA-");
		const syncB = await makeTmpDir("pearsync-syncB-");

		const manifestA = ManifestStore.create(storeA, { bootstrap: tn.bootstrap });
		await manifestA.ready();
		const inviteB = await manifestA.createInvite();
		const manifestB = await ManifestStore.pair(storeB, inviteB, { bootstrap: tn.bootstrap });
		await waitForMembersCount(manifestA, 2);
		await waitForMembersCount(manifestB, 2);

		const engineA = new SyncEngine(storeA, syncA, { manifest: manifestA });
		const engineB = new SyncEngine(storeB, syncB, { manifest: manifestB });
		await engineA.ready();
		await engineB.ready();
		await engineA.start();
		await engineB.start();

		let latest = "";
		for (let i = 0; i < 25; i++) {
			latest = `payload-${i}`;
			await writeFile(join(syncA, "stream.txt"), latest);
		}

		await waitForFileContent(join(syncB, "stream.txt"), latest);

		const metaA = await manifestA.get("/stream.txt");
		const metaB = await manifestB.get("/stream.txt");
		expect(metaA).not.toBeNull();
		expect(metaB).not.toBeNull();
		expect(isFileMetadata(metaA!)).toBe(true);
		expect(isFileMetadata(metaB!)).toBe(true);
		if (!isFileMetadata(metaA!) || !isFileMetadata(metaB!)) {
			throw new Error("Expected file metadata");
		}
		expect(metaB.hash).toBe(metaA.hash);

		await engineA.close();
		await engineB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
		for (const node of tn.nodes) await node.destroy();
	}, 70000);
});
