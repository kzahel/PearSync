import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Corestore from "corestore";
import testnet from "hyperdht/testnet";
import { afterEach, describe, expect, it } from "vitest";
import { FileStore } from "./file-store";
import { type FileMetadata, type ManifestValue, ManifestStore } from "./manifest-store";

let tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pearsync-repl-test-"));
	tmpDirs.push(dir);
	return dir;
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

/** Create two paired ManifestStore + FileStore instances on a testnet. */
async function createPairedStores(bootstrap: { host: string; port: number }[]) {
	const storeA = new Corestore(await makeTmpDir());
	const manifestA = ManifestStore.create(storeA, { bootstrap });
	await manifestA.ready();

	const invite = await manifestA.createInvite();

	const storeB = new Corestore(await makeTmpDir());
	const manifestB = await ManifestStore.pair(storeB, invite, { bootstrap });

	await waitForMembers(manifestA, manifestB);

	const fileStoreA = new FileStore(storeA);
	await fileStoreA.ready();

	const fileStoreB = new FileStore(storeB);
	await fileStoreB.ready();

	return { storeA, storeB, manifestA, manifestB, fileStoreA, fileStoreB };
}

/** Build FileMetadata from a StoredFile and a FileStore's core key. */
function buildMetadata(
	stored: { offset: number; length: number; size: number; hash: string },
	coreKey: Buffer,
): FileMetadata {
	return {
		size: stored.size,
		mtime: Date.now(),
		hash: stored.hash,
		writerKey: coreKey.toString("hex"),
		blocks: {
			offset: stored.offset,
			length: stored.length,
		},
	};
}

/** Read file bytes from a remote core by key. */
async function readRemoteFile(
	store: InstanceType<typeof Corestore>,
	metadata: FileMetadata,
): Promise<Buffer> {
	const remoteCore = store.get({ key: Buffer.from(metadata.writerKey, "hex") });
	try {
		await remoteCore.ready();

		const blocks: Buffer[] = [];
		for (let i = 0; i < metadata.blocks.length; i++) {
			const block = await remoteCore.get(metadata.blocks.offset + i);
			blocks.push(block!);
		}
		return Buffer.concat(blocks);
	} finally {
		await remoteCore.close();
	}
}

describe("Layer 3 — local replication integration", () => {
	let tn: Awaited<ReturnType<typeof testnet>>;

	afterEach(async () => {
		if (tn) {
			for (const node of tn.nodes) await node.destroy();
		}
		for (const dir of tmpDirs) {
			await rm(dir, { recursive: true, force: true });
		}
		tmpDirs = [];
	});

	it("A writes file → B reads file bytes via manifest metadata", async () => {
		tn = await testnet(10);
		const { storeA, storeB, manifestA, manifestB, fileStoreA, fileStoreB } =
			await createPairedStores(tn.bootstrap);

		const data = Buffer.from("hello from peer A");
		const stored = await fileStoreA.writeFile(data);
		const metadata = buildMetadata(stored, fileStoreA.core.key);
		await manifestA.put("/hello.txt", metadata);

		await waitUntil(manifestB, async () => (await manifestB.get("/hello.txt")) !== null);

		const entry = await manifestB.get("/hello.txt");
		expect(entry).not.toBeNull();

		const fileData = await readRemoteFile(storeB, entry! as FileMetadata);
		expect(fileData.equals(data)).toBe(true);

		await fileStoreA.close();
		await fileStoreB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
	});

	it("B writes file → A reads bytes (bidirectional)", async () => {
		tn = await testnet(10);
		const { storeA, storeB, manifestA, manifestB, fileStoreA, fileStoreB } =
			await createPairedStores(tn.bootstrap);

		// Wait for B to be writable
		await waitUntil(manifestB, async () => manifestB.writable);

		const data = Buffer.from("hello from peer B");
		const stored = await fileStoreB.writeFile(data);
		const metadata = buildMetadata(stored, fileStoreB.core.key);
		await manifestB.put("/from-b.txt", metadata);

		await waitUntil(manifestA, async () => (await manifestA.get("/from-b.txt")) !== null);

		const entry = await manifestA.get("/from-b.txt");
		expect(entry).not.toBeNull();

		const fileData = await readRemoteFile(storeA, entry! as FileMetadata);
		expect(fileData.equals(data)).toBe(true);

		await fileStoreA.close();
		await fileStoreB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
	});

	it("multiple files replicate", async () => {
		tn = await testnet(10);
		const { storeA, storeB, manifestA, manifestB, fileStoreA, fileStoreB } =
			await createPairedStores(tn.bootstrap);

		const files = [
			{ path: "/one.txt", data: Buffer.from("file one content") },
			{ path: "/two.txt", data: Buffer.from("file two content here") },
			{ path: "/three.txt", data: Buffer.from("third file with more data inside") },
		];

		for (const f of files) {
			const stored = await fileStoreA.writeFile(f.data);
			await manifestA.put(f.path, buildMetadata(stored, fileStoreA.core.key));
		}

		await waitUntil(manifestB, async () => (await manifestB.list()).length === 3);

		for (const f of files) {
			const entry = await manifestB.get(f.path);
			expect(entry).not.toBeNull();
			const fileData = await readRemoteFile(storeB, entry! as FileMetadata);
			expect(fileData.equals(f.data)).toBe(true);
		}

		await fileStoreA.close();
		await fileStoreB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
	});

	it("large file replication (1MB)", async () => {
		tn = await testnet(10);
		const { storeA, storeB, manifestA, manifestB, fileStoreA, fileStoreB } =
			await createPairedStores(tn.bootstrap);

		const data = randomBytes(1024 * 1024); // 1MB
		const expectedHash = createHash("sha256").update(data).digest("hex");

		const stored = await fileStoreA.writeFile(data);
		expect(stored.hash).toBe(expectedHash);

		const metadata = buildMetadata(stored, fileStoreA.core.key);
		await manifestA.put("/large.bin", metadata);

		await waitUntil(manifestB, async () => (await manifestB.get("/large.bin")) !== null);

		const entry = await manifestB.get("/large.bin");
		expect(entry).not.toBeNull();

		const fileData = await readRemoteFile(storeB, entry! as FileMetadata);
		expect(fileData.length).toBe(data.length);
		expect(fileData.equals(data)).toBe(true);

		const receivedHash = createHash("sha256").update(fileData).digest("hex");
		expect(receivedHash).toBe(expectedHash);

		await fileStoreA.close();
		await fileStoreB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
	});

	it("both peers write files, both can read each other's", async () => {
		tn = await testnet(10);
		const { storeA, storeB, manifestA, manifestB, fileStoreA, fileStoreB } =
			await createPairedStores(tn.bootstrap);

		await waitUntil(manifestB, async () => manifestB.writable);

		const dataX = Buffer.from("file X from peer A");
		const storedX = await fileStoreA.writeFile(dataX);
		await manifestA.put("/x.txt", buildMetadata(storedX, fileStoreA.core.key));

		const dataY = Buffer.from("file Y from peer B");
		const storedY = await fileStoreB.writeFile(dataY);
		await manifestB.put("/y.txt", buildMetadata(storedY, fileStoreB.core.key));

		// Wait for both sides to see both entries
		await waitUntil(manifestB, async () => (await manifestB.get("/x.txt")) !== null);
		await waitUntil(manifestA, async () => (await manifestA.get("/y.txt")) !== null);

		// B reads A's file
		const entryX = await manifestB.get("/x.txt");
		expect(entryX).not.toBeNull();
		const fileDataX = await readRemoteFile(storeB, entryX! as FileMetadata);
		expect(fileDataX.equals(dataX)).toBe(true);

		// A reads B's file
		const entryY = await manifestA.get("/y.txt");
		expect(entryY).not.toBeNull();
		const fileDataY = await readRemoteFile(storeA, entryY! as FileMetadata);
		expect(fileDataY.equals(dataY)).toBe(true);

		await fileStoreA.close();
		await fileStoreB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
	});

	it("file blocks persist after manifest entry removal", async () => {
		tn = await testnet(10);
		const { storeA, storeB, manifestA, manifestB, fileStoreA, fileStoreB } =
			await createPairedStores(tn.bootstrap);

		const data = Buffer.from("persistent block data");
		const stored = await fileStoreA.writeFile(data);
		const metadata = buildMetadata(stored, fileStoreA.core.key);
		await manifestA.put("/ephemeral.txt", metadata);

		// B receives the entry and reads the file bytes
		await waitUntil(manifestB, async () => (await manifestB.get("/ephemeral.txt")) !== null);
		const entry = await manifestB.get("/ephemeral.txt");
		expect(entry).not.toBeNull();
		const fileDataBefore = await readRemoteFile(storeB, entry! as FileMetadata);
		expect(fileDataBefore.equals(data)).toBe(true);

		// A removes the manifest entry
		await manifestA.remove("/ephemeral.txt");

		// B sees the removal
		await waitUntil(manifestB, async () => (await manifestB.get("/ephemeral.txt")) === null);
		expect(await manifestB.get("/ephemeral.txt")).toBeNull();

		// B can still read the file blocks — Hypercore is append-only
		const fileDataAfter = await readRemoteFile(storeB, entry! as FileMetadata);
		expect(fileDataAfter.equals(data)).toBe(true);

		await fileStoreA.close();
		await fileStoreB.close();
		await manifestA.close();
		await manifestB.close();
		await storeA.close();
		await storeB.close();
	});
});
