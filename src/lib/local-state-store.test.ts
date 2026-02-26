import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStateStore } from "./local-state-store";

let tmpDirs: string[] = [];

async function makeTmpDir(prefix = "pearsync-state-store-test-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const dir of tmpDirs) {
		await rm(dir, { recursive: true, force: true });
	}
	tmpDirs = [];
});

describe("LocalStateStore — corruption recovery", () => {
	it("recovers from backup when state.json is corrupt", async () => {
		const syncDir = await makeTmpDir();

		const state = new LocalStateStore(syncDir);
		await state.load();
		await state.set("/foo.txt", {
			lastSyncedHash: "abc123",
			lastSyncedMtime: 1000,
			lastManifestHash: "abc123",
			lastManifestWriterKey: "writer-a",
		});

		const statePath = join(syncDir, ".pearsync", "state.json");
		const backupPath = join(syncDir, ".pearsync", "state.json.bak");
		await copyFile(statePath, backupPath);
		await writeFile(statePath, "{this-is-not-valid-json");

		const recovered = new LocalStateStore(syncDir);
		await recovered.load();

		const value = recovered.get("/foo.txt");
		expect(value).toBeDefined();
		expect(value!.lastSyncedHash).toBe("abc123");

		const repaired = JSON.parse(await readFile(statePath, "utf-8")) as Record<string, unknown>;
		expect(repaired["/foo.txt"]).toBeDefined();
	});

	it("resets to empty when state and backup are both corrupt", async () => {
		const syncDir = await makeTmpDir();

		const stateDir = join(syncDir, ".pearsync");
		await mkdir(stateDir, { recursive: true });
		await writeFile(join(stateDir, "state.json"), "{bad");
		await writeFile(join(stateDir, "state.json.bak"), "{also-bad");

		const recovered = new LocalStateStore(syncDir);
		await recovered.load();

		expect(recovered.paths()).toEqual([]);
		const repaired = JSON.parse(
			await readFile(join(stateDir, "state.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(repaired).toEqual({});
	});
});
